// Settings: my profile, notifications, leave policy (admin), company (admin).
import { layout, html, icon, pageHead, avatar, textField, radioChips, switchRow, errorSummary } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { fmtDot } from '../lib/dates.mjs';

const SECTIONS = [
  { key: 'profile', label: '내 정보', ico: 'user', desc: '이름과 연락처를 관리해요.' },
  { key: 'notifications', label: '알림', ico: 'bell', desc: '받고 싶은 알림을 고르세요.' },
  { key: 'leave-policy', label: '휴가 정책', ico: 'calendar', desc: '연차 부여 기준과 반차 사용 여부를 정해요.', admin: true },
  { key: 'company', label: '회사 정보', ico: 'building', desc: '회사 기본 정보를 관리해요.', admin: true },
];

const NOTIFY = [
  ['approval_request', '결재 요청', '내가 결재할 문서가 올라오면 알려드려요.'],
  ['approval_result', '결재 결과', '내가 올린 문서가 승인되거나 반려되면 알려드려요.'],
  ['notice', '새 공지', '공지사항이 올라오면 알려드려요.'],
  ['attendance', '출근 기록 알림', '오전 10시까지 출근 기록이 없으면 알려드려요.'],
  ['email', '이메일로도 받기', '중요한 알림을 회사 이메일로도 보내드려요.'],
];

function shell(ctx, section, inner, { status = 200, errors = {} } = {}) {
  const u = ctx.user;
  const meta = SECTIONS.find((s) => s.key === section);
  const visible = SECTIONS.filter((s) => !s.admin || u.role === 'admin');
  const body = html`
${pageHead({ title: '설정', desc: '내 정보와 알림, 회사 운영 정책을 관리하세요.' })}
<div class="settings">
  <nav class="settings-nav" aria-label="설정 메뉴">
    <ul>${visible.map(
      (s) => html`<li><a class="settings-link${s.key === section ? ' is-active' : ''}" href="/settings/${s.key}"${s.key === section ? html` aria-current="page"` : ''}>${icon(s.ico, { size: 17 })}<span>${s.label}</span>${s.admin ? html`<span class="settings-scope">관리자</span>` : ''}</a></li>`,
    )}</ul>
  </nav>
  <div class="settings-main">
    ${errorSummary(errors)}
    <section aria-labelledby="settings-title">
      <div class="settings-head"><h2 id="settings-title">${meta.label}</h2><p class="settings-desc">${meta.desc}</p></div>
      ${inner}
    </section>
  </div>
</div>`;
  return ctx.send(status, layout(ctx, { title: `${meta.label} · 설정`, nav: 'settings', crumbs: [{ label: '설정', href: '/settings' }, { label: meta.label }], body }));
}

const foot = html`<div class="form-foot"><button type="submit" class="btn btn-primary">저장</button></div>`;

function profileForm(ctx, { values, errors = {}, status } = {}) {
  const u = ctx.user;
  const v = values || { name: u.name, phone: u.phone || '', email: u.email };
  return shell(
    ctx,
    'profile',
    html`<form method="post" action="/settings/profile" novalidate aria-labelledby="settings-title">
      <div class="settings-body">
        <div class="profile-row">${avatar(u, 56)}<div><p class="profile-row-name">${u.name}</p><p class="profile-row-sub">${u.dept} · ${u.title} · 입사 ${u.joined_on ? fmtDot(u.joined_on) : '—'}</p></div></div>
        <div class="field-row">
          ${textField({ id: 'profile-name', name: 'name', label: '이름', value: v.name, error: errors.name, maxlength: 20 })}
          ${textField({ id: 'profile-phone', name: 'phone', label: '휴대전화', value: v.phone, placeholder: '010-0000-0000', error: errors.phone, maxlength: 13 })}
        </div>
        ${textField({ id: 'profile-email', name: 'email', label: '이메일', value: v.email, error: errors.email, type: 'email', maxlength: 80, hint: '로그인할 때 쓰는 이메일이에요.' })}
        <div class="readonly-grid">
          <div><span class="label">부서</span><p>${u.dept}</p></div>
          <div><span class="label">직책</span><p>${u.title || '—'}</p></div>
          <div><span class="label">사번</span><p>${u.employee_no || '—'}</p></div>
        </div>
      </div>
      ${foot}
    </form>`,
    { status, errors },
  );
}

function notificationsForm(ctx) {
  const prefs = data.getSettings(`user:${ctx.user.id}`);
  return shell(
    ctx,
    'notifications',
    html`<form method="post" action="/settings/notifications" novalidate aria-labelledby="settings-title">
      <div class="settings-body switch-list">${NOTIFY.map(([key, label, desc]) => switchRow({ id: `notify-${key}`, name: key, label, desc, checked: prefs[key] === '1' }))}</div>
      ${foot}
    </form>`,
  );
}

function leavePolicyForm(ctx) {
  const p = data.getSettings('leave');
  return shell(
    ctx,
    'leave-policy',
    html`<form method="post" action="/settings/leave-policy" novalidate aria-labelledby="settings-title">
      <div class="settings-body">
        ${radioChips({ id: 'policy-basis', name: 'basis', label: '연차 기준', value: p.basis || 'fiscal', options: [{ value: 'hire', label: '입사일 기준' }, { value: 'fiscal', label: '회계연도 기준' }], hint: '회계연도 기준이면 매년 1월 1일에 연차가 새로 생겨요.' })}
        <div class="switch-list">
          ${switchRow({ id: 'policy-half', name: 'half_day', label: '반차 사용', desc: '오전·오후 반차(0.5일)를 신청할 수 있어요.', checked: p.half_day === '1' })}
          ${switchRow({ id: 'policy-carry', name: 'carry_over', label: '남은 연차 이월', desc: '쓰지 못한 연차를 다음 해로 최대 5일까지 넘겨요.', checked: p.carry_over === '1' })}
        </div>
      </div>
      ${foot}
    </form>`,
  );
}

function companyForm(ctx, { values, errors = {}, status } = {}) {
  const c = values || data.getSettings('company');
  return shell(
    ctx,
    'company',
    html`<form method="post" action="/settings/company" novalidate aria-labelledby="settings-title">
      <div class="settings-body">
        <div class="field-row">
          ${textField({ id: 'company-name', name: 'name', label: '회사명', value: c.name, error: errors.name, maxlength: 40 })}
          ${textField({ id: 'company-ceo', name: 'ceo', label: '대표자', value: c.ceo, error: errors.ceo, maxlength: 20 })}
        </div>
        <div class="field-row">
          ${textField({ id: 'company-bizno', name: 'bizno', label: '사업자등록번호', value: c.bizno, error: errors.bizno, maxlength: 12, placeholder: '000-00-00000' })}
          ${textField({ id: 'company-phone', name: 'phone', label: '대표 전화', value: c.phone, error: errors.phone, maxlength: 13 })}
        </div>
        ${textField({ id: 'company-address', name: 'address', label: '주소', value: c.address, error: errors.address, maxlength: 80 })}
        <div class="field-row">
          ${textField({ id: 'company-start', name: 'work_start', label: '출근 시간', value: c.work_start, error: errors.work_start, maxlength: 5, placeholder: '09:00' })}
          ${textField({ id: 'company-end', name: 'work_end', label: '퇴근 시간', value: c.work_end, error: errors.work_end, maxlength: 5, placeholder: '18:00' })}
        </div>
      </div>
      ${foot}
    </form>`,
    { status, errors },
  );
}

export function settingsPage(ctx, section) {
  const meta = SECTIONS.find((s) => s.key === section);
  if (!meta || (meta.admin && ctx.user.role !== 'admin')) return ctx.notFound();
  if (section === 'profile') return profileForm(ctx);
  if (section === 'notifications') return notificationsForm(ctx);
  if (section === 'leave-policy') return leavePolicyForm(ctx);
  return companyForm(ctx);
}

const SAVED = '변경 사항을 저장했어요.';

export function settingsPost(ctx, section) {
  const meta = SECTIONS.find((s) => s.key === section);
  if (!meta || (meta.admin && ctx.user.role !== 'admin')) return ctx.notFound();
  const b = ctx.body;
  const u = ctx.user;
  if (section === 'profile') {
    const values = { name: String(b.name || '').trim(), phone: String(b.phone || '').trim(), email: String(b.email || '').trim() };
    const errors = {};
    if (!values.name) errors.name = '이름을 입력해 주세요.';
    if (values.phone && !/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(values.phone)) errors.phone = '010-0000-0000 형식으로 입력해 주세요.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = '이메일 형식이 올바르지 않아요.';
    else if (data.emailTaken(values.email, u.id)) errors.email = '다른 구성원이 쓰고 있는 이메일이에요.';
    if (Object.keys(errors).length) return profileForm(ctx, { values, errors, status: 422 });
    data.updateProfile(u.id, values);
  } else if (section === 'notifications') {
    data.saveSettings(`user:${u.id}`, Object.fromEntries(NOTIFY.map(([k]) => [k, b[k] === '1' ? '1' : '0'])));
  } else if (section === 'leave-policy') {
    data.saveSettings('leave', { basis: b.basis === 'hire' ? 'hire' : 'fiscal', half_day: b.half_day === '1' ? '1' : '0', carry_over: b.carry_over === '1' ? '1' : '0' });
  } else {
    const keys = ['name', 'ceo', 'bizno', 'phone', 'address', 'work_start', 'work_end'];
    const values = Object.fromEntries(keys.map((k) => [k, String(b[k] || '').trim()]));
    const errors = {};
    if (!values.name) errors.name = '회사명을 입력해 주세요.';
    if (values.bizno && !/^\d{3}-?\d{2}-?\d{5}$/.test(values.bizno)) errors.bizno = '000-00-00000 형식으로 입력해 주세요.';
    for (const k of ['work_start', 'work_end']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values[k])) errors[k] = 'HH:MM 형식으로 입력해 주세요.';
    if (Object.keys(errors).length) return companyForm(ctx, { values, errors, status: 422 });
    data.saveSettings('company', values);
  }
  ctx.redirect(`/settings/${section}`, { flash: SAVED });
}

