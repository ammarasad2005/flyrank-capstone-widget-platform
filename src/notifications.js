import { withTransaction } from './db.js';

export async function enqueueConfirmation(client, submissionId) {
  const idempotencyKey = `submission:${submissionId}:confirmation`;
  await client.query(
    `INSERT INTO notification_jobs(submission_id, idempotency_key)
     VALUES ($1, $2)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [submissionId, idempotencyKey],
  );
}

export function createConsoleNotifier({ log = console.log } = {}) {
  return {
    async send({ submissionId }) {
      log(JSON.stringify({ event: 'confirmation_notification_sent', submissionId }));
    },
  };
}

export async function processOneNotification({
  pool,
  notifier,
  alert = async () => {},
  maxAttempts = 3,
  baseDelayMs = 1_000,
  staleAfterMs = 60_000,
  now = () => new Date(),
}) {
  const claimTime = now();
  const staleBefore = new Date(claimTime.getTime() - staleAfterMs);
  const job = await withTransaction(pool, async (client) => {
    const due = await client.query(
      `SELECT id, submission_id, idempotency_key
       FROM notification_jobs
       WHERE (status = 'pending' AND next_attempt_at <= $1)
          OR (status = 'in_progress' AND updated_at <= $2)
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [claimTime, staleBefore],
    );
    if (!due.rowCount) return null;
    const candidate = due.rows[0];
    const claimed = await client.query(
      `UPDATE notification_jobs
       SET status = 'in_progress', attempts = attempts + 1, updated_at = $2
       WHERE id = $1
       RETURNING id, submission_id, idempotency_key, attempts`,
      [candidate.id, claimTime],
    );
    return claimed.rows[0];
  });

  if (!job) return false;

  try {
    await notifier.send({
      submissionId: Number(job.submission_id),
      idempotencyKey: job.idempotency_key,
    });
    await pool.query(
      `UPDATE notification_jobs SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE id = $1`,
      [job.id],
    );
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 500);
    if (Number(job.attempts) >= maxAttempts) {
      await pool.query(
        `UPDATE notification_jobs SET status = 'dead_letter', last_error = $2, updated_at = now() WHERE id = $1`,
        [job.id, message],
      );
      try {
        await alert({
          jobId: Number(job.id),
          submissionId: Number(job.submission_id),
          attempts: Number(job.attempts),
          message,
        });
      } catch (alertError) {
        console.error(JSON.stringify({
          event: 'notification_failure_alert_failed',
          jobId: Number(job.id),
          message: String(alertError?.message ?? alertError),
        }));
      }
    } else {
      const delayMs = Math.min(baseDelayMs * (2 ** (Number(job.attempts) - 1)), 60_000);
      const nextAttemptAt = new Date(now().getTime() + delayMs);
      await pool.query(
        `UPDATE notification_jobs
         SET status = 'pending', next_attempt_at = $2, last_error = $3, updated_at = now()
         WHERE id = $1`,
        [job.id, nextAttemptAt, message],
      );
    }
  }
  return true;
}

export function startNotificationWorker(options, { pollMs = 1_000 } = {}) {
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      while (!stopped && await processOneNotification(options)) {
        // Drain currently due jobs; delayed retries remain pending until their due time.
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'notification_worker_error', message: String(error?.message ?? error) }));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, pollMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
