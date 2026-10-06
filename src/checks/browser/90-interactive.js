// Helpers used by the Node side for crawling, the keyboard pass, disclosure activation,
// and the 200% zoom pass. These are not checks; they expose functions on window.__a11y508.
(() => {
  const A = window.__a11y508;

  A.pageInfo = () => {
    const links = [];
    for (const a of document.querySelectorAll('a[href], area[href]')) {
      const href = a.getAttribute('href');
      if (!href) continue;
      try {
        const u = new URL(href, location.href);
        if (u.protocol === 'http:' || u.protocol === 'https:') links.push(u.href);
      } catch {}
    }
    const navSig = (sel) => {
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll(sel)) {
        if (!A.isVisible(a) && !A.isVisuallyHidden(a)) continue;
        const n = A.accName(a).name.toLowerCase().trim();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
      return out;
    };
    const linkNames = [];
    const here = location.href.replace(/#.*$/, '');
    for (const a of document.querySelectorAll('a[href]')) {
      if (linkNames.length >= 400) break;
      const raw = a.getAttribute('href') || '';
      if (raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
      const n = A.accName(a).name.trim();
      if (!n) continue;
      try {
        const u = new URL(raw, location.href);
        const hadHash = !!u.hash;
        u.hash = '';
        if (hadHash && u.href === here) continue;
        linkNames.push([u.href, n]);
      } catch {}
    }
    const search = !!document.querySelector('input[type="search"], [role="search"], form[action*="search" i], input[name="q"], input[name="s"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i]');
    const sitemap = !!Array.from(document.querySelectorAll('a[href]')).find((a) => /sitemap|site map|site index/i.test(A.accName(a).name) || /sitemap/i.test(a.getAttribute('href') || ''));
    const breadcrumb = !!document.querySelector('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, nav[class*="breadcrumb" i], ol[class*="breadcrumb" i]');
    const navCount = document.querySelectorAll('nav a[href], [role="navigation"] a[href]').length;
    return {
      title: (document.title || '').trim(),
      lang: document.documentElement.getAttribute('lang') || '',
      links: Array.from(new Set(links)),
      nav: navSig('nav a[href], [role="navigation"] a[href], header a[href], [role="banner"] a[href], footer a[href], [role="contentinfo"] a[href]'),
      linkNames,
      search,
      sitemap,
      breadcrumb,
      navCount,
      textLength: A.text(document.body).length,
      h1: A.text(document.querySelector('h1') || { textContent: '' }),
    };
  };

  // ---- keyboard pass ----
  const FOCUS_PROPS = ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color', 'border-top-width', 'border-bottom-width', 'border-top-style', 'background-color', 'color', 'text-decoration-line', 'filter', 'transform', 'background-image', 'opacity'];
  const snapshot = (el) => {
    const s = A.cs(el);
    const o = {};
    for (const p of FOCUS_PROPS) o[p] = s.getPropertyValue(p);
    // Also watch the immediate children (e.g. focus style applied to inner span) and ::before/::after
    for (const pseudo of ['::before', '::after']) {
      const ps = A.cs(el, pseudo);
      o[pseudo + 'content'] = ps.content;
      o[pseudo + 'box-shadow'] = ps.boxShadow;
      o[pseudo + 'outline-style'] = ps.outlineStyle;
      o[pseudo + 'opacity'] = ps.opacity;
      o[pseudo + 'border-color'] = ps.borderTopColor;
      o[pseudo + 'background-color'] = ps.backgroundColor;
    }
    const kid = el.firstElementChild;
    if (kid) {
      const ks = A.cs(kid);
      for (const p of ['outline-style', 'box-shadow', 'background-color', 'color', 'text-decoration-line', 'border-bottom-color']) o['child:' + p] = ks.getPropertyValue(p);
    }
    const parent = el.parentElement;
    if (parent) {
      const ps = A.cs(parent);
      for (const p of ['outline-style', 'box-shadow', 'background-color', 'border-bottom-color']) o['parent:' + p] = ps.getPropertyValue(p);
    }
    return o;
  };

  A.kbPrepare = () => {
    A.kb = { baseline: new WeakMap(), index: new WeakMap(), count: 0 };
    const all = document.querySelectorAll('*');
    let i = 0;
    for (const el of all) {
      A.kb.index.set(el, i++);
      if (A.isTabbable(el) && A.isVisible(el)) {
        A.kb.baseline.set(el, snapshot(el));
        A.kb.count++;
      }
    }
    try {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    } catch {}
    window.scrollTo(0, 0);
    return { count: A.kb.count, href: location.href };
  };

  A.kbSample = () => {
    const el = document.activeElement;
    const isBody = !el || el === document.body || el === document.documentElement;
    if (isBody) return { isBody: true, href: location.href };
    const r = el.getBoundingClientRect();
    const s = A.cs(el);
    const visible = A.isVisible(el) && !A.isVisuallyHidden(el) && s.visibility !== 'hidden';
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth && r.width > 0 && r.height > 0;
    const base = A.kb.baseline.get(el);
    const now = snapshot(el);
    const diff = [];
    if (base) {
      for (const k of Object.keys(now)) if (now[k] !== base[k]) diff.push(k);
    }
    // outline: none with no other change is the classic failure
    const outlineVisible = now['outline-style'] !== 'none' && parseFloat(now['outline-width']) > 0 && A.parseColor(now['outline-color']).a > 0;
    // Is the focused element covered by something else (e.g. sticky header)?
    let covered = false;
    if (inViewport) {
      try {
        const cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
        const cy = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
      } catch {}
    }
    return {
      isBody: false,
      href: location.href,
      key: A.kb.index.get(el) ?? -1,
      domIndex: A.kb.index.get(el) ?? -1,
      selector: A.selector(el),
      html: A.html(el),
      tag: el.localName,
      role: A.role(el),
      name: A.accName(el).name.slice(0, 80),
      rect: A.rect(el),
      visible,
      inViewport,
      covered,
      hadBaseline: !!base,
      diff,
      outlineVisible,
      inDialog: !!el.closest('[role="dialog"], [role="alertdialog"], dialog'),
      inIframe: el.localName === 'iframe',
      // Native composite widgets move focus internally while document.activeElement stays on the host.
      composite: el.localName === 'iframe' || el.localName === 'audio' || el.localName === 'video' || !!el.shadowRoot ||
        (el.localName === 'input' && /^(date|time|datetime-local|month|week|color|file)$/.test(el.type)),
    };
  };

  A.focusSelector = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  };

  // ---- disclosure activation ----
  A.disclosureCandidates = (max) => {
    const out = [];
    const sel = 'button[aria-expanded="false"], [role="button"][aria-expanded="false"], a[aria-expanded="false"][href^="#"], a[aria-expanded="false"]:not([href]), summary, button[aria-haspopup]:not([aria-expanded="true"]), [role="button"][aria-haspopup]:not([aria-expanded="true"])';
    for (const el of document.querySelectorAll(sel)) {
      if (out.length >= max) break;
      if (!A.isVisible(el) || A.isAriaHidden(el)) continue;
      if (el.localName === 'button' && el.form && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit') continue;
      if (el.localName === 'summary') {
        const d = el.parentElement;
        if (!d || d.localName !== 'details' || d.open) continue;
      }
      const name = A.accName(el).name;
      if (/sign out|log ?out|delete|remove|submit|pay|purchase|buy|send/i.test(name)) continue;
      out.push({ selector: A.selector(el), name: name.slice(0, 60), native: el.localName === 'button' || el.localName === 'summary' || el.localName === 'a' });
    }
    return out;
  };

  A.disclosureState = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { exists: false, href: location.href };
    let expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.localName === 'summary') expanded = !!(el.parentElement && el.parentElement.open);
    const active = document.activeElement;
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')).find((d) => A.isVisible(d));
    const focusInDialog = !!(dialog && active && dialog.contains(active));
    const focusOnTrigger = active === el;
    return { exists: true, expanded, href: location.href, dialog: dialog ? A.selector(dialog) : null, focusInDialog, focusOnTrigger, activeSelector: active ? A.selector(active) : '' };
  };

  // ---- 200% zoom pass ----
  A.visibleTextLength = () => A.text(document.body).length;

  A.layoutIssues = () => {
    const clipped = [];
    const overlaps = [];
    const leaves = [];
    for (const el of A.allVisible(6000)) {
      if (A.isAriaHidden(el) || A.isVisuallyHidden(el)) continue;
      let own = false;
      for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) { own = true; break; }
      if (!own) continue;
      if (el.closest('pre, code, table, svg, button, select, option, [role="tab"]')) continue;
      const s = A.cs(el);
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const clips = ['hidden', 'clip'].includes(s.overflowX) || ['hidden', 'clip'].includes(s.overflowY);
      if (clips && clipped.length < 10) {
        const overflowX = el.scrollWidth - el.clientWidth;
        const overflowY = el.scrollHeight - el.clientHeight;
        if ((overflowX > 4 && s.whiteSpace === 'nowrap' && s.textOverflow !== 'ellipsis') || overflowY > 8) {
          clipped.push({ selector: A.selector(el), html: A.html(el), rect: A.rect(el), overflowX, overflowY, text: A.text(el).slice(0, 60) });
        }
      }
      if (leaves.length < 800) leaves.push({ el, r, sel: null });
    }
    leaves.sort((a, b) => a.r.top - b.r.top);
    for (let i = 0; i < leaves.length && overlaps.length < 10; i++) {
      const a = leaves[i];
      for (let j = i + 1; j < leaves.length; j++) {
        const b = leaves[j];
        if (b.r.top >= a.r.bottom - 3) break;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 6 && oy > 6) {
          // ignore if one is positioned over the other intentionally (e.g. floating label) and invisible text
          overlaps.push({ a: A.selector(a.el), b: A.selector(b.el), textA: A.text(a.el).slice(0, 40), textB: A.text(b.el).slice(0, 40), rect: A.rect(a.el), html: A.html(a.el) });
          if (overlaps.length >= 10) break;
        }
      }
    }
    return { clipped, overlaps, textLength: A.visibleTextLength(), scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  };
})();
