// Attendance: monthly summary, recent records and correction requests.
import { layout, html, status, pageHead, sectionHead, dialog, dialogButton, textField, textArea, radioChips, emptyState } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { TODAY, NOW_TIME, addDays, isValidDate, minutesOf, fmtDuration, fmtClock, fmtMonthDayW, fmtMonthDay, monthOf, fmtStampShort } from '../lib/dates.mjs';

const LUNCH = 60;
const worked = (r) => (r.clock_in && r.clock_out ? Math.max(0, minutesOf(r.clock_out) - minutesOf(r.clock_in) - LUNCH) : 0);
const FIELD_LABEL = { in: '출근', out: '퇴근' };

function render(ctx, { values = {}, errors = {}, open = false, status: code = 200 } = {}) {
  const u = ctx.user;
  const rows = data.attendanceRange(u.id, addDays(TODAY, -10), TODAY);
  const month = monthOf(TODAY);
  const [y, m] = month.split('-').map(Number);
  const inMonth = data.attendanceRange(u.id, `${month}-01`, TODAY);
  const workedRows = inMonth.filter((r) => r.clock_in);
  const done = inMonth.filter((r) => r.clock_in && r.clock_out);
  const totalMin = done.reduce((s, r) => s + worked(r), 0);
  const avgIn = workedRows.length ? workedRows.reduce((s, r) => s + minutesOf(r.clock_in), 0) / workedRows.length : 0;
  const late = inMonth.filter((r) => r.status === 'late').length;
  const today = inMonth.find((r) => r.work_date === TODAY);
  const todayWorked = today?.clock_in && !today.clock_out ? Math.max(0, minutesOf(NOW_TIME) - minutesOf(today.clock_in)) : 0;
  const corrections = data.myCorrections(u.id);
  const oldest = rows[rows.length - 1]?.work_date || TODAY;

  const fact = (label, value, sub) => html`<div class="month-fact"><dt>${label}</dt><dd><span class="month-value">${value}</span>${sub ? html`<span class="month-sub">${sub}</span>` : ''}</dd></div>`;

  const body = html`
${pageHead({
  title: '근태',
  desc: '출퇴근 기록과 근무 시간을 확인하고, 잘못된 기록은 정정을 요청하세요.',
  actions: dialogButton('correction-dialog', '근무 기록 정정 요청'),
})}

<section class="section" aria-labelledby="month-title">
  ${sectionHead('month-title', `${y}년 ${m}월`, html`<span class="section-aside">${fmtMonthDay(`${month}-01`)} – ${fmtMonthDay(TODAY)} 기준</span>`)}
  <dl class="month-facts">
    ${fact('오늘 출근', today?.clock_in || '—', today?.clock_in && !today.clock_out ? `${fmtDuration(todayWorked)}째 근무 중` : '')}
    ${fact('근무일', `${workedRows.length}일`, `휴가 ${inMonth.filter((r) => r.status === 'vacation').length}일 · 외근 ${inMonth.filter((r) => r.status === 'outside').length}일`)}
    ${fact('총 근무 시간', fmtDuration(totalMin), `퇴근까지 마친 ${done.length}일 기준`)}
    ${fact('평균 출근', avgIn ? fmtClock(avgIn) : '—', '기준 출근 09:00')}
    ${fact('지각', `${late}회`, late ? '이번 달 누적' : '이번 달은 지각이 없어요')}
  </dl>
</section>

<section class="section" aria-labelledby="records-title">
  ${sectionHead('records-title', '최근 근무 기록', html`<span class="section-aside">${fmtMonthDay(oldest)} – ${fmtMonthDay(TODAY)}</span>`)}
  <div class="table-wrap">
  <table class="table">
    <thead><tr><th scope="col" style="width:200px">날짜</th><th scope="col" style="width:120px">출근</th><th scope="col" style="width:160px">퇴근</th><th scope="col" style="width:160px">근무 시간</th><th scope="col" style="width:120px">상태</th><th scope="col">메모</th></tr></thead>
    <tbody>
      ${rows.map((r) => {
        const isToday = r.work_date === TODAY;
        let hours = '—';
        if (r.clock_in && r.clock_out) hours = fmtDuration(worked(r));
        else if (isToday && r.clock_in) hours = html`<span class="cell-strong">근무 중</span>`;
        return html`<tr${isToday ? html` class="is-today"` : ''}>
          <td class="cell-strong">${fmtMonthDayW(r.work_date)}${isToday ? html`<span class="cell-aside">오늘</span>` : ''}</td>
          <td>${r.clock_in || '—'}</td>
          <td>${r.clock_out || '—'}${r.corrected ? html`<span class="cell-aside">정정됨</span>` : ''}</td>
          <td>${hours}</td>
          <td>${status(r.status)}</td>
          <td class="cell-muted">${r.note || '—'}</td>
        </tr>`;
      })}
    </tbody>
  </table>
  </div>
</section>

<section class="section" aria-labelledby="corr-title">
  ${sectionHead('corr-title', '정정 요청 내역', html`<span class="section-aside">${corrections.length}건</span>`)}
  ${corrections.length
    ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col" style="width:200px">대상 날짜</th><th scope="col" style="width:120px">항목</th><th scope="col" style="width:160px">정정 시간</th><th scope="col">사유</th><th scope="col" style="width:120px">상태</th><th scope="col" class="ta-r" style="width:140px">요청일</th></tr></thead>
      <tbody>${corrections.map(
        (c) => html`<tr>
          <td class="cell-strong">${fmtMonthDayW(c.work_date)}</td>
          <td>${FIELD_LABEL[c.field]}</td>
          <td>${c.time}</td>
          <td class="cell-muted cell-wrap">${c.reason}</td>
          <td>${status(c.status)}</td>
          <td class="ta-r cell-muted">${fmtStampShort(c.created_at)}</td>
        </tr>`,
      )}</tbody></table></div>`
    : emptyState({ title: '정정 요청 내역이 없어요' })}
</section>`;

  const correctionDialog = dialog({
    id: 'correction-dialog',
    title: '근무 기록 정정 요청',
    desc: '잘못 남은 출퇴근 시간을 알려 주세요. 경영지원팀이 확인한 뒤 반영해요.',
    action: '/attendance',
    hidden: { intent: 'correction' },
    autoOpen: open,
    body: html`
      ${textField({ id: 'corr-date', name: 'date', label: '날짜', value: values.date, placeholder: 'YYYY-MM-DD', error: errors.date, maxlength: 10, cls: 'field-narrow' })}
      ${radioChips({ id: 'corr-field', name: 'field', label: '정정 항목', value: values.field, options: [{ value: 'in', label: '출근' }, { value: 'out', label: '퇴근' }], error: errors.field })}
      ${textField({ id: 'corr-time', name: 'time', label: '정정 시간', value: values.time, placeholder: '예: 09:00', error: errors.time, maxlength: 5, cls: 'field-narrow' })}
      ${textArea({ id: 'corr-reason', name: 'reason', label: '사유', value: values.reason, placeholder: '예: 외부 미팅 후 복귀해서 퇴근 기록을 늦게 남겼어요.', error: errors.reason, rows: 3, maxlength: 200 })}`,
    foot: html`<button type="button" class="btn btn-secondary" data-dialog-close>취소</button><button type="submit" class="btn btn-primary">요청 보내기</button>`,
  });

  return ctx.send(code, layout(ctx, { title: '근태', nav: 'attendance', crumbs: [{ label: '근태' }], body, dialogs: [correctionDialog] }));
}

export const attendancePage = (ctx) => render(ctx);

export function attendancePost(ctx) {
  const b = ctx.body;
  if (b.intent !== 'correction') return ctx.redirect('/attendance');
  const values = { date: String(b.date || '').trim(), time: String(b.time || '').trim(), field: b.field, reason: String(b.reason || '').trim() };
  const errors = {};
  if (!values.date) errors.date = '날짜를 입력해 주세요.';
  else if (!isValidDate(values.date)) errors.date = 'YYYY-MM-DD 형식으로 입력해 주세요.';
  else if (values.date > TODAY) errors.date = '오늘 이후 날짜는 정정할 수 없어요.';
  if (!['in', 'out'].includes(values.field)) errors.field = '정정할 항목을 선택해 주세요.';
  const tm = /^(\d{1,2}):(\d{2})$/.exec(values.time);
  if (!values.time) errors.time = '정정 시간을 입력해 주세요.';
  else if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) errors.time = 'HH:MM 형식으로 입력해 주세요.';
  else values.time = `${tm[1].padStart(2, '0')}:${tm[2]}`;
  if (!values.reason) errors.reason = '사유를 입력해 주세요.';
  if (Object.keys(errors).length) return render(ctx, { values, errors, open: true, status: 422 });
  data.createCorrection(ctx.user.id, values);
  ctx.redirect('/attendance', { flash: '정정 요청을 보냈어요' });
}
