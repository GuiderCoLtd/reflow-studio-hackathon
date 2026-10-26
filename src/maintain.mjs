// Guide maintenance by re-execution (no source-code access needed).
// Replays every verified script against the current site and classifies each
// step: unchanged, renamed (same element, new label), relocated (found only by
// a fallback locator) or missing. Renames are fixed by rewriting the copy;
// missing targets trigger a fresh agent run of the workflow. Every update ends
// in "pending approval" with a changelog; nothing is published automatically.
import path from 'node:path';
import { callJSON, MODELS } from './llm.mjs';
import { writeJson, readJson, log } from './util.mjs';

const norm = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[*＊]\s*$/, '')
    .trim();

export async function currentName(locator) {
  return locator
    .evaluate((el) => {
      const byIds = (ids) => ids.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      const label = el.labels?.[0]?.innerText || (el.closest('label')?.innerText ?? '');
      return (
        el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') ? byIds(el.getAttribute('aria-labelledby')) : '') ||
        label ||
        el.innerText ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.value ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    })
    .catch(() => '');
}

export function compareStep(step, observed) {
  const before = norm(step.name);
  const now = norm(observed.name);
  if (!observed.found) return { kind: 'missing', before, now: null };
  const primary = step.bundle?.candidates?.[0];
  const relocated = primary && observed.via && observed.via !== primary.kind + (primary.scope ? '@' + primary.scope.role : '');
  if (!before || before === now || now.includes(before) || before.includes(now)) return { kind: relocated ? 'relocated' : 'same', before, now };
  return { kind: 'renamed', before, now };
}

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, title: { type: 'string' }, instruction: { type: 'string' }, narration: { type: 'string' } },
        required: ['i', 'title', 'instruction', 'narration'],
        additionalProperties: false,
      },
    },
    title: { type: 'string' },
    intro: { type: 'string' },
    outro: { type: 'string' },
    summary: { type: 'string' },
    result_note: { type: 'string' },
  },
  required: ['steps', 'title', 'intro', 'outro', 'summary', 'result_note'],
  additionalProperties: false,
};

// Rewrite only what the renamed labels affect; keep everything else verbatim.
export async function refreshCopy(script, renames) {
  const mapping = renames.map((r) => `'${r.before}' → '${r.now}'`).join('\n');
  const out = await callJSON({
    model: MODELS.writer,
    effort: 'low',
    system: 'You maintain a how-to guide after the product renamed some on-screen labels. Replace old labels with the new ones wherever they appear (quoted or paraphrased). Change nothing else: keep wording, tone and length identical otherwise.',
    user: `RENAMED LABELS:\n${mapping}\n\nCURRENT COPY (JSON):\n${JSON.stringify({ title: script.title, intro: script.intro, outro: script.outro, summary: script.summary, result_note: script.result_note, steps: script.steps.map((s) => ({ i: s.i, title: s.title, instruction: s.instruction, narration: s.narration })) })}`,
    schema: COPY_SCHEMA,
    name: 'copy_refresh',
    label: 'maintain',
  });
  const next = structuredClone(script);
  for (const k of ['title', 'intro', 'outro', 'summary', 'result_note']) next[k] = out[k];
  for (const s of next.steps) {
    const c = out.steps.find((x) => x.i === s.i);
    if (c) Object.assign(s, { title: c.title, instruction: c.instruction, narration: c.narration });
    const r = renames.find((x) => x.i === s.i);
    if (r) s.name = r.now;
  }
  return next;
}

export function writeMaintenance(dir, record) {
  const file = path.join(dir, 'maintenance.json');
  const history = readJson(file, { checks: [] });
  history.checks.push(record);
  history.status = record.status;
  writeJson(file, history);
  log('maintain', `${path.basename(dir)}: ${record.status} — ${record.summary}`);
}
