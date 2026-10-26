// Compile an agent trace into a guide script: drop detours, keep the minimal
// reproducible path, and write the copy for each output format (short step
// title, on-screen instruction, spoken narration). The script is then verified
// by a deterministic replay before anything is filmed.
import path from 'node:path';
import { callJSON, MODELS } from './llm.mjs';
import { writeJson, truncate } from './util.mjs';

const LANG = { ko: 'Korean (polite 해요체 for narration, concise imperative for instructions)', en: 'English' };

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    keep: { type: 'array', items: { type: 'integer' }, description: 'Indexes of trace steps a user must perform, in order' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          title: { type: 'string', description: 'Very short step label (max ~18 Korean chars)' },
          instruction: { type: 'string', description: 'One imperative sentence for docs and on-screen tooltips; quote UI labels verbatim in single quotes' },
          narration: { type: 'string', description: 'What the narrator says while this step happens: ONE short spoken sentence (Korean: at most ~40 characters). Say where to look and what to press. Do not read long labels in full; refer to them by their key words.' },
        },
        required: ['index', 'title', 'instruction', 'narration'],
        additionalProperties: false,
      },
    },
    guide_title: { type: 'string' },
    intro: { type: 'string', description: "Narrated opening line, one short sentence (Korean: at most ~35 characters) that states what the guide covers, e.g. '…하는 방법을 안내해요.'; no suggestive '~해 봐요'" },
    outro: { type: 'string', description: 'Narrated closing line, one short sentence (Korean: at most ~35 characters)' },
    summary: { type: 'string', description: '2-3 sentence description for the article header' },
    prerequisites: { type: 'array', items: { type: 'string' } },
    result_note: { type: 'string', description: 'What the user sees when finished' },
  },
  required: ['keep', 'steps', 'guide_title', 'intro', 'outro', 'summary', 'prerequisites', 'result_note'],
  additionalProperties: false,
};

function describe(s, i) {
  const t = s.target ? `${s.target.role} '${truncate(s.target.name || s.target.text || '', 60)}'` : '';
  const where = s.target?.container?.role ? ` in ${s.target.container.role}${s.target.container.name ? ` '${s.target.container.name}'` : ''}` : '';
  const val = s.args.value !== undefined ? ` value="${truncate(s.args.value, 60)}"` : s.args.option ? ` option='${s.args.option}'` : s.args.key ? ` key=${s.args.key}` : '';
  const moved = s.urlAfter && s.urlAfter !== s.urlBefore ? ` → ${new URL(s.urlAfter).pathname}` : '';
  const net = (s.network || []).filter((n) => n.mutating).map((n) => `${n.method} ${n.status}`).join(',');
  return `[${i}] ${s.tool} ${t}${where}${val} status=${s.status}${s.guideStep ? '' : ' (agent marked non-guide)'}${moved}${net ? ` net=${net}` : ''}\n     caption: ${s.caption}`;
}

export async function compileTrace(trace, { outDir, lang = 'ko', site } = {}) {
  const lines = trace.steps.map((s, i) => describe(s, i)).join('\n');
  const edit = await callJSON({
    model: MODELS.writer,
    effort: 'medium',
    system: `You turn a browser agent's action log into a clean how-to guide. Keep only the actions a user must perform to reproduce the result, in order: drop failed attempts, detours, scrolling, exploratory clicks, and focus clicks immediately followed by typing into the same field. Never keep go_back steps, and drop any step whose effect a later go_back undid (for example opening a file preview in a new tab and closing it again). Never keep a step whose status is error or blocked. Write all copy in ${LANG[lang] || lang}. Narration is spoken over the video, so it must be brief and conversational; the instruction text carries the full detail. Quote on-screen labels verbatim in single quotes exactly as in the log (do not translate them).`,
    user: `WORKFLOW: ${trace.workflow.title}\nGOAL: ${trace.workflow.goal}\nRESULT: ${trace.verdict.success ? 'success' : 'failed'} — ${trace.verdict.end_state}\n\nACTION LOG:\n${lines}`,
    schema: EDIT_SCHEMA,
    name: 'guide_edit',
    label: 'compile',
  });
  const copy = new Map(edit.steps.map((s) => [s.index, s]));
  // Deterministic guard on top of the model's choice: back/scroll steps cannot
  // be replayed, and a step whose page a later go_back closed was a detour.
  const undone = new Set();
  trace.steps.forEach((s, i) => {
    if (s.tool !== 'go_back') return;
    for (let j = i - 1; j >= 0; j--) {
      const p = trace.steps[j];
      if (p.tool === 'go_back') continue;
      if (p.urlAfter && p.urlAfter === s.urlBefore && p.urlAfter !== p.urlBefore) undone.add(j);
      break;
    }
  });
  const keep = edit.keep.filter((idx) => !['go_back', 'scroll'].includes(trace.steps[idx]?.tool) && !undone.has(idx));
  const steps = [];
  for (const idx of keep) {
    let s = trace.steps[idx];
    if (!s || s.status === 'error' || s.status === 'blocked') continue;
    // Enter/Space on a focused link or button is a click on that element.
    if (s.tool === 'press_key' && /^(Enter|Space| )$/.test(s.args.key) && s.focus?.bundle && ['link', 'button', 'menuitem', 'tab', 'checkbox', 'option'].includes(s.focus.role)) {
      s = { ...s, tool: 'click', bundle: s.focus.bundle, target: { role: s.focus.role, name: s.focus.name }, args: { ...s.args, key: undefined } };
    }
    const c = copy.get(idx) || { title: s.caption, instruction: s.caption, narration: s.caption };
    steps.push({
      i: steps.length + 1,
      from: idx,
      action: { click: 'click', fill: 'fill', select_option: 'select', press_key: 'press', hover: 'hover' }[s.tool] || s.tool,
      bundle: s.bundle ? { candidates: s.bundle.candidates, describe: s.bundle.describe, role: s.bundle.role, name: s.bundle.name } : null,
      role: s.target?.role || null,
      name: s.target?.name || null,
      value: s.args.value,
      option: s.args.option,
      key: s.args.key,
      ghost: s.status === 'ghost',
      title: c.title,
      instruction: c.instruction,
      narration: c.narration,
      urlBefore: s.urlBefore,
      urlAfter: s.urlAfter,
      boxPerform: s.box || null,
    });
  }
  const script = {
    version: 1,
    site: site ? { id: site.id, name: site.name, baseUrl: site.baseUrl, lang: site.lang } : null,
    workflow: trace.workflow,
    title: edit.guide_title || trace.workflow.title,
    summary: edit.summary,
    intro: edit.intro,
    outro: edit.outro,
    prerequisites: edit.prerequisites,
    result_note: edit.result_note,
    start_url: trace.workflow.start_url,
    lang,
    steps,
    performVerdict: trace.verdict,
  };
  if (outDir) writeJson(path.join(outDir, 'script.json'), script);
  return script;
}
