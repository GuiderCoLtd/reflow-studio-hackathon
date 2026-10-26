// Date helpers. Dates are 'YYYY-MM-DD' strings and timestamps are
// 'YYYY-MM-DD HH:MM' strings (Korea time, no zone math needed).
import { TODAY, NOW, NOW_TIME } from './config.mjs';

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// Korean public holidays (incl. substitute holidays) used for leave day counts.
export const HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-05', '2026-05-25',
  '2026-06-03', '2026-08-17', '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25',
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-05', '2027-05-13', '2027-08-16',
  '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11', '2027-12-27',
]);

export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export const isValidDate = (s) => parseDate(s) !== null;
export const ymd = (dt) => dt.toISOString().slice(0, 10);

export function addDays(s, n) {
  const dt = parseDate(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return ymd(dt);
}

export function diffDays(a, b) {
  // b - a in whole days
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export const weekday = (s) => WEEKDAYS[parseDate(s).getUTCDay()];
export const isWeekend = (s) => [0, 6].includes(parseDate(s).getUTCDay());
export const isWorkday = (s) => !isWeekend(s) && !HOLIDAYS.has(s);

export function workdaysBetween(a, b) {
  let n = 0;
  for (let d = a; d <= b; d = addDays(d, 1)) if (isWorkday(d)) n++;
  return n;
}

const parts = (s) => s.split('-').map(Number);

export function fmtMonthDay(s) {
  const [, m, d] = parts(s);
  return `${m}월 ${d}일`;
}
export const fmtMonthDayW = (s) => `${fmtMonthDay(s)} (${weekday(s)})`;
export const fmtLongDay = (s) => `${fmtMonthDay(s)} ${weekday(s)}요일`;
export function fmtFull(s) {
  const [y, m, d] = parts(s);
  return `${y}년 ${m}월 ${d}일`;
}
export const fmtFullW = (s) => `${fmtFull(s)} (${weekday(s)})`;
export const fmtDot = (s) => s.replaceAll('-', '.');
export function fmtShort(s) {
  const [, m, d] = parts(s);
  return `${m}/${d}`;
}
export function fmtRange(a, b) {
  if (!b || a === b) return fmtMonthDayW(a);
  return `${fmtMonthDayW(a)} – ${fmtMonthDayW(b)}`;
}
export function fmtRangeShort(a, b) {
  if (!b || a === b) return fmtShort(a);
  return `${fmtShort(a)}~${fmtShort(b)}`;
}

export function fmtStamp(ts) {
  // '2026-11-04 16:12' -> '2026.11.04 16:12'
  if (!ts) return '';
  const [d, t] = ts.split(' ');
  return t ? `${fmtDot(d)} ${t}` : fmtDot(d);
}

export function fmtStampShort(ts) {
  // '2026-11-04 16:12' -> '11월 4일 16:12'
  if (!ts) return '';
  const [d, t] = ts.split(' ');
  return t ? `${fmtMonthDay(d)} ${t}` : fmtMonthDay(d);
}

export const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}분`;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

export function fmtClock(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
}

// Relative time against the fixed "now".
export function relTime(ts) {
  if (!ts) return '';
  const [d, t = '00:00'] = ts.split(' ');
  const days = diffDays(d, TODAY);
  if (days < 0) return fmtMonthDay(d);
  if (days === 0) {
    const mins = minutesOf(NOW_TIME) - minutesOf(t);
    if (mins < 1) return '방금';
    if (mins < 60) return `${mins}분 전`;
    return `${Math.floor(mins / 60)}시간 전`;
  }
  if (days === 1) return `어제 ${t}`;
  if (days < 7) return `${days}일 전`;
  return fmtMonthDay(d);
}

export function monthOf(s) {
  return s.slice(0, 7);
}

export { TODAY, NOW, NOW_TIME };
