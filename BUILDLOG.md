# BUILDLOG.md — development log

Implementation notes for the embeddable widget / lead-capture platform: what was built in each working session,
which problems were hit, and what changed as a result.

## 2026-10-12 — Phase 1: design and scope

- Read the 11-page FlyRank Lead-Capture capstone brief and extracted its requirements, acceptance probes, scope
  boundaries, and submission-pack rules; drafted `DESIGN.md` and the initial README from that.
- No application code, production credential, geo-provider call, or email/webhook service was touched in this session.
  A public GitHub API lookup was used only to check whether the suggested repository name was already taken.
- The design proposes Node.js/Express, tenant-scoped JWT authentication, PostgreSQL migrations, provider adapters, and
  a database-backed notification outbox. These are design choices, not implemented behaviour.
- Environment check: Node.js 20.20.2 and npm 10.8.2 were present; Docker and `psql` were not. PostgreSQL via Docker
  Compose was selected as the database, so integration runs happen on a Docker host or in CI.

## 2026-10-15 — Phase 2: hardened submission path

- Built the Phase 2 infrastructure: PostgreSQL migration and pool/transaction helpers, seed fixtures, password and
  JWT auth, tenant-scoped widget routes, the submission path (CORS, validation, rate limiting, honeypot), the geo
  adapter, the notification outbox worker, tests, the smoke script, and documentation.
- **Problems hit and fixed:**
  - Deriving the Zod 4 update schema by calling `.partial()` on a refined object failed at module import. The schemas
    were restructured around a shared base shape.
  - The first PostgreSQL-backed test run exposed a missing `ipResolver` binding in the HTTP app; the suite passed
    once it was wired in.
  - The partial-update schema reset widget settings that the caller had omitted; it now leaves untouched columns alone.
  - `npm install` surfaced a high-severity Zod advisory. Zod was upgraded to the fixed v4 line (`^4.6.7`) and the
    update path was adapted to the installed API; `npm audit --audit-level=high` then reported zero vulnerabilities.
- **Runtime evidence:** PostgreSQL 16 through Docker Compose, including the separate `widget_platform_test` database.
  The Node 20 image built with `npm ci --omit=dev`, `/ready` returned ready, and the seed command succeeded twice.
  `npm test` exercised the real database and migrations: 8 tests passed, 0 failed. The live smoke returned HTTP 201,
  passed CORS preflight, and verified the lead plus its outbox row; the worker then marked the job `succeeded` in one
  attempt and logged the confirmation event. Geo stayed null for the Docker bridge address. See `EVIDENCE.md` for the
  named probes and the exact verification boundary.
- Geo fallback/outage and notifier-failure tests use deterministic injected mocks. The smoke made real geo-provider
  calls, but no enrichment was returned for the container address. No email service, alert webhook, browser widget, or
  public deployment was exercised in this Phase 2 verification. No production credentials were added to the repository.
- **Scope boundary:** work stops at the Phase 2 hardened submission gate. Widget assets/config, browser rendering from
  a separate page, dashboard submission/statistics reads, and the evaluator manifest remain Phase 3 work.

## 2026-10-16 — Phase 3: delivery, dashboard and proof

- Built the versioned browser bundle (`public/widget.v1.js`), the public config/bundle endpoints with cache and ETag
  handling, embed-snippet generation and `/api/widgets/:id/embed`, the tenant-scoped `GET /api/submissions`,
  `GET /api/submissions/:id` and `GET /api/stats` queries and indexes, the static owner dashboard and second-origin
  demo page, the demo static server, the acceptance-probe script, `capstone.yaml`, and the CI workflow.
- **Problems hit and fixed:**
  - The first bundle design let the snippet use a stable `widget.js` URL that *redirected* to the versioned file.
    Chromium blocked the cross-origin script with `ERR_BLOCKED_BY_ORB` (Opaque Response Blocking rejects cross-origin
    script redirects), so the page rendered nothing. The alias now answers `200` directly with a short cache while
    `/public/widget.v1.js` stays long-cached and immutable.
  - The first Docker build omitted `public/` and `demo/`, so the running container answered `500` for the bundle
    (`ENOENT /app/public/widget.v1.js`). The `Dockerfile` now copies both directories and the bundle serves
    `200 application/javascript`.
  - The reserved-field list initially blocked the common `name` field, which silently dropped a required field from the
    public config. The list was reduced to names the bundle itself uses (`website`, `id`, `password`, `action`,
    `method`, `type`) and a test pins the behaviour.
  - `sendValidationError` called `path.join`, which crashed on the plain-string paths used by the new query-parameter
    validators (`500` instead of `422`). It now handles both array and string paths.
  - Rate limiting was a fixed window, so a caller blocked at the end of a window stayed blocked until the window rolled
    over even though `Retry-After` promised recovery. Replaced with a token bucket so `Retry-After` is accurate and
    normal traffic recovers on schedule; a unit test pins burst → throttle → recovery.
  - The ETag/`304` tests initially failed under Node's `fetch`, which sends `cache-control: no-cache` (making
    `req.fresh` correctly false). The tests now use a raw `http.request` for conditional GETs instead of weakening the
    check.
  - The acceptance-probe script failed its second consecutive run because the caller's IP bucket was still drained,
    turning probes 2 and 6 into `429`s. Probes that are not about throttling now honour `Retry-After` and retry.
- **Verification:** `npm test` — 15 PostgreSQL-backed tests passed (8 Phase 2 + 7 Phase 3), including a run against a
  freshly created empty database to validate the CI job; `npm run probes` — 6/6 acceptance probes passed live; a real
  Chromium session rendered and submitted the widget from `http://localhost:5500` and showed the lead in the owner
  dashboard (screenshots in `evidence/`); `npm audit --audit-level=high` — 0 vulnerabilities.
- Geo in the live container/browser runs is null because the visitor address is private; the enrichment and
  both-providers-down guarantees are proved with the injected mocks, not claimed from the live run. No production
  credentials were added to the repository.
- **Scope boundary:** work stops at the Phase 3 gate. Stretch goals (real-time dashboard, targeting rules, CAPTCHA,
  double opt-in, hosted deployment) were deliberately not started.

## 2026-10-16 — Full verification walkthrough against the brief

- **What was done:** destroyed the stack (`docker compose down -v`), rebuilt and re-seeded it from scratch, then
  re-executed every externally checkable promise in the brief rather than trusting earlier runs. Added
  `scripts/verify-walkthrough.sh` (50 live checks), `scripts/verify-browser.mjs` (the Playwright pass, kept out of the
  project's dependencies), and `VERIFICATION.md` with one verdict per statement. The README gained a short section
  pointing at them.
- **Corrections made while verifying:** an earlier browser report logged `honeypotOffscreen: false` because the check
  measured the hidden input rather than its clipped wrapper; the verifier now records the wrapper's aria/offscreen
  state, the input's `tabindex`, and whether the input is inside the viewport, and reports `true` for off-screen. The
  acceptance-probe script's second-consecutive-run failure (a drained IP bucket turning probes 2 and 6 into 429s) was
  fixed the same day by honouring `Retry-After` in the probes that are not about throttling.
- **Result:** 50/50 walkthrough checks, 15/15 integration tests, 6/6 acceptance probes, 0 audit vulnerabilities, and a
  clean clone of the repository installs and passes. Every statement in the brief had a verdict at that point.

## 2026-10-16 — Close-out: live geo check and the Mailpit transport

- **Why:** two items from the verification pass had only ever been shown through mocks or console output — live geo
  enrichment and the email side effect. Both were closed before the final commit.
- **Added:** `scripts/geo-check.js`, the dependency-free SMTP client (`createSmtpNotifier`), the
  `src/notifier-factory.js` selection point, the Mailpit compose service, the transport configuration, and
  `test/notifications-smtp.test.js` (delivery against an in-process fake SMTP server, header-injection defence, and an
  unreachable-catcher retry that dead-letters while the lead survives).
- **Problems hit and fixed:**
  - The first SMTP state machine processed only the first line of each TCP chunk, so a multi-line banner (`250-…`) left
    the client waiting for data that had already arrived and every send timed out. The handler now drains every
    complete line in the buffer and acts only on the final line of a reply.
  - The same handler initially stalled on the server greeting (the first step sends nothing), which the timeout hid as
    "smtp timeout" rather than a protocol error.
  - `test/notifications-smtp.test.js` read the same `fetch` response body twice (`text()` then `json()`), failing with
    "Body is unusable".
  - A retry loop in the new test compared the worker's Node clock against PostgreSQL's `now()` within the same
    millisecond, so the job was sometimes not yet due and the test flaked. The test now backdates the retry by a
    second instead of racing the clock.
  - The walkthrough script used a hard-coded `Idempotency-Key`, so a second run legitimately returned `200 reused` and
    looked like a failure. It now generates a unique key per run, and the suite passes repeatedly.
- **Also recorded:** `npm test` runs with `--test-concurrency=1`, because the three test files each truncate the shared
  `_test` database between fixtures; parallel files were able to delete each other's rows.
- **Verification after changes:** `npm test` 19/19 (four consecutive runs), `npm run probes` 6/6,
  `bash scripts/verify-walkthrough.sh` 50/50 twice in a row, `npm run geo:check -- 8.8.8.8` returned a real
  enrichment from provider A while provider B was rate-limited, and a submission with `NOTIFICATION_TRANSPORT=smtp`
  produced a "New lead #4" email in Mailpit with the outbox row `succeeded` in one attempt.
