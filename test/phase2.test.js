import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { seedDemoData, DEMO_USERS } from '../src/seed-data.js';
import { processOneNotification, startNotificationWorker } from '../src/notifications.js';

const testOrigin = 'http://localhost:5500';
let pool;

before(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Tests must run with NODE_ENV=test');
  const databaseName = decodeURIComponent(new URL(config.testDatabaseUrl).pathname.split('/').at(-1) ?? '');
  if (!databaseName.endsWith('_test')) {
    throw new Error('Refusing destructive integration tests: TEST_DATABASE_URL must point to a database whose name ends in _test');
  }
  pool = createPool(config.testDatabaseUrl);
  await runMigrations(pool);
});

after(async () => {
  if (pool) await pool.end();
});

async function resetDemo() {
  await pool.query('TRUNCATE notification_jobs, submissions, widgets, users, tenants RESTART IDENTITY CASCADE');
  return seedDemoData(pool);
}

async function withServer(options, run) {
  const { appConfig: overrides, ...dependencies } = options ?? {};
  const server = createApp({
    ...dependencies,
    pool,
    appConfig: {
      ...config,
      jwtSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      rateLimitWindowMs: 60_000,
      rateLimitMax: 20,
      rateLimitPerWidgetMax: 100,
      bodyLimit: '10kb',
      geoTimeoutMs: 50,
      ...overrides,
    },
  }).listen(0, '0.0.0.0');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(baseUrl, path, { method = 'GET', json, rawBody, headers = {} } = {}) {
  const outgoingHeaders = { ...headers };
  let body;
  if (json !== undefined) {
    outgoingHeaders['content-type'] ??= 'application/json';
    body = JSON.stringify(json);
  } else if (rawBody !== undefined) {
    body = rawBody;
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers: outgoingHeaders, body });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* preserve a useful assertion failure below */ }
  return { response, data, text };
}

async function login(baseUrl, credentials) {
  const result = await request(baseUrl, '/auth/login', {
    method: 'POST',
    json: credentials,
  });
  assert.equal(result.response.status, 200, result.text);
  return result.data.accessToken;
}

function submissionPath(publicId) {
  return `/submissions?widget_id=${encodeURIComponent(publicId)}`;
}

function leadFields(overrides = {}) {
  return { name: 'Ammar Asad', email: 'ammar@example.test', message: 'Please contact me.', ...overrides };
}

function submissionOptions(_publicId, overrides = {}) {
  return {
    method: 'POST',
    headers: { origin: testOrigin, ...overrides.headers },
    json: overrides.json ?? { fields: leadFields() },
    rawBody: overrides.rawBody,
  };
}

const noGeo = {
  providerA: async () => null,
  providerB: async () => null,
};

// Each integration test uses a fresh fixture set in the real PostgreSQL test database.

test('cross-origin preflight and accepted submission persist provider-A enrichment and enqueue one notification', async () => {
  const fixture = await resetDemo();
  const geoProviders = {
    providerA: async () => ({ country: 'Pakistan', city: 'Islamabad', provider: 'mock-provider-a' }),
    providerB: async () => { throw new Error('provider B should not run'); },
  };

  await withServer({ geoProviders }, async (baseUrl) => {
    const preflight = await fetch(`${baseUrl}${submissionPath(fixture.publicId)}`, {
      method: 'OPTIONS',
      headers: {
        origin: testOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), testOrigin);
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Idempotency-Key/i);

    const blockedPreflight = await fetch(`${baseUrl}${submissionPath(fixture.publicId)}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://unlisted.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(blockedPreflight.status, 403);
    assert.equal(blockedPreflight.headers.get('access-control-allow-origin'), null);
    const blockedMethod = await fetch(`${baseUrl}${submissionPath(fixture.publicId)}`, {
      method: 'OPTIONS',
      headers: {
        origin: testOrigin,
        'access-control-request-method': 'DELETE',
      },
    });
    assert.equal(blockedMethod.status, 403);

    const first = await request(baseUrl, submissionPath(fixture.publicId), {
      ...submissionOptions(fixture.publicId),
      headers: { origin: testOrigin, 'idempotency-key': 'cross-origin-phase2-001' },
    });
    assert.equal(first.response.status, 201, first.text);
    assert.equal(first.response.headers.get('access-control-allow-origin'), testOrigin);
    assert.equal(first.data.received, true);

    const duplicate = await request(baseUrl, submissionPath(fixture.publicId), {
      ...submissionOptions(fixture.publicId),
      headers: { origin: testOrigin, 'idempotency-key': 'cross-origin-phase2-001' },
    });
    assert.equal(duplicate.response.status, 200, duplicate.text);
    assert.equal(duplicate.data.submissionId, first.data.submissionId);
    assert.equal(duplicate.data.reused, true);

    const rows = await pool.query(
      `SELECT s.fields, s.geo_country, s.geo_city, s.geo_provider, s.tenant_id,
              w.public_id, n.idempotency_key, n.status AS notification_status
       FROM submissions s
       JOIN widgets w ON w.id = s.widget_id
       JOIN notification_jobs n ON n.submission_id = s.id
       WHERE s.id = $1`,
      [first.data.submissionId],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].fields.name, 'Ammar Asad');
    assert.equal(rows.rows[0].geo_country, 'Pakistan');
    assert.equal(rows.rows[0].geo_city, 'Islamabad');
    assert.equal(rows.rows[0].geo_provider, 'mock-provider-a');
    assert.equal(Number(rows.rows[0].tenant_id), fixture.tenantAId);
    assert.equal(rows.rows[0].public_id, fixture.publicId);
    assert.equal(rows.rows[0].notification_status, 'pending');
    assert.equal(rows.rows[0].idempotency_key, `submission:${first.data.submissionId}:confirmation`);
    const count = await pool.query('SELECT count(*)::int AS count FROM submissions');
    assert.equal(count.rows[0].count, 1);
  });
});

test('provider A failure falls back to provider B and stores provider-B enrichment', async () => {
  const fixture = await resetDemo();
  let providerACalls = 0;
  let providerBCalls = 0;
  const geoProviders = {
    providerA: async () => { providerACalls += 1; throw new Error('simulated provider-A outage'); },
    providerB: async () => { providerBCalls += 1; return { country: 'Pakistan', city: 'Rawalpindi', provider: 'mock-provider-b' }; },
  };

  await withServer({ geoProviders }, async (baseUrl) => {
    const result = await request(baseUrl, submissionPath(fixture.publicId), submissionOptions(fixture.publicId));
    assert.equal(result.response.status, 201, result.text);
    assert.equal(providerACalls, 1);
    assert.equal(providerBCalls, 1);
    const saved = await pool.query('SELECT geo_country, geo_city, geo_provider FROM submissions WHERE id = $1', [result.data.submissionId]);
    assert.deepEqual(saved.rows[0], { geo_country: 'Pakistan', geo_city: 'Rawalpindi', geo_provider: 'mock-provider-b' });
  });
});

test('both geo providers failing does not prevent durable submission storage', async () => {
  const fixture = await resetDemo();
  const geoProviders = {
    providerA: async () => { throw new Error('simulated provider-A outage'); },
    providerB: async () => { throw new Error('simulated provider-B outage'); },
  };

  await withServer({ geoProviders }, async (baseUrl) => {
    const result = await request(baseUrl, submissionPath(fixture.publicId), submissionOptions(fixture.publicId));
    assert.equal(result.response.status, 201, result.text);
    const saved = await pool.query(
      'SELECT fields, geo_country, geo_city, geo_provider FROM submissions WHERE id = $1',
      [result.data.submissionId],
    );
    assert.equal(saved.rowCount, 1);
    assert.equal(saved.rows[0].fields.email, 'ammar@example.test');
    assert.equal(saved.rows[0].geo_country, null);
    assert.equal(saved.rows[0].geo_city, null);
    assert.equal(saved.rows[0].geo_provider, null);
  });
});

test('owner auth and widget CRUD are tenant-scoped', async () => {
  const fixture = await resetDemo();
  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const unauthenticated = await request(baseUrl, '/api/widgets');
    assert.equal(unauthenticated.response.status, 401);

    const tokenA = await login(baseUrl, DEMO_USERS.tenantA);
    const tokenB = await login(baseUrl, DEMO_USERS.tenantB);
    const widgetsA = await request(baseUrl, '/api/widgets', { headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(widgetsA.response.status, 200);
    assert.equal(widgetsA.data.widgets.length, 1);
    const seededWidgetId = widgetsA.data.widgets[0].id;

    const otherTenantList = await request(baseUrl, '/api/widgets', { headers: { authorization: `Bearer ${tokenB}` } });
    assert.equal(otherTenantList.response.status, 200);
    assert.deepEqual(otherTenantList.data.widgets, []);
    const crossTenantRead = await request(baseUrl, `/api/widgets/${seededWidgetId}`, { headers: { authorization: `Bearer ${tokenB}` } });
    assert.equal(crossTenantRead.response.status, 404);
    const crossTenantUpdate = await request(baseUrl, `/api/widgets/${seededWidgetId}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${tokenB}` }, json: { title: 'Hijack attempt' },
    });
    assert.equal(crossTenantUpdate.response.status, 404);
    const crossTenantDelete = await request(baseUrl, `/api/widgets/${seededWidgetId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(crossTenantDelete.response.status, 404);

    const created = await request(baseUrl, '/api/widgets', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenB}` },
      json: {
        kind: 'signup',
        title: 'Tenant B signup',
        fields: [{ name: 'email', label: 'Email', type: 'email', required: true, maxLength: 254 }],
        allowedOrigins: [testOrigin],
      },
    });
    assert.equal(created.response.status, 201, created.text);
    const newWidgetId = created.data.widget.id;
    assert.equal(created.data.widget.tenantId, fixture.tenantBId);
    assert.deepEqual(created.data.widget.displayOptions, { theme: 'light', position: 'inline' });

    const crossTenantReadNewWidget = await request(baseUrl, `/api/widgets/${newWidgetId}`, { headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(crossTenantReadNewWidget.response.status, 404);
    const patched = await request(baseUrl, `/api/widgets/${newWidgetId}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${tokenB}` }, json: { title: 'Updated B signup' },
    });
    assert.equal(patched.response.status, 200, patched.text);
    assert.equal(patched.data.widget.title, 'Updated B signup');
    const deleted = await request(baseUrl, `/api/widgets/${newWidgetId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(deleted.response.status, 204);
    const archived = await request(baseUrl, `/api/widgets/${newWidgetId}`, { headers: { authorization: `Bearer ${tokenB}` } });
    assert.equal(archived.data.widget.status, 'archived');
  });
});

test('malformed, oversized, invalid, and honeypot submissions fail safely or are silently dropped', async () => {
  const fixture = await resetDemo();
  await withServer({ appConfig: { bodyLimit: '512b' }, geoProviders: noGeo }, async (baseUrl) => {
    const invalidEmail = await request(baseUrl, submissionPath(fixture.publicId), {
      ...submissionOptions(fixture.publicId),
      json: { fields: leadFields({ email: 'not-an-email' }) },
    });
    assert.equal(invalidEmail.response.status, 422);
    assert.equal(invalidEmail.response.headers.get('access-control-allow-origin'), testOrigin);
    const unknownField = await request(baseUrl, submissionPath(fixture.publicId), {
      ...submissionOptions(fixture.publicId),
      json: { fields: leadFields({ extra: 'not declared in widget schema' }) },
    });
    assert.equal(unknownField.response.status, 422);

    const beforeSpam = await pool.query('SELECT count(*)::int AS count FROM submissions');
    const spam = await request(baseUrl, submissionPath(fixture.publicId), {
      ...submissionOptions(fixture.publicId),
      json: { fields: leadFields(), website: 'https://bot.invalid' },
    });
    assert.equal(spam.response.status, 202);
    const afterSpam = await pool.query('SELECT count(*)::int AS count FROM submissions');
    assert.equal(afterSpam.rows[0].count, beforeSpam.rows[0].count);

    const malformed = await request(baseUrl, submissionPath(fixture.publicId), {
      method: 'POST',
      headers: { origin: testOrigin, 'content-type': 'application/json' },
      rawBody: '{"fields":',
    });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.data.error, 'malformed_json');
    assert.equal(malformed.response.headers.get('access-control-allow-origin'), testOrigin);

    const oversized = await request(baseUrl, submissionPath(fixture.publicId), {
      method: 'POST',
      headers: { origin: testOrigin, 'content-type': 'application/json' },
      json: { fields: leadFields({ message: 'x'.repeat(1500) }) },
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.data.error, 'payload_too_large');
    assert.equal(oversized.response.headers.get('access-control-allow-origin'), testOrigin);

    const first = await request(baseUrl, submissionPath(fixture.publicId), {
      ...submissionOptions(fixture.publicId),
      headers: { origin: testOrigin, 'idempotency-key': 'dedupe-this-submission' },
    });
    assert.equal(first.response.status, 201, first.text);
    const repeated = await request(baseUrl, submissionPath(fixture.publicId), {
      ...submissionOptions(fixture.publicId),
      headers: { origin: testOrigin, 'idempotency-key': 'dedupe-this-submission' },
    });
    assert.equal(repeated.response.status, 200, repeated.text);
    assert.equal(repeated.data.submissionId, first.data.submissionId);
    const count = await pool.query('SELECT count(*)::int AS count FROM submissions');
    assert.equal(count.rows[0].count, 1);
  });
});

test('per-IP rate limiting returns 429 without blocking a different visitor', async () => {
  const fixture = await resetDemo();
  await withServer({
    appConfig: { rateLimitMax: 2, rateLimitPerWidgetMax: 100 },
    ipResolver: (req) => req.get('x-test-client-ip') ?? req.ip,
    geoProviders: noGeo,
  }, async (baseUrl) => {
    const send = (ip) => request(baseUrl, submissionPath(fixture.publicId), {
      method: 'POST',
      headers: { origin: testOrigin, 'x-test-client-ip': ip },
      json: { fields: leadFields() },
    });
    assert.equal((await send('visitor-a')).response.status, 201);
    assert.equal((await send('visitor-a')).response.status, 201);
    const limited = await send('visitor-a');
    assert.equal(limited.response.status, 429);
    assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);
    assert.equal(limited.data.error, 'rate_limit_exceeded');
    const otherVisitor = await send('visitor-b');
    assert.equal(otherVisitor.response.status, 201, otherVisitor.text);
  });
});

test('notification failure retries to dead letter and alerts without losing the submission', async () => {
  const fixture = await resetDemo();
  let acceptedSubmissionId;
  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const accepted = await request(baseUrl, submissionPath(fixture.publicId), submissionOptions(fixture.publicId));
    assert.equal(accepted.response.status, 201, accepted.text);
    acceptedSubmissionId = accepted.data.submissionId;
  });

  let sends = 0;
  const alerts = [];
  const notifier = {
    async send({ submissionId, idempotencyKey }) {
      assert.equal(submissionId, acceptedSubmissionId);
      assert.match(idempotencyKey, /^submission:\d+:confirmation$/);
      sends += 1;
      throw new Error('simulated notifier outage');
    },
  };
  const workerOptions = {
    pool,
    notifier,
    alert: async (details) => alerts.push(details),
    maxAttempts: 3,
    baseDelayMs: 0,
  };
  assert.equal(await processOneNotification(workerOptions), true);
  assert.equal(await processOneNotification(workerOptions), true);
  assert.equal(await processOneNotification(workerOptions), true);
  assert.equal(await processOneNotification(workerOptions), false);
  assert.equal(sends, 3);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].attempts, 3);

  const job = await pool.query('SELECT status, attempts, last_error FROM notification_jobs LIMIT 1');
  assert.deepEqual(job.rows[0], { status: 'dead_letter', attempts: 3, last_error: 'simulated notifier outage' });
  const saved = await pool.query('SELECT count(*)::int AS count FROM submissions');
  assert.equal(saved.rows[0].count, 1);
});

test('background worker polls the durable outbox and completes a due notification', async () => {
  const fixture = await resetDemo();
  let submissionId;
  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const accepted = await request(baseUrl, submissionPath(fixture.publicId), submissionOptions(fixture.publicId));
    assert.equal(accepted.response.status, 201, accepted.text);
    submissionId = accepted.data.submissionId;
  });

  const stop = startNotificationWorker({
    pool,
    notifier: { async send({ submissionId: sentId }) { assert.equal(sentId, submissionId); } },
    alert: async () => {},
    maxAttempts: 2,
  }, { pollMs: 10 });
  try {
    const deadline = Date.now() + 2_000;
    let status = null;
    while (Date.now() < deadline) {
      const result = await pool.query('SELECT status FROM notification_jobs WHERE submission_id = $1', [submissionId]);
      status = result.rows[0]?.status ?? null;
      if (status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status, 'succeeded');
  } finally {
    stop();
  }
});
