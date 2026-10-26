// Site configuration, login handling and environment reset.
// A session always starts by proving it is logged in; if the saved state has
// expired (rotating refresh tokens, idle timeouts) it logs in again and saves
// the fresh state, so long pipelines never silently run logged out.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSession, waitForSettle, closeSession } from './browser.mjs';
import { ROOT, RUNS_DIR, ensureDir, log, readJson } from './util.mjs';

export function loadSite(id) {
  const file = path.join(ROOT, 'sites', `${id}.json`);
  const site = readJson(file);
  site.stateFile = path.join(RUNS_DIR, site.id, 'state.json');
  return site;
}

function secret(step) {
  if (step.secret && process.env[step.secret]) return process.env[step.secret];
  return step.fallback ?? step.value ?? '';
}

export async function isLoggedOut(session, site) {
  const marker = site.login?.loggedOutUrl;
  if (!marker) return false;
  try {
    return new URL(session.page.url()).pathname.startsWith(marker);
  } catch {
    return false;
  }
}

export async function login(session, site) {
  const spec = site.login;
  if (!spec) return;
  const page = session.page;
  await page.goto(spec.url, { waitUntil: 'domcontentloaded' });
  await waitForSettle(session);
  for (const step of spec.steps) {
    if (step.fill) await page.locator(step.fill).first().fill(secret(step), { timeout: 10000 });
    else if (step.click) await page.locator(step.click).first().click({ timeout: 10000 });
    else if (step.press) await page.keyboard.press(step.press);
  }
  await waitForSettle(session);
  await page.waitForURL((u) => !u.pathname.startsWith(spec.loggedOutUrl || '/__never__'), { timeout: 10000 }).catch(() => {});
  if (await isLoggedOut(session, site)) throw new Error(`login failed for ${site.id}`);
  await saveState(session, site);
  log('site', `logged in to ${site.id}`);
}

export async function saveState(session, site) {
  ensureDir(path.dirname(site.stateFile));
  await session.context.storageState({ path: site.stateFile }).catch(() => {});
}

// Open a session that is guaranteed to be logged in (when the site needs it).
export async function openSiteSession(site, opts = {}) {
  const session = await openSession({ storageState: site.stateFile, locale: opts.locale || localeOf(site), userAgent: site.userAgent, args: site.chromeArgs || [], ...opts });
  if (site.login) {
    await session.page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForSettle(session);
    if (await isLoggedOut(session, site)) await login(session, site);
  }
  return session;
}

export async function closeSiteSession(session, site) {
  if (site.login) await saveState(session, site);
  await closeSession(session);
}

export function localeOf(site) {
  return { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' }[site.lang] || 'ko-KR';
}

// Environment reset for sandbox sites: restore a database snapshot so every
// filming run starts from the same data.
export function snapshotEnv(site, name = 'base') {
  if (site.reset?.kind !== 'sqlite-copy') return false;
  execFileSync(path.join(ROOT, 'testapps', 'ctl.sh'), ['snapshot', site.reset.restart, name], { stdio: 'pipe' });
  return true;
}

export function restoreEnv(site, name = 'base') {
  if (site.reset?.kind !== 'sqlite-copy') return false;
  const snap = path.join(ROOT, 'testapps', 'snapshots', `${site.reset.restart}-${name}.db`);
  if (!fs.existsSync(snap)) return false;
  execFileSync(path.join(ROOT, 'testapps', 'ctl.sh'), ['restore', site.reset.restart, name], { stdio: 'pipe' });
  return true;
}
