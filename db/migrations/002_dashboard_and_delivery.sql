-- Phase 3: dashboard read paths and versioned widget delivery.
--
-- The dashboard filters every read by tenant_id and window/country predicates, so the
-- covering index keeps the aggregates on one tenant's timeline instead of scanning the table.
CREATE INDEX submissions_tenant_created_idx ON submissions(tenant_id, created_at DESC);
CREATE INDEX submissions_tenant_geo_created_idx ON submissions(tenant_id, geo_country, created_at DESC);
-- Statistics grouped by widget for one tenant avoid touching other tenants' rows.
CREATE INDEX submissions_tenant_widget_country_idx ON submissions(tenant_id, widget_id, geo_country);
-- The outbox alert path lists terminal failures; this partial index keeps it tiny.
CREATE INDEX notification_jobs_dead_letter_idx ON notification_jobs(updated_at DESC)
  WHERE status = 'dead_letter';

-- The bundle major version a widget was published against is deliberately NOT frozen per widget:
-- the public config advertises the current version and the service returns 410 for an old
-- bundle, so an evaluator always loads the asset the config points at.
