import { withTransaction } from './db.js';
import { enqueueConfirmation } from './notifications.js';

const widgetColumns = `id, public_id, tenant_id, kind, title, description, fields,
                       button_text, display_options, allowed_origins, status, version,
                       created_at, updated_at`;

export async function findOwnerByEmail(pool, email) {
  const result = await pool.query(
    `SELECT id, tenant_id, email, password_hash
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function listWidgetsForTenant(pool, tenantId) {
  const result = await pool.query(
    `SELECT ${widgetColumns} FROM widgets
     WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC`,
    [tenantId],
  );
  return result.rows;
}

export async function findWidgetForTenant(pool, widgetId, tenantId) {
  const result = await pool.query(
    `SELECT ${widgetColumns} FROM widgets
     WHERE id = $1 AND tenant_id = $2
     LIMIT 1`,
    [widgetId, tenantId],
  );
  return result.rows[0] ?? null;
}

export async function findPublicWidget(pool, publicId) {
  const result = await pool.query(
    `SELECT ${widgetColumns} FROM widgets WHERE public_id = $1 LIMIT 1`,
    [publicId],
  );
  return result.rows[0] ?? null;
}

export async function createWidgetForTenant(pool, tenantId, widget, publicId) {
  const result = await pool.query(
    `INSERT INTO widgets(tenant_id, public_id, kind, title, description, fields,
                        button_text, display_options, allowed_origins)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::text[])
     RETURNING ${widgetColumns}`,
    [
      tenantId,
      publicId,
      widget.kind,
      widget.title,
      widget.description,
      JSON.stringify(widget.fields),
      widget.buttonText,
      JSON.stringify(widget.displayOptions),
      widget.allowedOrigins,
    ],
  );
  return result.rows[0];
}

export async function updateWidgetForTenant(pool, widgetId, tenantId, widget) {
  const result = await pool.query(
    `UPDATE widgets
     SET kind = $3, title = $4, description = $5, fields = $6::jsonb,
         button_text = $7, display_options = $8::jsonb, allowed_origins = $9::text[],
         version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING ${widgetColumns}`,
    [
      widgetId,
      tenantId,
      widget.kind,
      widget.title,
      widget.description,
      JSON.stringify(widget.fields),
      widget.buttonText,
      JSON.stringify(widget.displayOptions),
      widget.allowedOrigins,
    ],
  );
  return result.rows[0] ?? null;
}

export async function archiveWidgetForTenant(pool, widgetId, tenantId) {
  const result = await pool.query(
    `UPDATE widgets SET status = 'archived', version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status <> 'archived'
     RETURNING id`,
    [widgetId, tenantId],
  );
  return result.rowCount > 0;
}

export async function findSubmissionByIdempotencyKey(pool, widgetId, idempotencyKey) {
  const result = await pool.query(
    `SELECT id FROM submissions
     WHERE widget_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [widgetId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export async function createSubmissionWithNotification(pool, { widget, fields, idempotencyKey, geo }) {
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO submissions(tenant_id, widget_id, fields, idempotency_key,
                              geo_country, geo_city, geo_provider)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (widget_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        widget.tenant_id,
        widget.id,
        JSON.stringify(fields),
        idempotencyKey,
        geo?.country ?? null,
        geo?.city ?? null,
        geo?.provider ?? null,
      ],
    );
    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT id FROM submissions WHERE widget_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [widget.id, idempotencyKey],
      );
      if (!existing.rowCount) throw new Error('idempotent submission disappeared after conflict');
      return { id: Number(existing.rows[0].id), reused: true };
    }
    const submissionId = Number(inserted.rows[0].id);
    await enqueueConfirmation(client, submissionId);
    return { id: submissionId, reused: false };
  });
}

const submissionColumns = `s.id, s.widget_id, s.fields, s.geo_country, s.geo_city,
                            s.geo_provider, s.created_at`;

/**
 * Tenant-scoped submission list. Every filter is combined with the tenant predicate so a
 * caller can never widen the result set beyond the authenticated tenant.
 */
export async function listSubmissionsForTenant(pool, tenantId, { limit, offset, widgetId = null, since = null }) {
  const filters = ['s.tenant_id = $1'];
  const values = [tenantId];
  if (widgetId !== null) {
    values.push(widgetId);
    filters.push(`s.widget_id = $${values.length}`);
  }
  if (since !== null) {
    values.push(since);
    filters.push(`s.created_at >= $${values.length}`);
  }
  const where = filters.join(' AND ');

  const [rows, total] = await Promise.all([
    pool.query(
      `SELECT ${submissionColumns} FROM submissions s
       WHERE ${where}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    ),
    pool.query(`SELECT count(*)::int AS total FROM submissions s WHERE ${where}`, values),
  ]);
  return { rows: rows.rows, total: total.rows[0]?.total ?? 0 };
}

export async function findSubmissionForTenant(pool, submissionId, tenantId) {
  const result = await pool.query(
    `SELECT ${submissionColumns} FROM submissions s
     WHERE s.id = $1 AND s.tenant_id = $2
     LIMIT 1`,
    [submissionId, tenantId],
  );
  return result.rows[0] ?? null;
}

/**
 * Aggregates for one tenant over a trailing window. Each query repeats the tenant predicate;
 * the widget filter is optional and never replaces it.
 */
export async function statisticsForTenant(pool, tenantId, { days, widgetId = null }) {
  const windowStart = `now() - make_interval(days => $2::int)`;
  const widgetFilter = '$3::bigint IS NULL OR widget_id = $3';
  const scoped = `tenant_id = $1 AND created_at >= ${windowStart} AND (${widgetFilter})`;
  const scopedAliased = `s.tenant_id = $1 AND s.created_at >= ${windowStart} AND ($3::bigint IS NULL OR s.widget_id = $3)`;
  const params = [tenantId, days, widgetId];

  const [totals, timeline, perWidget, countries] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS submissions,
              count(DISTINCT geo_country)::int AS countries,
              count(*) FILTER (WHERE geo_country IS NULL)::int AS without_geo,
              max(created_at) AS last_submission_at
       FROM submissions WHERE ${scoped}`,
      params,
    ),
    pool.query(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS date, COALESCE(c.count, 0)::int AS count
       FROM generate_series(
              date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $2::int - 1),
              date_trunc('day', now() AT TIME ZONE 'UTC'),
              interval '1 day'
            ) AS d(day)
       LEFT JOIN (
         SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day, count(*) AS count
         FROM submissions s WHERE ${scopedAliased}
         GROUP BY 1
       ) c ON c.day = d.day
       ORDER BY d.day`,
      params,
    ),
    pool.query(
      `SELECT w.id, w.public_id, w.title, w.status,
              count(s.id)::int AS count,
              max(s.created_at) AS last_submission_at
       FROM widgets w
       LEFT JOIN submissions s
         ON s.widget_id = w.id AND s.tenant_id = w.tenant_id
        AND s.created_at >= ${windowStart}
       WHERE w.tenant_id = $1 AND ($3::bigint IS NULL OR w.id = $3)
       GROUP BY w.id, w.public_id, w.title, w.status, w.created_at
       ORDER BY w.created_at DESC, w.id DESC`,
      params,
    ),
    pool.query(
      `SELECT COALESCE(geo_country, 'unknown') AS country, count(*)::int AS count
       FROM submissions WHERE ${scoped}
       GROUP BY 1
       ORDER BY count DESC, country ASC
       LIMIT 25`,
      params,
    ),
  ]);

  return {
    windowDays: days,
    totals: totals.rows[0],
    timeline: timeline.rows,
    perWidget: perWidget.rows,
    countries: countries.rows,
  };
}
