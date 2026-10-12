// Beyond Section 508: WCAG 2.1 / 2.2 success criteria and best practices. These run only with the
// --wcag 2.1 / 2.2 profile (--beyond-508); a default run never registers a finding from this file.
// Each finding's test is the WCAG criterion ('BP' for best practices) and carries beyond508: true.
// Written from the WCAG 2.1/2.2 Understanding documents, the HTML autofill grammar and ARIA in HTML;
// the rule set is informed by axe-core and IBM Equal Access, with no code taken from either.
// The passes that need the browser to re-lay out the page (text spacing, reflow at 320 px, focus
// not obscured) are in src/passes.mjs, with their in-page helpers at the end of this file.
(() => {
  const A = window.__a11y508;

  const words = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // The text a sighted user sees in el: text nodes that render and are not visually hidden.
  const visibleText = (el) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      const p = t.parentElement;
      if (!p || !t.nodeValue.trim()) continue;
      if (!A.isVisible(p) || A.isVisuallyHidden(p)) continue;
      parts.push(A.stripGlyphs(t.nodeValue));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  // The colour painted behind el: the backgrounds of its ancestors, composited until opaque, over a
  // white canvas. null when a background image is in the way (the colour cannot be known).
  const surroundingBg = (el) => {
    const layers = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = A.cs(n);
      if (!s) continue;
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = A.parseColor(s.backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 1) break;
    }
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) out = A.blend(layers[i], out);
    return out;
  };
  A.surroundingBg = surroundingBg;

  // ---- 2.5.3 Label in name ----
  // A control whose visible text is its label must have an accessible name that contains that text
  // (case, spacing and punctuation aside), so speech-input users can say what they see.
  const labelInName = () => {
    const sel = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], input, select, textarea';
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (n >= 30) break;
      if (!A.isVisible(el) || A.isVisuallyHidden(el) || A.isHiddenFromAT(el)) continue;
      const { name, source } = A.accName(el);
      if (source !== 'aria-label' && source !== 'aria-labelledby') continue;
      let shown = '';
      const tag = el.localName;
      if (tag === 'input' && /^(submit|reset|button)$/i.test(el.type)) shown = el.value || '';
      else if (tag === 'input' || tag === 'select' || tag === 'textarea') shown = Array.from(el.labels || []).map(visibleText).join(' ');
      else shown = visibleText(el);
      const v = words(shown);
      // A single character or a symbol is not label text (WCAG's Understanding 2.5.3).
      if (!v || v.replace(/\s/g, '').length < 2) continue;
      if ((' ' + words(name) + ' ').includes(' ' + v + ' ')) continue;
      n++;
      A.add({ test: '2.5.3', impact: 'serious', el, message: `The visible label "${shown.trim().slice(0, 80)}" is not part of the accessible name "${name.slice(0, 120)}" (from ${source}). Speech-input users say what they see; put the visible text in the name, ideally at its start.`, details: { visible: shown.trim().slice(0, 120), name: name.slice(0, 200), source } });
    }
  };

  // ---- 1.3.5 Identify input purpose ----
  // The autofill grammar of the HTML standard (4.10.18.7.1): "on" or "off" alone; otherwise an
  // optional "section-*" token, an optional "shipping" or "billing", then either a field name or
  // an optional contact type followed by a contact field name, and an optional final "webauthn".
  const FIELDS = new Set(('name honorific-prefix given-name additional-name family-name honorific-suffix nickname ' +
    'username new-password current-password one-time-code organization-title organization street-address ' +
    'address-line1 address-line2 address-line3 address-level4 address-level3 address-level2 address-level1 ' +
    'country country-name postal-code cc-name cc-given-name cc-additional-name cc-family-name cc-number cc-exp ' +
    'cc-exp-month cc-exp-year cc-csc cc-type transaction-currency transaction-amount language bday bday-day ' +
    'bday-month bday-year sex url photo').split(' '));
  const CONTACT_FIELDS = new Set('tel tel-country-code tel-national tel-area-code tel-local tel-local-prefix tel-local-suffix tel-extension email impp'.split(' '));
  const CONTACT_TYPES = new Set(['home', 'work', 'mobile', 'fax', 'pager']);
  // The control group of a field name (the standard's table), for the field names whose group is
  // not plain text.
  const GROUP = {
    'street-address': 'multiline', 'new-password': 'password', 'current-password': 'password', 'one-time-code': 'password',
    username: 'username', 'cc-exp': 'month', bday: 'date', 'cc-exp-month': 'numeric', 'cc-exp-year': 'numeric',
    'transaction-amount': 'numeric', 'bday-day': 'numeric', 'bday-month': 'numeric', 'bday-year': 'numeric',
    url: 'url', photo: 'url', impp: 'url', email: 'email',
    tel: 'tel', 'tel-country-code': 'tel', 'tel-national': 'tel', 'tel-area-code': 'tel', 'tel-local': 'tel',
    'tel-local-prefix': 'tel', 'tel-local-suffix': 'tel', 'tel-extension': 'tel',
  };
  // The control groups each typed input accepts. Text, search, hidden, textarea and select accept
  // every group; input types that take no autofill at all are listed with none.
  const ACCEPTS = {
    email: ['username', 'email'], tel: ['tel'], url: ['url'], password: ['password'], number: ['numeric'],
    month: ['month'], date: ['date'], week: [], time: [], 'datetime-local': [], range: ['numeric'], color: [],
    checkbox: [], radio: [], file: [], submit: [], reset: [], button: [], image: [],
  };
  // Returns null when the value is valid, else the reason.
  A.autofillProblem = (value, type) => {
    const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    if (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off')) return null;
    const t = [...tokens];
    if (t[t.length - 1] === 'webauthn') t.pop();
    if (t[0] && t[0].startsWith('section-') && t[0].length > 8) t.shift();
    if (t[0] === 'shipping' || t[0] === 'billing') t.shift();
    let field = null;
    if (t.length === 1 && FIELDS.has(t[0])) field = t[0];
    else if (t.length === 1 && CONTACT_FIELDS.has(t[0])) field = t[0];
    else if (t.length === 2 && CONTACT_TYPES.has(t[0]) && CONTACT_FIELDS.has(t[1])) field = t[1];
    if (!field) {
      const bad = tokens.find((x) => !FIELDS.has(x) && !CONTACT_FIELDS.has(x) && !CONTACT_TYPES.has(x) && x !== 'shipping' && x !== 'billing' && x !== 'webauthn' && !(x.startsWith('section-') && x.length > 8));
      return bad ? `"${bad}" is not an autofill token` : 'the tokens are not in the order the HTML autofill grammar requires ([section-*] [shipping|billing] [home|work|mobile|fax|pager] field)';
    }
    const accepts = ACCEPTS[type];
    if (accepts) {
      const group = GROUP[field] || 'text';
      if (!accepts.includes(group)) return `"${field}" cannot be used on <input type="${type}">${accepts.length ? '' : ', which takes no autofill field name'}`;
    }
    return null;
  };
  const inputPurpose = () => {
    let n = 0;
    for (const el of document.querySelectorAll('input[autocomplete], select[autocomplete], textarea[autocomplete]')) {
      if (n >= 30) break;
      const type = el.localName === 'input' ? (el.getAttribute('type') || 'text').trim().toLowerCase() : el.localName;
      if (type === 'hidden' || !A.isVisible(el) || el.disabled) continue;
      const value = el.getAttribute('autocomplete') || '';
      const problem = A.autofillProblem(value, type);
      if (!problem) continue;
      n++;
      A.add({ test: '1.3.5', impact: 'serious', el, message: `autocomplete="${value.slice(0, 80)}": ${problem}. Use a valid autofill field name for what the field collects (for example "email", "shipping postal-code", "section-billing tel"), so browsers and assistive technology can identify its purpose.` });
    }
  };

  // ---- 2.5.8 Target size (minimum) ----
  const TARGETS = 'a[href], button, input:not([type="hidden" i]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="slider"], [onclick]';
  // A browser control whose size the author left to the browser (WCAG's user agent exception):
  // form fields drawn by the browser, not buttons.
  const NATIVE = /^(checkbox|radio|range|color|file|date|time|datetime-local|month|week|text|search|email|tel|url|number|password)$/;
  const isNative = (el) => {
    if (el.localName === 'select' || el.localName === 'textarea') return (A.cs(el).appearance || 'auto') !== 'none';
    if (el.localName !== 'input') return false;
    return NATIVE.test((el.getAttribute('type') || 'text').toLowerCase()) && (A.cs(el).appearance || 'auto') !== 'none';
  };
  const blockOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const d = (A.cs(n) || {}).display || 'block';
      if (d !== 'inline' && d !== 'contents') return n;
    }
    return document.body;
  };
  // Inline in a sentence: an inline target whose block holds more text than the target itself.
  const isInline = (el) => (A.cs(el) || {}).display === 'inline' && A.text(blockOf(el)).length > A.text(el).length + 10;
  const SMALL = 24 - 0.5;
  const targetList = () => {
    const out = [];
    for (const el of document.querySelectorAll(TARGETS)) {
      if (out.length >= 1500) break;
      if (el.parentElement && el.parentElement.closest(TARGETS)) continue; // part of a larger target
      if (!A.isVisible(el) || A.isVisuallyHidden(el) || el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ el, r, small: r.width < SMALL || r.height < SMALL });
    }
    return out;
  };
  const distToRect = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  // The WCAG 2.2 spacing exception: a 24 px circle centred on the undersized target intersects no
  // other target and no other undersized target's circle. Returns the target it touches, or null.
  const crowdedBy = (t, all) => {
    const cx = t.r.left + t.r.width / 2;
    const cy = t.r.top + t.r.height / 2;
    for (const o of all) {
      if (o === t || o.el.contains(t.el) || t.el.contains(o.el)) continue;
      if (o.small) {
        if (Math.hypot(cx - (o.r.left + o.r.width / 2), cy - (o.r.top + o.r.height / 2)) < 24) return o;
      } else if (distToRect(cx, cy, o.r) < 12) return o;
    }
    return null;
  };
  const sameTarget = (a, b) => {
    if (a.localName === 'a' && b.localName === 'a' && a.href && a.href === b.href) return true;
    const na = A.accName(a).name.trim().toLowerCase();
    return !!na && na === A.accName(b).name.trim().toLowerCase();
  };
  // Reports the undersized targets among els (all of the page's targets when els is omitted).
  const targetSize = (els) => {
    const all = targetList();
    const pick = els ? els.map((el) => {
      const r = el.getBoundingClientRect();
      return all.find((t) => t.el === el) || { el, r, small: r.width < SMALL || r.height < SMALL };
    }) : all;
    let n = 0;
    for (const t of pick) {
      if (n >= 25) break;
      if (!t.small || isNative(t.el) || isInline(t.el)) continue;
      if (all.some((o) => o !== t && !o.small && sameTarget(t.el, o.el))) continue;
      const near = crowdedBy(t, all);
      if (!near) continue;
      n++;
      A.add({ test: '2.5.8', impact: 'serious', el: t.el, details: { width: Math.round(t.r.width), height: Math.round(t.r.height), near: A.selector(near.el) },
        message: `Target is ${Math.round(t.r.width)}x${Math.round(t.r.height)} px, under 24x24, and a 24 px circle centred on it reaches ${A.selector(near.el)}, so it is easy to hit the wrong one. Make it at least 24x24 CSS px, or space it from other targets.` });
    }
  };
  // Elements with a click listener (from the Node side's listener probe), which the selector above
  // cannot see.
  A.targetSizeFor = (selectors) => {
    A.findings = [];
    A.counts = {};
    A.truncated = {};
    const els = [];
    for (const s of selectors || []) {
      try {
        const el = document.querySelector(s);
        if (el && !el.matches(TARGETS) && !(el.parentElement && el.parentElement.closest(TARGETS)) && A.isVisible(el)) els.push(el);
      } catch {}
    }
    if (els.length) targetSize(els);
    return A.findings;
  };

  // ---- 1.4.12 Text spacing (author styles that block the user's overrides) ----
  const SPACING = { 'line-height': 1.5, 'letter-spacing': 0.12, 'word-spacing': 0.16 };
  const tooTight = (el, prop) => {
    const s = A.cs(el);
    const fs = parseFloat(s.fontSize) || 16;
    const v = s.getPropertyValue(prop);
    const px = v === 'normal' ? (prop === 'line-height' ? fs * 1.2 : 0) : parseFloat(v);
    return Number.isNaN(px) || px < SPACING[prop] * fs - 0.01;
  };
  const textSpacing = () => {
    let n = 0;
    for (const el of document.querySelectorAll('[style]')) {
      if (n >= 15) break;
      if (!A.isVisible(el) || !A.text(el)) continue;
      for (const prop of Object.keys(SPACING)) {
        if (el.style.getPropertyPriority(prop) !== 'important' || !tooTight(el, prop)) continue;
        n++;
        A.add({ test: '1.4.12', impact: 'serious', el, message: `Inline style "${prop}: ${el.style.getPropertyValue(prop)} !important" overrides a user's text-spacing setting (WCAG asks that ${prop} can be raised to ${SPACING[prop]} times the font size). Drop !important, or set it in a stylesheet.` });
        break;
      }
    }
    const rules = [];
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules && !(r instanceof CSSStyleRule)) walk(r.cssRules);
        else if (r instanceof CSSStyleRule) rules.push(r);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {} // cross-origin stylesheet
    }
    for (const rule of rules) {
      if (n >= 15) break;
      for (const prop of Object.keys(SPACING)) {
        if (rule.style.getPropertyPriority(prop) !== 'important') continue;
        let el = null;
        try {
          el = Array.from(document.querySelectorAll(rule.selectorText)).find((x) => A.isVisible(x) && A.text(x));
        } catch {}
        if (!el || !tooTight(el, prop)) continue;
        n++;
        A.add({ test: '1.4.12', impact: 'serious', el, message: `The rule "${rule.selectorText} { ${prop}: ${rule.style.getPropertyValue(prop)} !important }" holds ${prop} below ${SPACING[prop]} times the font size and outranks spacing a user applies with a bookmarklet or extension. Drop !important.` });
        break;
      }
    }
  };

  // ---- 1.3.4 Orientation (review) ----
  // A rule under an orientation media query that rotates content a quarter turn or hides it.
  const quarterTurn = (transform) => {
    const re = /rotate(?:z)?\(\s*(-?[\d.]+)(deg|rad|grad|turn)\s*\)/gi;
    let m;
    while ((m = re.exec(transform || ''))) {
      const v = parseFloat(m[1]);
      const deg = m[2] === 'rad' ? (v * 180) / Math.PI : m[2] === 'grad' ? v * 0.9 : m[2] === 'turn' ? v * 360 : v;
      const r = ((Math.abs(deg) % 180) + 180) % 180;
      if (Math.abs(r - 90) < 1) return true;
    }
    return false;
  };
  const orientation = () => {
    const found = [];
    const walk = (list, media) => {
      for (const r of list) {
        if (found.length >= 5) return;
        if (r instanceof CSSMediaRule) walk(r.cssRules, /orientation\s*:\s*(portrait|landscape)/i.test(r.media.mediaText) ? r.media.mediaText : media);
        else if (r.cssRules && !(r instanceof CSSStyleRule)) walk(r.cssRules, media);
        else if (media && r instanceof CSSStyleRule) {
          const st = r.style;
          const what = quarterTurn(st.getPropertyValue('transform')) || quarterTurn(st.getPropertyValue('rotate') ? `rotate(${st.getPropertyValue('rotate')})` : '')
            ? `rotates it a quarter turn (${(st.getPropertyValue('transform') || st.getPropertyValue('rotate')).trim()})`
            : st.getPropertyValue('display').trim() === 'none' ? 'hides it (display: none)'
            : st.getPropertyValue('visibility').trim() === 'hidden' ? 'hides it (visibility: hidden)' : '';
          if (what) found.push({ media, rule: r, what });
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules, null);
      } catch {}
    }
    for (const f of found) {
      A.add({ test: '1.3.4', level: 'review', impact: 'moderate', selector: f.rule.selectorText, html: f.rule.cssText.slice(0, 300),
        message: `Under @media ${f.media}, "${f.rule.selectorText}" ${f.what}, which can lock the content to one orientation. Confirm the page works in both portrait and landscape, unless one orientation is essential.` });
    }
  };

  // ---- 1.4.11 Non-text contrast (review): the boundary of fields, checkboxes and buttons ----
  const FIELD = 'input, textarea, select, button, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="combobox"]';
  const nonTextContrast = () => {
    let n = 0;
    for (const el of document.querySelectorAll(FIELD)) {
      if (n >= 20) break;
      const type = el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
      if (/^(hidden|image|range|color|file)$/.test(type)) continue;
      if (!A.isVisible(el) || A.isVisuallyHidden(el) || A.isHiddenFromAT(el) || el.disabled) continue;
      const s = A.cs(el);
      // Checkboxes and radios the browser draws are the browser's; only author-drawn ones are judged.
      if (/^(checkbox|radio)$/.test(type) && (s.appearance || 'auto') !== 'none') continue;
      const around = surroundingBg(el);
      if (!around) continue;
      const bw = parseFloat(s.borderTopWidth) || 0;
      const border = A.parseColor(s.borderTopColor);
      const bg = A.parseColor(s.backgroundColor);
      let part = null;
      let color = null;
      if (bw >= 1 && s.borderTopStyle !== 'none' && s.borderTopStyle !== 'hidden' && border.a > 0) {
        part = 'border';
        color = A.blend(border, around);
      } else if (bg.a > 0) {
        part = 'background';
        color = A.blend(bg, around);
      }
      if (!part) continue;
      const ratio = A.contrast(color, around);
      // Same colour as the surroundings: that part draws no boundary at all (a borderless button
      // whose text identifies it), which this rule does not judge.
      if (ratio >= 3 || ratio < 1.005) continue;
      n++;
      A.add({ test: '1.4.11', level: 'review', impact: 'moderate', el, details: { part, ratio: +ratio.toFixed(2), color: A.hex(color), against: A.hex(around) },
        message: `The ${part} of this ${type ? `${type} field` : el.localName === 'button' || A.role(el) === 'button' ? 'button' : A.role(el) || el.localName} is ${A.hex(color)} on ${A.hex(around)}, ${ratio.toFixed(2)}:1, below the 3:1 a component's boundary needs to be seen. Confirm the control can be identified by other means, or darken its ${part}.` });
    }
  };

  // ---- Best practices (review, test 'BP') ----
  const LANDMARK_ROLES = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search', 'dialog', 'alertdialog']);
  const inLandmark = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (LANDMARK_ROLES.has(A.role(n))) return true;
    return false;
  };
  const region = () => {
    const tops = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      const p = t.parentElement;
      if (!p || !t.nodeValue.trim() || /^(script|style|noscript|template)$/.test(p.localName)) continue;
      if (!A.isVisible(p) || A.isVisuallyHidden(p) || A.isHiddenFromAT(p)) continue;
      if (p.closest('a[href^="#"]')) continue; // skip links sit before the landmarks by design
      if (inLandmark(p)) continue;
      let top = p;
      while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
      if (!tops.has(top)) tops.set(top, t.nodeValue.trim());
      if (tops.size >= 5) break;
    }
    for (const [el, text] of tops) {
      A.add({ test: 'BP', level: 'review', impact: 'moderate', el, details: { rule: 'region' }, message: `Text "${text.slice(0, 60)}" is outside every landmark, so screen reader users who move by landmarks skip it. Put the page's content in main, header, nav, aside, footer or a named region. (best practice: region)` });
    }
  };
  const headingOne = () => {
    const h1 = Array.from(document.querySelectorAll('h1, [role="heading"][aria-level="1"]')).some((h) => (A.isVisible(h) || A.isVisuallyHidden(h)) && !A.isHiddenFromAT(h));
    if (!h1) A.add({ test: 'BP', level: 'review', impact: 'moderate', selector: 'h1', details: { rule: 'page-has-heading-one' }, message: 'The page has no level-one heading. Screen reader users jump to the h1 to find the main content; give the page one that names it. (best practice: page-has-heading-one)' });
  };
  // ARIA in HTML: the roles authors may give these elements. Elements not listed are not judged.
  const ROLES_ALLOWED = (() => {
    const L = (s) => new Set(s.split(' '));
    const link = L('button checkbox menuitem menuitemcheckbox menuitemradio option radio switch tab treeitem');
    return {
      a: (el) => (el.hasAttribute('href') ? link : null),
      button: () => L('checkbox combobox gridcell link menuitem menuitemcheckbox menuitemradio option radio separator slider switch tab treeitem'),
      li: () => L('menuitem menuitemcheckbox menuitemradio option none presentation radio separator tab treeitem'),
      ul: () => L('group listbox menu menubar none presentation radiogroup tablist toolbar tree'),
      ol: () => L('group listbox menu menubar none presentation radiogroup tablist toolbar tree'),
      h1: () => L('none presentation tab'), h2: () => L('none presentation tab'), h3: () => L('none presentation tab'),
      h4: () => L('none presentation tab'), h5: () => L('none presentation tab'), h6: () => L('none presentation tab'),
      nav: () => L('menu menubar none presentation tablist'),
      main: () => L(''),
      header: () => L('group none presentation'),
      footer: () => L('group none presentation'),
      aside: () => L('feed none note presentation region search'),
      label: () => L(''),
      textarea: () => L(''),
      select: (el) => (el.multiple || el.size > 1 ? L('') : L('menu')),
      option: () => L(''),
      table: () => null,
      input: (el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return L('button menuitemcheckbox option switch');
        if (type === 'radio') return L('menuitemradio');
        if (/^(button|submit|reset|image)$/.test(type)) return L('checkbox combobox link menuitem menuitemcheckbox menuitemradio option radio switch tab');
        if (/^(text|search|tel|url|email)$/.test(type)) return el.hasAttribute('list') ? L('') : L('combobox searchbox spinbutton');
        return L('');
      },
    };
  })();
  const allowedRole = () => {
    let n = 0;
    for (const el of document.querySelectorAll('[role]')) {
      if (n >= 20) break;
      const role = A.explicitRole(el);
      if (!role || !ROLES_ALLOWED[el.localName]) continue;
      const allowed = ROLES_ALLOWED[el.localName](el);
      if (!allowed || allowed.has(role) || role === A.aria.implicitRole(el)) continue;
      if (!A.isVisible(el) && !A.isVisuallyHidden(el)) continue;
      n++;
      A.add({ test: 'BP', level: 'review', impact: 'minor', el, details: { rule: 'aria-allowed-role' }, message: `role="${role}" is not allowed on <${el.localName}> (ARIA in HTML${allowed.size ? ` allows ${[...allowed].join(', ')}` : ' allows no role here'}). Use an element whose own role fits, such as <${role === 'button' ? 'button' : role === 'link' ? 'a href' : 'div'}>, or nest one inside. (best practice: aria-allowed-role)` });
    }
  };
  // Header cells by ARIA role that name nothing (th elements are 14.B's).
  const emptyHeader = () => {
    for (const el of document.querySelectorAll('[role="columnheader"], [role="rowheader"]')) {
      if (el.localName === 'th' || !A.isVisible(el) || A.isHiddenFromAT(el)) continue;
      if (A.text(el) || A.accName(el).name) continue;
      A.add({ test: 'BP', level: 'review', impact: 'minor', el, details: { rule: 'empty-table-header' }, message: `This ${A.role(el)} is empty, so the cells it heads are announced without a header. Give it text. (best practice: empty-table-header)` });
    }
  };
  // A viewport that caps zoom below 500% (below 200% is 18.A's violation).
  const viewportLarge = () => {
    const vp = document.querySelector('meta[name="viewport" i]');
    if (!vp) return;
    const m = /maximum-scale\s*=\s*([\d.]+)/i.exec(vp.getAttribute('content') || '');
    if (!m) return;
    const max = parseFloat(m[1]);
    if (max >= 2 && max < 5) A.add({ test: 'BP', level: 'review', impact: 'minor', selector: 'meta[name=viewport]', html: vp.outerHTML, details: { rule: 'meta-viewport-large' }, message: `The viewport meta tag limits zoom to ${max * 100}% (maximum-scale=${max}). Low-vision users on phones zoom further; allow at least 500% (maximum-scale=5), or drop maximum-scale. (best practice: meta-viewport-large)` });
  };

  A.register(function beyond508(A) {
    if (!A.beyond()) return;
    const rules = [labelInName, inputPurpose, textSpacing, orientation, nonTextContrast, region, headingOne, allowedRole, emptyHeader, viewportLarge];
    if (A.beyond('2.2')) rules.push(() => targetSize());
    const add = A.add;
    // Every finding from this check is beyond Section 508.
    A.add = (f) => add({ ...f, beyond508: true });
    try {
      for (const rule of rules) {
        try {
          rule();
        } catch (e) {
          A.meta.errors.push(`beyond508 ${rule.name || 'rule'}: ${e && e.message ? e.message : e}`);
        }
      }
    } finally {
      A.add = add;
    }
  });

  // ---- Helpers for the passes in src/passes.mjs ----

  // Text spacing: WCAG 1.4.12's values as an author stylesheet, the way a bookmarklet applies them.
  const SPACING_ID = '__a11y508-text-spacing';
  A.applyTextSpacing = () => {
    if (document.getElementById(SPACING_ID)) return true;
    const st = document.createElement('style');
    st.id = SPACING_ID;
    st.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
    (document.head || document.documentElement).appendChild(st);
    return true;
  };
  A.removeTextSpacing = () => {
    const st = document.getElementById(SPACING_ID);
    if (st) st.remove();
    return !document.getElementById(SPACING_ID);
  };

  // Reflow at 320 CSS px: elements that reach past the viewport's right edge, so the page scrolls
  // sideways. Content that needs two dimensions (tables, images, maps, video, canvas, pre, code,
  // iframes) is exempt, and so is anything inside a container that scrolls or clips on its own.
  const TWO_D = 'table, img, picture, svg, video, canvas, map, object, embed, iframe, pre, code, math, [role="img"], [role="grid"], [role="table"], [role="treegrid"], [role="application"]';
  A.reflowIssues = () => {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const out = [];
    const over = (el) => el.getBoundingClientRect().right + window.scrollX > vw + 1;
    for (const el of A.allVisible(6000)) {
      if (out.length >= 10) break;
      if (A.isVisuallyHidden(el) || A.isHiddenFromAT(el)) continue;
      if (!over(el)) continue;
      if (el.matches(TWO_D) || el.closest(TWO_D)) continue;
      const p = el.parentElement;
      // Report the outermost element that overflows; its descendants overflow with it.
      if (p && p !== document.body && p !== document.documentElement && over(p) && !p.matches(TWO_D)) continue;
      let scrolls = false;
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const s = A.cs(n);
        if (s && /auto|scroll|hidden|clip/.test(s.overflowX)) {
          scrolls = true;
          break;
        }
      }
      if (scrolls) continue;
      const r = el.getBoundingClientRect();
      out.push({ selector: A.selector(el), html: A.html(el), rect: A.rect(el), right: Math.round(r.right + window.scrollX), width: Math.round(r.width) });
    }
    return { issues: out, viewport: vw, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  };
})();
