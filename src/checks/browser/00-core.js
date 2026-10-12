// Core helpers shared by every in-page check. Loaded first.
// Plain script (not a module); it runs inside the audited page via Runtime.evaluate.
(() => {
  const A = (window.__a11y508 = window.__a11y508 || {});
  A.checks = [];
  A.register = (fn) => A.checks.push(fn);
  A.findings = [];
  A.counts = {};
  A.LIMIT = 150; // findings per test per page

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton',
    'gridcell', 'row', 'columnheader', 'rowheader',
  ]);
  A.INTERACTIVE_ROLES = INTERACTIVE_ROLES;

  // Valid, abstract and name-from-content roles come from the ARIA model (05-aria-data.js, A.aria),
  // which is loaded after this file and read only when a check runs.
  // Native elements named from their content whatever their role (caption's role prohibits naming,
  // legend has none, but each names its table or fieldset).
  const NAME_FROM_CONTENT_TAGS = new Set(['summary', 'legend', 'caption', 'td', 'th', 'tr', 'option']);

  // Characters that render as nothing a listener can interpret: Unicode private-use areas (icon-font
  // glyphs, planes 15 and 16 included), variation selectors, and zero-width characters.
  const NON_TEXT = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u200B-\u200D\u2060\uFEFF]/gu;
  A.stripGlyphs = (str) => (str || '').replace(NON_TEXT, '');

  A.text = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();

  A.cs = (el, pseudo) => {
    try {
      return getComputedStyle(el, pseudo || null);
    } catch {
      return null;
    }
  };

  A.isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[hidden]')) return false;
    const s = A.cs(el);
    if (!s || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && !el.getClientRects().length) return false;
    // display:contents elements have no box but their children render
    if (r.width === 0 && r.height === 0 && s.display !== 'contents') {
      if (el.childElementCount === 0) return false;
    }
    return true;
  };

  // Visually hidden but still in the accessibility tree (sr-only patterns, opacity 0, off-screen)
  A.isVisuallyHidden = (el) => {
    const s = A.cs(el);
    if (!s) return false;
    const r = el.getBoundingClientRect();
    if (parseFloat(s.opacity) === 0) return true;
    if (s.clipPath && s.clipPath !== 'none' && /inset\(\s*(100%|50%)/.test(s.clipPath)) return true;
    if (s.clip && /rect\(\s*0(px)?,?\s*0(px)?,?\s*0(px)?,?\s*0(px)?\s*\)/.test(s.clip) && s.position === 'absolute') return true;
    if (r.width <= 1 && r.height <= 1 && s.overflow === 'hidden') return true;
    // Off-screen means off the document, not off the viewport: a scrolled page must not hide what is above the fold.
    if (r.right + window.scrollX < 0 || r.bottom + window.scrollY < 0) return true;
    if (parseFloat(s.fontSize) === 0) return true;
    if (s.color && A.parseColor(s.color).a === 0) return true;
    return false;
  };

  A.isAriaHiddenAttr = (el) => !!el.closest('[aria-hidden="true" i]');
  const isInert = (el) => !!el.closest('[inert]');
  // The open modal dialog, if any: a native dialog shown with showModal(), or a visible element
  // with role="dialog"/"alertdialog" and aria-modal="true". Looked up once per A.run() (cached
  // for the run's duration) and on every call outside a run.
  const findModal = () => {
    try {
      const native = document.querySelector('dialog:modal');
      if (native) return native;
    } catch {}
    for (const d of document.querySelectorAll('[role="dialog"][aria-modal="true" i], [role="alertdialog"][aria-modal="true" i]')) {
      if (A.isVisible(d)) return d;
    }
    return null;
  };
  let modalCache;
  A.openModal = () => (modalCache !== undefined ? modalCache : findModal());
  const outsideModal = (el) => {
    const modal = A.openModal();
    return !!modal && !modal.contains(el);
  };
  // { selector, name } of the modal dialog open now, or null. The crawler calls it after load.
  A.modalOnLoad = () => {
    const m = findModal();
    return m ? { selector: A.selector(m), name: A.accName(m).name || '' } : null;
  };
  // Hidden for everyone, sighted users included: display:none or visibility:hidden on the element
  // or an ancestor, or the hidden attribute. Visually hidden (sr-only, clipped) content is not.
  A.isHiddenForEveryone = (el) => {
    if (el.closest('[hidden]')) return true;
    const s = A.cs(el);
    if (!s || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
    return s.display !== 'contents' && el.getClientRects().length === 0;
  };
  // Hidden from assistive technology: aria-hidden (any case), an inert ancestor, or outside an open modal dialog.
  A.isHiddenFromAT = (el) => A.isAriaHiddenAttr(el) || isInert(el) || outsideModal(el);
  A.isAriaHidden = (el) => A.isHiddenFromAT(el);

  A.selector = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.localName;
      if (cur.id && document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
        parts.unshift('#' + cur.id);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.localName === cur.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length > 12) break;
    }
    return parts.join(' > ');
  };

  A.html = (el, max = 300) => {
    if (!el || el.nodeType !== 1) return '';
    let s;
    try {
      const open = el.cloneNode(false).outerHTML;
      const inner = A.text(el);
      s = open.replace(/<\/[^>]+>$/, '');
      if (inner) s += inner.slice(0, 80) + (inner.length > 80 ? '…' : '');
      if (!/\/>$/.test(open)) s += `</${el.localName}>`;
    } catch {
      s = el.outerHTML || '';
    }
    return s.length > max ? s.slice(0, max) + '…' : s;
  };

  A.rect = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    } catch {
      return null;
    }
  };

  A.parseColor = (str) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(str || '');
    if (!m) {
      if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      return { r: 0, g: 0, b: 0, a: 1 };
    }
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  };

  A.blend = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };

  A.luminance = ({ r, g, b }) => {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  A.contrast = (c1, c2) => {
    const l1 = A.luminance(c1);
    const l2 = A.luminance(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  A.hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  const NATIVE_FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"])';
  A.isNativeFocusable = (el) => {
    if (!el.matches(NATIVE_FOCUSABLE)) return false;
    if (el.matches('input[type="hidden"]')) return false;
    // :disabled also covers controls inside a disabled fieldset (outside its first legend).
    if (el.disabled || el.matches(':disabled')) return false;
    if (el.localName === 'summary' && !(el.parentElement && el.parentElement.localName === 'details' && el.parentElement.firstElementChild === el)) return false;
    return true;
  };
  A.tabindexOf = (el) => {
    const t = el.getAttribute('tabindex');
    if (t === null || t.trim() === '') return null;
    const n = parseInt(t, 10);
    return Number.isNaN(n) ? null : n;
  };
  A.isFocusable = (el) => {
    if (isInert(el) || outsideModal(el)) return false;
    if (A.isNativeFocusable(el)) return true;
    const t = A.tabindexOf(el);
    return t !== null;
  };
  A.isTabbable = (el) => {
    if (!A.isFocusable(el)) return false;
    const t = A.tabindexOf(el);
    if (t !== null && t < 0) return false;
    return true;
  };

  A.hasInteractiveAncestor = (el) => {
    const p = el.parentElement && el.parentElement.closest('a[href], button, [role="button"], [role="link"], label, summary, select, [contenteditable="true"]');
    return !!p;
  };

  // The explicit role is the first valid token of the role attribute ("image" is the ARIA 1.3 alias of img);
  // '' when no token is valid, in which case the browser falls back to the implicit role.
  A.explicitRole = (el) => {
    const tokens = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const r = t === 'image' ? 'img' : t;
      if (A.aria.isConcrete(r)) return r;
    }
    return '';
  };

  // The explicit role, else the implicit one from HTML-AAM ('generic' for div and span, '' for
  // elements with no corresponding role).
  A.role = (el) => A.explicitRole(el) || A.aria.implicitRole(el);

  // self: the element being named, when it is not el (see contentName).
  const refText = (el, attr, self = el) => {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    const parts = [];
    for (const id of ids) {
      const t = document.getElementById(id);
      if (t) parts.push(nameFromContent(t, true, self));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  // CSS generated text of ::before/::after: { text, raw }. text has icon-font glyphs and other
  // non-text characters removed, because a private-use glyph is not a name anyone can hear.
  const pseudoText = (el) => {
    const out = [];
    for (const p of ['::before', '::after']) {
      const c = A.cs(el, p);
      const v = c && c.content;
      if (v && v !== 'none' && v !== 'normal' && /^"/.test(v)) {
        const raw = v.slice(1, -1);
        out.push({ text: A.stripGlyphs(raw), raw });
      } else out.push(null);
    }
    return out;
  };

  // The value an embedded control contributes to the name of what contains it (accname 2C):
  // a textbox's value, the selected option of a select or listbox, a range's aria-valuetext or
  // aria-valuenow. null when the node is not such a control. Password values never contribute.
  const TEXT_INPUT = /^(text|search|email|tel|url|number)$/;
  A.embeddedValue = (node) => {
    const tag = node.localName;
    const role = A.explicitRole(node);
    const type = tag === 'input' ? (node.getAttribute('type') || 'text').toLowerCase() : '';
    if (role === 'slider' || role === 'spinbutton' || type === 'range') {
      const vt = node.getAttribute('aria-valuetext');
      if (vt && vt.trim()) return vt.trim();
      const vn = node.getAttribute('aria-valuenow');
      if (vn && vn.trim()) return vn.trim();
      return tag === 'input' ? node.value || '' : '';
    }
    if (tag === 'select') return Array.from(node.selectedOptions || []).map((o) => A.text(o)).join(' ');
    if (tag === 'textarea') return node.value || '';
    if (tag === 'input') return TEXT_INPUT.test(type) ? node.value || '' : null;
    if (role === 'listbox') return Array.from(node.querySelectorAll('[role="option"][aria-selected="true" i]')).map((o) => A.text(o)).join(' ');
    if (role === 'combobox' || role === 'textbox' || role === 'searchbox') return A.text(node);
    return null;
  };

  // Simplified accessible-name-from-content: text, alt of images, aria-label of descendants,
  // and the value of embedded controls.
  // Returns { name, raw }: raw keeps icon-font glyphs so a message can show what is there.
  // self is the element whose name is being computed when el is something else (its label, or an
  // element its aria-labelledby points at). As Chrome does, self contributes nothing to its own
  // name: <label>Show <select>…</select> rows</label> names the select "Show rows", while a button
  // labelled by that label is "Show 10 rows".
  function contentName(el, includeHidden, self = el) {
    const parts = [];
    const raws = [];
    const push = (text, raw) => {
      parts.push(text);
      raws.push(raw === undefined ? text : raw);
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        push(A.stripGlyphs(node.nodeValue), node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;
      if (node === self && node !== el) return;
      if ((node.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return;
      if (!includeHidden && !A.isVisible(node) && !A.isVisuallyHidden(node)) return;
      const al = node.getAttribute('aria-label');
      if (al && A.stripGlyphs(al).trim()) {
        push(al);
        return;
      }
      if (node.hasAttribute('aria-labelledby') && node !== el) {
        const t = refText(node, 'aria-labelledby', self);
        if (t) {
          push(t);
          return;
        }
      }
      if (node.localName === 'img' || node.localName === 'area') {
        push(node.getAttribute('alt') || '');
        return;
      }
      if (node.localName === 'input' && /^(submit|reset|button|image)$/i.test(node.type)) {
        push(node.value || node.getAttribute('alt') || '');
        return;
      }
      if (node.localName === 'svg') {
        const t = node.querySelector(':scope > title');
        if (t) push(A.text(t));
        return;
      }
      if (node !== el) {
        const v = A.embeddedValue(node);
        if (v !== null) {
          push(v);
          return;
        }
      }
      const [before, after] = pseudoText(node);
      if (before && before.raw) push(before.text, before.raw);
      for (const c of node.childNodes) walk(c);
      if (after && after.raw) push(after.text, after.raw);
      if (!parts.length && node.getAttribute('title')) push(node.getAttribute('title'));
    };
    walk(el);
    const clean = (a) => a.join(' ').replace(/\s+/g, ' ').trim();
    return { name: clean(parts), raw: clean(raws) };
  }
  function nameFromContent(el, includeHidden, self) {
    return contentName(el, includeHidden, self).name;
  }
  A.nameFromContent = nameFromContent;

  // Content names an element only when its role allows it (WAI-ARIA "name from: contents"),
  // or for the native summary, legend and caption; otherwise only labelling attributes and title do.
  A.namedFromContent = (el) => {
    const r = A.aria.roles[A.role(el)];
    return (!!r && r.nameFromContent) || NAME_FROM_CONTENT_TAGS.has(el.localName);
  };

  // Returns { name, source } where source is one of:
  // aria-labelledby | aria-label | label | alt | value | content | title | placeholder | caption | legend | ''
  // and, when the element is unnamed but holds content that is not a name (an icon-font glyph), raw.
  A.accName = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = refText(el, 'aria-labelledby');
      if (t) return { name: t, source: 'aria-labelledby' };
    }
    const al = el.getAttribute('aria-label');
    if (al && A.stripGlyphs(al).trim()) return { name: al.trim(), source: 'aria-label' };
    const tag = el.localName;
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'meter' || tag === 'progress' || tag === 'output') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && ['submit', 'reset', 'button'].includes(type)) {
        const v = el.getAttribute('value');
        if (v && v.trim()) return { name: v.trim(), source: 'value' };
        return { name: type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '', source: type === 'button' ? '' : 'default' };
      }
      if (tag === 'input' && type === 'image') {
        const alt = el.getAttribute('alt');
        if (alt && alt.trim()) return { name: alt.trim(), source: 'alt' };
        const v = el.getAttribute('value');
        if (v && v.trim()) return { name: v.trim(), source: 'value' };
      }
      const labels = [];
      if (el.labels) for (const l of el.labels) labels.push(nameFromContent(l, true, el));
      const lt = labels.join(' ').trim();
      if (lt) return { name: lt, source: 'label' };
      const title = el.getAttribute('title');
      if (title && title.trim()) return { name: title.trim(), source: 'title' };
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return { name: ph.trim(), source: 'placeholder' };
      return { name: '', source: '' };
    }
    if (tag === 'img' || tag === 'area') {
      const alt = el.getAttribute('alt');
      if (alt !== null && alt.trim()) return { name: alt.trim(), source: 'alt' };
      const title = el.getAttribute('title');
      if (title && title.trim()) return { name: title.trim(), source: 'title' };
      return { name: '', source: alt === '' ? 'empty-alt' : '' };
    }
    if (tag === 'table') {
      const c = el.querySelector(':scope > caption');
      if (c && A.text(c)) return { name: A.text(c), source: 'caption' };
    }
    if (tag === 'fieldset') {
      const l = el.querySelector(':scope > legend');
      if (l && A.text(l)) return { name: A.text(l), source: 'legend' };
    }
    if (tag === 'figure') {
      const l = el.querySelector(':scope > figcaption');
      if (l && A.text(l)) return { name: A.text(l), source: 'figcaption' };
    }
    if (tag === 'iframe' || tag === 'frame') {
      const title = el.getAttribute('title');
      if (title && title.trim()) return { name: title.trim(), source: 'title' };
      return { name: '', source: '' };
    }
    if (tag === 'svg') {
      const t = el.querySelector(':scope > title');
      if (t && A.text(t)) return { name: A.text(t), source: 'svg-title' };
    }
    let raw = '';
    if (A.namedFromContent(el)) {
      const content = contentName(el, false);
      if (content.name) return { name: content.name, source: 'content' };
      raw = content.raw;
    }
    const title = el.getAttribute('title');
    if (title && A.stripGlyphs(title).trim()) return { name: title.trim(), source: 'title' };
    // raw: content that was not a name, e.g. an icon-font glyph, kept for messages.
    return raw ? { name: '', source: '', raw } : { name: '', source: '' };
  };

  A.accDescription = (el) => {
    const d = el.getAttribute('aria-describedby');
    if (d) return refText(el, 'aria-describedby');
    const t = el.getAttribute('title');
    return t ? t.trim() : '';
  };

  A.add = (f) => {
    const key = f.test;
    A.counts[key] = (A.counts[key] || 0) + 1;
    if (A.counts[key] > A.LIMIT) {
      A.truncated[key] = (A.truncated[key] || 0) + 1;
      return;
    }
    const el = f.el;
    const out = {
      test: f.test,
      level: f.level || 'violation',
      impact: f.impact || 'moderate',
      message: f.message,
      selector: el ? A.selector(el) : f.selector || '',
      html: el ? A.html(el) : f.html || '',
      rect: el ? A.rect(el) : f.rect || null,
      details: f.details || undefined,
    };
    A.findings.push(out);
    return out;
  };

  A.allVisible = (limit = 5000) => {
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (/^(script|style|noscript|template|head|meta|link|title)$/.test(n.localName)) continue;
      if (A.isVisible(n)) out.push(n);
      if (out.length >= limit) break;
    }
    return out;
  };

  A.bodyFontSize = () => parseFloat(A.cs(document.body || document.documentElement).fontSize) || 16;

  A.run = (opts) => {
    A.opts = opts || {};
    A.findings = [];
    A.counts = {};
    A.truncated = {};
    A.meta = { errors: [] };
    const sx = window.scrollX;
    const sy = window.scrollY;
    modalCache = findModal();
    try {
      for (const check of A.checks) {
        try {
          check(A);
        } catch (e) {
          A.meta.errors.push(`${check.name}: ${e && e.message ? e.message : e}`);
        }
      }
    } finally {
      modalCache = undefined;
    }
    // Checks may scroll (contrast scrolls text into view to sample it); they must leave the page where it was.
    A.meta.scrollRestored = Math.abs(window.scrollX - sx) < 1 && Math.abs(window.scrollY - sy) < 1;
    A.meta.truncated = A.truncated;
    return { findings: A.findings, meta: A.meta };
  };

  A.fingerprint = (f) => `${f.test}|${f.selector}|${f.message}`;
})();
