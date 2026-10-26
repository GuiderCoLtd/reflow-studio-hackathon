// Leave: balance + history, request form, detail with approval progress.
import { layout, html, icon, status, pageHead, sectionHead, moreLink, avatar, person, approverNote, dialog, dialogButton, textField, textArea, radioChips, errorSummary, emptyState } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { L } from '../labels.mjs';
import { TODAY, HOLIDAYS, isValidDate, fmtStamp, fmtStampShort, fmtDot, addDays } from '../lib/dates.mjs';

const num = (n) => data.fmtDays(n).replace('일', '');

export function leaveList(ctx) {
  const u = ctx.user;
  const bal = data.leaveBalance(u);
  const leaves = data.myLeaves(u.id);
  const policy = data.getSettings('leave');
  const year = TODAY.slice(0, 4);
  const period = policy.basis === 'hire' && u.joined_on ? `입사일 기준 · 매년 ${Number(u.joined_on.slice(5, 7))}월 ${Number(u.joined_on.slice(8, 10))}일 갱신` : `회계연도 기준 · ${year}.01.01 – ${year}.12.31`;
  const pct = (n) => `${Math.min(100, (n / bal.total) * 100).toFixed(1)}%`;

  const body = html`
${pageHead({
  title: '휴가',
  desc: '남은 연차와 신청 내역을 확인하세요. 연차는 결재가 승인되면 차감돼요.',
  actions: html`<a class="btn btn-primary" href="/leave/new">${L.leaveNewButton}</a>`,
})}

<section class="section balance" aria-labelledby="balance-title">
  ${sectionHead('balance-title', `${year}년 연차 현황`, html`<span class="section-aside">${period}</span>`)}
  <div class="balance-body">
    <p class="balance-main"><span class="balance-label">남은 연차</span><span class="balance-value">${num(bal.remaining)}<small>일</small></span></p>
    <dl class="balance-facts">
      <div><dt>총 연차</dt><dd>${data.fmtDays(bal.total)}</dd></div>
      <div><dt>사용</dt><dd>${data.fmtDays(bal.used)}</dd></div>
      <div><dt>승인 대기</dt><dd>${data.fmtDays(bal.pending)}</dd></div>
    </dl>
  </div>
  <div class="meter" aria-hidden="true"><span class="meter-used" style="width:${pct(bal.used)}"></span><span class="meter-pending" style="width:${pct(bal.pending)}"></span></div>
</section>

<section class="section" aria-labelledby="history-title">
  ${sectionHead('history-title', '신청 내역', html`<span class="section-aside">${leaves.length}건</span>`)}
  ${leaves.length
    ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">기간</th><th scope="col" style="width:120px">종류</th><th scope="col" class="ta-r" style="width:72px">일수</th><th scope="col" class="col-gap" style="width:132px">상태</th><th scope="col" style="width:180px">결재자</th><th scope="col" class="ta-r" style="width:120px">신청일</th></tr></thead>
      <tbody>${leaves.map(
        (l) => html`<tr data-href="/leave/${l.id}">
          <td><a class="cell-link" href="/leave/${l.id}">${data.periodText(l.start_date, l.end_date)}</a></td>
          <td>${data.leaveTypeLabel(l.type)}</td>
          <td class="ta-r">${data.fmtDays(l.days)}</td>
          <td class="col-gap">${status(l.status)}</td>
          <td>${person({ id: l.approver_id, name: l.approver_name }, { size: 24, aside: l.approver_title })}</td>
          <td class="ta-r cell-muted">${fmtDot(l.created_at.slice(0, 10))}</td>
        </tr>`,
      )}</tbody></table></div>`
    : emptyState({ title: '아직 신청한 휴가가 없어요', desc: '첫 휴가를 신청해 보세요.' })}
</section>`;

  return ctx.send(200, layout(ctx, { title: '휴가', nav: 'leave', crumbs: [{ label: '휴가' }], body }));
}

// Leave types allowed by the company policy (half days can be switched off).
function allowedTypes() {
  const policy = data.getSettings('leave');
  return policy.half_day === '0' ? data.LEAVE_TYPES.filter((t) => !data.isHalf(t.value)) : data.LEAVE_TYPES;
}

function newForm(ctx, { values = {}, errors = {}, status: code = 200 } = {}) {
  const u = ctx.user;
  const bal = data.leaveBalance(u);
  const approver = data.approverFor(u);
  const holidays = [...HOLIDAYS].filter((d) => d >= TODAY && d <= addDays(TODAY, 400));
  const days = values.days || 0;
  const after = bal.available - (data.usesBalance(values.type || 'annual') ? days : 0);

  const body = html`
${pageHead({ title: L.leaveNewTitle, desc: '휴가 종류와 기간을 입력하면 결재자에게 바로 전달돼요.', id: 'leave-form-title' })}
${errorSummary(errors)}
<form class="form-layout" method="post" action="/leave/new" novalidate aria-labelledby="leave-form-title" data-leave-form data-holidays="${JSON.stringify(holidays)}" data-available="${bal.available}">
  <div class="form-main">
    ${radioChips({ id: 'leave-type', name: 'type', label: '휴가 종류', value: values.type, options: allowedTypes(), error: errors.type })}
    <div class="field-range">
      ${textField({ id: 'start-date', name: 'start_date', label: '시작일', value: values.start, placeholder: 'YYYY-MM-DD', error: errors.start, maxlength: 10 })}
      <span class="range-sep" aria-hidden="true">–</span>
      ${textField({ id: 'end-date', name: 'end_date', label: '종료일', value: values.end, placeholder: 'YYYY-MM-DD', error: errors.end, maxlength: 10 })}
    </div>
    ${textArea({ id: 'leave-reason', name: 'reason', label: '사유', value: values.reason, placeholder: '예: 가족 여행', error: errors.reason, rows: 4, maxlength: 200 })}
  </div>
  <div class="form-side">
    <div class="summary">
      <h2 class="summary-title">연차 계산</h2>
      <dl class="summary-list" aria-live="polite">
        <div><dt>사용 가능한 연차</dt><dd>${data.fmtDays(bal.available)}</dd></div>
        <div><dt>이번 휴가</dt><dd><span data-leave-days>${data.fmtDays(days)}</span></dd></div>
        <div class="summary-total"><dt>사용 후 남는 연차</dt><dd><span data-leave-after>${data.usesBalance(values.type || 'annual') ? data.fmtDays(after) : '차감 없음'}</span></dd></div>
      </dl>
    </div>
    ${approverNote(approver)}
  </div>
  <div class="form-foot">
    <a class="btn btn-secondary" href="/leave">취소</a>
    <button type="submit" class="btn btn-primary">${L.leaveSubmit}</button>
  </div>
</form>`;

  return ctx.send(code, layout(ctx, { title: L.leaveNewTitle, nav: 'leave', crumbs: [{ label: '휴가', href: '/leave' }, { label: L.leaveNewTitle }], body }));
}

export const leaveNew = (ctx) => newForm(ctx);

export function leaveCreate(ctx) {
  const u = ctx.user;
  const b = ctx.body;
  const values = { type: b.type || '', start: String(b.start_date || '').trim(), end: String(b.end_date || '').trim(), reason: String(b.reason || '').trim() };
  const errors = {};
  const typeOk = allowedTypes().some((t) => t.value === values.type);
  if (!typeOk) errors.type = data.isHalf(values.type) ? '지금은 반차를 신청할 수 없어요. 회사 휴가 정책을 확인해 주세요.' : '휴가 종류를 선택해 주세요.';
  if (data.isHalf(values.type) && !values.end) values.end = values.start;
  if (!values.start) errors.start = '시작일을 입력해 주세요.';
  else if (!isValidDate(values.start)) errors.start = '날짜를 YYYY-MM-DD 형식으로 입력해 주세요.';
  if (!values.end) errors.end = '종료일을 입력해 주세요.';
  else if (!isValidDate(values.end)) errors.end = '날짜를 YYYY-MM-DD 형식으로 입력해 주세요.';
  if (!errors.start && !errors.end) {
    if (values.end < values.start) errors.end = '종료일은 시작일과 같거나 그 이후여야 해요.';
    else if (data.isHalf(values.type) && values.end !== values.start) errors.end = '반차는 하루만 신청할 수 있어요. 종료일을 시작일과 같게 입력해 주세요.';
    else if (values.start < TODAY && values.type !== 'sick') errors.start = '지난 날짜에는 휴가를 신청할 수 없어요.';
    else {
      values.days = data.leaveDays(values.type || 'annual', values.start, values.end);
      if (!values.days) errors.end = '선택한 기간에 근무일이 없어요. 주말과 공휴일은 빼고 계산해요.';
      else if (data.leaveOverlaps(u.id, values.start, values.end)) errors.start = '이미 신청한 휴가와 기간이 겹쳐요.';
      else if (typeOk && data.usesBalance(values.type)) {
        const bal = data.leaveBalance(u);
        if (values.days > bal.available) errors.start = `사용 가능한 연차(${data.fmtDays(bal.available)})보다 많이 신청했어요.`;
      }
    }
  }
  if (!values.reason) errors.reason = '사유를 입력해 주세요.';
  if (Object.keys(errors).length) return newForm(ctx, { values, errors, status: 422 });
  data.createLeave(u, values);
  ctx.redirect('/leave', { flash: L.leaveCreated });
}

function progress(leave) {
  const approverText = `${leave.approver_name} ${leave.approver_title}`;
  const steps = [{ label: '신청', state: 'done', title: '휴가를 신청했어요', meta: fmtStampShort(leave.created_at) }];
  if (leave.status === 'pending') {
    steps.push({ label: '결재', state: 'current', title: `${approverText}의 결재를 기다리고 있어요`, meta: '결재 대기 중' });
    steps.push({ label: '완료', state: 'todo', title: '결재가 끝나면 알려드릴게요', meta: '' });
  } else if (leave.status === 'approved') {
    steps.push({ label: '결재', state: 'done', title: `${data.josa(approverText, '이', '가')} 승인했어요`, meta: fmtStampShort(leave.decided_at) });
    steps.push({ label: '완료', state: 'done', title: data.usesBalance(leave.type) ? `연차에서 ${data.josa(data.fmtDays(leave.days), '이', '가')} 차감됐어요` : '휴가가 확정됐어요', meta: fmtStampShort(leave.decided_at) });
  } else if (leave.status === 'rejected') {
    steps.push({ label: '결재', state: 'failed', title: `${data.josa(approverText, '이', '가')} 반려했어요`, meta: fmtStampShort(leave.decided_at), note: leave.decision_note });
    steps.push({ label: '완료', state: 'todo', title: '반려된 신청은 다시 신청할 수 있어요', meta: '' });
  } else {
    steps.push({ label: '결재', state: 'failed', title: '신청을 취소했어요', meta: fmtStampShort(leave.decided_at) });
    steps.push({ label: '완료', state: 'todo', title: '결재 요청이 회수됐어요', meta: '' });
  }
  const ico = { done: 'check', current: null, failed: 'x', todo: null };
  return html`<ol class="steps">${steps.map(
    (s) => html`<li class="step is-${s.state}">
      <span class="step-mark">${ico[s.state] ? icon(ico[s.state], { size: 12, stroke: 2.4 }) : ''}</span>
      <div class="step-body">
        <p class="step-label">${s.label}</p>
        <p class="step-title">${s.title}</p>
        ${s.meta ? html`<p class="step-meta">${s.meta}</p>` : ''}
        ${s.note ? html`<p class="step-note">${s.note}</p>` : ''}
      </div>
    </li>`,
  )}</ol>`;
}

export function leaveDetail(ctx, id) {
  const u = ctx.user;
  const leave = data.getLeave(id);
  if (!leave || leave.user_id !== u.id) return ctx.notFound();
  const pending = leave.status === 'pending';
  const row = (k, v) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`;

  const body = html`
${pageHead({
  eyebrow: '휴가 상세',
  title: `${data.leaveTypeLabel(leave.type)} · ${data.fmtDays(leave.days)}`,
  meta: html`<p class="head-meta">${status(leave.status)}<span class="dot-sep" aria-hidden="true"></span><span>${data.periodText(leave.start_date, leave.end_date)}</span></p>`,
  actions: pending ? dialogButton('cancel-dialog', L.leaveCancel, { cls: 'btn btn-danger-quiet' }) : html`<a class="btn btn-secondary" href="/leave">목록으로</a>`,
})}
<div class="detail-layout">
  <section class="section" aria-labelledby="leave-info-title">
    ${sectionHead('leave-info-title', '신청 정보', leave.doc ? moreLink(`/approvals/${leave.doc.id}`, '결재 문서 보기') : '')}
    <dl class="kv">
      ${row('휴가 종류', data.leaveTypeLabel(leave.type))}
      ${row('기간', data.periodText(leave.start_date, leave.end_date))}
      ${row('일수', data.fmtDays(leave.days))}
      ${row('사유', leave.reason)}
      ${row('결재자', person({ id: leave.approver_id, name: leave.approver_name }, { size: 24, aside: `${leave.approver_dept} ${leave.approver_title}` }))}
      ${row('신청일', fmtStamp(leave.created_at))}
      ${leave.doc ? row('문서 번호', leave.doc.doc_no) : ''}
    </dl>
  </section>
  <section class="section" aria-labelledby="leave-progress-title">
    ${sectionHead('leave-progress-title', '결재 진행 상황', pending ? html`<span class="section-aside">진행 중</span>` : '')}
    ${progress(leave)}
  </section>
</div>`;

  const cancelDialog = pending
    ? dialog({
        id: 'cancel-dialog',
        title: L.leaveCancelTitle,
        desc: '결재 요청도 함께 회수돼요. 취소한 신청은 되돌릴 수 없어요.',
        size: 'modal-sm',
        action: `/leave/${leave.id}`,
        hidden: { intent: 'cancel' },
        foot: html`<button type="button" class="btn btn-secondary" data-dialog-close autofocus>닫기</button><button type="submit" class="btn btn-danger">${L.leaveCancelConfirm}</button>`,
      })
    : '';

  return ctx.send(200, layout(ctx, { title: '휴가 상세', nav: 'leave', crumbs: [{ label: '휴가', href: '/leave' }, { label: '휴가 상세' }], body, dialogs: [cancelDialog] }));
}

export function leaveDetailPost(ctx, id) {
  const leave = data.getLeave(id);
  if (!leave || leave.user_id !== ctx.user.id) return ctx.notFound();
  if (ctx.body.intent === 'cancel') {
    if (leave.status !== 'pending') return ctx.redirect(`/leave/${id}`, { flash: '이미 처리된 신청은 취소할 수 없어요.', tone: 'error' });
    data.cancelLeave(leave);
    return ctx.redirect('/leave', { flash: L.leaveCancelled });
  }
  ctx.redirect(`/leave/${id}`);
}
