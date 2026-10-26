// Members directory, invitations and profiles.
import { layout, html, icon, status, pageHead, sectionHead, avatar, dialog, dialogButton, textField, selectField, radioChips, emptyState, pagination } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { TODAY, fmtDot, fmtStamp, fmtStampShort, fmtMonthDay } from '../lib/dates.mjs';

const PER_PAGE = 9;
const ROLE_LABEL = { admin: '관리자', member: '일반' };

const invitedOn = (m) => `초대됨 · ${fmtMonthDay(m.created_at.slice(0, 10))}`;
const resentText = (m) => (m.invite_resent_at ? `${fmtStampShort(m.invite_resent_at)}에 다시 보냈어요` : '');

function render(ctx, { values = {}, errors = {}, open = false, status: code = 200 } = {}) {
  const q = String(ctx.query.get('q') || '').trim();
  const dept = String(ctx.query.get('dept') || '');
  const page = Number(ctx.query.get('page') || 1) || 1;
  const depts = data.departments();
  const list = data.listMembers({ q, dept, page, perPage: PER_PAGE });
  const stats = data.companyStats();
  const company = data.getSettings('company');
  const href = (p) => `/members?${new URLSearchParams({ ...(q ? { q } : {}), ...(dept ? { dept } : {}), page: String(p) })}`;
  const filtered = q || dept;

  const body = html`
${pageHead({
  title: '구성원',
  desc: `${company.name || '우리 회사'} 구성원 ${stats.total}명의 정보와 근무 상태를 확인하세요.`,
  actions: dialogButton('invite-dialog', '구성원 초대', { cls: 'btn btn-primary' }),
})}
<section class="section section-flush" aria-label="구성원 목록">
  <form class="toolbar" method="get" action="/members" role="search" aria-label="구성원 검색">
    <div class="tool-field tool-search">
      <label class="sr-only" for="member-q">검색</label>
      <div class="input-wrap has-icon">${icon('search', { size: 16, cls: 'ico input-icon' })}<input class="input input-sm" id="member-q" name="q" value="${q}" placeholder="이름 또는 이메일" autocomplete="off"></div>
    </div>
    <div class="tool-field">
      <label class="sr-only" for="member-dept">소속</label>
      <select class="input input-sm select" id="member-dept" name="dept" data-autosubmit>
        <option value="">전체 부서</option>
        ${depts.map((d) => html`<option value="${d.id}"${String(d.id) === dept ? html` selected` : ''}>${d.name}</option>`)}
      </select>
    </div>
    <button type="submit" class="btn btn-secondary btn-sm">조회</button>
    ${filtered ? html`<a class="btn btn-ghost btn-sm" href="/members">초기화</a>` : ''}
    <span class="toolbar-count">${filtered ? `검색 결과 ${list.total}명` : `전체 ${list.total}명`}</span>
  </form>
  ${list.rows.length
    ? html`<div class="table-wrap"><table class="table table-fixed table-members">
      <thead><tr><th scope="col" class="col-name">이름</th><th scope="col" class="col-dept">부서</th><th scope="col" class="col-title">직책</th><th scope="col">이메일</th><th scope="col" class="col-status">상태</th><th scope="col" class="col-actions"><span class="sr-only">초대 관리</span></th></tr></thead>
      <tbody>${list.rows.map(
        (m) => html`<tr data-href="/members/${m.id}">
          <td><span class="person">${avatar(m, 28)}<a class="cell-link" href="/members/${m.id}">${m.name}</a>${m.id === ctx.user.id ? html`<span class="person-aside">나</span>` : ''}</span></td>
          <td>${m.dept}</td>
          <td>${m.title || html`<span class="cell-muted">—</span>`}</td>
          <td class="cell-muted cell-clip">${m.email}</td>
          <td>${m.invited ? status('invited', invitedOn(m)) : status(m.status)}</td>
          <td>${m.invited
            ? html`<div class="row-actions"><span class="resend-note" id="resend-note-${m.id}" aria-live="polite">${resentText(m)}</span><button type="button" class="btn btn-secondary btn-sm" data-resend-invite="/members/${m.id}/resend-invite" data-resend-note="resend-note-${m.id}">초대 메일 다시 보내기</button></div>`
            : ''}</td>
        </tr>`,
      )}</tbody></table></div>
      ${pagination({ ...list, href })}`
    : emptyState({ title: '조건에 맞는 구성원이 없어요', desc: '검색어나 부서를 바꿔 보세요.' })}
</section>`;

  const inviteDialog = dialog({
    id: 'invite-dialog',
    title: '구성원 초대',
    desc: '초대 메일을 받은 구성원이 비밀번호를 설정하면 바로 함께 일할 수 있어요.',
    action: '/members',
    hidden: { intent: 'invite' },
    autoOpen: open,
    body: html`
      ${textField({ id: 'invite-name', name: 'name', label: '이름', value: values.name, placeholder: '예: 윤서진', error: errors.name, maxlength: 20 })}
      ${textField({ id: 'invite-email', name: 'email', label: '이메일', value: values.email, placeholder: 'name@company.com', error: errors.email, type: 'email', maxlength: 80 })}
      ${selectField({ id: 'invite-dept', name: 'dept', label: '부서', value: values.dept, placeholder: '부서를 선택하세요', options: depts.map((d) => ({ value: d.id, label: d.name })), error: errors.dept })}
      ${radioChips({ id: 'invite-role', name: 'role', label: '권한', value: values.role || 'member', options: [{ value: 'member', label: '일반' }, { value: 'admin', label: '관리자' }], error: errors.role, hint: '관리자는 휴가 정책과 회사 정보를 바꿀 수 있어요.' })}`,
    foot: html`<button type="button" class="btn btn-secondary" data-dialog-close>취소</button><button type="submit" class="btn btn-primary">초대 보내기</button>`,
  });

  return ctx.send(code, layout(ctx, { title: '구성원', nav: 'members', crumbs: [{ label: '구성원' }], body, dialogs: [inviteDialog] }));
}

export const membersPage = (ctx) => render(ctx);

export function membersPost(ctx) {
  const b = ctx.body;
  if (b.intent !== 'invite') return ctx.redirect('/members');
  const values = { name: String(b.name || '').trim(), email: String(b.email || '').trim(), dept: String(b.dept || ''), role: b.role || '' };
  const errors = {};
  if (!values.name) errors.name = '이름을 입력해 주세요.';
  if (!values.email) errors.email = '이메일을 입력해 주세요.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = '이메일 형식이 올바르지 않아요.';
  else if (data.emailTaken(values.email)) errors.email = '이미 등록된 이메일이에요.';
  if (!data.departments().some((d) => String(d.id) === values.dept)) errors.dept = '부서를 선택해 주세요.';
  if (!['member', 'admin'].includes(values.role)) errors.role = '권한을 선택해 주세요.';
  if (Object.keys(errors).length) return render(ctx, { values, errors, open: true, status: 422 });
  data.inviteMember({ name: values.name, email: values.email, deptId: Number(values.dept), role: values.role });
  ctx.redirect('/members', { flash: `${values.name}님에게 초대 메일을 보냈어요.` });
}

// Resend a pending invitation. Called with fetch from the members table, so it
// answers JSON instead of redirecting.
export function memberResendInvite(ctx, id) {
  if (!data.resendInvite(id)) return ctx.json(404, { ok: false });
  ctx.json(200, { ok: true });
}

export function memberDetail(ctx, id) {
  const m = data.getUser(id);
  if (!m) return ctx.notFound();
  m.status = data.memberStatus(m);
  const team = data.teamMembers(m);
  const plans = data.upcomingLeaves(m.id);
  const row = (k, v) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`;
  const body = html`
<div class="page-head profile-head">
  ${avatar(m, 64)}
  <div class="page-head-text">
    <h1 id="member-name">${m.name}</h1>
    <p class="head-meta"><span>${m.dept}${m.title ? ` · ${m.title}` : ''}</span><span class="dot-sep" aria-hidden="true"></span>${m.invited ? status('invited', invitedOn(m)) : status(m.status)}${m.role === 'admin' ? html`<span class="dot-sep" aria-hidden="true"></span><span>관리자</span>` : ''}</p>
  </div>
  <div class="page-actions"><a class="btn btn-secondary" href="/members">목록으로</a></div>
</div>
<div class="detail-layout">
  <section class="section" aria-labelledby="member-info-title">
    ${sectionHead('member-info-title', '기본 정보')}
    <dl class="kv">
      ${row('이메일', m.email)}
      ${row('휴대전화', m.phone || '—')}
      ${row('부서', m.dept)}
      ${row('직책', m.title || '—')}
      ${row('권한', ROLE_LABEL[m.role])}
      ${m.invited ? row('초대일', fmtStamp(m.created_at)) : row('입사일', m.joined_on ? fmtDot(m.joined_on) : '—')}
      ${m.invited && m.invite_resent_at ? row('다시 보낸 날', fmtStamp(m.invite_resent_at)) : ''}
      ${m.invited ? '' : row('사번', m.employee_no || '—')}
    </dl>
    ${m.invited ? html`<p class="quiet-note">아직 초대를 수락하지 않았어요. 초대 메일은 7일 동안 유효해요.</p>` : ''}
  </section>
  <div class="side-stack">
    <section aria-labelledby="leave-plan-title">
      ${sectionHead('leave-plan-title', '휴가 일정', html`<span class="section-aside">오늘 이후</span>`)}
      ${plans.length
        ? html`<ul class="plain-list">${plans.map((l) => {
            const now = l.start_date <= TODAY && l.end_date >= TODAY;
            return html`<li class="plain-item"><span class="plain-main"><strong>${data.periodText(l.start_date, l.end_date)}</strong><span class="plain-sub">${data.leaveTypeLabel(l.type)} · ${data.fmtDays(l.days)}</span></span>${status(now ? 'away' : l.status, now ? '오늘' : l.status === 'pending' ? '결재 대기' : '확정')}</li>`;
          })}</ul>`
        : html`<p class="quiet-note">예정된 휴가가 없어요.</p>`}
    </section>
    <section aria-labelledby="team-title">
      ${sectionHead('team-title', `${m.dept} 구성원`, html`<span class="section-aside">${team.length + 1}명</span>`)}
      <ul class="plain-list">${team.map(
        (t) => html`<li class="plain-item" data-href="/members/${t.id}"><span class="person">${avatar(t, 28)}<a class="cell-link" href="/members/${t.id}">${t.name}</a><span class="person-aside">${t.title || '초대 수락 전'}</span></span>${status(t.status)}</li>`,
      )}</ul>
    </section>
  </div>
</div>`;
  return ctx.send(200, layout(ctx, { title: `${m.name} · 구성원`, nav: 'members', crumbs: [{ label: '구성원', href: '/members' }, { label: m.name }], body }));
}
