/*
 * Acceptance probes — the six behavioural promises from the capstone brief, run against a
 * live system (docker compose up + npm run seed) rather than against mocks.
 *
 *   npm run probes
 *
 * Probes 1, 2, 3 and 6 talk to the running API over HTTP from the second-origin header.
 * Probes 4 (geo fallback) and 5 (failing side effect) require deterministic provider and
 * notifier failures, so they are executed by re-running the named integration tests and
 * their output is reported here. Set PROBES_SKIP_TESTS=1 to run only the live probes.
 *
 * Probes 1, 2 and 6 are not about throttling, so they honour `Retry-After` and retry when a
 * previous run left the caller's bucket drained. Probe 3 is the throttling probe and waits
 * out its own `Retry-After` before asserting that legitimate traffic still succeeds.
 *
 * Environment: API_URL, PROBE_ORIGIN, WIDGET_PUBLIC_ID, OWNER_EMAIL, OWNER_PASSWORD,
 * PROBE_WAIT_MAX_MS (cap on the Retry-After wait, default 20000).
 */
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { DEMO_USERS, DEMO_WIDGET_PUBLIC_ID } from '../src/seed-data.js';

const apiUrl = (process.env.API_URL ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
const origin = process.env.PROBE_ORIGIN ?? 'http://localhost:5500';
const widgetPublicId = process.env.WIDGET_PUBLIC_ID ?? DEMO_WIDGET_PUBLIC_ID;
const ownerEmail = process.env.OWNER_EMAIL ?? DEMO_USERS.tenantA.email;
const ownerPassword = process.env.OWNER_PASSWORD ?? DEMO_USERS.tenantA.password;
const waitMaxMs = Number(process.env.PROBE_WAIT_MAX_MS ?? 20_000);
const submissionUrl = `${apiUrl}/submissions?widget_id=${encodeURIComponent(widgetPublicId)}`;

const results = [];

function record(probe, passed, detail) {
  results.push({ probe, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${probe}\n      ${detail}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(request) {
  const response = await request;
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw text in the message */ }
  return { response, body, text };
}

function leadFields() {
  return {
    name: 'Acceptance probe',
    email: `probe-${Date.now()}@example.test`,
    message: 'Submitted from the second-origin acceptance probe.',
  };
}

async function submitWithBackoff(options = {}, { attempts = 4 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await submit(options);
    if (result.response.status !== 429 || attempt === attempts) return result;
    const waitMs = Math.min(Number(result.response.headers.get('retry-after') ?? 1) * 1000, waitMaxMs);
    console.log(`      (throttled with Retry-After ${waitMs / 1000}s — waiting before retrying, attempt ${attempt}/${attempts})`);
    await sleep(waitMs + 250);
  }
  return null;
}

function submit({ body, headers = {}, withHoneypot = false } = {}) {
  const payload = body ?? {
    fields: leadFields(),
    ...(withHoneypot ? { website: 'https://spam.example' } : {}),
  };
  return json(fetch(submissionUrl, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'idempotency-key': `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  }));
}

async function ownerToken() {
  const { response, body } = await json(fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  }));
  if (response.status !== 200) throw new Error(`owner login failed: HTTP ${response.status}`);
  return body.accessToken;
}

async function dashboardSubmissions(token, query = 'limit=5') {
  return json(fetch(`${apiUrl}/api/submissions?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  }));
}

function runNamedTests(pattern) {
  return new Promise((resolve) => {
    const child = spawn('node', ['--test', '--test-name-pattern', pattern], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function probe1() {
  const { response, body } = await submitWithBackoff();
  if (response.status !== 201) {
    record('Probe 1 — cross-origin submission stored and visible', false, `expected 201, got ${response.status}`);
    return;
  }
  const token = await ownerToken();
  const list = await dashboardSubmissions(token, 'limit=20');
  const visible = list.body?.submissions?.some((row) => row.id === body.submissionId);
  record(
    'Probe 1 — cross-origin submission stored and visible',
    Boolean(visible),
    `POST from Origin ${origin} → 201 (submission ${body.submissionId}); dashboard API ${visible ? 'returns it' : 'does not return it'}`,
  );
}

async function probe2() {
  const malformed = await submitWithBackoff({ body: '{"fields":' });
  const oversized = await submitWithBackoff({ body: JSON.stringify({ fields: { name: 'x'.repeat(20_000) } }) });
  const passed = malformed.response.status === 400
    && malformed.body?.error === 'malformed_json'
    && oversized.response.status === 413
    && oversized.body?.error === 'payload_too_large';
  record(
    'Probe 2 — malformed and oversized payloads get clean JSON 4xx',
    passed,
    `malformed → ${malformed.response.status} ${malformed.body?.error}; oversized → ${oversized.response.status} ${oversized.body?.error}`,
  );
}

async function probe3() {
  let limited = null;
  let attempts = 0;
  for (let i = 0; i < 40 && !limited; i += 1) {
    attempts += 1;
    const { response, body } = await submit();
    if (response.status === 429) limited = { response, body };
  }
  if (!limited) {
    record('Probe 3 — burst is throttled and service keeps serving', false, 'no 429 observed within 40 submissions');
    return;
  }

  const retryAfter = Number(limited.response.headers.get('retry-after') ?? 0);
  const health = await fetch(`${apiUrl}/health`);
  const widgetConfig = await fetch(`${apiUrl}/widgets/${encodeURIComponent(widgetPublicId)}/config`);
  const serviceUp = health.status === 200 && widgetConfig.status === 200;

  const waitMs = Math.min(Math.max(retryAfter, 1) * 1000, waitMaxMs);
  await sleep(waitMs + 250);
  const afterBurst = await submitWithBackoff({}, { attempts: 6 });

  const passed = serviceUp && afterBurst.response.status === 201;
  record(
    'Probe 3 — burst is throttled and service keeps serving',
    passed,
    `${attempts} submissions before 429 (${limited.body?.error}, Retry-After ${retryAfter}s); /health ${health.status}, config ${widgetConfig.status}; `
      + `after ${Math.round(waitMs / 1000)}s wait the next submission → ${afterBurst.response.status}`,
  );
}

async function probe6() {
  const token = await ownerToken();
  const before = await dashboardSubmissions(token, 'limit=1');
  const beforeTotal = before.body?.pagination?.total ?? 0;

  const honeypot = await submitWithBackoff({ withHoneypot: true });
  await sleep(300);
  const after = await dashboardSubmissions(token, 'limit=1');
  const afterTotal = after.body?.pagination?.total ?? 0;

  const passed = [200, 202].includes(honeypot.response.status) && afterTotal === beforeTotal;
  record(
    'Probe 6 — filled honeypot is dropped without a stored lead',
    passed,
    `honeypot submission → ${honeypot.response.status} ${honeypot.body?.error ?? 'acknowledged'}; stored leads ${beforeTotal} → ${afterTotal}`,
  );
}

async function probe4And5() {
  if (process.env.PROBES_SKIP_TESTS === '1') {
    console.log('SKIP  Probes 4 and 5 (PROBES_SKIP_TESTS=1) — deterministic mocks are in npm test');
    return;
  }

  const probe4 = await runNamedTests('provider A failure falls back to provider B|both geo providers failing');
  const probe5 = await runNamedTests('notification failure retries to dead letter');

  const count = (output, pattern) => (output.match(pattern) ?? []).length;
  const probe4Passed = probe4.code === 0 && count(probe4.output, /^ok \d+ - /gm) >= 2;
  const probe5Passed = probe5.code === 0 && count(probe5.output, /^ok \d+ - /gm) >= 1;

  record(
    'Probe 4 — provider A down → provider B enriches; both down → still stored',
    probe4Passed,
    'node --test --test-name-pattern "provider A failure falls back…|both geo providers failing…" → '
      + `${probe4Passed ? 'both tests passed' : 'failed'} (injected provider failures, real PostgreSQL)`,
  );
  record(
    'Probe 5 — failing notification does not block storage',
    probe5Passed,
    'node --test --test-name-pattern "notification failure retries to dead letter" → '
      + `${probe5Passed ? 'passed' : 'failed'} (notifier throws three times; lead remains stored; alert fires)`,
  );
}

console.log(`Acceptance probes against ${apiUrl} (widget ${widgetPublicId}, browser origin ${origin})\n`);

try {
  await fetch(`${apiUrl}/health`);
} catch {
  console.error(`Cannot reach ${apiUrl}. Start the stack with: docker compose up -d --build --wait app && docker compose exec app npm run seed`);
  process.exit(2);
}

await probe1();
await probe2();
await probe6();
await probe3();
await probe4And5();

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) process.exit(1);
