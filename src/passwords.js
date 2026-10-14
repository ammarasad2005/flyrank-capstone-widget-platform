import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  const [scheme, saltText, keyText] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;
  try {
    const expected = Buffer.from(keyText, 'base64url');
    const actual = Buffer.from(await derive(password, Buffer.from(saltText, 'base64url')));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
