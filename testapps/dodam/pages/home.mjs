// Home: what needs doing today, my own status, the team's next two weeks and
// one piece of company news.
import { layout, html, icon, avatar, kindLabel, sectionHead, moreLink, emptyState } from '../lib/ui.mjs';
import * as data from '../lib/data.mjs';
import { L } from '../labels.mjs';
import { TODAY, addDays, parseDate, weekday, fmtLongDay, fmtMonthDay, fmtShort, relTime, monthOf } from '../lib/dates.mjs';

const FIELD_LABEL = { in: '출근', out: '퇴근' };

// One short fact about a document for its row: days, amount or place.
function docFact(d) {
  if (d.ref_type === 'leave') return data.fmtDays(data.getLeave(d.ref_id)?.days ?? 0);
  if (d.ref_type === 'expense') return `${data.fmtWon(data.getExpense(d.ref_id)?.amount)}원`;
  const body = JSON.parse(d.body || '{}');
  if (body.items?.length) return `${data.fmtWon(body.items.reduce((s, it) => s + it.qty * it.price, 0))}원`;
  return Object.fromEntries(body.fields || [])['출장지'] || '';
}

function todoRow({ href, who, title, meta, when, action }) {
  return html`<li class="todo" data-href="${href}">
  ${avatar(who, 36)}
  <div class="todo-main">
    <a class="todo-title" href="${href}">${title}</a>
    <p class="todo-meta">${meta.filter(Boolean).join(' · ')}</p>
  </div>
  <span class="todo-when">${when}</span>
  <a class="todo-action" href="${href}" tabindex="-1" aria-hidden="true">${action}${icon('chevronRight', { size: 14 })}</a>
</li>`;
}

function todoGroup(caption, rows) {
  if (!rows.length) return '';
  return html`<div class="todo-group"><h3 class="group-caption">${caption}<span class="group-count">${rows.length}</span></h3><ul class="todo-list">${rows}</ul></div>`;
}

export function homePage(ctx) {
  const u = ctx.user;
  const today = data.attendanceOn(u.id, TODAY);
  const bal = data.leaveBalance(u);
  const exp = data.expenseSummary(u.id, monthOf(TODAY));
  const received = data.approvalsReceived(u.id);
  const waiting = data.approvalsSent(u.id).filter((d) => d.status === 'pending');
  const corrections = data.myCorrections(u.id).filter((c) => c.status === 'pending');
  const news = data.featuredNotice();

  const toApprove = received.map((d) =>
    todoRow({
      href: `/approvals/${d.id}`,
      who: { id: d.drafter_id, name: d.drafter_name },
      title: d.title,
      meta: [d.drafter_name, kindLabel(d.kind), docFact(d)],
      when: relTime(d.drafted_at),
      action: '결재하기',
    }),
  );
  const mine = [
    ...waiting.map((d) => {
      const a = data.currentApprover(d.id);
      return todoRow({
        href: `/approvals/${d.id}`,
        who: a ? { id: a.user_id, name: a.name } : u,
        title: d.title,
        meta: [a ? `${a.name} ${a.title} 결재 대기` : '결재 대기', kindLabel(d.kind), docFact(d)],
        when: relTime(d.drafted_at),
        action: '진행 보기',
      });
    }),
    ...corrections.map((c) =>
      todoRow({
        href: '/attendance',
        who: u,
        title: `근무 기록 정정 요청 (${fmtShort(c.work_date)} ${FIELD_LABEL[c.field]})`,
        meta: ['경영지원팀 확인 대기', `${c.time}로 정정`],
        when: relTime(c.created_at),
        action: '내역 보기',
      }),
    ),
  ];

  let clock = '출근 기록 없음';
  if (today?.status === 'vacation') clock = '휴가';
  else if (today?.clock_in) clock = today.clock_out ? `${today.clock_in} – ${today.clock_out}` : `${today.clock_in} · 근무 중`;

  // Team leave and company events for this week and the next (weeks start on Monday).
  const monday = addDays(TODAY, -((parseDate(TODAY).getUTCDay() + 6) % 7));
  const nextMonday = addDays(monday, 7);
  const schedule = data.upcoming(u, 20).filter((s) => s.date < addDays(nextMonday, 7));
  const schedRow = (s) => {
    const isToday = s.date <= TODAY && (s.end || s.date) >= TODAY;
    const span = s.end && s.end !== s.date ? `${fmtShort(s.date)}–${fmtShort(s.end).replace(/^\d+\//, '')}` : fmtShort(s.date);
    let note = s.kind === 'event' ? s.detail.split(' · ')[0] : s.detail.split(' · ').pop();
    if (s.pending) note = '결재 대기';
    if (isToday) note = '오늘';
    return html`<li class="sched${isToday ? ' is-today' : ''}"><span class="sched-date">${span} ${weekday(s.date)}</span><span class="sched-title">${s.title}</span><span class="sched-note">${note}</span></li>`;
  };

  const body = html`
<div class="page-head">
  <div class="page-head-text">
    <p class="eyebrow">${fmtLongDay(TODAY)}</p>
    <h1>안녕하세요, ${u.name}님</h1>
  </div>
  <div class="page-actions">
    <a class="btn btn-secondary" href="/expenses/new">경비 청구</a>
    <a class="btn btn-primary" href="/leave/new">${L.leaveNewButton}</a>
  </div>
</div>

<div class="home-grid">
  <section class="home-todo" aria-labelledby="home-todo-title">
    ${sectionHead('home-todo-title', '오늘 처리할 일', moreLink('/approvals', '결재함 보기'))}
    ${toApprove.length || mine.length
      ? html`${todoGroup('결재할 문서', toApprove)}${todoGroup('내가 올린 요청', mine)}`
      : emptyState({ title: '오늘 처리할 일을 모두 마쳤어요', desc: '새 결재 요청이 오면 여기에 모여요.' })}
  </section>

  <div class="home-side">
    <section aria-labelledby="home-me-title">
      ${sectionHead('home-me-title', '내 현황')}
      <dl class="facts">
        <div class="fact" data-href="/attendance"><dt>오늘 출근</dt><dd>${clock}</dd></div>
        <div class="fact" data-href="/leave"><dt>남은 연차</dt><dd>${data.fmtDays(bal.remaining)}<span class="fact-sub"> / ${data.fmtDays(bal.total)}</span></dd></div>
        <div class="fact" data-href="/expenses"><dt>이번 달 경비</dt><dd>${data.fmtWon(exp.total)}원<span class="fact-sub"> · ${exp.count}건</span></dd></div>
      </dl>
    </section>

    <section aria-labelledby="home-team-title">
      ${sectionHead('home-team-title', '팀 일정', html`<span class="section-aside">이번 주 · 다음 주</span>`)}
      ${schedule.length ? html`<ul class="sched-list">${schedule.map(schedRow)}</ul>` : html`<p class="sched-empty">예정된 일정이 없어요</p>`}
    </section>

    ${news
      ? html`<section aria-labelledby="home-news-title">
      ${sectionHead('home-news-title', '회사 소식', moreLink('/notices', '공지 전체 보기'))}
      <div class="news" data-href="/notices/${news.id}">
        ${news.photo ? html`<img class="news-photo" src="/static/img/${news.photo}-800.jpg" alt="" width="800" height="533">` : ''}
        <a class="news-title" href="/notices/${news.id}">${news.title}</a>
        <p class="news-meta">${news.author_name} · ${fmtMonthDay(news.created_at.slice(0, 10))}</p>
      </div>
    </section>`
      : ''}
  </div>
</div>`;

  return ctx.send(200, layout(ctx, { title: '홈', nav: 'home', crumbs: [{ label: '홈' }], body }));
}
