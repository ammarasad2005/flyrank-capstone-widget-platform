# Phase 2 evidence

**Verification date:** 2026-10-15 (Asia/Karachi). **Environment:** Node.js 20.20.2, npm 10.8.2, Docker Compose PostgreSQL 16, test database `widget_platform_test`. The integration suite uses real PostgreSQL and deterministic injected geo/notifier doubles; no real external geo API or email service was called by these tests.

## Reproduction commands

From the repository root, with `.env` copied from `.env.example`:

```bash
docker compose up -d --wait db
npm test
npm audit --audit-level=high
```

The test command executed was `NODE_ENV=test node --test`. `docker compose up -d --build --wait app` built the Node 20 image with `npm ci --omit=dev`, ran the server, and applied `001_initial.sql`; `GET /ready` returned `{"status":"ready"}`. `docker compose exec app npm run seed` succeeded twice, confirming the seed is repeatable. The first test run applied `001_initial.sql` to the separate test database; the final test run reused that migrated schema and reported:

```text
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`npm audit --audit-level=high` reported `found 0 vulnerabilities` after Zod was upgraded to the fixed v4 range. The additional live `npm run phase2:smoke` against the Compose app returned HTTP `201`, passed preflight, and verified the submission plus outbox row in PostgreSQL. A subsequent database/log check showed the job transition to `succeeded` after one attempt and the app emitted `confirmation_notification_sent`. Geo columns were null for the Docker bridge address in that live check; provider enrichment/fallback is therefore claimed only on the deterministic mocked tests, not on the live smoke run.

## Requirement-to-test map

| Phase 2 proof | Concrete test/evidence | Result |
|---|---|---|
| Migrations, indexes, PostgreSQL persistence | Test setup connects to Compose's `widget_platform_test`; `runMigrations()` applies `001_initial.sql`. Submission tests query the persisted rows, tenant IDs, geo columns, and notification outbox. | Pass |
| Seeded, tenant-scoped owner auth and widget management | `owner auth and widget CRUD are tenant-scoped` logs in both seeded owners, rejects unauthenticated access, proves Tenant B cannot read/update/delete Tenant A's widget, and exercises create/update/archive for Tenant B. | Pass |
| Cross-origin CORS and preflight | `cross-origin preflight and accepted submission persist provider-A enrichment and enqueue one notification` sends an `OPTIONS` request with a distinct allowed `Origin`, validates ACAO/method/header responses, then POSTs from that origin and checks ACAO on the response. | Pass |
| Boundary and malformed/oversized payload handling | `malformed, oversized, invalid, and honeypot submissions fail safely or are silently dropped` checks invalid email `422`, malformed JSON `400`, and a 512-byte-limit overflow `413`; error responses stay JSON and include CORS for the permitted origin. | Pass |
| Geo provider A→B fallback | `provider A failure falls back to provider B and stores provider-B enrichment` injects provider A failure and provider B success, then asserts the stored country/city/provider. | Pass |
| All geo providers fail but storage succeeds | `both geo providers failing does not prevent durable submission storage` injects failure from both providers, asserts `201`, and queries the stored submission with null geo columns. | Pass |
| Rate limiting and normal visitor isolation | `per-IP rate limiting returns 429 without blocking a different visitor` exceeds the per-IP cap, checks `Retry-After`, then submits successfully from a different simulated IP. | Pass |
| Spam honeypot and idempotency | The malformed/payload test fills the `website` honeypot and proves the submission count does not increase; the cross-origin test repeats an idempotency key and proves one row/job is reused. | Pass |
| Durable, resilient notification handling | Cross-origin persistence test verifies the submission and notification job are created together. `notification failure retries to dead letter and alerts without losing the submission` forces three send failures, asserts retry/terminal alert, and confirms the lead remains stored. `background worker polls the durable outbox and completes a due notification` proves the polling loop delivers a pending job. | Pass |
| No known high-severity dependency issue | `npm audit --audit-level=high` after Zod v4 upgrade. | 0 vulnerabilities |

## Scope of this evidence

The cross-origin proof is an HTTP integration test that sends a browser-style `Origin` header and preflight request; it is **not** a rendered browser page. Geo and notifier failures are deterministic mocks rather than third-party outages. `npm run phase2:smoke` **was run** against the Compose app; it created a local lead, passed CORS preflight, and verified the durable submission/outbox, but the public providers returned no geo fields for the container address. Phase 3 browser rendering, public widget assets/config, owner submission/statistics reads, and the evaluator manifest are not yet complete.
