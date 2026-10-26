// HTTP plumbing: cookies, signed sessions, flash messages and request bodies
// (urlencoded and multipart), with no dependencies.
import crypto from 'node:crypto';
import { SESSION_SECRET, SESSION_COOKIE, FLASH_COOKIE } from './config.mjs';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    let val = part.slice(i + 1).trim();
    try {
      val = decodeURIComponent(val);
    } catch {
      /* keep raw */
    }
    if (key) out[key] = val;
  }
  return out;
}

// Host-only cookie (no Domain attribute) so it works on any hostname.
export function cookie(name, value, { maxAge } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) s += `; Max-Age=${maxAge}`;
  return s;
}

const sign = (id) => crypto.createHmac('sha256', SESSION_SECRET).update(`user:${id}`).digest('base64url').slice(0, 32);

export const sessionCookie = (userId) => cookie(SESSION_COOKIE, `${userId}.${sign(userId)}`, { maxAge: 60 * 60 * 24 * 90 });
export const clearSessionCookie = () => cookie(SESSION_COOKIE, '', { maxAge: 0 });

export function verifySession(value) {
  const m = /^(\d+)\.([A-Za-z0-9_-]{32})$/.exec(value || '');
  if (!m) return null;
  const expected = Buffer.from(sign(m[1]));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return Number(m[1]);
}

export const flashCookie = (message, tone = 'success') => cookie(FLASH_COOKIE, JSON.stringify({ message, tone }));
export const clearFlashCookie = () => cookie(FLASH_COOKIE, '', { maxAge: 0 });

export function readFlash(cookies) {
  const v = cookies[FLASH_COOKIE];
  if (!v) return null;
  try {
    const f = JSON.parse(v);
    return f && typeof f.message === 'string' ? f : null;
  } catch {
    return null;
  }
}

export async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseBody(contentType = '', buf) {
  const type = contentType.toLowerCase();
  if (type.startsWith('multipart/form-data')) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    return m ? parseMultipart(buf, m[1] || m[2]) : { fields: {}, files: {} };
  }
  const fields = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) fields[k] = v;
  return { fields, files: {} };
}

function parseMultipart(buf, boundary) {
  const fields = {};
  const files = {};
  const delim = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing delimiter
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headers = buf.subarray(pos, headerEnd).toString('utf8');
    const next = buf.indexOf(delim, headerEnd + 4);
    if (next < 0) break;
    const data = buf.subarray(headerEnd + 4, Math.max(headerEnd + 4, next - 2));
    const disp = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] || '';
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disp)?.[1];
    const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disp)?.[1];
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream';
    if (name !== undefined) {
      if (filename !== undefined) {
        if (filename && data.length) files[name] = { filename: filename.replace(/^.*[\\/]/, ''), type: ctype, data: Buffer.from(data) };
      } else {
        fields[name] = data.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}
