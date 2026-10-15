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
