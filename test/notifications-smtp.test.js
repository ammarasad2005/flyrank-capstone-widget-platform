import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { seedDemoData, DEMO_USERS } from '../src/seed-data.js';
import { createConsoleNotifier, createSmtpNotifier, processOneNotification } from '../src/notifications.js';

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

/** Minimal in-process SMTP server capturing the envelope and message body. */
async function startFakeSmtp() {
  const sessions = [];
  const server = net.createServer((socket) => {
    const session = { commands: [], data: '' };
    sessions.push(session);
    socket.write('220 fake-smtp ESMTP ready\r\n');
    let buffer = '';
    let inData = false;

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\r\n');

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 queued\r\n');
          } else {
            session.data += `${line}\n`;
          }
          continue;
        }

        session.commands.push(line);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          // Multi-line reply on purpose: the client must wait for the final "250 " line.
          socket.write('250-fake-smtp\r\n250-PIPELINING\r\n250 SIZE 10240000\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT') {
          socket.write('250 2.1.0 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    sessions,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function storeLead(publicId = 'demo-contact-widget-a') {
  const app = createApp({
    pool,
    appConfig: { ...config, jwtSecret: 'test-only-secret-with-at-least-thirty-two-characters' },
    geoProviders: { providerA: async () => null, providerB: async () => null },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/submissions?widget_id=${encodeURIComponent(publicId)}`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost:5500',
        'content-type': 'application/json',
        'idempotency-key': `smtp-${Math.random().toString(16).slice(2)}`,
      },
      body: JSON.stringify({ fields: { name: 'SMTP Lead', email: 'smtp@example.test', message: 'Hello from the test.' } }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body.submissionId;
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function submissionLookup(submissionId) {
  const result = await pool.query(
    `SELECT s.fields, w.public_id FROM submissions s JOIN widgets w ON w.id = s.widget_id WHERE s.id = $1`,
    [submissionId],
  );
  const row = result.rows[0];
  return row ? { fields: row.fields, publicId: row.public_id } : null;
}

test('SMTP notifier delivers the confirmation email to a local catcher', async () => {
  const fixture = await resetDemo();
  const smtp = await startFakeSmtp();
  try {
    const submissionId = await storeLead(fixture.publicId);
    const notifier = createSmtpNotifier({
      host: '127.0.0.1',
      port: smtp.port,
      from: 'widgets@localhost',
      to: 'owner-a@example.test',
      lookup: submissionLookup,
    });

    const delivered = await processOneNotification({
      pool,
      notifier,
      maxAttempts: 3,
      baseDelayMs: 100,
    });
    assert.equal(delivered, true);

    const job = await pool.query('SELECT status, attempts FROM notification_jobs WHERE submission_id = $1', [submissionId]);
    assert.equal(job.rows[0].status, 'succeeded');
    assert.equal(job.rows[0].attempts, 1);

    assert.equal(smtp.sessions.length, 1);
    const session = smtp.sessions[0];
    assert.ok(session.commands.some((line) => line.startsWith('MAIL FROM:<widgets@localhost>')));
    assert.ok(session.commands.some((line) => line.startsWith('RCPT TO:<owner-a@example.test>')));
    assert.match(session.data, /Subject: New lead #\d+/);
    assert.match(session.data, /name: SMTP Lead/);
    assert.match(session.data, /Widget: demo-contact-widget-a/);
  } finally {
    await smtp.close();
  }
});

test('SMTP header injection in submitted values cannot add headers or recipients', async () => {
  const fixture = await resetDemo();
  const smtp = await startFakeSmtp();
  try {
    const app = createApp({
      pool,
      appConfig: { ...config, jwtSecret: 'test-only-secret-with-at-least-thirty-two-characters' },
      geoProviders: { providerA: async () => null, providerB: async () => null },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/submissions?widget_id=${encodeURIComponent(fixture.publicId)}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:5500', 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: {
          name: 'Eve\r\nBcc: victim@example.test',
          email: 'eve@example.test',
          message: 'Injected\r\nX-Evil: 1',
        },
      }),
    });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(response.status, 201, await response.text());

    const notifier = createSmtpNotifier({ host: '127.0.0.1', port: smtp.port, lookup: submissionLookup });
    await processOneNotification({ pool, notifier, maxAttempts: 1, baseDelayMs: 10 });

    const data = smtp.sessions[0].data;
    assert.ok(!/^Bcc:/m.test(data), 'a submitted value must not create a Bcc header');
    assert.ok(!/^X-Evil:/m.test(data), 'a submitted value must not create arbitrary headers');
    assert.equal(smtp.sessions[0].commands.filter((line) => line.startsWith('RCPT TO')).length, 1);
  } finally {
    await smtp.close();
  }
});

test('an unreachable mail catcher retries then dead-letters without losing the lead', async () => {
  const fixture = await resetDemo();
  const port = await closedPort();
  const submissionId = await storeLead(fixture.publicId);

  const alerts = [];
  const notifier = createSmtpNotifier({ host: '127.0.0.1', port, timeoutMs: 500, lookup: submissionLookup });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const processed = await processOneNotification({
      pool,
      notifier,
      maxAttempts: 3,
      baseDelayMs: 1,
      alert: async (details) => alerts.push(details),
    });
    assert.equal(processed, true);
    if (attempt < 3) {
      // The retry is scheduled a millisecond out using the worker's clock; backdate it so the
      // next iteration claims it without racing the database clock against the Node clock.
      await pool.query(`UPDATE notification_jobs SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`);
    }
  }

  const job = await pool.query('SELECT status, attempts, last_error FROM notification_jobs WHERE submission_id = $1', [submissionId]);
  assert.equal(job.rows[0].status, 'dead_letter');
  assert.equal(job.rows[0].attempts, 3);
  assert.match(job.rows[0].last_error, /ECONNREFUSED|smtp/i);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].submissionId, submissionId);

  const lead = await pool.query('SELECT fields FROM submissions WHERE id = $1', [submissionId]);
  assert.equal(lead.rowCount, 1, 'the stored lead must survive a failing side effect');
  assert.equal(lead.rows[0].fields.name, 'SMTP Lead');
});

test('console notifier stays the default transport and never touches the network', async () => {
  const lines = [];
  const notifier = createConsoleNotifier({ log: (line) => lines.push(line) });
  await notifier.send({ submissionId: 42, idempotencyKey: 'submission:42:confirmation' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /confirmation_notification_sent/);
  assert.match(lines[0], /"submissionId":42/);
});
