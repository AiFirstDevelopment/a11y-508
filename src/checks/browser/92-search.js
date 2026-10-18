// Search-form discovery: forms (and role="search" regions, and groups of fields with a button) that
// look like searches or filters, filled with a date range and submitted, so results that only
// appear for a query (a search screen) can be audited and followed. Nothing named like an action
// with side effects is ever submitted.
(() => {
  const A = window.__a11y508;
  const SEARCH = /\b(search(es|ing)?|filter(s|ed)?|apply( filters?)?|go|find|refresh|show results|view results|look ?up|query|retrieve|get results)\b/i;
  const DANGER = /\b(save|create|delete|remove|destroy|erase|purge|send|pay|purchase|buy|order|checkout|post|publish|update|upload|import|export|download|sign ?(in|up|out|on)|log ?(in|on|out|off)|register|subscribe|unsubscribe|reset|clear|cancel|approve|reject|transfer|confirm|archive|submit (order|payment|request|application)|add|new|edit|close|accept|decline)\b/i;
  const CONTROL = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';
  // A control that opens, closes or folds the search's panel is named with its words too ("Collapse
  // search panel", "Advanced search", "Show filters"): never the control that runs the search.
  const TOGGLEY = /\b(collapse|expand|toggle|minimi[sz]e|maximi[sz]e|panel|drawer|sidebar|advanced)\b|\b(show|hide|open|close)\s+(the\s+)?(search|filter|filters|options|criteria)\b/i;
  // Among the controls named like a search, the one that is the search: a submit, or one whose name
  // starts with the word (Search, Find, Apply filters), before one that only mentions it.
  const LEADS = /^(search|find|go|apply|filter|query|look ?up|refresh|retrieve|show results|view results|get results)\b/i;
  const searchRank = (x) => (x.c.matches('input[type="submit"], button[type="submit"]') || LEADS.test(x.name) ? 0 : 1);
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
  const candidateScopes = () => {
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
    return scopes;
  };
  A.searchForms = (max) => {
    const scopes = candidateScopes();
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
      // Every visible control, a disabled one too: a Search button that is disabled until the form is
      // valid is still the search's control; it is pressed once the fill has enabled it.
      const disabledOf = (c) => !!c.disabled || c.getAttribute('aria-disabled') === 'true';
      const controls = [...scope.querySelectorAll(CONTROL)].filter((c) => A.isVisible(c));
      const named = controls.map((c) => ({ c, name: nameOf(c), acc: (A.accName(c).name || '').trim().replace(/\s+/g, ' ').slice(0, 80), disabled: disabledOf(c) }));
      // The search is submitted by its own control, one named like a search; the other controls in
      // the scope (Clear, Reset, Export, Save...) are never pressed, so they do not make the scope an
      // action. Only a scope whose one way to submit is such a control, or Enter with one as the
      // form's default, is left alone (and reported).
      const isDanger = (x) => DANGER.test(x.name) || /^submit$/i.test(x.name);
      const danger = named.find((x) => !x.disabled && isDanger(x));
      const searchers = named.filter((x) => SEARCH.test(x.name) && !DANGER.test(x.name) && !TOGGLEY.test(x.name)).sort((a, b) => searchRank(a) - searchRank(b));
      const go = searchers.find((x) => !x.disabled) || searchers[0] || null;
      // A search box with no button submits with Enter.
      const searchBox = fields.find((f) => f.type === 'search') || (scope.matches('[role="search"]') ? fields[0] : null);
      if (!go) {
        // A scope that looks like a search (date fields, a date preset, a search label) whose buttons are
        // not named like one (an icon with no name, beside an Export): said, with the buttons it has, so
        // a Search button with no name is not a mystery. A scope whose only control is an action is one.
        const searchLike = widgets.length > 0 || !!scope.querySelector(TOGGLE) || fields.some((f) => f.type === 'date' || DATEY.test(hintOf(f)) || DATEFMT.test(f.getAttribute('placeholder') || '')) || /search|filter/i.test(`${scope.getAttribute('aria-label') || ''} ${scope.id || ''} ${typeof scope.className === 'string' ? scope.className : ''}`);
        const other = named.some((x) => !isDanger(x));
        if (searchLike && other && !searchBox) {
          skipped.push({ selector: A.selector(scope), name: named.map((x) => x.acc || '(no name)').slice(0, 4).join(', ') || 'none', reason: 'no control named like a search' });
          continue;
        }
        if (danger) {
          skipped.push({ selector: A.selector(scope), name: danger.name, reason: 'looks like an action' });
          continue;
        }
        if (!searchBox) {
          if (searchLike) skipped.push({ selector: A.selector(scope), name: named.map((x) => x.acc || '(no name)').slice(0, 4).join(', ') || 'none', reason: 'no control named like a search' });
          continue;
        }
      }
      used.add(scope);
      out.push({ selector: A.selector(scope), submit: go ? A.selector(go.c) : null, submitDisabled: !!(go && go.disabled), name: go ? go.name : 'Enter', fields: fields.length, method: (scope.getAttribute('method') || 'get').toLowerCase(), danger: !!danger });
    }
    return { forms: out, skipped };
  };

  // Whether a control can be pressed now (a Search button the fill has enabled).
  A.isEnabled = (sel) => {
    const el = A.query(sel);
    return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
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
          out.via = { kind: 'select', selector: A.selector(s) };
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
          out.via = { kind: 'radio', selector: A.selector(c.item.r) };
        }
      }
      if (!out.preset) {
        const btns = [...scope.querySelectorAll(PRESETBTN)].filter((b) => A.isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
        const c = choosePreset(btns.map((b) => ({ b, text: nameOf(b) })), months);
        if (c) {
          if (c.item.b.getAttribute('aria-checked') !== 'true' && c.item.b.getAttribute('aria-pressed') !== 'true') c.item.b.click();
          take(c, c.item.text);
          out.via = { kind: 'button', selector: A.selector(c.item.b) };
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
        out.fromSel = A.selector(fromEl);
      }
      if (toEl) {
        setValue(toEl, formatFor(toEl, today));
        out.dates++;
        out.to = toEl.value;
        out.toSel = A.selector(toEl);
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

  // The date range kept at the last N months on every load (src/passes.mjs applyRanges and
  // guardRange): the search and filter scopes with a control named like a search (or a search box)
  // that may hold a date range. Scopes with an action button too (Clear, Reset) are included, since
  // nothing is submitted; login and upload forms are not.
  A.rangeScopes = (max) => {
    const out = [];
    const used = new Set();
    for (const scope of candidateScopes()) {
      if (out.length >= max) break;
      if (used.has(scope) || [...used].some((u) => u.contains(scope) || scope.contains(u))) continue;
      if (!A.isVisible(scope) || inDialog(scope)) continue;
      const fields = [...scope.querySelectorAll(FIELD)].filter((f) => A.isVisible(f) && !f.disabled);
      if (fields.some((f) => f.type === 'password' || f.type === 'file')) continue;
      const controls = [...scope.querySelectorAll(CONTROL)].filter((c) => A.isVisible(c) && !c.disabled);
      const go = controls.some((c) => SEARCH.test(nameOf(c)) && !DANGER.test(nameOf(c)));
      const box = fields.some((f) => f.type === 'search') || scope.matches('[role="search"]');
      if (!go && !box) continue;
      const ranged = fields.some((f) => f.localName === 'select' || f.type === 'radio' || (f.localName === 'input' && isDate(f))) || [...scope.querySelectorAll(WIDGET)].some((w) => A.isVisible(w));
      if (!ranged) continue;
      used.add(scope);
      out.push({ selector: A.selector(scope) });
    }
    return out;
  };
  // What was set in a scope on this load, and how to tell whether the app has changed it since.
  A.rangeRecord = (sel, rec) => {
    A._ranges = A._ranges || {};
    A._ranges[sel] = rec;
    return true;
  };
  const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
  A.rangeIntact = (sel) => {
    const rec = A._ranges && A._ranges[sel];
    if (!rec || !rec.via) return true;
    const v = rec.via;
    const q = (s) => {
      try {
        return s ? A.query(s) : null;
      } catch {
        return null;
      }
    };
    if (v.kind === 'dates') {
      const f = q(v.from);
      const t = q(v.to);
      return (!f || f.value === rec.from) && (!t || t.value === rec.to);
    }
    const el = q(v.selector);
    if (!el) return true;
    if (v.kind === 'select') return norm(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : '').slice(0, 80) === rec.preset;
    if (v.kind === 'radio') return el.checked;
    if (v.kind === 'button') return el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') ? el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' : true;
    // A custom dropdown shows its choice as its text (mat-select) or its input's value (React Select).
    const shown = norm(`${A.text(el)} ${el.value || ''} ${[...el.querySelectorAll('input')].map((i) => i.value).join(' ')}`);
    return shown.includes(rec.preset);
  };
  // The recorded scope a pass is about to submit by activating `sel` (or, with `enter`, by pressing
  // Enter on the focused element): a submit button, a control named like a search, or Enter on one
  // of the scope's fields. null when the activation submits no recorded scope.
  const SUBMITLIKE = /\b(search|filter|apply|go|find|run|show results)\b/i;
  A.rangeTarget = (sel, enter) => {
    if (!A._ranges) return null;
    let el;
    try {
      el = sel ? A.query(sel) : A.activeElement();
    } catch {
      return null;
    }
    if (!el) return null;
    const submits =
      el.matches('input[type="submit"], input[type="image"], button[type="submit"]') ||
      (el.localName === 'button' && !el.hasAttribute('type') && !!el.form) ||
      (enter && el.matches(FIELD) && !el.matches('select, textarea')) ||
      (el.matches('button, [role="button"], input[type="button"], a[href^="javascript:" i], a[href="#"]') && SUBMITLIKE.test(nameOf(el)));
    if (!submits) return null;
    for (const s of Object.keys(A._ranges)) {
      let scope = null;
      try {
        scope = A.query(s);
      } catch {}
      if (scope && scope.contains(el)) return s;
    }
    return null;
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

  // Panels left open (a dropdown's listbox, a menu, an overlay's backdrop): a click meant for a control
  // beneath lands on them, and a zoomed page measures them. Escape closes them (closePanels in passes.mjs).
  const PANELS = '[role="listbox"], [role="menu"], .cdk-overlay-backdrop, .mat-mdc-select-panel, .mat-select-panel, .mat-mdc-menu-panel, .mat-menu-panel, .p-dropdown-panel, .p-overlaypanel';
  A.openPanels = () => A.all(PANELS).filter((e) => A.isVisible(e) && !e.closest('[role="dialog"], dialog')).length;

  // Elements present before a search, so what it reveals can be told apart.
  A.markBeforeSearch = () => {
    A._preSearch = new WeakSet(A.all('*'));
    return true;
  };
  // Settled: no new elements and no new resource loads for a while.
  A.searchSignature = () => `${document.getElementsByTagName('*').length}|${performance.getEntriesByType('resource').length}|${location.href}`;
  // The page as the results wait reads it: its signature, and whether something says it is busy (a
  // spinner, a progress bar, an aria-busy region), which results replace when they arrive.
  const BUSY = '[aria-busy="true"], [role="progressbar"], progress:not([value]), mat-spinner, mat-progress-spinner, mat-progress-bar, .mat-mdc-progress-spinner, .mat-mdc-progress-bar, .spinner, .loading, .loader';
  A.searchState = () => ({ sig: A.searchSignature(), busy: A.all(BUSY).some((el) => A.isVisible(el)) });

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
    // What a person can click inside a row: a link with no address (a router link handled on click),
    // role="link", something focusable, or anything shown with a pointer cursor.
    const CLICKABLE = 'a:not([href]), [role="link"], [tabindex]:not([tabindex="-1"]), [onclick]';
    const clickableIn = (row) => {
      for (const el of row.querySelectorAll('*')) {
        if (el.closest('th, [role="columnheader"]') || el.matches('input, select, textarea, button[type="submit"]')) continue;
        if (!A.isVisible(el) || !(A.text(el) || '').trim()) continue;
        if (el.matches(CLICKABLE)) return el;
        const c = A.cs(el);
        if (c && c.cursor === 'pointer' && !(el.parentElement && A.cs(el.parentElement) && A.cs(el.parentElement).cursor === 'pointer' && el.parentElement !== row)) return el;
      }
      return null;
    };
    for (const el of fresh) {
      if (el.matches('tr, [role="row"], li, mat-row, .mat-mdc-row, .mat-row')) {
        if (el.querySelector('a[href]')) continue; // its link is followed as a link
        if (el.querySelector('th, [role="columnheader"]')) continue; // a header row
        if (A.cs(el) && A.cs(el).cursor === 'pointer') consider(el, 'result row');
        else consider(clickableIn(el), 'result cell');
      } else if (el.matches('button, [role="button"], a[href^="javascript:" i], a[href="#"]')) {
        const n = nameOf(el);
        if (/\b(view|details?|open|show|more)\b|^[›»>→]$|chevron/i.test(n) || /chevron|arrow/i.test(el.className || '')) consider(el, 'result control');
      }
    }
    // Results the page already showed (an app that searches as it loads, and re-renders the same rows
    // when Search is pressed again): nothing new appeared, so the rows on the page are the results.
    if (!cands.length && !links.size) {
      for (const el of A.all('tr, [role="row"], mat-row, .mat-mdc-row, .mat-row')) {
        if (!A.isVisible(el) || inDialog(el) || el.querySelector('th, [role="columnheader"]')) continue;
        if (!el.closest('table, [role="grid"], [role="table"], [role="treegrid"], mat-table, .mat-mdc-table')) continue;
        const a = el.querySelector('a[href]');
        if (a && !/^(javascript:|#$)/i.test(a.getAttribute('href') || '')) links.add(a.href);
        else if (A.cs(el) && A.cs(el).cursor === 'pointer') consider(el, 'result row');
        else consider(clickableIn(el), 'result cell');
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
