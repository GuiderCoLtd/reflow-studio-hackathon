// Deterministic replay of a compiled guide script — no LLM decides anything.
// mode 'verify': run fast and report which steps resolved and acted.
// mode 'film'  : stop-motion capture. Instead of recording the screen in real
//                time (CDP screencast is capped at CSS resolution and drops
//                frames), take a full-DPR still at every visual beat: idle,
//                hover, each typed character, a short burst after the action,
//                and the settled result. The renderer rebuilds time, cursor
//                motion and camera from these beats, so network jitter never
//                reaches the video.
import path from 'node:path';
import { waitForSettle } from './browser.mjs';
import { resolveBundle, clickProxy } from './locators.mjs';
import { ensureDir, writeJson, sleep, log } from './util.mjs';

const now = () => Date.now() / 1000;

function centerOf(box) {
  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 24) };
}

// The surrounding UI block (dialog, form, menu, card) gives the camera context.
async function contextRect(loc) {
  return loc
    .evaluate((el) => {
      const sel = '[role=dialog],dialog,[role=alertdialog],[role=menu],[role=listbox],form,fieldset,section,article,[class*=modal],[class*=card],[class*=segment],[class*=panel]';
      const vw = innerWidth;
      const vh = innerHeight;
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        if (cur.matches(sel)) {
          const r = cur.getBoundingClientRect();
          if (r.width * r.height < vw * vh * 0.85 && r.width > 40 && r.height > 20) return { x: r.x, y: r.y, width: r.width, height: r.height, kind: cur.getAttribute('role') || cur.tagName.toLowerCase() };
        }
        cur = cur.parentElement;
      }
      return null;
    })
    .catch(() => null);
}

function makeCamera(session, dir) {
  let n = 0;
  // A shot can fail while the page is navigating; retry once, otherwise
  // return null so no timeline entry points at a missing file.
  return async function shoot(kind) {
    const file = `s${String(n + 1).padStart(4, '0')}-${kind}.jpg`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = now();
      const ok = await session.page.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: 92 }).then(() => true, () => false);
      if (ok) {
        n++;
        return { f: file, kind, t };
      }
      await sleep(200);
    }
    return null;
  };
}

// Capture frames while the page reacts to an action, until it settles.
async function burst(session, shoot, { maxFrames = 8, maxMs = 2500 } = {}) {
  const frames = [];
  const t0 = Date.now();
  let quiet = 0;
  while (frames.length < maxFrames && Date.now() - t0 < maxMs) {
    const shot = await shoot('burst');
    if (shot) frames.push(shot);
    await sleep(60);
    const busy = session.net.inflightCount > 0;
    quiet = busy ? 0 : quiet + 1;
    if (quiet >= 3 && frames.length >= 3) break;
  }
  return frames;
}

export async function replayScript(session, script, { mode = 'verify', outDir, onTarget = null } = {}) {
  const film = mode === 'film';
  const page = () => session.page;
  const framesDir = film ? ensureDir(path.join(outDir, 'frames')) : null;
  const shoot = film ? makeCamera(session, framesDir) : null;
  session.dialogPolicy = () => 'accept';
  const results = [];

  await page().goto(script.start_url, { waitUntil: 'domcontentloaded' });
  await waitForSettle(session);
  const vp = page().viewportSize();
  const opening = film ? await shoot('opening') : null;
  const tStart = now();

  for (const step of script.steps) {
    const r = { i: step.i, action: step.action, status: 'ok', urlBefore: page().url(), frames: {} };
    r.tStart = now();
    try {
      let loc = null;
      if (step.bundle) {
        const hit = await resolveBundle(page(), step.bundle, { timeoutMs: 10000 });
        if (!hit) throw new Error('target not found');
        loc = hit.locator;
        r.via = hit.via.kind + (hit.via.scope ? '@' + hit.via.scope.role : '');
        const before = await page().evaluate(() => scrollY).catch(() => 0);
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        const after = await page().evaluate(() => scrollY).catch(() => 0);
        if (film && Math.abs(after - before) > 2) {
          await waitForSettle(session, { maxMs: 1500, networkQuietMs: 150, domQuietMs: 150 });
          r.scrolled = after - before;
        }
        const box = await loc.boundingBox();
        if (box) r.box = box;
        if (film) r.context = await contextRect(loc);
        if (onTarget) await onTarget(page(), step, loc).catch((err) => log('replay', `onTarget failed at step ${step.i}: ${err.message.split('\n')[0]}`));
      }
      if (film) r.frames.idle = await shoot('idle');
      if (film && r.box && ['click', 'fill', 'select', 'hover'].includes(step.action)) {
        const c = centerOf(r.box);
        r.cursor = c;
        await page().mouse.move(c.x, c.y);
        await sleep(160);
        r.frames.hover = await shoot('hover');
        // Hover can reflow the element (menus expand); the hover still is what the
        // viewer sees during the action, so measure the target again.
        const hb = await loc.boundingBox().catch(() => null);
        if (hb && r.box && (Math.abs(hb.x - r.box.x) > 2 || Math.abs(hb.y - r.box.y) > 2 || Math.abs(hb.width - r.box.width) > 2 || Math.abs(hb.height - r.box.height) > 2)) {
          r.boxIdle = r.box;
          r.box = hb;
        }
      }
      r.tAction = now();
      if (step.ghost) {
        r.status = 'ghost';
      } else {
        switch (step.action) {
          case 'click':
            await loc.click({ timeout: 6000 }).catch(async (err) => {
              const proxy = await clickProxy(page(), loc);
              if (!proxy) throw err;
              r.proxy = true;
              await proxy.click({ timeout: 6000 });
            });
            if (film) r.frames.burst = await burst(session, shoot);
            break;
          case 'fill': {
            const text = String(step.value ?? '');
            if (film) {
              await loc.click({ timeout: 8000 });
              await loc.fill('');
              r.frames.focus = await shoot('focus');
              // One still per typed chunk; long text is typed in larger chunks.
              const chunk = Math.max(1, Math.ceil(text.length / 28));
              r.frames.typing = [];
              for (let k = 0; k < text.length; k += chunk) {
                await loc.pressSequentially(text.slice(k, k + chunk), { delay: 0 });
                const shot = await shoot('type');
                if (shot) r.frames.typing.push({ ...shot, chars: Math.min(k + chunk, text.length) });
              }
            } else {
              await loc.click({ timeout: 8000 });
              await loc.fill('');
              await loc.pressSequentially(text, { delay: 0 });
            }
            break;
          }
          case 'select':
            if (film) {
              await loc.click({ timeout: 4000 }).catch(() => {});
              await sleep(200);
              r.frames.open = await shoot('open');
            }
            await loc.selectOption({ label: step.option }, { timeout: 8000 }).catch(async () => loc.selectOption(step.option, { timeout: 4000 }));
            if (film) r.frames.burst = await burst(session, shoot, { maxFrames: 3 });
            break;
          case 'press':
            await page().keyboard.press(step.key);
            if (film) r.frames.burst = await burst(session, shoot);
            break;
          case 'hover':
            await loc.hover({ timeout: 8000 });
            if (film) r.frames.burst = await burst(session, shoot, { maxFrames: 3 });
            break;
          default:
            throw new Error(`unsupported action ${step.action}`);
        }
      }
      await waitForSettle(session, { maxMs: 9000 });
      r.tSettled = now();
      r.urlAfter = page().url();
      if (!film && outDir && r.urlAfter !== r.urlBefore) {
        r.shot = path.join(outDir, `verify-step-${step.i}.jpg`);
        await page().screenshot({ path: r.shot, type: 'jpeg', quality: 75 }).catch(() => (r.shot = null));
      }
      if (film) {
        await page().mouse.move(r.cursor?.x ?? vp.width / 2, r.cursor?.y ?? vp.height / 2).catch(() => {});
        r.frames.settled = await shoot('settled');
      }
    } catch (err) {
      r.status = 'error';
      r.error = err.message.split('\n')[0].slice(0, 200);
      log('replay', `step ${step.i} failed: ${r.error}`);
      results.push(r);
      break;
    }
    results.push(r);
  }
  const tEnd = now();
  const ok = results.length === script.steps.length && results.every((r) => r.status !== 'error');
  const timeline = {
    mode,
    ok,
    viewport: vp,
    dpr: film ? await page().evaluate(() => devicePixelRatio) : 1,
    tStart,
    tEnd,
    opening,
    steps: results,
    finalUrl: page().url(),
  };
  if (outDir) writeJson(path.join(outDir, film ? 'timeline.json' : 'verify.json'), timeline);
  return timeline;
}
