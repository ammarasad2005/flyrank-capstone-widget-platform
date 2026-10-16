# FlyRank Capstone — Embeddable Widget & Lead-Capture Platform

A lead-capture platform you can embed on someone else's website with one line of HTML. An owner creates a
tenant-isolated widget, gets a `<script>` snippet, installs it on a page the platform does not control, and every
visitor submission is validated, abuse-checked, geo-enriched with a provider fallback chain, stored, and shown back
to that owner — even when a geo provider or the notification side effect fails.

Stack: **Node.js 20 + Express + PostgreSQL 16**, Docker Compose, no paid services and no API keys.

```
Owner (authenticated)        Customer page (any origin)          Visitor (untrusted)
        │                              │                                │
        │ POST /auth/login             │ <script src="…/public/widget.js?id=…">
        │ GET  /api/widgets  → snippet │      → GET /widgets/:id/config (cached, CORS *)
        │ GET  /api/submissions        │      → bundle renders the form
        │ GET  /api/stats              │                                │
        │                              │                POST /submissions?widget_id=…
        │                              │                  ├ boundary validation + payload cap
        │                              │                  ├ per-IP + per-widget rate limit (token bucket)
        │                              │                  ├ honeypot "website" field → silent 202
        │                              │                  ├ geo provider A → provider B → null
        │                              │                  └ one transaction: submission + outbox job
        │                              │                                │
        └────── dashboard reads ◄──────┴────────────────────────────────┘
                                          background worker: notify, retry, dead-letter, alert
```

| Layer | Where |
|---|---|
| HTTP / CORS / auth / caching | `src/app.js` |
| Boundary validation + public payload shapes | `src/validation.js`, `src/widget-payloads.js` |
| Domain adapters (geo, notifications, rate limiting) | `src/geo.js`, `src/notifications.js`, `src/rate-limiter.js` |
| Data access + transactions (tenant-scoped SQL) | `src/repositories.js`, `src/db.js` |
| Schema, indexes, seed | `db/migrations/`, `src/migrate.js`, `src/seed-data.js` |
| Browser bundle and demo pages | `public/widget.v1.js`, `demo/`, `scripts/demo-server.js` |

## Quick start (clean clone, Docker required)

```bash
git clone https://github.com/ammarasad2005/flyrank-capstone-widget-platform.git
cd flyrank-capstone-widget-platform
cp .env.example .env

docker compose up -d --build --wait app      # PostgreSQL 16 + API; migrations run on boot
docker compose exec app npm run seed         # two demo tenants, two owners, one active widget
```

Then, in two terminals:

```bash
npm run demo:page      # the "customer site" on http://localhost:5500  (second origin)
npm test               # 19 PostgreSQL-backed integration tests (needs the compose database)
```

- **Customer site (renders the widget):** <http://localhost:5500/>
- **Owner dashboard:** <http://localhost:3000/demo/dashboard.html> — sign in as `owner-a@example.test` /
  `demo-owner-a-password`
- **API health:** <http://localhost:3000/health> · readiness: <http://localhost:3000/ready>

Seeded fixtures (development only — never reuse these passwords anywhere else):

| Tenant | Owner | Password | Data |
|---|---|---|---|
| Demo Company A | `owner-a@example.test` | `demo-owner-a-password` | widget `demo-contact-widget-a` (allowed origins `http://localhost:5500`, `http://127.0.0.1:5500`) |
| Demo Company B | `owner-b@example.test` | `demo-owner-b-password` | no widgets — used to prove tenant isolation |

`npm run seed` is idempotent. `npm test` runs against the separate `widget_platform_test` database created by
`docker/postgres/init/01-create-test-db.sql`; it truncates only that database and refuses to run unless the database
name ends in `_test`. If you use a hosted PostgreSQL instead, set `TEST_DATABASE_URL` to a disposable `_test` database.

Other scripts:

```bash
npm run probes       # the six acceptance probes against the running stack (see "Acceptance probes")
npm run geo:check    # show live provider A/B answers for a public IP (default 8.8.8.8)
npm run phase2:smoke # single live cross-origin submission + persistence/outbox check
npm run worker       # optional standalone outbox worker (the API also runs one in-process)
npm run migrate      # apply migrations explicitly
```

## Acceptance probes

`npm run probes` executes the brief's six behavioural promises against the running system and prints one
`PASS`/`FAIL` line each (`evidence/acceptance-probes.txt` holds a real transcript):

| Probe | What it does |
|---|---|
| 1 | Posts from `Origin: http://localhost:5500`, then reads the lead back through `GET /api/submissions` |
| 2 | Sends malformed JSON and an oversized body → `400 malformed_json`, `413 payload_too_large` |
| 3 | Bursts until `429` with `Retry-After`, checks `/health` and `/widgets/:id/config` still answer, then succeeds after the wait |
| 4 | Provider A down → provider B enriches; both down → lead still stored without geo (deterministic mock tests) |
| 5 | Notification throws every time → request still `201`, lead stored, alert recorded |
| 6 | Fills the honeypot like a bot → `202` acknowledged, submission count unchanged |

Probes 4 and 5 need deterministic provider/notifier failures, so they re-run the named integration tests inside
`npm test` and report their result; the other four are live HTTP probes.

## API

All responses are JSON except `204`. Owner routes need `Authorization: Bearer <accessToken>` from `/auth/login`.

### Widget management (authenticated, tenant-scoped)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | `{email, password}` → one-hour Bearer token |
| `GET` | `/api/widgets` | only the caller's tenant; each widget carries `embed.snippet`, `embed.scriptUrl`, `embed.configUrl` |
| `POST` | `/api/widgets` | `kind` (`signup`/`contact`/`cta`), `title`, `description`, `fields[]`, `buttonText`, `displayOptions{theme,position}`, `allowedOrigins[]` |
| `GET` | `/api/widgets/:id` | another tenant's ID returns `404` |
| `PATCH` | `/api/widgets/:id` | partial update; omitted properties keep their values; `version` increments |
| `DELETE` | `/api/widgets/:id` | archives (soft delete); the public config stops serving immediately |
| `GET` | `/api/widgets/:id/embed` | the one-line snippet an owner pastes |

```json
{
  "widget": {
    "id": 1,
    "publicId": "demo-contact-widget-a",
    "embed": {
      "snippet": "<script src=\"http://localhost:3000/public/widget.js?id=demo-contact-widget-a\" async></script>",
      "scriptUrl": "http://localhost:3000/public/widget.js?id=demo-contact-widget-a",
      "configUrl": "http://localhost:3000/widgets/demo-contact-widget-a/config"
    }
  }
}
```

Unauthenticated owner requests → `401`; invalid bodies → `422` with an `issues[]` array.

### Public widget delivery (no auth, cache-controlled)

| Method | Path | Headers |
|---|---|---|
| `GET` | `/widgets/:publicId/config` | `Cache-Control: public, max-age=60, must-revalidate`, weak `ETag`, `Access-Control-Allow-Origin: *`; `304` on revalidation. Payload contains only public rendering data — never a tenant ID or owner email. Archived/missing widgets → `404`. |
| `GET` | `/public/widget.v1.js` | versioned bundle: `Cache-Control: public, max-age=31536000, immutable`, ETag; `304` supported |
| `GET` | `/public/widget.js` | stable alias used by snippets: same bundle with `Cache-Control: public, max-age=300` (served directly — a cross-origin redirect would be blocked by Chromium's Opaque Response Blocking) |
| `GET` | `/public/widget.v0.js` | any non-current version → `410 stale_widget_bundle` |

Cache-busting is a release step: ship `public/widget.v2.js`, bump `WIDGET_ASSET_VERSION` in
`src/widget-payloads.js`, and the alias/immutable URLs change together so browsers keep serving the old immutable
bundle only for pages that request it explicitly.

### Public submission (cross-origin)

`OPTIONS /submissions?widget_id=…` — resolves the active widget and its origin allowlist, then returns `204` with
`Access-Control-Allow-Origin: <request Origin>`, `Access-Control-Allow-Methods: POST, OPTIONS`,
`Access-Control-Allow-Headers: Content-Type, Idempotency-Key`, `Access-Control-Max-Age: 600`. A different origin →
`403`; an unsupported method or header → `403`.

`POST /submissions?widget_id=…`

```json
{ "fields": { "name": "Ada Lovelace", "email": "ada@example.test", "message": "Please contact me." }, "website": "" }
```

| Result | Status |
|---|---|
| accepted | `201 {received, submissionId}` |
| repeated `Idempotency-Key` for the same widget | `200 {received, submissionId, reused: true}` (no second geo call or outbox job) |
| filled honeypot `website` | `202 {received: true}` — nothing stored |
| unknown/archived widget | `404 widget_not_found` |
| origin not in the widget's allowlist | `403 origin_not_allowed` |
| invalid/unknown/missing/overlong field, unknown top-level key | `422 validation_failed` with `issues[]` |
| malformed JSON | `400 malformed_json` |
| body over `BODY_LIMIT` | `413 payload_too_large` |
| per-IP or per-widget limit exhausted | `429 rate_limit_exceeded` + `Retry-After` |

Validation is driven by the widget definition: only declared field names are accepted, `email` fields are format
checked, values are trimmed and length-capped, `website` is reserved and can never be declared.

### Owner dashboard (authenticated, tenant-scoped)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/submissions?limit=20&offset=0&widgetId=…` | newest first, `pagination{limit,offset,total,hasMore}` |
| `GET` | `/api/submissions/:id` | another tenant's submission → `404` |
| `GET` | `/api/stats?days=30&widgetId=…` | `totals{submissions,countries,withoutGeo,lastSubmissionAt}`, `byDay[]` (zero-filled), `byWidget[]`, `byCountry[]` (geo breakdown, `unknown` bucket) |

A static dashboard (`/demo/dashboard.html`, same origin as the API) renders those endpoints: metrics, counts-over-time
bars, geo breakdown, per-widget stats, the embed snippet, and the recent-submissions table.

## Reliability and safety design

- **The lead is the product.** The submission row and its outbox job are written in one transaction. Geo lookup runs
  before it and can fail silently (`null` geo columns); notification runs after it in a separate worker, so neither can
  delete an accepted lead.
- **Geo fallback chain.** `ip-api.com` → `ipapi.co`, each bounded by `GEO_TIMEOUT_MS`; a failure or unusable answer
  moves to the next provider; if both fail the lead is stored with null geo. Providers are injectable, so both failure
  modes are tested deterministically instead of by waiting for a real outage. Raw visitor IPs are not stored.
- **Durable outbox.** `notification_jobs` rows are claimed with `FOR UPDATE SKIP LOCKED` (safe with more than one
  worker), retried with exponential backoff, reclaimed if a worker dies mid-job, and end in `dead_letter` with a
  failure alert (optional `ALERT_WEBHOOK_URL`, otherwise a structured log line).
- **Idempotency.** `(widget_id, idempotency_key)` is unique, so a retried submission returns the original ID; the
  outbox key `submission:<id>:confirmation` prevents duplicate notifications.
- **Abuse controls.** Token-bucket limits per client IP and per widget. A burst is throttled, `Retry-After` reports the
  exact recovery time, and *another* caller or the rest of the API (config, health, owner routes) is unaffected.
  An in-browser guard stops double submits with the same idempotency key, and the honeypot drops bot posts.
- **Tenant isolation in SQL.** Every owner query carries `tenant_id` from the verified JWT; the public path derives
  ownership from the widget row, never from request JSON.
- **Boundary validation.** Zod schemas at the HTTP edge, a JSON body cap, and a JSON error handler so a bad request is
  never a `500`.
- **Secrets.** Configuration is environment-only (`.env` is git-ignored, `.env.example` is committed); the app refuses
  to boot with a `JWT_SECRET` shorter than 32 characters. Nothing secret is logged.

## Database

```
tenants(id, name UNIQUE)
users(id, tenant_id → tenants, email UNIQUE, password_hash)          -- scrypt hashes
widgets(id, tenant_id → tenants, public_id UNIQUE, kind, title, description,
        fields JSONB, button_text, display_options JSONB,
        allowed_origins TEXT[], version, status, timestamps)
submissions(id, tenant_id → tenants, widget_id → widgets, fields JSONB,
        idempotency_key, geo_country, geo_city, geo_provider, created_at)
        UNIQUE (widget_id, idempotency_key)
notification_jobs(id, submission_id → submissions, idempotency_key UNIQUE,
        status, attempts, next_attempt_at, last_error, timestamps)
```

Migrations run on boot and are recorded in `schema_migrations`. Indexes cover tenant/widget ownership and status,
`(tenant_id, created_at DESC)` for dashboard lists and timelines, `(tenant_id, geo_country, created_at DESC)` for the
geo breakdown, `(widget_id, created_at DESC)` for per-widget history, due outbox jobs
`(status, next_attempt_at, id)`, and a partial index on dead-lettered jobs.

## Configuration

`.env.example` lists every variable with safe local values. Notable ones: `PORT`, `PUBLIC_BASE_URL` (the origin used in
generated snippets and config `submitUrl`), `DATABASE_URL`, `TEST_DATABASE_URL`, `JWT_SECRET` (≥32 chars),
`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_PER_WIDGET_MAX`, `BODY_LIMIT`, `GEO_TIMEOUT_MS`,
`NOTIFICATION_POLL_MS`, `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_BASE_DELAY_MS`, `ALERT_WEBHOOK_URL`,
`DEMO_PORT`, and `DEMO_ALLOWED_ORIGINS` (extra exact origins for the seeded demo widget, e.g. when a hosted preview
serves the demo page on another host).

## Optional: see the email side effect in a mailbox

The default notification transport is a structured console log. To watch the confirmation actually get delivered,
start the bundled Mailpit catcher and switch the transport:

```bash
docker compose up -d mailpit                          # SMTP on :1025, web UI on http://localhost:8025
NOTIFICATION_TRANSPORT=smtp docker compose up -d --force-recreate app   # or set it in .env
curl -X POST 'http://localhost:3000/submissions?widget_id=demo-contact-widget-a' \
  -H 'origin: http://localhost:5500' -H 'content-type: application/json' \
  -d '{"fields":{"name":"Ada","email":"ada@example.test","message":"Hello"}}'
open http://localhost:8025                            # the message "New lead #<id>" is in the inbox
```

The SMTP adapter is a ~100-line dependency-free client (`createSmtpNotifier` in `src/notifications.js`), so the $0 stack
stays intact. It is still a **side effect**: if the catcher is down the submission still returns `201` and is stored, the
job retries, and it ends in `dead_letter` with an alert. Header values are stripped of CR/LF so a submission cannot
inject mail headers. Switch back with `NOTIFICATION_TRANSPORT=console`.

## Verification walkthrough

`scripts/verify-walkthrough.sh` starts from a destroyed stack and checks every externally checkable promise in the
brief — owner auth and CRUD, tenant isolation, snippet generation, cache headers and ETag revalidation, versioned bundle
and stale-version handling, CORS/preflight, every validation status code, honeypot, persistence and tenant linkage,
dashboard reads, statistics, burst throttling, and the outbox — printing one `PASS`/`FAIL` line per check. It exits
non-zero on any failure.

```bash
docker compose down -v && docker compose up -d --build --wait app
docker compose exec app npm run seed
bash scripts/verify-walkthrough.sh          # 50 checks
node scripts/verify-browser.mjs             # optional Chromium pass (needs: npm i --no-save playwright)
```

`VERIFICATION.md` maps every statement in the brief to a verdict and the transcript that proves it.

## Tests and evidence

`npm test` runs 19 integration tests against real PostgreSQL with deterministic provider/notifier mocks: the hardened
submission path (CORS, enrichment, fallback, all-down, validation, rate limits, honeypot, idempotency), the durable
outbox and worker, widget delivery and caching, tenant-scoped dashboard reads and statistics, and the rate limiter's
recovery behaviour. `test/phase2.test.js`, `test/phase3.test.js` and `test/notifications-smtp.test.js` are all part of that suite; the SMTP
tests run against an in-process fake SMTP server, so they need no Mailpit and no network. The command uses
`--test-concurrency=1` because every file truncates the shared `_test` database between its own fixtures.

- `VERIFICATION.md` — statement-by-statement verdict against the brief, with the commands and transcripts behind it.
- `EVIDENCE.md` — one proof per required checkpoint, plus the six acceptance probes.
- `evidence/acceptance-probes.txt` — real `npm run probes` transcript.
- `evidence/*.png` — Chromium screenshots of the widget on `localhost:5500` and the owner dashboard showing the stored lead.
- `BUILDLOG.md` — what each session built, the problems hit, and what changed as a result.
- `DESIGN.md` — design, layers, and the explicit non-goals.
- `capstone.yaml` — the evaluator manifest (run, seed, test, base URL, endpoints to probe).
- `.github/workflows/ci.yml` — CI runs the same suite against a PostgreSQL service container.

## Deliberate limitations

- Everything runs locally: no hosting, CDN, custom domain, or paid email provider. The default notification adapter logs
  a structured `confirmation_notification_sent` event; the optional SMTP adapter delivers into the bundled Mailpit
  catcher. A real provider would only need to implement `send({submissionId, idempotencyKey})`.
- Rate-limit buckets live in one process and reset on restart; this is not a distributed quota service.
- Client IPs are `req.ip` as seen by Node. Behind a reverse proxy you must configure trusted proxies before relying on
  per-IP limits or geo lookups.
- Live geo enrichment needs outbound internet and a routable visitor IP; private/container addresses yield null geo,
  which is the documented degrade path. No raw IPs are persisted and there is no retention/GDPR workflow.
- The widget supports `text`, `email`, `textarea`, and `tel` fields with `light`/`dark` themes and
  `inline`/`popover` positioning. It is intentionally not a form builder, and there is no live-updating dashboard,
  targeting rule, CAPTCHA, or account sign-up.
- The owner dashboard is a small static page against the API, not a front-end product.


## License

MIT — see `LICENSE`.
