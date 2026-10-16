import { config } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { startNotificationWorker } from './notifications.js';
import { createAlert, createNotifier } from './notifier-factory.js';

const pool = createPool();
await runMigrations(pool);
const stop = startNotificationWorker({
  pool,
  notifier: createNotifier(pool),
  maxAttempts: config.notificationMaxAttempts,
  baseDelayMs: config.notificationBaseDelayMs,
  alert: createAlert(),
}, { pollMs: config.notificationPollMs });

console.log(JSON.stringify({ event: 'notification_worker_started', pollMs: config.notificationPollMs }));
process.once('SIGINT', () => { stop(); void pool.end(); });
process.once('SIGTERM', () => { stop(); void pool.end(); });
