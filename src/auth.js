import { SignJWT, jwtVerify } from 'jose';

const accessTokenTtlSeconds = 60 * 60;

function keyFrom(secret) {
  return new TextEncoder().encode(secret);
}

export async function issueAccessToken(user, secret) {
  return new SignJWT({ tenantId: Number(user.tenant_id), email: user.email })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(`${accessTokenTtlSeconds}s`)
    .sign(keyFrom(secret));
}

export async function verifyAccessToken(token, secret) {
  const { payload } = await jwtVerify(token, keyFrom(secret), { algorithms: ['HS256'] });
  const userId = Number(payload.sub);
  const tenantId = Number(payload.tenantId);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(tenantId)) {
    throw new Error('invalid token claims');
  }
  return { userId, tenantId, email: String(payload.email ?? '') };
}

export function requireAuth(secret) {
  return async (req, res, next) => {
    const match = req.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) return res.status(401).json({ error: 'bearer token required' });
    try {
      req.auth = await verifyAccessToken(match[1], secret);
      return next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired bearer token' });
    }
  };
}
