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
        if (p.querySelectorAll(FIELD).length >= 1 && p !== document.body) {
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
      if (!fields.length || fields.some((f) => f.type === 'password' || f.type === 'file')) continue;
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
    const m = /\b(yyyy|mm?|dd?)([-/.])(yyyy|mm?|dd?)\2(yyyy|mm?|dd?)\b/i.exec(hint);
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
  // "Last 6 months", "Past year": the number of months a preset covers.
  const presetMonths = (text) => {
    const t = text.toLowerCase();
    let m = /(?:last|past|previous)\s+(\d+)\s+(month|year|week|day)s?/.exec(t);
    if (m) return { month: 1, year: 12, week: 0.25, day: 1 / 30 }[m[2]] * Number(m[1]);
    m = /(?:last|past|previous)\s+(month|year|quarter|week)\b/.exec(t);
    if (m) return { month: 1, year: 12, quarter: 3, week: 0.25 }[m[1]];
    if (/\b(all time|any time|all dates)\b/.test(t)) return 1200;
    return 0;
  };

  // Fills one scope: a date-range preset at least `months` wide if there is one, else the date
  // fields (from = today minus `months`, to = today); required fields get a value; a free-text
  // search stays empty. Returns what it did.
  A.fillSearch = (sel, months) => {
    const scope = A.query(sel);
    if (!scope) return null;
    const out = { dates: 0, preset: null, required: 0 };
    const fields = [...scope.querySelectorAll(FIELD)].filter((f) => A.isVisible(f) && !f.disabled && !f.readOnly);
    // A preset: an option of a select, or a radio's label.
    for (const s of fields.filter((f) => f.localName === 'select')) {
      const best = [...s.options].map((o) => ({ o, m: presetMonths(o.text) })).filter((x) => x.m >= months).sort((a, b) => a.m - b.m)[0];
      if (best) {
        setValue(s, best.o.value);
        out.preset = best.o.text.trim();
      }
    }
    if (!out.preset) {
      for (const r of fields.filter((f) => f.type === 'radio')) {
        if (presetMonths(hintOf(r)) >= months) {
          r.click();
          out.preset = hintOf(r).trim();
          break;
        }
      }
    }
    const today = new Date();
    const from = new Date(today);
    from.setMonth(from.getMonth() - months);
    const isDate = (f) => ['date', 'datetime-local'].includes(f.type) || (['text', ''].includes(f.type || '') && DATEY.test(hintOf(f)) && /date|from|\bto\b|start|end|since|until|mm|dd|yyyy/i.test(hintOf(f)));
    const dates = fields.filter((f) => f.localName === 'input' && isDate(f));
    if (!out.preset && dates.length) {
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
    return out;
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
