# FlyRank Widget Platform — Phase 2

A Node.js/Express + PostgreSQL capstone implementing the hardened lead-submission path: tenant-scoped owner authentication and widget CRUD, origin-aware CORS/preflight, boundary and payload validation, per-IP/per-widget rate limits, a honeypot, geo-provider A→B fallback, durable submission storage, and a retryable notification outbox.

> **Status:** Phase 2 is implemented and tested. The embeddable JavaScript asset, public widget configuration/rendering, owner submission/statistics read API, and browser second-origin demo are intentionally deferred to Phase 3. This repository is not yet the finished capstone product.

## Phase 2 request flow

```text
Owner → POST /auth/login → short-lived JWT → tenant-scoped /api/widgets CRUD

External site → OPTIONS /submissions?widget_id=… → origin allowlist + preflight
Visitor       → POST /submissions?widget_id=…
              → request-size / schema checks → per-IP + per-widget limits → honeypot
              → geo provider A → provider B on failure → null geo if both fail
              → one PostgreSQL transaction: submission + unique notification outbox job
              → background worker: console notification, retry/backoff, terminal alert
```

The widget record is the source of truth for tenant ownership and permitted origins; the visitor never supplies a tenant ID. Geo lookup and notifications are secondary: provider or notifier failure does not remove an accepted lead.

## Run locally

Requirements: Node.js 20.19+ and Docker Compose v2.

```bash
cp .env.example .env
npm install
docker compose up -d --build
docker compose exec app npm run seed
npm test
```

The seed command is safe to rerun. It creates two demo tenants, two owner accounts, and one active widget for Tenant A. It prints the development-only credentials:

- Tenant A: `owner-a@example.test` / `demo-owner-a-password`
- Tenant B: `owner-b@example.test` / `demo-owner-b-password`
- Public demo widget ID: `demo-contact-widget-a`

**These fixture passwords are public, local-demo-only values. Never reuse them outside a disposable development environment.** The app runs migrations on startup. PostgreSQL is exposed on host port `5432`; the API is exposed on `3000` by default. The Compose initialization script creates a separate `widget_platform_test` database for tests. `npm test` runs from the host against `TEST_DATABASE_URL` in `.env` and uses real PostgreSQL with deterministic provider/notifier mocks; it truncates only that test database and refuses to run if its name does not end in `_test`.

To exercise the live HTTP path as well (this creates a demo lead and may call the public geo providers):

```bash
npm run phase2:smoke
```

`API_URL`, `WIDGET_PUBLIC_ID`, and `SMOKE_ORIGIN` can override its defaults. The smoke script reports whether real geo enrichment was available; deterministic fallback and all-providers-down proofs are in the test suite. Do not run the smoke command if you do not want a lead inserted into the local demo database.

To stop containers without deleting local data:

```bash
docker compose down
```

## API surface implemented in Phase 2

All responses are JSON unless the endpoint returns `204`. The demo widget allows origins `http://localhost:5500` and `http://127.0.0.1:5500`.

### Owner authentication and widget management

`POST /auth/login`

```json
{"email":"owner-a@example.test","password":"demo-owner-a-password"}
```

Returns a one-hour Bearer token. Supply `Authorization: Bearer <accessToken>` to:

- `GET /api/widgets` — list only widgets belonging to the JWT tenant.
- `POST /api/widgets` — create a widget. Supported kinds: `signup`, `contact`, `cta`. Provide a `fields` array and optionally `buttonText`, `displayOptions`, and `allowedOrigins`.
- `GET /api/widgets/:id` — read a tenant-owned widget.
- `PATCH /api/widgets/:id` — update validated widget properties.
- `DELETE /api/widgets/:id` — archive (soft-delete) a tenant-owned widget.

A different tenant receives `404` for another tenant's widget ID. Unauthenticated owner requests receive `401`.

### Public lead submission

`OPTIONS /submissions?widget_id=demo-contact-widget-a` supports `POST` preflight with `Content-Type` and `Idempotency-Key`. The request `Origin` must exactly match the widget's allowlist.

`POST /submissions?widget_id=demo-contact-widget-a`

```json
{
  "fields": {
    "name": "Ada Lovelace",
    "email": "ada@example.test",
    "message": "Please contact me."
  },
  "website": ""
}
```

A non-empty `website` honeypot value is acknowledged with `202` and is not stored. Accepted submissions return `201`; a repeated `Idempotency-Key` for the same widget returns `200` with the original submission ID. A missing/unknown widget returns `404`, a disallowed origin returns `403`, invalid data returns `422`, malformed JSON returns `400`, an oversized body returns `413`, and exhausted limits return `429` with `Retry-After`.

Other operational endpoints: `GET /health` (process liveness) and `GET /ready` (database readiness).

## Configuration and safeguards

All settings are environment-driven; `.env` is ignored by Git. `.env.example` contains local-only values. Replace `JWT_SECRET` before any non-local use. The demo database password in Compose is for local development only.

- `RATE_LIMIT_MAX` — per-IP request cap per window (default 10).
- `RATE_LIMIT_PER_WIDGET_MAX` — aggregate per-widget cap per window (default 100).
- `RATE_LIMIT_WINDOW_MS` — rate window (default 60 seconds).
- `BODY_LIMIT` — Express JSON request limit (default `10kb`).
- `GEO_TIMEOUT_MS` — timeout for each geo provider attempt.
- `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_BASE_DELAY_MS`, and `NOTIFICATION_POLL_MS` — outbox retry/worker controls.
- `ALERT_WEBHOOK_URL` — optional terminal-failure alert destination; blank means an alert is recorded to the service log.

The worker runs in the API process by default. `npm run worker` can start a separate worker against the same database; PostgreSQL row locking prevents two workers from claiming the same due job at the same time. The sample notifier writes a small confirmation event to the console; no external email service is configured.

## Architecture and implementation notes

- `src/app.js` — HTTP routes, CORS/preflight, auth boundary, and response mapping.
- `src/validation.js` — Zod schemas and dynamic widget-field validation.
- `src/auth.js`, `src/passwords.js` — HMAC-signed JWTs and salted `scrypt` password hashes.
- `src/geo.js` — injectable `ip-api.com` → `ipapi.co` lookup with bounded requests and null fallback.
- `src/notifications.js` — transactional outbox insertion, `SKIP LOCKED` worker claims, retries, dead-letter state, and alert callback.
- `src/repositories.js`, `src/db.js`, `src/migrate.js`, `db/migrations/` — tenant-aware SQL/data access, transactions, PostgreSQL pool, versioned schema, and indexes.
- `src/seed-data.js`, `src/seed.js` — repeatable local demo fixtures.
- `test/phase2.test.js` — PostgreSQL-backed behavioral tests using injected failure mocks.

See `DESIGN.md` for the current design snapshot, `EVIDENCE.md` for concrete Phase 2 test evidence, and `BUILDLOG.md` for the implementation log and the problems hit along the way.

## Deliberate limits at this phase

- The widget JavaScript/config endpoint, an actual browser-rendered second-origin page, dashboard submission/statistics endpoints, and `capstone.yaml` are Phase 3 work—not claimed as complete here.
- Rate-limit buckets are in process and reset when the API restarts; this is a local single-service implementation, not a distributed quota system.
- The default proxy trust setting is conservative (`req.ip` as seen by Node). A deployment behind a reverse proxy needs an explicit trusted-proxy configuration before relying on real client IPs for rate limits or geo lookups.
- Visitor IPs are sent to the configured public geo providers when possible; raw IPs are not stored in the submission table. A production privacy notice/retention policy is outside this Phase 2 implementation.
- Notifications are console-only by default. A real email/webhook delivery adapter is not configured; retry behavior is verified with deterministic test doubles.
