# Design — Embeddable Widget & Lead-Capture Platform

**Snapshot:** Phase 2 implementation, 2026-10-15. The Phase 1 design below has been updated to distinguish implemented behavior from Phase 3 plans.
**Problem:** Let a tenant-owned widget be embedded on an external website and safely capture leads from browsers the API does not control.

## Actors and boundaries

- **Owner:** authenticates, manages only their tenant's widgets, and later reads that tenant's submissions/aggregates. Phase 2 implements owner login and widget CRUD; dashboard reads remain Phase 3.
- **Customer site:** later loads a public widget bundle/config from the API. The install/render path is Phase 3.
- **Visitor:** submits untrusted fields from a different origin. The client never chooses the authoritative tenant or bypasses server validation.

## Phase 2 data model

- `tenants(id, name UNIQUE, created_at)`
- `users(id, tenant_id, email UNIQUE, password_hash, created_at)` — seeded demo accounts; no public sign-up or OAuth.
- `widgets(id, tenant_id, public_id UNIQUE, kind, title, description, fields JSONB, button_text, display_options JSONB, allowed_origins TEXT[], version, status, timestamps)`
- `submissions(id, tenant_id, widget_id, fields JSONB, idempotency_key, geo_country, geo_city, geo_provider, created_at)` — geo fields nullable; raw visitor IP is not persisted; `(widget_id, idempotency_key)` is unique (PostgreSQL permits multiple null keys).
- `notification_jobs(id, submission_id, idempotency_key UNIQUE, status, attempts, next_attempt_at, last_error, timestamps)` — due-job and submission indexes support the worker.

Migrations are versioned under `db/migrations/`. Indexes cover tenant/widget ownership and status, recent submissions per tenant/widget, recent widget submissions, and due notification jobs. Owner routes take `tenant_id` only from verified JWT claims and put it in every relevant SQL predicate. Public submission ownership is derived from the active widget row, never from request JSON.

## Implemented Phase 2 HTTP surface

- `POST /auth/login` — validates credentials for a seeded owner and issues a one-hour HS256 Bearer token. Passwords use salted Node `scrypt` hashes.
- `/api/widgets` — authenticated, tenant-scoped list/create/read/update/archive routes. Widget schemas validate type, fields, display options, and exact HTTP(S) origins.
- `OPTIONS /submissions?widget_id=…` — verifies the widget's origin allowlist, method, and requested headers; returns preflight CORS headers.
- `POST /submissions?widget_id=…` — resolves an active widget and allowed Origin; caps JSON size; validates only declared fields and types; rate-limits by client IP and widget; silently acknowledges a filled `website` honeypot without persistence; then performs geo lookup and stores the lead plus its notification job in one transaction.
- `GET /health` and `GET /ready` — liveness and PostgreSQL readiness.

CORS is an origin allowlist, not authentication or spam protection. A request without an `Origin` remains usable by non-browser clients; if an `Origin` is present, it must exactly match the widget's configured origins. Preflight permits `POST` and the `Content-Type` / `Idempotency-Key` headers used by the public route.

## Submission and failure flow

1. Resolve the active widget from the public ID and reject an unlisted browser origin.
2. Parse JSON under the configured request limit; reject malformed, oversized, invalid, unknown, missing, overlong, or wrong-type values with JSON 4xx responses.
3. Apply per-IP and aggregate per-widget fixed-window limits. Treat a non-empty reserved `website` field as bot traffic and return `202` without creating a lead.
4. If an `Idempotency-Key` already exists for this widget, return its original submission ID without another geo call or outbox job. PostgreSQL's unique constraint handles concurrent retries.
5. Call `ip-api.com`, then `ipapi.co` on error/empty result. Each attempt is bounded by a timeout. If both fail, keep all geo columns null and continue.
6. Insert the submission and one unique `submission:<id>:confirmation` notification job in the same PostgreSQL transaction. No raw IP is stored.
7. The background worker claims due work with `FOR UPDATE SKIP LOCKED`, runs a console notifier, retries with exponential backoff, reclaims stale `in_progress` claims, and reports terminal failure through an optional alert webhook or service log. A notification error cannot undo the stored lead.

Provider, notifier, alert, and clock inputs are injectable so failure modes can be tested without relying on the internet or email infrastructure. The default development notifier is console-only.

## Layers and phase boundary

```text
HTTP/CORS/auth: src/app.js
        ↓
Validation + domain adapters: src/validation.js, src/geo.js, src/notifications.js
        ↓
Repository queries/transaction workflow: src/repositories.js + src/db.js + db/migrations/*.sql
        ↓
PostgreSQL + repeatable seed: Compose, src/seed-data.js, src/seed.js
```

**Phase 3 plan, not implemented:** public widget configuration and versioned JavaScript, a plain HTML page on a second local origin that renders/submits the widget in a browser, authenticated submission/statistics/geo-breakdown reads, and the final evaluator manifest/submission evidence. Do not read the Phase 1 plan above as proof those endpoints exist.

**Non-goals:** no full form-builder UI, production account registration/OAuth, paid email/hosting/CDN, distributed rate-limit service, or stretch feature. Local in-process rate buckets reset on API restart. The app does not trust forwarded IP headers by default; a deployment proxy needs explicit configuration before client-IP-dependent controls can be relied on.
