// Site explorer: a bounded, read-only crawl that builds a map of screens,
// navigation, dialogs/forms and API endpoints. No LLM in the loop: it follows
// links and safely "peeks" at openers (create/settings/menu buttons and tabs),
// recording what they reveal and closing them again without submitting.
import path from 'node:path';
import { observe } from './observe.mjs';
import { waitForSettle } from './browser.mjs';
import { decide } from './safety.mjs';
import { urlTemplate, sameOrigin, ensureDir, writeJson, log, truncate, sleep } from './util.mjs';

const SKIP_URL = /(logout|log-out|signout|sign_out|delete|remove|destroy|unsubscribe|\/api\/|swagger|openapi|\/raw\/|\/archive\/|\.(zip|pdf|tar|gz|png|jpe?g|svg|csv|xlsx?|json|txt|xml|rss|atom)(\?|$)|^mailto:|^tel:|^javascript:)/i;
const OPENER_NAME = /(new|create|add|invite|settings|setting|edit|filter|sort|view|more|options|menu|share|import|export|request|\+|만들기|생성|추가|새|초대|설정|편집|수정|필터|정렬|보기|더보기|옵션|메뉴|공유|가져오기|내보내기|신청|요청|청구|작성|등록|정정)/i;
// Openers whose label reads like an action ("구성원 초대", "정정 요청") are only
// peeked at behind a network guard that aborts every data-changing request.
const GUARDED = new Set(['send', 'submit', 'save', 'share']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LAYOUT_TOGGLE = /(숨기기|접기|펼치기|hide|show menu|collapse|expand|toggle|sidebar|사이드바|메뉴 보기|메뉴 숨기기|skip to)/i;

export async function exploreSite(session, {
  baseUrl,
  startUrls = [baseUrl],
  outDir,
  maxPages = 30,
  maxDepth = 3,
  maxProbesPerPage = 6,
  maxPerTemplate = 2,
  timeBudgetMs = 8 * 60_000,
  ensureLogin = null,
  shotQuality = 70,
} = {}) {
  ensureDir(outDir);
  const shotsDir = ensureDir(path.join(outDir, 'shots'));
  const started = Date.now();
  const pages = [];
  const transitions = [];
  const templates = new Map();
  const queued = new Set();
  const queue = startUrls.map((u) => ({ url: u, depth: 0, via: null }));
  const probedSiteWide = new Set(); // global chrome (sidebars, headers) is probed once per site
  startUrls.forEach((u) => queued.add(normalize(u)));
  // Leave-page prompts must be accepted or every later navigation is aborted.
  session.dialogPolicy = (d) => (d.type() === 'beforeunload' ? 'accept' : 'dismiss');

  while (queue.length && pages.length < maxPages && Date.now() - started < timeBudgetMs) {
    queue.sort((a, b) => a.depth - b.depth || (b.priority || 0) - (a.priority || 0));
    const item = queue.shift();
    const tpl = urlTemplate(item.url);
    // Query-string variants of an already visited path (sort/filter links) add little.
    const pathKey = tpl.split('?')[0];
    if (tpl.includes('?') && [...templates.keys()].some((k) => k.split('?')[0] === pathKey)) continue;
    if ((templates.get(tpl) || 0) >= maxPerTemplate) continue;
    templates.set(tpl, (templates.get(tpl) || 0) + 1);
    const firstOfTemplate = templates.get(tpl) === 1;

    const netMark = Date.now();
    try {
      await session.page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (err) {
      log('explore', 'goto failed', item.url, err.message.split('\n')[0]);
      continue;
    }
    await waitForSettle(session);
    // A crawl must never continue logged out: log back in and retry once.
    if (ensureLogin && (await ensureLogin(session))) {
      await session.page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await waitForSettle(session);
    }
    if (!sameOrigin(session.page.url(), baseUrl)) continue;
    const finalTpl = urlTemplate(session.page.url());
    if (finalTpl !== tpl) {
      if ((templates.get(finalTpl) || 0) >= maxPerTemplate) continue;
      templates.set(finalTpl, (templates.get(finalTpl) || 0) + 1);
    }
    const obs = await observe(session, { maxChars: 9000 });
    const id = `p${String(pages.length + 1).padStart(2, '0')}`;
    const shot = path.join(shotsDir, `${id}.jpg`);
    await session.page.screenshot({ path: shot, type: 'jpeg', quality: shotQuality }).catch(() => {});
    const record = {
      id,
      t: Date.now() - started,
      url: obs.url,
      template: urlTemplate(obs.url),
      title: obs.title,
      depth: item.depth,
      via: item.via,
      snapshot: obs.snapshot,
      shot: path.relative(outDir, shot),
      // Where every link sits on screen: lets a viewer see what the crawler saw.
      linkBoxes: await linkBoxes(session.page),
      api: apiCalls(session.net.since(netMark)),
      probes: [],
    };
    pages.push(record);
    log('explore', `${id} d${item.depth} ${truncate(obs.url, 90)} "${truncate(obs.title, 40)}"`);

    // Enqueue same-origin links discovered in the snapshot.
    for (const link of linksOf(obs, baseUrl)) {
      const key = normalize(link.url);
      if (queued.has(key) || item.depth + 1 > maxDepth) continue;
      queued.add(key);
      // Create/new/settings entry points are where most how-to guides start.
      const opener = OPENER_NAME.test(link.name) || /\/(new|create|settings|edit)(\/|$|\?)/.test(link.url);
      queue.push({ url: link.url, depth: item.depth + 1, via: { from: id, label: link.name }, priority: opener ? 4 : link.nav ? 2 : 1 });
      transitions.push({ from: id, label: link.name, kind: 'link', to: link.url });
    }

    if (firstOfTemplate) {
      const probes = await probeOpeners(session, obs, { baseUrl, max: maxProbesPerPage, shotsDir, pageId: id, outDir, probedSiteWide, started, shotQuality });
      record.probes = probes;
      for (const p of probes) {
        transitions.push({ from: id, label: p.label, kind: p.kind, to: p.toUrl || null });
        if (p.kind === 'route' && p.toUrl && !queued.has(normalize(p.toUrl)) && item.depth + 1 <= maxDepth) {
          queued.add(normalize(p.toUrl));
          queue.push({ url: p.toUrl, depth: item.depth + 1, via: { from: id, label: p.label }, priority: 3 });
        }
        for (const link of p.links || []) {
          const key = normalize(link.url);
          if (queued.has(key) || item.depth + 1 > maxDepth) continue;
          queued.add(key);
          queue.push({ url: link.url, depth: item.depth + 1, via: { from: id, label: `${p.label} › ${link.name}` }, priority: 2 });
        }
      }
    }
  }
  const map = { baseUrl, exploredAt: new Date().toISOString(), ms: Date.now() - started, pages, transitions };
  writeJson(path.join(outDir, 'map.json'), map);
  return map;
}

function normalize(u) {
  try {
    const x = new URL(u);
    x.hash = x.hash && x.hash.length > 1 ? x.hash : '';
    return x.toString();
  } catch {
    return u;
  }
}

function apiCalls(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (e.type === 'document') continue;
    let p;
    try {
      p = urlTemplate(e.url).replace(/^https?:\/\/[^/]+/, '');
    } catch {
      p = e.url;
    }
    const key = `${e.method} ${p}`;
    if (!seen.has(key)) seen.set(key, { method: e.method, path: p, status: e.status });
  }
  return [...seen.values()].slice(0, 40);
}

// Links from the snapshot text: lines like  - link "Name" [e5] {url=/x}
function linksOf(obs, baseUrl) {
  const out = [];
  const lines = obs.snapshot.split('\n');
  let navDepth = -1;
  for (const line of lines) {
    const indent = line.match(/^ */)[0].length;
    if (/- (navigation|banner|complementary|menu|menubar|tablist)\b/.test(line)) navDepth = indent;
    else if (navDepth >= 0 && indent <= navDepth) navDepth = -1;
    const m = line.match(/- link "([^"]*)" \[[^\]]+\][^{]*\{[^}]*url=([^,}\s]+)/);
    if (!m) continue;
    const [, name, href] = m;
    if (!href || href.startsWith('#') || SKIP_URL.test(href) || SKIP_URL.test(name)) continue;
    let abs;
    try {
      abs = new URL(href.replace(/…$/, ''), obs.url).toString();
    } catch {
      continue;
    }
    if (!sameOrigin(abs, baseUrl)) continue;
    out.push({ name, url: abs, nav: navDepth >= 0 });
  }
  return out;
}

const CONTROL_ROLES = new Set(['button', 'combobox', 'tab', 'menuitem']);

function openerCandidates(obs, disclosures = new Set()) {
  const out = [];
  for (const [ref, info] of obs.refs) {
    const name = info.name || '';
    // Only controls are openers; landmarks such as nav "주 메뉴" are not clickable targets.
    if (!CONTROL_ROLES.has(info.role)) continue;
    const isTab = info.role === 'tab';
    const isMenu = info.role === 'menuitem' || /메뉴|menu/i.test(name);
    const isButton = info.role === 'button' || info.role === 'combobox';
    const isDisclosure = isButton && (info.expanded === false || disclosures.has(name));
    if (!(isTab || isMenu || isDisclosure || (isButton && OPENER_NAME.test(name)))) continue;
    if (LAYOUT_TOGGLE.test(name)) continue;
    const safety = decide({ mode: 'explore', action: { tool: 'click', role: info.role, name } });
    if (safety.decision !== 'allow' && !GUARDED.has(safety.category)) continue;
    if (/(search|검색)/i.test(name) && info.role !== 'button') continue;
    out.push({ ref, role: info.role, name, expanded: info.expanded === false || disclosures.has(name) ? false : info.expanded, guarded: safety.decision !== 'allow' });
  }
  // Tabs and create/settings openers first, then generic menus.
  const score = (c) => (OPENER_NAME.test(c.name) ? 2 : 0) + (c.role === 'tab' ? 1 : 0) + (c.expanded === false ? 1 : 0);
  return out.sort((a, b) => score(b) - score(a));
}

async function probeOpeners(session, obs, { baseUrl, max, shotsDir, pageId, outDir, probedSiteWide = new Set(), started = Date.now(), shotQuality = 70 }) {
  const page = session.page;
  const origin = obs.url;
  const results = [];
  const tried = new Set();
  let current = obs;
  const disclosures = new Set(
    await page
      .evaluate(() =>
        [...document.querySelectorAll('[aria-expanded="false"], [aria-haspopup]:not([aria-haspopup="false"])')]
          .filter((e) => e.getClientRects().length)
          .map((e) => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim()),
      )
      .catch(() => []),
  );
  for (const cand of openerCandidates(obs, disclosures)) {
    if (results.length >= max) break;
    const label = cand.name || cand.role;
    if (tried.has(label) || probedSiteWide.has(`${cand.role}:${label}`)) continue;
    tried.add(label);
    probedSiteWide.add(`${cand.role}:${label}`);
    // Refs die when restore() reloads the page; look the element up again by role+name.
    const live = [...current.refs.entries()].find(([, i]) => i.role === cand.role && i.name === cand.name);
    if (!live) continue;
    const loc = page.locator(`aria-ref=${live[0]}`);
    const before = await dialogCount(page);
    let box = null;
    const t = Date.now() - started;
    // A form's own submit button commits; it is never an opener.
    if (await loc.evaluate((el) => (el.type === 'submit' || el.getAttribute('type') === 'submit') && !!el.form, undefined, { timeout: 1000 }).catch(() => false)) continue;
    const blocked = [];
    const guard = (route) => {
      const req = route.request();
      if (SAFE_METHODS.has(req.method())) return route.continue();
      blocked.push(`${req.method()} ${new URL(req.url()).pathname}`);
      return route.abort('blockedbyclient');
    };
    await page.route('**/*', guard);
    try {
      if (!(await loc.isVisible({ timeout: 500 }))) {
        await page.unroute('**/*', guard);
        continue;
      }
      box = await loc.boundingBox().catch(() => null);
      await loc.click({ timeout: 3000 });
    } catch {
      await page.unroute('**/*', guard).catch(() => {});
      continue;
    }
    await waitForSettle(session, { maxMs: 4000 });
    const now = session.page;
    const toUrl = now.url();
    const result = { label, role: cand.role, kind: 'none', t, box, guarded: cand.guarded, blocked };
    if (normalize(toUrl) !== normalize(origin)) {
      result.kind = 'route';
      result.toUrl = sameOrigin(toUrl, baseUrl) ? toUrl : null;
    } else {
      const after = await observe(session, { maxChars: 5000 });
      const dialogs = await dialogCount(now);
      const delta = diffLines(obs.snapshot, after.snapshot);
      if (dialogs > before) result.kind = 'dialog';
      else if (/- (menu|listbox|menuitem|option)\b/.test(delta)) result.kind = 'menu';
      else if (delta.trim()) result.kind = cand.role === 'tab' ? 'tab' : 'reveal';
      if (result.kind !== 'none') {
        result.revealed = truncate(delta, 2500);
        result.links = linksOf({ ...after, snapshot: delta }, baseUrl).slice(0, 12);
        const shot = path.join(shotsDir, `${pageId}-probe${results.length + 1}.jpg`);
        await now.screenshot({ path: shot, type: 'jpeg', quality: shotQuality }).catch(() => {});
        result.shot = path.relative(outDir, shot);
      }
    }
    results.push(result);
    const reloaded = await restore(session, origin, result.kind);
    await page.unroute('**/*', guard).catch(() => {});
    if (reloaded || result.kind !== 'none') current = await observe(session, { maxChars: 9000 });
  }
  return results;
}

async function linkBoxes(page) {
  return page
    .evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => {
          const r = a.getBoundingClientRect();
          const name = (a.getAttribute('aria-label') || a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          return { name, href: a.href, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((l) => l.w > 2 && l.h > 2),
    )
    .catch(() => []);
}

async function dialogCount(page) {
  return page.locator('[role=dialog]:visible, [role=alertdialog]:visible, dialog[open]').count().catch(() => 0);
}

function diffLines(a, b) {
  const seen = new Set(a.split('\n').map((l) => l.trim()));
  return b
    .split('\n')
    .filter((l) => !seen.has(l.trim()))
    .join('\n');
}

// Return to the original state: Escape, then close buttons, then reload.
async function restore(session, origin, kind) {
  const page = session.page;
  if (kind === 'route') {
    await page.goto(origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForSettle(session, { maxMs: 5000 });
    return true;
  }
  if (kind === 'none') return false;
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(250);
  if ((await dialogCount(page)) > 0) {
    const close = page.getByRole('button', { name: /^(close|cancel|닫기|취소|×|x)$/i }).first();
    if (await close.isVisible().catch(() => false)) await close.click({ timeout: 2000 }).catch(() => {});
    await sleep(250);
  }
  let reloaded = false;
  if ((await dialogCount(page)) > 0 || kind === 'tab' || kind === 'reveal') {
    await page.goto(origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
    reloaded = true;
  }
  await waitForSettle(session, { maxMs: 5000 });
  return reloaded;
}
