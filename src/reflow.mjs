// Reflow bridge: export an agent-made guide as a Reflow guide package and
// prove it plays in Reflow's real player (the web-embed runtime).
//
// Targets are described by Reflow's own recorder code (content.js
// buildTargetRef) running on the live page, so an exported step is
// structurally identical to one a person recorded with the extension.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, ensureDir, readJson, writeJson, log, sleep } from './util.mjs';
import { resolveBundle } from './locators.mjs';
import { waitForSettle } from './browser.mjs';

// The Reflow extension source is a separate, private product. Without it the
// Reflow-specific steps (target refs, player check) are skipped and say so.
const REFLOW_SRC = process.env.REFLOW_SRC || path.join(ROOT, '..', 'Reflow-CTO', 'reflowguide');
export const reflowAvailable = () => fs.existsSync(path.join(REFLOW_SRC, 'content.js'));
const VENDOR = ensureDir(path.join(ROOT, 'runs', '_vendor'));

const CHROME_SHIM = `globalThis.chrome = globalThis.chrome || {
  runtime: { id: "autoguide", sendMessage(){}, onMessage: { addListener(){} }, getURL: (p) => p, lastError: null },
  storage: { local: { get(_, cb){ cb && cb({}); }, set(){} } }
};`;

// content.js is one bare block in sloppy mode; insert an export before its
// final brace without touching the rest (same technique as Reflow's bench).
function instrument(file, names, globalName) {
  const src = fs.readFileSync(path.join(REFLOW_SRC, file), 'utf8').replace(/^﻿/, '');
  if (src.trimStart()[0] !== '{') throw new Error(`${file} is not a bare-block file`);
  const last = src.lastIndexOf('}');
  return `${src.slice(0, last)}\ntry { globalThis.${globalName} = { ${names.join(', ')} }; } catch (e) {}\n${src.slice(last)}`;
}

export function reflowBundles() {
  const out = path.join(VENDOR, 'reflow-rec.js');
  const srcStat = fs.statSync(path.join(REFLOW_SRC, 'content.js'));
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < srcStat.mtimeMs) {
    fs.writeFileSync(out, `${CHROME_SHIM}\n${instrument('content.js', ['buildTargetRef', 'buildFastTargetRef'], '__AGREC')}`);
  }
  return { rec: fs.readFileSync(out, 'utf8') };
}

let commit = null;
function reflowCommit() {
  if (commit) return commit;
  try {
    commit = execFileSync('git', ['-C', REFLOW_SRC, 'rev-parse', '--short', 'HEAD']).toString().trim();
  } catch {
    commit = 'unknown';
  }
  return commit;
}

// Describe the element behind `locator` with Reflow's recorder.
export async function reflowTargetRef(page, locator) {
  if (!reflowAvailable()) return null;
  const has = await page.evaluate(() => !!globalThis.__AGREC).catch(() => false);
  if (!has) await page.addScriptTag({ content: reflowBundles().rec });
  return locator.evaluate(async (el) => {
    let ref = null;
    try {
      ref = await globalThis.__AGREC.buildTargetRef(el);
    } catch {
      ref = null;
    }
    if (!ref) ref = globalThis.__AGREC.buildFastTargetRef(el);
    // Repeated row controls (one "settings" button per list row) share a name;
    // qualify them by the row's distinguishing text with a verified XPath.
    if (ref) {
      const xq = (t) => (t.includes("'") ? `concat('${t.split("'").join(`', "'", '`)}')` : `'${t}'`);
      const nameOf = (n) => (n.getAttribute('aria-label') || n.innerText || '').replace(/\s+/g, ' ').trim();
      const mine = nameOf(el);
      const peers = mine ? [...document.querySelectorAll(el.tagName)].filter((x) => x !== el && nameOf(x) === mine) : [];
      if (peers.length) {
        let row = el.parentElement;
        while (row && row !== document.body && !row.matches('li,tr,[role=row],[role=listitem],[role=treeitem]')) row = row.parentElement;
        const key = row && row !== document.body ? [...row.querySelectorAll('a,[role=link],h1,h2,h3,h4,td,span')].map((n) => (n.innerText || '').replace(/\s+/g, ' ').trim()).find((t) => t && t !== mine && t.length <= 60) : null;
        if (key) {
          const tag = el.tagName.toLowerCase();
          const aria = el.getAttribute('aria-label');
          const own = aria ? `${tag}[@aria-label=${xq(aria)}]` : `${tag}[normalize-space(.)=${xq(mine)}]`;
          const xp = `//${row.tagName.toLowerCase()}[.//*[normalize-space(.)=${xq(key)}]]//${own}`;
          const res = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          if (res.snapshotLength >= 1 && res.snapshotItem(0) === el) ref.rowXPath = xp;
        }
      }
    }
    // Native selects: keep the real option values so a select step can be matched.
    if (ref && el instanceof HTMLSelectElement) ref.options = [...el.options].map((o) => ({ value: o.value, label: o.label || o.textContent.trim() }));
    if (ref && !ref.captureBox) {
      const r = el.getBoundingClientRect();
      ref.captureBox = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      ref.captureViewport = { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
    }
    return ref;
  });
}

const ACTION_TYPE = { click: 'click', fill: 'input', select: 'select', hover: null, press: null };

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function pathOf(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return null;
  }
}

// Map the option the agent chose (by visible label) to the option's real value.
function selectOptionFor(ref, option) {
  const want = String(option ?? '').trim();
  const hit = (ref.options || []).find((o) => o.label === want) || (ref.options || []).find((o) => o.value === want) || (ref.options || []).find((o) => o.label.includes(want));
  return hit ? { value: hit.value, label: hit.label } : { value: want, label: want };
}

// Build a Reflow guide package from a compiled script and the refs captured
// during a verify replay. Screenshots come from the film stills.
export function buildReflowPackage(wfDir, { stillsWidth = 1440 } = {}) {
  const script = readJson(path.join(wfDir, 'script.json'));
  const refs = readJson(path.join(wfDir, 'reflow-refs.json'));
  const timeline = readJson(path.join(wfDir, 'film', 'timeline.json'), null);
  const id = `ag-${script.site?.id || 'site'}-${script.workflow.id}`;
  const origin = originOf(script.start_url);
  const steps = [];
  const assets = [];
  const jobs = [];
  const unsupported = [];
  for (const s of script.steps) {
    const actionType = ACTION_TYPE[s.action];
    const ref = refs.steps.find((r) => r.i === s.i)?.ref;
    if (!actionType || !ref) {
      // Never drop a step silently: the report shows what the player cannot express.
      unsupported.push({ i: s.i, action: s.action, key: s.key || null, title: s.title, reason: !actionType ? `Reflow player has no "${s.action}" step type` : 'no recorder ref captured' });
      continue;
    }
    const frameSt = timeline?.steps.find((t) => t.i === s.i);
    const still = frameSt?.frames?.hover?.f || frameSt?.frames?.idle?.f;
    const assetId = `${id}-s${s.i}`;
    if (still) jobs.push({ src: path.join(wfDir, 'film', 'frames', still), dst: path.join(wfDir, 'out', 'reflow', `${assetId}.jpg`), width: stillsWidth, quality: 82, box: null, assetId });
    steps.push({
      id: `${id}-s${s.i}`,
      order: steps.length + 1,
      title: s.title,
      instruction: s.instruction,
      actionType,
      recorderMode: s.ghost ? 'ghost' : 'normal',
      recordedLang: script.lang || 'ko',
      urlPattern: pathOf(s.urlBefore),
      frame: { isTopFrame: true, url: s.urlBefore, urlPattern: pathOf(s.urlBefore), origin: originOf(s.urlBefore) },
      target: {
        // A row-qualified XPath is an authored locator: the player resolves it first.
        primaryLocator: ref.rowXPath ? { kind: 'xpath', value: ref.rowXPath, score: 0.99 } : ref.locators?.[0] || null,
        fallbackLocators: ref.rowXPath ? ref.locators || [] : (ref.locators || []).slice(1),
        anchorBox: ref.boundingBox,
        captureBox: ref.captureBox,
        captureViewport: ref.captureViewport,
        snapshot: ref.snapshot || null,
        hint: {
          tagName: ref.tagName, role: ref.role, inputType: ref.inputType, text: ref.text, name: ref.name, label: ref.label,
          previewLabel: ref.previewLabel, previewDescription: ref.previewDescription, placeholder: ref.placeholder,
          nameAttr: ref.nameAttr, testId: ref.testId, elementId: ref.elementId, href: ref.href,
        },
        contextLabel: ref.contextLabel || null,
      },
      completionRule: { kind: 'manual_continue' },
      inputValue: actionType === 'input' ? String(s.value ?? '') : null,
      selectOption: actionType === 'select' ? selectOptionFor(ref, s.option) : null,
      sensitive: false,
      comment: null,
      screenshotAssetId: still ? assetId : null,
      screenshotScroll: { x: ref.captureViewport?.scrollX || 0, y: ref.captureViewport?.scrollY || 0 },
      refinedAt: new Date().toISOString(),
      generatedBy: { tool: 'autoguide', workflow: script.workflow.id, verifiedAt: script.verified?.at || null },
    });
  }
  ensureDir(path.join(wfDir, 'out', 'reflow'));
  if (jobs.length) {
    const jobFile = path.join(wfDir, 'out', 'reflow', '_jobs.json');
    fs.writeFileSync(jobFile, JSON.stringify(jobs));
    execFileSync('python3', [path.join(ROOT, 'src', 'py', 'stills.py'), jobFile], { stdio: 'inherit' });
    fs.rmSync(jobFile, { force: true });
    for (const j of jobs) {
      assets.push({ id: j.assetId, type: 'screenshot', mimeType: 'image/jpeg', dataUrl: `data:image/jpeg;base64,${fs.readFileSync(j.dst).toString('base64')}` });
      fs.rmSync(j.dst, { force: true });
    }
  }
  const guide = {
    id,
    name: script.title,
    nameI18n: null,
    summary: script.summary,
    status: 'draft',
    startOrigin: origin,
    startUrl: script.start_url,
    allowedOrigins: [origin],
  };
  const pkg = {
    id,
    name: script.title,
    guide,
    startOrigin: origin,
    startUrl: script.start_url,
    allowedOrigins: [origin],
    sourceSession: null,
    steps,
    assets,
    generator: { tool: 'autoguide', reflowSourceCommit: reflowCommit(), createdAt: new Date().toISOString(), unsupportedSteps: unsupported },
  };
  writeJson(path.join(wfDir, 'out', 'reflow', 'guide.json'), pkg);
  return pkg;
}

// ---------------------------------------------------------------------------
// Playback verification with Reflow's real player (embed runtime, no extension)

function playerBundle() {
  const out = path.join(VENDOR, 'reflow-player.js');
  const files = ['embed/runtime-shim.js', 'embed/guide-ui.js', 'content.js', 'content-player.js'];
  const newest = Math.max(...files.map((f) => fs.statSync(path.join(REFLOW_SRC, f)).mtimeMs));
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < newest) {
    // Order matters: the runtime shim must exist before the player hydrates.
    const parts = files.map((f) => fs.readFileSync(path.join(REFLOW_SRC, f), 'utf8').replace(/^﻿/, ''));
    fs.writeFileSync(out, parts.join('\n;\n'));
  }
  return fs.readFileSync(out, 'utf8');
}

async function injectPlayer(page) {
  const booted = await page.evaluate(() => !!window.ReflowEmbedRuntime && window.__guidePlayerBooted === true).catch(() => false);
  if (booted) return;
  await page.addScriptTag({ content: playerBundle() });
  await sleep(300);
}

async function overlayBox(page) {
  return page
    .evaluate(() => {
      const root = document.getElementById('guide-player-overlay-root')?.shadowRoot;
      const box = root?.querySelector('[aria-label="Trigger the current guide step"]');
      if (!box) return null;
      const r = box.getBoundingClientRect();
      const cs = getComputedStyle(box);
      if (r.width < 2 || r.height < 2 || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })
    .catch(() => null);
}

const runtimeIndex = (page) => page.evaluate(() => (window.ReflowEmbedRuntime?.getState?.() ? window.ReflowEmbedRuntime.getState().currentIndex : null)).catch(() => undefined);

function iou(a, b) {
  if (!a || !b) return 0;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// Drive the guide like a person: for each step wait for Reflow's highlight,
// check it sits on the right element, act with trusted input, and confirm the
// player advanced.
export async function verifyInPlayer(session, pkg, script, { outDir } = {}) {
  const page = () => session.page;
  const report = { guide: pkg.id, steps: [], startedAt: new Date().toISOString() };
  await page().goto(pkg.startUrl, { waitUntil: 'domcontentloaded' });
  await waitForSettle(session);
  await injectPlayer(page());
  await page().evaluate((g) => {
    window.ReflowEmbedRuntime.start(g, { startIndex: 0 });
    if (window.ReflowEmbedGuideUI) new window.ReflowEmbedGuideUI(window.ReflowEmbedRuntime).mount();
  }, { id: pkg.id, name: pkg.name, guide: pkg.guide, steps: pkg.steps });

  for (let k = 0; k < pkg.steps.length; k++) {
    const step = pkg.steps[k];
    const sStep = script.steps.find((s) => `${pkg.id}-s${s.i}` === step.id);
    const rec = { order: step.order, title: step.title, actionType: step.actionType };
    // After a full navigation the page lost the injected player; re-inject (it re-hydrates).
    await injectPlayer(page());
    let box = null;
    for (let t = 0; t < 40 && !box; t++) {
      box = await overlayBox(page());
      if (!box) await sleep(150);
    }
    const hit = sStep?.bundle ? await resolveBundle(page(), sStep.bundle, { timeoutMs: 6000 }) : null;
    const truth = hit ? await hit.locator.boundingBox() : null;
    rec.highlighted = !!box;
    rec.iou = Number(iou(box, truth).toFixed(2));
    rec.onTarget = rec.iou >= 0.5 || (!!box && !!truth && contains(box, truth));
    const before = await runtimeIndex(page());
    if (step.recorderMode === 'ghost') {
      // Ghost steps are filmed but must never be executed, not even by the checker.
      rec.ghost = true;
      rec.advanced = null;
      report.steps.push(rec);
      log('reflow', `step ${step.order} ghost: highlight=${rec.highlighted} iou=${rec.iou} (not executed)`);
      break;
    }
    try {
      if (!hit) throw new Error('reference element not found');
      if (step.actionType === 'click') await hit.locator.click({ timeout: 6000 });
      else if (step.actionType === 'input') {
        // Same input semantics as verify and film: focus, clear, type.
        await hit.locator.click({ timeout: 6000 });
        await hit.locator.fill('');
        await hit.locator.pressSequentially(step.inputValue || '', { delay: 0 });
      } else if (step.actionType === 'select') {
        // Choose with trusted keyboard input like a person; the player ignores
        // synthetic change events (isTrusted=false) by design.
        const { from, to } = await hit.locator.evaluate((el, want) => {
          const idx = [...el.options].findIndex((o) => o.value === want.value || o.label === want.label);
          return { from: el.selectedIndex, to: idx };
        }, step.selectOption);
        if (to < 0) throw new Error(`option ${step.selectOption.label} not found`);
        await hit.locator.focus();
        const key = to > from ? 'ArrowDown' : 'ArrowUp';
        for (let n = 0; n < Math.abs(to - from); n++) await page().keyboard.press(key);
        await page().keyboard.press('Tab');
      }
    } catch (err) {
      rec.error = err.message.split('\n')[0];
    }
    await waitForSettle(session, { maxMs: 6000 });
    await injectPlayer(page());
    let after = await runtimeIndex(page());
    for (let t = 0; t < 20 && after === before; t++) {
      await sleep(150);
      after = await runtimeIndex(page());
    }
    rec.indexBefore = before;
    rec.indexAfter = after;
    rec.advanced = after === null || (typeof after === 'number' && typeof before === 'number' && after > before);
    report.steps.push(rec);
    log('reflow', `step ${step.order} ${step.actionType} highlight=${rec.highlighted} iou=${rec.iou} advanced=${rec.advanced}${rec.error ? ' err=' + rec.error : ''}`);
  }
  report.finishedAt = new Date().toISOString();
  report.highlightRate = report.steps.filter((s) => s.onTarget).length / Math.max(1, report.steps.length);
  report.advanceRate = report.steps.filter((s) => s.advanced).length / Math.max(1, report.steps.length);
  const executed = report.steps.filter((x) => !x.ghost);
  report.errors = report.steps.filter((x) => x.error).length;
  // Finished = every executed step was on target, advanced by the user's own
  // action and error-free, and the player ended the run (or stopped at a ghost).
  report.endedAtGhost = !!report.steps.at(-1)?.ghost;
  report.completed =
    report.errors === 0 &&
    report.steps.length === pkg.steps.length &&
    executed.every((x) => x.advanced && x.onTarget) &&
    (report.endedAtGhost || report.steps.at(-1)?.indexAfter === null);
  if (outDir) writeJson(path.join(outDir, 'player-check.json'), report);
  return report;
}

function contains(outer, inner) {
  return outer.x <= inner.x + 2 && outer.y <= inner.y + 2 && outer.x + outer.width >= inner.x + inner.width - 2 && outer.y + outer.height >= inner.y + inner.height - 2;
}
