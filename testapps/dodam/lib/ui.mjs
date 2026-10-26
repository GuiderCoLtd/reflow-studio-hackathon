// Page chrome (sidebar, top bar, dialogs) and shared UI components.
import { html, raw, attr } from './html.mjs';
import { icon, logoMark } from './icons.mjs';
import { PRODUCT } from './config.mjs';
import { relTime } from './dates.mjs';
import * as data from './data.mjs';

const NAV = [
  { caption: null, items: [{ key: 'home', href: '/', label: '홈', icon: 'home' }] },
  {
    caption: '업무',
    items: [
      { key: 'attendance', href: '/attendance', label: '근태', icon: 'clock' },
      { key: 'leave', href: '/leave', label: '휴가', icon: 'calendar' },
      { key: 'approvals', href: '/approvals', label: '결재', icon: 'docCheck', count: true },
      { key: 'expenses', href: '/expenses', label: '경비', icon: 'receipt' },
    ],
  },
  {
    caption: '회사',
    items: [
      { key: 'members', href: '/members', label: '구성원', icon: 'users' },
      { key: 'notices', href: '/notices', label: '공지사항', icon: 'megaphone' },
    ],
  },
];
const NAV_BOTTOM = [{ key: 'settings', href: '/settings', label: '설정', icon: 'gear' }];

// Photographs for some people (by user id, see tools/photos.py). Everyone else
// gets a neutral initial.
const PHOTOS = { 1: 'p-kim-haneul', 2: 'p-park-jihoon', 3: 'p-lee-doyun', 4: 'p-choi-seoa', 6: 'p-han-soyul', 7: 'p-seo-junho' };

export function avatar(person, size = 32) {
  const photo = PHOTOS[person?.id];
  if (photo) {
    const src = `/static/img/${photo}-${size > 80 ? 480 : 160}.jpg`;
    return html`<span class="avatar" style="--av:${size}px" aria-hidden="true"><img src="${src}" alt="" width="${size}" height="${size}"></span>`;
  }
  // One syllable (the family name), ink on the same light gray for everyone.
  return html`<span class="avatar avatar-initial" style="--av:${size}px" aria-hidden="true">${(person?.name || '').slice(0, 1)}</span>`;
}

// Avatar + name, with either a second line (sub) or a quiet word after the name (aside).
export function person(p, { size = 28, sub, aside } = {}) {
  const name = html`<span class="person-name">${p.name}</span>`;
  return html`<span class="person">${avatar(p, size)}${sub ? html`<span class="person-text">${name}<span class="person-sub">${sub}</span></span>` : name}${aside ? html`<span class="person-aside">${aside}</span>` : ''}</span>`;
}

// Read-only approver shown in a form's side column.
export function approverNote(approver, id = 'approver-label') {
  return html`<div class="approver" role="group" aria-labelledby="${id}">
  <span class="approver-label" id="${id}">결재자</span>
  <span class="person">${avatar(approver, 36)}<span class="person-text"><strong class="person-name">${approver.name}</strong><span class="person-sub">${approver.dept} ${approver.title}</span></span></span>
</div>`;
}

// Statuses are plain text: weight and position carry them, and red only marks
// the states that need attention (rejected, late).
const STATUS = {
  approved: ['승인', 'done'],
  pending: ['대기', 'open'],
  rejected: ['반려', 'alert'],
  cancelled: ['취소', 'off'],
  withdrawn: ['회수', 'off'],
  skipped: ['—', 'off'],
  invited: ['초대됨', 'quiet'],
  active: ['재직', 'quiet'],
  away: ['휴가 중', 'open'],
  normal: ['정상', 'quiet'],
  late: ['지각', 'alert'],
  outside: ['외근', 'plain'],
  vacation: ['휴가', 'plain'],
};

export function status(key, label, { cls = '' } = {}) {
  const [text, tone] = STATUS[key] || [key, 'plain'];
  return html`<span class="status is-${tone}${cls ? ` ${cls}` : ''}">${label || text}</span>`;
}

export const kindLabel = (kind) => data.DOC_KINDS[kind] || kind;

export function pageHead({ title, desc, actions, eyebrow, id, meta }) {
  return html`<div class="page-head">
  <div class="page-head-text">
    ${eyebrow ? html`<p class="eyebrow">${eyebrow}</p>` : ''}
    <h1${attr('id', id)}>${title}</h1>
    ${desc ? html`<p class="page-desc">${desc}</p>` : ''}
    ${meta || ''}
  </div>
  ${actions ? html`<div class="page-actions">${actions}</div>` : ''}
</div>`;
}

// Section title row: h2 on the left, a quiet note or link on the right.
export function sectionHead(id, title, aside) {
  return html`<div class="section-head"><h2 id="${id}">${title}</h2>${aside || ''}</div>`;
}

export const moreLink = (href, label) => html`<a class="more-link" href="${href}">${label}${icon('chevronRight', { size: 14 })}</a>`;

export function banner(flash) {
  const ok = flash.tone !== 'error';
  return html`<div class="banner ${ok ? 'banner-success' : 'banner-error'}" role="${ok ? 'status' : 'alert'}">${icon(ok ? 'checkCircle' : 'alertCircle', { size: 18 })}<p>${flash.message}</p></div>`;
}

export function errorSummary(errors) {
  const n = Object.keys(errors || {}).length;
  if (!n) return '';
  return html`<div class="banner banner-error" role="alert">${icon('alertCircle', { size: 18 })}<p>입력한 내용을 확인해 주세요. 고쳐야 할 항목이 ${n}개 있어요.</p></div>`;
}

function described(id, error, hint) {
  return [error ? `${id}-error` : null, !error && hint ? `${id}-hint` : null].filter(Boolean).join(' ') || null;
}

function fieldMessages(id, error, hint) {
  if (error) return html`<p class="field-error" id="${id}-error">${error}</p>`;
  if (hint) return html`<p class="field-hint" id="${id}-hint">${hint}</p>`;
  return '';
}

export function textField({ id, name = id, label, value = '', placeholder, error, hint, type = 'text', suffix, prefixIcon, autocomplete, inputmode, maxlength, autofocus, cls = '' }) {
  return html`<div class="field ${cls}${error ? ' has-error' : ''}">
  <label class="label" for="${id}">${label}</label>
  <div class="input-wrap${suffix ? ' has-suffix' : ''}${prefixIcon ? ' has-icon' : ''}">
    ${prefixIcon ? icon(prefixIcon, { size: 16, cls: 'ico input-icon' }) : ''}
    <input class="input" id="${id}" name="${name}" type="${type}" value="${value ?? ''}"${attr('placeholder', placeholder)}${attr('autocomplete', autocomplete || 'off')}${attr('inputmode', inputmode)}${attr('maxlength', maxlength)}${attr('autofocus', !!autofocus)}${attr('aria-invalid', error ? 'true' : null)}${attr('aria-describedby', described(id, error, hint))}>
    ${suffix ? html`<span class="input-suffix" aria-hidden="true">${suffix}</span>` : ''}
  </div>
  ${fieldMessages(id, error, hint)}
</div>`;
}

export function textArea({ id, name = id, label, value = '', placeholder, error, hint, rows = 3, maxlength, autofocus, cls = '' }) {
  return html`<div class="field ${cls}${error ? ' has-error' : ''}">
  <label class="label" for="${id}">${label}</label>
  <textarea class="input textarea" id="${id}" name="${name}" rows="${rows}"${attr('placeholder', placeholder)}${attr('maxlength', maxlength)}${attr('autofocus', !!autofocus)}${attr('aria-invalid', error ? 'true' : null)}${attr('aria-describedby', described(id, error, hint))}>${value ?? ''}</textarea>
  ${fieldMessages(id, error, hint)}
</div>`;
}

export function selectField({ id, name = id, label, value = '', options, placeholder, error, hint, cls = '', autosubmit }) {
  return html`<div class="field ${cls}${error ? ' has-error' : ''}">
  <label class="label" for="${id}">${label}</label>
  <select class="input select" id="${id}" name="${name}"${attr('data-autosubmit', !!autosubmit)}${attr('aria-invalid', error ? 'true' : null)}${attr('aria-describedby', described(id, error, hint))}>
    ${placeholder !== undefined ? html`<option value="">${placeholder}</option>` : ''}
    ${options.map((o) => html`<option value="${o.value}"${attr('selected', String(o.value) === String(value))}>${o.label}</option>`)}
  </select>
  ${fieldMessages(id, error, hint)}
</div>`;
}

// Single choice as a segmented control: visible <button role="radio"> elements
// in a labelled radiogroup. The selected value travels in a hidden input.
export function radioChips({ id, name = id, label, options, value = '', error, hint, cls = '' }) {
  const hasValue = options.some((o) => o.value === value);
  return html`<div class="field ${cls}${error ? ' has-error' : ''}">
  <span class="label" id="${id}-label">${label}</span>
  <div class="segmented" role="radiogroup" aria-label="${label}" data-radio-input="${id}"${attr('aria-invalid', error ? 'true' : null)}${attr('aria-describedby', described(id, error, hint))}>
    ${options.map((o, i) => {
      const on = o.value === value;
      const focusable = on || (!hasValue && i === 0);
      return html`<button type="button" class="segment" role="radio" aria-checked="${on ? 'true' : 'false'}" tabindex="${focusable ? '0' : '-1'}" data-value="${o.value}">${o.label}</button>`;
    })}
  </div>
  <input type="hidden" id="${id}" name="${name}" value="${hasValue ? value : ''}">
  ${fieldMessages(id, error, hint)}
</div>`;
}

// Toggle switch: a visible <button role="switch"> named by its <label>.
export function switchRow({ id, name = id, label, desc, checked }) {
  return html`<div class="switch-row">
  <div class="switch-text">
    <label class="switch-title" for="${id}-switch">${label}</label>
    ${desc ? html`<span class="switch-desc" id="${id}-desc">${desc}</span>` : ''}
  </div>
  <button type="button" class="switch" role="switch" id="${id}-switch" aria-checked="${checked ? 'true' : 'false'}"${attr('aria-describedby', desc ? `${id}-desc` : null)} data-switch-input="${id}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button>
  <input type="hidden" id="${id}" name="${name}" value="${checked ? '1' : '0'}">
</div>`;
}

export function emptyState({ title, desc, action }) {
  return html`<div class="empty">
  <p class="empty-title">${title}</p>
  ${desc ? html`<p class="empty-desc">${desc}</p>` : ''}
  ${action || ''}
</div>`;
}

export function dialog({ id, title, desc, body, foot, size = '', autoOpen = false, action, method = 'post', enctype, hidden = {} }) {
  const inner = html`
    <div class="modal-head">
      <h2 id="${id}-title">${title}</h2>
      ${desc ? html`<p class="modal-desc" id="${id}-desc">${desc}</p>` : ''}
    </div>
    ${body ? html`<div class="modal-body">${body}</div>` : ''}
    <div class="modal-foot">${foot}</div>`;
  return html`<dialog class="modal ${size}" id="${id}" aria-modal="true" aria-labelledby="${id}-title"${attr('aria-describedby', desc ? `${id}-desc` : null)}${attr('data-autoopen', autoOpen)}>
  ${action
    ? html`<form class="modal-inner" method="${method}" action="${action}" novalidate${attr('enctype', enctype)}>${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}${inner}</form>`
    : html`<div class="modal-inner">${inner}</div>`}
</dialog>`;
}

// Button that opens a <dialog> (Radix-style trigger: haspopup + expanded + controls).
export function dialogButton(id, label, { cls = 'btn btn-secondary' } = {}) {
  return html`<button type="button" class="${cls}" data-dialog-open="${id}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${id}">${label}</button>`;
}

export function pagination({ page, pages, total, perPage, href }) {
  if (pages <= 1) return html`<div class="table-foot"><span>전체 ${total}명</span></div>`;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return html`<div class="table-foot">
  <span>${from}–${to} / 전체 ${total}명</span>
  <nav class="pager" aria-label="페이지">
    ${page > 1 ? html`<a class="pager-btn" href="${href(page - 1)}">${icon('chevronLeft', { size: 14 })}이전</a>` : html`<span class="pager-btn is-disabled" aria-hidden="true">${icon('chevronLeft', { size: 14 })}이전</span>`}
    ${Array.from({ length: pages }, (_, i) => i + 1).map((n) => (n === page ? html`<span class="pager-num is-current" aria-current="page">${n}</span>` : html`<a class="pager-num" href="${href(n)}" aria-label="${n}페이지">${n}</a>`))}
    ${page < pages ? html`<a class="pager-btn" href="${href(page + 1)}">다음${icon('chevronRight', { size: 14 })}</a>` : html`<span class="pager-btn is-disabled" aria-hidden="true">다음${icon('chevronRight', { size: 14 })}</span>`}
  </nav>
</div>`;
}

function sidebar(active, pending, company) {
  const item = (it) => {
    const on = it.key === active;
    return html`<li><a class="nav-item${on ? ' is-active' : ''}" href="${it.href}"${attr('aria-current', on ? 'page' : null)}>${icon(it.icon, { size: 18 })}<span class="nav-label">${it.label}</span>${it.count && pending ? html`<span class="nav-count" aria-hidden="true">${pending}</span>` : ''}</a></li>`;
  };
  return html`<aside class="sidebar">
  <a class="brand" href="/">${logoMark(22)}<span class="brand-name">${PRODUCT}</span></a>
  <nav class="nav" aria-label="주 메뉴">
    ${NAV.map((g) => html`<div class="nav-group">${g.caption ? html`<p class="nav-caption">${g.caption}</p>` : ''}<ul>${g.items.map(item)}</ul></div>`)}
    <div class="nav-group nav-bottom"><ul>${NAV_BOTTOM.map(item)}</ul></div>
  </nav>
  <div class="workspace"><strong>${company.name}</strong><span>구성원 ${company.members}명</span></div>
</aside>`;
}

function crumbsNav(crumbs) {
  return html`<nav class="crumbs" aria-label="현재 위치"><ol>${crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    const sep = i ? icon('chevronRight', { size: 14, cls: 'ico crumb-sep' }) : '';
    if (last || !c.href) return html`<li>${sep}<span${attr('aria-current', last ? 'page' : null)}>${c.label}</span></li>`;
    return html`<li>${sep}<a href="${c.href}">${c.label}</a></li>`;
  })}</ol></nav>`;
}

function topbar(user, crumbs) {
  const notes = data.notifications(user.id, 4);
  const unread = data.unreadCount(user.id);
  return html`<header class="topbar">
  ${crumbsNav(crumbs)}
  <div class="top-actions">
    <button type="button" class="search-trigger" data-dialog-open="search-dialog" aria-haspopup="dialog" aria-expanded="false" aria-controls="search-dialog">${icon('search', { size: 16 })}<span>검색</span><kbd aria-hidden="true">/</kbd></button>
    <div class="menu-wrap">
      <button type="button" class="icon-btn" aria-label="알림" aria-haspopup="menu" aria-expanded="false" aria-controls="notif-panel" data-menu-trigger>${icon('bell', { size: 18 })}${unread ? html`<span class="unread-dot" aria-hidden="true"></span>` : ''}</button>
      <div class="dropdown dropdown-notif" id="notif-panel" hidden>
        <div class="dropdown-head"><strong>알림</strong><span>읽지 않은 알림 ${unread}개</span></div>
        <div class="dropdown-menu" role="menu" aria-label="알림 목록">
          ${notes.map(
            (n) => html`<a class="notif-item${n.read ? '' : ' is-unread'}" role="menuitem" href="${n.link || '/'}" tabindex="-1"><span class="notif-mark" aria-hidden="true"></span><span class="notif-body"><span class="notif-text">${n.text}</span><span class="notif-time">${relTime(n.created_at)}</span></span></a>`,
          )}
          <a class="dropdown-foot" role="menuitem" href="/settings/notifications" tabindex="-1">알림 설정</a>
        </div>
      </div>
    </div>
    <div class="menu-wrap">
      <button type="button" class="profile-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="profile-panel" data-menu-trigger>${avatar(user, 26)}<span class="profile-name">${user.name}</span>${icon('chevronDown', { size: 14, cls: 'ico profile-chev' })}</button>
      <div class="dropdown dropdown-profile" id="profile-panel" hidden>
        <div class="dropdown-user">${avatar(user, 36)}<span><strong>${user.name}</strong><span>${user.dept} · ${user.title || '구성원'}</span></span></div>
        <div class="dropdown-menu" role="menu" aria-label="프로필 메뉴">
          <a class="menu-item" role="menuitem" href="/settings/profile" tabindex="-1">내 정보</a>
          <a class="menu-item" role="menuitem" href="/logout" tabindex="-1">로그아웃</a>
        </div>
      </div>
    </div>
  </div>
</header>`;
}

function searchDialog() {
  const suggestions = ['연말정산', '보안 교육', '모니터', '이도윤'];
  return dialog({
    id: 'search-dialog',
    title: '검색',
    desc: '구성원, 결재 문서, 공지사항을 한 번에 찾아요.',
    size: 'modal-search',
    action: '/search',
    method: 'get',
    body: html`${textField({ id: 'search-q', name: 'q', label: '검색어', placeholder: '예: 연말정산, 김하늘', prefixIcon: 'search', autofocus: true })}
      <div class="search-suggest"><p class="search-suggest-label">추천 검색어</p><ul>${suggestions.map((s) => html`<li><a href="/search?q=${encodeURIComponent(s)}">${s}</a></li>`)}</ul></div>`,
    foot: html`<button type="button" class="btn btn-secondary" data-dialog-close>취소</button><button type="submit" class="btn btn-primary">찾기</button>`,
  });
}

export function documentShell({ title, body, bodyClass = '' }) {
  return html`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | ${PRODUCT}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body${attr('class', bodyClass || null)}>
${body}
</body>
</html>`;
}

export function layout(ctx, { title, nav, crumbs = [], body, dialogs = [] }) {
  const user = ctx.user;
  const company = data.getSettings('company');
  const stats = data.companyStats();
  const flash = ctx.takeFlash();
  return documentShell({
    title,
    body: html`<div class="app">
  ${sidebar(nav, data.pendingCount(user.id), { name: company.name || '주식회사 도담', members: stats.total })}
  <div class="sheet">
    ${topbar(user, crumbs)}
    <main class="content" id="main">
      ${flash ? banner(flash) : ''}
      ${body}
    </main>
  </div>
</div>
${searchDialog()}
${dialogs}`,
  });
}

export { html, raw, attr, icon };
