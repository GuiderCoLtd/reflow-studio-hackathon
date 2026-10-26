// Page observation for the agent: a compact, ref-annotated accessibility view
// built from Playwright's AI-mode aria snapshot.
import { truncate } from './util.mjs';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider',
  'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'listbox',
]);
const STRUCTURAL_ROLES = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'dialog', 'alertdialog',
  'menu', 'menubar', 'tablist', 'tabpanel', 'list', 'table', 'grid', 'rowgroup', 'row', 'toolbar', 'tree', 'group',
]);
const SIGNAL_ROLES = new Set(['heading', 'alert', 'status', 'img', 'cell', 'columnheader', 'rowheader', 'listitem', 'paragraph']);

const LIST_KEEP = 6; // repeated siblings kept before collapsing
let listKeep = LIST_KEEP;

export async function observe(session, { maxChars = 14000, collapse = true } = {}) {
  const page = session.page;
  // A file opened in a tab (image, SVG, PDF) has no controls to read.
  const ctype = await page.evaluate(() => document.contentType).catch(() => 'text/html');
  if (ctype && !/html/i.test(ctype)) {
    return { url: page.url(), title: '', snapshot: `- document "${ctype}": a file shown in this tab, with no controls. Use go_back to return.`, refs: new Map(), lineCount: 1 };
  }
  let tree = [];
  try {
    tree = await page.ariaSnapshotJSON({ mode: 'ai' });
  } catch {
    tree = [];
  }
  await enrichUnnamed(page, tree);
  const editors = await markRichEditors(page, tree);
  const refs = new Map();
  const lines = [];
  listKeep = collapse ? LIST_KEEP : Infinity;
  for (const node of asArray(tree)) render(node, 0, lines, refs);
  for (const ed of editors) {
    refs.set(ed.id, { role: 'textbox', name: ed.name, selector: ed.selector });
    if (!ed.placed) lines.push(`- textbox "${truncate(ed.name, 80)}" [${ed.id}] {rich-text editor: use fill}`);
  }
  let text = lines.join('\n');
  if (Number.isFinite(maxChars) && text.length > maxChars) text = shrink(lines, maxChars);
  let title = '';
  try {
    title = await page.title();
  } catch {
    /* navigating */
  }
  return { url: page.url(), title, snapshot: text, refs, lineCount: lines.length };
}

// Some apps hide link text from the accessibility tree (icon fonts, odd
// markup). Fill empty names of interactive nodes from visible text so the
// agent and the captions can still refer to them.
async function enrichUnnamed(page, tree, cap = 60) {
  const todo = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.ref && !n.name && (INTERACTIVE_ROLES.has(n.role) || n.cursor === 'pointer') && todo.length < cap) todo.push(n);
    for (const c of asArray(n.children)) walk(c);
  };
  for (const n of asArray(tree)) walk(n);
  await Promise.all(
    todo.map(async (n) => {
      try {
        const text = await page.locator(`aria-ref=${n.ref}`).evaluate((el) =>
          (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        { timeout: 800 });
        if (text) {
          n.name = text;
          n.nameFromText = true;
        }
      } catch {
        /* detached */
      }
    }),
  );
}

// Rich-text editors (ProseMirror/TipTap/Quill/CKEditor) are contenteditable
// roots that the accessibility tree often reports as plain generic nodes.
// Find them in the DOM and relabel the matching snapshot node as a textbox.
async function markRichEditors(page, tree, cap = 6) {
  // Each visible editor root gets a data attribute and a synthetic ref (rteN)
  // backed by a selector, so the agent never acts through a mismatched ref.
  const editors = [];
  try {
    const loc = page.locator('[contenteditable="true"]:visible, [contenteditable=""]:visible');
    const n = Math.min(await loc.count(), cap);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const info = await el
        .evaluate((node, k) => {
          node.setAttribute('data-ag-rte', String(k));
          const ph = node.querySelector('[data-placeholder]')?.getAttribute('data-placeholder') || node.getAttribute('aria-label') || node.getAttribute('data-placeholder') || '';
          return { name: (ph || node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
        }, i + 1)
        .catch(() => null);
      if (!info) continue;
      const sub = await el.ariaSnapshot({ mode: 'ai', timeout: 1000 }).catch(() => '');
      const m = sub.match(/\[ref=([^\]]+)\]/);
      editors.push({ id: `rte${i + 1}`, selector: `[data-ag-rte="${i + 1}"]`, name: info.name, subRef: m ? m[1].replace(/^f\d+/, '') : null, placed: false });
    }
  } catch {
    /* page changed under us */
  }
  if (!editors.length) return [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const ed = node.ref && editors.find((e) => !e.placed && e.subRef && e.subRef === String(node.ref).replace(/^f\d+/, ''));
    if (ed) {
      node.role = 'textbox';
      node.richText = true;
      node.ref = ed.id;
      node.selector = ed.selector;
      node.name = node.name || ed.name;
      ed.placed = true;
    }
    for (const c of asArray(node.children)) walk(c);
  };
  for (const node of asArray(tree)) walk(node);
  return editors;
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function attrs(node) {
  const out = [];
  for (const key of ['level', 'checked', 'disabled', 'expanded', 'selected', 'pressed', 'active', 'required']) {
    if (node[key] !== undefined && node[key] !== false) out.push(node[key] === true ? key : `${key}=${node[key]}`);
  }
  if (node.expanded === false) out.push('collapsed');
  if (node.value !== undefined && node.value !== '') out.push(`value="${truncate(node.value, 60)}"`);
  if (node.url) out.push(`url=${truncate(node.url, 80)}`);
  if (node.richText) out.push('rich-text editor: use fill');
  return out.length ? ` {${out.join(', ')}}` : '';
}

function render(node, depth, lines, refs) {
  if (typeof node === 'string') {
    const t = node.trim();
    if (t) lines.push(`${'  '.repeat(depth)}"${truncate(t, 140)}"`);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const role = node.role || 'generic';
  const name = (node.name || '').trim();
  const children = asArray(node.children);
  if (node.ref) refs.set(node.ref, { role, name, expanded: node.expanded, selector: node.selector });

  const isGeneric = role === 'generic' || role === 'none' || role === 'presentation';
  const ownText = typeof node.text === 'string' ? node.text.trim() : '';
  // Unnamed generic wrappers are transparent: hoist their children.
  if (isGeneric && !name) {
    if (ownText) lines.push(`${'  '.repeat(depth)}"${truncate(ownText, 140)}"`);
    renderChildren(children, depth, lines, refs);
    return;
  }
  const keep = INTERACTIVE_ROLES.has(role) || STRUCTURAL_ROLES.has(role) || SIGNAL_ROLES.has(role) || name || ownText;
  if (!keep) {
    renderChildren(children, depth, lines, refs);
    return;
  }
  const label = name ? ` "${truncate(name, 100)}"` : '';
  const ref = node.ref && (INTERACTIVE_ROLES.has(role) || node.cursor === 'pointer' || STRUCTURAL_ROLES.has(role) || role === 'heading' || role === 'cell' || role === 'listitem' || role === 'row') ? ` [${node.ref}]` : '';
  const clickable = node.cursor === 'pointer' && !INTERACTIVE_ROLES.has(role) ? ' {clickable}' : '';
  const textPart = ownText && ownText !== name ? `: "${truncate(ownText, 120)}"` : '';
  lines.push(`${'  '.repeat(depth)}- ${role}${label}${ref}${attrs(node)}${clickable}${textPart}`);
  renderChildren(children, depth + 1, lines, refs);
}

// Unnamed, text-less generic wrappers are layout noise; splice their children
// into the parent's list so repeated items under per-item wrappers still group.
function flattenTransparent(children, out = []) {
  for (const c of children) {
    if (c && typeof c === 'object' && (c.role === 'generic' || c.role === 'none' || c.role === 'presentation' || !c.role) && !c.name && !(typeof c.text === 'string' && c.text.trim())) {
      flattenTransparent(asArray(c.children), out);
    } else out.push(c);
  }
  return out;
}

function renderChildren(rawChildren, depth, lines, refs) {
  const children = flattenTransparent(rawChildren);
  // Collapse long runs of same-role siblings (table rows, list items, cards).
  const groups = new Map();
  for (const c of children) {
    const key = typeof c === 'string' ? '#text' : c?.role || 'generic';
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const seen = new Map();
  let skipped = new Map();
  for (const c of children) {
    const key = typeof c === 'string' ? '#text' : c?.role || 'generic';
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (groups.get(key) > listKeep + 2 && n > listKeep && !(key === 'generic' && !c?.name)) {
      skipped.set(key, (skipped.get(key) || 0) + 1);
      // Still register refs of hidden siblings so a remembered ref stays usable.
      registerRefs(c, refs);
      continue;
    }
    render(c, depth, lines, refs);
  }
  for (const [key, count] of skipped) lines.push(`${'  '.repeat(depth)}… (+${count} more ${key} items)`);
}

function registerRefs(node, refs) {
  if (!node || typeof node !== 'object') return;
  if (node.ref) refs.set(node.ref, { role: node.role || 'generic', name: (node.name || '').trim() });
  for (const c of asArray(node.children)) registerRefs(c, refs);
}

// Keep interactive lines and their structure first; drop deep plain text last.
function shrink(lines, maxChars) {
  const scored = lines.map((line, i) => {
    const indent = line.match(/^ */)[0].length / 2;
    let score = 10 - Math.min(indent, 9);
    if (/\[e\d+\]|\[f\d+e\d+\]/.test(line)) score += 20;
    if (/- (heading|dialog|alertdialog|alert|navigation|main|tab|menu)/.test(line)) score += 15;
    if (/^ *"/.test(line)) score -= 5;
    return { line, i, score };
  });
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const keep = new Set();
  let total = 0;
  for (const s of sorted) {
    if (total + s.line.length + 1 > maxChars) continue;
    keep.add(s.i);
    total += s.line.length + 1;
  }
  const out = [];
  let gap = 0;
  for (const s of scored) {
    if (keep.has(s.i)) {
      if (gap) out.push(`${' '.repeat(s.line.match(/^ */)[0].length)}… (${gap} lines omitted)`);
      gap = 0;
      out.push(s.line);
    } else gap++;
  }
  return out.join('\n');
}

export function refLabel(obs, ref) {
  const r = obs.refs.get(ref);
  return r ? `${r.role} "${r.name}"` : ref;
}

// Search the full, uncollapsed snapshot for lines mentioning `query` and
// return them with their ancestor lines so the agent can act on hidden items.
export async function findInPage(session, query, { maxHits = 20 } = {}) {
  const full = await observe(session, { maxChars: Infinity, collapse: false });
  const lines = full.snapshot.split('\n');
  const q = String(query || '').toLowerCase().trim();
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    if (!q || !lines[i].toLowerCase().includes(q)) continue;
    const indent = lines[i].match(/^ */)[0].length;
    const ctx = [];
    for (let j = i - 1; j >= 0 && ctx.length < 2; j--) {
      const ind = lines[j].match(/^ */)[0].length;
      if (ind < indent) ctx.unshift(lines[j]);
    }
    hits.push([...ctx, lines[i]].join('\n'));
  }
  return { hits, refs: full.refs };
}
