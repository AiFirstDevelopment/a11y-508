// Trusted Tester 6.A: links and buttons.
window.__a11y508.register(function links(A) {
  const GENERIC = /^(click here|click|here|more|read more|learn more|link|details|more details|this|this page|continue|go|view|see more|more info|info|download|open|submit|ok|next|previous|back|»|›|>|>>|\.{2,3}|…)$/i;
  const CONTEXT_SEL = 'li, p, td, th, dd, dt, figcaption, h1, h2, h3, h4, h5, h6, [role="listitem"], blockquote, caption';
  const byText = new Map();
  const norm = (href) => {
    try {
      const u = new URL(href, location.href);
      u.hash = '';
      return u.href;
    } catch {
      return href;
    }
  };

  const controls = document.querySelectorAll('a[href], [role="link"], button, [role="button"], input[type="submit"], input[type="reset"], input[type="button"], summary, [role="menuitem"], [role="tab"]');
  for (const el of controls) {
    if (!A.isVisible(el)) continue;
    if (A.isAriaHidden(el)) {
      if (A.isTabbable(el)) A.add({ test: '4.A', impact: 'serious', el, message: 'Focusable control is inside aria-hidden="true", so keyboard users reach an element assistive technology cannot see.' });
      continue;
    }
    const role = A.role(el);
    const { name } = A.accName(el);
    const isLink = role === 'link';

    if (!name) {
      const hint = el.querySelector('img[alt=""], img[role="presentation"], img[role="none"]') ? ' A decorative image (alt="") is its only content; give the image alt text that describes the destination or action.'
        : el.querySelector('img:not([alt])') ? ' It contains an image without alt text.'
        : el.querySelector('img[aria-hidden="true"], svg[aria-hidden="true"]') ? ' Its only content is hidden from assistive technology with aria-hidden.'
        : el.querySelector('svg, i, span[class*="icon"]') ? ' It appears to be an icon-only control; add aria-label or visually hidden text.' : '';
      A.add({ test: '6.A', impact: 'critical', el, message: `${isLink ? 'Link' : 'Button'} has no accessible name.${hint}` });
      continue;
    }

    const t = name.trim();
    if (GENERIC.test(t)) {
      const ctx = el.closest(CONTEXT_SEL);
      const ctxText = ctx ? A.text(ctx).replace(t, '').trim() : '';
      const desc = A.accDescription(el);
      if (ctxText.length > 10 || desc) {
        A.add({ test: '6.A', level: 'review', impact: 'moderate', el, message: `Generic ${isLink ? 'link' : 'button'} text "${t}". Confirm the enclosing ${ctx ? ctx.localName : 'context'} makes its purpose clear.`, details: { context: ctxText.slice(0, 200), description: desc } });
      } else {
        A.add({ test: '6.A', impact: 'serious', el, message: `Generic ${isLink ? 'link' : 'button'} text "${t}" with no programmatic context to explain its purpose.` });
      }
    } else if (/^(https?:\/\/|www\.)\S+$/i.test(t) && t.length > 30) {
      A.add({ test: '6.A', level: 'review', impact: 'minor', el, message: 'A raw URL is used as the link text. Confirm it is understandable when read aloud.' });
    }

    if (isLink && el.localName === 'a') {
      const href = el.getAttribute('href') || '';
      if ((href === '#' || /^javascript:/i.test(href)) && !el.getAttribute('role')) {
        A.add({ test: '6.A', level: 'review', impact: 'minor', el, message: `Link with href="${href}" acts as a button. Prefer a <button>, or add role="button" so its purpose is announced correctly.` });
      }
      if (!GENERIC.test(t)) {
        const key = t.toLowerCase();
        if (!byText.has(key)) byText.set(key, new Map());
        const m = byText.get(key);
        const h = norm(href);
        if (!m.has(h)) m.set(h, el);
      }
    }
  }

  let dupCount = 0;
  for (const [text, hrefs] of byText) {
    if (hrefs.size < 2 || dupCount >= 15) continue;
    dupCount++;
    const first = hrefs.values().next().value;
    A.add({ test: '6.A', level: 'review', impact: 'moderate', el: first, message: `Link text "${text}" points to ${hrefs.size} different destinations on this page. Confirm context distinguishes them.`, details: { destinations: Array.from(hrefs.keys()).slice(0, 10) } });
  }

  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')) {
    if (!A.isVisible(el)) continue;
    if (!A.accName(el).name) A.add({ test: '5.C', impact: 'moderate', el, message: 'Dialog has no accessible name (aria-label or aria-labelledby).' });
  }
});
