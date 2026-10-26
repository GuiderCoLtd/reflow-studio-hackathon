// Log in and screenshot every screen plus the open states of menus and
// dialogs at 1440x810 @2x into tools/shots/. Read-only: nothing is submitted.
//   node testapps/dodam/tools/shots.mjs [filter]
//   SHOTS_HEIGHT=900 SHOTS_DIR=shots-900 node testapps/dodam/tools/shots.mjs   # the agent's 1440x900 viewport
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { L } from '../labels.mjs';

const BASE = process.env.DODAM_URL || 'http://127.0.0.1:3500';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.SHOTS_DIR || 'shots');
const HEIGHT = Number(process.env.SHOTS_HEIGHT || 810);
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const context = await browser.newContext({ viewport: { width: 1440, height: HEIGHT }, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await context.newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

async function shot(name, url, act, { full = false } = {}) {
  if (filter && !filter.test(name)) return;
  if (url) await page.goto(BASE + url, { waitUntil: 'networkidle' });
  if (act) {
    await act();
    await page.waitForTimeout(260); // let menu/dialog motion (<= 220 ms) settle
  }
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
  const m = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, title: document.title }));
  console.log(`${name.padEnd(28)} ${String(url || '').padEnd(24)} ${m.w > 1440 ? 'H-OVERFLOW ' : ''}h=${m.h}${m.h > HEIGHT ? ' (scrolls)' : ''}  "${m.title}"`);
}

await shot('00-login', '/login');
await page.goto(`${BASE}/login`);
await page.fill('#email', 'demo@dodamwork.test');
await page.fill('#password', 'DemoPass!2026');
await page.click('button[type=submit]');
await page.waitForURL(`${BASE}/`);

await shot('01-home', '/');
await shot('01b-home-notifications', '/', () => page.getByRole('button', { name: '알림' }).click());
await shot('01c-home-profile-menu', '/', () => page.getByRole('button', { name: '김하늘' }).click());
await shot('01d-search-dialog', '/', async () => {
  await page.getByRole('button', { name: '검색' }).click();
  await page.getByLabel('검색어').fill('연말정산');
});
await shot('02-attendance', '/attendance');
await shot('02-attendance-full', '/attendance', null, { full: true });
await shot('02b-correction-modal', '/attendance', async () => {
  await page.getByRole('button', { name: '근무 기록 정정 요청' }).click();
  await page.getByLabel('날짜').fill('2026-11-02');
  await page.getByRole('radio', { name: '출근' }).click();
  await page.getByLabel('정정 시간').fill('08:55');
});
await shot('03-leave', '/leave');
await shot('04-leave-new', '/leave/new');
await shot('04b-leave-new-filled', '/leave/new', async () => {
  await page.getByRole('radio', { name: '연차' }).click();
  await page.getByLabel('시작일').fill('2026-11-12');
  await page.getByLabel('종료일').fill('2026-11-13');
  await page.getByLabel('사유').fill('가족 여행');
});
await shot('04c-leave-new-errors', '/leave/new', async () => {
  await page.getByLabel('시작일').fill('2026/11/12');
  await page.getByRole('button', { name: L.leaveSubmit }).click();
  await page.waitForLoadState('networkidle');
});
await shot('05-leave-detail', '/leave/4');
await shot('05b-leave-detail-rejected', '/leave/1');
await shot('06-approvals', '/approvals');
await shot('06b-approvals-sent', '/approvals/sent');
await shot('06b-approvals-sent-full', '/approvals/sent', null, { full: true });
await shot('06c-approvals-done', '/approvals/done');
const docHref = await (async () => {
  await page.goto(`${BASE}/approvals`);
  return page.getByRole('link', { name: '디자인팀 모니터 구매' }).getAttribute('href');
})();
await shot('07-approval-detail', docHref);
await shot('07-approval-detail-full', docHref, null, { full: true });
await shot('07b-reject-modal', docHref, async () => {
  await page.getByRole('button', { name: '반려' }).click();
  await page.getByLabel('반려 사유').fill('견적서를 한 곳 더 받아서 첨부해 주세요.');
});
const leaveDocHref = await (async () => {
  await page.goto(`${BASE}/approvals`);
  return page.getByRole('link', { name: '연차 휴가 신청 (11/19~11/20)' }).getAttribute('href');
})();
await shot('07c-approval-leave-doc', leaveDocHref);
await shot('08-expenses', '/expenses');
await shot('09-expense-new', '/expenses/new');
await shot('09b-expense-new-filled', '/expenses/new', async () => {
  await page.getByLabel('사용일').fill('2026-11-05');
  await page.getByLabel('금액').fill('45000');
  await page.getByRole('radio', { name: '식대' }).click();
  await page.getByLabel('사용처').fill('을지로 국수집');
  await page.getByLabel('메모').fill('신규 파트너 미팅 점심 (3명)');
});
await shot('10-expense-detail', '/expenses/5');
await shot('11-members', '/members');
await shot('11b-invite-modal', '/members', async () => {
  await page.getByRole('button', { name: '구성원 초대' }).click();
  await page.getByLabel('이름').fill('윤가람');
  await page.getByLabel('이메일').fill('garam.yoon@dodamwork.test');
  await page.getByRole('dialog').getByLabel('부서', { exact: true }).selectOption({ label: '디자인팀' });
});
// Resend invitation: success is mocked and failure aborted, so nothing is written.
await shot('11d-members-resend-sent', '/members', async () => {
  await page.route('**/members/*/resend-invite', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.getByRole('button', { name: '초대 메일 다시 보내기' }).click();
  await page.getByText('초대 메일을 다시 보냈어요').waitFor();
  await page.unroute('**/members/*/resend-invite');
});
await shot('11e-members-resend-blocked', '/members', async () => {
  await page.route('**/members/*/resend-invite', (r) => r.abort());
  await page.getByRole('button', { name: '초대 메일 다시 보내기' }).click();
  await page.getByText('보내지 못했어요. 잠시 후 다시 시도해 주세요.').waitFor();
  await page.unroute('**/members/*/resend-invite');
});
await shot('11c-members-page2', '/members?page=2');
await shot('12-member-detail', '/members/3');
await shot('12b-member-invited', '/members/18');
await shot('13-notices', '/notices');
await shot('13b-notice-new', '/notices/new', async () => {
  await page.getByLabel('제목').fill('12월 송년회 일정 안내');
  await page.getByLabel('내용').fill('올해 송년회를 아래와 같이 진행해요.\n\n- 일시: 12월 18일(금) 18:30\n- 장소: 성수동 라운지');
  await page.getByRole('switch', { name: '상단 고정' }).click();
});
await shot('13c-notice-detail', '/notices/1');
await shot('13d-notice-detail-photo', '/notices/5');
await shot('13d-notice-detail-photo-full', '/notices/5', null, { full: true });
await shot('14-settings-profile', '/settings/profile');
await shot('14b-settings-notifications', '/settings/notifications');
await shot('14c-settings-leave-policy', '/settings/leave-policy');
await shot('14d-settings-company', '/settings/company');
await shot('15-search', '/search?q=%EC%97%B0%EB%A7%90');
await shot('16-404', '/no-such-page');

console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no console errors');
await browser.close();
