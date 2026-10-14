// Search-form discovery: forms (and role="search" regions, and groups of fields with a button) that
// look like searches or filters, filled with a date range and submitted, so results that only
// appear for a query (a search screen) can be audited and followed. Nothing named like an action
// with side effects is ever submitted.
(() => {
  const A = window.__a11y508;
  const SEARCH = /\b(search(es|ing)?|filter(s|ed)?|apply( filters?)?|go|find|refresh|show results|view results|look ?up|query|retrieve|get results)\b/i;
  const DANGER = /\b(save|create|delete|remove|destroy|erase|purge|send|pay|purchase|buy|order|checkout|post|publish|update|upload|import|export|download|sign ?(in|up|out|on)|log ?(in|on|out|off)|register|subscribe|unsubscribe|reset|clear|cancel|approve|reject|transfer|confirm|archive|submit (order|payment|request|application)|add|new|edit|close|accept|decline)\b/i;
  const CONTROL = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';
  const FIELD = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), select, textarea';
  const FROM = /\b(from|start|begin|since|after|min)\b|from|start/i;
  const TO = /\b(to|end|until|through|thru|before|max)\b|end|until/i;
  const DATEY = /date|from|\bto\b|start|end|period|range|since|until/i;
  // Custom dropdowns (mat-select, React Select, PrimeNG, Kendo) and preset buttons: date controls that
  // are not form fields.
  const COMBO = '[role="combobox"], [role="listbox"], button[aria-haspopup="listbox"]';
  const PRESETBTN = '[role="radio"], [role="radiogroup"] button, button[aria-pressed]';
  const WIDGET = `${COMBO}, ${PRESETBTN}`;
  const DATEFMT = /\b(yyyy|mm?|dd?)([-/.])(yyyy|mm?|dd?)\2(yyyy|mm?|dd?)\b/i;
  const TOGGLE = 'mat-datepicker-toggle, [class*="datepicker-toggle" i], button[aria-label*="open calendar" i], button[aria-label*="choose date" i], button[aria-label*="choose a date" i], button[aria-label*="date picker" i], button[aria-label*="datepicker" i]';

  const nameOf = (el) => (A.accName(el).name || el.value || A.text(el) || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const hintOf = (el) => {
    const labels = el.labels ? [...el.labels].map((l) => A.text(l)).join(' ') : '';
    return [labels, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name, el.id, A.accName(el).name].filter(Boolean).join(' ');
  };
  const inDialog = (el) => !!el.closest('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]');

  // The scopes worth searching: forms, role="search" regions, and containers of two or more
  // fields with a button that are not in a form. Each with the control that submits it.
  A.searchForms = (max) => {
    const scopes = new Set(A.all('form, [role="search"]'));
    for (const c of A.all(CONTROL)) {
      if (c.closest('form, [role="search"]')) continue;
      let p = c.parentElement;
      for (let i = 0; p && i < 4; i++, p = p.parentElement) {
        if (p.querySelectorAll(`${FIELD}, ${WIDGET}`).length >= 1 && p !== document.body) {
          scopes.add(p);
          break;
        }
      }
    }
    const out = [];
    const skipped = [];
    const used = new Set();
    for (const scope of scopes) {
      if (out.length >= max) break;
      if (used.has(scope) || [...used].some((u) => u.contains(scope) || scope.contains(u))) continue;
      if (!A.isVisible(scope) || inDialog(scope)) continue;
      const fields = [...scope.querySelectorAll(FIELD)].filter((f) => A.isVisible(f) && !f.disabled);
      const widgets = [...scope.querySelectorAll(WIDGET)].filter((w) => A.isVisible(w));
      if ((!fields.length && !widgets.length) || fields.some((f) => f.type === 'password' || f.type === 'file')) continue;
      const controls = [...scope.querySelectorAll(CONTROL)].filter((c) => A.isVisible(c) && !c.disabled && c.getAttribute('aria-disabled') !== 'true');
      const named = controls.map((c) => ({ c, name: nameOf(c) }));
      // A scope with any control named like an action is not a search, whatever else it has.
      const danger = named.find((x) => DANGER.test(x.name) || /^submit$/i.test(x.name));
      const go = named.find((x) => SEARCH.test(x.name) && !DANGER.test(x.name));
      if (danger && !go) {
        skipped.push({ selector: A.selector(scope), name: danger.name, reason: 'looks like an action' });
        continue;
      }
      if (danger && go && DANGER.test(go.name)) continue;
      // A search box with no button submits with Enter.
      const searchBox = fields.find((f) => f.type === 'search') || (scope.matches('[role="search"]') ? fields[0] : null);
      if (!go && !searchBox) continue;
      if (danger) {
        skipped.push({ selector: A.selector(scope), name: danger.name, reason: 'looks like an action' });
        continue;
      }
      used.add(scope);
      out.push({ selector: A.selector(scope), submit: go ? A.selector(go.c) : null, name: go ? go.name : 'Enter', fields: fields.length, method: (scope.getAttribute('method') || 'get').toLowerCase() });
    }
    return { forms: out, skipped };
  };

  const pad = (n) => String(n).padStart(2, '0');
  // A date in the format a field expects: ISO for type="date", else the placeholder's pattern.
  const formatFor = (el, d) => {
    if (el.type === 'date') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (el.type === 'datetime-local') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
    const hint = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-format') || ''} ${el.labels ? [...el.labels].map((l) => A.text(l)).join(' ') : ''}`;
    const m = DATEFMT.exec(hint);
    const parts = m ? [m[1], m[3], m[4]] : ['mm', 'dd', 'yyyy'];
    const sep = m ? m[2] : '/';
    return parts
      .map((p) => {
        const k = p.toLowerCase();
        if (k === 'yyyy') return String(d.getFullYear());
        if (k.startsWith('m')) return k.length === 2 ? pad(d.getMonth() + 1) : String(d.getMonth() + 1);
        return k.length === 2 ? pad(d.getDate()) : String(d.getDate());
      })
      .join(sep);
  };
  // The value set the way a person's typing sets it, so Angular and React see it.
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
  };
  // "Last 6 months", "Past year", "90 days", "YTD": the number of days a preset covers (0: not a
  // preset). "All" / "All time" is ALL.
  const ALL = 36500;
  const UNIT = { day: 1, week: 7, month: 30, quarter: 90, year: 365 };
  const presetDays = (text) => {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let m = /\b(?:last|past|previous|prior)\s+(\d+)\s*(day|week|month|quarter|year)s?\b/.exec(t) || /^(\d+)\s*(day|week|month|quarter|year)s?$/.exec(t);
    if (m) return UNIT[m[2]] * Number(m[1]);
    m = /\b(?:last|past|previous|prior)\s+(day|week|month|quarter|year)\b/.exec(t);
    if (m) return UNIT[m[1]];
    if (/\b(ytd|year[ -]to[ -]date|this year)\b/.test(t)) {
      const now = new Date();
      return Math.max(1, Math.round((now - new Date(now.getFullYear(), 0, 1)) / 86400000));
    }
    if (/^all$/.test(t) || /\b(all time|any time|anytime|all dates)\b/.test(t)) return ALL;
    return 0;
  };
  const presetMonths = (text) => presetDays(text) / 30;
  A.presetMonths = presetMonths;
  // Of a list of choices ({ text }), the narrowest preset covering `months`, else (with `widest`) the
  // widest there is (short: true). A list whose only preset is "All" is not a list of date ranges (a
  // status filter). A native select or radio left short keeps its default (often "All") and the
  // date fields get the full range instead, so only custom dropdowns and button groups take `widest`.
  const choosePreset = (items, months, widest = true) => {
    const scored = items.map((x) => ({ ...x, days: presetDays(x.text) })).filter((x) => x.days > 0);
    if (!scored.some((x) => x.days < ALL)) return null;
    const enough = scored.filter((x) => x.days >= months * 30).sort((a, b) => a.days - b.days)[0];
    if (enough) return { item: enough, days: enough.days, short: false };
    if (!widest) return null;
    const wide = scored.sort((a, b) => b.days - a.days)[0];
    return { item: wide, days: wide.days, short: true };
  };
  // A datepicker toggle (Angular Material's, or a button labelled "calendar") beside a text field:
  // in the field's nearest container that holds one, with at most a from/to pair of fields.
  const toggleBeside = (f) => {
    let p = f.parentElement;
    for (let i = 0; p && i < 3; i++, p = p.parentElement) {
      if (!p.querySelector(TOGGLE)) continue;
      return p.querySelectorAll(FIELD).length <= 2;
    }
    return false;
  };
  const isDate = (f) =>
    ['date', 'datetime-local'].includes(f.type) ||
    (['text', ''].includes(f.type || '') &&
      (DATEFMT.test(hintOf(f)) ||
        f.classList.contains('mat-datepicker-input') ||
        (DATEY.test(hintOf(f)) && /date|from|\bto\b|start|end|since|until|mm|dd|yyyy/i.test(hintOf(f))) ||
        toggleBeside(f)));

  // Fills one scope: a date-range preset at least `months` wide if there is one (else the widest),
  // else the date fields (from = today minus `months`, to = today); required fields get a value; a
  // free-text search stays empty. `steps` picks what to do: the crawler chooses presets first, then
  // tries the custom dropdowns it is handed back (`combos`) from outside the page, then the dates.
  A.fillSearch = (sel, months, steps = {}) => {
    const { presets = true, dates: doDates = true, required = true } = steps;
    const scope = A.query(sel);
    if (!scope) return null;
    const out = { dates: 0, preset: null, presetDays: null, short: false, required: 0, combos: [] };
    const fields = [...scope.querySelectorAll(FIELD)].filter((f) => A.isVisible(f) && !f.disabled && !f.readOnly);
    const take = (c, text) => {
      out.preset = String(text).trim().replace(/\s+/g, ' ').slice(0, 80);
      out.presetDays = c.days;
      out.short = c.short;
    };
    if (presets) {
      // A preset: an option of a select, a radio's label, or a button of a group ("Last 90 days").
      for (const s of fields.filter((f) => f.localName === 'select')) {
        const c = choosePreset([...s.options].map((o) => ({ o, text: o.text })), months, false);
        if (c) {
          setValue(s, c.item.o.value);
          take(c, c.item.o.text);
          break;
        }
      }
      if (!out.preset) {
        // A radio's own label (or accessible name), so a bare "All" reads as one.
        const text = (r) => (r.labels && r.labels.length ? [...r.labels].map((l) => A.text(l)).join(' ') : A.accName(r).name || hintOf(r));
        const c = choosePreset(fields.filter((f) => f.type === 'radio').map((r) => ({ r, text: text(r) })), months, false);
        if (c) {
          c.item.r.click();
          take(c, c.item.text);
        }
      }
      if (!out.preset) {
        const btns = [...scope.querySelectorAll(PRESETBTN)].filter((b) => A.isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
        const c = choosePreset(btns.map((b) => ({ b, text: nameOf(b) })), months);
        if (c) {
          if (c.item.b.getAttribute('aria-checked') !== 'true' && c.item.b.getAttribute('aria-pressed') !== 'true') c.item.b.click();
          take(c, c.item.text);
        }
      }
      // Custom dropdowns, for the crawler to open: outermost ones only (not an input inside a combobox).
      if (!out.preset) {
        const combos = [...scope.querySelectorAll(COMBO)].filter((c) => A.isVisible(c) && !c.disabled && c.getAttribute('aria-disabled') !== 'true');
        out.combos = combos.filter((c) => !combos.some((o) => o !== c && o.contains(c))).slice(0, 4).map((c) => A.selector(c));
      }
    }
    const today = new Date();
    const from = new Date(today);
    from.setMonth(from.getMonth() - months);
    const dates = fields.filter((f) => f.localName === 'input' && isDate(f));
    if (doDates && !out.preset && dates.length) {
      let fromEl = dates.find((f) => FROM.test(hintOf(f)) && !TO.test(hintOf(f).replace(/date/i, ''))) || null;
      let toEl = dates.find((f) => f !== fromEl && TO.test(hintOf(f))) || null;
      // A pair with no telling labels: the first is the start, the second the end.
      if (!fromEl && !toEl && dates.length >= 2) [fromEl, toEl] = dates;
      if (!fromEl && dates.length === 1 && !toEl) fromEl = dates[0];
      if (fromEl) {
        setValue(fromEl, formatFor(fromEl, from));
        out.dates++;
        out.from = fromEl.value;
      }
      if (toEl) {
        setValue(toEl, formatFor(toEl, today));
        out.dates++;
        out.to = toEl.value;
      }
    }
    if (required) {
      for (const f of fields) {
        if (dates.includes(f) || !(f.required || f.getAttribute('aria-required') === 'true')) continue;
        if (f.localName === 'select') {
          const o = [...f.options].find((x) => x.value);
          if (o && !f.value) setValue(f, o.value);
        } else if (f.type === 'checkbox' || f.type === 'radio') {
          if (!f.checked) f.click();
        } else if (!f.value) {
          setValue(f, ' ');
          if (f.checkValidity && !f.checkValidity()) setValue(f, 'a');
        }
        out.required++;
      }
    }
    return out;
  };

  // A custom dropdown, driven from outside the page (real clicks and keys, so the framework sees a
  // person): comboMark before opening it, comboOptions to read what it shows and choose, comboIsOpen
  // to know whether it still needs closing.
  const LISTY = '[role="listbox"], [role="option"]';
  A.comboMark = () => {
    A._comboPre = new WeakSet(A.all(LISTY).filter((e) => A.isVisible(e)));
    return true;
  };
  const optionsIn = (root) => [...root.querySelectorAll('[role="option"]')].filter((o) => A.isVisible(o));
  A.comboOptions = (sel, months) => {
    const el = A.query(sel);
    if (!el) return { options: [], choice: null };
    const pre = A._comboPre || new WeakSet();
    let opts = [];
    // An inline listbox shows its options already; a combobox names its popup with aria-controls/owns.
    if (el.matches('[role="listbox"]')) opts = optionsIn(el);
    if (!opts.length) {
      const refs = [el, ...el.querySelectorAll('[aria-controls], [aria-owns]')].flatMap((e) => `${e.getAttribute('aria-controls') || ''} ${e.getAttribute('aria-owns') || ''}`.split(/\s+/)).filter(Boolean);
      for (const id of refs) {
        const lb = A.rootOf(el).getElementById ? A.rootOf(el).getElementById(id) : document.getElementById(id);
        if (lb) opts.push(...(lb.matches('[role="option"]') ? [lb] : optionsIn(lb)));
      }
    }
    // Else whatever options appeared since it was opened, wherever the overlay renders them.
    if (!opts.length) opts = A.all('[role="option"]').filter((o) => A.isVisible(o) && !pre.has(o));
    const items = opts.map((o) => ({ selector: A.selector(o), text: (A.text(o) || A.accName(o).name || '').trim().replace(/\s+/g, ' ').slice(0, 80) }));
    const c = choosePreset(items, months);
    return { options: items.map((i) => i.text), choice: c ? { selector: c.item.selector, text: c.item.text, days: c.days, short: c.short } : null };
  };
  // Whether an option took: it is gone (the popup closed) or marked selected.
  A.optionTaken = (sel) => {
    let o;
    try {
      o = A.query(sel);
    } catch {
      return true;
    }
    return !o || !A.isVisible(o) || o.getAttribute('aria-selected') === 'true';
  };
  // For the Enter fallback: the option made the active one, focused when it can be.
  A.comboActivate = (comboSel, optSel) => {
    const el = A.query(comboSel);
    const o = A.query(optSel);
    if (!o) return false;
    o.scrollIntoView({ block: 'nearest' });
    if (el && o.id) el.setAttribute('aria-activedescendant', o.id);
    if (o.tabIndex >= 0 || o.hasAttribute('tabindex')) o.focus();
    else if (el) el.focus();
    return true;
  };
  A.comboFocus = (sel) => {
    const el = A.query(sel);
    if (el) el.focus();
    return !!el;
  };
  // Open: the dropdown says so, or a listbox or options are showing that were not before it opened.
  A.comboIsOpen = (sel) => {
    const el = A.query(sel);
    const pre = A._comboPre || new WeakSet();
    if (el && el.getAttribute('aria-expanded') === 'true') return true;
    return A.all(LISTY).some((e) => e !== el && A.isVisible(e) && !pre.has(e) && !(el && el.contains(e)));
  };

  // Elements present before a search, so what it reveals can be told apart.
  A.markBeforeSearch = () => {
    A._preSearch = new WeakSet(A.all('*'));
    return true;
  };
  // Settled: no new elements and no new resource loads for a while.
  A.searchSignature = () => `${document.getElementsByTagName('*').length}|${performance.getEntriesByType('resource').length}|${location.href}`;

  // What a search revealed: links in the new content, and the controls in it worth clicking (result
  // rows, "view"/"details" buttons, pagination), named like nothing with side effects.
  const NAVDANGER = /\b(delete|remove|destroy|erase|log ?out|sign ?out|save|send|pay|purchase|buy|order|approve|reject|cancel|archive|edit|create|add|new|download|export|print|close|dismiss)\b/i;
  const PAGER = /^(next|next page|more|load more|show more|older|›|»|>|→|\d{1,3})$/i;
  A.searchResults = (max) => {
    const pre = A._preSearch || new WeakSet();
    const fresh = A.all('*').filter((el) => !pre.has(el));
    const links = new Set();
    const cands = [];
    const seen = new Set();
    const consider = (el, why) => {
      if (!el || seen.has(el) || cands.length >= max * 3 || !A.isVisible(el) || inDialog(el)) return;
      seen.add(el);
      const name = (A.accName(el).name || A.text(el) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!name || NAVDANGER.test(name)) return;
      cands.push({ selector: A.selector(el), name, why });
    };
    for (const el of fresh) {
      if (el.matches('a[href]') && !/^(javascript:|#$)/i.test(el.getAttribute('href') || '')) links.add(el.href);
    }
    for (const el of fresh) {
      if (el.matches('tr, [role="row"], li')) {
        if (el.querySelector('a[href]')) continue; // its link is followed as a link
        if (A.cs(el) && A.cs(el).cursor === 'pointer') consider(el, 'result row');
      } else if (el.matches('button, [role="button"], a[href^="javascript:" i], a[href="#"]')) {
        const n = nameOf(el);
        if (/\b(view|details?|open|show|more)\b|^[›»>→]$|chevron/i.test(n) || /chevron|arrow/i.test(el.className || '')) consider(el, 'result control');
      }
    }
    // Pagination: in the new content or a pager anywhere.
    for (const el of A.all('a[href], button, [role="button"], [role="link"]')) {
      const n = nameOf(el);
      if (!PAGER.test(n) && el.getAttribute('rel') !== 'next') continue;
      if (!el.closest('[class*="pagin" i], nav[aria-label*="pag" i], [role="navigation"][aria-label*="pag" i], .pager, [class*="pager" i]') && el.getAttribute('rel') !== 'next' && !/next/i.test(n)) continue;
      if (el.matches('a[href]') && !/^(javascript:|#$)/i.test(el.getAttribute('href') || '')) links.add(el.href);
      else consider(el, 'pagination');
    }
    return { links: [...links], candidates: cands.slice(0, max), fresh: fresh.length };
  };
})();
