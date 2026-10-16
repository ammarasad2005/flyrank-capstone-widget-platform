import { config } from './config.js';
import { createConsoleNotifier, createSmtpNotifier } from './notifications.js';

/*
 * One place that decides how the confirmation side effect is delivered:
 *   NOTIFICATION_TRANSPORT=console  (default) → structured log line, no external service
 *   NOTIFICATION_TRANSPORT=smtp              → local Mailpit catcher (docker compose up -d mailpit)
 *
 * SMTP failures are thrown back to the outbox worker so they retry and dead-letter; the
 * stored lead is never affected either way.
 */
export function createNotifier(pool) {
  if (config.notificationTransport !== 'smtp') return createConsoleNotifier();

  return createSmtpNotifier({
    host: config.smtpHost,
    port: config.smtpPort,
    from: config.smtpFrom,
    to: config.smtpTo,
    timeoutMs: config.smtpTimeoutMs,
    lookup: async (submissionId) => {
      const result = await pool.query(
        `SELECT s.fields, w.public_id
         FROM submissions s JOIN widgets w ON w.id = s.widget_id
         WHERE s.id = $1`,
        [submissionId],
      );
      const row = result.rows[0];
      if (!row) return {};
      return { fields: row.fields, publicId: row.public_id };
    },
  });
}

export function createAlert() {
  return async (details) => {
    if (!config.alertWebhookUrl) {
      console.error(JSON.stringify({ event: 'notification_dead_letter', ...details }));
      return;
    }
    const response = await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'notification_dead_letter', ...details }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`alert endpoint returned HTTP ${response.status}`);
  };
}
