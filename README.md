# Embeddable Widget & Lead-Capture Platform

A FlyRank backend capstone: tenants define small signup/CTA widgets, embed them with one script tag, and safely receive validated, spam-filtered, optionally geo-enriched leads.

> **Status:** Phase 1 design only. No runtime features have been implemented yet.

## Product flow

```text
Owner (authenticated) → widget CRUD → one-line embed snippet
                                      ↓
Customer HTML page (second origin) → cached widget bundle + public config
                                      ↓
Visitor → CORS/preflight → validation + rate/spam controls → geo A → geo B
                                      ↓                               ↓
                           persisted lead + dashboard API       no geo if both fail
                                      ↓
                           notification job (retryable; failure never loses the lead)
```

## Planned scope

- Tenant-isolated widget CRUD and authenticated dashboard API.
- Public versioned widget JavaScript, cached configuration, and a plain second-origin test page.
- Cross-origin lead capture, boundary validation, payload limits, rate limiting, and a honeypot.
- Geo-provider fallback and a notification job that retries and reports terminal failure.
- A small local run/seed/test flow; no hosting, paid service, real CDN, or full frontend is required.

## Phase 1 artifacts

- `DESIGN.md` — data model, API surface, layer sketch, failure behavior, and non-goals.
- `BUILDLOG.md` — implementation notes: what each session built, what broke, and what changed.
- `.env.example` — safe local placeholders; copy to `.env` (git-ignored) when runtime configuration is implemented.

Exact install/run/seed commands, `capstone.yaml`, API documentation, and requirement-by-requirement `EVIDENCE.md` will be completed alongside the implementation, before submission. The final README must be verified from a clean clone.

## Constraints

The target is a free, local capstone: Node.js/Express with PostgreSQL via Docker Compose (the owner selected this path). Docker is not installed on the development machine yet, so database integration runs will go through a Docker host or CI. Geo APIs are the free providers listed in the brief; deterministic mocks will be used for fallback evidence. Email can be console/Mailpit. No paid accounts or credit card.
