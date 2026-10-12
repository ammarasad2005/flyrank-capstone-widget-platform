# Design — Embeddable Widget & Lead-Capture Platform

**Phase:** 1 design (v1 proposal)  
**Problem:** Let a tenant-owned widget be embedded on an external website and safely capture leads from browsers the API does not control.

## Actors and boundaries

- **Owner:** authenticates, manages only their tenant's widgets, and reads that tenant's submissions and aggregates.
- **Customer site:** loads a public widget bundle and a small public configuration from the API.
- **Visitor:** submits untrusted fields from a different origin. The client never chooses the authoritative tenant or bypasses server validation.

## Data model

- `tenants(id, name, created_at)`
- `users(id, tenant_id, email, password_hash, created_at)` — minimal seeded demo accounts; no public sign-up or OAuth.
- `widgets(id, tenant_id, public_id, kind, title, description, fields_json, button_text, display_json, allowed_origins, version, status, timestamps)`
- `submissions(id, tenant_id, widget_id, fields_json, geo_country, geo_city, created_at)` — geo columns nullable; do not persist raw visitor IP by default.
- `notification_jobs(id, submission_id, idempotency_key, status, attempts, next_attempt_at, last_error, timestamps)` — unique idempotency key and due-job index.

Use PostgreSQL via Docker Compose from the start. This is free, follows the brief's preferred database path, and supports versioned migrations, JSON fields, indexes, and tenant-scoped queries. Add indexes on tenant/widget ownership, `submissions(tenant_id, widget_id, created_at)`, and due notification jobs. Widget `public_id` and job `idempotency_key` are unique. The browser supplies a widget public ID; the database derives its tenant. Owner routes derive tenant scope from a signed JWT, never a request-body `tenant_id`. No managed cloud database or paid service is planned.

## HTTP surface

- `POST /auth/login` — return a short-lived signed bearer token for a seeded owner; password hashes use a standard password-hashing function.
- `/api/widgets` — authenticated owner CRUD; tenant scope is applied in every query.
- `GET /assets/widget.<version>.js` — public, versioned bundle with long-lived immutable cache headers.
- `GET /widgets/:public_id/config` — public, minimal configuration with short-lived cache headers and CORS for the widget's configured origins.
- `POST /submissions` — public, CORS + `OPTIONS`; body-size cap, boundary schema validation, per-IP/per-widget rate limits, then honeypot check. A filled honeypot is acknowledged without persisting a lead.
- `/api/submissions` and `/api/stats` — authenticated dashboard reads, always tenant-scoped.

## Submission and failure flow

Resolve the active widget; reject malformed/oversized input with JSON 4xx; apply abuse controls; try geo provider A (`ip-api.com`), then B (`ipapi.co`) on failure; if both fail, continue with null geo; transactionally store the submission and a notification outbox job; return 201 for the stored lead. A small DB-backed worker sends a console/Mailpit notification, retries with backoff, and emits a failure alert on terminal failure. Notification retries reuse the job's idempotency key; notifier failure cannot roll back or hide the lead.

## Layers and explicit non-goal

Keep HTTP/routes, validation and domain services, repositories/migrations, provider/notifier adapters, widget assets, and the worker separate. **Non-goal:** no full form-builder UI, no complete SaaS signup/OAuth system, no paid email/hosting/CDN, no analytics beyond the requested basic counts/geo breakdown, and no stretch features until all core probes pass. The HTML customer page and owner dashboard can stay minimal.

**Implementation constraint:** the development machine has Node/npm but no Docker or `psql`; the owner selected PostgreSQL via Docker Compose. Compose/runtime integration checks therefore need to run on the owner's Docker host or in CI. Do not silently switch the project to SQLite.
