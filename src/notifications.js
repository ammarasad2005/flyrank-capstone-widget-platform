import net from 'node:net';
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

/*
 * Minimal SMTP notifier for the confirmation side effect, used against a local Mailpit
 * catcher (`docker compose up -d mailpit`, web UI on :8025) instead of a paid mail service.
 *
 * The side effect stays non-critical by design: any SMTP error is thrown back to the outbox
 * worker, which retries and then dead-letters — the stored lead is never affected.
 * CR/LF is stripped from every header value so a submission cannot inject mail headers.
 */
function headerValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
}

export function createSmtpNotifier({
  host = '127.0.0.1',
  port = 1025,
  from = 'widgets@localhost',
  to = 'owner@example.test',
  timeoutMs = 5_000,
  lookup = async () => ({}),
} = {}) {
  function sendMail({ submissionId, idempotencyKey, details }) {
    const fields = details?.fields ?? {};
    const widgetLine = details?.publicId ? `Widget: ${headerValue(details.publicId)}\r\n` : '';
    const fieldLines = Object.entries(fields)
      .slice(0, 20)
      .map(([key, value]) => `${headerValue(key)}: ${headerValue(value)}`)
      .join('\r\n');

    const message = [
      `From: ${headerValue(from)}`,
      `To: ${headerValue(to)}`,
      `Subject: ${headerValue(`New lead #${submissionId}`)}`,
      `Message-ID: <${headerValue(idempotencyKey)}@widget-platform.local>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      `A new lead was captured (submission ${submissionId}).`,
      widgetLine.trimEnd(),
      fieldLines,
    ].filter((line, index) => line !== '' || index < 8).join('\r\n');

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let buffer = '';
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };

      socket.setTimeout(timeoutMs, () => finish(new Error('smtp timeout')));
      socket.on('error', (error) => finish(error));
      socket.on('close', () => { if (!settled) finish(new Error('smtp connection closed early')); });

      const steps = [
        { expect: 220, send: null },
        { expect: 250, send: `EHLO widget-platform` },
        { expect: 250, send: `MAIL FROM:<${from}>` },
        { expect: 250, send: `RCPT TO:<${to}>` },
        { expect: 354, send: 'DATA' },
        { expect: 250, send: `${message.replace(/^\./gm, '..')}\r\n.` },
        { expect: 221, send: 'QUIT' },
      ];
      let step = 0;

      const advance = () => {
        const current = steps[step];
        if (!current) return finish(null);
        step += 1;
        if (current.send === null) return;
        socket.write(`${current.send}\r\n`);
      };

      // Replies can arrive in one chunk, several chunks, or as multi-line replies where
      // continuation lines start with "250-". Consume every complete line in the buffer and
      // act only on the final line of each reply.
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\r\n');
        while (index !== -1 && !settled) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\r\n');
          if (/^\d{3}-/.test(line)) continue;
          const status = Number(line.slice(0, 3));
          if (!Number.isFinite(status)) {
            finish(new Error('smtp protocol error'));
            return;
          }
          if (status >= 400) {
            finish(new Error(`smtp ${status}: ${line.slice(4)}`));
            return;
          }
          advance();
        }
      });

      advance();
    });
  }

  return {
    async send({ submissionId, idempotencyKey }) {
      const details = await lookup(submissionId).catch(() => null);
      await sendMail({ submissionId, idempotencyKey, details });
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
