// Search results and error pages.
import { layout, html, icon, status, kindLabel, pageHead, sectionHead, avatar, emptyState } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { relTime, fmtDot } from '../lib/dates.mjs';

export function searchPage(ctx) {
  const q = String(ctx.query.get('q') || '').trim();
  const res = q ? data.search(ctx.user, q) : { members: [], docs: [], notices: [] };
  const total = res.members.length + res.docs.length + res.notices.length;
  let n = 0;
  const group = (title, count, items) => {
    const id = `result-group-${++n}`;
    return html`<section class="section search-group" aria-label="${title} 검색 결과">${sectionHead(id, title, html`<span class="section-aside">${count}건</span>`)}<ul class="result-list">${items}</ul></section>`;
  };

  const body = html`
${pageHead({ title: q ? `‘${q}’ 검색 결과` : '검색', desc: q ? `구성원, 결재 문서, 공지사항에서 ${total}건을 찾았어요.` : '위의 검색 버튼을 눌러 찾고 싶은 내용을 입력하세요.' })}
<form class="search-bar" method="get" action="/search" role="search" aria-label="다시 검색">
  <label class="sr-only" for="search-page-q">검색어</label>
  <div class="input-wrap has-icon">${icon('search', { size: 16, cls: 'ico input-icon' })}<input class="input" id="search-page-q" name="q" value="${q}" placeholder="예: 연말정산, 김하늘" autocomplete="off"></div>
  <button type="submit" class="btn btn-primary">찾기</button>
</form>
${q && !total ? emptyState({ title: '검색 결과가 없어요', desc: '다른 검색어로 다시 찾아보세요.' }) : ''}
${res.members.length
  ? group('구성원', res.members.length, res.members.map((m) => html`<li class="result-item" data-href="/members/${m.id}">${avatar(m, 28)}<span class="result-text"><a href="/members/${m.id}">${m.name}</a><span class="result-sub">${m.dept}${m.title ? ` · ${m.title}` : ''} · ${m.email}</span></span>${status(m.status)}</li>`))
  : ''}
${res.docs.length
  ? group('결재 문서', res.docs.length, res.docs.map((d) => html`<li class="result-item" data-href="/approvals/${d.id}"><span class="result-text"><a href="/approvals/${d.id}">${d.title}</a><span class="result-sub">${kindLabel(d.kind)} · ${d.drafter_name} · ${relTime(d.drafted_at)}</span></span>${status(d.status)}</li>`))
  : ''}
${res.notices.length
  ? group('공지사항', res.notices.length, res.notices.map((n) => html`<li class="result-item" data-href="/notices/${n.id}"><span class="result-text"><a href="/notices/${n.id}">${n.title}</a><span class="result-sub">${n.author_name} · ${fmtDot(n.created_at.slice(0, 10))}</span></span></li>`))
  : ''}`;
  return ctx.send(200, layout(ctx, { title: q ? `${q} 검색` : '검색', nav: null, crumbs: [{ label: '검색' }], body }));
}

export function notFoundPage(ctx) {
  const body = html`<section class="not-found" aria-labelledby="nf-title">
  <p class="nf-code">404</p>
  <h1 id="nf-title">페이지를 찾을 수 없어요</h1>
  <p class="page-desc">주소가 바뀌었거나 삭제된 페이지예요. 왼쪽 메뉴에서 원하는 화면으로 이동해 주세요.</p>
  <a class="btn btn-primary" href="/">홈으로 가기</a>
</section>`;
  return ctx.send(404, layout(ctx, { title: '페이지를 찾을 수 없어요', nav: null, crumbs: [{ label: '페이지 없음' }], body }));
}
