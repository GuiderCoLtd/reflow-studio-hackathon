// Reach the app through the hostname app.dodamwork.test (Chrome host-resolver
// mapping, like the demo pipeline), log in, and print the ARIA snapshot of the
// given pages so roles and accessible names can be reviewed.
//   node testapps/dodam/tools/aria.mjs [/leave/new /] [--ai]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const ai = args.includes('--ai');
const pages = args.filter((a) => a.startsWith('/'));
const targets = pages.length ? pages : ['/leave/new', '/'];
const HOST = 'app.dodamwork.test';
const BASE = `http://${HOST}`;

const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:3500`] });
const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, locale: 'ko-KR' });
const page = await context.newPage();

await page.goto(`${BASE}/`);
console.log(`# unauthenticated ${BASE}/ -> ${page.url()}`);
await page.locator('#email').fill('demo@dodamwork.test');
await page.locator('#password').fill('DemoPass!2026');
await page.locator('button[type=submit]').click();
await page.waitForURL(`${BASE}/`);
const cookies = await context.cookies();
const session = cookies.find((c) => c.name === 'dodam_session');
console.log(`# logged in at ${page.url()} — cookie domain=${session?.domain} path=${session?.path} httpOnly=${session?.httpOnly} sameSite=${session?.sameSite}`);

for (const p of targets) {
  await page.goto(BASE + p, { waitUntil: 'networkidle' });
  const snap = ai ? await page.locator('body').ariaSnapshot({ mode: 'ai' }) : await page.locator('body').ariaSnapshot();
  console.log(`\n# ${p}  "${await page.title()}"\n${snap}`);
}
await browser.close();
