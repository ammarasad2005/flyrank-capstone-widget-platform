import './env.js';

const integer = (name, fallback, minimum = 1) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
};

function publicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error();
    }
    return parsed.origin;
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment.');
  }
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: integer('PORT', 3000),
  publicBaseUrl: publicBaseUrl(),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://widget:widget@localhost:5432/widget_platform',
  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://widget:widget@localhost:5432/widget_platform_test',
  jwtSecret: process.env.JWT_SECRET ?? 'local-dev-only-change-me-to-a-long-random-secret',
  rateLimitWindowMs: integer('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: integer('RATE_LIMIT_MAX', 10),
  rateLimitPerWidgetMax: integer('RATE_LIMIT_PER_WIDGET_MAX', 100),
  bodyLimit: process.env.BODY_LIMIT ?? '10kb',
  geoTimeoutMs: integer('GEO_TIMEOUT_MS', 2_500),
  notificationPollMs: integer('NOTIFICATION_POLL_MS', 1_000),
  notificationMaxAttempts: integer('NOTIFICATION_MAX_ATTEMPTS', 3),
  notificationBaseDelayMs: integer('NOTIFICATION_BASE_DELAY_MS', 1_000),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
});

if (config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters. Copy .env.example to .env and replace the local value.');
}
