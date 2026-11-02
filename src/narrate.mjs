// Synthesize narration for a compiled script: intro, one clip per step, outro.
// Writes narration.json with real clip durations for the video renderer.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { speak } from './tts.mjs';
import { currentProvider, transcribe } from './llm.mjs';
import { writeJson, log } from './util.mjs';

// How close a transcript is to the line (0..1), ignoring spacing and punctuation.
function closeness(a, b) {
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

// Listen back: a synthetic voice can mangle a word, and nobody reviews every clip.
async function listenBack(clips) {
  const out = [];
  for (const c of clips) {
    try {
      const wav = execFileSync('ffmpeg', ['-v', 'error', '-i', c.wav, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBuffer: 1 << 28 });
      const heard = await transcribe(wav);
      out.push({ key: c.key, said: c.text, heard, score: Number(closeness(c.text, heard).toFixed(3)) });
    } catch (err) {
      log('narrate', `listen-back failed for ${c.key}: ${err.message.split('\n')[0]}`);
    }
  }
  return out;
}

export async function narrateScript(script, { outDir, provider = 'openai', lang = script.lang || 'ko', concurrency = 4 } = {}) {
  const items = [
    { key: 'intro', text: script.intro },
    ...script.steps.map((s) => ({ key: `step-${s.i}`, i: s.i, text: s.narration })),
    { key: 'outro', text: script.outro },
  ].filter((x) => x.text);
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const k = next++;
      const it = items[k];
      const clip = await speak(it.text, { provider, lang });
      out[k] = { ...it, wav: clip.wav, duration: Number(clip.duration.toFixed(3)) };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const narration = {
    provider,
    lang,
    voice: out[0]?.voice,
    intro: out.find((x) => x.key === 'intro') || null,
    outro: out.find((x) => x.key === 'outro') || null,
    steps: out.filter((x) => x.key.startsWith('step-')),
    total: Number(out.reduce((a, x) => a + x.duration, 0).toFixed(2)),
  };
  if (currentProvider() === 'meta') {
    narration.listenBack = await listenBack(out);
    const low = narration.listenBack.filter((c) => c.score < 0.8);
    log('narrate', `listen-back: ${narration.listenBack.length} clips, ${low.length} below 0.8${low.length ? `: ${low.map((c) => `${c.key} heard "${c.heard}"`).join('; ')}` : ''}`);
  }
  writeJson(path.join(outDir, 'narration.json'), narration);
  log('narrate', `${items.length} clips, ${narration.total}s total (${provider})`);
  return narration;
}
