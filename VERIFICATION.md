# Walkthrough verification — every claim in the brief, checked

**Date:** 2026-10-16 (Asia/Karachi). **Method:** started from a destroyed stack (`docker compose down -v`, volumes
removed), rebuilt and seeded it, then executed each promise in the brief against the live system. Nothing below is
quoted from an earlier session; each line was re-produced today.
**Machine state during verification:** Node 20.20.2, Docker Compose 2.26.1, PostgreSQL 16 container, Chromium
(Playwright) for the browser pass. Any single check can be re-run with `scripts/verify-walkthrough.sh`.

| Artefact | What it contains |
|---|---|
| `EVIDENCE.md` | One proof per required checkpoint, plus the six acceptance probes |
| `evidence/acceptance-probes.txt` | Real `npm run probes` transcript |
| `evidence/*.png` | Chromium screenshots of the widget on `localhost:5500` and the owner dashboard |
| `scripts/verify-walkthrough.sh` | The 50-check walkthrough, re-runnable against a live stack |

Reproduce the whole thing:

```bash
docker compose down -v && docker compose up -d --build --wait app
docker compose exec app npm run seed
bash scripts/verify-walkthrough.sh     # the 50-check script (needs sudo only if docker needs it here)
npm test && npm run probes
npm run demo:page                      # second terminal, then: node scripts/verify-browser.mjs
```

---

## Section 3 — Ground rules

| Statement in the brief | Verdict | Observed |
|---|---|---|
| One separate, public GitHub repository | **Met** | `github.com/ammarasad2005/flyrank-capstone-widget-platform`, public, unrelated to any other work. Repository name follows the suggested `flyrank-capstone-<short-name>` pattern. |
| Write a one-page design doc first (problem, data model, API surface, layer sketch, one explicit non-goal) | **Met** | `DESIGN.md` has all five plus an explicit non-goal. Committed in the first two commits, before any feature code. |
| $0, no credit card, ever | **Met** | Only services touched: Docker, PostgreSQL, `ip-api.com`, `ipapi.co`, GitHub. No key, no account, no card consulted anywhere in code or config. |
| `BUILDLOG.md` kept honestly as the build proceeds | **Met** | `BUILDLOG.md` has one dated entry per session, each listing the concrete mistakes hit and their fixes (ORB-blocked redirect, missing `public/` in the image, reserved `name` field, `path.join` 500, fixed-window `Retry-After`, probe re-runs, SMTP banner stall). |
| Mock the geo providers for the fallback proof; real APIs only for manual dev | **Met** | Fallback and all-down proofs use injected providers in `npm test`; live calls happen only in dev/smoke runs. |
| Never commit an API key or SMTP credential; `.env` git-ignored, `.env.example` committed | **Met** | `.gitignore` line 7 ignores `.env`; `git ls-files` shows only `.env.example`; secret-pattern scan of the working tree and of `git log -p --all` returns 0 hits. |

## Section 4 — The five moving parts (+ dashboard)

### 4.1 Widget management API

| Statement | Verdict | Observed |
|---|---|---|
| Authenticated CRUD for widgets | **Met** | create `201`, read `200`, patch `200` with `version` 1→2, delete `204` (archive); unauthenticated → `401`; wrong password → `401` |
| Rejected without valid auth | **Met** | `GET /api/widgets` without a token → `401` (checked in the walkthrough and in tests) |
| Type (signup form / CTA / popover), title, description, form fields, button text, display options | **Met** | `kind` ∈ `signup`, `contact`, `cta`; `displayOptions{theme:light|dark, position:inline|popover}`; walkthrough created a `signup` widget and read back the others. One demo widget is `contact`; the second created during verification is `signup`. |
| Widgets tenant-isolated — one customer can never see or edit another's | **Met** | Tenant B against Tenant A's widget: read `404`, patch `404`, delete `404`, embed `404`; Tenant A's own read `200`; Tenant B's list shows only its own rows |
| Full CRUD, validated, correct status codes | **Met** | invalid body (bad kind, empty title, empty fields) → `422` with `issues[]` |

### 4.2 Embed snippet generation

| Statement | Verdict | Observed |
|---|---|---|
| API returns the one line to paste | **Met** | `GET /api/widgets` and `GET /api/widgets/:id/embed` both return `<script src="http://localhost:3000/public/widget.js?id=demo-contact-widget-a" async></script>` — asserted string-equal to the brief's shape |
| Everything the snippet needs flows from it automatically | **Met** | The bundle derives its own API origin and widget ID from its own `<script src>`, then loads config and renders; the page contains no other integration code |

### 4.3 Fast, cached widget delivery

| Statement | Verdict | Observed |
|---|---|---|
| Public config endpoint, small payload, correct cache headers | **Met** | `GET /widgets/demo-contact-widget-a/config` → `200`, 556 bytes, `Cache-Control: public, max-age=60, must-revalidate`, `ETag`, `304` on `If-None-Match`, `Access-Control-Allow-Origin: *` |
| Versioned bundle (new version = new URL or cache-bust) | **Met** | `/public/widget.v1.js` served `application/javascript`, `Cache-Control: public, max-age=31536000, immutable`, `X-Widget-Bundle: v1`; any other version → `410 stale_widget_bundle`; a release bumps `WIDGET_ASSET_VERSION` so both the immutable URL and the alias change together |
| Small payloads / CDN-like behaviour | **Met** | config 556 bytes, bundle 13.9 KB uncompressed, both revalidatable |
| Widget renders on a page from a different origin | **Met** | Chromium: page on `:5500`, API on `:3000`; widget rendered with title, 3 fields and button; `failedRequests: []`, `consoleMessages: []` |

### 4.4 Public submission endpoint

| Statement | Verdict | Observed |
|---|---|---|
| Accepts cross-origin requests with correct CORS | **Met** | `POST` with `Origin: http://localhost:5500` → `201` and `Access-Control-Allow-Origin: http://localhost:5500`; a non-allowlisted origin → `403` |
| Preflight (`OPTIONS`) handled | **Met** | `OPTIONS` → `204` with `Allow-Origin` echo, `Allow-Methods: POST, OPTIONS`, `Allow-Headers: Content-Type, Idempotency-Key`, `Max-Age: 600`. In the real browser the CDP log shows the preflight **request and a 204 response** before the POST. |
| Validate every field before business logic | **Met** | invalid email `422`, missing required `422`, unknown top-level key (`tenantId`) `422`, non-object body (`[]`) `422`, malformed JSON `400`, oversized `413` — never `500` |
| Reject invalid/oversized with 4xx + error message | **Met** | all bodies are JSON `{error, issues?}` |
| Store what passes, linked to the right widget and tenant | **Met** | stored row read directly from PostgreSQL: `id=1, tenant_id=1, widget_id=1, public_id=demo-contact-widget-a, widget.tenant_id=1`; the client never sends a tenant |
| Server never trusts the client | **Met** | ownership, allowed origins and field definitions all come from the widget row; a `tenantId` in the body is rejected outright |

### 4.5 Protection, enrichment, safe side effects

| Statement | Verdict | Observed |
|---|---|---|
| Rate limiting per IP and per widget | **Met** | per-IP token bucket and per-widget bucket; burst → `429 rate_limit_exceeded` with `Retry-After: 6` |
| A flood must not take you down; API keeps serving | **Met** | during the throttle, `/health` `200` and `/widgets/:id/config` `200`; after `Retry-After`, a normal submission → `201` |
| At least one spam control, demonstrably blocking | **Met** | honeypot `website`: filled → `202` acknowledged, stored leads `1 → 1` (live) and the test asserts no row is created; the bundle renders it off-screen (`aria-hidden`, `tabindex=-1`, outside the viewport) so humans never see it |
| Enrichment tries provider A, then B | **Met** | `ip-api.com` → `ipapi.co`, each bounded by `GEO_TIMEOUT_MS`; provider failure logged without the visitor IP. `npm run geo:check -- 8.8.8.8` shows a real answer from provider A while provider B was rate-limited, and the chain still returned enrichment |
| A down, B answers → stored enriched by B | **Met** | test `provider A failure falls back to provider B and stores provider-B enrichment` asserts the persisted country/city/provider |
| All providers down → still succeeds without geo | **Met** | test `both geo providers failing does not prevent durable submission storage` → `201`, row present, geo columns null. Live runs show the same degrade path with a private visitor IP (`geo_provider_failed` logged, lead stored, `unknown` in the geo breakdown). |
| Safe side effect after storage; failure must not block success | **Met** | lead + outbox row in one transaction; test `notification failure retries to dead letter and alerts without losing the submission` throws three times, dead-letters, fires the alert, and the lead is still stored |
| Non-critical operations never break the main path | **Met** | geo and notifier both have their own failure boundary; neither can roll back or delete a stored lead |

### 4.6 Owner dashboard API

| Statement | Verdict | Observed |
|---|---|---|
| Authenticated owner views their submissions | **Met** | `GET /api/submissions?limit=5` → the stored lead with fields, geo and timestamp; `GET /api/submissions/:id` → `200` |
| Counts over time | **Met** | `GET /api/stats?days=7` → 7 zero-filled `byDay` buckets, last day `{date: 2026-10-16, count: 22}` |
| Per-widget stats | **Met** | `byWidget[0] = {publicId: demo-contact-widget-a, status: active, count: 22}` |
| Geo breakdown | **Met** | `byCountry = [{country: unknown, count: 22}]` locally; `Germany` in tests where a provider answered |
| Endpoints + a simple table are enough | **Met** | endpoints plus `/demo/dashboard.html` (same-origin static page) rendering totals, chart, breakdowns, snippet and the submission table |
| Tenant isolation for submissions too | **Met** | Tenant B: list total `0`, other tenant's submission `404`, stats total `0` |

## Section 6 — Requirements checklist

Every box below was re-checked today; `EVIDENCE.md` carries the matching proof for each.

| # | Requirement | Verdict |
|---|---|---|
| 1 | Authenticated CRUD; no-auth rejected | **Met** |
| 2 | Multi-tenant isolation proven for widgets and submissions | **Met** |
| 3 | Embed snippet per widget | **Met** |
| 4 | Public config with correct cache headers | **Met** |
| 5 | Widget JS served as a versioned bundle | **Met** |
| 6 | Widget renders on a different origin | **Met** (Chromium) |
| 7 | Cross-origin submissions work, CORS + preflight | **Met** |
| 8 | All input validated; malformed/oversized → 4xx JSON | **Met** |
| 9 | Valid submissions stored, linked to widget + tenant | **Met** |
| 10 | Rate limiting → 429 under burst, service keeps serving | **Met** |
| 11 | Spam technique demonstrably blocks spam | **Met** |
| 12 | Provider fallback A → B enriches | **Met** |
| 13 | All providers down → still stored without geo | **Met** |
| 14 | Failing email/webhook does not prevent storage | **Met** |
| 15 | README + required files | **Met** |

## Section 7 — Realistic scope (where to stop)

| Statement | Verdict |
|---|---|
| Customer site is a plain HTML file on a second port or `file://` | **Met** — `demo/index.html` on `:5500`, one `<script>` tag |
| Widget UI can be minimal | **Met** — fields, button, status line, theme/position; styled but not a UI product |
| One or two widget types are enough | **Met** — `signup`, `contact`, `cta` modelled; `contact` and `signup` exercised live |
| Email can be fake (console/Mailpit) | **Met** — structured `confirmation_notification_sent` log line; failure-tolerance is what is tested |
| Mock geo providers for the fallback proof | **Met** |

## Section 8 — Phase gates

| Phase | Gate | Verdict |
|---|---|---|
| 1 Design | One-page design doc committed | **Met** |
| 2 Hardened submission path | A cross-origin curl stores an enriched row | **Met** — live `201` + stored row (`scripts/verify-walkthrough.sh`), enriched by provider A in the deterministic test; local container IP degrades to null geo |
| 3 Delivery, dashboard & proof | Widget renders on a second-origin page | **Met** — Chromium render, preflight 204, submit, dashboard read-back (`evidence/*.png`) |

## Section 9 — Stretch goals

Deliberately **not** attempted (per the brief: only after every Section 6 box is green, and per the agreed scope
decision). Current repo contains no minified production bundle, no WebSocket/SSE dashboard, no targeting rules, no
GDPR/double opt-in, no CAPTCHA/proof-of-work. The deterministic test suite is the one stretch item that is effectively
present, and the brief notes tests are valuable regardless.

## Section 10 — The $0 stack

| Need | Brief's free option | What the project uses | Verdict |
|---|---|---|---|
| Language + framework | Node + Express or Python + FastAPI | Node 20 + Express 4 | **Met** |
| Database | PostgreSQL via Docker (or SQLite) | PostgreSQL 16 via Compose, versioned migrations | **Met** |
| Geo A | `ip-api.com`, no key | `http://ip-api.com/json/…` | **Met** |
| Geo B | `ipapi.co` | `https://ipapi.co/…/json/` | **Met** |
| Email side effect | Console or Mailpit | Console log by default; optional SMTP adapter delivering into the bundled Mailpit catcher (see `EVIDENCE.md` §6) | **Met** |
| Customer site | `npx serve` / `python -m http.server` on a second port | `npm run demo:page` (20-line static server, port 5500) | **Met** |
| Repo + CI | Public GitHub repo | Public repo + `.github/workflows/ci.yml` (PostgreSQL service, `npm test`, audit) | **Met** |
| Hosting | None required | None used; everything local | **Met** |

## Section 11 — GitHub rules

| Statement | Verdict | Observed |
|---|---|---|
| Dedicated public repo, not inside other work | **Met** | Separate repo, 52 tracked files |
| Clear name | **Met** | `flyrank-capstone-widget-platform` |
| Commit as you build, meaningful messages, one per session, each phase visible | **Met** | 23 commits across five evening sessions (12–16 Oct 2026): design → scaffold → auth/API → Phase 2 hardened path → Phase 3 delivery → evidence. Timestamps are the real local clock, Asia/Karachi. |
| Never commit a secret; `.env` ignored, `.env.example` shipped | **Met** | Scans above; `.env.example` has placeholders for every variable |
| A stranger can run it with one documented command + seed | **Met** | fresh clone → `npm ci` → `docker compose config` valid → full suite green (19/19) |
| `README.md` with what/architecture/run+seed/API/limitations | **Met** | README has all five sections |
| `capstone.yaml` with `run`, `seed`, `test`, `base_url`, endpoints | **Met** | Keys present and matching the README commands |
| `EVIDENCE.md` one proof per checkbox | **Met** | 15-row checklist + 6 probes + browser proof + clean-clone check |
| `BUILDLOG.md` development log | **Met** | Five dated entries covering all three phases, with the problems hit and their fixes |
| `.env.example` with every variable | **Met** | 18 variables, all optional ones blank |
| License | **Met** | MIT |
| `main` always runnable | **Met** | A fresh `git clone` of the default branch installs with `npm ci`, passes `docker compose config`, and runs 19/19 tests. |
| Don't commit `node_modules`, datasets, force-push | **Met** | `node_modules` and datasets are untracked; the largest tracked files are three evidence PNGs (≤204 KB) |

## Section 13 — Evaluation layers

**Layer 1, submission pack (machine-checkable):** all required files present in the pushed tree; `run`, `seed`, `test`,
`base_url` present in `capstone.yaml` and identical to the README; `test` command exits 0.

**Layer 2, acceptance probes:**

| Probe | Verdict | Observed today |
|---|---|---|
| 1 — valid submission from the second-origin page → 2xx, stored, visible via dashboard API | **Pass** | Browser submit → `201`, lead `22` visible in `/api/submissions`; scripted probe 1 also passed |
| 2 — malformed and oversized → clean 4xx, never 500 | **Pass** | `400 malformed_json`, `413 payload_too_large`, JSON bodies |
| 3 — burst → 429s, then a normal request succeeds | **Pass** | 11 submissions → `429`, `Retry-After: 6`, service still up, next request `201` |
| 4 — provider A off → B enriches; both off → stored without geo | **Pass** | deterministic tests, both green |
| 5 — side effect throws → still success and stored | **Pass** | dead-letter + alert, lead intact |
| 6 — honeypot filled → dropped or rejected | **Pass** | `202`, no row created |

**Shared requirements:**

| # | Requirement | Verdict | Observed |
|---|---|---|---|
| 1 | Layered data/logic/HTTP | **Met** | `app.js` (HTTP) → `validation.js`/`widget-payloads.js` → `repositories.js` → migrations; no SQL in route handlers |
| 2 | Validation at the boundary, bad input → 4xx never 500 | **Met** | every malformed case above; the error handler maps parser errors to JSON 400/413 |
| 3 | ≥1 background job with retries + failure alert | **Met** | outbox with `SKIP LOCKED` claims, exponential backoff, `dead_letter`, alert callback; live: `succeeded` jobs, 11 `confirmation_notification_sent` log lines |
| 4 | Real persistence: migrations, indexes, isolated tenants | **Met** | 2 migrations applied, 22 indexes listed, isolation checks above |
| 5 | Idempotency where it matters | **Met** | repeated `Idempotency-Key` → `200 reused:true`, same submission; one outbox job per submission (12 submissions ↔ 12 jobs) |
| 6 | Secrets clean: env only, never logged | **Met** | env-only config, boot-time `JWT_SECRET` length check, no secret or raw IP in logs |
| 7 | Per-call cost tracked if a paid model API is used | **N/A, correctly** | The application makes no runtime calls to any paid or model API, so no per-call cost or budget guard applies |

## Section 12 — Submission mechanics

| Statement | Status |
|---|---|
| Submission is the repository link in the portal form (not a ZIP) | **Not done, intentionally** — you instructed me not to submit the portal form. The repo link is ready: `https://github.com/ammarasad2005/flyrank-capstone-widget-platform` |
| Review is asynchronous | Informational |

---

## Summary

- **50/50** scripted live checks passed (`scripts/verify-walkthrough.sh`), repeatably — each run uses a fresh idempotency key.
- **19/19** integration tests, **6/6** acceptance probes, **0** audit vulnerabilities.
- **Every Section 6 checkbox and every Section 13 probe is met and re-proved today** from a destroyed stack.
- Two honest, documented gaps rather than failures:
  1. ~~`main` does not contain the system yet~~ — **fixed**: `main` now holds the full system and the gate was re-run on it.
  2. **Live geo is null locally** (private container/browser IP). The brief's enrichment and fallback promises are proved with deterministic mocks, which the brief explicitly asks for; a real public IP would enrich.
- Scope limits that are intentional and documented: in-process rate buckets, static dashboard page, console notification adapter by default (optional Mailpit is available), no hosting, no stretch goals.

### Follow-up items closed after this walkthrough

| Item | Status |
|---|---|
| Live geo never demonstrated with a public IP | **Closed** — `npm run geo:check` shows provider A answering for `8.8.8.8` (see `EVIDENCE.md` §6) |
| Email side effect only ever logged to the console | **Closed** — optional SMTP transport delivers real mail into the bundled Mailpit catcher, with three new tests (delivery, header-injection defence, unreachable-catcher retry → dead letter) |
| `main` not containing the system | **Closed** — the default branch carries the completed system and the full gate runs on it |
