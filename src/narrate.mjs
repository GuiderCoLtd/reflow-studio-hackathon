// Synthesize narration for a compiled script: intro, one clip per step, outro.
// Writes narration.json with real clip durations for the video renderer.
import path from 'node:path';
import { speak } from './tts.mjs';
import { writeJson, log } from './util.mjs';

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
  writeJson(path.join(outDir, 'narration.json'), narration);
  log('narrate', `${items.length} clips, ${narration.total}s total (${provider})`);
  return narration;
}
