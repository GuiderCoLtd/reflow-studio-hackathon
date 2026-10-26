// Locator bundles: describe an element the agent acted on with several
// independent strategies, verify which ones uniquely hit it, and resolve a
// bundle back to a live element on replay.

const DESCRIBE_ELEMENT = (el) => {
  const tag = el.tagName.toLowerCase();
  const get = (n) => el.getAttribute(n);
  const clean = (s, n = 120) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-e2e'];
  let testId = null;
  for (const a of TEST_ID_ATTRS) {
    if (el.hasAttribute(a) && get(a)) {
      testId = { attr: a, value: get(a) };
      break;
    }
  }
  const labels = el.labels ? [...el.labels].map((l) => clean(l.textContent, 80)).filter(Boolean) : [];
  const volatile = (id) => /\d{4,}|[a-f0-9]{10,}|^(ember|react|radix|headlessui|mui|:r|v-|el-|vs-|rc_|tippy|downshift)/i.test(id);
  const id = get('id');
  const stableId = id && !volatile(id) && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1 ? id : null;

  const cssPath = (node) => {
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const cid = cur.getAttribute('id');
      if (cid && !volatile(cid) && document.querySelectorAll(`#${CSS.escape(cid)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cid)}`);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const xpath = (node) => {
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1) {
      const cid = cur.getAttribute('id');
      if (cid && !volatile(cid)) {
        parts.unshift(`//*[@id="${cid}"]`);
        return parts.join('/');
      }
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  };
  // Nearest named container gives the step a "where" for captions and scoping.
  const containerOf = (node) => {
    let cur = node.parentElement;
    while (cur && cur !== document.body) {
      const role = cur.getAttribute('role') || ({ dialog: 'dialog', nav: 'navigation', main: 'main', form: 'form', header: 'banner', aside: 'complementary' })[cur.tagName.toLowerCase()];
      if (role && ['dialog', 'alertdialog', 'navigation', 'menu', 'form', 'complementary', 'banner', 'main', 'tabpanel', 'listbox'].includes(role)) {
        let name = cur.getAttribute('aria-label') || '';
        const lb = cur.getAttribute('aria-labelledby');
        if (!name && lb) name = lb.split(/\s+/).map((x) => document.getElementById(x)?.textContent || '').join(' ');
        if (!name && (role === 'dialog' || role === 'alertdialog')) name = cur.querySelector('h1,h2,h3,h4,[role=heading]')?.textContent || '';
        return { role, name: clean(name, 80) };
      }
      cur = cur.parentElement;
    }
    return null;
  };
  const r = el.getBoundingClientRect();
  return {
    tag,
    type: get('type'),
    id: stableId,
    name: get('name'),
    ariaLabel: get('aria-label'),
    placeholder: get('placeholder'),
    title: get('title'),
    href: tag === 'a' ? get('href') : null,
    testId,
    labels,
    text: clean(el.innerText || el.textContent),
    value: 'value' in el && typeof el.value === 'string' ? clean(el.value, 200) : null,
    isContentEditable: !!el.isContentEditable,
    css: cssPath(el),
    xpath: xpath(el),
    container: containerOf(el),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
  };
};

export async function describeElement(locator) {
  return locator.evaluate(DESCRIBE_ELEMENT);
}

function candidateList(role, name, d) {
  const c = [];
  if (role && name && role !== 'generic') c.push({ kind: 'role', role, name, exact: true });
  if (d.testId) c.push({ kind: 'testid', attr: d.testId.attr, value: d.testId.value });
  if (d.labels?.[0]) c.push({ kind: 'label', value: d.labels[0] });
  if (d.placeholder) c.push({ kind: 'placeholder', value: d.placeholder });
  if (d.id) c.push({ kind: 'css', value: `#${cssEscape(d.id)}` });
  if (d.name && ['input', 'select', 'textarea', 'button'].includes(d.tag)) c.push({ kind: 'css', value: `${d.tag}[name="${d.name}"]` });
  if (d.href && d.href !== '#' && !d.href.startsWith('javascript')) c.push({ kind: 'css', value: `a[href="${d.href}"]` });
  if (d.text && d.text.length <= 60 && !['input', 'textarea', 'select'].includes(d.tag)) c.push({ kind: 'text', value: d.text });
  c.push({ kind: 'css', value: d.css });
  c.push({ kind: 'xpath', value: d.xpath });
  return c;
}

function cssEscape(s) {
  return String(s).replace(/([^\w-])/g, '\\$1');
}

export function toLocator(page, cand) {
  let root = page;
  if (cand.scope) root = page.getByRole(cand.scope.role, cand.scope.name ? { name: cand.scope.name } : {});
  switch (cand.kind) {
    case 'role':
      return root.getByRole(cand.role, { name: cand.name, exact: cand.exact !== false });
    case 'testid':
      return root.locator(`[${cand.attr}="${cand.value}"]`);
    case 'label':
      return root.getByLabel(cand.value, { exact: true });
    case 'placeholder':
      return root.getByPlaceholder(cand.value, { exact: true });
    case 'text':
      return root.getByText(cand.value, { exact: true });
    case 'xpath':
      return root.locator(`xpath=${cand.value}`);
    case 'css':
    default:
      return root.locator(cand.value);
  }
}

export function locatorCode(cand) {
  const q = (s) => JSON.stringify(s);
  const scope = cand.scope ? `getByRole(${q(cand.scope.role)}${cand.scope.name ? `, { name: ${q(cand.scope.name)} }` : ''}).` : '';
  switch (cand.kind) {
    case 'role':
      return `page.${scope}getByRole(${q(cand.role)}, { name: ${q(cand.name)}, exact: true })`;
    case 'testid':
      return `page.${scope}locator(${q(`[${cand.attr}="${cand.value}"]`)})`;
    case 'label':
      return `page.${scope}getByLabel(${q(cand.value)}, { exact: true })`;
    case 'placeholder':
      return `page.${scope}getByPlaceholder(${q(cand.value)}, { exact: true })`;
    case 'text':
      return `page.${scope}getByText(${q(cand.value)}, { exact: true })`;
    case 'xpath':
      return `page.${scope}locator(${q('xpath=' + cand.value)})`;
    default:
      return `page.${scope}locator(${q(cand.value)})`;
  }
}

// Build and verify a bundle for the element behind `target` (a live locator).
export async function buildBundle(page, target, { role, name } = {}) {
  const d = await describeElement(target);
  const probe = `ag${Math.random().toString(36).slice(2, 8)}`;
  await target.evaluate((el, p) => el.setAttribute('data-ag-probe', p), probe);
  const verified = [];
  try {
    const cands = candidateList(role, name, d);
    // A non-unique role/name inside a named container can be scoped to it.
    if (role && name && d.container?.role && ['dialog', 'alertdialog', 'navigation', 'menu', 'form', 'complementary', 'tabpanel', 'listbox'].includes(d.container.role)) {
      cands.splice(1, 0, { kind: 'role', role, name, exact: true, scope: { role: d.container.role, name: d.container.name || undefined } });
    }
    for (const cand of cands) {
      let count = 0;
      let hits = false;
      try {
        const loc = toLocator(page, cand);
        count = await loc.count();
        if (count === 1) hits = await loc.evaluate((el, p) => el.getAttribute('data-ag-probe') === p, probe);
        else if (count > 1 && count <= 30) {
          const flags = await loc.evaluateAll((els, p) => els.map((el) => el.getAttribute('data-ag-probe') === p), probe);
          const idx = flags.indexOf(true);
          if (idx >= 0) cand.nth = idx;
        }
      } catch {
        count = -1;
      }
      verified.push({ ...cand, count, unique: count === 1 && hits });
    }
  } finally {
    await target.evaluate((el) => el.removeAttribute('data-ag-probe')).catch(() => {});
  }
  const ordered = [...verified.filter((v) => v.unique), ...verified.filter((v) => !v.unique && v.nth !== undefined)];
  return { describe: d, role: role || null, name: name || null, candidates: ordered, all: verified, primary: ordered[0] ? locatorCode(ordered[0]) : null };
}

// Resolve a bundle on a (possibly changed) page. Returns { locator, via } or null.
export async function resolveBundle(page, bundle, { timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const cand of bundle.candidates || []) {
      try {
        let loc = toLocator(page, cand);
        const count = await loc.count();
        if (count === 1 && cand.unique) {
          if (await loc.isVisible()) return { locator: loc, via: cand };
        } else if (count > 1 && cand.nth !== undefined && cand.nth < count) {
          loc = loc.nth(cand.nth);
          if (await loc.isVisible()) return { locator: loc, via: { ...cand, usedNth: true } };
        }
      } catch {
        /* try next */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// The visible element a user would actually click for `locator`: its label,
// an ancestor label, or whatever sits on top at its centre.
export async function clickProxy(page, locator) {
  const handle = await locator.elementHandle({ timeout: 2000 }).catch(() => null);
  if (!handle) return null;
  const proxyHandle = await handle.evaluateHandle((el) => {
    const visible = (n) => {
      if (!n || n.nodeType !== 1) return false;
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    if (el.labels && el.labels.length && visible(el.labels[0])) return el.labels[0];
    const lab = el.closest('label');
    if (lab && visible(lab)) return lab;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (top && top !== el && visible(top)) return top;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (visible(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  });
  const proxyEl = proxyHandle.asElement();
  if (!proxyEl) return null;
  const mark = `agp${Math.random().toString(36).slice(2, 8)}`;
  await proxyEl.evaluate((n, m) => n.setAttribute('data-ag-proxy', m), mark);
  return page.locator(`[data-ag-proxy="${mark}"]`);
}

