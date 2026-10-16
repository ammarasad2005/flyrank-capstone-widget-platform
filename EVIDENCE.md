# Evidence

**Verification date:** 2026-10-16 (Asia/Karachi). **Environment:** Node.js 20.20.2, npm 10.8.2, Docker Compose
PostgreSQL 16, the Compose app image (Node 20 Alpine), Chromium via Playwright for the browser run.
Integration tests use real PostgreSQL with deterministic injected geo-provider and notifier doubles; no external geo
API, email service, or alert webhook is required for them.

Reproduce everything below from the repository root:

```bash
docker compose up -d --build --wait app
docker compose exec app npm run seed
npm test                 # 19 integration tests against widget_platform_test
npm run probes           # the six acceptance probes against the running stack
npm run demo:page        # http://localhost:5500 — the second-origin customer page
```

## 1. Requirements checklist (Section 6 of the brief)

| Requirement | Concrete proof | Result |
|---|---|---|
| Authenticated widget CRUD; requests without valid auth rejected | `owner auth and widget CRUD are tenant-scoped` — logs in both seeded owners, asserts `401` without a token, then create/read/update/archive for Tenant B | Pass |
| Multi-tenant isolation for widgets **and** submissions | Same test: Tenant B gets `404` reading/updating/deleting Tenant A's widget. `dashboard submission reads and statistics are tenant-scoped and filterable`: Tenant B's `/api/submissions` total is `0`, `/api/submissions/:id` for Tenant A's lead is `404`, `/api/stats` totals are `0` | Pass |
| Embed snippet generated per widget | `owner widget responses expose a generated embed snippet and the embed endpoint agrees` — asserts the exact `<script src="http://localhost:3000/public/widget.js?id=demo-contact-widget-a" async></script>` from `GET /api/widgets` and `GET /api/widgets/:id/embed`; the same snippet is rendered in `evidence/dashboard-owner-view.png` | Pass |
| Public config with correct cache headers | `public widget config serves a cached, CORS-readable payload for the active widget` — `Cache-Control: public, max-age=60, must-revalidate`, `ETag`, `ACAO: *`, `304` on `If-None-Match`, no tenant ID or owner email in the body, `404` for an unknown widget. Live: `curl -sD- http://localhost:3000/widgets/demo-contact-widget-a/config` | Pass |
| Versioned widget JavaScript | `widget bundle is served as a versioned, immutable asset with a stable alias` — `/public/widget.v1.js` → `200`, `max-age=31536000, immutable`, ETag + `304`, `X-Widget-Bundle: v1`; stable alias `/public/widget.js?id=…` → `200`, `max-age=300`; `/public/widget.v0.js` → `410 stale_widget_bundle`; path traversal → `404` | Pass |
| Widget renders on a page from a different origin | Chromium run against `http://localhost:5500/` (API on `:3000`): widget rendered with title "Talk to our team", fields `name`, `email`, `message`, honeypot off-screen, no console errors, no failed requests → `evidence/widget-second-origin.png`; after submit `Thanks — your message has been received.` → `evidence/widget-submitted-second-origin.png` | Pass |
| Cross-origin submissions: CORS + preflight | `cross-origin preflight and accepted submission persist provider-A enrichment and enqueue one notification` — `OPTIONS` returns `204` with `ACAO` echoing the origin, allowed method `POST`, allowed headers including `Idempotency-Key`; the follow-up POST carries `ACAO`. Browser run exercises the real preflight path | Pass |
| All input validated; malformed and oversized payloads → 4xx JSON | `malformed, oversized, invalid, and honeypot submissions fail safely or are silently dropped` — invalid email `422`, malformed JSON `400 malformed_json`, 512-byte limit overflow `413 payload_too_large`, unknown top-level key `422`, all JSON with CORS on an allowed origin. Live: probe 2 → `400`/`413` | Pass |
| Valid submissions stored, linked to the right widget and tenant | Cross-origin test queries the row and asserts `tenant_id`/`widget_id` come from the widget record; probe 1 reads the new lead back via `GET /api/submissions`; browser run shows the lead in the dashboard table | Pass |
| Rate limiting per IP and/or widget → 429, service keeps serving | `per-IP rate limiting returns 429 without blocking a different visitor` (API level) and `token bucket throttles a burst, then admits the next request once Retry-After elapses` (limiter unit). Live probe 3: burst → `429 rate_limit_exceeded` with `Retry-After`, `/health` `200`, `/widgets/…/config` `200`, next submission after the wait → `201` | Pass |
| At least one spam control demonstrably blocks spam | Honeypot `website`: API test proves the submission count does not increase; live probe 6 → `202` acknowledged with stored leads unchanged (`12 → 12` in `evidence/acceptance-probes.txt`); the bundle renders the honeypot off-screen and the owner fixture cannot declare a `website` field (`sample field names reserved for the engine are never rendered…`) | Pass |
| Geo fallback: A down → B answers → submission enriched | `provider A failure falls back to provider B and stores provider-B enrichment` (mocked provider A failure, real PostgreSQL row asserts the stored country/city/provider) | Pass |
| All providers down → still succeeds without geo | `both geo providers failing does not prevent durable submission storage` — `201`, row stored, all geo columns null | Pass |
| Failing confirmation/webhook does not prevent storage | `notification failure retries to dead letter and alerts without losing the submission` — notifier throws three times, alert fires, job ends `dead_letter`, the lead is still stored. Live worker evidence: a smoke lead's job reached `succeeded` after one attempt with `confirmation_notification_sent` logged | Pass |
| README (architecture, setup, API), required files | `README.md`, `DESIGN.md`, `EVIDENCE.md`, `BUILDLOG.md`, `capstone.yaml`, `.env.example`, `LICENSE` all present; README contains the architecture diagram, clean-clone run/seed steps, full API reference, and limitations | Pass |

## 2. Acceptance probes (Section 13, layer 2)

`npm run probes` — real transcript in `evidence/acceptance-probes.txt` (this run started with the caller's IP bucket
partly drained from an earlier probe pass, and recovered through the documented `Retry-After` path):

```text
PASS  Probe 1 — cross-origin submission stored and visible
      POST from Origin http://localhost:5500 → 201 (submission 12); dashboard API returns it
PASS  Probe 2 — malformed and oversized payloads get clean JSON 4xx
      malformed → 400 malformed_json; oversized → 413 payload_too_large
PASS  Probe 6 — filled honeypot is dropped without a stored lead
      honeypot submission → 202 acknowledged; stored leads 12 → 12
PASS  Probe 3 — burst is throttled and service keeps serving
      1 submissions before 429 (rate_limit_exceeded, Retry-After 6s); /health 200, config 200; after 6s wait the next submission → 201
PASS  Probe 4 — provider A down → provider B enriches; both down → still stored
      node --test --test-name-pattern "provider A failure falls back…|both geo providers failing…" → both tests passed
PASS  Probe 5 — failing notification does not block storage
      node --test --test-name-pattern "notification failure retries to dead letter" → passed

6/6 probes passed
```

Probes 4 and 5 have no live "turn the provider off" switch by design: the brief asks for deterministic mocks rather
than waiting for a real outage. The probe script runs those named integration tests and reports their outcome.

## 3. Browser evidence (the Phase 3 gate)

Chromium (Playwright) opened <http://localhost:5500/>, a static page that contains only the one-line snippet:

- `evidence/widget-second-origin.png` — page served from `localhost:5500`, API on `localhost:3000`, widget rendered
  by `/public/widget.js`.
- `evidence/widget-submitted-second-origin.png` — after a real submit from that page.
- `evidence/dashboard-owner-view.png` — `http://localhost:3000/demo/dashboard.html` signed in as
  `owner-a@example.test`, showing the submitted lead (`name: Browser Acceptance Lead · email: browser-…@example.test ·
  message: Rendered and submitted from http://localhost:5500 inside Chromium.`), the totals, the counts-over-time
  chart, per-widget stats, geo breakdown, and the generated snippet.

Recorded run facts: `renderedFieldNames: ["name","email","message"]`, `honeypotOffscreen: true`,
`failedRequests: []`, `consoleMessages: []`, `successText: "Thanks — your message has been received."`,
`metricSubmissions: "1"`.
Geo in that container/browser run is `unknown` because the request originates from a private address; enrichment and
its fallback are covered by the mocked tests above, which is the honest boundary of this evidence.

## 4. Shared requirements (Section 13)

| Requirement | Proof |
|---|---|
| Layered architecture | `src/app.js` (HTTP) → `src/validation.js`/`src/widget-payloads.js` (boundary) → `src/repositories.js` (data) → `db/migrations`. No SQL in route handlers; see `DESIGN.md`. |
| Validation at the boundary | Zod schemas plus widget-driven field validation; `400/413/422` JSON paths asserted in tests and probe 2. |
| ≥1 background job with retries + failure alert | `notification_jobs` outbox, `SKIP LOCKED` claims, exponential backoff, `dead_letter`, alert callback. Tests: `notification failure retries to dead letter and alerts…` and `background worker polls the durable outbox and completes a due notification`. |
| Real persistence, migrations, indexes, isolated tenants | `db/migrations/001_initial.sql`, `002_dashboard_and_delivery.sql`, `schema_migrations` table; isolation tests listed above. |
| Idempotency where it matters | `UNIQUE (widget_id, idempotency_key)` + `200 reused` in the cross-origin test; outbox key `submission:<id>:confirmation` makes notification retries single-delivery. |
| Secrets clean | Env-only configuration, `.env` git-ignored, `.env.example` with placeholders, boot-time `JWT_SECRET` length check, no secret or visitor IP logged. |
| Per-call cost tracked if a paid model API is used | **Not applicable** — the application makes no runtime calls to any paid or model API, so there is no per-call cost to track or budget to guard. |

## 5. Test suite

```text
1..19
# tests 19
# suites 0
# pass 19
# fail 0
```

`npm test` = `NODE_ENV=test node --test` against `widget_platform_test`. Phase 2 tests cover the hardened submission
path; Phase 3 tests cover config caching/revalidation, the versioned bundle and alias, embed snippets, tenant-scoped
submission reads and statistics, reserved-field filtering plus archived-widget cut-off, the served dashboard page, and
the rate limiter's recovery, plus the optional SMTP notifier (delivery to an in-process fake SMTP server, header-injection
defence, and an unreachable catcher retrying to `dead_letter` while the lead survives). The same suite also ran against a
brand-new empty database (migrations applied `001` and `002`) to confirm the CI path. `npm audit --audit-level=high` reports **0 vulnerabilities**. `git diff --check` is clean.

## 6. Live geo and Mailpit evidence

Both are optional extras, recorded so the claims are not just theoretical:

```text
$ npm run geo:check -- 8.8.8.8
providerA (ip-api.com) → {"country":"United States","city":"Ashburn","provider":"ip-api.com"}
providerB (ipapi.co)   → failed: ipapi.co returned HTTP 429
enrichment chain result (what would be stored) → {"country":"United States","city":"Ashburn","provider":"ip-api.com"}
PASS  the fallback chain returned enrichment
```

That is a real provider answering for a public IP, with the second provider rate-limited at the time — and the chain still
returned an enrichment. Private/container addresses legitimately resolve to null.

```text
$ NOTIFICATION_TRANSPORT=smtp docker compose up -d --force-recreate app   # Mailpit on :1025, UI :8025
$ curl -X POST '…/submissions?widget_id=demo-contact-widget-a' …          → {"received":true,"submissionId":4}
outbox: 4 | submission 4 | succeeded | attempts 1
mailpit messages (total 3):
 - New lead #4 → owner@example.test | A new lead was captured (submission 4). Widget: demo-contact-widget-a …
```

The confirmation email is really delivered, and the outbox row still reaches `succeeded` in one attempt.

## 7. Clean-clone check

A fresh clone of `main` was installed and run exactly as the README says, with no local state:

```text
git clone --branch main https://github.com/ammarasad2005/flyrank-capstone-widget-platform.git
npm ci                       → added 84 packages
docker compose config        → valid
npm test                     → 19 tests, 19 pass, 0 fail
npm audit --audit-level=high → found 0 vulnerabilities
```

The migration path was additionally exercised against a brand-new empty database (`ci_check_test`), where
`001_initial.sql` and `002_dashboard_and_delivery.sql` applied from scratch before the same 19 tests passed. That is
the path the GitHub Actions job in `.github/workflows/ci.yml` uses.

## 8. Scope notes

- Live geo enrichment depends on outbound internet and a routable visitor IP; the container/private address used in
  local verification returns no geo, which is the documented degrade path rather than a failure.
- Rate-limit buckets are per-process and reset on restart.
- Mailpit is an optional local container (`docker compose up -d mailpit`); the default transport is a console log, so the
  required path needs nothing extra.
- The dashboard is a static page against the authenticated API, not a front-end product.
