import { config } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { createApp } from './app.js';
import { createConsoleNotifier, startNotificationWorker } from './notifications.js';

const pool = createPool();
await runMigrations(pool);

const notifier = createConsoleNotifier();
const alert = async (details) => {
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

const stopWorker = startNotificationWorker({
  pool,
  notifier,
  alert,
  maxAttempts: config.notificationMaxAttempts,
  baseDelayMs: config.notificationBaseDelayMs,
}, { pollMs: config.notificationPollMs });

const app = createApp({ pool });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'server_listening', port: config.port, environment: config.nodeEnv }));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'server_shutdown', signal }));
  stopWorker();
  server.close(async (error) => {
    if (error) console.error(JSON.stringify({ event: 'server_close_failed', message: error.message }));
    await pool.end();
    process.exitCode = error ? 1 : 0;
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
