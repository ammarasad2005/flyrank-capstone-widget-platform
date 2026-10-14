import { config } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { createConsoleNotifier, startNotificationWorker } from './notifications.js';

const pool = createPool();
await runMigrations(pool);
const stop = startNotificationWorker({
  pool,
  notifier: createConsoleNotifier(),
  maxAttempts: config.notificationMaxAttempts,
  baseDelayMs: config.notificationBaseDelayMs,
  alert: async (details) => {
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
  },
}, { pollMs: config.notificationPollMs });

console.log(JSON.stringify({ event: 'notification_worker_started', pollMs: config.notificationPollMs }));
process.once('SIGINT', () => { stop(); void pool.end(); });
process.once('SIGTERM', () => { stop(); void pool.end(); });
