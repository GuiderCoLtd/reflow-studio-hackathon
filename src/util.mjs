// Shared helpers: paths, JSON IO, logging, small string utilities.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS_DIR = path.join(ROOT, 'runs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
  return file;
}

export function slugify(text, max = 48) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'item';
}

export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// Replace volatile path segments (numeric ids, uuids, hashes) so pages of the
// same template collapse to one key, e.g. /projects/12/tasks/3 -> /projects/:id/tasks/:id
export function urlTemplate(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/').map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      if (/^[0-9a-f]{12,}$/i.test(seg)) return ':hash';
      return seg;
    });
    const keys = [...u.searchParams.keys()].sort();
    return `${u.origin}${segs.join('/')}${keys.length ? `?${keys.map((k) => `${k}=`).join('&')}` : ''}${u.hash && u.hash.length > 1 ? '#' + u.hash.slice(1).replace(/\d+/g, ':id') : ''}`;
  } catch {
    return rawUrl;
  }
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

let logFile = null;
export function setLogFile(file) {
  ensureDir(path.dirname(file));
  logFile = file;
}

export function log(scope, ...parts) {
  const line = `[${new Date().toISOString().slice(11, 19)}] [${scope}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, line + '\n');
}
