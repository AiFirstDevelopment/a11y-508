// Helpers used by the Node side for crawling, the keyboard pass, disclosure activation,
// and the 200% zoom pass. These are not checks; they expose functions on window.__a11y508.
(() => {
  const A = window.__a11y508;

  A.pageInfo = () => {
    const links = [];
    for (const a of A.all('a[href], area[href]')) {
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
      for (const a of A.all(sel)) {
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
    for (const a of A.all('a[href]')) {
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
    const search = !!A.one('input[type="search"], [role="search"], form[action*="search" i], input[name="q"], input[name="s"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i]');
    const sitemap = !!Array.from(A.all('a[href]')).find((a) => /sitemap|site map|site index/i.test(A.accName(a).name) || /sitemap/i.test(a.getAttribute('href') || ''));
    const breadcrumb = !!A.one('[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, nav[class*="breadcrumb" i], ol[class*="breadcrumb" i]');
    const navCount = A.all('nav a[href], [role="navigation"] a[href]').length;
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
      h1: A.text(A.one('h1') || { textContent: '' }),
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

  // Custom checkboxes, radios and switches: the native input is visually hidden and the visible
  // box is its label or the element after it, often drawn with ::before/::after. Those are where
  // the focus indicator shows, so they are watched too (own styles and pseudo-elements only:
  // a label's first child or parent may be the hidden input or a container that says nothing).
  const isCustomToggle = (el) => el.localName === 'input' &&
    (/^(checkbox|radio)$/i.test(el.type) || (el.getAttribute('role') || '').toLowerCase().split(/\s+/).includes('switch')) &&
    !!(el.labels && el.labels.length) && A.isVisuallyHidden(el);
  const toggleProxies = (el) => {
    const out = [];
    for (const l of el.labels || []) if (!out.includes(l)) out.push(l);
    const next = el.nextElementSibling;
    if (next && !out.includes(next)) out.push(next);
    return out;
  };
  const proxySnapshot = (el) => {
    const o = {};
    toggleProxies(el).forEach((p, i) => {
      const s = A.cs(p);
      for (const prop of FOCUS_PROPS) o[i + ':' + prop] = s.getPropertyValue(prop);
      for (const pseudo of ['::before', '::after']) {
        const ps = A.cs(p, pseudo);
        for (const prop of FOCUS_PROPS) o[i + pseudo + prop] = ps.getPropertyValue(prop);
      }
    });
    return o;
  };

  A.kbPrepare = () => {
    A.kb = { baseline: new WeakMap(), proxies: new WeakMap(), index: new WeakMap(), count: 0 };
    const all = A.all('*');
    let i = 0;
    for (const el of all) {
      A.kb.index.set(el, i++);
      if (A.isTabbable(el) && A.isVisible(el)) {
        A.kb.baseline.set(el, snapshot(el));
        if (isCustomToggle(el)) A.kb.proxies.set(el, proxySnapshot(el));
        A.kb.count++;
      }
    }
    try {
      const active = A.activeElement();
      if (active && active !== document.body) active.blur();
    } catch {}
    window.scrollTo(0, 0);
    return { count: A.kb.count, href: location.href };
  };

  // The element that has focus, followed into open shadow roots (a host's shadowRoot.activeElement)
  // as far as they go: document.activeElement stops at the outermost host.
  A.activeElement = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  A.kbSample = () => {
    const el = A.activeElement();
    const isBody = !el || el === document.body || el === document.documentElement;
    if (isBody) return { isBody: true, href: location.href };
    const r = el.getBoundingClientRect();
    const s = A.cs(el);
    const visible = A.isVisible(el) && !A.isVisuallyHidden(el) && s.visibility !== 'hidden';
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth && r.width > 0 && r.height > 0;
    const pbase = A.kb.proxies.get(el);
    if (pbase && isCustomToggle(el)) {
      // Judge the label and the custom box, and name the label as the element.
      const pnow = proxySnapshot(el);
      const pdiff = Object.keys(pnow).filter((k) => pnow[k] !== pbase[k]);
      const label = el.labels[0];
      const lr = label.getBoundingClientRect();
      return {
        isBody: false,
        href: location.href,
        key: A.kb.index.get(el) ?? -1,
        domIndex: A.kb.index.get(el) ?? -1,
        selector: A.selector(label),
        html: A.html(label),
        tag: el.localName,
        role: A.role(el),
        name: A.accName(el).name.slice(0, 80),
        rect: A.rect(label),
        visible: true,
        inViewport: lr.bottom > 0 && lr.right > 0 && lr.top < window.innerHeight && lr.left < window.innerWidth && lr.width > 0 && lr.height > 0,
        covered: false,
        hadBaseline: true,
        diff: pdiff,
        outlineVisible: false,
        proxied: el.type === 'radio' ? 'radio' : (el.getAttribute('role') || '').toLowerCase().includes('switch') ? 'switch' : 'checkbox',
        inDialog: !!el.closest('[role="dialog"], [role="alertdialog"], dialog'),
        inIframe: false,
        composite: false,
      };
    }
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
        const top = A.rootOf(el).elementFromPoint(cx, cy);
        covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
      } catch {}
    }
    const beyond = A.beyond() ? beyondSample(el, r, base, now, diff, inViewport) : {};
    return {
      ...beyond,
      isBody: false,
      href: location.href,
      key: A.kb.index.get(el) ?? -1,
      domIndex: A.kb.index.get(el) ?? -1,
      selector: A.selector(el),
      html: A.html(el),
      tag: el.localName,
      role: A.role(el),
      // A label for people reading the report, not an accessible name: generic elements keep their text.
      name: (A.accName(el).name || A.nameFromContent(el, false)).slice(0, 80),
      rect: A.rect(el),
      visible,
      inViewport,
      covered,
      hadBaseline: !!base,
      diff,
      outlineVisible,
      inDialog: !!el.closest('[role="dialog"], [role="alertdialog"], dialog'),
      inIframe: el.localName === 'iframe' || el.localName === 'frame',
      // Native composite widgets move focus internally while document.activeElement stays on the host.
      composite: el.localName === 'iframe' || el.localName === 'audio' || el.localName === 'video' || !!el.shadowRoot ||
        (el.localName === 'input' && /^(date|time|datetime-local|month|week|color|file)$/.test(el.type)),
    };
  };

  // Beyond-508 profile only. obscured: 'full' when every sampled point of the focused element is
  // under fixed or sticky author content (WCAG 2.2 2.4.11), 'partial' when some are. faint: hidden
  // only by IBM's opacity-under-0.1 rule. weakIndicator: the focus change is a colour change of
  // under 3:1 against the unfocused state, or a new outline under 3:1 against what is behind it
  // (WCAG 2.1 1.4.11).
  const pinned = (n) => {
    for (; n && n.nodeType === 1; n = A.parent(n)) {
      const p = (A.cs(n) || {}).position;
      if (p === 'fixed' || p === 'sticky') return n;
    }
    return null;
  };
  const COLOR_KEY = /(^|:)(background-color|color|border-(top|bottom|left|right)-color|outline-color)$/;
  const beyondSample = (el, r, base, now, diff, inViewport) => {
    const out = { faint: A.isFaint(el) };
    if (inViewport) {
      let points = 0;
      let under = 0;
      let by = null;
      for (const fx of [0.1, 0.5, 0.9]) {
        for (const fy of [0.1, 0.5, 0.9]) {
          const x = r.left + r.width * fx;
          const y = r.top + r.height * fy;
          if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
          points++;
          const top = A.rootOf(el).elementFromPoint(x, y);
          if (!top || top === el || el.contains(top) || top.contains(el)) continue;
          const pin = pinned(top);
          if (!pin || A.contains(pin, el)) continue;
          under++;
          by = by || pin;
        }
      }
      out.obscured = points && under === points ? 'full' : under ? 'partial' : null;
      out.obscuredBy = by ? A.selector(by) : null;
    }
    if (base && diff.length) {
      const visibleOutline = (o) => o['outline-style'] !== 'none' && parseFloat(o['outline-width']) > 0 && A.parseColor(o['outline-color']).a > 0;
      const behind = A.surroundingBg ? A.surroundingBg(el) : null;
      if (visibleOutline(now) && !visibleOutline(base) && behind) {
        const ratio = A.contrast(A.blend(A.parseColor(now['outline-color']), behind), behind);
        if (ratio < 3) out.weakIndicator = { prop: 'outline-color', from: A.hex(behind), to: A.hex(A.parseColor(now['outline-color'])), ratio: +ratio.toFixed(2), against: 'the background behind it' };
      } else if (diff.every((k) => COLOR_KEY.test(k))) {
        let best = null;
        for (const k of diff) {
          const ratio = A.contrast(A.blend(A.parseColor(base[k]), behind || { r: 255, g: 255, b: 255, a: 1 }), A.blend(A.parseColor(now[k]), behind || { r: 255, g: 255, b: 255, a: 1 }));
          if (!best || ratio > best.ratio) best = { prop: k, from: A.hex(A.parseColor(base[k])), to: A.hex(A.parseColor(now[k])), ratio: +ratio.toFixed(2), against: 'its unfocused state' };
        }
        if (best && best.ratio < 3) out.weakIndicator = best;
      }
    }
    return out;
  };

  A.focusSelector = (sel) => {
    const el = A.query(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus({ preventScroll: true });
    return A.activeElement() === el;
  };

  // ---- frames ----
  // The iframes and frames of this document (shadow roots included), for the Node side to audit the
  // same-origin ones as part of the page. skip: why a frame is not audited ('hidden', 'small' under
  // 30 x 15 px, 'unexposed' when hidden from assistive technology or behind an open modal, 'blank'
  // for an about:blank frame with nothing in it), or null. sameOrigin: its document can be read.
  // label: where a frame from another origin comes from (its host). x, y: the top-left of its
  // content box in this document's coordinates, to place what is found inside it.
  A.frameCandidates = () => {
    A.frameEls = [];
    const out = [];
    for (const f of A.all('iframe, frame')) {
      let doc = null;
      try {
        doc = f.contentDocument;
      } catch {}
      const r = f.getBoundingClientRect();
      let skip = null;
      if (!A.isVisible(f)) skip = 'hidden';
      else if (r.width < 30 || r.height < 15) skip = 'small';
      else if (A.isHiddenFromAT(f)) skip = 'unexposed';
      else if (doc && doc.URL === 'about:blank' && !(doc.body && doc.body.childElementCount)) skip = 'blank';
      const src = f.getAttribute('src') || '';
      let label = 'a sandboxed frame';
      if (/^\s*data:/i.test(src)) label = 'a data: URL';
      else if (src) {
        try {
          label = new URL(src, location.href).host || src.slice(0, 60);
        } catch {
          label = src.slice(0, 60);
        }
      }
      const s = A.cs(f) || {};
      A.frameEls.push(f);
      out.push({
        i: A.frameEls.length - 1,
        selector: A.selector(f),
        sameOrigin: !!(doc && doc.documentElement),
        skip,
        label,
        x: r.left + window.scrollX + f.clientLeft + (parseFloat(s.paddingLeft) || 0),
        y: r.top + window.scrollY + f.clientTop + (parseFloat(s.paddingTop) || 0),
      });
    }
    return out;
  };
  A.scrollPosition = () => ({ x: window.scrollX, y: window.scrollY });

  // ---- disclosure activation ----
  A.disclosureCandidates = (max) => {
    const out = [];
    const sel = 'button[aria-expanded="false"], [role="button"][aria-expanded="false"], a[aria-expanded="false"][href^="#"], a[aria-expanded="false"]:not([href]), summary, button[aria-haspopup]:not([aria-expanded="true"]), [role="button"][aria-haspopup]:not([aria-expanded="true"])';
    for (const el of A.all(sel)) {
      if (out.length >= max) break;
      if (!A.isVisible(el) || A.isAriaHidden(el)) continue;
      if (el.localName === 'button' && el.form && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit') continue;
      if (el.localName === 'summary') {
        const d = el.parentElement;
        if (!d || d.localName !== 'details' || d.open) continue;
      }
      // Content fallback: a link-styled control without href has no role that is named from content,
      // but its text is what the danger filter and the messages need.
      const name = A.accName(el).name || A.nameFromContent(el, false);
      if (/sign out|log ?out|delete|remove|submit|pay|purchase|buy|send/i.test(name)) continue;
      out.push({ selector: A.selector(el), name: name.slice(0, 60), native: el.localName === 'button' || el.localName === 'summary' || el.localName === 'a' });
    }
    return out;
  };

  A.disclosureState = (sel) => {
    const el = A.query(sel);
    if (!el) return { exists: false, href: location.href };
    let expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.localName === 'summary') expanded = !!(el.parentElement && el.parentElement.open);
    const active = A.activeElement();
    const dialog = Array.from(A.all('[role="dialog"], [role="alertdialog"], dialog[open]')).find((d) => A.isVisible(d));
    const focusInDialog = !!(dialog && active && A.contains(dialog, active));
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

// Route discovery: controls that look like navigation but have no href, so the
// crawler cannot see where they lead without clicking them.
(() => {
  const A = window.__a11y508;
  // Names that suggest an action with side effects. Never clicked.
  const DANGER = /\b(delete|remove|destroy|erase|purge|log ?out|log ?off|sign ?out|submit|save|send|post|pay|purchase|buy|order|checkout|approve|reject|deny|confirm|cancel|reset|clear|archive|disable|enable|revoke|unsubscribe|terminate|transfer|upload|import|export|download|print|run|execute|apply|update|create|add|new|edit|copy|duplicate|close|dismiss|accept|decline)\b/i;
  const NAV_HINT = '[routerlink], [ng-reflect-router-link], [data-href], [data-url], [data-route], [data-link], [data-path], [role="link"], [role="menuitem"], [role="tab"], [role="treeitem"], [onclick]';
  const NAV_AREA = 'nav, [role="navigation"], header, [role="banner"], aside, [role="menu"], [role="menubar"], [role="tablist"], [role="tree"], [class*="nav" i], [class*="menu" i], [class*="sidebar" i], [class*="sidenav" i], [class*="breadcrumb" i], [class*="tab" i]';

  A.navCandidates = (max, extraSelectors) => {
    const out = [];
    const skipped = [];
    const seen = new Set();
    const consider = (el, why) => {
      if (!el || seen.has(el) || out.length >= max * 4) return;
      seen.add(el);
      if (!A.isVisible(el)) return;
      if (el.matches('a[href], area[href], input, select, textarea, option, label, [type="submit"], [disabled], [aria-disabled="true"], [aria-expanded], [aria-haspopup="dialog"]')) return;
      if (el.closest('a[href], form, [role="dialog"], dialog, [aria-hidden="true"]')) return;
      if (el.querySelector('a[href]')) return;
      const name = (A.accName(el).name || A.text(el) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!name) return;
      if (DANGER.test(name)) {
        skipped.push({ selector: A.selector(el), name, reason: 'looks like an action' });
        return;
      }
      out.push({ selector: A.selector(el), name, why });
    };
    for (const el of A.all(NAV_HINT)) consider(el, 'navigation attribute or role');
    for (const area of A.all(NAV_AREA)) {
      for (const el of area.querySelectorAll('button, [role="button"], li, span, div')) {
        if (el.localName !== 'button' && el.getAttribute('role') !== 'button') {
          const s = A.cs(el);
          if (!s || s.cursor !== 'pointer') continue;
          if (el.parentElement && A.cs(el.parentElement).cursor === 'pointer') continue;
        }
        consider(el, 'clickable control in a navigation area');
      }
    }
    for (const sel of extraSelectors || []) {
      try {
        consider(A.query(sel), 'clickable element without a link');
      } catch {}
    }
    const capped = Math.max(0, out.length - max);
    return { candidates: out.slice(0, max), skipped, capped };
  };

  A.prepareClick = (sel) => {
    let el;
    try {
      el = A.query(sel);
    } catch {
      return null;
    }
    if (!el || !A.isVisible(el)) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = A.rootOf(el).elementFromPoint(x, y);
    if (!hit || (hit !== el && !el.contains(hit))) return null; // covered by something else
    return { x, y };
  };
})();
