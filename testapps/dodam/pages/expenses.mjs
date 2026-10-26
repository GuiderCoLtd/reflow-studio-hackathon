// Expenses: monthly summary + list, claim form (with receipt upload), detail.
import { layout, html, icon, status, pageHead, sectionHead, moreLink, person, approverNote, textField, textArea, radioChips, errorSummary, emptyState } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { TODAY, isValidDate, fmtStamp, fmtDot, monthOf, diffDays } from '../lib/dates.mjs';

// Receipt URLs end with the file name, so downloads get a proper name and
// crawlers can tell the link points at a file.
export const receiptUrl = (e) => `/expenses/${e.id}/receipt/${encodeURIComponent(e.receipt_name || 'receipt')}`;

export function expenseList(ctx) {
  const u = ctx.user;
  const month = monthOf(TODAY);
  const sum = data.expenseSummary(u.id, month);
  const rows = data.myExpenses(u.id);
  const m = Number(month.slice(5));
  const cats = data.EXPENSE_CATEGORIES.filter((c) => sum.byCat[c.value] > 0);

  const body = html`
${pageHead({
  title: '경비',
  desc: '업무에 쓴 비용을 청구하고 처리 상태를 확인하세요.',
  actions: html`<a class="btn btn-primary" href="/expenses/new">경비 청구</a>`,
})}

<section class="section exp-summary" aria-labelledby="exp-sum-title">
  ${sectionHead('exp-sum-title', `${m}월 청구 합계`, html`<span class="section-aside">${sum.count}건 · 승인 ${sum.approved}건 · 승인 대기 ${sum.pending}건</span>`)}
  <div class="exp-summary-body">
    <p class="exp-total-value">${data.fmtWon(sum.total)}<small>원</small></p>
    <dl class="exp-cats">${cats.map((c) => html`<div><dt>${c.label}</dt><dd>${data.fmtWon(sum.byCat[c.value])}원</dd></div>`)}</dl>
  </div>
</section>

<section class="section" aria-labelledby="exp-list-title">
  ${sectionHead('exp-list-title', '청구 내역', html`<span class="section-aside">${rows.length}건</span>`)}
  ${rows.length
    ? html`<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col" style="width:156px">사용일</th><th scope="col" style="width:100px">분류</th><th scope="col">사용처</th><th scope="col" class="ta-r" style="width:120px">금액</th><th scope="col" class="col-gap" style="width:132px">상태</th><th scope="col" class="ta-r" style="width:120px">청구일</th></tr></thead>
      <tbody>${rows.map(
        (e) => html`<tr data-href="/expenses/${e.id}">
          <td>${data.dateW(e.used_on)}</td>
          <td class="cell-muted">${data.categoryLabel(e.category)}</td>
          <td><a class="cell-link" href="/expenses/${e.id}">${e.merchant}</a>${e.memo ? html`<span class="cell-sub">${e.memo}</span>` : ''}</td>
          <td class="ta-r cell-strong">${data.fmtWon(e.amount)}원</td>
          <td class="col-gap">${status(e.status)}</td>
          <td class="ta-r cell-muted">${fmtDot(e.created_at.slice(0, 10))}</td>
        </tr>`,
      )}</tbody></table></div>`
    : emptyState({ title: '청구한 경비가 없어요' })}
</section>`;

  return ctx.send(200, layout(ctx, { title: '경비', nav: 'expenses', crumbs: [{ label: '경비' }], body }));
}

function receiptField(error) {
  const describedBy = error ? 'receipt-error' : 'receipt-hint';
  return html`<div class="field${error ? ' has-error' : ''}">
  <div class="label-row"><label class="label" for="receipt">영수증</label><span class="label-opt">선택</span></div>
  <div class="dropzone" data-dropzone>
    <input class="dropzone-input" id="receipt" name="receipt" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" aria-describedby="${describedBy}"${error ? html` aria-invalid="true"` : ''}>
    <div class="dropzone-ui" aria-hidden="true">
      ${icon('upload', { size: 18 })}
      <span class="dropzone-text"><strong data-file-name>영수증 파일 선택</strong><span id="receipt-hint">JPG, PNG, PDF · 10MB 이하</span></span>
    </div>
  </div>
  ${error ? html`<p class="field-error" id="receipt-error">${error}</p>` : ''}
</div>`;
}

function newForm(ctx, { values = {}, errors = {}, status: code = 200 } = {}) {
  const u = ctx.user;
  const approver = data.approverFor(u);
  const month = monthOf(TODAY);
  const sum = data.expenseSummary(u.id, month);
  const digits = String(values.amountRaw || '').replace(/[,\s원₩]/g, '');
  const amount = /^\d+$/.test(digits) ? Number(digits) : 0;
  const body = html`
${pageHead({ title: '경비 청구', desc: '사용한 비용과 영수증을 올리면 결재자에게 바로 전달돼요.', id: 'expense-form-title' })}
${errorSummary(errors)}
<form class="form-layout" method="post" action="/expenses/new" enctype="multipart/form-data" novalidate aria-labelledby="expense-form-title" data-expense-form data-month-total="${sum.total}">
  <div class="form-main">
    <div class="field-row">
      ${textField({ id: 'used-on', name: 'used_on', label: '사용일', value: values.usedOn, placeholder: 'YYYY-MM-DD', error: errors.usedOn, maxlength: 10 })}
      ${textField({ id: 'amount', name: 'amount', label: '금액', value: values.amountRaw, placeholder: '0', error: errors.amount, inputmode: 'numeric', suffix: '원', maxlength: 12 })}
    </div>
    ${radioChips({ id: 'category', name: 'category', label: '분류', value: values.category, options: data.EXPENSE_CATEGORIES, error: errors.category })}
    ${textField({ id: 'merchant', name: 'merchant', label: '사용처', value: values.merchant, placeholder: '예: 한상 차림 을지로점', error: errors.merchant, maxlength: 60 })}
    <div class="field-row field-row-top">
      ${textArea({ id: 'memo', name: 'memo', label: '메모', value: values.memo, placeholder: '예: 마케팅팀 주간 회의 점심 (5명)', error: errors.memo, rows: 3, maxlength: 200 })}
      ${receiptField(errors.receipt)}
    </div>
  </div>
  <div class="form-side">
    <div class="summary">
      <h2 class="summary-title">${Number(month.slice(5))}월 청구 요약</h2>
      <dl class="summary-list" aria-live="polite">
        <div><dt>이번 달 청구 합계</dt><dd>${data.fmtWon(sum.total)}원</dd></div>
        <div><dt>이번 청구</dt><dd><span data-expense-amount>${data.fmtWon(amount)}원</span></dd></div>
        <div class="summary-total"><dt>청구 후 합계</dt><dd><span data-expense-after>${data.fmtWon(sum.total + amount)}원</span></dd></div>
      </dl>
    </div>
    ${approverNote(approver)}
  </div>
  <div class="form-foot">
    <a class="btn btn-secondary" href="/expenses">취소</a>
    <button type="submit" class="btn btn-primary">청구하기</button>
  </div>
</form>`;
  return ctx.send(code, layout(ctx, { title: '경비 청구', nav: 'expenses', crumbs: [{ label: '경비', href: '/expenses' }, { label: '경비 청구' }], body }));
}

export const expenseNew = (ctx) => newForm(ctx);

export function expenseCreate(ctx) {
  const b = ctx.body;
  const values = {
    usedOn: String(b.used_on || '').trim(),
    category: b.category || '',
    amountRaw: String(b.amount || '').trim(),
    merchant: String(b.merchant || '').trim(),
    memo: String(b.memo || '').trim(),
  };
  const errors = {};
  if (!values.usedOn) errors.usedOn = '사용일을 입력해 주세요.';
  else if (!isValidDate(values.usedOn)) errors.usedOn = '날짜를 YYYY-MM-DD 형식으로 입력해 주세요.';
  else if (values.usedOn > TODAY) errors.usedOn = '아직 오지 않은 날짜예요.';
  else if (diffDays(values.usedOn, TODAY) > 90) errors.usedOn = '90일이 지난 경비는 청구할 수 없어요.';
  if (!data.EXPENSE_CATEGORIES.some((c) => c.value === values.category)) errors.category = '분류를 선택해 주세요.';
  const digits = values.amountRaw.replace(/[,\s원₩]/g, '');
  if (!digits) errors.amount = '금액을 입력해 주세요.';
  else if (!/^\d+$/.test(digits) || Number(digits) <= 0) errors.amount = '금액은 숫자로만 입력해 주세요.';
  else if (Number(digits) > 10_000_000) errors.amount = '1,000만 원 넘는 경비는 구매 품의서로 올려 주세요.';
  if (!values.merchant) errors.merchant = '사용처를 입력해 주세요.';
  const file = ctx.files.receipt;
  if (file) {
    if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.type)) errors.receipt = 'JPG, PNG, WEBP, PDF 파일만 올릴 수 있어요.';
    else if (file.data.length > 10 * 1024 * 1024) errors.receipt = '10MB 이하 파일만 올릴 수 있어요.';
  }
  if (Object.keys(errors).length) {
    if (file && !errors.receipt) errors.receipt = '보안을 위해 영수증 파일을 다시 선택해 주세요.';
    return newForm(ctx, { values, errors, status: 422 });
  }
  data.createExpense(ctx.user, { ...values, amount: Number(digits), file });
  ctx.redirect('/expenses', { flash: '경비 청구가 접수됐어요. 결재가 끝나면 알려드릴게요.' });
}

export function expenseDetail(ctx, id) {
  const e = data.getExpense(id);
  if (!e || e.user_id !== ctx.user.id) return ctx.notFound();
  const row = (k, v) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`;
  const isImage = e.receipt_type && e.receipt_type.startsWith('image/');
  const body = html`
${pageHead({
  eyebrow: '경비 상세',
  title: e.merchant,
  meta: html`<p class="head-meta">${status(e.status)}<span class="dot-sep" aria-hidden="true"></span><span>${data.dateW(e.used_on)}</span><span class="dot-sep" aria-hidden="true"></span><span>${data.categoryLabel(e.category)}</span></p>`,
  actions: html`<a class="btn btn-secondary" href="/expenses">목록으로</a>`,
})}
<div class="detail-layout">
  <section class="section" aria-labelledby="exp-info-title">
    ${sectionHead('exp-info-title', '청구 정보', e.doc ? moreLink(`/approvals/${e.doc.id}`, '결재 문서 보기') : '')}
    <p class="amount-line"><span>청구 금액</span><strong>${data.fmtWon(e.amount)}<small>원</small></strong></p>
    <dl class="kv">
      ${row('사용일', data.dateW(e.used_on))}
      ${row('분류', data.categoryLabel(e.category))}
      ${row('사용처', e.merchant)}
      ${row('메모', e.memo || '—')}
      ${row('결재자', person({ id: e.approver_id, name: e.approver_name }, { size: 24, aside: `${e.approver_dept} ${e.approver_title}` }))}
      ${row('처리 상태', html`${status(e.status)}${e.decided_at ? html`<span class="kv-aside">${fmtStamp(e.decided_at)}</span>` : ''}`)}
      ${e.decision_note ? row('반려 사유', e.decision_note) : ''}
      ${row('청구일', fmtStamp(e.created_at))}
    </dl>
  </section>
  <section class="section" aria-labelledby="receipt-title">
    ${sectionHead('receipt-title', '영수증', e.receipt_size ? html`<a class="more-link" href="${receiptUrl(e)}" target="_blank" rel="noopener">원본 보기${icon('chevronRight', { size: 14 })}</a>` : '')}
    ${e.receipt_size
      ? isImage
        ? html`<div class="receipt-frame"><img src="${receiptUrl(e)}" alt="${e.merchant} 영수증" width="240" height="340"></div><p class="file-line">${icon('paperclip', { size: 15 })}<span>${e.receipt_name}</span><span class="file-size">${Math.max(1, Math.round(e.receipt_size / 1024))}KB</span></p>`
        : html`<a class="file-link" href="${receiptUrl(e)}" target="_blank" rel="noopener">${icon('file', { size: 15 })}${e.receipt_name}</a>`
      : emptyState({ title: '첨부한 영수증이 없어요' })}
  </section>
</div>`;
  return ctx.send(200, layout(ctx, { title: '경비 상세', nav: 'expenses', crumbs: [{ label: '경비', href: '/expenses' }, { label: '경비 상세' }], body }));
}

export function expenseReceipt(ctx, id) {
  const r = data.expenseReceipt(id);
  if (!r?.receipt) return ctx.notFound();
  ctx.res.writeHead(200, {
    'Content-Type': r.receipt_type || 'application/octet-stream',
    'Content-Length': r.receipt.length,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.receipt_name || 'receipt')}`,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  ctx.res.end(Buffer.from(r.receipt));
}
