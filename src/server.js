import { config } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { createApp } from './app.js';
import { startNotificationWorker } from './notifications.js';
import { createAlert, createNotifier } from './notifier-factory.js';

const pool = createPool();
await runMigrations(pool);

const notifier = createNotifier(pool);
const alert = createAlert();

const stopWorker = startNotificationWorker({
  pool,
  notifier,
  alert,
  maxAttempts: config.notificationMaxAttempts,
  baseDelayMs: config.notificationBaseDelayMs,
}, { pollMs: config.notificationPollMs });

const app = createApp({ pool });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'server_listening',
    port: config.port,
    environment: config.nodeEnv,
    notificationTransport: config.notificationTransport,
  }));
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
