// Notices: list, compose, read.
import { layout, html, pageHead, avatar, textField, textArea, switchRow, errorSummary, emptyState } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { fmtDot, fmtStamp } from '../lib/dates.mjs';

// First sentence-ish line of a notice for the list (bullet lines skipped).
function excerpt(text) {
  const line = String(text).split('\n').find((l) => l.trim() && !/^\s*-\s+/.test(l)) || '';
  return line.trim();
}

export function noticeList(ctx) {
  const rows = data.listNotices(50);
  const body = html`
${pageHead({
  title: '공지사항',
  desc: '회사 소식과 꼭 알아야 할 안내를 확인하세요.',
  actions: html`<a class="btn btn-primary" href="/notices/new">공지 작성</a>`,
})}
<section class="section section-flush" aria-label="공지 목록">
  ${rows.length
    ? html`<ul class="notice-list">${rows.map(
        (n) => html`<li class="notice-row${n.pinned ? ' is-pinned' : ''}" data-href="/notices/${n.id}">
          <div class="notice-main">
            <p class="notice-title">${n.pinned ? html`<span class="notice-flag">고정</span>` : ''}<a href="/notices/${n.id}">${n.title}</a></p>
            <p class="notice-excerpt">${excerpt(n.body)}</p>
            <p class="notice-meta"><span>${n.author_name}</span><span>${n.author_dept}</span><span>${fmtDot(n.created_at.slice(0, 10))}</span><span>조회 ${n.views}</span></p>
          </div>
          ${n.photo ? html`<img class="notice-thumb" src="/static/img/${n.photo}-800.jpg" alt="" width="800" height="533">` : ''}
        </li>`,
      )}</ul>`
    : emptyState({ title: '아직 공지가 없어요' })}
</section>`;
  return ctx.send(200, layout(ctx, { title: '공지사항', nav: 'notices', crumbs: [{ label: '공지사항' }], body }));
}

function newForm(ctx, { values = {}, errors = {}, status = 200 } = {}) {
  const body = html`
<div class="narrow">
  ${pageHead({ title: '공지 작성', desc: '작성한 공지는 모든 구성원에게 알림으로 전달돼요.', id: 'notice-form-title' })}
  ${errorSummary(errors)}
  <form class="form-stack" method="post" action="/notices/new" novalidate aria-labelledby="notice-form-title">
    ${textField({ id: 'notice-title', name: 'title', label: '제목', value: values.title, placeholder: '예: 12월 송년회 일정 안내', error: errors.title, maxlength: 60 })}
    ${textArea({ id: 'notice-body', name: 'body', label: '내용', value: values.body, placeholder: '구성원에게 알릴 내용을 적어 주세요. 줄 앞에 - 를 붙이면 목록으로 보여요.', error: errors.body, rows: 9, maxlength: 3000 })}
    <div class="switch-list">${switchRow({ id: 'notice-pinned', name: 'pinned', label: '상단 고정', desc: '공지 목록 맨 위에 계속 보여요.', checked: values.pinned === '1' })}</div>
    <div class="form-foot">
      <a class="btn btn-secondary" href="/notices">취소</a>
      <button type="submit" class="btn btn-primary">게시하기</button>
    </div>
  </form>
</div>`;
  return ctx.send(status, layout(ctx, { title: '공지 작성', nav: 'notices', crumbs: [{ label: '공지사항', href: '/notices' }, { label: '공지 작성' }], body }));
}

export const noticeNew = (ctx) => newForm(ctx);

export function noticeCreate(ctx) {
  const values = { title: String(ctx.body.title || '').trim(), body: String(ctx.body.body || '').trim(), pinned: ctx.body.pinned === '1' ? '1' : '0' };
  const errors = {};
  if (!values.title) errors.title = '제목을 입력해 주세요.';
  if (!values.body) errors.body = '내용을 입력해 주세요.';
  if (Object.keys(errors).length) return newForm(ctx, { values, errors, status: 422 });
  data.createNotice(ctx.user, { title: values.title, body: values.body, pinned: values.pinned === '1' });
  ctx.redirect('/notices', { flash: '공지를 게시했어요' });
}

// Plain text -> paragraphs and bullet lists ("- " lines).
function renderBody(text) {
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length && lines.every((l) => /^\s*-\s+/.test(l))) {
      return html`<ul>${lines.map((l) => html`<li>${l.replace(/^\s*-\s+/, '')}</li>`)}</ul>`;
    }
    return html`<p>${lines.map((l, i) => html`${i ? html`<br>` : ''}${l}`)}</p>`;
  });
}

export function noticeDetail(ctx, id) {
  const n = data.getNotice(id);
  if (!n) return ctx.notFound();
  const body = html`
<article class="article" aria-labelledby="notice-title">
  <header class="article-head">
    <p class="eyebrow">공지사항${n.pinned ? html`<span class="dot-sep" aria-hidden="true"></span>상단 고정` : ''}</p>
    <h1 id="notice-title">${n.title}</h1>
    <p class="article-meta"><span class="person">${avatar({ id: n.author_id, name: n.author_name }, 24)}<span class="person-name">${n.author_name}</span><span class="person-aside">${n.author_dept} ${n.author_title}</span></span><span class="dot-sep" aria-hidden="true"></span><span>${fmtStamp(n.created_at)}</span><span class="dot-sep" aria-hidden="true"></span><span>조회 ${n.views}</span></p>
  </header>
  ${n.photo ? html`<img class="article-hero" src="/static/img/${n.photo}-1600.jpg" alt="" width="1600" height="1067">` : ''}
  <div class="article-body">${renderBody(n.body)}</div>
  <footer class="article-foot"><a class="btn btn-secondary" href="/notices">목록으로</a></footer>
</article>`;
  return ctx.send(200, layout(ctx, { title: n.title, nav: 'notices', crumbs: [{ label: '공지사항', href: '/notices' }, { label: '공지 상세' }], body }));
}
