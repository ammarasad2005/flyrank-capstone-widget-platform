/*
 * Live geo-provider check (visibility only — the deterministic proofs stay in npm test).
 *
 *   npm run geo:check                      # uses GEO_CHECK_IP, default 8.8.8.8
 *   npm run geo:check -- 1.1.1.1           # or pass any public IP
 *
 * Shows provider A's answer, provider B's answer, and what the enrichment chain would
 * actually store. Useful when a reviewer wants to see the real free providers respond;
 * private/container addresses legitimately resolve to null and are documented as such.
 */
import { createGeoProviders, enrichGeo } from '../src/geo.js';
import { config } from '../src/config.js';

const ip = process.argv[2] ?? process.env.GEO_CHECK_IP ?? '8.8.8.8';

const isPublic = (value) => {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  return true;
};

console.log(`Geo provider check for ${ip} (timeout ${config.geoTimeoutMs}ms per provider)`);
if (!isPublic(ip)) {
  console.log('NOTE  This is a private/loopback address; public providers will decline it. Pass a public IP to see enrichment.');
}

const providers = createGeoProviders({ timeoutMs: config.geoTimeoutMs });

for (const name of ['providerA', 'providerB']) {
  const label = name === 'providerA' ? 'ip-api.com' : 'ipapi.co';
  try {
    const result = await providers[name](ip);
    console.log(`${name} (${label}) → ${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`${name} (${label}) → failed: ${error.message}`);
  }
}

const chain = await enrichGeo(ip, providers);
console.log(`enrichment chain result (what would be stored) → ${JSON.stringify(chain)}`);
console.log(chain
  ? 'PASS  the fallback chain returned enrichment'
  : 'DEGRADED  no provider answered; a lead would still be stored with null geo (documented behaviour)');
