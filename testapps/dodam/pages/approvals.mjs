// Approvals inbox (received / sent / done) and the document view.
import { layout, html, icon, status, kindLabel, pageHead, sectionHead, avatar, person, dialog, dialogButton, textArea, emptyState } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { TODAY, addDays, relTime, fmtStamp, fmtStampShort } from '../lib/dates.mjs';

const TABS = [
  { key: 'received', href: '/approvals', label: '받은 결재' },
  { key: 'sent', href: '/approvals/sent', label: '보낸 결재' },
  { key: 'done', href: '/approvals/done', label: '완료' },
];
const TITLES = { received: '받은 결재', sent: '보낸 결재', done: '완료된 결재' };

export function approvalsList(ctx, tab) {
  const u = ctx.user;
  const received = data.approvalsReceived(u.id);
  const sent = data.approvalsSent(u.id);
  const done = data.approvalsDone(u.id);
  const rows = { received, sent, done }[tab];
  const counts = { received: received.length };
  const since = addDays(TODAY, -30);
  const recent = done.filter((d) => d.my_acted_at.slice(0, 10) >= since);
  const inFlight = sent.filter((d) => d.status === 'pending');
  const oldest = received[received.length - 1];

  const statusCell = (d) => {
    if (tab === 'done') return status(d.my_action, d.my_action === 'approved' ? '승인함' : '반려함');
    if (tab === 'sent' && d.status === 'pending') return status('pending', '결재 중');
    return status(d.status);
  };
  const dateCell = (d) => (tab === 'done' ? fmtStampShort(d.my_acted_at) : relTime(d.drafted_at));
  const personCell = (d) => {
    if (tab === 'sent') {
      const a = data.lastApprover(d.id);
      return person({ id: a.user_id, name: a.name }, { size: 28, sub: `${a.dept} · ${a.title}` });
    }
    return person({ id: d.drafter_id, name: d.drafter_name }, { size: 28, sub: `${d.drafter_dept} · ${d.drafter_title}` });
  };
  const tabNote = {
    received: oldest ? `가장 오래된 문서 ${relTime(oldest.drafted_at)}` : '모두 처리했어요',
    sent: `결재 중 ${inFlight.length}건`,
    done: `최근 30일 승인 ${recent.filter((d) => d.my_action === 'approved').length}건 · 반려 ${recent.filter((d) => d.my_action === 'rejected').length}건`,
  }[tab];

  const empty = {
    received: ['결재할 문서가 없어요', '새 문서가 올라오면 알림으로 알려드릴게요.'],
    sent: ['보낸 문서가 없어요', '휴가나 경비를 신청하면 여기에 모여요.'],
    done: ['처리한 문서가 없어요', '승인하거나 반려한 문서가 여기에 쌓여요.'],
  }[tab];

  const body = html`
${pageHead({ title: '결재함', desc: '결재할 문서와 내가 올린 문서를 한곳에서 확인하세요.' })}
<div class="tabs-row">
  <nav class="tabs" aria-label="결재함 탭">
    ${TABS.map((t) => html`<a class="tab${t.key === tab ? ' is-active' : ''}" href="${t.href}"${t.key === tab ? html` aria-current="page"` : ''}>${t.label}${counts[t.key] ? html`<span class="tab-count" aria-hidden="true">${counts[t.key]}</span>` : ''}</a>`)}
  </nav>
  <span class="tabs-note">${tabNote}</span>
</div>
<section class="section section-flush" aria-label="${TITLES[tab]} 목록">
  ${rows.length
    ? html`<div class="table-wrap"><table class="table table-docs">
      <thead><tr><th scope="col" class="col-kind">문서 종류</th><th scope="col">제목</th><th scope="col" class="col-person">${tab === 'sent' ? '결재자' : '기안자'}</th><th scope="col" class="col-date">${tab === 'done' ? '처리일' : '기안일'}</th><th scope="col" class="col-status">${tab === 'done' ? '처리' : '상태'}</th></tr></thead>
      <tbody>${rows.map(
        (d) => html`<tr data-href="/approvals/${d.id}">
          <td class="cell-muted">${kindLabel(d.kind)}</td>
          <td><a class="cell-link" href="/approvals/${d.id}">${d.title}</a><span class="cell-sub">${d.doc_no}</span></td>
          <td>${personCell(d)}</td>
          <td class="cell-muted cell-nowrap">${dateCell(d)}</td>
          <td>${statusCell(d)}</td>
        </tr>`,
      )}</tbody></table></div>`
    : emptyState({ title: empty[0], desc: empty[1] })}
</section>`;

  return ctx.send(200, layout(ctx, { title: TITLES[tab], nav: 'approvals', crumbs: [{ label: '결재' }], body }));
}

function docBody(doc) {
  const b = doc.body || {};
  const parts = [];
  if (b.fields?.length) {
    parts.push(html`<dl class="kv kv-doc">${b.fields.map(([k, v]) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`);
  }
  if (b.items?.length) {
    const total = b.items.reduce((s, it) => s + it.qty * it.price, 0);
    parts.push(html`<h3 class="sub-title">구매 품목</h3>
    <div class="table-wrap"><table class="table table-compact table-items">
      <thead><tr><th scope="col">품명</th><th scope="col">규격</th><th scope="col" class="ta-r">수량</th><th scope="col" class="ta-r">단가</th><th scope="col" class="ta-r">금액</th></tr></thead>
      <tbody>${b.items.map((it) => html`<tr><td class="cell-strong">${it.name}</td><td class="cell-muted">${it.spec || '—'}</td><td class="ta-r">${it.qty}</td><td class="ta-r">${data.fmtWon(it.price)}원</td><td class="ta-r">${data.fmtWon(it.qty * it.price)}원</td></tr>`)}</tbody>
      <tfoot><tr><th scope="row" colspan="4">합계</th><td class="ta-r">${data.fmtWon(total)}원</td></tr></tfoot>
    </table></div>`);
  }
  if (b.note) parts.push(html`<p class="doc-note">${b.note}</p>`);
  if (b.attachments?.length) {
    parts.push(html`<h3 class="sub-title">첨부 파일</h3><ul class="files">${b.attachments.map(
      (a) => html`<li>${a.expenseId ? html`<a class="file-link" href="/expenses/${a.expenseId}/receipt/${encodeURIComponent(a.name)}" target="_blank" rel="noopener">${icon('paperclip', { size: 15 })}${a.name}</a>` : html`<span class="file-link">${icon('paperclip', { size: 15 })}${a.name}</span>`}</li>`,
    )}</ul>`);
  }
  return parts;
}

// Visual state of each approval step and how its role reads in that state.
const STEP_STATE = {
  drafted: ['done', () => '기안'],
  approved: ['done', (role) => `${role} 완료`],
  rejected: ['failed', () => '반려'],
  pending: ['current', (role) => `${role} 대기`],
  waiting: ['todo', (role) => `${role} 예정`],
  skipped: ['todo', () => '—'],
  withdrawn: ['todo', () => '회수'],
};

function approvalLine(doc) {
  const ico = { done: 'check', failed: 'x' };
  return html`<ol class="steps steps-line">${doc.steps.map((s) => {
    const [state, label] = STEP_STATE[s.status] || ['todo', () => s.status];
    return html`<li class="step is-${state}">
      <span class="step-mark">${ico[state] ? icon(ico[state], { size: 12, stroke: 2.4 }) : ''}</span>
      <div class="step-body">
        ${person({ id: s.user_id, name: s.name }, { size: 24, aside: `${s.dept} ${s.title || ''}` })}
        <p class="step-meta"><span class="step-state">${label(s.role)}</span>${s.acted_at ? ` · ${fmtStampShort(s.acted_at)}` : ''}</p>
      </div>
    </li>`;
  })}</ol>`;
}

function render(ctx, id, { rejectError, rejectValue, status: code = 200 } = {}) {
  const u = ctx.user;
  const doc = data.getDoc(id);
  if (!doc || !data.canView(doc, u)) return ctx.notFound();
  const step = data.currentStep(doc);
  const canAct = doc.status === 'pending' && step?.user_id === u.id;
  const comments = doc.steps.filter((s) => s.comment);
  const statusLabel = doc.status === 'pending' ? status('pending', canAct ? '내 결재 차례' : step ? `${step.name} 결재 대기` : '대기', { cls: 'doc-status' }) : status(doc.status, null, { cls: 'doc-status' });
  const prop = (k, v) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`;

  const actions = canAct
    ? html`<div class="page-actions">
        ${dialogButton('reject-dialog', '반려', { cls: 'btn btn-danger-quiet' })}
        <form method="post" action="/approvals/${doc.id}" class="inline-form"><input type="hidden" name="intent" value="approve"><button type="submit" class="btn btn-primary">승인</button></form>
      </div>`
    : '';

  const body = html`
<div class="page-head doc-head">
  <div class="page-head-text">
    <p class="eyebrow">${kindLabel(doc.kind)}<span class="dot-sep" aria-hidden="true"></span>${doc.doc_no}</p>
    <h1 id="doc-title">${doc.title}</h1>
    <p class="head-meta">${statusLabel}<span class="dot-sep" aria-hidden="true"></span><span>${doc.drafter_name} 기안</span><span class="dot-sep" aria-hidden="true"></span><span>${fmtStamp(doc.drafted_at)}</span></p>
  </div>
  ${actions}
</div>

<div class="doc-layout">
  <section class="doc-main" aria-labelledby="doc-body-title">
    ${sectionHead('doc-body-title', '문서 내용')}
    <div class="doc-content">${docBody(doc)}</div>
  </section>
  <div class="doc-side">
    <section aria-labelledby="doc-info-title">
      ${sectionHead('doc-info-title', '문서 정보')}
      <dl class="kv kv-props">
        ${prop('문서 번호', doc.doc_no)}
        ${prop('기안자', person({ id: doc.drafter_id, name: doc.drafter_name }, { size: 22, aside: `${doc.drafter_dept} ${doc.drafter_title}` }))}
        ${prop('기안일', fmtStamp(doc.drafted_at))}
        ${doc.closed_at ? prop('완료일', fmtStamp(doc.closed_at)) : ''}
      </dl>
    </section>
    <section aria-labelledby="aline-title">
      ${sectionHead('aline-title', '결재선', html`<span class="section-aside">${doc.steps.length}단계</span>`)}
      ${approvalLine(doc)}
    </section>
    <section aria-labelledby="comments-title">
      ${sectionHead('comments-title', '결재 의견')}
      ${comments.length
        ? html`<ul class="comments">${comments.map(
            (c) => html`<li class="comment">${avatar({ id: c.user_id, name: c.name }, 28)}<div class="comment-body"><p class="comment-head"><strong>${c.name}</strong><span>${c.role} · ${fmtStampShort(c.acted_at)}</span>${c.status === 'rejected' ? html`<span class="comment-flag">반려 사유</span>` : ''}</p><p class="comment-text">${c.comment}</p></div></li>`,
          )}</ul>`
        : html`<p class="quiet-note">아직 남겨진 의견이 없어요.</p>`}
    </section>
  </div>
</div>`;

  const rejectDialog = canAct
    ? dialog({
        id: 'reject-dialog',
        title: '문서 반려',
        desc: `‘${doc.title}’ 문서를 반려해요. 반려 사유는 기안자에게 전달돼요.`,
        action: `/approvals/${doc.id}`,
        hidden: { intent: 'reject' },
        autoOpen: !!rejectError,
        body: textArea({ id: 'reject-reason', name: 'reason', label: '반려 사유', value: rejectValue, placeholder: '예: 견적서를 한 곳 더 받아서 첨부해 주세요.', error: rejectError, rows: 4, maxlength: 300, autofocus: true }),
        foot: html`<button type="button" class="btn btn-secondary" data-dialog-close>취소</button><button type="submit" class="btn btn-danger">반려하기</button>`,
      })
    : '';

  return ctx.send(code, layout(ctx, { title: doc.title, nav: 'approvals', crumbs: [{ label: '결재', href: '/approvals' }, { label: '문서 상세' }], body, dialogs: [rejectDialog] }));
}

export const approvalDetail = (ctx, id) => render(ctx, id);

export function approvalPost(ctx, id) {
  const u = ctx.user;
  const doc = data.getDoc(id);
  if (!doc || !data.canView(doc, u)) return ctx.notFound();
  const step = data.currentStep(doc);
  if (doc.status !== 'pending' || step?.user_id !== u.id) {
    return ctx.redirect(`/approvals/${id}`, { flash: '이미 처리됐거나 결재 차례가 아닌 문서예요.', tone: 'error' });
  }
  if (ctx.body.intent === 'approve') {
    data.approveDoc(doc, u);
    return ctx.redirect(`/approvals/${id}`, { flash: '승인했어요' });
  }
  if (ctx.body.intent === 'reject') {
    const reason = String(ctx.body.reason || '').trim();
    if (!reason) return render(ctx, id, { rejectError: '반려 사유를 입력해 주세요.', rejectValue: reason, status: 422 });
    data.rejectDoc(doc, u, reason);
    return ctx.redirect(`/approvals/${id}`, { flash: '반려했어요' });
  }
  ctx.redirect(`/approvals/${id}`);
}
