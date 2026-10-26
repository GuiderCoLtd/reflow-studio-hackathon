// Dodam Work client behaviour: dropdown menus, dialogs, segmented radios,
// switches, clickable rows, live form summaries and resending invitations.
// Nothing changes the layout on load (pages are fully rendered on the server);
// the only motion is CSS (menus and dialogs fade in, live numbers tick).
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- dropdown menus (notifications, profile) ----------
  let openMenu = null;
  const menuItems = (panel) => $$('[role="menuitem"]', panel);

  function closeMenu(focusTrigger) {
    if (!openMenu) return;
    openMenu.panel.hidden = true;
    openMenu.trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) openMenu.trigger.focus();
    openMenu = null;
  }

  function showMenu(trigger, focusFirst) {
    const panel = document.getElementById(trigger.getAttribute('aria-controls'));
    if (!panel) return;
    closeMenu(false);
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { trigger, panel };
    if (focusFirst) menuItems(panel)[0]?.focus();
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-menu-trigger]');
    if (trigger) {
      if (trigger.getAttribute('aria-expanded') === 'true') closeMenu(false);
      // e.detail === 0 means keyboard activation: move focus into the menu.
      else showMenu(trigger, e.detail === 0);
      return;
    }
    if (openMenu && !openMenu.panel.contains(e.target)) closeMenu(false);
  });

  document.addEventListener('keydown', (e) => {
    const trigger = e.target.closest?.('[data-menu-trigger]');
    if (trigger && e.key === 'ArrowDown') {
      e.preventDefault();
      showMenu(trigger, true);
      return;
    }
    if (!openMenu) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
      return;
    }
    if (e.key === 'Tab') {
      closeMenu(false);
      return;
    }
    const list = menuItems(openMenu.panel);
    const i = list.indexOf(document.activeElement);
    const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (move !== undefined && list.length) {
      e.preventDefault();
      list[(move + list.length) % list.length].focus();
    }
  });

  // ---------- dialogs ----------
  function openDialog(id, opener) {
    const dialog = document.getElementById(id);
    if (!dialog || dialog.open) return;
    closeMenu(false);
    dialog.showModal();
    if (opener) {
      dialog.opener = opener;
      opener.setAttribute('aria-expanded', 'true');
    }
    dialog.querySelector('[autofocus]')?.focus();
  }

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-dialog-open]');
    if (opener) {
      e.preventDefault();
      openDialog(opener.getAttribute('data-dialog-open'), opener);
      return;
    }
    const closer = e.target.closest('[data-dialog-close]');
    if (closer) closer.closest('dialog')?.close();
  });

  for (const dialog of $$('dialog')) {
    dialog.addEventListener('close', () => dialog.opener?.setAttribute('aria-expanded', 'false'));
    // A click that starts and ends on the backdrop closes the dialog.
    dialog.addEventListener('mousedown', (e) => {
      dialog.pressedBackdrop = e.target === dialog;
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && dialog.pressedBackdrop) dialog.close();
      dialog.pressedBackdrop = false;
    });
  }

  // Forms inside a dialog that came back with errors reopen it.
  for (const dialog of $$('dialog[data-autoopen]')) openDialog(dialog.id, $(`[data-dialog-open="${dialog.id}"]`));

  // "/" opens search.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || $('dialog[open]')) return;
    e.preventDefault();
    openDialog('search-dialog', $('[data-dialog-open="search-dialog"]'));
  });

  // ---------- segmented radios ----------
  for (const group of $$('[role="radiogroup"][data-radio-input]')) {
    const input = document.getElementById(group.getAttribute('data-radio-input'));
    const radios = $$('[role="radio"]', group);
    const select = (radio, focus) => {
      for (const r of radios) {
        const on = r === radio;
        r.setAttribute('aria-checked', on ? 'true' : 'false');
        r.tabIndex = on ? 0 : -1;
      }
      if (input) {
        input.value = radio.getAttribute('data-value');
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (focus) radio.focus();
    };
    group.addEventListener('click', (e) => {
      const radio = e.target.closest('[role="radio"]');
      if (radio) select(radio, false);
    });
    group.addEventListener('keydown', (e) => {
      const i = radios.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        select(radios[i], true);
        return;
      }
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        select(radios[(i + step + radios.length) % radios.length], true);
      }
    });
  }

  // ---------- switches ----------
  document.addEventListener('click', (e) => {
    const sw = e.target.closest('button[role="switch"]');
    if (!sw) return;
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    const input = document.getElementById(sw.getAttribute('data-switch-input'));
    if (input) input.value = on ? '1' : '0';
  });

  // ---------- clickable rows and list items ----------
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-href]');
    if (!row || e.defaultPrevented) return;
    if (e.target.closest('a, button, input, select, textarea, label')) return;
    if (String(window.getSelection?.() || '').length) return;
    window.location.href = row.getAttribute('data-href');
  });

  // ---------- filters that submit on change ----------
  for (const select of $$('select[data-autosubmit]')) {
    select.addEventListener('change', () => select.form?.requestSubmit());
  }

  // ---------- prevent double submits ----------
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
    if (form.dataset.submitting) {
      e.preventDefault();
      return;
    }
    form.dataset.submitting = '1';
  });

  // ---------- file drop zones: show the chosen file name ----------
  for (const zone of $$('[data-dropzone]')) {
    const input = $('input[type="file"]', zone);
    const name = $('[data-file-name]', zone);
    const placeholder = name.textContent;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      name.textContent = file ? file.name : placeholder;
      zone.classList.toggle('has-file', !!file);
    });
  }

  // ---------- live numbers: replace the text and replay a short tick ----------
  const setLive = (el, text) => {
    if (!el || el.textContent === text) return;
    el.textContent = text;
    el.classList.remove('is-ticking');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('is-ticking');
  };
  const fmtDays = (n) => `${Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, '')}일`;

  // ---------- leave form: live day count and remaining balance ----------
  const leaveForm = $('[data-leave-form]');
  if (leaveForm) {
    const holidays = new Set(JSON.parse(leaveForm.getAttribute('data-holidays') || '[]'));
    const available = Number(leaveForm.getAttribute('data-available')) || 0;
    const out = $('[data-leave-days]', leaveForm);
    const after = $('[data-leave-after]', leaveForm);
    const type = $('#leave-type');
    const start = $('#start-date');
    const end = $('#end-date');
    const parse = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
      if (!m) return null;
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
    };
    const iso = (d) => d.toISOString().slice(0, 10);
    const update = () => {
      const half = type.value === 'am_half' || type.value === 'pm_half';
      const a = parse(start.value);
      const b = parse(end.value) || (half ? a : null);
      let days = 0;
      if (a && b && b >= a) {
        if (half) days = a.getTime() === b.getTime() ? 0.5 : 0;
        else {
          for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
            const w = d.getUTCDay();
            if (w !== 0 && w !== 6 && !holidays.has(iso(d))) days++;
          }
        }
      }
      setLive(out, fmtDays(days));
      // Sick and family leave do not use the annual balance.
      const usesBalance = !type.value || type.value === 'annual' || half;
      const left = available - days;
      setLive(after, usesBalance ? fmtDays(left) : '차감 없음');
      after.classList.toggle('is-over', usesBalance && left < 0);
    };
    leaveForm.addEventListener('input', update);
    leaveForm.addEventListener('change', update);
  }

  // ---------- expense form: live month total ----------
  const expenseForm = $('[data-expense-form]');
  if (expenseForm) {
    const base = Number(expenseForm.getAttribute('data-month-total')) || 0;
    const amount = $('#amount', expenseForm);
    const won = (n) => `${n.toLocaleString('ko-KR')}원`;
    amount.addEventListener('input', () => {
      const digits = amount.value.replace(/[,\s원₩]/g, '');
      const n = /^\d+$/.test(digits) ? Number(digits) : 0;
      setLive($('[data-expense-amount]', expenseForm), won(n));
      setLive($('[data-expense-after]', expenseForm), won(base + n));
    });
  }

  // ---------- members: resend a pending invitation ----------
  // A plain fetch (never a form submit). The result is written next to the button.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-resend-invite]');
    if (!btn || btn.disabled) return;
    const note = document.getElementById(btn.getAttribute('data-resend-note'));
    btn.disabled = true;
    let ok = false;
    try {
      const res = await fetch(btn.getAttribute('data-resend-invite'), { method: 'POST', headers: { Accept: 'application/json' } });
      ok = res.ok && (await res.json()).ok === true;
    } catch {
      ok = false;
    }
    btn.disabled = false;
    if (!note) return;
    note.textContent = ok ? '초대 메일을 다시 보냈어요' : '보내지 못했어요. 잠시 후 다시 시도해 주세요.';
    note.classList.toggle('is-error', !ok);
    note.classList.remove('is-fresh');
    void note.offsetWidth;
    note.classList.add('is-fresh');
  });
})();
