// Aggregate every run into one evaluation table (results.json + results.md)
// and a local gallery page (runs/index.html) to browse the outputs.
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR, readJson, writeJson, writeText } from './util.mjs';

// USD per 1M tokens (input, cached input, output), checked 2026-10-22 on
// developers.openai.com/api/docs/pricing.
const PRICES = {
  'gpt-6.1-sol': [2.0, 0.1, 10.0],
  'gpt-6-sol': [2.0, 0.2, 10.0],
  'gpt-6-astra': [10.0, 1.0, 50.0],
  'gpt-6-luna': [0.1, 0.01, 0.5],
};

export function costOf(byModel = {}) {
  let usd = 0;
  for (const [model, u] of Object.entries(byModel)) {
    const p = PRICES[model];
    if (!p) continue;
    usd += ((u.input - u.cached) * p[0] + u.cached * p[1] + u.output * p[2]) / 1e6;
  }
  return usd;
}

const exists = (f) => fs.existsSync(f);
const rel = (f) => path.relative(RUNS_DIR, f);

function workflowRow(siteId, wfId, catalog) {
  const dir = path.join(RUNS_DIR, siteId, 'wf', wfId);
  const entry = catalog?.workflows?.find((w) => w.id === wfId) || {};
  const trace = readJson(path.join(dir, 'perform', 'trace.json'), null);
  const script = readJson(path.join(dir, 'script.json'), null);
  const timeline = readJson(path.join(dir, 'film', 'timeline.json'), null);
  const narration = readJson(path.join(dir, 'narration.json'), null);
  const render = readJson(path.join(dir, 'out', 'render.json'), null);
  const player = readJson(path.join(dir, 'out', 'reflow', 'player-check.json'), null);
  const luna = readJson(path.join(dir, 'perform-luna', 'trace.json'), null);
  const stills = timeline && exists(path.join(dir, 'film', 'frames')) ? fs.readdirSync(path.join(dir, 'film', 'frames')).length : 0;
  return {
    site: siteId,
    id: wfId,
    title: script?.title || entry.title || wfId,
    value: entry.value ?? null,
    effects: entry.effects || [],
    perform: trace
      ? {
          success: !!trace.verdict?.success,
          actions: trace.steps.length,
          guideActions: trace.steps.filter((s) => s.guideStep && s.status === 'ok').length,
          secs: Math.round((trace.finishedAt - trace.startedAt) / 1000),
          model: trace.model,
        }
      : null,
    performLuna: luna ? { success: !!luna.verdict?.success, actions: luna.steps.length, secs: Math.round((luna.finishedAt - luna.startedAt) / 1000) } : null,
    script: script ? { steps: script.steps.length, verified: !!script.verified?.ok } : null,
    film: timeline ? { ok: !!timeline.ok && timeline.verdict?.success !== false, stills } : null,
    narrationSecs: narration?.total ?? null,
    video: render ? { secs: Number((render.duration ?? render.video_duration ?? 0).toFixed?.(1) ?? render.duration), renderSecs: Number((render.render_seconds ?? 0).toFixed(1)) } : null,
    player: player ? { onTarget: player.highlightRate, advanced: player.advanceRate, completed: player.completed, steps: player.steps.length } : null,
    files: {
      video: exists(path.join(dir, 'out', 'video.mp4')) ? rel(path.join(dir, 'out', 'video.mp4')) : null,
      poster: exists(path.join(dir, 'out', 'poster.jpg')) ? rel(path.join(dir, 'out', 'poster.jpg')) : null,
      article: exists(path.join(dir, 'out', 'article', 'index.html')) ? rel(path.join(dir, 'out', 'article', 'index.html')) : null,
      demo: exists(path.join(dir, 'out', 'demo', 'index.html')) ? rel(path.join(dir, 'out', 'demo', 'index.html')) : null,
      reflow: exists(path.join(dir, 'out', 'reflow', 'guide.json')) ? rel(path.join(dir, 'out', 'reflow', 'guide.json')) : null,
      captions: exists(path.join(dir, 'out', 'captions.vtt')) ? rel(path.join(dir, 'out', 'captions.vtt')) : null,
    },
  };
}

function loadCatalog(siteId) {
  const custom = path.join(RUNS_DIR, '..', 'sites', `${siteId}.workflows.json`);
  if (exists(custom)) return readJson(custom);
  return readJson(path.join(RUNS_DIR, siteId, 'explore', 'catalog.json'), null);
}

export function buildReport(siteIds) {
  const rows = [];
  const usage = {};
  for (const siteId of siteIds) {
    const wfRoot = path.join(RUNS_DIR, siteId, 'wf');
    if (!exists(wfRoot)) continue;
    const catalog = loadCatalog(siteId);
    for (const wfId of fs.readdirSync(wfRoot).sort()) rows.push(workflowRow(siteId, wfId, catalog));
    // Token ledgers written by perform runs (main model only; A/B tags excluded).
    for (const f of fs.readdirSync(path.join(RUNS_DIR, siteId)).filter((x) => /^perform-\d/.test(x))) {
      const led = readJson(path.join(RUNS_DIR, siteId, f), null);
      for (const [m, u] of Object.entries(led?.usage?.byModel || {})) {
        const t = (usage[m] ||= { input: 0, cached: 0, output: 0, calls: 0 });
        t.input += u.input;
        t.cached += u.cached;
        t.output += u.output;
        t.calls += u.calls;
      }
    }
  }
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  const performed = rows.filter((r) => r.perform);
  const summary = {
    workflows: rows.length,
    performPass: performed.filter((r) => r.perform.success).length,
    performed: performed.length,
    verified: rows.filter((r) => r.script?.verified).length,
    filmed: rows.filter((r) => r.film?.ok).length,
    rendered: rows.filter((r) => r.files.video).length,
    playerCompleted: rows.filter((r) => r.player?.completed).length,
    playerChecked: rows.filter((r) => r.player).length,
    performUsd: Number(costOf(usage).toFixed(3)),
  };
  writeJson(path.join(RUNS_DIR, 'results.json'), { generatedAt: new Date().toISOString(), summary, usage, rows });
  const md = [
    `# autoguide 실행 결과 (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
    '',
    `- 워크플로우 ${summary.workflows}개 · 에이전트 수행 통과 ${summary.performPass}/${summary.performed} (${pct(summary.performPass, summary.performed)})`,
    `- 모델 없는 재실행 검증 ${summary.verified} · 촬영 ${summary.filmed} · 영상 ${summary.rendered}`,
    `- Reflow 실제 플레이어 완주 ${summary.playerCompleted}/${summary.playerChecked}`,
    `- 수행 단계 LLM 비용(판정 포함) 약 $${summary.performUsd}`,
    '',
    '| 사이트 | 워크플로우 | 수행 | 액션→가이드 단계 | 수행 시간 | 재실행 검증 | 스틸 | 영상 길이 | Reflow 하이라이트/진행 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) =>
      [
        r.site,
        r.title,
        r.perform ? (r.perform.success ? 'PASS' : 'FAIL') : '-',
        r.perform ? `${r.perform.actions} → ${r.script?.steps ?? '-'}` : '-',
        r.perform ? `${r.perform.secs}s` : '-',
        r.script ? (r.script.verified ? 'OK' : 'NO') : '-',
        r.film?.stills || '-',
        r.video ? `${r.video.secs}s` : '-',
        r.player ? `${Math.round(r.player.onTarget * 100)}% / ${Math.round(r.player.advanced * 100)}%${r.player.completed ? ' 완주' : ''}` : '-',
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    ),
  ].join('\n');
  writeText(path.join(RUNS_DIR, 'results.md'), md);
  writeText(path.join(RUNS_DIR, 'index.html'), gallery(rows, summary));
  return { summary, rows };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function gallery(rows, summary) {
  const cards = rows
    .filter((r) => r.files.video || r.files.article)
    .map(
      (r) => `<article class="card">
  ${r.files.video ? `<video controls preload="none" poster="${esc(r.files.poster || '')}" src="${esc(r.files.video)}">${r.files.captions ? `<track kind="subtitles" srclang="ko" label="한국어" src="${esc(r.files.captions)}" default>` : ''}</video>` : ''}
  <div class="body">
    <p class="site">${esc(r.site)}</p>
    <h2>${esc(r.title)}</h2>
    <p class="meta">${r.script ? `${r.script.steps}단계` : ''}${r.video ? ` · 영상 ${r.video.secs}초` : ''}${r.perform ? ` · 에이전트 ${r.perform.actions}회 조작` : ''}${r.player ? ` · Reflow 재생 ${r.player.completed ? '완주' : '미완주'}` : ''}</p>
    <p class="links">${r.files.article ? `<a href="${esc(r.files.article)}">캡처 가이드</a>` : ''}${r.files.demo ? `<a href="${esc(r.files.demo)}">따라 해 보기</a>` : ''}${r.files.reflow ? `<a href="${esc(r.files.reflow)}">Reflow 가이드 JSON</a>` : ''}</p>
  </div>
</article>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>autoguide 결과</title>
<style>
  :root { --bg:#f8fafc; --fg:#0f172a; --muted:#475569; --line:#e2e8f0; --card:#fff; --accent:#E11D48; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b1220; --fg:#e2e8f0; --muted:#94a3b8; --line:#1e293b; --card:#111a2e; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 "Pretendard", system-ui, sans-serif; word-break:keep-all; }
  main { max-width:1200px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:26px; margin:0 0 6px; }
  .summary { color:var(--muted); margin:0 0 24px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; display:flex; flex-direction:column; }
  video { width:100%; aspect-ratio:16/9; background:#000; display:block; }
  .body { padding:12px 16px 16px; }
  .site { margin:0; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  h2 { font-size:17px; margin:2px 0 6px; line-height:1.4; }
  .meta { margin:0 0 10px; color:var(--muted); font-size:13px; }
  .links { display:flex; flex-wrap:wrap; gap:8px; margin:0; }
  .links a { color:var(--accent); text-decoration:none; border:1px solid var(--line); border-radius:8px; padding:4px 10px; font-size:13px; }
</style></head>
<body><main>
<h1>autoguide 결과물</h1>
<p class="summary">에이전트 수행 통과 ${summary.performPass}/${summary.performed} · 재실행 검증 ${summary.verified} · 영상 ${summary.rendered} · Reflow 플레이어 완주 ${summary.playerCompleted}/${summary.playerChecked}</p>
<div class="grid">
${cards}
</div>
</main></body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sites = process.argv.slice(2);
  const { summary } = buildReport(sites.length ? sites : fs.readdirSync(RUNS_DIR).filter((d) => exists(path.join(RUNS_DIR, d, 'wf'))));
  console.log(JSON.stringify(summary, null, 1));
}
