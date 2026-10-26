// Functional checks for the main write flows. Each flow submits through the UI,
// expects the success banner, reloads and checks that the change persisted.
// Finishes with `ctl.sh restore dodam` and verifies the seed state comes back
// while the same browser session stays logged in.
//   node testapps/dodam/tools/flows.mjs
//   DODAM_LABELS=v2 node testapps/dodam/tools/flows.mjs   # against a server started with v2 labels
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { L } from '../labels.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CTL = path.resolve(HERE, '../../ctl.sh');
const BASE = process.env.DODAM_URL || 'http://127.0.0.1:3500';
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const banner = () => page.getByRole('status');
const bannerText = async () => ((await banner().count()) ? (await banner().first().innerText()).trim() : '');
// Wait out menu/dialog motion (<= 220 ms) so captures show the settled state.
const shot = async (name) => {
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const go = (p) => page.goto(BASE + p, { waitUntil: 'networkidle' });

// ---- login
await go('/');
check('logged-out visit lands on /login', new URL(page.url()).pathname === '/login', page.url());
await page.locator('#email').fill('demo@dodamwork.test');
await page.locator('#password').fill('DemoPass!2026');
await page.locator('button[type=submit]').click();
await page.waitForURL(`${BASE}/`);
check('login → home', (await page.title()) === '홈 | 도담워크');

// ---- 1. leave request
await go('/leave');
await page.getByRole('link', { name: L.leaveNewButton, exact: true }).click();
await page.waitForURL('**/leave/new');
await page.getByRole('radio', { name: '연차', exact: true }).click();
await page.getByLabel('시작일', { exact: true }).fill('2026-11-12');
await page.getByLabel('종료일', { exact: true }).fill('2026-11-13');
await page.getByLabel('사유', { exact: true }).fill('가족 여행');
check('leave form live day count', (await page.locator('[data-leave-days]').innerText()) === '2일');
await page.getByRole('button', { name: L.leaveSubmit, exact: true }).click();
await page.waitForURL(`${BASE}/leave`);
check('leave banner', (await bannerText()) === L.leaveCreated, await bannerText());
const firstLeave = async () => page.locator('tbody tr').first().innerText();
check('leave new row on top (대기)', /2026\.11\.12.*2026\.11\.13/s.test(await firstLeave()) && /대기/.test(await firstLeave()), (await firstLeave()).replace(/\s+/g, ' '));
await shot('f01-leave-created');
await page.reload({ waitUntil: 'networkidle' });
check('leave persists after reload (banner gone)', /2026\.11\.12/.test(await firstLeave()) && (await banner().count()) === 0);
await go('/');
check('home schedule shows my pending leave', await page.getByText('김하늘 연차').isVisible());
await go('/approvals/sent');
check('leave doc in 보낸 결재', await page.getByRole('link', { name: '연차 휴가 신청 (11/12~11/13)' }).isVisible());

// leave detail + cancel flow on a second request
await go('/leave/new');
await page.getByRole('radio', { name: '오후 반차', exact: true }).click();
await page.getByLabel('시작일', { exact: true }).fill('2026-11-16');
await page.getByLabel('사유', { exact: true }).fill('병원 진료');
await page.getByRole('button', { name: L.leaveSubmit, exact: true }).click();
await page.waitForURL(`${BASE}/leave`);
await page.locator('tbody tr').first().getByRole('link').click();
await page.waitForURL(/\/leave\/\d+$/);
await shot('f02-leave-detail-pending');
await page.getByRole('button', { name: L.leaveCancel, exact: true }).click();
check('cancel confirm dialog opens', await page.getByRole('dialog', { name: L.leaveCancelTitle }).isVisible());
await shot('f03-leave-cancel-modal');
await page.keyboard.press('Escape');
check('Escape closes the dialog', !(await page.getByRole('dialog').isVisible().catch(() => false)));
await page.getByRole('button', { name: L.leaveCancel, exact: true }).click();
await page.getByRole('button', { name: L.leaveCancelConfirm, exact: true }).click();
await page.waitForURL(`${BASE}/leave`);
check('cancel banner + 취소 status', (await bannerText()) === L.leaveCancelled && /취소/.test(await firstLeave()), await bannerText());

// ---- 2. expense claim with receipt upload
const receipt = path.join(SHOTS, '00-login.png');
await go('/expenses');
await page.getByRole('link', { name: '경비 청구', exact: true }).click();
await page.waitForURL('**/expenses/new');
await page.getByLabel('사용일', { exact: true }).fill('2026-11-05');
await page.getByLabel('금액', { exact: true }).fill('45000');
await page.getByRole('radio', { name: '식대', exact: true }).click();
await page.getByLabel('사용처', { exact: true }).fill('을지로 국수집');
await page.getByLabel('메모', { exact: true }).fill('신규 파트너 미팅 점심 (3명)');
await page.getByLabel('영수증', { exact: true }).setInputFiles(receipt);
check('dropzone shows chosen file', (await page.locator('[data-file-name]').innerText()) === '00-login.png');
await shot('f04-expense-filled');
await page.getByRole('button', { name: '청구하기', exact: true }).click();
await page.waitForURL(`${BASE}/expenses`);
check('expense banner', /경비 청구가 접수됐어요/.test(await bannerText()), await bannerText());
const firstExp = async () => (await page.locator('tbody tr').first().innerText()).replace(/\s+/g, ' ');
check('expense new row on top', /을지로 국수집/.test(await firstExp()) && /45,000원/.test(await firstExp()) && /대기/.test(await firstExp()), await firstExp());
check('expense month total updated', /293,000/.test(await page.locator('.exp-total-value').innerText()));
await shot('f05-expense-created');
await page.reload({ waitUntil: 'networkidle' });
check('expense persists after reload', /을지로 국수집/.test(await firstExp()));
await page.locator('tbody tr').first().getByRole('link').click();
await page.waitForURL(/\/expenses\/\d+$/);
const img = page.locator('.receipt-frame img');
check('uploaded receipt is shown', (await img.count()) === 1 && (await img.evaluate((el) => el.complete && el.naturalWidth > 0)));

// ---- 3. approve one approval, reject another
await go('/approvals');
await page.getByRole('link', { name: '연차 휴가 신청 (11/19~11/20)', exact: true }).click();
await page.waitForURL(/\/approvals\/\d+$/);
const docUrl = page.url();
await page.getByRole('button', { name: '승인', exact: true }).click();
await page.waitForURL(docUrl);
check('approve banner', (await bannerText()) === '승인했어요', await bannerText());
check('doc status → 승인', (await page.locator('.doc-status').innerText()).trim() === '승인');
await shot('f06-approved');
await page.reload({ waitUntil: 'networkidle' });
check('approval persists after reload', (await page.locator('.doc-status').innerText()).trim() === '승인' && (await page.getByRole('button', { name: '승인', exact: true }).count()) === 0);
await go('/approvals');
check('받은 결재 now 2 docs', (await page.locator('tbody tr').count()) === 2);
check('sidebar count now 2', (await page.locator('.nav-count').innerText()).trim() === '2');
await page.getByRole('link', { name: '고객 인터뷰 다과비 청구', exact: true }).click();
await page.waitForURL(/\/approvals\/\d+$/);
await page.getByRole('button', { name: '반려', exact: true }).click();
await page.getByRole('button', { name: '반려하기', exact: true }).click();
await page.waitForLoadState('networkidle');
check('empty reject reason → error inside reopened dialog', await page.getByRole('dialog', { name: '문서 반려' }).getByText('반려 사유를 입력해 주세요.').isVisible());
await page.getByLabel('반려 사유', { exact: true }).fill('참가자 명단을 함께 첨부해 주세요.');
await page.getByRole('button', { name: '반려하기', exact: true }).click();
await page.waitForLoadState('networkidle');
check('reject banner + 반려 status', (await bannerText()) === '반려했어요' && (await page.locator('.doc-status').innerText()).trim() === '반려', await bannerText());

// ---- 4. resend a pending invitation: a fetch from a plain button, never a form submit
await go('/members');
const seojin = page.locator('tbody tr', { hasText: '윤서진' });
const resendBtn = seojin.getByRole('button', { name: '초대 메일 다시 보내기', exact: true });
const rowText = async () => (await seojin.innerText()).replace(/\s+/g, ' ');
check('invited row shows 초대됨 · 11월 3일 + resend button', /초대됨 · 11월 3일/.test(await rowText()) && (await resendBtn.count()) === 1, await rowText());
check('resend button is type=button outside any form', await resendBtn.evaluate((b) => b.type === 'button' && !b.form));
const isResend = (r) => new URL(r.url()).pathname === '/members/18/resend-invite';
const [resendRes] = await Promise.all([page.waitForResponse(isResend), resendBtn.click()]);
await seojin.getByText('초대 메일을 다시 보냈어요', { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
check(
  'resend: POST answers {ok:true}, success text shown, no navigation',
  resendRes.request().method() === 'POST' && JSON.stringify(await resendRes.json()) === '{"ok":true}' && (await seojin.getByText('초대 메일을 다시 보냈어요', { exact: true }).isVisible()) && new URL(page.url()).pathname === '/members',
  await rowText(),
);
await page.reload({ waitUntil: 'networkidle' });
check('resend recorded (shown after reload)', /11월 5일 10:24에 다시 보냈어요/.test(await rowText()), await rowText());
await page.route('**/members/*/resend-invite', (r) => r.abort());
const [blockedReq] = await Promise.all([page.waitForRequest(isResend), resendBtn.click()]);
await seojin.getByText('보내지 못했어요. 잠시 후 다시 시도해 주세요.').waitFor({ timeout: 5000 }).catch(() => {});
check(
  'resend aborted → failure text',
  blockedReq.method() === 'POST' && (await seojin.getByText('보내지 못했어요. 잠시 후 다시 시도해 주세요.').isVisible()) && (await seojin.getByText('초대 메일을 다시 보냈어요').count()) === 0,
  await rowText(),
);
await page.unroute('**/members/*/resend-invite');
await shot('f07a-resend-blocked');
const notInvited = await page.request.post(`${BASE}/members/3/resend-invite`);
check('resend refuses a member who is not invited (404)', notInvited.status() === 404 && (await notInvited.json()).ok === false);

// ---- 4b. invite a member
await go('/members');
await page.getByRole('button', { name: '구성원 초대', exact: true }).click();
const invite = page.getByRole('dialog', { name: '구성원 초대' });
await invite.getByLabel('이름', { exact: true }).fill('윤가람');
await invite.getByLabel('이메일', { exact: true }).fill('garam.yoon@dodamwork.test');
await invite.getByLabel('부서', { exact: true }).selectOption({ label: '디자인팀' });
await invite.getByRole('radio', { name: '일반', exact: true }).click();
await invite.getByRole('button', { name: '초대 보내기', exact: true }).click();
await page.waitForURL(`${BASE}/members`);
check('invite banner', (await bannerText()) === '윤가람님에게 초대 메일을 보냈어요.', await bannerText());
const firstMember = async () => (await page.locator('tbody tr').first().innerText()).replace(/\s+/g, ' ');
check('invited member on top (초대됨)', /윤가람/.test(await firstMember()) && /초대됨/.test(await firstMember()), await firstMember());
await shot('f07-member-invited');
await page.reload({ waitUntil: 'networkidle' });
check('invite persists after reload', /윤가람/.test(await firstMember()));

// ---- 5. attendance correction request
await go('/attendance');
await page.getByRole('button', { name: '근무 기록 정정 요청', exact: true }).click();
const corr = page.getByRole('dialog', { name: '근무 기록 정정 요청' });
await corr.getByLabel('날짜', { exact: true }).fill('2026-11-02');
await corr.getByRole('radio', { name: '출근', exact: true }).click();
await corr.getByLabel('정정 시간', { exact: true }).fill('08:55');
await corr.getByLabel('사유', { exact: true }).fill('지하철 지연으로 출근 태그를 늦게 했어요.');
await corr.getByRole('button', { name: '요청 보내기', exact: true }).click();
await page.waitForURL(`${BASE}/attendance`);
check('correction banner', (await bannerText()) === '정정 요청을 보냈어요', await bannerText());
const corrRow = page.getByRole('region', { name: '정정 요청 내역' }).locator('tbody tr').first();
check('correction listed (대기)', /11월 2일/.test(await corrRow.innerText()) && /대기/.test(await corrRow.innerText()), (await corrRow.innerText()).replace(/\s+/g, ' '));
await page.reload({ waitUntil: 'networkidle' });
check('correction persists after reload', /11월 2일/.test(await corrRow.innerText()));

// ---- 6. notice creation
await go('/notices');
await page.getByRole('link', { name: '공지 작성', exact: true }).click();
await page.waitForURL('**/notices/new');
await page.getByLabel('제목', { exact: true }).fill('12월 송년회 일정 안내');
await page.getByLabel('내용', { exact: true }).fill('올해 송년회를 아래와 같이 진행해요.\n\n- 일시: 12월 18일(금) 18:30\n- 장소: 성수동 라운지');
await page.getByRole('switch', { name: '상단 고정' }).click();
check('switch toggles aria-checked', (await page.getByRole('switch', { name: '상단 고정' }).getAttribute('aria-checked')) === 'true');
await page.getByRole('button', { name: '게시하기', exact: true }).click();
await page.waitForURL(`${BASE}/notices`);
check('notice banner', (await bannerText()) === '공지를 게시했어요', await bannerText());
const firstNotice = async () => (await page.locator('.notice-row').first().innerText()).replace(/\s+/g, ' ');
check('pinned notice on top', /12월 송년회 일정 안내/.test(await firstNotice()) && /고정/.test(await firstNotice()), await firstNotice());
await page.reload({ waitUntil: 'networkidle' });
check('notice persists after reload', /12월 송년회 일정 안내/.test(await firstNotice()));

// ---- 7. settings switch
await go('/settings/notifications');
await page.getByRole('switch', { name: '출근 기록 알림' }).click();
await page.getByRole('button', { name: '저장', exact: true }).click();
await page.waitForURL(`${BASE}/settings/notifications`);
check('settings banner', (await bannerText()) === '변경 사항을 저장했어요.', await bannerText());
await page.reload({ waitUntil: 'networkidle' });
check('settings switch persisted', (await page.getByRole('switch', { name: '출근 기록 알림' }).getAttribute('aria-checked')) === 'true');

// ---- 8. menus close with Escape
await go('/');
await page.getByRole('button', { name: '알림' }).click();
check('notification menu opens', await page.getByRole('menu', { name: '알림 목록' }).isVisible());
await page.keyboard.press('Escape');
check('notification menu closes on Escape', !(await page.getByRole('menu', { name: '알림 목록' }).isVisible()));

// ---- restore and verify seed state with the same session
execFileSync(CTL, ['restore', 'dodam'], { stdio: 'pipe' });
await go('/');
check('session survives restore (no re-login)', new URL(page.url()).pathname === '/' && (await page.title()) === '홈 | 도담워크', page.url());
await go('/leave');
check('restore: leave history back to 4 rows', (await page.locator('tbody tr').count()) === 4);
await go('/approvals');
check('restore: 3 pending approvals', (await page.locator('tbody tr').count()) === 3);
await go('/members');
check('restore: invited member gone', !/윤가람/.test(await page.locator('tbody').innerText()));
await go('/notices');
check('restore: 6 notices', (await page.locator('.notice-row').count()) === 6);
await go('/expenses');
check('restore: month total ₩248,000', /248,000/.test(await page.locator('.exp-total-value').innerText()));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
