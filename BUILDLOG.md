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
