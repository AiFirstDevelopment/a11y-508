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
    'option', 'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'scrollbar',
    'gridcell', 'row', 'columnheader', 'rowheader',
  ]);
  A.INTERACTIVE_ROLES = INTERACTIVE_ROLES;

  A.VALID_ROLES = new Set((
    'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox ' +
    'complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell ' +
    'group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox ' +
    'menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup ' +
    'rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table ' +
    'tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem doc-abstract doc-acknowledgments ' +
    'doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon ' +
    'doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue ' +
    'doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref ' +
    'doc-notice doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc ' +
    'graphics-document graphics-object graphics-symbol'
  ).split(' '));

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
    if (r.right < 0 || r.bottom < 0) return true;
    if (parseFloat(s.fontSize) === 0) return true;
    if (s.color && A.parseColor(s.color).a === 0) return true;
    return false;
  };

  A.isAriaHidden = (el) => !!el.closest('[aria-hidden="true"]');

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
    if (el.disabled) return false;
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

  A.role = (el) => {
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (r) return r.toLowerCase();
    const t = el.localName;
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'area' && el.hasAttribute('href')) return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    if (t === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'table') return 'table';
    if (t === 'ul' || t === 'ol') return 'list';
    if (t === 'li') return 'listitem';
    if (t === 'nav') return 'navigation';
    if (t === 'main') return 'main';
    if (t === 'dialog') return 'dialog';
    if (t === 'summary') return 'button';
    return '';
  };

  const refText = (el, attr) => {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    const parts = [];
    for (const id of ids) {
      const t = document.getElementById(id);
      if (t) parts.push(nameFromContent(t, true));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  const pseudoText = (el) => {
    const out = [];
    for (const p of ['::before', '::after']) {
      const c = A.cs(el, p);
      if (!c) continue;
      const v = c.content;
      if (v && v !== 'none' && v !== 'normal' && /^"/.test(v)) out.push(v.slice(1, -1));
    }
    return out;
  };

  // Simplified accessible-name-from-content: text, alt of images, aria-label of descendants.
  function nameFromContent(el, includeHidden) {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.getAttribute('aria-hidden') === 'true') return;
      if (!includeHidden && !A.isVisible(node) && !A.isVisuallyHidden(node)) return;
      const al = node.getAttribute('aria-label');
      if (al && al.trim()) {
        parts.push(al);
        return;
      }
      if (node.hasAttribute('aria-labelledby') && node !== el) {
        const t = refText(node, 'aria-labelledby');
        if (t) {
          parts.push(t);
          return;
        }
      }
      if (node.localName === 'img' || node.localName === 'area') {
        parts.push(node.getAttribute('alt') || '');
        return;
      }
      if (node.localName === 'input' && /^(submit|reset|button|image)$/i.test(node.type)) {
        parts.push(node.value || node.getAttribute('alt') || '');
        return;
      }
      if (node.localName === 'svg') {
        const t = node.querySelector(':scope > title');
        if (t) parts.push(A.text(t));
        return;
      }
      const ps = pseudoText(node);
      if (ps[0]) parts.push(ps[0]);
      for (const c of node.childNodes) walk(c);
      if (ps[1]) parts.push(ps[1]);
      if (!parts.length && node.getAttribute('title')) parts.push(node.getAttribute('title'));
    };
    walk(el);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  A.nameFromContent = nameFromContent;

  // Returns { name, source } where source is one of:
  // aria-labelledby | aria-label | label | alt | value | content | title | placeholder | caption | legend | ''
  A.accName = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = refText(el, 'aria-labelledby');
      if (t) return { name: t, source: 'aria-labelledby' };
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return { name: al.trim(), source: 'aria-label' };
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
      if (el.labels) for (const l of el.labels) labels.push(nameFromContent(l, true));
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
    const content = nameFromContent(el, false);
    if (content) return { name: content, source: 'content' };
    const title = el.getAttribute('title');
    if (title && title.trim()) return { name: title.trim(), source: 'title' };
    return { name: '', source: '' };
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
    for (const check of A.checks) {
      try {
        check(A);
      } catch (e) {
        A.meta.errors.push(`${check.name}: ${e && e.message ? e.message : e}`);
      }
    }
    A.meta.truncated = A.truncated;
    return { findings: A.findings, meta: A.meta };
  };

  A.fingerprint = (f) => `${f.test}|${f.selector}|${f.message}`;
})();
