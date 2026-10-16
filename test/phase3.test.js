import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { seedDemoData, DEMO_USERS, DEMO_WIDGET_PUBLIC_ID } from '../src/seed-data.js';
import { WIDGET_ASSET_PATH, WIDGET_ASSET_VERSION } from '../src/widget-payloads.js';
import { createRateLimiter } from '../src/rate-limiter.js';

const testOrigin = 'http://localhost:5500';
const publicBaseUrl = 'http://localhost:3000';
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
      publicBaseUrl,
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

async function request(baseUrl, path, { method = 'GET', json, headers = {} } = {}) {
  const outgoingHeaders = { ...headers };
  let body;
  if (json !== undefined) {
    outgoingHeaders['content-type'] ??= 'application/json';
    body = JSON.stringify(json);
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers: outgoingHeaders, body, redirect: 'manual' });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* assertions report the raw text */ }
  return { response, data, text };
}

/**
 * Conditional-GET helper. Node's fetch adds `cache-control: no-cache` to every request,
 * which makes Express's `req.fresh` correctly report a stale request, so ETag/304
 * revalidation has to be exercised with a raw HTTP request.
 */
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function login(baseUrl, credentials) {
  const result = await request(baseUrl, '/auth/login', { method: 'POST', json: credentials });
  assert.equal(result.response.status, 200, result.text);
  return result.data.accessToken;
}

const noGeo = {
  providerA: async () => null,
  providerB: async () => null,
};

function leadFields(overrides = {}) {
  return { name: 'Phase Three Lead', email: 'phase3@example.test', message: 'Rendered from a second origin.', ...overrides };
}

async function submitLead(baseUrl, publicId, { fields = leadFields(), headers = {} } = {}) {
  return request(baseUrl, `/submissions?widget_id=${encodeURIComponent(publicId)}`, {
    method: 'POST',
    headers: { origin: testOrigin, 'idempotency-key': `key-${Math.random().toString(16).slice(2)}`, ...headers },
    json: { fields },
  });
}

test('public widget config serves a cached, CORS-readable payload for the active widget', async () => {
  const fixture = await resetDemo();

  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const config1 = await request(baseUrl, `/widgets/${encodeURIComponent(fixture.publicId)}/config`, {
      headers: { origin: 'http://localhost:5500' },
    });
    assert.equal(config1.response.status, 200, config1.text);
    assert.equal(config1.response.headers.get('access-control-allow-origin'), '*');
    assert.match(config1.response.headers.get('cache-control'), /max-age=60/);
    assert.ok(config1.response.headers.get('etag'));
    assert.equal(config1.data.publicId, fixture.publicId);
    assert.equal(config1.data.title, 'Talk to our team');
    assert.equal(config1.data.buttonText, 'Send message');
    assert.equal(config1.data.fields.length, 3);
    assert.equal(config1.data.submitUrl, `${publicBaseUrl}/submissions?widget_id=${fixture.publicId}`);
    assert.ok(!('tenantId' in config1.data), 'public config must not leak tenant identifiers');
    assert.ok(!JSON.stringify(config1.data).includes('owner-a@example.test'));

    const revalidated = await rawGet(`${baseUrl}/widgets/${encodeURIComponent(fixture.publicId)}/config`, {
      'if-none-match': config1.response.headers.get('etag'),
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body, '');

    const missing = await request(baseUrl, '/widgets/does-not-exist/config');
    assert.equal(missing.response.status, 404);
    assert.equal(missing.data.error, 'widget_not_found');
  });
});

test('widget bundle is served as a versioned, immutable asset with a stable alias', async () => {
  await resetDemo();

  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const asset = await fetch(`${baseUrl}${WIDGET_ASSET_PATH}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /application\/javascript/);
    assert.match(asset.headers.get('cache-control'), /max-age=31536000/);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.equal(asset.headers.get('access-control-allow-origin'), '*');
    const source = await asset.text();
    assert.match(source, /flyrank-widget/);
    assert.ok(!source.includes('eval('), 'bundle must not use eval');
    assert.ok(!source.includes('innerHTML'), 'bundle must not inject markup strings');

    const revalidated = await rawGet(`${baseUrl}${WIDGET_ASSET_PATH}`, {
      'if-none-match': asset.headers.get('etag'),
    });
    assert.equal(revalidated.status, 304);

    const alias = await fetch(`${baseUrl}/public/widget.js?id=demo-contact-widget-a`);
    assert.equal(alias.status, 200);
    assert.match(alias.headers.get('content-type'), /application\/javascript/);
    assert.match(alias.headers.get('cache-control'), /public, max-age=300/);
    assert.equal(alias.headers.get('x-widget-bundle'), WIDGET_ASSET_VERSION);
    assert.equal(await alias.text(), source, 'the stable alias serves the current bundle directly');

    const stale = await request(baseUrl, '/public/widget.v0.js');
    assert.equal(stale.response.status, 410);
    assert.equal(stale.data.error, 'stale_widget_bundle');

    const traversal = await request(baseUrl, '/public/..%2f..%2fpackage.json');
    assert.equal(traversal.response.status, 404);
  });
});

test('owner widget responses expose a generated embed snippet and the embed endpoint agrees', async () => {
  const fixture = await resetDemo();

  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const token = await login(baseUrl, DEMO_USERS.tenantA);
    const list = await request(baseUrl, '/api/widgets', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(list.response.status, 200, list.text);
    assert.equal(list.data.widgets.length, 1);
    const widget = list.data.widgets[0];
    const expectedSnippet = `<script src="${publicBaseUrl}/public/widget.js?id=${fixture.publicId}" async></script>`;
    assert.equal(widget.embed.snippet, expectedSnippet);
    assert.equal(widget.embed.scriptUrl, `${publicBaseUrl}/public/widget.js?id=${fixture.publicId}`);
    assert.equal(widget.embed.configUrl, `${publicBaseUrl}/widgets/${fixture.publicId}/config`);

    const embed = await request(baseUrl, `/api/widgets/${widget.id}/embed`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(embed.response.status, 200, embed.text);
    assert.equal(embed.data.snippet, expectedSnippet);
    assert.equal(embed.data.publicId, fixture.publicId);

    const otherTenantToken = await login(baseUrl, DEMO_USERS.tenantB);
    const forbidden = await request(baseUrl, `/api/widgets/${widget.id}/embed`, {
      headers: { authorization: `Bearer ${otherTenantToken}` },
    });
    assert.equal(forbidden.response.status, 404);
    assert.equal(forbidden.data.error, 'widget_not_found');
  });
});

test('dashboard submission reads and statistics are tenant-scoped and filterable', async () => {
  const fixture = await resetDemo();
  const geoProviders = {
    providerA: async () => ({ country: 'Germany', city: 'Berlin', provider: 'mock-provider-a' }),
    providerB: async () => { throw new Error('provider B should not run'); },
  };

  await withServer({ geoProviders }, async (baseUrl) => {
    const first = await request(baseUrl, `/submissions?widget_id=${encodeURIComponent(fixture.publicId)}`, {
      method: 'POST',
      headers: { origin: testOrigin, 'idempotency-key': 'dashboard-lead-1' },
      json: { fields: leadFields() },
    });
    assert.equal(first.response.status, 201, first.text);
    const second = await submitLead(baseUrl, fixture.publicId);
    assert.equal(second.response.status, 201, second.text);

    const token = await login(baseUrl, DEMO_USERS.tenantA);
    const auth = { authorization: `Bearer ${token}` };

    const list = await request(baseUrl, '/api/submissions?limit=1&offset=0', { headers: auth });
    assert.equal(list.response.status, 200, list.text);
    assert.equal(list.data.submissions.length, 1);
    assert.equal(list.data.pagination.total, 2);
    assert.equal(list.data.pagination.hasMore, true);
    assert.equal(list.data.submissions[0].id, second.data.submissionId);
    assert.equal(list.data.submissions[0].fields.name, 'Phase Three Lead');
    assert.ok('geo' in list.data.submissions[0]);

    const filtered = await request(baseUrl, `/api/submissions?widgetId=${fixture.widgetId}`, { headers: auth });
    assert.equal(filtered.response.status, 200, filtered.text);
    assert.equal(filtered.data.pagination.total, 2);

    const otherWidget = await request(baseUrl, '/api/submissions?widgetId=999999', { headers: auth });
    assert.equal(otherWidget.response.status, 200);
    assert.equal(otherWidget.data.pagination.total, 0);

    const single = await request(baseUrl, `/api/submissions/${first.data.submissionId}`, { headers: auth });
    assert.equal(single.response.status, 200, single.text);
    assert.equal(single.data.submission.id, first.data.submissionId);

    const stats = await request(baseUrl, '/api/stats?days=7', { headers: auth });
    assert.equal(stats.response.status, 200, stats.text);
    assert.equal(stats.data.totals.submissions, 2);
    assert.ok(stats.data.totals.countries >= 1);
    assert.equal(stats.data.byDay.length, 7);
    assert.equal(stats.data.byDay.at(-1).count >= 2, true);
    assert.equal(stats.data.byWidget[0].publicId, fixture.publicId);
    assert.equal(stats.data.byWidget[0].count, 2);
    assert.deepEqual(stats.data.byCountry, [{ country: 'Germany', count: 2 }]);
    assert.equal(stats.data.windowDays, 7);

    const otherTenantToken = await login(baseUrl, DEMO_USERS.tenantB);
    const otherAuth = { authorization: `Bearer ${otherTenantToken}` };
    const otherList = await request(baseUrl, '/api/submissions', { headers: otherAuth });
    assert.equal(otherList.data.pagination.total, 0, 'tenant B must not see tenant A submissions');
    const stolenRead = await request(baseUrl, `/api/submissions/${first.data.submissionId}`, { headers: otherAuth });
    assert.equal(stolenRead.response.status, 404);
    const otherStats = await request(baseUrl, '/api/stats?days=7', { headers: otherAuth });
    assert.equal(otherStats.data.totals.submissions, 0);

    const unauthorised = await request(baseUrl, '/api/submissions');
    assert.equal(unauthorised.response.status, 401);
    const unauthorisedStats = await request(baseUrl, '/api/stats');
    assert.equal(unauthorisedStats.response.status, 401);

    const badLimit = await request(baseUrl, '/api/submissions?limit=abc', { headers: auth });
    assert.equal(badLimit.response.status, 422);
    const badDays = await request(baseUrl, '/api/stats?days=0', { headers: auth });
    assert.equal(badDays.response.status, 422);
    const badWidget = await request(baseUrl, '/api/submissions?widgetId=-3', { headers: auth });
    assert.equal(badWidget.response.status, 422);
  });
});

test('sample field names reserved for the engine are never rendered, and archived widgets stop serving', async () => {
  const fixture = await resetDemo();

  await pool.query(
    `UPDATE widgets SET fields = $2::jsonb WHERE public_id = $1`,
    [DEMO_WIDGET_PUBLIC_ID, JSON.stringify([
      { name: 'website', label: 'Website', type: 'text', required: false, maxLength: 100 },
      { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 100 },
      { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 254 },
    ])],
  );

  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const configResponse = await request(baseUrl, `/widgets/${fixture.publicId}/config`);
    assert.equal(configResponse.response.status, 200, configResponse.text);
    const names = configResponse.data.fields.map((field) => field.name);
    assert.deepEqual(names, ['name', 'email'], 'reserved engine field names are dropped from the public config');

    const token = await login(baseUrl, DEMO_USERS.tenantA);
    const archived = await request(baseUrl, `/api/widgets/${fixture.widgetId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(archived.response.status, 204);

    const afterArchive = await request(baseUrl, `/widgets/${fixture.publicId}/config`);
    assert.equal(afterArchive.response.status, 404, 'archived widgets must not serve configuration');
    const submitAfterArchive = await submitLead(baseUrl, fixture.publicId);
    assert.equal(submitAfterArchive.response.status, 404);
  });
});

test('owner dashboard page is served from the API origin for same-origin API calls', async () => {
  await resetDemo();

  await withServer({ geoProviders: noGeo }, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/demo/dashboard.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /owner dashboard/i);
    assert.match(html, /\/api\/stats/);
    assert.match(html, /\/auth\/login/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');

    const missing = await fetch(`${baseUrl}/demo/does-not-exist.html`);
    assert.equal(missing.status, 404);
  });
});

test('token bucket throttles a burst, then admits the next request once Retry-After elapses', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: () => clock });

  assert.equal(limiter.consume('visitor').allowed, true);
  assert.equal(limiter.consume('visitor').allowed, true);
  assert.equal(limiter.consume('visitor').allowed, true);

  const blocked = limiter.consume('visitor');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(limiter.consume('other-visitor').allowed, true, 'a different caller is unaffected');

  clock += blocked.retryAfterSeconds * 1000;
  const recovered = limiter.consume('visitor');
  assert.equal(recovered.allowed, true, 'the throttled caller recovers after Retry-After');
});
