import { hashPassword } from './passwords.js';
import { allowedOriginsSchema } from './validation.js';

export const DEMO_USERS = Object.freeze({
  tenantA: { email: 'owner-a@example.test', password: 'demo-owner-a-password' },
  tenantB: { email: 'owner-b@example.test', password: 'demo-owner-b-password' },
});

export const DEMO_WIDGET_PUBLIC_ID = 'demo-contact-widget-a';

const demoFields = [
  { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 100 },
  { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 254 },
  { name: 'message', label: 'Message', type: 'textarea', required: false, maxLength: 1000 },
];

function demoAllowedOrigins() {
  const extras = (process.env.DEMO_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const origins = [...new Set(['http://localhost:5500', 'http://127.0.0.1:5500', ...extras])];
  const parsed = allowedOriginsSchema.safeParse(origins);
  if (!parsed.success) throw new Error('DEMO_ALLOWED_ORIGINS must be a comma-separated list of exact HTTP(S) origins.');
  return parsed.data;
}

export async function seedDemoData(pool) {
  const tenantA = await pool.query(
    `INSERT INTO tenants(name) VALUES ('Demo Company A')
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const tenantB = await pool.query(
    `INSERT INTO tenants(name) VALUES ('Demo Company B')
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const tenantAId = Number(tenantA.rows[0].id);
  const tenantBId = Number(tenantB.rows[0].id);

  for (const [tenantId, credentials] of [
    [tenantAId, DEMO_USERS.tenantA],
    [tenantBId, DEMO_USERS.tenantB],
  ]) {
    const passwordHash = await hashPassword(credentials.password);
    await pool.query(
      `INSERT INTO users(tenant_id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id, password_hash = EXCLUDED.password_hash`,
      [tenantId, credentials.email, passwordHash],
    );
  }

  await pool.query(
    `INSERT INTO widgets(tenant_id, public_id, kind, title, description, fields, button_text,
                         display_options, allowed_origins, status)
     VALUES ($1, $2, 'contact', 'Talk to our team', 'A demo lead-capture widget.', $3::jsonb,
             'Send message', $4::jsonb, $5::text[], 'active')
     ON CONFLICT (public_id) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           kind = EXCLUDED.kind,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           fields = EXCLUDED.fields,
           button_text = EXCLUDED.button_text,
           display_options = EXCLUDED.display_options,
           allowed_origins = EXCLUDED.allowed_origins,
           status = 'active',
           version = widgets.version + 1,
           updated_at = now()`,
    [
      tenantAId,
      DEMO_WIDGET_PUBLIC_ID,
      JSON.stringify(demoFields),
      JSON.stringify({ theme: 'light', position: 'inline' }),
      demoAllowedOrigins(),
    ],
  );

  const widget = await pool.query('SELECT id, public_id FROM widgets WHERE public_id = $1', [DEMO_WIDGET_PUBLIC_ID]);
  return { tenantAId, tenantBId, widgetId: Number(widget.rows[0].id), publicId: widget.rows[0].public_id };
}
