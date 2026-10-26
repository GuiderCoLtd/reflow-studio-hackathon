// Document outputs from one filmed run:
//  - article: step-by-step screenshot guide (HTML + Markdown), the format
//    Korean users search for, with highlights baked into the images
//  - demo: a click-through interactive walkthrough (hotspot per step)
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROOT, ensureDir, writeText, writeJson, readJson } from './util.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Step numbers are typography, not badges: tabular "01", "02", ...
const stepNo = (i) => String(i).padStart(2, '0');

// The still that best shows what the user must do in this step.
function actionStill(st) {
  const f = st.frames || {};
  if (st.action === 'fill') return f.typing?.at(-1)?.f || f.focus?.f || f.hover?.f || f.idle?.f;
  if (st.action === 'select') return f.open?.f || f.hover?.f || f.idle?.f;
  return f.hover?.f || f.idle?.f;
}

function processStills(jobs) {
  const file = path.join(ROOT, 'runs', '_tmp', `jobs-${process.pid}-${Date.now()}.json`);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(jobs));
  execFileSync('python3', [path.join(ROOT, 'src', 'py', 'stills.py'), file], { stdio: 'inherit' });
  fs.rmSync(file, { force: true });
}

function loadRun(wfDir) {
  const script = readJson(path.join(wfDir, 'script.json'));
  const timeline = readJson(path.join(wfDir, 'film', 'timeline.json'));
  const framesDir = path.join(wfDir, 'film', 'frames');
  return { script, timeline, framesDir };
}

const scaleBox = (box, dpr) => (box ? { x: box.x * dpr, y: box.y * dpr, width: box.width * dpr, height: box.height * dpr } : null);

// A 16:9 crop around the target and its container so text stays readable in a
// narrow article column. Falls back to the full frame when the region is large.
function focusCrop(st, vp, dpr) {
  if (!st.box) return null;
  const b = st.box;
  const c = st.context && st.context.width * st.context.height < vp.width * vp.height * 0.6 ? st.context : null;
  let x0 = Math.min(b.x, c ? c.x : b.x) - 40;
  let y0 = Math.min(b.y, c ? c.y : b.y) - 40;
  let x1 = Math.max(b.x + b.width, c ? c.x + c.width : b.x + b.width) + 40;
  let y1 = Math.max(b.y + b.height, c ? c.y + c.height : b.y + b.height) + 40;
  let w = Math.max(x1 - x0, 720);
  let h = Math.max(y1 - y0, 405);
  if (w / h > 16 / 9) h = (w * 9) / 16;
  else w = (h * 16) / 9;
  if (w >= vp.width * 0.9) return null;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  x0 = Math.min(Math.max(0, cx - w / 2), vp.width - w);
  y0 = Math.min(Math.max(0, cy - h / 2), vp.height - h);
  return { x: x0 * dpr, y: y0 * dpr, width: w * dpr, height: h * dpr };
}

export function buildArticle(wfDir, { width = 1440, color = '#2563EB' } = {}) {
  const { script, timeline, framesDir } = loadRun(wfDir);
  const outDir = ensureDir(path.join(wfDir, 'out', 'article'));
  const imgDir = ensureDir(path.join(outDir, 'img'));
  const jobs = [];
  const steps = script.steps.map((s, k) => {
    const st = timeline.steps[k] || {};
    const still = actionStill(st);
    const img = `step-${String(s.i).padStart(2, '0')}.jpg`;
    const crop = focusCrop(st, timeline.viewport, timeline.dpr);
    if (still) jobs.push({ src: path.join(framesDir, still), dst: path.join(imgDir, img), width: crop ? 1280 : width, quality: 84, box: scaleBox(st.box, timeline.dpr), crop, label: stepNo(s.i), color });
    return { ...s, img: still ? `img/${img}` : null };
  });
  const last = timeline.steps.at(-1)?.frames?.settled?.f;
  if (last) jobs.push({ src: path.join(framesDir, last), dst: path.join(imgDir, 'result.jpg'), width, quality: 84, box: null });
  processStills(jobs);

  const verified = script.verified?.ok && script.verified?.at ? new Date(script.verified.at) : null;
  const verifiedText = verified ? `${verified.getFullYear()}년 ${verified.getMonth() + 1}월 ${verified.getDate()}일 실제 화면에서 자동 검증됨` : '';
  const html = `<!doctype html>
<html lang="${esc(script.lang || 'ko')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(script.title)}</title>
<style>
  :root { --bg:#ffffff; --fg:#111827; --text:#374151; --muted:#5F6B7A; --line:#D8DEE8; --accent:${color}; --num:${color}; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0B1220; --fg:#EEF2F8; --text:#C9D2E0; --muted:#94A0B0; --line:#243045; --num:color-mix(in srgb, ${color} 62%, white); } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.75 "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif; word-break:keep-all; overflow-wrap:anywhere; -webkit-font-smoothing:antialiased; }
  main { max-width: 880px; margin: 0 auto; padding: 56px 16px 88px; }
  h1 { font-size: 36px; font-weight: 700; line-height: 1.25; margin: 0 0 14px; letter-spacing: -0.03em; }
  .summary { color: var(--text); margin: 0 0 24px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px 20px; font-size:14px; color:var(--muted); padding: 12px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); font-variant-numeric: tabular-nums; }
  .prereq { border-left: 2px solid var(--accent); padding: 2px 0 2px 18px; margin: 28px 0 0; }
  .prereq h2 { font-size: 14px; font-weight: 600; color: var(--muted); margin: 0 0 4px; letter-spacing: 0.01em; }
  .prereq ul { margin: 0; padding-left: 18px; color: var(--text); }
  ol.steps { list-style: none; padding: 0; margin: 44px 0 0; }
  ol.steps > li { margin: 0 0 52px; }
  .step-head { display:flex; align-items:baseline; }
  .num { flex: none; width: 56px; font-size: 28px; font-weight: 600; line-height: 1; letter-spacing: -0.03em; color: var(--num); font-variant-numeric: tabular-nums; }
  .step-head h2 { font-size: 22px; font-weight: 700; margin: 0; line-height: 1.4; letter-spacing: -0.02em; }
  .instruction { margin: 6px 0 16px 56px; color: var(--text); }
  figure { margin: 0 0 0 56px; }
  figure img { width: 100%; height: auto; display: block; border-radius: 10px; border: 1px solid var(--line); box-shadow: 0 2px 8px rgba(23,37,84,0.05), 0 18px 48px -20px rgba(23,37,84,0.22); }
  .result { margin-top: 8px; padding-top: 28px; border-top: 1px solid var(--line); }
  .result h2 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 8px; }
  .result p { color: var(--text); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (max-width: 640px) { .instruction, figure { margin-left: 0; } .num { width: 44px; font-size: 24px; } h1 { font-size: 26px; } }
</style>
</head>
<body>
<main>
  <h1>${esc(script.title)}</h1>
  <p class="summary">${esc(script.summary)}</p>
  <div class="meta"><span>${esc(script.site?.name || '')}</span><span>단계 ${script.steps.length}개</span>${verifiedText ? `<span>${esc(verifiedText)}</span>` : ''}</div>
  ${script.prerequisites?.length ? `<section class="prereq"><h2>시작하기 전에</h2><ul>${script.prerequisites.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></section>` : ''}
  <ol class="steps">
${steps
  .map(
    (s) => `    <li>
      <div class="step-head"><span class="num" aria-hidden="true">${stepNo(s.i)}</span><h2><span class="sr">${s.i}단계. </span>${esc(s.title)}</h2></div>
      <p class="instruction">${esc(s.instruction)}</p>
      ${s.img ? `<figure><img src="${s.img}" alt="${esc(s.title)}" loading="lazy"></figure>` : ''}
    </li>`,
  )
  .join('\n')}
  </ol>
  <section class="result"><h2>결과</h2><p>${esc(script.result_note || script.outro)}</p>${last ? '<figure style="margin-left:0"><img src="img/result.jpg" alt="결과 화면" loading="lazy"></figure>' : ''}</section>
</main>
</body>
</html>`;
  writeText(path.join(outDir, 'index.html'), html);
  const md = [
    `# ${script.title}`,
    '',
    script.summary,
    '',
    script.prerequisites?.length ? `**시작하기 전에**\n\n${script.prerequisites.map((p) => `- ${p}`).join('\n')}\n` : '',
    ...steps.map((s) => `## ${s.i}단계. ${s.title}\n\n${s.instruction}\n\n${s.img ? `![${s.title}](${s.img})\n` : ''}`),
    `## 결과\n\n${script.result_note || script.outro}\n${last ? '\n![결과 화면](img/result.jpg)\n' : ''}`,
    verifiedText ? `\n_${verifiedText}_\n` : '',
  ].join('\n');
  writeText(path.join(outDir, 'article.md'), md);
  return path.join(outDir, 'index.html');
}

export function buildDemo(wfDir, { width = 1440, maxTyping = 6 } = {}) {
  const { script, timeline, framesDir } = loadRun(wfDir);
  const outDir = ensureDir(path.join(wfDir, 'out', 'demo'));
  const imgDir = ensureDir(path.join(outDir, 'img'));
  const jobs = [];
  const used = new Map();
  const add = (still) => {
    if (!still) return null;
    if (!used.has(still)) {
      const name = `${used.size + 1}.jpg`;
      used.set(still, `img/${name}`);
      jobs.push({ src: path.join(framesDir, still), dst: path.join(imgDir, name), width, quality: 80, box: null });
    }
    return used.get(still);
  };
  const vp = timeline.viewport;
  const steps = script.steps.map((s, k) => {
    const st = timeline.steps[k] || {};
    const f = st.frames || {};
    const typing = (f.typing || []).filter((_, idx, arr) => arr.length <= maxTyping || idx % Math.ceil(arr.length / maxTyping) === 0 || idx === arr.length - 1);
    return {
      i: s.i,
      title: s.title,
      instruction: s.instruction,
      action: s.action,
      screen: add(f.hover?.f || f.idle?.f),
      typing: typing.map((t) => add(t.f)),
      after: add(f.settled?.f),
      box: st.box ? { l: (st.box.x / vp.width) * 100, t: (st.box.y / vp.height) * 100, w: (st.box.width / vp.width) * 100, h: (st.box.height / vp.height) * 100 } : null,
    };
  });
  processStills(jobs);
  const data = { title: script.title, site: script.site?.name || '', intro: script.intro, outro: script.outro, result: script.result_note, steps };
  writeJson(path.join(outDir, 'demo.json'), data);
  const html = `<!doctype html>
<html lang="${esc(script.lang || 'ko')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(script.title)} · 따라 해 보기</title>
<style>
  :root { --bg:#F7F8FA; --fg:#111827; --muted:#5F6B7A; --line:#D8DEE8; --accent:#2563EB; --accent-on-dark:#6591F1; --panel:rgba(17,24,39,0.9); }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--fg); font:15px/1.6 "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif; word-break:keep-all; overflow-wrap:anywhere; -webkit-font-smoothing:antialiased; display:flex; flex-direction:column; align-items:center; padding:16px; }
  header { width:100%; max-width:1200px; display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:12px; }
  header h1 { font-size:19px; font-weight:700; letter-spacing:-0.02em; margin:0; }
  .progress { color:var(--muted); font-size:14px; font-weight:500; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .segments { width:100%; max-width:1200px; display:flex; gap:6px; margin:0 0 12px; }
  .segments i { flex:1; height:3px; background:var(--line); transition:background .3s; }
  .segments i.cur { background:color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .segments i.done { background:var(--accent); }
  .stage { position:relative; width:100%; max-width:1200px; aspect-ratio:16/9; border-radius:12px; overflow:hidden; background:#fff; box-shadow:0 2px 8px rgba(23,37,84,0.05), 0 18px 48px -20px rgba(23,37,84,0.22); }
  .stage img.screen { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
  /* target: four cobalt corner marks and a faint wash, never a full box */
  .hotspot { position:absolute; cursor:pointer; }
  .hotspot::before { content:""; position:absolute; inset:-7px; border-radius:6px; background:rgba(37,99,235,0.07); }
  .hotspot i { position:absolute; width:min(16px, calc(40% + 6px)); height:min(16px, calc(40% + 6px)); border:0 solid var(--accent); filter:drop-shadow(0 0 4px rgba(37,99,235,0.45)); animation:breathe 2.2s ease-in-out infinite; }
  .hotspot i:nth-child(1) { left:-7px; top:-7px; border-width:2.5px 0 0 2.5px; border-top-left-radius:4px; --x:-1; --y:-1; }
  .hotspot i:nth-child(2) { right:-7px; top:-7px; border-width:2.5px 2.5px 0 0; border-top-right-radius:4px; --x:1; --y:-1; }
  .hotspot i:nth-child(3) { right:-7px; bottom:-7px; border-width:0 2.5px 2.5px 0; border-bottom-right-radius:4px; --x:1; --y:1; }
  .hotspot i:nth-child(4) { left:-7px; bottom:-7px; border-width:0 0 2.5px 2.5px; border-bottom-left-radius:4px; --x:-1; --y:1; }
  .hotspot:hover i { animation-play-state:paused; }
  @keyframes breathe { 50% { transform:translate(calc(var(--x) * 3px), calc(var(--y) * 3px)); } }
  @media (prefers-reduced-motion: reduce) { .hotspot i { animation:none; } }
  .tip { position:absolute; max-width:min(380px, 72%); background:var(--panel); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); color:#F8FAFC; border-radius:10px; padding:12px 16px 13px; box-shadow:0 14px 36px -14px rgba(2,6,23,0.5); pointer-events:none; }
  .kicker { display:flex; align-items:center; gap:10px; font-size:13px; font-weight:600; color:#CBD5E1; }
  .kicker .n { color:var(--accent-on-dark); font-weight:700; font-variant-numeric:tabular-nums; }
  .kicker .r { width:14px; height:1.5px; background:#5C6B85; }
  .tip p { margin:3px 0 0; font-size:15px; line-height:1.55; }
  .overlay { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(15,23,48,0.82); -webkit-backdrop-filter:blur(18px) saturate(0.4); backdrop-filter:blur(18px) saturate(0.4); color:#F8FAFC; text-align:center; padding:24px; }
  .overlay .eyebrow { font-size:15px; font-weight:600; color:var(--accent-on-dark); margin:0 0 10px; }
  .overlay h2 { margin:0 0 12px; font-size:32px; font-weight:700; line-height:1.25; letter-spacing:-0.03em; }
  .overlay p { margin:0 0 26px; color:#A9B8D6; max-width:560px; }
  .overlay .kicker { justify-content:center; margin:0 0 10px; }
  .overlay .check { width:44px; height:44px; margin:0 0 18px; }
  button { font:inherit; font-weight:600; border:0; border-radius:8px; padding:11px 22px; background:var(--accent); color:#fff; cursor:pointer; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); font-weight:500; padding:9px 16px; }
  button.ghost:hover { border-color:#B6C0CF; }
  footer { width:100%; max-width:1200px; display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
</style>
</head>
<body>
<header><h1>${esc(script.title)}</h1><span class="progress" id="progress"></span></header>
<div class="segments" id="segments" aria-hidden="true"></div>
<div class="stage" id="stage"></div>
<footer><button class="ghost" id="prev">이전</button><button class="ghost" id="restart">처음부터</button></footer>
<script>
const DATA = ${JSON.stringify(data)};
const stage = document.getElementById('stage');
const progress = document.getElementById('progress');
const segments = document.getElementById('segments');
const CHECK = '<svg class="check" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20.75" fill="none" stroke="#6591F1" stroke-width="2.5"/><path d="M13.6 22.8l6.1 5.8 10.9-11.4" fill="none" stroke="#F8FAFC" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let idx = -1, busy = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
DATA.steps.forEach((s) => [s.screen, s.after, ...s.typing].forEach((src) => { if (src) { const i = new Image(); i.src = src; } }));
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function text(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }
function screen(src) { const img = el('img', 'screen'); img.src = src; img.alt = ''; return img; }
function kicker(k, title) { return '<div class="kicker"><span class="n">' + String(k + 1).padStart(2, '0') + '</span><span class="r"></span><span>' + text(title) + '</span></div>'; }
DATA.steps.forEach(() => segments.append(el('i')));
function mark(done) { [...segments.children].forEach((node, k) => { node.className = k < done ? 'done' : k === done ? 'cur' : ''; }); }
function render() {
  stage.innerHTML = '';
  if (idx < 0) {
    stage.append(screen(DATA.steps[0].screen));
    const o = el('div', 'overlay', (DATA.site ? '<div class="eyebrow">' + text(DATA.site) + ' 사용 가이드</div>' : '') + '<h2>' + text(DATA.title) + '</h2><p>' + text(DATA.intro) + '</p>');
    const b = el('button', null, '시작하기'); b.onclick = () => { idx = 0; render(); }; o.append(b); stage.append(o);
    progress.textContent = DATA.steps.length + '단계';
    mark(-1);
    return;
  }
  if (idx >= DATA.steps.length) {
    stage.append(screen(DATA.steps.at(-1).after || DATA.steps.at(-1).screen));
    const o = el('div', 'overlay', CHECK + '<h2>완료했어요</h2><p>' + text(DATA.result || DATA.outro) + '</p>');
    const b = el('button', null, '다시 해 보기'); b.onclick = () => { idx = 0; render(); }; o.append(b); stage.append(o);
    progress.textContent = '완료';
    mark(DATA.steps.length);
    return;
  }
  const s = DATA.steps[idx];
  stage.append(screen(s.screen));
  progress.textContent = (idx + 1) + ' / ' + DATA.steps.length;
  mark(idx);
  if (!s.box) { const o = el('div', 'overlay', kicker(idx, s.title) + '<p>' + text(s.instruction) + '</p>'); const b = el('button', null, '다음'); b.onclick = advance; o.append(b); stage.append(o); return; }
  const hs = el('div', 'hotspot', '<i></i><i></i><i></i><i></i>'); hs.style.left = s.box.l + '%'; hs.style.top = s.box.t + '%'; hs.style.width = s.box.w + '%'; hs.style.height = s.box.h + '%';
  hs.title = s.instruction; hs.onclick = advance; stage.append(hs);
  const tip = el('div', 'tip', kicker(idx, s.title) + '<p>' + text(s.instruction) + '</p>');
  const below = s.box.t + s.box.h < 70;
  tip.style.top = below ? 'calc(' + (s.box.t + s.box.h) + '% + 20px)' : 'auto';
  tip.style.bottom = below ? 'auto' : 'calc(' + (100 - s.box.t) + '% + 20px)';
  if (s.box.l > 55) tip.style.right = (100 - s.box.l - s.box.w) + '%'; else tip.style.left = s.box.l + '%';
  stage.append(tip);
}
async function advance() {
  if (busy || idx < 0 || idx >= DATA.steps.length) return;
  busy = true;
  const s = DATA.steps[idx];
  const img = stage.querySelector('img.screen');
  stage.querySelectorAll('.hotspot,.tip').forEach((n) => n.remove());
  for (const src of s.typing) { img.src = src; await sleep(110); }
  if (s.after) { img.src = s.after; await sleep(s.typing.length ? 250 : 350); }
  idx++; busy = false; render();
}
document.getElementById('prev').onclick = () => { if (idx > 0) { idx--; render(); } };
document.getElementById('restart').onclick = () => { idx = -1; render(); };
document.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'Enter') { if (idx < 0) { idx = 0; render(); } else advance(); } if (e.key === 'ArrowLeft' && idx > 0) { idx--; render(); } });
render();
</script>
</body>
</html>`;
  writeText(path.join(outDir, 'index.html'), html);
  return path.join(outDir, 'index.html');
}
