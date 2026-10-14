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
