// Browser session: launch Chromium, track network activity, and wait for the
// page to settle after an action (network quiet + DOM quiet + animations done).
import fs from 'node:fs';
import { chromium } from 'playwright';
import { sleep } from './util.mjs';

const TRACKED_TYPES = new Set(['document', 'xhr', 'fetch']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const DEFAULT_VIEWPORT = { width: 1440, height: 810 };

export async function openSession({
  headless = true,
  viewport = DEFAULT_VIEWPORT,
  deviceScaleFactor = 1,
  storageState = null,
  locale = 'ko-KR',
  timezoneId = 'Asia/Seoul',
  slowMo = 0,
  bypassCSP = false,
  userAgent = undefined,
  args = [],
} = {}) {
  const browser = await chromium.launch({
    headless,
    slowMo,
    args: ['--disable-blink-features=AutomationControlled', '--hide-scrollbars', '--force-color-profile=srgb', ...args],
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    locale,
    timezoneId,
    storageState: storageState && fs.existsSync(storageState) ? storageState : undefined,
    bypassCSP,
    userAgent,
  });
  const page = await context.newPage();
  const session = { browser, context, page, net: createNetTracker(), dialogs: [] };
  attachPage(session, page);
  // New tabs (target=_blank) become the active page so the agent follows them.
  context.on('page', (p) => {
    attachPage(session, p);
    session.page = p;
  });
  return session;
}

function attachPage(session, page) {
  const net = session.net;
  page.on('request', (req) => net.onRequest(req));
  page.on('requestfinished', (req) => net.onDone(req, false));
  page.on('requestfailed', (req) => net.onDone(req, true));
  page.on('dialog', async (dialog) => {
    const entry = { type: dialog.type(), message: dialog.message(), at: Date.now(), handled: null };
    session.dialogs.push(entry);
    // The active policy decides; default is to accept alerts and dismiss confirms.
    const policy = session.dialogPolicy || ((d) => (d.type() === 'alert' ? 'accept' : 'dismiss'));
    const decision = policy(dialog);
    entry.handled = decision;
    try {
      if (decision === 'accept') await dialog.accept();
      else await dialog.dismiss();
    } catch {
      /* dialog may already be handled */
    }
  });
}

function createNetTracker() {
  const inflight = new Map();
  const log = [];
  let lastActivity = Date.now();
  return {
    log,
    get inflightCount() {
      return inflight.size;
    },
    get lastActivity() {
      return lastActivity;
    },
    onRequest(req) {
      if (!TRACKED_TYPES.has(req.resourceType())) return;
      inflight.set(req, Date.now());
      lastActivity = Date.now();
    },
    async onDone(req, failed) {
      if (!inflight.has(req)) return;
      const startedAt = inflight.get(req);
      inflight.delete(req);
      lastActivity = Date.now();
      let status = null;
      try {
        status = failed ? null : (await req.response())?.status() ?? null;
      } catch {
        status = null;
      }
      log.push({
        at: startedAt,
        ms: Date.now() - startedAt,
        method: req.method(),
        url: req.url(),
        type: req.resourceType(),
        status,
        failed,
        mutating: MUTATING.has(req.method()),
        postData: MUTATING.has(req.method()) ? truncatePost(req.postData()) : undefined,
      });
    },
    since(t) {
      return log.filter((e) => e.at >= t);
    },
  };
}

function truncatePost(data) {
  if (!data) return undefined;
  return data.length > 600 ? data.slice(0, 600) + '…' : data;
}

// Wait until the page looks stable. Every phase is capped so a chatty page
// (polling, websockets, tickers) never blocks the pipeline.
export async function waitForSettle(session, { networkQuietMs = 450, domQuietMs = 350, maxMs = 9000 } = {}) {
  const page = session.page;
  const deadline = Date.now() + maxMs;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: Math.max(500, deadline - Date.now()) });
  } catch {
    /* keep going */
  }
  while (Date.now() < deadline) {
    if (session.net.inflightCount === 0 && Date.now() - session.net.lastActivity >= networkQuietMs) break;
    await sleep(80);
  }
  const remaining = Math.max(200, deadline - Date.now());
  try {
    await page.evaluate(
      ({ quiet, cap }) =>
        new Promise((resolve) => {
          const started = performance.now();
          let last = performance.now();
          const obs = new MutationObserver(() => {
            last = performance.now();
          });
          obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
          const tick = () => {
            const now = performance.now();
            const animating = document
              .getAnimations()
              .some((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime ?? Infinity));
            if ((now - last >= quiet && !animating) || now - started >= cap) {
              obs.disconnect();
              resolve();
            } else {
              setTimeout(tick, 50);
            }
          };
          setTimeout(tick, 50);
        }),
      { quiet: domQuietMs, cap: Math.min(remaining, 4000) },
    );
  } catch {
    /* navigation during evaluate: the next observation will catch up */
  }
}

export async function closeSession(session) {
  try {
    await session.browser.close();
  } catch {
    /* already closed */
  }
}
