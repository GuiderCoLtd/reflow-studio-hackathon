// Computer-use performer: Muse Spark looks at screenshots and answers with pixel
// actions through the native computer tool. The model never touches the browser;
// this harness executes each action, puts it through the safety gate, and turns
// the pixel into a real element with a verified locator bundle. The output is the
// same trace the snapshot agent writes, so compile, replay and film stay unchanged.
import path from 'node:path';
import { waitForSettle } from './browser.mjs';
import { buildBundle } from './locators.mjs';
import { decide } from './safety.mjs';
import { finishTrace, summarizeStep } from './perform.mjs';
import { callComputer, callJSON, imagePart, MODELS } from './llm.mjs';
import { ensureDir, log, sleep, truncate } from './util.mjs';

const SYSTEM = `You are a computer-use agent operating a web browser to carry out one workflow, so that it can be turned into a how-to guide for end users. You receive screenshots of the browser viewport and choose the next action or actions.

Coordinates are pixels in the screenshot you were last shown: (0, 0) is the top-left. Click the center of the target element.

Return a short batch of actions only when they do not depend on intermediate visual feedback, such as click, type, and keypress. Do not batch across page loads, searches, modal transitions, or any step where the next action depends on a new screenshot. Use wait when the page is loading or an action needs time to take effect.

Follow the most natural path a typical user would take through the visible UI: menus, buttons, links. Do not use keyboard shortcuts or Tab to reach an element when a person would click it. Keys are only for Enter to submit a field, Escape to close a popup, or editing text. To replace the text of a field, click it and type the new value; the harness clears nothing for you, so select the old text first when one is present. Use the provided sample data for inputs and never invent personal data beyond it.

Next to each screenshot you get the list of controls on screen, including what icon-only controls do. Each entry's x,y is already on the scale your click action uses: to click a listed control, copy its x,y into the action as they are. Use the image to understand the page and for anything not listed.

You may also get a note. A note saying an action was blocked means it was not performed: choose another path, or finish.

Finish by replying with a normal message that starts with "DONE:" when the goal is visibly complete on screen, or "INFEASIBLE:" with a short explanation when it cannot be done because of missing permissions, unavailable UI, ambiguity, or repeated lack of progress. Do not guess hidden UI state and do not claim completion unless the screenshot supports it. If a target is not visible, scroll or request a new screenshot before clicking.`;

// Calibrated on Muse Spark 1.3 with a known target: 1280x720 lands within 2px on
// both axes, while 1440x810 drifts about 3% on y. Replay and film are DOM-based,
// so they keep their own, larger viewport.
export const COMPUTER_VIEWPORT = { width: 1280, height: 720 };

// The one check code a harness may accept by policy. Anything else (prompt
// injection and the like) stops the run and goes to a person.
const POLICY_CHECK = 'computer_action_requires_confirmation';

const KEY_NAMES = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift',
};
const MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'Shift']);

function normalizeKeys(keys) {
  return (Array.isArray(keys) ? keys : [keys]).map((k) => KEY_NAMES[String(k).toLowerCase()] || String(k)).join('+');
}

const CONTROL_SELECTOR = 'a[href],button,input,select,textarea,label,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=treeitem],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true]';

// Runs in the page: every control really on top at its own center, with exact
// coordinates. Vision alone misses small or faint targets by tens of pixels (a
// "..." menu, a low-contrast save button), so the model gets these next to the image.
const LIST_CONTROLS = ({ selector, cap }) => {
  const clean = (t, n = 44) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const pointerRoots = [...document.querySelectorAll('body *')].filter((el) => getComputedStyle(el).cursor === 'pointer' && getComputedStyle(el.parentElement).cursor !== 'pointer');
  const seen = new Set();
  const out = [];
  for (const el of [...document.querySelectorAll(selector), ...pointerRoots]) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
    const x = Math.round(Math.max(0, r.left) / 2 + Math.min(innerWidth - 1, r.right) / 2);
    const y = Math.round(Math.max(0, r.top) / 2 + Math.min(innerHeight - 1, r.bottom) / 2);
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top))) continue;
    const label = clean(el.getAttribute('aria-label') || (el.labels && el.labels[0]?.textContent) || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || (typeof el.value === 'string' ? el.value : ''));
    const tag = el.tagName.toLowerCase();
    out.push({ kind: el.getAttribute('role') || ({ a: 'link', button: 'button', input: 'field', textarea: 'field', select: 'dropdown', label: 'label' })[tag] || 'clickable', label, x, y });
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return { total: out.length, items: out.slice(0, cap) };
};

async function controlList(page) {
  const list = await page.evaluate(LIST_CONTROLS, { selector: CONTROL_SELECTOR, cap: 70 }).catch(() => null);
  if (!list?.items.length) return '';
  // Measured, not documented: the model answers on a 0-1000 grid and the API scales
  // that to pixels (a copied 807,32 came back as 1032,23 at 1280x720). A value above
  // 1000 fails the whole request with a 500. So the list speaks the model's grid.
  const vp = viewportOf(page);
  const grid = (c) => `${Math.round((c.x * 1000) / vp.width)},${Math.round((c.y * 1000) / vp.height)}`;
  const lines = list.items.map((c) => `- ${c.kind} ${c.label ? JSON.stringify(c.label) : '(no label)'} @ ${grid(c)}`);
  const more = list.total > list.items.length ? `\n(${list.total - list.items.length} more not listed; scroll or use the image)` : '';
  return `CONTROLS ON SCREEN NOW (kind, label @ x,y):\n${lines.join('\n')}${more}`;
}

// Runs in the page: find what a pixel (or the keyboard focus) really points at,
// tag it so a locator can reach it, and say what kind of control it is.
const INSPECT = ({ x, y, mark, focused, selector }) => {
  const deepest = () => {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const controlFor = (el) => {
    const hit = el.closest(selector);
    if (hit) return hit;
    // A plain div with a click handler: take the outermost pointer-cursor ancestor nearby.
    let last = null;
    let cur = el;
    for (let d = 0; cur && cur !== document.body && d < 6; d++, cur = cur.parentElement) {
      if (getComputedStyle(cur).cursor === 'pointer') last = cur;
    }
    return last || el;
  };
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'input') return { button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', search: 'searchbox', number: 'spinbutton', range: 'slider' }[type] || 'textbox';
    return null;
  };
  let el;
  let clickable = true;
  if (focused) {
    el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
  } else {
    const raw = deepest();
    if (!raw) return null;
    el = controlFor(raw);
    clickable = !!el.closest(selector) || getComputedStyle(el).cursor === 'pointer';
  }
  el.setAttribute('data-ag-cu', mark);
  const tag = el.tagName.toLowerCase();
  const clean = (s, n = 120) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const labels = el.labels ? [...el.labels].map((l) => clean(l.textContent, 80)).filter(Boolean) : [];
  const type = (el.getAttribute('type') || '').toLowerCase();
  return {
    tag,
    clickable,
    role: el.getAttribute('role') || implicitRole(el),
    fallbackName: clean(el.getAttribute('aria-label') || labels[0] || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || ''),
    editable: !!el.isContentEditable || tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'image'].includes(type)) || ['textbox', 'searchbox'].includes(el.getAttribute('role')),
    isSelect: tag === 'select',
    options: tag === 'select' ? [...el.options].map((o) => o.label || o.text).slice(0, 60) : null,
    isFrame: tag === 'iframe',
  };
};

// Playwright's own computed name is what getByRole will match during replay.
async function accessibleName(loc, info) {
  if (!info.role) return info.fallbackName;
  const first = (await loc.ariaSnapshot({ timeout: 1500 }).catch(() => '')).split('\n')[0] || '';
  const m = first.match(/^- ([a-zA-Z]+)(?: ("(?:[^"\\]|\\.)*"))?/);
  if (m && m[1] === info.role && m[2]) {
    try {
      return JSON.parse(m[2]);
    } catch {
      /* fall through */
    }
  }
  return info.fallbackName;
}

async function inspect(page, { x = 0, y = 0, focused = false } = {}) {
  const mark = `agc${Math.random().toString(36).slice(2, 8)}`;
  const info = await page.evaluate(INSPECT, { x, y, mark, focused, selector: CONTROL_SELECTOR }).catch(() => null);
  if (!info) return null;
  const loc = page.locator(`[data-ag-cu="${mark}"]`).first();
  const name = await accessibleName(loc, info);
  let bundle = null;
  try {
    bundle = await buildBundle(page, loc, { role: info.role, name });
  } catch {
    /* the element can vanish between the pixel and the probe */
  }
  await loc.evaluate((el) => el.removeAttribute('data-ag-cu')).catch(() => {});
  return { ...info, role: info.role || 'generic', name, bundle };
}

// Icon-only controls have no text for the gate or the guide to read, so ask the
// model what the control looks like. Results are cached per element within a run.
async function visualLabel(page, target, cache) {
  const rect = target.bundle?.describe?.rect;
  const key = target.bundle?.describe?.css;
  if (!rect || rect.width * rect.height > 90_000) return '';
  if (key && cache.has(key)) return cache.get(key);
  const vp = viewportOf(page);
  const m = 48;
  const clip = { x: Math.max(0, rect.x - m), y: Math.max(0, rect.y - m) };
  clip.width = Math.min(vp.width - clip.x, rect.width + m * 2);
  clip.height = Math.min(vp.height - clip.y, rect.height + m * 2);
  let label = '';
  try {
    const img = await page.screenshot({ type: 'jpeg', quality: 85, clip });
    const out = await callJSON({
      model: MODELS.agent,
      effort: 'low',
      system: 'You name web UI controls from a crop of a screenshot. The control sits in the center of the crop and has no readable label in its markup.',
      user: 'In a few English words, what does this control do? Name the action, for example "Delete task" or "Open settings". If you cannot tell, return an empty label.',
      images: [imagePart(img, 'high')],
      schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
      name: 'control_label',
      label: 'label-control',
    });
    label = truncate(out.label || '', 60);
  } catch (err) {
    log('computer', `could not label control: ${err.message.split('\n')[0]}`);
  }
  if (key) cache.set(key, label);
  return label;
}

function captionFor(step, lang) {
  const name = step.target?.name || step.target?.text || '';
  const q = name ? `'${truncate(name, 40)}'` : '';
  if (lang === 'ko') {
    return { click: `${q} 클릭`, double_click: `${q} 더블클릭`, fill: `${q}에 입력`, select_option: `${q}에서 선택`, press_key: `${step.args.key} 키 누르기`, hover: `${q}에 마우스 올리기` }[step.tool] || '';
  }
  return { click: `Click ${q}`, double_click: `Double-click ${q}`, fill: `Fill ${q}`, select_option: `Choose in ${q}`, press_key: `Press ${step.args.key}`, hover: `Hover ${q}` }[step.tool] || '';
}

const viewportOf = (page) => page.viewportSize() || COMPUTER_VIEWPORT;

const visibleControls = (page) =>
  page
    .evaluate(() => [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=menuitem],[role=link],[role=option]')].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').length)
    .catch(() => 0);

export async function performComputerUse(session, workflow, {
  outDir,
  lang = 'ko',
  siteMode = 'sandbox',
  siteBrief = '',
  model = MODELS.agent,
  effort = 'medium',
  maxSteps = 30,
} = {}) {
  ensureDir(outDir);
  const shotsDir = ensureDir(path.join(outDir, 'shots'));
  const allowed = workflow.allowed_effects || [];
  const steps = [];
  const approvals = [];
  const still = (page, file) => (session.stillShot ? session.stillShot(file) : page.screenshot({ path: file, type: 'jpeg', quality: 90 })).catch(() => {});
  // What the model sees is always CSS-pixel sized; an adopted tab supplies its own capture.
  const screenshot = async (page) => `data:image/png;base64,${(session.modelShot ? await session.modelShot(page) : await page.screenshot({ type: 'png', scale: 'css' })).toString('base64')}`;
  const labelCache = new Map();
  const startedAt = Date.now();
  let seq = 0;
  let final = null;
  session.dialogPolicy = () => 'accept';

  if (workflow.start_url) {
    await session.page.goto(workflow.start_url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForSettle(session);
  }

  const openStep = async (tool, args, target = null, extra = {}) => {
    seq++;
    const page = session.page;
    const step = {
      index: seq,
      tool,
      args,
      caption: '',
      intent: '',
      guideStep: !['scroll', 'go_back', 'drag', 'raw_type', 'raw_click'].includes(tool),
      urlBefore: page.url(),
      status: 'ok',
      startedAt: Date.now(),
      dialogMark: session.dialogs.length,
      ...extra,
    };
    if (target) {
      step.target = { role: target.role, name: target.name, text: target.bundle?.describe?.text || '', container: target.bundle?.describe?.container || null };
      step.bundle = target.bundle;
      step.box = target.bundle?.describe?.rect;
    }
    step.caption = captionFor(step, lang);
    const before = path.join(shotsDir, `${String(seq).padStart(2, '0')}-before.jpg`);
    await still(page, before);
    step.shotBefore = path.basename(before);
    return step;
  };

  const closeStep = async (step, t0) => {
    await waitForSettle(session);
    const p = session.page; // a new tab may have become active
    step.urlAfter = p.url();
    step.network = session.net.since(t0).map(({ method, url, status, mutating, type }) => ({ method, url, status, mutating, type }));
    step.dialogs = session.dialogs.slice(step.dialogMark);
    delete step.dialogMark;
    const after = path.join(shotsDir, `${String(step.index).padStart(2, '0')}-after.jpg`);
    await still(p, after);
    step.shotAfter = path.basename(after);
    step.finishedAt = Date.now();
    steps.push(step);
  };

  // Every effect goes through the same gate the snapshot agent uses.
  const gate = (tool, target, key) =>
    // A control's name is its action; the text inside it can be a whole tooltip ("invite link...").
    decide({ mode: 'perform', siteMode, allowed, action: { tool, role: target?.role, name: target?.name || key, text: target?.name ? '' : target?.bundle?.describe?.text || target?.visual, container: target?.bundle?.describe?.container } });

  const refused = (step, safety, notes) => {
    step.safety = safety;
    if (safety.decision === 'block') {
      step.status = 'blocked';
      delete step.dialogMark;
      steps.push(step);
      notes.push(`Blocked by policy, not performed: ${safety.reason}`);
      return { executed: false, stop: true, blocked: true };
    }
    step.status = 'ghost';
    step.ghost = true;
    delete step.dialogMark;
    steps.push(step);
    notes.push(`Recorded but not executed on live data: ${safety.reason} Continue as if it happened, or finish.`);
    return { executed: false, stop: true };
  };

  // A focus click or select-all right before typing is part of the same fill.
  const absorbFocusSteps = (css) => {
    while (steps.length) {
      const s = steps.at(-1);
      const effect = (s.network || []).some((n) => n.mutating) || s.urlAfter !== s.urlBefore;
      const same = s.tool === 'click' ? s.bundle?.describe?.css === css : s.tool === 'press_key' && s.focus?.bundle?.describe?.css === css && /^(Control\+|Meta\+|Backspace|Delete)/.test(s.args.key);
      if (!same || effect || s.status !== 'ok') return;
      steps.pop();
    }
  };

  const clickAt = async (action, notes) => {
    const page = session.page;
    const { x, y } = action;
    const vp = viewportOf(page);
    if (!(x >= 0 && y >= 0 && x < vp.width && y < vp.height)) {
      notes.push('Those coordinates are outside the screen.');
      return { executed: false, stop: true };
    }
    const button = action.button || 'left';
    if (button === 'back' || button === 'forward') return navigateHistory(button, notes);
    // Pointer first: hover-reveal controls only exist under the cursor.
    await page.mouse.move(x, y).catch(() => {});
    await sleep(80);
    const target = await inspect(page, { x, y });
    const isDouble = action.type === 'double_click';
    if (target?.isFrame || button !== 'left') {
      const step = await openStep('raw_click', { x, y, button }, target);
      const t0 = Date.now();
      if (button !== 'left') await page.mouse.click(x, y, { button: button === 'wheel' ? 'middle' : button });
      else await page.mouse.click(x, y);
      await closeStep(step, t0);
      if (target?.isFrame) notes.push('That click landed inside an embedded frame; it was performed but cannot be replayed in the guide.');
      return { executed: true };
    }
    if (target?.isSelect) {
      // A native select popup is drawn by the OS and never shows up in a screenshot.
      await page.evaluate(({ x: px, y: py }) => document.elementFromPoint(px, py)?.closest('select')?.focus(), { x, y }).catch(() => {});
      notes.push(`That is a native dropdown ("${truncate(target.name, 40)}") whose popup is not visible in screenshots. It now has focus. Options: ${target.options.map((o) => JSON.stringify(o)).join(', ')}. To choose one, use a type action with the exact option text.`);
      return { executed: true, stop: true };
    }
    if (target && !target.name && !target.bundle?.describe?.text) target.visual = await visualLabel(page, target, labelCache);
    const tool = isDouble ? 'double_click' : 'click';
    const step = await openStep(tool, { x, y }, target);
    if (target?.visual) {
      step.target.text = target.visual;
      step.target.visualLabel = true;
      step.caption = captionFor(step, lang);
    }
    // A pixel on plain content triggers nothing, and the text of a whole page section
    // must not read as an action ("게시" inside a task list is not a publish button).
    const safety = target && !target.clickable ? { decision: 'allow', category: 'plain', label: '' } : gate('click', target);
    step.safety = safety;
    if (safety.decision !== 'allow') return refused(step, safety, notes);
    const t0 = Date.now();
    try {
      if (isDouble) await page.mouse.dblclick(x, y);
      else await page.mouse.click(x, y);
    } catch (err) {
      step.status = 'error';
      step.error = err.message.split('\n')[0].slice(0, 200);
    }
    await closeStep(step, t0);
    if (target && !target.clickable && step.urlAfter === step.urlBefore) notes.push('That click hit plain content, not a control. Check the x,y in the control list.');
    if (session.page !== page) notes.push("A new tab opened and is now the one you see. Use a click with button 'back' to return.");
    if (step.urlAfter !== step.urlBefore || session.page !== page) return { executed: true, stop: true };
    return { executed: true };
  };

  const navigateHistory = async (button, notes) => {
    const page = session.page;
    const step = await openStep('go_back', {});
    const t0 = Date.now();
    const pages = session.context.pages();
    const canBack = await page.evaluate(() => history.length > 1).catch(() => false);
    if (button === 'back' && !canBack && pages.length > 1) {
      await page.close().catch(() => {});
      session.page = pages.filter((x) => x !== page).at(-1);
      await session.page.bringToFront().catch(() => {});
      step.closedTab = true;
    } else if (button === 'back') await page.goBack({ timeout: 8000 }).catch(() => {});
    else await page.goForward({ timeout: 8000 }).catch(() => {});
    await closeStep(step, t0);
    return { executed: true, stop: true };
  };

  const typeText = async (text, notes) => {
    const page = session.page;
    const newline = /\r?\n$/.test(text);
    const body = text.replace(/\r?\n$/, '');
    const focus = await inspect(page, { focused: true });
    if (focus?.isSelect) {
      const wanted = body.trim().toLowerCase();
      const option = focus.options.find((o) => o.trim().toLowerCase() === wanted) || focus.options.find((o) => o.toLowerCase().includes(wanted));
      if (!option) {
        notes.push(`No option matches "${truncate(body, 40)}". Options: ${focus.options.map((o) => JSON.stringify(o)).join(', ')}.`);
        return { executed: false, stop: true };
      }
      const step = await openStep('select_option', { option }, focus);
      const t0 = Date.now();
      await page.evaluate((label) => {
        const el = document.activeElement;
        const o = [...el.options].find((x) => (x.label || x.text) === label);
        if (o) {
          el.value = o.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, option);
      await closeStep(step, t0);
      return { executed: true };
    }
    if (!focus?.editable) {
      const step = await openStep('raw_type', { text: truncate(body, 120) }, focus);
      const t0 = Date.now();
      await page.keyboard.type(text);
      await closeStep(step, t0);
      notes.push('No text field had focus, so those keystrokes went to the page. Click the field first.');
      return { executed: true, stop: true };
    }
    absorbFocusSteps(focus.bundle?.describe?.css);
    const step = await openStep('fill', { value: body }, focus);
    const t0 = Date.now();
    await page.keyboard.type(body);
    // Record what the field ended up holding: replay clears it and types this value.
    const value = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.isContentEditable ? el.innerText : el?.value;
    }).catch(() => null);
    if (typeof value === 'string' && value) step.args.value = value;
    await closeStep(step, t0);
    if (newline) return pressKeys('Enter', notes);
    return { executed: true };
  };

  const pressKeys = async (key, notes) => {
    const page = session.page;
    const focus = await inspect(page, { focused: true });
    const parts = key.split('+');
    const onlyEditing = parts.some((k) => MODIFIERS.has(k)) || ['Backspace', 'Delete'].includes(key);
    const step = await openStep('press_key', { key }, null, { guideStep: !onlyEditing });
    step.focus = focus ? { tag: focus.tag, role: focus.role, name: focus.name, bundle: focus.bundle } : null;
    // Enter or Space on a focused button is a click on it, so gate it as one.
    const safety = /^(Enter|Space)$/.test(key) && focus && !focus.editable ? gate('click', focus) : gate('press_key', null, key);
    step.safety = safety;
    if (safety.decision !== 'allow') return refused(step, safety, notes);
    const t0 = Date.now();
    await page.keyboard.press(key).catch((err) => {
      step.status = 'error';
      step.error = err.message.split('\n')[0].slice(0, 200);
    });
    await closeStep(step, t0);
    if (step.urlAfter !== step.urlBefore) return { executed: true, stop: true };
    return { executed: true };
  };

  const hoverAt = async ({ x, y }) => {
    const page = session.page;
    const countBefore = await visibleControls(page);
    await page.mouse.move(x, y).catch(() => {});
    await sleep(120);
    const target = await inspect(page, { x, y });
    const step = await openStep('hover', { x, y }, target);
    const t0 = Date.now();
    // A hover only belongs in the guide when it reveals something.
    step.guideStep = (await visibleControls(page)) !== countBefore;
    await closeStep(step, t0);
    return { executed: true };
  };

  const scrollAt = async ({ x = 0, y = 0, scroll_x: dx = 0, scroll_y: dy = 0 }) => {
    const page = session.page;
    const scale = Math.max(Math.abs(dx), Math.abs(dy)) < 10 ? 100 : 1; // Some turns use wheel notches rather than pixels.
    const step = await openStep('scroll', { x, y, direction: dy < 0 ? 'up' : 'down' });
    const t0 = Date.now();
    await page.mouse.move(x, y).catch(() => {});
    await page.mouse.wheel(dx * scale, dy * scale);
    await closeStep(step, t0);
    return { executed: true };
  };

  const dragPath = async ({ path: points = [] }) => {
    const page = session.page;
    if (points.length < 2) return { executed: false };
    const step = await openStep('drag', { points: points.length });
    const t0 = Date.now();
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const p of points.slice(1)) await page.mouse.move(p.x, p.y);
    await page.mouse.up();
    await closeStep(step, t0);
    return { executed: true };
  };

  const runAction = async (action, notes) => {
    switch (action.type) {
      case 'click':
      case 'double_click':
        return clickAt(action, notes);
      case 'type':
        return typeText(String(action.text ?? ''), notes);
      case 'keypress':
        return pressKeys(normalizeKeys(action.keys), notes);
      case 'move':
        return hoverAt(action);
      case 'scroll':
        return scrollAt(action);
      case 'drag':
        return dragPath(action);
      case 'wait':
        await sleep(1000);
        await waitForSettle(session);
        return { executed: true };
      case 'screenshot':
        return { executed: true };
      default:
        notes.push(`Unknown action type "${action.type}".`);
        return { executed: false, stop: true };
    }
  };

  const task = [
    `WORKFLOW: ${workflow.title}`,
    `GOAL: ${workflow.goal}`,
    workflow.success_criteria ? `SUCCESS LOOKS LIKE: ${workflow.success_criteria}` : '',
    workflow.sample_data ? `SAMPLE DATA: ${JSON.stringify(workflow.sample_data)}` : '',
    workflow.hints ? `HINTS: ${workflow.hints}` : '',
    siteBrief ? `SITE KNOWLEDGE (from prior exploration):\n${truncate(siteBrief, 6000)}` : '',
  ].filter(Boolean).join('\n\n');

  // A fresh conversation carries the work done so far as text. Two things need it:
  // the API refuses to continue past an unacknowledged safety check, and a stored
  // response can start failing with 5xx while the run itself is fine.
  const startConversation = async (note = '') => {
    const done = steps.length ? `\n\nACTIONS ALREADY DONE (continue from the current screen, do not repeat them):\n${steps.map((st, i) => `${i + 1}. ${summarizeStep(st).text}`).join('\n')}` : '';
    const controls = await controlList(session.page);
    const text = [`${task}${done}`, note && `NOTE: ${note}`, controls].filter(Boolean).join('\n\n');
    return callComputer({ model, effort, system: SYSTEM, input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: await screenshot(session.page) }] }] });
  };

  let res = await startConversation();
  let turn = 0;
  let restarts = 0;
  let lastActions = '';
  let repeats = 0;
  const MAX_RESTARTS = 3;
  for (; turn < maxSteps; turn++) {
    const call = (res.output || []).find((o) => o.type === 'computer_call');
    if (!call) {
      const text = res.output_text || '';
      final = { claimedSuccess: !/^\s*INFEASIBLE/i.test(text) && !!text, summary: truncate(text, 600), evidence: '', turn };
      break;
    }
    const checks = call.pending_safety_checks || [];
    const foreign = checks.filter((c) => c.code !== POLICY_CHECK);
    if (foreign.length) {
      approvals.push({ turn, codes: checks.map((c) => c.code), actions: call.actions, decision: 'stopped' });
      final = { claimedSuccess: false, summary: `Stopped for human review: ${foreign.map((c) => `${c.code}: ${c.message}`).join('; ')}`, evidence: '', turn };
      break;
    }
    const notes = [];
    let executed = 0;
    let blocked = false;
    const key = JSON.stringify(call.actions);
    repeats = key === lastActions ? repeats + 1 : 0;
    lastActions = key;
    for (const action of call.actions || []) {
      let out;
      try {
        out = await runAction(action, notes);
      } catch (err) {
        notes.push(`That action failed: ${err.message.split('\n')[0].slice(0, 160)}`);
        out = { executed: false, stop: true };
      }
      if (out.executed) executed++;
      if (out.blocked) blocked = true;
      if (out.stop) break;
    }
    if (repeats >= 2) notes.push('You have repeated the same action without progress. Try a different element, or finish with INFEASIBLE.');
    log('computer', `#${turn + 1} ${truncate(JSON.stringify(call.actions), 200)}${checks.length ? ` checks=${checks.length}` : ''}${blocked ? ' BLOCKED' : ''}`);
    // The gate is the review: a check is acknowledged only for actions the gate let through.
    if (checks.length) approvals.push({ turn, codes: checks.map((c) => c.code), actions: call.actions, decision: blocked ? 'declined' : 'acknowledged-by-policy', notes });
    try {
      if (blocked) {
        if (++restarts > MAX_RESTARTS) {
          final = { claimedSuccess: false, summary: `Stopped: too many blocked actions. ${notes.join(' ')}`, evidence: '', turn };
          break;
        }
        res = await startConversation(notes.join(' '));
        continue;
      }
      const controls = await controlList(session.page);
      const text = [...notes, controls].filter(Boolean).join('\n\n');
      const input = [{
        type: 'computer_call_output',
        call_id: call.call_id,
        acknowledged_safety_checks: checks,
        output: { type: 'computer_screenshot', image_url: await screenshot(session.page) },
      }];
      if (text) input.push({ role: 'user', content: [{ type: 'input_text', text }] });
      try {
        res = await callComputer({ model, effort, system: SYSTEM, input, previousResponseId: res.id });
      } catch (err) {
        if (++restarts > MAX_RESTARTS) throw err;
        log('computer', `conversation lost (${err.message.split('\n')[0].slice(0, 120)}), restarting from the current screen`);
        res = await startConversation();
      }
    } catch (err) {
      final = { claimedSuccess: false, summary: `Run ended: ${err.message.split('\n')[0].slice(0, 200)}`, evidence: '', turn };
      break;
    }
  }
  if (!final) final = { claimedSuccess: false, summary: 'Ran out of turns.', evidence: '', turn };
  steps.forEach((s, i) => {
    s.index = i + 1;
  });
  return finishTrace(session, { workflow, lang, siteMode, startedAt, model, effort, final, steps, shotsDir, outDir, extra: { executor: 'computer-use', turns: turn, restarts, approvals } });
}
