#!/usr/bin/env node
// autoguide CLI. Stages: explore -> plan -> perform -> compile -> film -> render.
//   node src/cli.mjs explore <site> [--max 40]
//   node src/cli.mjs plan <site> [--focus "customer priorities"]
//   node src/cli.mjs perform <site> <wf-id|top:N|all> [--effort medium] [--no-reset] [--provider meta] [--executor computer-use|snapshot]
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadSite, openSiteSession, closeSiteSession, isLoggedOut, login, restoreEnv } from './sites.mjs';
import { exploreSite } from './explore.mjs';
import { summarizePages, proposeWorkflows, buildBrief } from './plan.mjs';
import { performWorkflow, workflowFromCatalog, judge } from './perform.mjs';
import { compileTrace } from './compile.mjs';
import { replayScript } from './replay.mjs';
import { observe } from './observe.mjs';
import { waitForSettle } from './browser.mjs';
import { reflowTargetRef, buildReflowPackage, verifyInPlayer, reflowAvailable } from './reflow.mjs';
import { buildArticle, buildDemo } from './docs.mjs';
import { narrateScript } from './narrate.mjs';
import { currentName, compareStep, refreshCopy, writeMaintenance } from './maintain.mjs';
import { performComputerUse, COMPUTER_VIEWPORT } from './computer.mjs';
import { driftEvidence } from './evidence.mjs';
import { usageLedger, callJSON, MODELS, useProvider, currentProvider } from './llm.mjs';
import { RUNS_DIR, readJson, writeJson, setLogFile, log, stamp } from './util.mjs';

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, opts };
}

export const paths = (siteId) => {
  const root = path.join(RUNS_DIR, siteId);
  return {
    root,
    explore: path.join(root, 'explore'),
    wf: (id) => path.join(root, 'wf', id),
  };
};

export function selectWorkflows(catalog, spec) {
  if (!spec || spec === 'all') return catalog.workflows;
  if (spec.startsWith('top:')) {
    const n = Number(spec.slice(4));
    return [...catalog.workflows].sort((a, b) => b.value - a.value || a.difficulty - b.difficulty).slice(0, n);
  }
  const ids = spec.split(',');
  return catalog.workflows.filter((w) => ids.includes(w.id));
}

async function cmdExplore(site, opts) {
  const p = paths(site.id);
  const s = await openSiteSession(site, { deviceScaleFactor: Number(opts.dpr || 1) });
  const ensureLogin = async (sess) => {
    if (await isLoggedOut(sess, site)) {
      await login(sess, site);
      return true;
    }
    return false;
  };
  const map = await exploreSite(s, { baseUrl: site.baseUrl, outDir: p.explore, maxPages: Number(opts.max || 40), ensureLogin, shotQuality: Number(opts['shot-quality'] || 70) });
  await closeSiteSession(s, site);
  log('explore', `${map.pages.length} screens, ${map.transitions.length} transitions in ${(map.ms / 1000).toFixed(1)}s`);
}

async function cmdPlan(site, opts) {
  const p = paths(site.id);
  const map = readJson(path.join(p.explore, 'map.json'));
  const summaries = await summarizePages(map, { outDir: p.explore });
  const catalog = await proposeWorkflows(summaries, { site, outDir: p.explore, lang: site.lang, focus: opts.focus || '' });
  for (const w of catalog.workflows) log('plan', `[v${w.value} d${w.difficulty}] ${w.id}: ${w.title}`);
}

// Customer-specified workflows (sites/<id>.workflows.json) take precedence over
// the planner's catalog; they are how a real engagement starts.
function loadCatalog(site) {
  const custom = path.join(RUNS_DIR, '..', 'sites', `${site.id}.workflows.json`);
  const base = fs.existsSync(custom) ? readJson(custom) : readJson(path.join(paths(site.id).explore, 'catalog.json'));
  const asked = readJson(path.join(paths(site.id).explore, 'asked.json'), { workflows: [] });
  return { ...base, workflows: [...base.workflows, ...asked.workflows] };
}

async function cmdPerform(site, spec, opts) {
  const p = paths(site.id);
  const summaries = readJson(path.join(p.explore, 'summaries.json'), []);
  const catalog = loadCatalog(site);
  const chosen = selectWorkflows(catalog, spec);
  const results = [];
  for (const w of chosen) {
    if (!opts['no-reset']) restoreEnv(site);
    const wf = workflowFromCatalog(w, summaries);
    const relevant = [...new Set([w.start_screen, ...(w.evidence || [])])];
    // --no-brief measures what prior exploration is worth (Chris's hypothesis).
    const siteBrief = opts['no-brief']
      ? ''
      : `${buildBrief(summaries, { only: relevant })}\n\nOther screens: ${summaries
          .filter((s) => !relevant.includes(s.id))
          .map((s) => `${s.screen_name} (${new URL(s.url).pathname})`)
          .join(', ')}`;
    // --tag keeps A/B runs (e.g. another model) apart from the main trace.
    const outDir = path.join(p.wf(w.id), opts.tag ? `perform-${opts.tag}` : 'perform');
    // Muse Spark drives the screen through the native computer tool; the snapshot agent stays available for A/B runs.
    const executor = opts.executor || (currentProvider() === 'meta' ? 'computer-use' : 'snapshot');
    const perform = executor === 'computer-use' ? performComputerUse : performWorkflow;
    const session = await openSiteSession(site, { deviceScaleFactor: Number(opts.dpr || 1), ...(executor === 'computer-use' ? { viewport: COMPUTER_VIEWPORT } : {}) });
    const t0 = Date.now();
    let trace;
    try {
      trace = await perform(session, wf, { outDir, lang: site.lang, siteMode: site.siteMode, siteBrief, effort: opts.effort || 'medium', model: opts.model });
    } finally {
      await closeSiteSession(session, site);
    }
    const r = {
      id: w.id,
      title: w.title,
      success: trace.verdict.success,
      confidence: trace.verdict.confidence,
      steps: trace.steps.length,
      guideSteps: trace.steps.filter((s) => s.guideStep && s.status === 'ok').length,
      secs: Math.round((Date.now() - t0) / 1000),
      reason: trace.verdict.reason,
    };
    results.push(r);
    log('perform', `${r.success ? 'PASS' : 'FAIL'} ${w.id} steps=${r.steps} guide=${r.guideSteps} ${r.secs}s — ${r.reason.slice(0, 160)}`);
  }
  writeJson(path.join(p.root, `perform-${opts.tag ? opts.tag + '-' : ''}${stamp()}.json`), { model: opts.model || null, effort: opts.effort || 'medium', results, usage: usageLedger() });
  return results;
}

// Judge the end state of a deterministic replay against the workflow's
// success criteria (the same bar the agent run had to pass).
async function judgeReplay(session, script, timeline, outDir, label) {
  // Verification may need a reload (persistence) that a guide reader never does.
  await session.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForSettle(session);
  const obs = await observe(session);
  const shot = path.join(outDir, `${label}-final.jpg`);
  await session.page.screenshot({ path: shot, type: 'jpeg', quality: 80 }).catch(() => {});
  const actionsText = [
    ...timeline.steps.map((r, k) => `${k + 1}. ${script.steps[k]?.instruction || r.action} [${r.status}${r.error ? ': ' + r.error : ''}]`),
    `${timeline.steps.length + 1}. [checker] reloaded the page after the last step to confirm the result persists`,
  ].join('\n');
  const keyShots = timeline.steps
    .filter((r) => r.shot)
    .slice(0, -1)
    .map((r) => ({ path: r.shot, label: `after step ${r.i}: ${new URL(r.urlAfter).pathname}` }));
  return judge({ workflow: script.workflow, actionsText, final: { claimedSuccess: timeline.ok }, obs, shotPath: shot, net: session.net.since(timeline.tStart * 1000), keyShots });
}

// A film run is usable only if the replay passed the success judge and every
// step kept its key frames (before and after). Otherwise it goes to review.
export function filmUsable(dir) {
  const tl = readJson(path.join(dir, 'film', 'timeline.json'), null);
  if (!tl?.ok || tl.verdict?.success !== true) return false;
  return tl.steps.every((s) => s.frames?.idle && s.frames?.settled && (s.status === 'ghost' || s.frames.burst || s.frames.typing || s.frames.open || s.action === 'press'));
}

function ids(site, spec) {
  const p = paths(site.id);
  const catalog = loadCatalog(site);
  return selectWorkflows(catalog, spec)
    .map((w) => w.id)
    .filter((id) => fs.existsSync(path.join(p.wf(id), 'perform', 'trace.json')));
}

async function cmdCompile(site, spec, opts) {
  const p = paths(site.id);
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    const trace = readJson(path.join(dir, 'perform', 'trace.json'));
    if (!trace.verdict?.success && !opts.force) {
      log('compile', `skip ${id}: agent run did not pass`);
      continue;
    }
    // The editor can drop a step a later one depends on (an Escape that closes a popup
    // covering the next target). A failed replay is concrete evidence, so it gets one retry.
    let feedback = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const script = await compileTrace(trace, { outDir: dir, lang: site.lang, site, feedback });
      if (!opts['no-reset']) restoreEnv(site);
      const session = await openSiteSession(site, { bypassCSP: true });
      try {
        // Describe every target with Reflow's own recorder while we are on the live page.
        const refs = [];
        const onTarget = async (page, step, loc) => refs.push({ i: step.i, ref: await reflowTargetRef(page, loc) });
        const tl = await replayScript(session, script, { mode: 'verify', outDir: dir, onTarget });
        writeJson(path.join(dir, 'reflow-refs.json'), { capturedAt: new Date().toISOString(), steps: refs });
        const verdict = tl.ok ? await judgeReplay(session, script, tl, dir, 'verify') : { success: false, confidence: 1, reason: `replay stopped: ${tl.steps.at(-1)?.error}`, end_state: '' };
        script.verified = { ok: tl.ok && verdict.success, at: new Date().toISOString(), verdict, via: tl.steps.map((r) => r.via || null), attempt };
        writeJson(path.join(dir, 'script.json'), script);
        log('compile', `${script.verified.ok ? 'VERIFIED' : 'NOT VERIFIED'} ${id}: ${script.steps.length} steps (from ${trace.steps.length}), attempt ${attempt} — ${verdict.reason.slice(0, 140)}`);
        if (script.verified.ok) break;
        const failed = tl.steps.find((r) => r.status === 'error');
        const at = failed ? script.steps[failed.i - 1] : null;
        feedback = [
          `You kept action log indexes [${script.steps.map((st) => st.from).join(', ')}].`,
          at ? `A model-free replay of them stopped at index ${at.from} ("${at.title}"): ${failed.error}.` : `The replay ran, but the end state was rejected: ${verdict.reason}`,
          'Usually a step you dropped was needed, such as an Escape or click that closes a popup covering this target. Look at the dropped steps right before it and keep what is needed.',
        ].join(' ');
      } finally {
        await closeSiteSession(session, site);
      }
    }
  }
}

async function cmdFilm(site, spec, opts) {
  const p = paths(site.id);
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    const script = readJson(path.join(dir, 'script.json'), null);
    if (!script?.verified?.ok && !opts.force) {
      log('film', `skip ${id}: script not verified`);
      continue;
    }
    const filmDir = path.join(dir, 'film');
    // An app restarted a moment ago can miss a beat (first search of a typeahead), so a
    // replay that stops gets one more take. A take the judge rejects is not retried.
    for (let take = 1; take <= 2; take++) {
      fs.rmSync(filmDir, { recursive: true, force: true });
      if (!opts['no-reset']) restoreEnv(site);
      const session = await openSiteSession(site, { deviceScaleFactor: Number(opts.dpr || 2), viewport: { width: 1440, height: 810 } });
      try {
        const tl = await replayScript(session, script, { mode: 'film', outDir: filmDir });
        const verdict = tl.ok ? await judgeReplay(session, script, tl, filmDir, 'film') : { success: false, reason: 'film replay failed' };
        tl.verdict = verdict;
        tl.take = take;
        writeJson(path.join(filmDir, 'timeline.json'), tl);
        const nFrames = fs.readdirSync(path.join(filmDir, 'frames')).length;
        log('film', `${tl.ok && verdict.success ? 'FILMED' : 'FILM FAILED'} ${id}: ${nFrames} stills, ${(tl.tEnd - tl.tStart).toFixed(1)}s, take ${take} — ${verdict.reason.slice(0, 120)}`);
        if (tl.ok) break;
      } finally {
        await closeSiteSession(session, site);
      }
    }
  }
}

async function cmdDocs(site, spec) {
  const p = paths(site.id);
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    if (!filmUsable(dir)) {
      log('docs', `skip ${id}: film run not usable (needs review)`);
      continue;
    }
    log('docs', `${id}: ${buildArticle(dir)} | ${buildDemo(dir)}`);
  }
}

async function cmdNarrate(site, spec, opts) {
  const p = paths(site.id);
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    const script = readJson(path.join(dir, 'script.json'), null);
    if (!script?.verified?.ok) continue;
    await narrateScript(script, { outDir: dir, provider: opts.voice || 'openai', lang: site.lang });
  }
}

// Capture Reflow recorder refs for an existing verified script (no recompile).
async function cmdRefs(site, spec, opts) {
  const p = paths(site.id);
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    const script = readJson(path.join(dir, 'script.json'), null);
    if (!script?.verified?.ok) continue;
    if (!opts['no-reset']) restoreEnv(site);
    const session = await openSiteSession(site, { bypassCSP: true });
    try {
      const refs = [];
      const onTarget = async (page, step, loc) => refs.push({ i: step.i, ref: await reflowTargetRef(page, loc) });
      const tl = await replayScript(session, script, { mode: 'verify', onTarget });
      writeJson(path.join(dir, 'reflow-refs.json'), { capturedAt: new Date().toISOString(), replayOk: tl.ok, steps: refs });
      log('refs', `${id}: ${refs.length} refs, replay ok=${tl.ok}`);
    } finally {
      await closeSiteSession(session, site);
    }
  }
}

async function cmdReflow(site, spec, opts) {
  const p = paths(site.id);
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    if (!reflowAvailable()) {
      writeJson(path.join(dir, 'out', 'reflow', 'player-check.json'), { completed: null, skipped: 'REFLOW_SRC not set: the Reflow player check did not run' });
      log('reflow', `${id}: skipped, REFLOW_SRC not set (player check not run)`);
      continue;
    }
    if (!fs.existsSync(path.join(dir, 'reflow-refs.json')) || !filmUsable(dir)) continue;
    const script = readJson(path.join(dir, 'script.json'));
    const pkg = buildReflowPackage(dir);
    if (!opts['no-reset']) restoreEnv(site);
    const session = await openSiteSession(site, { bypassCSP: true });
    try {
      const rep = await verifyInPlayer(session, pkg, script, { outDir: path.join(dir, 'out', 'reflow') });
      log('reflow', `${id}: ${pkg.steps.length} steps, on-target ${(rep.highlightRate * 100).toFixed(0)}%, advanced ${(rep.advanceRate * 100).toFixed(0)}%, completed=${rep.completed}`);
    } finally {
      await closeSiteSession(session, site);
    }
  }
}

async function cmdRender(site, spec, opts) {
  const p = paths(site.id);
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    if (!filmUsable(dir)) {
      log('render', `skip ${id}: film run not usable (needs review)`);
      continue;
    }
    const args = ['python3', path.join('render', 'video.py'), '--wf', dir];
    if (!fs.existsSync(path.join(dir, 'narration.json'))) args.push('--no-audio');
    const t0 = Date.now();
    // memcap caps memory on the machine this was built on; elsewhere run python directly.
    const capped = spawnSync('sh', ['-c', 'command -v memcap'], { stdio: 'ignore' }).status === 0;
    execFileSync(capped ? 'memcap' : args[0], capped ? ['-m', '12G', ...args] : args.slice(1), { stdio: 'inherit', cwd: path.resolve(RUNS_DIR, '..') });
    log('render', `${id}: ${path.join(dir, 'out', 'video.mp4')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

// Re-verify published guides against the live site and update them.
// Status model: UNCHANGED | ENV_BLOCKED | DRIFT_DETECTED -> REPLAY_VERIFIED ->
// ARTIFACTS_VALIDATED -> REVIEW_REQUIRED (never auto-published here).
async function cmdMaintain(site, spec, opts) {
  const p = paths(site.id);
  const report = [];
  for (const id of ids(site, spec)) {
    const dir = p.wf(id);
    const script = readJson(path.join(dir, 'script.json'), null);
    if (!script?.verified?.ok) continue;
    if (!opts['no-reset']) restoreEnv(site);
    const session = await openSiteSession(site, { bypassCSP: true });
    const observed = [];
    let tl;
    const checkDir = path.join(dir, 'maintain');
    try {
      tl = await replayScript(session, script, {
        mode: 'verify',
        outDir: checkDir,
        onTarget: async (page, step, loc) => {
          observed.push({ i: step.i, found: true, name: await currentName(loc), ref: await reflowTargetRef(page, loc) });
        },
      });
    } finally {
      await closeSiteSession(session, site);
    }
    for (const r of tl.steps) {
      const o = observed.find((x) => x.i === r.i);
      if (o) o.via = r.via;
    }
    const failedAt = tl.steps.find((r) => r.status === 'error');
    if (failedAt && !observed.find((x) => x.i === failedAt.i)) observed.push({ i: failedAt.i, found: false });
    const diffs = script.steps.map((st) => ({ i: st.i, title: st.title, ...compareStep(st, observed.find((x) => x.i === st.i) || { found: false }) }));
    const loggedOut = tl.finalUrl && site.login?.loggedOutUrl && new URL(tl.finalUrl).pathname.startsWith(site.login.loggedOutUrl);
    const record = { at: new Date().toISOString(), steps: diffs, actions: [] };
    if (loggedOut) {
      record.status = 'ENV_BLOCKED';
      record.summary = 'session or environment problem; no UI repair attempted';
    } else if (failedAt) {
      // The path itself broke: let the agent redo the workflow under the same contract.
      record.status = 'DRIFT_DETECTED';
      record.summary = `step ${failedAt.i} target missing (${failedAt.error}); re-performing workflow`;
      record.actions.push('re-perform');
      // Evidence for the reviewer, from pixels alone: is the old control still on screen?
      if (currentProvider() === 'meta' && failedAt.shot) {
        // The first step that drifted can sit before the one that failed: an old selector
        // may still match something else on the new page and "pass".
        const firstOff = diffs.find((d) => d.kind !== 'same') || { i: failedAt.i };
        record.firstOff = firstOff;
        const oldStep = script.steps[firstOff.i - 1];
        const oldTrace = readJson(path.join(dir, 'perform', 'trace.json'), null);
        const shotBefore = oldTrace?.steps?.[oldStep.from]?.shotBefore;
        if (shotBefore && oldStep.boxPerform) {
          record.evidence = await driftEvidence({ before: path.join(dir, 'perform', 'shots', shotBefore), after: failedAt.shot, box: oldStep.boxPerform, outDir: checkDir }).catch((err) => log('maintain', `no evidence: ${err.message.split('\n')[0]}`));
        }
      }
      const old = path.join(dir, `script.v${script.version || 1}.json`);
      fs.copyFileSync(path.join(dir, 'script.json'), old);
      await cmdPerform(site, id, { ...opts, 'no-reset': false });
      await cmdCompile(site, id, opts);
      const next = readJson(path.join(dir, 'script.json'), null);
      if (next?.verified?.ok) {
        next.version = (script.version || 1) + 1;
        next.changelog = [...(script.changelog || []), { at: record.at, kind: 'path-changed', from: failedAt.i }];
        writeJson(path.join(dir, 'script.json'), next);
        record.status = 'REPLAY_VERIFIED';
      }
    } else {
      const renames = diffs.filter((d) => d.kind === 'renamed').map((d) => ({ i: d.i, before: d.before, now: d.now }));
      if (!renames.length) {
        record.status = 'UNCHANGED';
        record.summary = `all ${diffs.length} steps resolved with the same labels`;
      } else {
        record.status = 'DRIFT_DETECTED';
        record.summary = `${renames.length} label change(s): ${renames.map((r) => `'${r.before}'→'${r.now}'`).join(', ')}`;
        fs.copyFileSync(path.join(dir, 'script.json'), path.join(dir, `script.v${script.version || 1}.json`));
        const next = await refreshCopy(script, renames);
        next.version = (script.version || 1) + 1;
        next.changelog = [...(script.changelog || []), { at: record.at, kind: 'labels-renamed', renames }];
        // The path still works, so it is verified as replayed; refs are refreshed from the live page.
        next.verified = { ...script.verified, ok: true, at: record.at, via: tl.steps.map((r) => r.via || null) };
        writeJson(path.join(dir, 'script.json'), next);
        writeJson(path.join(dir, 'reflow-refs.json'), { capturedAt: record.at, replayOk: tl.ok, steps: observed.map((o) => ({ i: o.i, ref: o.ref })) });
        record.actions.push('copy-refresh');
        record.status = 'REPLAY_VERIFIED';
      }
    }
    if (record.status === 'REPLAY_VERIFIED') {
      // Regenerate every format from the updated script as one version.
      for (const stage of ['film', 'narrate', 'render', 'docs', 'reflow']) await STAGES[stage](site, id, opts);
      const usable = filmUsable(dir);
      const player = readJson(path.join(dir, 'out', 'reflow', 'player-check.json'), null);
      record.artifacts = { film: usable, reflowCompleted: player?.completed ?? null, ...(player?.skipped ? { reflowCheck: player.skipped } : {}) };
      record.status = usable && player?.completed !== false ? 'REVIEW_REQUIRED' : 'REPAIR_FAILED';
      record.actions.push(`regenerated: film, narration, video, article, demo${player?.skipped ? '; Reflow player check not run' : ', reflow'}`);
    }
    writeMaintenance(dir, record);
    report.push({ id, status: record.status, summary: record.summary });
  }
  writeJson(path.join(p.root, `maintenance-${stamp()}.json`), report);
  return report;
}

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    feasible: { type: 'boolean', description: 'Can this be answered with a how-to workflow on the observed screens?' },
    reason: { type: 'string' },
    workflow: {
      type: 'object',
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, title_en: { type: 'string' }, category: { type: 'string' }, persona: { type: 'string' },
        goal: { type: 'string' }, start_screen: { type: 'string' }, path_hint: { type: 'string' }, preconditions: { type: 'string' },
        sample_data: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'], additionalProperties: false } },
        success_criteria: { type: 'string' },
        success_criteria_local: { type: 'string' },
        effects: { type: 'array', items: { type: 'string', enum: ['read', 'create', 'update', 'delete', 'send', 'settings'] } },
        evidence: { type: 'array', items: { type: 'string' } },
        value: { type: 'integer' }, difficulty: { type: 'integer' }, est_steps: { type: 'integer' }, unverified: { type: 'string' },
      },
      required: ['id', 'title', 'title_en', 'category', 'persona', 'goal', 'start_screen', 'path_hint', 'preconditions', 'sample_data', 'success_criteria', 'success_criteria_local', 'effects', 'evidence', 'value', 'difficulty', 'est_steps', 'unverified'],
      additionalProperties: false,
    },
  },
  required: ['feasible', 'reason', 'workflow'],
  additionalProperties: false,
};

// A support question becomes a workflow spec grounded in the site map, then
// goes through the normal pipeline. "Start from one ticket" instead of a list.
async function cmdAsk(site, question, opts) {
  const p = paths(site.id);
  const summaries = readJson(path.join(p.explore, 'summaries.json'));
  const out = await callJSON({
    model: MODELS.planner,
    effort: 'medium',
    system: `You turn a customer support question about a web product into one how-to workflow that an agent can perform and film. Ground it in the observed screens (cite screen ids). The success criteria must be checkable by the same user in the same browser session at the end (no other accounts, emails or external systems). Use realistic sample data in ${site.lang === 'ko' ? 'Korean' : site.lang}, with new distinctive names for anything created; dates must be valid for the site's own "today" as shown on its screens (past events on or before it, plans after it). Title in ${site.lang === 'ko' ? 'Korean' : site.lang}, phrased as the answer ("…하는 방법").`,
    user: `PRODUCT: ${site.name}\nQUESTION: ${question}\n\nSCREENS:\n${buildBrief(summaries)}`,
    schema: ASK_SCHEMA,
    name: 'ask',
    label: 'ask',
  });
  if (!out.feasible) {
    log('ask', `not a workflow on observed screens: ${out.reason}`);
    return;
  }
  const w = { ...out.workflow, id: `ask-${out.workflow.id}`.slice(0, 60), question };
  const file = path.join(p.explore, 'asked.json');
  const asked = readJson(file, { workflows: [] });
  asked.workflows = [...asked.workflows.filter((x) => x.id !== w.id), w];
  writeJson(file, asked);
  log('ask', `${w.id}: ${w.title}`);
  await cmdRun(site, w.id, opts);
}

const STAGES = {
  perform: cmdPerform,
  compile: cmdCompile,
  film: cmdFilm,
  narrate: cmdNarrate,
  render: cmdRender,
  docs: cmdDocs,
  reflow: cmdReflow,
};

// Run several stages in order for the selected workflows.
async function cmdRun(site, spec, opts) {
  const stages = String(opts.stages || 'perform,compile,film,narrate,render,docs,reflow').split(',');
  for (const st of stages) {
    if (!STAGES[st]) throw new Error(`unknown stage ${st}`);
    log('run', `== ${st} ==`);
    await STAGES[st](site, spec, opts);
  }
}

async function main() {
  const { pos, opts } = parseArgs(process.argv.slice(2));
  const [cmd, siteId, spec] = pos;
  if (!cmd || !siteId) {
    console.log('usage: cli.mjs <explore|plan|perform> <site> [workflow]');
    process.exit(1);
  }
  if (opts.provider) useProvider(opts.provider);
  const site = loadSite(siteId);
  setLogFile(path.join(RUNS_DIR, site.id, 'log.txt'));
  if (cmd === 'explore') await cmdExplore(site, opts);
  else if (cmd === 'plan') await cmdPlan(site, opts);
  else if (cmd === 'perform') await cmdPerform(site, spec, opts);
  else if (cmd === 'compile') await cmdCompile(site, spec, opts);
  else if (cmd === 'film') await cmdFilm(site, spec, opts);
  else if (cmd === 'docs') await cmdDocs(site, spec, opts);
  else if (cmd === 'narrate') await cmdNarrate(site, spec, opts);
  else if (cmd === 'reflow') await cmdReflow(site, spec, opts);
  else if (cmd === 'refs') await cmdRefs(site, spec, opts);
  else if (cmd === 'render') await cmdRender(site, spec, opts);
  else if (cmd === 'run') await cmdRun(site, spec, opts);
  else if (cmd === 'maintain') await cmdMaintain(site, spec, opts);
  else if (cmd === 'ask') await cmdAsk(site, spec, opts);
  else throw new Error(`unknown command ${cmd}`);
  const u = usageLedger();
  if (u.calls) log('usage', JSON.stringify(u.byModel));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
