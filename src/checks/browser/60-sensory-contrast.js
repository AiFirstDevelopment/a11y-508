// Trusted Tester 13.A (color alone), 13.B (sensory characteristics), 13.C (contrast).
window.__a11y508.register(function sensoryContrast(A) {
  const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

  // The nodes painted at a point inside the element, front to back, starting with the element.
  const paintChain = (el) => {
    const r = el.getBoundingClientRect();
    const cx = Math.min(Math.max(r.left + Math.min(r.width / 2, 8), 0), window.innerWidth - 1);
    const cy = Math.min(Math.max(r.top + Math.min(r.height / 2, 8), 0), window.innerHeight - 1);
    let stack = null;
    if (r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0) {
      try {
        stack = document.elementsFromPoint(cx, cy);
      } catch {}
    }
    const chain = [el];
    if (stack && stack.length && stack.includes(el)) {
      for (const n of stack.slice(stack.indexOf(el) + 1)) chain.push(n);
    } else {
      let p = el.parentElement;
      while (p) {
        chain.push(p);
        p = p.parentElement;
      }
    }
    const end = chain.indexOf(document.documentElement);
    if (end >= 0) chain.length = end + 1;
    return chain;
  };

  const opacityOf = (n) => {
    const o = parseFloat((A.cs(n) || {}).opacity);
    return Number.isNaN(o) ? 1 : o;
  };
  // Elements with opacity < 1 that contain n (itself included), innermost first. Each is an opacity group:
  // its content is composited at full alpha, then the group is painted once at its opacity.
  const groupsOf = (n) => {
    const out = [];
    for (let p = n; p && p.nodeType === 1; p = p.parentElement) if (opacityOf(p) < 1) out.push(p);
    return out;
  };

  // Flattens the paint chain front to back into one color over white. top is the text color (or
  // null for the background alone). A group's opacity is applied once, when the walk leaves it.
  // uncertain is true when an image/gradient is painted above the first opaque layer.
  const flatten = (chain, top) => {
    let acc = top || TRANSPARENT;
    let uncertain = false;
    let open = groupsOf(chain[0]);
    const over = (front, back) => (front.a === 0 ? back : A.blend(front, back));
    for (const n of chain) {
      while (open.length && !open[0].contains(n)) {
        acc = { ...acc, a: acc.a * opacityOf(open[0]) };
        open = open.slice(1);
      }
      const s = A.cs(n);
      if (!s) continue;
      if (s.backgroundImage && s.backgroundImage !== 'none') uncertain = true;
      let c = A.parseColor(s.backgroundColor);
      if (c.a > 0) {
        // Groups around n that the text is not in (a translucent layer behind it): their opacity applies to n alone.
        for (const g of groupsOf(n)) if (!open.includes(g)) c = { ...c, a: c.a * opacityOf(g) };
        acc = over(acc, c);
      }
      if (acc.a >= 0.999 && !open.length) break;
    }
    for (const g of open) acc = { ...acc, a: acc.a * opacityOf(g) };
    return { color: acc.a < 0.999 ? A.blend(acc, { r: 255, g: 255, b: 255, a: 1 }) : acc, uncertain };
  };

  const hasOwnText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim().length > 0) return true;
    return false;
  };
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  };

  // Inactive components are exempt (WCAG 1.4.3): labels of disabled controls, and text that names one.
  const disabledControl = (c) => !!c && (c.matches(':disabled') || c.getAttribute('aria-disabled') === 'true');
  const namesDisabled = new Set();
  for (const c of document.querySelectorAll('[aria-labelledby]')) {
    if (!disabledControl(c)) continue;
    for (const id of c.getAttribute('aria-labelledby').split(/\s+/)) {
      const t = id && document.getElementById(id);
      if (t) namesDisabled.add(t);
    }
  }
  const labelsDisabled = (el) => {
    const label = el.closest('label');
    if (label && disabledControl(label.control)) return true;
    for (let p = el; p; p = p.parentElement) if (namesDisabled.has(p)) return true;
    return false;
  };

  // An absolutely positioned ::before/::after with a background behind 25% or more of the element:
  // the real background is the pseudo-element, which the paint chain cannot see.
  const pseudoBackground = (el) => {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (!area) return null;
    for (const p of ['::before', '::after']) {
      const ps = A.cs(el, p);
      if (!ps || !ps.content || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
      if (ps.position !== 'absolute' && ps.position !== 'fixed') continue;
      if (A.parseColor(ps.backgroundColor).a === 0 && (!ps.backgroundImage || ps.backgroundImage === 'none')) continue;
      const covered = (parseFloat(ps.width) || 0) * (parseFloat(ps.height) || 0);
      if (covered >= area * 0.25) return { pseudo: p, percent: Math.min(100, Math.round((covered / area) * 100)) };
    }
    return null;
  };

  let count = 0;
  let uncertainList = [];
  let checked = 0;
  for (const el of A.allVisible(6000)) {
    if (count >= 100) break;
    if (!hasOwnText(el)) continue;
    if (el.closest('option, script, style') || A.isHiddenFromAT(el)) continue;
    if (A.isVisuallyHidden(el)) continue;
    if (el.matches('[disabled], [aria-disabled="true"], :disabled') || el.closest('[disabled], [aria-disabled="true"], fieldset:disabled')) continue;
    if (labelsDisabled(el)) continue;
    const s = A.cs(el);
    if (!s) continue;
    let fg = A.parseColor(s.color);
    const fill = s.webkitTextFillColor;
    if (fill && fill !== s.color && !/currentcolor/i.test(fill)) fg = A.parseColor(fill);
    if (fg.a === 0) continue;
    const chain = paintChain(el);
    const { color: bg, uncertain } = flatten(chain, null);
    checked++;
    if (uncertain) {
      if (uncertainList.length < 15) uncertainList.push({ selector: A.selector(el), text: A.text(el).slice(0, 60) });
      continue;
    }
    const fgFlat = flatten(chain, fg).color;
    const ratio = A.contrast(fgFlat, bg);
    const size = parseFloat(s.fontSize) || 16;
    const weight = parseInt(s.fontWeight, 10) || (s.fontWeight === 'bold' ? 700 : 400);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    if (ratio + 0.005 < need) {
      count++;
      const details = { ratio: +ratio.toFixed(2), required: need, foreground: A.hex(fgFlat), background: A.hex(bg), fontSize: size, fontWeight: weight, text: A.text(el).slice(0, 80) };
      const measured = `${ratio.toFixed(2)}:1, ${A.hex(fgFlat)} on ${A.hex(bg)}`;
      const pseudo = pseudoBackground(el);
      const own = ownText(el);
      if (pseudo) {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Text sits over an absolutely positioned ${pseudo.pseudo} background covering ${pseudo.percent}% of the element, so its contrast could not be measured (computed ${measured} without it). Check it visually.`, details });
      } else if (ratio < 1.005) {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Text and background resolve to the same color (1:1, ${A.hex(fgFlat)}). This is usually hidden text or a background the check cannot see; check it visually.`, details });
      } else if (Array.from(own).length === 1) {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Single-character text "${own}" has contrast ${measured}, below ${need}:1. Single characters are often icons; confirm whether it conveys information and check it visually.`, details });
      } else {
        A.add({
          test: '13.C', impact: ratio < need - 1.5 ? 'serious' : 'moderate', el,
          message: `Text contrast ${ratio.toFixed(2)}:1 is below ${need}:1 (${Math.round(size)}px${weight >= 700 ? ' bold' : ''}, ${A.hex(fgFlat)} on ${A.hex(bg)}).`,
          details,
        });
      }
    }
  }
  if (uncertainList.length) {
    A.add({ test: '13.C', level: 'review', impact: 'moderate', selector: 'text over images', message: `${uncertainList.length}${uncertainList.length >= 15 ? '+' : ''} text element(s) sit on a background image or gradient; contrast could not be computed. Check them visually.`, details: { elements: uncertainList } });
  }
  A.meta.contrastChecked = checked;

  // 13.A: links distinguished from surrounding text by color alone (WCAG F73 / G183)
  let linkCount = 0;
  for (const a of document.querySelectorAll('p a[href], li a[href], td a[href], dd a[href], span a[href], div a[href], label a[href]')) {
    if (linkCount >= 20) break;
    if (!A.isVisible(a) || A.isAriaHidden(a)) continue;
    const parent = a.parentElement;
    if (!parent || parent.closest('nav, [role="navigation"], header, footer, [role="banner"], [role="contentinfo"], ul.menu, .menu, .nav, button')) continue;
    // surrounding text must exist in the same parent
    let surrounding = '';
    for (const n of parent.childNodes) if (n.nodeType === 3) surrounding += n.nodeValue;
    if (surrounding.trim().length < 15) continue;
    const sa = A.cs(a);
    const sp = A.cs(parent);
    const deco = (sa.textDecorationLine || sa.textDecoration || '').includes('underline') || Array.from(a.children).some((c) => (A.cs(c).textDecorationLine || '').includes('underline'));
    if (deco) continue;
    const borderB = parseFloat(sa.borderBottomWidth) > 0 && sa.borderBottomStyle !== 'none';
    if (borderB) continue;
    if (sa.backgroundColor !== sp.backgroundColor && A.parseColor(sa.backgroundColor).a > 0) continue;
    if (sa.fontWeight !== sp.fontWeight || sa.fontStyle !== sp.fontStyle || sa.fontSize !== sp.fontSize) continue;
    if (sa.color === sp.color) continue;
    if (a.querySelector('img, svg')) continue;
    linkCount++;
    const linkVsText = A.contrast(A.parseColor(sa.color), A.parseColor(sp.color));
    if (linkVsText >= 3) {
      A.add({ test: '13.A', level: 'review', impact: 'moderate', el: a, message: `Inline link is distinguished from surrounding text only by color (link/text contrast ${linkVsText.toFixed(1)}:1). Acceptable only if an additional cue appears on hover and focus (WCAG G183). Confirm.` });
    } else {
      A.add({ test: '13.A', impact: 'moderate', el: a, message: `Inline link is distinguished from surrounding text only by color, and the link/text contrast is ${linkVsText.toFixed(1)}:1 (below 3:1). Add an underline or another non-color cue.` });
    }
  }

  // 13.B: instructions that rely on sensory characteristics
  const SENSORY = /\b(?:(?:click|press|select|use|choose|see|find|tap)\s+(?:on\s+)?the\s+(?:(?:red|green|blue|yellow|orange|purple|grey|gray|black|white|round|square|circular|rectangular|small|large|big|wide|narrow)\s+)+(?:button|link|icon|box|arrow|tab|menu|item)|(?:button|link|icon|box|menu|arrow|field|image|section|column|sidebar|panel)\s+(?:on|to|at|in)\s+the\s+(?:left|right|top|bottom)\b|(?:on|to|in|at)\s+the\s+(?:left|right)[-\s](?:hand\s+)?(?:side|column|corner|menu|panel|sidebar)|(?:the\s+(?:left|right)\s+(?:button|link|icon|arrow|column|menu))|when you hear\b|\bbeep\b)/i;
  let sensoryCount = 0;
  for (const el of document.querySelectorAll('p, li, td, dd, label, legend, figcaption, h1, h2, h3, h4, h5, h6, span, div, caption')) {
    if (sensoryCount >= 10) break;
    if (!hasOwnText(el) || !A.isVisible(el) || A.isAriaHidden(el)) continue;
    let own = '';
    if (/^(p|li|td|dd|label|legend|figcaption|h[1-6]|caption)$/.test(el.localName)) own = A.text(el);
    else for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue + ' ';
    const m = SENSORY.exec(own);
    if (!m) continue;
    sensoryCount++;
    const idx = Math.max(0, m.index - 60);
    A.add({ test: '13.B', level: 'review', impact: 'moderate', el, message: `Instruction may rely on a sensory characteristic: "…${own.slice(idx, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim()}…". Confirm the referenced control is also identified by name or text.` });
  }
});
