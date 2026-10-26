// Password hashing (scrypt). Kept apart from data.mjs so the seed script can
// use it without opening the live database.
import crypto from 'node:crypto';

export function hashPassword(password, salt) {
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const given = crypto.scryptSync(String(password || ''), salt, expected.length);
  return crypto.timingSafeEqual(expected, given);
}
