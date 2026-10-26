// Runtime configuration. "Today" and "now" are fixed so every screen renders
// the same way on any day, which keeps screenshots and replays deterministic.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DB_PATH = path.join(APP_DIR, 'data', 'dodam.db');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');

export const HOST = process.env.DODAM_HOST || '127.0.0.1';
export const PORT = Number(process.env.DODAM_PORT || 3500);

const envToday = process.env.DODAM_TODAY || '';
export const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(envToday) ? envToday : '2026-11-05';
// Wall-clock time used for "now" (new records, relative times, hours worked today).
export const NOW_TIME = '10:24';
export const NOW = `${TODAY} ${NOW_TIME}`;

// Fixed secret: sessions are stateless signed cookies, so restoring a database
// snapshot (or restarting the server) never logs anyone out.
export const SESSION_SECRET = 'dodam-work::demo-session-secret::2026';
export const SESSION_COOKIE = 'dodam_session';
export const FLASH_COOKIE = 'dodam_flash';

export const PRODUCT = '도담워크';
