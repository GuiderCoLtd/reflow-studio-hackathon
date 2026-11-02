// Workflow performer: an LLM agent drives the browser one action at a time.
// Every action is recorded with a verified locator bundle, before/after
// screenshots, network effects and a user-facing caption, so the run can be
// compiled into a deterministic guide script afterwards.
import path from 'node:path';
import fs from 'node:fs';
import { observe, findInPage } from './observe.mjs';
import { waitForSettle } from './browser.mjs';
import { buildBundle, clickProxy } from './locators.mjs';
import { decide } from './safety.mjs';
import { callTool, callJSON, fnTool, imagePart, MODELS } from './llm.mjs';
import { ensureDir, writeJson, log, truncate } from './util.mjs';

const LANG_NAMES = { ko: 'Korean', en: 'English', ja: 'Japanese' };

function tools(lang) {
  const caption = {
    type: 'string',
    description: `One short instruction sentence for the final how-to guide, in ${LANG_NAMES[lang] || lang}. Quote UI labels exactly as shown on screen inside single quotes (never translate them).`,
  };
  const intent = { type: 'string', description: 'Why you are doing this (English, short).' };
  const guideStep = { type: 'boolean', description: 'True if a user following the guide must do this too. False for recovery, scrolling, closing popups you opened by mistake, or exploration.' };
  return [
    fnTool('click', 'Click an element.', { ref: { type: 'string' }, caption, intent, guide_step: guideStep }),
    fnTool('fill', 'Replace the content of a text field with a value.', { ref: { type: 'string' }, value: { type: 'string' }, caption, intent, guide_step: guideStep }),
    fnTool('select_option', 'Choose an option of a native <select> (combobox). For custom dropdowns click the trigger and then the option instead.', { ref: { type: 'string' }, option: { type: 'string', description: 'Visible option label' }, caption, intent, guide_step: guideStep }),
    fnTool('press_key', 'Press a key on the focused element (Enter, Escape, Tab, ArrowDown...).', { key: { type: 'string' }, caption, intent, guide_step: guideStep }),
    fnTool('hover', 'Hover an element (menus that open on hover).', { ref: { type: 'string' }, caption, intent, guide_step: guideStep }),
    fnTool('scroll', 'Scroll the page to reveal more content.', { direction: { type: 'string', enum: ['down', 'up'] }, intent }),
    fnTool('find', 'Search the whole page (including list items hidden in the snapshot summary) for elements whose text contains a query. Returns matching lines with refs you can act on next turn.', { text: { type: 'string' }, intent }),
    fnTool('go_back', 'Browser back (recovery only).', { intent }),
    fnTool('done', 'Finish. Call when the goal is achieved (and visible on screen) or clearly impossible.', {
      success: { type: 'boolean' },
      summary: { type: 'string', description: 'What was achieved, English.' },
      evidence: { type: 'string', description: 'What on screen proves it.' },
    }),
  ];
}

const SYSTEM = (lang) => `You operate a real web browser to carry out one workflow so it can be turned into a how-to guide for end users.

Rules:
- Each turn you get the current page as an accessibility snapshot. Elements you can act on carry a ref like [e12] or [f1e12]. Use only refs from the CURRENT snapshot.
- Follow the most natural path a typical user would take through the visible UI (menus, buttons, links). Do not type URLs. Prefer the primary, visible way over keyboard shortcuts or hidden tricks.
- One action per turn. After each action you see the result. If something did not work, try a different element instead of repeating the same action.
- Never move keyboard focus with Tab or arrow keys to reach an element. If an element you need is missing from the snapshot (long lists are summarised as "… more items"), call find with its visible text, or scroll. Keys are only for Enter to submit a field, Escape to close a popup, or typing.
- Use the provided sample data for inputs. Never invent personal data beyond it.
- Some actions are blocked by a safety gate; if blocked, choose another path or finish.
- Captions are for the final guide in ${LANG_NAMES[lang] || lang}: short, imperative, mention where the element is when helpful, and quote on-screen labels verbatim in single quotes.
- Call done(success=true) only when the goal is visibly achieved. Call done(success=false) if it is impossible.`;

export async function performWorkflow(session, workflow, {
  outDir,
  lang = 'ko',
  siteMode = 'sandbox',
  siteBrief = '',
  model = MODELS.agent,
  effort = 'medium',
  maxSteps = 30,
  useScreenshot = true,
} = {}) {
  ensureDir(outDir);
  const shotsDir = ensureDir(path.join(outDir, 'shots'));
  const page = () => session.page;
  const allowed = workflow.allowed_effects || [];
  const history = [];
  const steps = [];
  let final = null;
  const startedAt = Date.now();
  session.dialogPolicy = (d) => (d.type() === 'beforeunload' ? 'accept' : 'accept');

  if (workflow.start_url) {
    await page().goto(workflow.start_url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForSettle(session);
  }

  for (let turn = 1; turn <= maxSteps; turn++) {
    const obs = await observe(session);
    const shot = useScreenshot ? await page().screenshot({ type: 'jpeg', quality: 60, scale: 'css' }).catch(() => null) : null;
    const user = buildPrompt({ workflow, siteBrief, history, obs, turn, maxSteps });
    let call;
    try {
      call = await callTool({ model, effort, system: SYSTEM(lang), user, images: shot ? [imagePart(shot, 'low')] : [], tools: tools(lang), label: 'perform' });
    } catch (err) {
      history.push({ turn, note: `model error: ${err.message}` });
      continue;
    }
    const { name: tool, args } = call;
    log('perform', `#${turn} ${tool}`, truncate(JSON.stringify(args), 220));

    if (tool === 'done') {
      final = { claimedSuccess: !!args.success, summary: args.summary, evidence: args.evidence, turn };
      break;
    }
    if (tool === 'find') {
      const res = await findInPage(session, args.text);
      history.push({ turn, text: `find "${truncate(args.text, 40)}" → ${res.hits.length} match(es):\n${res.hits.map((h) => indentLines(h, 6)).join('\n') || '      (none)'}` });
      continue;
    }
    const step = await executeAction(session, { tool, args, obs, allowed, siteMode, shotsDir, index: steps.length + 1 });
    steps.push(step);
    history.push(summarizeStep(step));
  }

  return finishTrace(session, { workflow, lang, siteMode, startedAt, model, effort, final, steps, shotsDir, outDir });
}

// Independent judge: did the run reach the goal? Shared by every executor, so
// a run is held to the same bar whichever way the browser was driven.
export async function finishTrace(session, { workflow, lang, siteMode, startedAt, model, effort, final, steps, shotsDir, outDir, extra = {} }) {
  const page = () => session.page;
  const finalObs = await observe(session);
  const finalShotPath = path.join(shotsDir, 'final.jpg');
  await page().screenshot({ path: finalShotPath, type: 'jpeg', quality: 80 }).catch(() => {});
  const actionsText = steps.map((s, i) => `${i + 1}. ${summarizeStep(s).text}`).join('\n');
  // Before/after evidence: the screen right before the first edit shows the starting state.
  const firstEdit = steps.find((s) => (s.tool === 'fill' || s.tool === 'select_option') && s.shotBefore);
  const beforeShot = firstEdit ? path.join(shotsDir, firstEdit.shotBefore) : null;
  const keyShots = steps
    .filter((s) => s.shotAfter && s.urlAfter && s.urlAfter !== s.urlBefore)
    .slice(0, -1)
    .map((s) => ({ path: path.join(shotsDir, s.shotAfter), label: `after step ${s.index}: ${pathOfUrl(s.urlAfter)}` }));
  const verdict = await judge({ workflow, actionsText, final, obs: finalObs, shotPath: finalShotPath, net: session.net.since(startedAt), beforeShot, keyShots });
  const trace = {
    workflow,
    lang,
    siteMode,
    startedAt,
    finishedAt: Date.now(),
    model,
    effort,
    final,
    verdict,
    steps,
    finalUrl: finalObs.url,
    ...extra,
  };
  writeJson(path.join(outDir, 'trace.json'), trace);
  return trace;
}

// Map planner effects to the safety categories the workflow may trigger.
export function allowedFromEffects(effects = []) {
  const out = new Set();
  for (const e of effects) {
    if (e === 'create' || e === 'update' || e === 'settings') out.add('submit');
    // Sharing changes who can see something: a settings/update approval covers it.
    if (e === 'settings' || e === 'update') out.add('share');
    if (e === 'send') {
      out.add('send');
      out.add('submit');
    }
    if (e === 'delete') out.add('delete');
  }
  return [...out];
}

// Normalize a catalog entry (plan.mjs) into what the performer expects.
export function workflowFromCatalog(w, summaries = []) {
  const start = summaries.find((s) => s.id === w.start_screen) || (w.start_url ? { url: w.start_url } : summaries[0]);
  const sample = Object.fromEntries((w.sample_data || []).map((d) => [d.field, d.value]));
  return {
    id: w.id,
    title: w.title,
    title_en: w.title_en,
    goal: w.goal,
    success_criteria: w.success_criteria,
    sample_data: sample,
    hints: [w.path_hint && `Likely path: ${w.path_hint}`, w.preconditions && `Preconditions: ${w.preconditions}`].filter(Boolean).join('\n'),
    start_url: start?.url,
    effects: w.effects,
    allowed_effects: allowedFromEffects(w.effects),
    evidence: w.evidence,
  };
}

function buildPrompt({ workflow, siteBrief, history, obs, turn, maxSteps }) {
  const hist = history.length
    ? history.map((h, i) => `${i + 1}. ${h.text || h.note}`).join('\n')
    : '(none yet)';
  return [
    `WORKFLOW: ${workflow.title}`,
    `GOAL: ${workflow.goal}`,
    workflow.success_criteria ? `SUCCESS LOOKS LIKE: ${workflow.success_criteria}` : '',
    workflow.sample_data ? `SAMPLE DATA: ${JSON.stringify(workflow.sample_data)}` : '',
    workflow.hints ? `HINTS: ${workflow.hints}` : '',
    siteBrief ? `SITE KNOWLEDGE (from prior exploration):\n${siteBrief}` : '',
    `ACTIONS SO FAR:\n${hist}`,
    stuckNote(history),
    `TURN ${turn}/${maxSteps}`,
    `CURRENT PAGE: ${obs.url}  title="${obs.title}"`,
    `SNAPSHOT:\n${obs.snapshot}`,
  ].filter(Boolean).join('\n\n');
}

function indentLines(text, n) {
  return String(text)
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n');
}

async function focusedTarget(page) {
  const mark = `agf${Math.random().toString(36).slice(2, 8)}`;
  const info = await page
    .evaluate((m) => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      el.setAttribute('data-ag-focus', m);
      return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || ({ a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox' })[el.tagName.toLowerCase()] || 'generic', name: (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
    }, mark)
    .catch(() => null);
  if (!info) return null;
  const loc = page.locator(`[data-ag-focus="${mark}"]`);
  const bundle = await buildBundle(page, loc, { role: info.role, name: info.name }).catch(() => null);
  await loc.evaluate((el) => el.removeAttribute('data-ag-focus')).catch(() => {});
  return { ...info, bundle };
}

function stuckNote(history) {
  const recent = history.slice(-6).map((h) => h.text || '');
  const failing = recent.filter((t) => /\[(error|blocked)/.test(t)).length;
  const keyboard = recent.filter((t) => t.startsWith('press_key')).length;
  if (failing >= 3 || keyboard >= 4) {
    return 'NOTE: the last actions are not making progress. Do not work around the UI with keyboard focus tricks; pick a different visible element a person would click, or call done(success=false) and explain the blocker.';
  }
  return '';
}

export function summarizeStep(s) {
  const tgt = s.target ? `${s.target.role} '${truncate(s.target.name, 50)}'` : '';
  const val = s.args.value !== undefined ? ` = "${truncate(s.args.value, 40)}"` : s.args.option ? ` = '${s.args.option}'` : s.args.key ? ` ${s.args.key}` : '';
  const net = s.network?.filter((n) => n.mutating).map((n) => `${n.method} ${new URL(n.url).pathname} ${n.status}`).slice(0, 3).join(', ');
  const outcome = s.status === 'ok' ? 'ok' : `${s.status}: ${s.error || s.safety?.reason || ''}`;
  const moved = s.urlAfter && s.urlAfter !== s.urlBefore ? ` → ${pathOf(s.urlAfter)}` : '';
  const dlg = s.dialogs?.length ? ` dialog:"${truncate(s.dialogs[0].message, 60)}"` : '';
  return { text: `${s.tool} ${tgt}${val}${moved} [${outcome}]${net ? ` net: ${net}` : ''}${dlg}` };
}

function pathOfUrl(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

function pathOf(u) {
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash;
  } catch {
    return u;
  }
}

async function executeAction(session, { tool, args, obs, allowed, siteMode, shotsDir, index }) {
  const page = session.page;
  const step = {
    index,
    tool,
    args,
    caption: args.caption || '',
    intent: args.intent || '',
    guideStep: args.guide_step !== false && !['scroll', 'go_back'].includes(tool),
    urlBefore: page.url(),
    status: 'ok',
    startedAt: Date.now(),
  };
  const dialogMark = session.dialogs.length;
  let locator = null;
  if (args.ref) {
    const info = obs.refs.get(args.ref);
    if (!info) {
      step.status = 'error';
      step.error = `ref ${args.ref} is not in the current snapshot`;
      return step;
    }
    step.target = { ref: args.ref, role: info.role, name: info.name };
    locator = info.selector ? page.locator(info.selector).first() : page.locator(`aria-ref=${args.ref}`);
    // SPA frameworks re-render while the model is thinking; a ref from the
    // snapshot can point at a detached node. Re-resolve by role and name.
    const fresh = async () => {
      if (info.selector) return null;
      const alt = page.getByRole(info.role, info.name ? { name: info.name, exact: true } : {});
      const n = await alt.count().catch(() => 0);
      for (let k = 0; k < n; k++) if (await alt.nth(k).isVisible().catch(() => false)) return alt.nth(k);
      return null;
    };
    if (!(await locator.count().catch(() => 0))) {
      const alt = await fresh();
      if (alt) {
        locator = alt;
        step.reResolved = true;
      }
    }
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(async (err) => {
        const alt = await fresh();
        if (!alt) throw err;
        locator = alt;
        step.reResolved = true;
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
      });
      step.bundle = await buildBundle(page, locator, info);
      step.target.text = step.bundle.describe.text;
      step.target.container = step.bundle.describe.container;
      step.box = step.bundle.describe.rect;
    } catch (err) {
      step.status = 'error';
      step.error = `could not inspect element: ${err.message.split('\n')[0]}`;
      return step;
    }
  }
  const safety = decide({
    mode: 'perform',
    siteMode,
    allowed,
    action: { tool, role: step.target?.role, name: step.target?.name || args.key, text: step.target?.text, container: step.target?.container },
  });
  step.safety = safety;
  const beforePath = path.join(shotsDir, `${String(index).padStart(2, '0')}-before.jpg`);
  await page.screenshot({ path: beforePath, type: 'jpeg', quality: 80 }).catch(() => {});
  step.shotBefore = path.basename(beforePath);
  if (safety.decision === 'block') {
    step.status = 'blocked';
    return step;
  }
  if (safety.decision === 'ghost') {
    step.status = 'ghost';
    step.ghost = true;
    return step;
  }
  const t0 = Date.now();
  try {
    switch (tool) {
      case 'click':
        try {
          await locator.click({ timeout: 5000 });
        } catch (err) {
          // Styled controls hide the real input behind a label or overlay.
          // Click what a person would click and record that element instead.
          const proxy = await clickProxy(page, locator);
          if (!proxy) throw err;
          await proxy.click({ timeout: 5000 });
          step.bundle = await buildBundle(page, proxy, {});
          step.target = { ...step.target, proxyFor: step.target?.name, text: step.bundle.describe.text, container: step.bundle.describe.container };
          step.box = step.bundle.describe.rect;
          step.proxy = true;
        }
        break;
      case 'fill': {
        // Type like a person (same semantics as verify and film): typeahead
        // and validation listeners only react to real key input.
        const text = String(args.value ?? '');
        await locator.click({ timeout: 8000 }).catch(() => {});
        await locator.fill('', { timeout: 8000 });
        if (text.length > 400) await locator.fill(text, { timeout: 8000 });
        else await locator.pressSequentially(text, { delay: 0 });
        break;
      }
      case 'select_option':
        await locator.selectOption({ label: args.option }, { timeout: 8000 }).catch(async () => locator.selectOption(args.option, { timeout: 4000 }));
        break;
      case 'press_key': {
        // Remember what had focus: Enter on a focused link/button is really a click.
        step.focus = await focusedTarget(page);
        await page.keyboard.press(args.key);
        break;
      }
      case 'hover':
        await locator.hover({ timeout: 8000 });
        break;
      case 'scroll':
        await page.mouse.wheel(0, args.direction === 'up' ? -600 : 600);
        break;
      case 'go_back': {
        // A link that opened a new tab (file preview, external page) has no
        // history to go back to: close that tab and return to the one before.
        const pages = session.context.pages();
        const canBack = await page.evaluate(() => history.length > 1).catch(() => false);
        if (!canBack && pages.length > 1) {
          await page.close().catch(() => {});
          session.page = pages.filter((x) => x !== page).at(-1);
          await session.page.bringToFront().catch(() => {});
          step.closedTab = true;
        } else {
          await page.goBack({ timeout: 8000 }).catch(() => {});
        }
        break;
      }
      default:
        throw new Error(`unknown tool ${tool}`);
    }
  } catch (err) {
    step.status = 'error';
    step.error = err.message.split('\n')[0].slice(0, 200);
  }
  await waitForSettle(session);
  const p = session.page; // a new tab may have become active
  step.urlAfter = p.url();
  step.network = session.net.since(t0).map(({ method, url, status, mutating, type }) => ({ method, url, status, mutating, type }));
  step.dialogs = session.dialogs.slice(dialogMark);
  const afterPath = path.join(shotsDir, `${String(index).padStart(2, '0')}-after.jpg`);
  await p.screenshot({ path: afterPath, type: 'jpeg', quality: 80 }).catch(() => {});
  step.shotAfter = path.basename(afterPath);
  step.finishedAt = Date.now();
  return step;
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    confidence: { type: 'number', description: '0..1' },
    reason: { type: 'string' },
    end_state: { type: 'string', description: 'One sentence describing what the final screen shows.' },
  },
  required: ['success', 'confidence', 'reason', 'end_state'],
  additionalProperties: false,
};

export async function judge({ workflow, actionsText, final, obs, shotPath, net, beforeShot = null, keyShots = [] }) {
  const actions = actionsText;
  const mutations = net.filter((n) => n.mutating).map((n) => `${n.method} ${n.url} -> ${n.status}`).slice(-15).join('\n') || '(none)';
  const images = fs.existsSync(shotPath) ? [imagePart(fs.readFileSync(shotPath), 'high')] : [];
  // Screens the run passed through (e.g. a list before its detail page), oldest first.
  const visited = keyShots.filter((k) => k?.path && fs.existsSync(k.path)).slice(-2);
  for (const k of [...visited].reverse()) images.unshift(imagePart(fs.readFileSync(k.path), 'high'));
  if (beforeShot && fs.existsSync(beforeShot)) images.unshift(imagePart(fs.readFileSync(beforeShot), 'high'));
  const imageNote = [
    beforeShot ? 'the first image is the screen right BEFORE the first edit (starting state)' : null,
    visited.length ? `${visited.length} image(s) before the last are screens visited during the run (${visited.map((k) => k.label).join('; ')})` : null,
    'the last image is the FINAL screen',
  ].filter(Boolean);
  return callJSON({
    model: MODELS.judge,
    effort: 'medium',
    system: 'You are a strict QA reviewer. Decide whether a browser agent actually completed the workflow goal, using the final screenshot, the final accessibility snapshot, the action log and the network mutations as evidence. A claim without on-screen or network evidence is not success.',
    user: `${imageNote.length > 1 ? `IMAGES: ${imageNote.join('; ')}.\n` : ''}WORKFLOW: ${workflow.title}\nGOAL: ${workflow.goal}\nSUCCESS LOOKS LIKE: ${workflow.success_criteria || '(not given)'}\nAGENT CLAIM: ${final ? JSON.stringify(final) : 'agent ran out of turns'}\n\nACTIONS:\n${actions}\n\nNETWORK MUTATIONS:\n${mutations}\n\nFINAL URL: ${obs.url}\nFINAL SNAPSHOT:\n${truncate(obs.snapshot, 8000)}`,
    images,
    schema: JUDGE_SCHEMA,
    name: 'verdict',
    label: 'judge',
  });
}
