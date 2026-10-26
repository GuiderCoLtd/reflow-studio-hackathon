// Turn an exploration map into (1) per-screen summaries, (2) a site brief the
// performer can lean on, and (3) a catalog of candidate how-to workflows, each
// grounded in screens that were actually observed.
import path from 'node:path';
import fs from 'node:fs';
import { callJSON, imageFilePart, MODELS } from './llm.mjs';
import { writeJson, writeText, truncate, log } from './util.mjs';

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    screen_name: { type: 'string', description: 'Short name of this screen in the site language' },
    purpose: { type: 'string', description: 'What a user does here, one sentence, English' },
    purpose_local: { type: 'string', description: 'The same purpose sentence in the site language, short (for customer-facing review screens)' },
    entities: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Exact on-screen label' },
          where: { type: 'string', description: 'Where it is (header, sidebar, toolbar, row menu, dialog...)' },
          effect: { type: 'string', enum: ['navigate', 'read', 'create', 'update', 'delete', 'send', 'settings', 'other'] },
        },
        required: ['label', 'where', 'effect'],
        additionalProperties: false,
      },
    },
    forms: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, submit_label: { type: 'string' } },
        required: ['name', 'fields', 'submit_label'],
        additionalProperties: false,
      },
    },
    user_tasks: { type: 'array', items: { type: 'string' }, description: 'Concrete tasks a user could accomplish starting here, English' },
  },
  required: ['screen_name', 'purpose', 'purpose_local', 'entities', 'actions', 'forms', 'user_tasks'],
  additionalProperties: false,
};

export async function summarizePages(map, { outDir, concurrency = 6, model = MODELS.writer } = {}) {
  const summaries = new Array(map.pages.length);
  let next = 0;
  async function worker() {
    while (next < map.pages.length) {
      const i = next++;
      const p = map.pages[i];
      const probes = (p.probes || [])
        .filter((x) => x.kind !== 'none')
        .map((x) => `- Clicking "${x.label}" (${x.role}) -> ${x.kind}${x.toUrl ? ' ' + x.toUrl : ''}${x.revealed ? `\n  revealed:\n${indent(truncate(x.revealed, 1500), 4)}` : ''}`)
        .join('\n');
      const img = p.shot && fs.existsSync(path.join(outDir, p.shot)) ? [imageFilePart(path.join(outDir, p.shot), 'low')] : [];
      try {
        const s = await callJSON({
          model,
          effort: 'low',
          system: 'You document web application screens for a help center. Use only what the snapshot and screenshot show. Keep on-screen labels verbatim.',
          user: `URL: ${p.url}\nTITLE: ${p.title}\n\nACCESSIBILITY SNAPSHOT:\n${truncate(p.snapshot, 7000)}\n\nPROBED CONTROLS (clicked during exploration, then closed):\n${probes || '(none)'}`,
          images: img,
          schema: SUMMARY_SCHEMA,
          name: 'screen_summary',
          label: 'summarize',
        });
        summaries[i] = { id: p.id, url: p.url, template: p.template, title: p.title, via: p.via, ...s };
      } catch (err) {
        log('plan', `summary failed ${p.id}: ${err.message}`);
        summaries[i] = { id: p.id, url: p.url, template: p.template, title: p.title, via: p.via, screen_name: p.title, purpose: '', purpose_local: '', entities: [], actions: [], forms: [], user_tasks: [] };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeJson(path.join(outDir, 'summaries.json'), summaries);
  return summaries;
}

function indent(text, n) {
  return String(text)
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n');
}

// Compact, human-readable knowledge of the site used by the planner and the performer.
export function buildBrief(summaries, { only = null } = {}) {
  const pick = only ? summaries.filter((s) => only.includes(s.id)) : summaries;
  return pick
    .map((s) => {
      const via = s.via ? ` (reached via "${s.via.label}" from ${s.via.from})` : '';
      const acts = s.actions.slice(0, 14).map((a) => `'${a.label}' [${a.effect}] @${a.where}`).join('; ');
      const forms = s.forms.map((f) => `${f.name}: fields ${f.fields.map((x) => `'${x}'`).join(', ')}; submit '${f.submit_label}'`).join(' | ');
      return `${s.id} ${s.screen_name} — ${s.url}${via}\n  purpose: ${s.purpose}\n  actions: ${acts}${forms ? `\n  forms: ${forms}` : ''}`;
    })
    .join('\n');
}

const CATALOG_SCHEMA = {
  type: 'object',
  properties: {
    product_summary: { type: 'string', description: 'What the product is, 2 sentences, English' },
    personas: { type: 'array', items: { type: 'string' } },
    workflows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case slug' },
          title: { type: 'string', description: 'How-to title in the guide language, e.g. "새 프로젝트 만드는 방법"' },
          title_en: { type: 'string' },
          category: { type: 'string', description: 'Group name in the guide language' },
          persona: { type: 'string' },
          goal: { type: 'string', description: 'Precise instruction for an agent, English, including names/values to use' },
          start_screen: { type: 'string', description: 'Screen id where the workflow starts (usually the home screen)' },
          path_hint: { type: 'string', description: 'How to get there through the UI, using observed labels' },
          preconditions: { type: 'string' },
          sample_data: {
            type: 'array',
            items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'], additionalProperties: false },
          },
          success_criteria: { type: 'string', description: 'Observable end state that proves success (English). Must be checkable by the same user in the same browser session at the end of the workflow: no other accounts, emails or external systems.' },
          success_criteria_local: { type: 'string', description: 'The same success criteria in the guide language, one short sentence' },
          effects: { type: 'array', items: { type: 'string', enum: ['read', 'create', 'update', 'delete', 'send', 'settings'] } },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Screen ids that show this workflow exists' },
          value: { type: 'integer', description: '1-5: how often real users need this guide' },
          difficulty: { type: 'integer', description: '1-5: how hard it is for a new user without a guide' },
          est_steps: { type: 'integer' },
          unverified: { type: 'string', description: 'What the map does not prove yet (empty if fully observed)' },
        },
        required: ['id', 'title', 'title_en', 'category', 'persona', 'goal', 'start_screen', 'path_hint', 'preconditions', 'sample_data', 'success_criteria', 'success_criteria_local', 'effects', 'evidence', 'value', 'difficulty', 'est_steps', 'unverified'],
        additionalProperties: false,
      },
    },
  },
  required: ['product_summary', 'personas', 'workflows'],
  additionalProperties: false,
};

export async function proposeWorkflows(summaries, { site, outDir, lang = 'ko', focus = '', max = 16, model = MODELS.planner } = {}) {
  const brief = buildBrief(summaries);
  const catalog = await callJSON({
    model,
    effort: 'medium',
    system: `You are a customer-education lead planning a help center for a web product. From an exploration map you propose how-to guides users actually need. Ground every workflow in observed screens (cite screen ids). Do not invent features. Prefer real end-user jobs over trivia (theme toggles, language menus). Order by value. Titles and categories in ${lang === 'ko' ? 'Korean' : lang}.`,
    user: `PRODUCT: ${site.name} — ${site.description || ''}\nBASE URL: ${site.baseUrl}\n${focus ? `CUSTOMER PRIORITIES: ${focus}\n` : ''}\nSCREENS (from exploration):\n${brief}\n\nPropose up to ${max} workflows. Use realistic sample data in ${lang === 'ko' ? 'Korean' : lang} consistent with existing data. The goal must be achievable from the start screen through the UI. Workflows that create data must use new, distinctive names so the result is verifiable. Dates in sample data must be valid for the site's own "today": find it in the screens (a greeting date, a calendar, a row marked 오늘/today); records of things that already happened (expenses, attendance corrections, reports) must be dated on or before that day, plans (leave, bookings) after it. If no screen shows a date, today is ${new Date().toISOString().slice(0, 10)}.`,
    schema: CATALOG_SCHEMA,
    name: 'workflow_catalog',
    label: 'propose',
  });
  writeJson(path.join(outDir, 'catalog.json'), catalog);
  writeText(path.join(outDir, 'brief.md'), brief);
  return catalog;
}
