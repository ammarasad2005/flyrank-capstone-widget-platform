import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { seedDemoData, DEMO_USERS } from './seed-data.js';

const pool = createPool();
try {
  await runMigrations(pool);
  const seeded = await seedDemoData(pool);
  console.log(JSON.stringify({
    event: 'demo_seed_complete',
    widgetPublicId: seeded.publicId,
    tenantAOwner: DEMO_USERS.tenantA.email,
    tenantADevelopmentPassword: DEMO_USERS.tenantA.password,
    tenantBOwner: DEMO_USERS.tenantB.email,
    tenantBDevelopmentPassword: DEMO_USERS.tenantB.password,
    warning: 'Development-only fixture credentials. Never reuse them outside the local demo.',
  }, null, 2));
} finally {
  await pool.end();
}
