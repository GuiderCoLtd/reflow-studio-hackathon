// Router, request context and static files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOST, PORT, PUBLIC_DIR, TODAY } from './config.mjs';
import { parseCookies, verifySession, readFlash, clearFlashCookie, flashCookie, readBody, parseBody } from './http.mjs';
import { getUser } from './data.mjs';
import { LABEL_VARIANT } from '../labels.mjs';
import * as auth from '../pages/auth.mjs';
import { homePage } from '../pages/home.mjs';
import { attendancePage, attendancePost } from '../pages/attendance.mjs';
import { leaveList, leaveNew, leaveCreate, leaveDetail, leaveDetailPost } from '../pages/leave.mjs';
import { approvalsList, approvalDetail, approvalPost } from '../pages/approvals.mjs';
import { expenseList, expenseNew, expenseCreate, expenseDetail, expenseReceipt } from '../pages/expenses.mjs';
import { membersPage, membersPost, memberDetail, memberResendInvite } from '../pages/members.mjs';
import { noticeList, noticeNew, noticeCreate, noticeDetail } from '../pages/notices.mjs';
import { settingsPage, settingsPost } from '../pages/settings.mjs';
import { searchPage, notFoundPage } from '../pages/misc.mjs';

const routes = [];
function route(method, pattern, handler, { open = false } = {}) {
  const re = new RegExp(`^${pattern.replace(/:id/g, '(\\d+)').replace(/:section/g, '([a-z-]+)').replace(/:file/g, '[^/]+')}/?$`);
  routes.push({ method, re, handler, open });
}

route('GET', '/login', auth.loginGet, { open: true });
route('POST', '/login', auth.loginPost, { open: true });
route('GET', '/logout', auth.logout, { open: true });
route('GET', '/', homePage);
route('GET', '/attendance', attendancePage);
route('POST', '/attendance', attendancePost);
route('GET', '/leave', leaveList);
route('GET', '/leave/new', leaveNew);
route('POST', '/leave/new', leaveCreate);
route('GET', '/leave/:id', leaveDetail);
route('POST', '/leave/:id', leaveDetailPost);
route('GET', '/approvals', (ctx) => approvalsList(ctx, 'received'));
route('GET', '/approvals/sent', (ctx) => approvalsList(ctx, 'sent'));
route('GET', '/approvals/done', (ctx) => approvalsList(ctx, 'done'));
route('GET', '/approvals/:id', approvalDetail);
route('POST', '/approvals/:id', approvalPost);
route('GET', '/expenses', expenseList);
route('GET', '/expenses/new', expenseNew);
route('POST', '/expenses/new', expenseCreate);
route('GET', '/expenses/:id', expenseDetail);
route('GET', '/expenses/:id/receipt', expenseReceipt);
route('GET', '/expenses/:id/receipt/:file', expenseReceipt); // file name in the URL (download name, crawler-friendly)
route('GET', '/members', membersPage);
route('POST', '/members', membersPost);
route('GET', '/members/:id', memberDetail);
route('POST', '/members/:id/resend-invite', memberResendInvite); // fetch from the members table, answers JSON
route('GET', '/notices', noticeList);
route('GET', '/notices/new', noticeNew);
route('POST', '/notices/new', noticeCreate);
route('GET', '/notices/:id', noticeDetail);
route('GET', '/settings', (ctx) => ctx.redirect('/settings/profile', { status: 302 }));
route('GET', '/settings/:section', settingsPage);
route('POST', '/settings/:section', settingsPost);
route('GET', '/search', searchPage);

const STATIC = {
  '/static/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.svg', 'image/svg+xml'],
};

// Photographs converted by tools/photos.py: /static/img/<name>-<size>.jpg
const IMAGE = /^\/static\/img\/([a-z0-9-]+\.jpg)$/;

function serveStatic(req, res, file, type) {
  const buf = fs.readFileSync(path.join(PUBLIC_DIR, file));
  const etag = `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, ETag: etag, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function makeContext(req, res, url) {
  const cookies = parseCookies(req.headers.cookie);
  const ctx = {
    req,
    res,
    url,
    query: url.searchParams,
    cookies,
    body: {},
    files: {},
    user: null,
    setCookies: [],
    status: 0,
    flashTaken: false,
    // Read the one-time flash message (and clear its cookie) when a page renders it.
    takeFlash() {
      if (ctx.flashTaken) return null;
      ctx.flashTaken = true;
      const f = readFlash(cookies);
      if (f) ctx.setCookies.push(clearFlashCookie());
      return f;
    },
    send(status, body, headers = {}) {
      ctx.status = status;
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(ctx.setCookies.length ? { 'Set-Cookie': ctx.setCookies } : {}),
        ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : String(body));
    },
    json(status, value) {
      ctx.status = status;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    },
    // Post/Redirect/Get: the flash is shown as a banner on the next page.
    redirect(location, { flash, tone = 'success', cookies: extra = [], status = 303 } = {}) {
      ctx.status = status;
      const list = [...ctx.setCookies, ...extra];
      if (flash) list.push(flashCookie(flash, tone));
      res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', ...(list.length ? { 'Set-Cookie': list } : {}) });
      res.end();
    },
    notFound() {
      if (!ctx.user) return ctx.send(404, 'Not found');
      return notFoundPage(ctx);
    },
  };
  return ctx;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (STATIC[pathname]) return serveStatic(req, res, ...STATIC[pathname]);
  const img = IMAGE.exec(pathname);
  if (img && fs.existsSync(path.join(PUBLIC_DIR, 'img', img[1]))) return serveStatic(req, res, path.join('img', img[1]), 'image/jpeg');

  const ctx = makeContext(req, res, url);
  const userId = verifySession(ctx.cookies.dodam_session);
  ctx.user = userId ? getUser(userId) : null;
  if (ctx.user?.invited) ctx.user = null;

  const method = req.method === 'HEAD' ? 'GET' : req.method;
  let matched = null;
  let params = [];
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    matched = r;
    params = m.slice(1).map((v) => (/^\d+$/.test(v) ? Number(v) : v));
    break;
  }

  if (!matched?.open && !ctx.user) return ctx.redirect('/login', { status: 302 });
  if (!matched) {
    if (pathMatched) {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method Not Allowed');
    }
    return ctx.notFound();
  }
  if (method === 'POST') {
    const parsed = parseBody(req.headers['content-type'] || '', await readBody(req));
    ctx.body = parsed.fields;
    ctx.files = parsed.files;
  }
  await matched.handler(ctx, ...params);
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      await handle(req, res);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}\n${err.stack || err}`);
      if (!res.headersSent) {
        res.writeHead(err.status || 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err.status === 413 ? '파일이 너무 커요.' : '일시적인 오류가 발생했어요.');
      } else res.end();
    } finally {
      if (!req.url.startsWith('/static/')) console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`dodam listening on http://${HOST}:${PORT} (labels=${LABEL_VARIANT}, today=${TODAY}, pid=${process.pid})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
