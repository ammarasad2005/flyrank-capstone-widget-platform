import { config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { DEMO_WIDGET_PUBLIC_ID } from '../src/seed-data.js';

const apiUrl = (process.env.API_URL ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
const widgetPublicId = process.env.WIDGET_PUBLIC_ID ?? DEMO_WIDGET_PUBLIC_ID;
const origin = process.env.SMOKE_ORIGIN ?? 'http://localhost:5500';
const endpoint = `${apiUrl}/submissions?widget_id=${encodeURIComponent(widgetPublicId)}`;
const idempotencyKey = `phase2-smoke-${Date.now()}`;

const preflight = await fetch(endpoint, {
  method: 'OPTIONS',
  headers: {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type,idempotency-key',
  },
});
if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== origin) {
  throw new Error(`CORS preflight failed: HTTP ${preflight.status}`);
}

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
  body: JSON.stringify({
    fields: {
      name: 'Phase 2 smoke test',
      email: `phase2-${Date.now()}@example.test`,
      message: 'Cross-origin submission acceptance probe.',
    },
  }),
});
const result = await response.json().catch(() => ({}));
if (![200, 201].includes(response.status) || result.received !== true || !result.submissionId) {
  throw new Error(`Cross-origin submission failed: HTTP ${response.status} ${JSON.stringify(result)}`);
}

const pool = createPool(config.databaseUrl);
try {
  const stored = await pool.query(
    `SELECT s.id, s.geo_country, s.geo_city, s.geo_provider,
            n.status AS notification_status
     FROM submissions s
     JOIN notification_jobs n ON n.submission_id = s.id
     WHERE s.id = $1`,
    [result.submissionId],
  );
  if (!stored.rowCount) throw new Error('submission or durable notification job was not found in PostgreSQL');
  console.log(JSON.stringify({
    event: 'phase2_smoke_passed',
    httpStatus: response.status,
    corsPreflight: 'passed',
    submissionId: Number(stored.rows[0].id),
    persisted: true,
    geoEnriched: Boolean(stored.rows[0].geo_country || stored.rows[0].geo_city),
    geoProvider: stored.rows[0].geo_provider,
    notificationStatus: stored.rows[0].notification_status,
    note: 'Geo enrichment may be null if public providers reject the local/container IP; deterministic fallback and all-down behavior are tested with mocks by npm test.',
  }, null, 2));
} finally {
  await pool.end();
}
