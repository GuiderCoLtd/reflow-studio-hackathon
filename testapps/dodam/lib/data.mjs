// Data access: every query and mutation the pages need, in one place.
import { openDb, tx } from './db.mjs';
import { verifyPassword } from './passwords.mjs';
import { TODAY, NOW } from './config.mjs';
import { workdaysBetween, fmtDot, weekday, fmtShort } from './dates.mjs';

export const db = openDb();

export const LEAVE_TYPES = [
  { value: 'annual', label: '연차' },
  { value: 'am_half', label: '오전 반차' },
  { value: 'pm_half', label: '오후 반차' },
  { value: 'sick', label: '병가' },
  { value: 'family', label: '경조사' },
];
export const leaveTypeLabel = (v) => LEAVE_TYPES.find((t) => t.value === v)?.label || v;
export const isHalf = (t) => t === 'am_half' || t === 'pm_half';
export const usesBalance = (t) => t === 'annual' || isHalf(t);

export const EXPENSE_CATEGORIES = [
  { value: 'meal', label: '식대' },
  { value: 'transport', label: '교통비' },
  { value: 'supplies', label: '소모품' },
  { value: 'entertainment', label: '접대비' },
  { value: 'etc', label: '기타' },
];
export const categoryLabel = (v) => EXPENSE_CATEGORIES.find((c) => c.value === v)?.label || v;

export const DOC_KINDS = { leave: '휴가 신청서', expense: '경비 청구서', purchase: '구매 품의서', trip: '출장 신청서' };
export const TITLE_RANK = { 대표: 0, 이사: 1, 팀장: 2, 책임: 3, 선임: 4, 매니저: 5 };

export const fmtWon = (n) => Number(n || 0).toLocaleString('ko-KR');
export const fmtDays = (n) => `${Number.isInteger(n) ? n : Number(n).toFixed(1).replace(/\.0$/, '')}일`;
export const dateW = (s) => `${fmtDot(s)} (${weekday(s)})`;
export const periodText = (a, b) => (a === b ? dateW(a) : `${dateW(a)} – ${dateW(b)}`);

// Korean particle picker: josa('이사', '이', '가') -> '이사가'.
export function josa(word, withFinal, withoutFinal) {
  const ch = String(word).trim().slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 ? code % 28 !== 0 : /[0-9]$/.test(ch) ? !/[2459]$/.test(ch) : false;
  return `${word}${hasFinal ? withFinal : withoutFinal}`;
}

// ---------- users ----------

const USER_COLS = `u.id, u.name, u.email, u.title, u.role, u.invited, u.phone, u.employee_no, u.joined_on,
  u.leave_total, u.created_at, u.invite_resent_at, u.dept_id, d.name AS dept, d.sort AS dept_sort`;
const USER_FROM = 'FROM users u JOIN departments d ON d.id = u.dept_id';

export function getUser(id) {
  return db.prepare(`SELECT ${USER_COLS} ${USER_FROM} WHERE u.id = ?`).get(id) || null;
}

export function authenticate(email, password) {
  const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ? AND invited = 0').get(String(email || '').trim());
  if (!row?.password_hash) return null;
  return verifyPassword(password, row.password_hash) ? getUser(row.id) : null;
}

export function departments() {
  return db.prepare('SELECT id, name FROM departments ORDER BY sort').all();
}

export function companyStats() {
  return db.prepare('SELECT COUNT(*) AS total, SUM(invited) AS invited FROM users').get();
}

function onLeaveToday() {
  const rows = db.prepare(`SELECT user_id FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?`).all(TODAY, TODAY);
  return new Set(rows.map((r) => r.user_id));
}

export function memberStatus(user, away = onLeaveToday()) {
  if (user.invited) return 'invited';
  return away.has(user.id) ? 'away' : 'active';
}

export function listMembers({ q = '', dept = '', page = 1, perPage = 10 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(u.name LIKE ? OR u.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (dept) {
    where.push('u.dept_id = ?');
    params.push(Number(dept));
  }
  const rows = db.prepare(`SELECT ${USER_COLS} ${USER_FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).all(...params);
  const away = onLeaveToday();
  rows.forEach((r) => (r.status = memberStatus(r, away)));
  // Pending invitations first (newest first), then everyone else by name.
  rows.sort((a, b) => b.invited - a.invited || (a.invited ? b.created_at.localeCompare(a.created_at) || b.id - a.id : a.name.localeCompare(b.name, 'ko')));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * perPage, p * perPage), total, page: p, pages, perPage };
}

export function teamMembers(user) {
  const rows = db.prepare(`SELECT ${USER_COLS} ${USER_FROM} WHERE u.dept_id = ? AND u.id != ?`).all(user.dept_id, user.id);
  const away = onLeaveToday();
  rows.forEach((r) => (r.status = memberStatus(r, away)));
  return rows.sort((a, b) => a.invited - b.invited || (TITLE_RANK[a.title] ?? 9) - (TITLE_RANK[b.title] ?? 9) || a.name.localeCompare(b.name, 'ko'));
}

export function inviteMember({ name, email, deptId, role }) {
  const r = db
    .prepare(`INSERT INTO users (name, email, password_hash, dept_id, title, role, invited, created_at) VALUES (?, ?, NULL, ?, NULL, ?, 1, ?)`)
    .run(name, email, deptId, role, NOW);
  return Number(r.lastInsertRowid);
}

// Send a pending invitation again. Returns false when the member is not invited.
export function resendInvite(id) {
  return db.prepare('UPDATE users SET invite_resent_at = ? WHERE id = ? AND invited = 1').run(NOW, id).changes > 0;
}

export function emailTaken(email, exceptId = 0) {
  return !!db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, exceptId);
}

export function updateProfile(userId, { name, phone, email }) {
  db.prepare('UPDATE users SET name = ?, phone = ?, email = ? WHERE id = ?').run(name, phone, email, userId);
}

export function approverFor(user) {
  const director = db.prepare(`SELECT id FROM users WHERE title = '이사' AND invited = 0 ORDER BY id LIMIT 1`).get();
  if (user.title === '팀장' || user.title === '이사') return getUser(director.id);
  const lead = db.prepare(`SELECT id FROM users WHERE dept_id = ? AND title = '팀장' AND invited = 0 ORDER BY id LIMIT 1`).get(user.dept_id);
  return getUser(lead?.id ?? director.id);
}

// ---------- leave ----------

export function leaveBalance(user) {
  const year = TODAY.slice(0, 4);
  const rows = db
    .prepare(`SELECT type, days, status FROM leave_requests WHERE user_id = ? AND substr(start_date, 1, 4) = ? AND status IN ('approved', 'pending')`)
    .all(user.id, year);
  let used = 0;
  let pending = 0;
  for (const r of rows) {
    if (!usesBalance(r.type)) continue;
    if (r.status === 'approved') used += r.days;
    else pending += r.days;
  }
  const total = user.leave_total;
  return { total, used, pending, remaining: total - used, available: total - used - pending };
}

const LEAVE_SELECT = `SELECT l.*, a.name AS approver_name, a.title AS approver_title, ad.name AS approver_dept
  FROM leave_requests l LEFT JOIN users a ON a.id = l.approver_id LEFT JOIN departments ad ON ad.id = a.dept_id`;

export function myLeaves(userId) {
  return db.prepare(`${LEAVE_SELECT} WHERE l.user_id = ? ORDER BY l.created_at DESC, l.id DESC`).all(userId);
}

export function getLeave(id) {
  const leave = db.prepare(`${LEAVE_SELECT} WHERE l.id = ?`).get(id);
  if (!leave) return null;
  leave.doc = db.prepare(`SELECT id, doc_no, status FROM approval_docs WHERE ref_type = 'leave' AND ref_id = ?`).get(id) || null;
  return leave;
}

export function upcomingLeaves(userId) {
  return db
    .prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND status IN ('approved', 'pending') AND end_date >= ? ORDER BY start_date LIMIT 4`)
    .all(userId, TODAY);
}

export function leaveOverlaps(userId, start, end) {
  return !!db
    .prepare(`SELECT 1 FROM leave_requests WHERE user_id = ? AND status IN ('approved', 'pending') AND start_date <= ? AND end_date >= ?`)
    .get(userId, end, start);
}

export function leaveDays(type, start, end) {
  return isHalf(type) ? 0.5 : workdaysBetween(start, end);
}

export function leaveDocTitle(type, start, end) {
  const range = start === end ? fmtShort(start) : `${fmtShort(start)}~${fmtShort(end)}`;
  const name = { annual: '연차 휴가 신청', am_half: '오전 반차 신청', pm_half: '오후 반차 신청', sick: '병가 신청', family: '경조사 휴가 신청' }[type];
  return `${name} (${range})`;
}

export function createLeave(user, { type, start, end, days, reason }) {
  return tx(db, () => {
    const approver = approverFor(user);
    const r = db
      .prepare(`INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, status, approver_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(user.id, type, start, end, days, reason, approver.id, NOW);
    const leaveId = Number(r.lastInsertRowid);
    createDoc({
      kind: 'leave',
      title: leaveDocTitle(type, start, end),
      drafter: user,
      approvers: [{ user: approver, role: '승인' }],
      body: { fields: [['휴가 종류', leaveTypeLabel(type)], ['기간', periodText(start, end)], ['일수', fmtDays(days)], ['사유', reason]] },
      ref: ['leave', leaveId],
    });
    return leaveId;
  });
}

export function cancelLeave(leave) {
  tx(db, () => {
    db.prepare(`UPDATE leave_requests SET status = 'cancelled', decided_at = ? WHERE id = ?`).run(NOW, leave.id);
    if (leave.doc) {
      db.prepare(`UPDATE approval_docs SET status = 'withdrawn', closed_at = ? WHERE id = ?`).run(NOW, leave.doc.id);
      db.prepare(`UPDATE approval_steps SET status = 'withdrawn' WHERE doc_id = ? AND status IN ('pending', 'waiting')`).run(leave.doc.id);
    }
  });
}

// ---------- approvals ----------

const DOC_SELECT = `SELECT d.*, u.name AS drafter_name, u.title AS drafter_title, dp.name AS drafter_dept
  FROM approval_docs d JOIN users u ON u.id = d.drafter_id JOIN departments dp ON dp.id = u.dept_id`;

function nextDocNo(deptName, year) {
  const rows = db.prepare('SELECT doc_no FROM approval_docs WHERE doc_no LIKE ?').all(`${deptName}-${year}-%`);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.doc_no.split('-').pop()) || 0), 0);
  return `${deptName}-${year}-${String(max + 1).padStart(3, '0')}`;
}

export function createDoc({ kind, title, drafter, approvers, body, ref }) {
  const docNo = nextDocNo(drafter.dept, NOW.slice(0, 4));
  const r = db
    .prepare(`INSERT INTO approval_docs (doc_no, kind, title, drafter_id, status, body, ref_type, ref_id, drafted_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(docNo, kind, title, drafter.id, JSON.stringify(body), ref?.[0] ?? null, ref?.[1] ?? null, NOW);
  const docId = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT INTO approval_steps (doc_id, seq, user_id, role, status, acted_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(docId, 0, drafter.id, '기안', 'drafted', NOW);
  approvers.forEach((a, i) => ins.run(docId, i + 1, a.user.id, a.role, i === 0 ? 'pending' : 'waiting', null));
  return docId;
}

export function approvalsReceived(userId) {
  return db
    .prepare(
      `${DOC_SELECT} WHERE d.status = 'pending' AND EXISTS (SELECT 1 FROM approval_steps s WHERE s.doc_id = d.id AND s.user_id = ? AND s.status = 'pending')
       ORDER BY d.drafted_at DESC, d.id DESC`,
    )
    .all(userId);
}

export function pendingCount(userId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM approval_docs d WHERE d.status = 'pending'
       AND EXISTS (SELECT 1 FROM approval_steps s WHERE s.doc_id = d.id AND s.user_id = ? AND s.status = 'pending')`,
    )
    .get(userId).n;
}

export function approvalsSent(userId) {
  return db.prepare(`${DOC_SELECT} WHERE d.drafter_id = ? ORDER BY d.drafted_at DESC, d.id DESC`).all(userId);
}

export function approvalsDone(userId) {
  return db
    .prepare(
      `SELECT d.*, u.name AS drafter_name, u.title AS drafter_title, dp.name AS drafter_dept, s.status AS my_action, s.acted_at AS my_acted_at
       FROM approval_steps s JOIN approval_docs d ON d.id = s.doc_id JOIN users u ON u.id = d.drafter_id JOIN departments dp ON dp.id = u.dept_id
       WHERE s.user_id = ? AND s.seq > 0 AND s.status IN ('approved', 'rejected')
       ORDER BY s.acted_at DESC, d.id DESC`,
    )
    .all(userId);
}

export function getDoc(id) {
  const doc = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
  if (!doc) return null;
  doc.body = JSON.parse(doc.body);
  doc.steps = db
    .prepare(
      `SELECT s.*, u.name, u.title, dp.name AS dept FROM approval_steps s JOIN users u ON u.id = s.user_id JOIN departments dp ON dp.id = u.dept_id
       WHERE s.doc_id = ? ORDER BY s.seq`,
    )
    .all(id);
  return doc;
}

export function canView(doc, user) {
  return user.role === 'admin' || doc.drafter_id === user.id || doc.steps.some((s) => s.user_id === user.id);
}

export const currentStep = (doc) => doc.steps.find((s) => s.status === 'pending') || null;

// Who a pending document is waiting on right now.
export function currentApprover(docId) {
  return (
    db
      .prepare(
        `SELECT s.user_id, u.name, u.title, dp.name AS dept FROM approval_steps s JOIN users u ON u.id = s.user_id JOIN departments dp ON dp.id = u.dept_id
         WHERE s.doc_id = ? AND s.status = 'pending' ORDER BY s.seq LIMIT 1`,
      )
      .get(docId) || null
  );
}

// Final approver of a document (last step of its approval line).
export function lastApprover(docId) {
  return db
    .prepare(
      `SELECT s.user_id, u.name, u.title, dp.name AS dept FROM approval_steps s JOIN users u ON u.id = s.user_id JOIN departments dp ON dp.id = u.dept_id
       WHERE s.doc_id = ? ORDER BY s.seq DESC LIMIT 1`,
    )
    .get(docId);
}

function applyRef(doc, status, note) {
  if (doc.ref_type === 'leave') {
    db.prepare('UPDATE leave_requests SET status = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(status, NOW, note, doc.ref_id);
  } else if (doc.ref_type === 'expense') {
    db.prepare('UPDATE expenses SET status = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(status, NOW, note, doc.ref_id);
  }
}

function notify(userId, kind, text, link) {
  db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at, read) VALUES (?, ?, ?, ?, ?, 0)').run(userId, kind, text, link, NOW);
}

export function approveDoc(doc, user) {
  tx(db, () => {
    const step = doc.steps.find((s) => s.user_id === user.id && s.status === 'pending');
    if (!step) throw Object.assign(new Error('not your turn'), { status: 409 });
    db.prepare(`UPDATE approval_steps SET status = 'approved', acted_at = ? WHERE id = ?`).run(NOW, step.id);
    const next = doc.steps.find((s) => s.seq === step.seq + 1);
    if (next) {
      db.prepare(`UPDATE approval_steps SET status = 'pending' WHERE id = ?`).run(next.id);
    } else {
      db.prepare(`UPDATE approval_docs SET status = 'approved', closed_at = ? WHERE id = ?`).run(NOW, doc.id);
      applyRef(doc, 'approved', null);
      notify(doc.drafter_id, 'result', `${user.name}님이 '${doc.title}' 문서를 승인했어요.`, `/approvals/${doc.id}`);
    }
  });
}

export function rejectDoc(doc, user, reason) {
  tx(db, () => {
    const step = doc.steps.find((s) => s.user_id === user.id && s.status === 'pending');
    if (!step) throw Object.assign(new Error('not your turn'), { status: 409 });
    db.prepare(`UPDATE approval_steps SET status = 'rejected', acted_at = ?, comment = ? WHERE id = ?`).run(NOW, reason, step.id);
    db.prepare(`UPDATE approval_steps SET status = 'skipped' WHERE doc_id = ? AND seq > ?`).run(doc.id, step.seq);
    db.prepare(`UPDATE approval_docs SET status = 'rejected', closed_at = ? WHERE id = ?`).run(NOW, doc.id);
    applyRef(doc, 'rejected', reason);
    notify(doc.drafter_id, 'result', `${user.name}님이 '${doc.title}' 문서를 반려했어요.`, `/approvals/${doc.id}`);
  });
}

// ---------- expenses ----------

const EXP_COLS = `e.id, e.user_id, e.used_on, e.category, e.amount, e.merchant, e.memo, e.receipt_name, e.receipt_type,
  length(e.receipt) AS receipt_size, e.status, e.approver_id, e.created_at, e.decided_at, e.decision_note`;

export function myExpenses(userId) {
  return db.prepare(`SELECT ${EXP_COLS} FROM expenses e WHERE e.user_id = ? ORDER BY e.created_at DESC, e.id DESC`).all(userId);
}

export function getExpense(id) {
  const e = db
    .prepare(
      `SELECT ${EXP_COLS}, a.name AS approver_name, a.title AS approver_title, ad.name AS approver_dept
       FROM expenses e LEFT JOIN users a ON a.id = e.approver_id LEFT JOIN departments ad ON ad.id = a.dept_id WHERE e.id = ?`,
    )
    .get(id);
  if (!e) return null;
  e.doc = db.prepare(`SELECT id, doc_no, status FROM approval_docs WHERE ref_type = 'expense' AND ref_id = ?`).get(id) || null;
  return e;
}

export function expenseReceipt(id) {
  return db.prepare('SELECT receipt_name, receipt_type, receipt FROM expenses WHERE id = ?').get(id) || null;
}

export function expenseSummary(userId, month) {
  const rows = db
    .prepare(`SELECT category, amount, status FROM expenses WHERE user_id = ? AND substr(used_on, 1, 7) = ? AND status != 'rejected' AND status != 'cancelled'`)
    .all(userId, month);
  const byCat = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.value, 0]));
  let total = 0;
  let pending = 0;
  let approved = 0;
  for (const r of rows) {
    total += r.amount;
    byCat[r.category] = (byCat[r.category] || 0) + r.amount;
    if (r.status === 'pending') pending++;
    if (r.status === 'approved') approved++;
  }
  return { total, count: rows.length, pending, approved, byCat };
}

export function createExpense(user, { usedOn, category, amount, merchant, memo, file }) {
  return tx(db, () => {
    const approver = approverFor(user);
    const r = db
      .prepare(
        `INSERT INTO expenses (user_id, used_on, category, amount, merchant, memo, receipt_name, receipt_type, receipt, status, approver_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(user.id, usedOn, category, amount, merchant, memo, file?.filename ?? null, file?.type ?? null, file?.data ?? null, approver.id, NOW);
    const id = Number(r.lastInsertRowid);
    const fields = [['사용일', dateW(usedOn)], ['분류', categoryLabel(category)], ['사용처', merchant], ['금액', `${fmtWon(amount)}원`]];
    if (memo) fields.push(['메모', memo]);
    createDoc({
      kind: 'expense',
      title: `${categoryLabel(category)} 청구 · ${merchant}`,
      drafter: user,
      approvers: [{ user: approver, role: '승인' }],
      body: { fields, attachments: file ? [{ name: file.filename, expenseId: id }] : [] },
      ref: ['expense', id],
    });
    return id;
  });
}

// ---------- attendance ----------

export function attendanceRange(userId, from, to) {
  return db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date >= ? AND work_date <= ? ORDER BY work_date DESC').all(userId, from, to);
}

export function attendanceOn(userId, date) {
  return db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, date) || null;
}

export function myCorrections(userId) {
  return db.prepare('SELECT * FROM corrections WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(userId);
}

export function createCorrection(userId, { date, field, time, reason }) {
  db.prepare(`INSERT INTO corrections (user_id, work_date, field, time, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(userId, date, field, time, reason, NOW);
}

// ---------- notices ----------

const NOTICE_SELECT = `SELECT n.*, u.name AS author_name, u.title AS author_title, dp.name AS author_dept
  FROM notices n JOIN users u ON u.id = n.author_id JOIN departments dp ON dp.id = u.dept_id`;

export function listNotices(limit = 50) {
  return db.prepare(`${NOTICE_SELECT} ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC LIMIT ?`).all(limit);
}

export function getNotice(id) {
  return db.prepare(`${NOTICE_SELECT} WHERE n.id = ?`).get(id) || null;
}

// The notice featured on the home page (settings home.featured_notice), or
// else the newest notice that has a photo.
export function featuredNotice() {
  const id = Number(getSettings('home').featured_notice);
  const featured = id ? getNotice(id) : null;
  return featured || db.prepare(`${NOTICE_SELECT} WHERE n.photo IS NOT NULL ORDER BY n.created_at DESC, n.id DESC LIMIT 1`).get() || null;
}

export function createNotice(user, { title, body, pinned }) {
  const r = db.prepare('INSERT INTO notices (title, body, author_id, pinned, views, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(title, body, user.id, pinned ? 1 : 0, NOW);
  return Number(r.lastInsertRowid);
}

// ---------- notifications, schedule, settings, search ----------

export function notifications(userId, limit = 4) {
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(userId, limit);
}

export function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n;
}

export function upcoming(user, limit = 5) {
  const items = [];
  const leaves = db
    .prepare(
      `SELECT l.*, u.name AS user_name FROM leave_requests l JOIN users u ON u.id = l.user_id
       WHERE u.dept_id = ? AND l.status IN ('approved', 'pending') AND l.end_date >= ? ORDER BY l.start_date`,
    )
    .all(user.dept_id, TODAY);
  for (const l of leaves) {
    items.push({ kind: 'leave', date: l.start_date, end: l.end_date, title: `${l.user_name} ${leaveTypeLabel(l.type)}`, detail: `${user.dept} · ${fmtDays(l.days)}`, pending: l.status === 'pending', mine: l.user_id === user.id });
  }
  const events = db.prepare('SELECT * FROM events WHERE COALESCE(end_date, date) >= ? ORDER BY date').all(TODAY);
  for (const e of events) items.push({ kind: 'event', date: e.date, end: e.end_date, title: e.title, detail: e.detail });
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'leave' ? -1 : 1));
  return items.slice(0, limit);
}

export function getSettings(scope) {
  const rows = db.prepare('SELECT key, value FROM settings WHERE scope = ?').all(scope);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function saveSettings(scope, values) {
  tx(db, () => {
    const up = db.prepare('INSERT INTO settings (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(values)) up.run(scope, k, String(v));
  });
}

export function search(user, q) {
  const like = `%${q}%`;
  const members = db.prepare(`SELECT ${USER_COLS} ${USER_FROM} WHERE u.name LIKE ? OR u.email LIKE ? OR d.name LIKE ? ORDER BY u.name LIMIT 8`).all(like, like, like);
  const away = onLeaveToday();
  members.forEach((m) => (m.status = memberStatus(m, away)));
  const docs = db
    .prepare(
      `${DOC_SELECT} WHERE d.title LIKE ? AND (d.drafter_id = ? OR EXISTS (SELECT 1 FROM approval_steps s WHERE s.doc_id = d.id AND s.user_id = ?))
       ORDER BY d.drafted_at DESC LIMIT 8`,
    )
    .all(like, user.id, user.id);
  const notices = db.prepare(`${NOTICE_SELECT} WHERE n.title LIKE ? OR n.body LIKE ? ORDER BY n.created_at DESC LIMIT 8`).all(like, like);
  return { members, docs, notices };
}

