// Trusted Tester 13.A (color alone), 13.B (sensory characteristics), 13.C (contrast).
// Contrast technique informed by axe-core and IBM Equal Access (line boxes, bounded backgrounds,
// gradient stops, text shadows); implemented from WCAG's definitions, no code taken from either.
window.__a11y508.register(function sensoryContrast(A) {
  const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const BLACK = { r: 0, g: 0, b: 0, a: 1 };
  const fmt = (r) => r.toFixed(2);

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

  // The nodes painted at (x, y), front to back, starting with el; null when el is not hit there.
  const chainAt = (el, x, y) => {
    let stack = null;
    try {
      stack = document.elementsFromPoint(x, y);
    } catch {}
    if (!stack || !stack.includes(el)) return null;
    const chain = stack.slice(stack.indexOf(el));
    const end = chain.indexOf(document.documentElement);
    if (end >= 0) chain.length = end + 1;
    return chain;
  };
  // Only for a line the hit test cannot reach even in view (covered by another element).
  const domChain = (el) => {
    const chain = [];
    for (let p = el; p; p = p.parentElement) chain.push(p);
    return chain;
  };

  // Background images in the chain whose colors are unknown: a url() image is bounded by white and
  // black; a gradient by its color stops and the midpoint of each adjacent pair.
  const gradientStops = (bi) => {
    const stops = (bi.match(/rgba?\([^)]*\)/g) || []).map((c) => A.parseColor(c));
    const out = [...stops];
    for (let i = 1; i < stops.length; i++) {
      const p = stops[i - 1];
      const q = stops[i];
      out.push({ r: (p.r + q.r) / 2, g: (p.g + q.g) / 2, b: (p.b + q.b) / 2, a: (p.a + q.a) / 2 });
    }
    return out;
  };
  const unknownLayers = (chain) => {
    const out = [];
    for (const n of chain) {
      const s = A.cs(n);
      const bi = s && s.backgroundImage;
      if (!bi || bi === 'none') continue;
      const stops = /url\(/.test(bi) ? [] : gradientStops(bi);
      out.push(stops.length ? { node: n, kind: 'gradient', candidates: stops } : { node: n, kind: 'image', candidates: [WHITE, BLACK] });
      if (out.length >= 2) break;
    }
    return out;
  };
  // Every combination of candidate colors, one per unknown layer: Map node -> color.
  const scenarios = (layers) => {
    let out = [new Map()];
    for (const l of layers) {
      const next = [];
      for (const m of out) for (const c of l.candidates) next.push(new Map(m).set(l.node, c));
      out = next.slice(0, 64);
    }
    return out;
  };

  // Flattens the paint chain front to back into one color over white. top is the text color (or
  // null for the background alone). A group's opacity is applied once, when the walk leaves it.
  // pick maps a node with a background image to the color assumed for that image.
  const flatten = (chain, top, pick) => {
    let acc = top || TRANSPARENT;
    let open = groupsOf(chain[0]);
    const over = (front, back) => (front.a === 0 ? back : A.blend(front, back));
    for (const n of chain) {
      while (open.length && !open[0].contains(n)) {
        acc = { ...acc, a: acc.a * opacityOf(open[0]) };
        open = open.slice(1);
      }
      const s = A.cs(n);
      if (!s) continue;
      const layers = [];
      if (pick && pick.has(n)) layers.push(pick.get(n));
      const bg = A.parseColor(s.backgroundColor);
      if (bg.a > 0) layers.push(bg);
      for (let c of layers) {
        // Groups around n that the text is not in (a translucent layer behind it): their opacity applies to n alone.
        for (const g of groupsOf(n)) if (!open.includes(g)) c = { ...c, a: c.a * opacityOf(g) };
        acc = over(acc, c);
      }
      if (acc.a >= 0.999 && !open.length) break;
    }
    for (const g of open) acc = { ...acc, a: acc.a * opacityOf(g) };
    return acc.a < 0.999 ? A.blend(acc, WHITE) : acc;
  };

  // text-shadow: [{ color, blur, css }]. Chrome computes it as "rgb(0, 0, 0) 1px 1px 2px, ...".
  const shadowsOf = (s) => {
    const v = s.textShadow;
    if (!v || v === 'none') return [];
    return v.split(/,(?![^(]*\))/).map((part) => {
      const color = (part.match(/rgba?\([^)]*\)/) || [])[0];
      const lengths = part.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px/g) || [];
      return { color: color ? A.parseColor(color) : null, blur: parseFloat(lengths[2]) || 0, css: part.trim() };
    }).filter((x) => x.color && x.color.a > 0);
  };

  // Scrolling: everything sampled is brought into view first, and every scroll position is put back.
  const sx0 = window.scrollX;
  const sy0 = window.scrollY;
  const scrolled = new Map();
  const inView = (r) => r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  // Centres el by setting scroll offsets, its scrolling ancestors' and then the window's. Not
  // el.scrollIntoView(): in Chrome that moves the sequential focus navigation starting point, and
  // the keyboard pass that follows would start tabbing from the last element sampled.
  const bringIntoView = (el) => {
    if (inView(el.getBoundingClientRect())) return;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (p.scrollHeight <= p.clientHeight && p.scrollWidth <= p.clientWidth) continue;
      const ps = A.cs(p);
      if (!ps || !/auto|scroll|hidden/.test(`${ps.overflowX} ${ps.overflowY}`)) continue;
      const pr = p.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top >= pr.top && r.bottom <= pr.bottom && r.left >= pr.left && r.right <= pr.right) continue;
      if (!scrolled.has(p)) scrolled.set(p, [p.scrollLeft, p.scrollTop]);
      p.scrollTop += r.top + r.height / 2 - (pr.top + pr.height / 2);
      if (r.right <= pr.left || r.left >= pr.right) p.scrollLeft += r.left - pr.left;
    }
    const r = el.getBoundingClientRect();
    if (inView(r)) return;
    window.scrollBy({ top: r.top + r.height / 2 - window.innerHeight / 2, left: r.right <= 0 || r.left >= window.innerWidth ? r.left : 0, behavior: 'instant' });
  };
  // Hit testing skips pointer-events:none, so an overlay or a background drawn by such an element
  // would be missed: while sampling, every element is hit-testable (a style sheet outside the DOM).
  let hitSheet = null;
  try {
    hitSheet = new CSSStyleSheet();
    hitSheet.replaceSync('*, *::before, *::after { pointer-events: auto !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, hitSheet];
  } catch {
    hitSheet = null;
  }
  const restoreScroll = () => {
    if (hitSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== hitSheet);
    for (const [p, [l, t]] of scrolled) {
      p.scrollLeft = l;
      p.scrollTop = t;
    }
    window.scrollTo({ left: sx0, top: sy0, behavior: 'instant' });
  };

  // The line boxes of el's own text, merged per line, top to bottom: { sample } is the widest
  // fragment on the line, the one sampled.
  const lineBoxes = (el) => {
    const lines = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        const ln = lines.find((l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > Math.min(l.bottom - l.top, r.height) / 2);
        if (!ln) lines.push({ top: r.top, bottom: r.bottom, sample: r });
        else {
          ln.top = Math.min(ln.top, r.top);
          ln.bottom = Math.max(ln.bottom, r.bottom);
          if (r.width > ln.sample.width) ln.sample = r;
        }
      }
    }
    return lines.sort((a, b) => a.top - b.top).slice(0, 50);
  };

  // Samples one point: the paint stack there, every unknown background bounded, a stroke-like
  // shadow counted. Returns { kind, min, max, white, black }: kind is solid, image or gradient.
  const sample = (el, fg, x, y, stroke) => {
    const chain = chainAt(el, Math.min(Math.max(x, 0), window.innerWidth - 1), Math.min(Math.max(y, 0), window.innerHeight - 1)) || domChain(el);
    const layers = unknownLayers(chain);
    const results = scenarios(layers).map((pick) => {
      const bg = flatten(chain, null, pick);
      const fgFlat = flatten(chain, fg, pick);
      let ratio = A.contrast(fgFlat, bg);
      if (stroke) {
        // A thin shadow on the far side of the text color outlines the glyphs: the best of
        // text over background, text over outline, and outline over background.
        const sh = flatten(chain, stroke, pick);
        const lt = A.luminance(fgFlat);
        if (lt > A.luminance(bg) ? A.luminance(sh) < lt : A.luminance(sh) > lt) ratio = Math.max(ratio, A.contrast(fgFlat, sh), A.contrast(sh, bg));
      }
      return { ratio, fg: fgFlat, bg, pick };
    });
    let min = results[0];
    let max = results[0];
    for (const r of results) {
      if (r.ratio < min.ratio) min = r;
      if (r.ratio > max.ratio) max = r;
    }
    const varies = max.ratio - min.ratio >= 0.005;
    const kind = !varies ? 'solid' : layers.some((l) => l.kind === 'image') ? 'image' : 'gradient';
    const bound = (c) => results.find((r) => layers.every((l) => l.kind !== 'image' || r.pick.get(l.node) === c)) || min;
    return { kind, min, max, white: bound(WHITE), black: bound(BLACK) };
  };

  // Decides the outcome of a set of samples (one per line, or one for a control). Returns null
  // when the text passes, else { level, kind, ... } for the caller's message.
  const decide = (samples, need) => {
    const pass = (r) => r.ratio + 0.005 >= need;
    const mixedImage = samples.find((s) => s.kind === 'image' && pass(s.max) && !pass(s.min));
    if (mixedImage) return { level: 'review', kind: 'image', s: mixedImage };
    const gradient = samples.filter((s) => s.kind === 'gradient' && !pass(s.min));
    if (gradient.length) return { level: 'review', kind: 'gradient', s: gradient.reduce((a, b) => (b.min.ratio < a.min.ratio ? b : a)) };
    const failing = samples.filter((s) => !pass(s.min));
    if (!failing.length) return null;
    const worst = failing.reduce((a, b) => (b.min.ratio < a.min.ratio ? b : a));
    if (failing.length < samples.length) {
      const best = samples.filter((s) => pass(s.min)).reduce((a, b) => (b.min.ratio > a.min.ratio ? b : a));
      return { level: 'review', kind: 'lines', s: worst, line: samples.indexOf(worst) + 1, of: samples.length, best, bestLine: samples.indexOf(best) + 1 };
    }
    return { level: 'violation', kind: failing.some((s) => s.kind === 'image') ? 'image' : 'solid', s: worst };
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
  const isDisabled = (el) => el.matches('[disabled], [aria-disabled="true"], :disabled') || !!el.closest('[disabled], [aria-disabled="true"], fieldset:disabled');

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

  const textColor = (s) => {
    const fill = s.webkitTextFillColor;
    return fill && fill !== s.color && !/currentcolor/i.test(fill) ? A.parseColor(fill) : A.parseColor(s.color);
  };
  const thresholds = (s) => {
    const size = parseFloat(s.fontSize) || 16;
    const weight = parseInt(s.fontWeight, 10) || (s.fontWeight === 'bold' ? 700 : 400);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    return { size, weight, need: large ? 3 : 4.5 };
  };
  const detailsOf = (d, t, text) => {
    const w = d.s.min;
    const out = { ratio: +w.ratio.toFixed(2), required: t.need, foreground: A.hex(w.fg), background: A.hex(w.bg), fontSize: t.size, fontWeight: t.weight, text };
    if (d.kind === 'image') out.bounds = { white: +d.s.white.ratio.toFixed(2), black: +d.s.black.ratio.toFixed(2) };
    if (d.kind === 'lines') out.lines = { failing: d.line, passing: d.bestLine, of: d.of, passingRatio: +d.best.min.ratio.toFixed(2), passingBackground: A.hex(d.best.min.bg) };
    return out;
  };
  // Messages for the outcomes decide() can return, for text (who = 'Text') and form controls.
  const imageMessage = (who, d, t) => d.level === 'violation'
    ? `${who} over a background image fails ${t.need}:1 over any background: ${fmt(d.s.white.ratio)}:1 if the image is white, ${fmt(d.s.black.ratio)}:1 if it is black (${A.hex(d.s.min.fg)}).`
    : `${who} over a background image has contrast between ${fmt(d.s.min.ratio)}:1 and ${fmt(d.s.max.ratio)}:1 depending on the image (${fmt(d.s.white.ratio)}:1 if it is white, ${fmt(d.s.black.ratio)}:1 if it is black); it needs ${t.need}:1. Check it visually.`;
  const gradientMessage = (who, d, t) => `${who} over a gradient has contrast ${fmt(d.s.min.ratio)}:1 at the gradient's worst point (${A.hex(d.s.min.fg)} on ${A.hex(d.s.min.bg)}), below ${t.need}:1. Check it visually.`;

  let count = 0;
  let checked = 0;
  try {
    for (const el of A.allVisible(6000)) {
      if (count >= 100) break;
      if (!hasOwnText(el)) continue;
      if (el.closest('option, script, style, textarea') || A.isHiddenFromAT(el)) continue;
      if (A.isVisuallyHidden(el)) continue;
      if (isDisabled(el)) continue;
      if (labelsDisabled(el)) continue;
      const s = A.cs(el);
      if (!s) continue;
      const fg = textColor(s);
      if (fg.a === 0) continue;
      const t = thresholds(s);
      const shadows = shadowsOf(s);
      const stroke = shadows.find((x) => x.blur <= 0.1 * t.size);
      const halo = shadows.find((x) => x !== stroke && x.blur >= 0.2 * t.size);
      bringIntoView(el);
      let lines = lineBoxes(el);
      if (!lines.length) continue;
      const samples = [];
      for (let i = 0; i < lines.length; i++) {
        let r = lines[i].sample;
        if (r.bottom <= 0 || r.top >= window.innerHeight) {
          // A line of a long element outside the viewport: centre it, then measure again.
          window.scrollBy({ top: r.top + r.height / 2 - window.innerHeight / 2, behavior: 'instant' });
          lines = lineBoxes(el);
          if (!lines[i]) break;
          r = lines[i].sample;
        }
        samples.push(sample(el, fg, r.left + r.width / 2, r.top + r.height / 2, stroke && stroke.color));
      }
      if (!samples.length) continue;
      checked++;
      const d = decide(samples, t.need);
      if (!d) continue;
      count++;
      const text = A.text(el).slice(0, 80);
      const details = detailsOf(d, t, text);
      const w = d.s.min;
      const measured = `${fmt(w.ratio)}:1, ${A.hex(w.fg)} on ${A.hex(w.bg)}`;
      if (d.kind === 'image') {
        A.add({ test: '13.C', level: d.level, impact: d.level === 'violation' ? 'serious' : 'moderate', el, message: imageMessage('Text', d, t), details });
        continue;
      }
      if (d.kind === 'gradient') {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: gradientMessage('Text', d, t), details });
        continue;
      }
      if (d.kind === 'lines') {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Text contrast differs between its lines: line ${d.line} of ${d.of} is ${measured}, below ${t.need}:1, while line ${d.bestLine} is ${fmt(d.best.min.ratio)}:1 on ${A.hex(d.best.min.bg)}. Part of the text sits over a different background; check it visually.`, details });
        continue;
      }
      const pseudo = pseudoBackground(el);
      const own = ownText(el);
      if (pseudo) {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Text sits over an absolutely positioned ${pseudo.pseudo} background covering ${pseudo.percent}% of the element, so its contrast could not be measured (computed ${measured} without it). Check it visually.`, details });
      } else if (w.ratio < 1.005) {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Text and background resolve to the same color (1:1, ${A.hex(w.fg)}). This is usually hidden text or a background the check cannot see; check it visually.`, details });
      } else if (Array.from(own).length === 1) {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Single-character text "${own}" has contrast ${measured}, below ${t.need}:1. Single characters are often icons; confirm whether it conveys information and check it visually.`, details });
      } else if (halo) {
        A.add({ test: '13.C', level: 'review', impact: 'moderate', el, message: `Text contrast ${fmt(w.ratio)}:1 is below ${t.need}:1 (${A.hex(w.fg)} on ${A.hex(w.bg)}) without its text shadow (text-shadow: ${halo.css}), which may make it readable. Check it visually.`, details: { ...details, shadow: halo.css } });
      } else {
        A.add({
          test: '13.C', impact: w.ratio < t.need - 1.5 ? 'serious' : 'moderate', el,
          message: `Text contrast ${fmt(w.ratio)}:1 is below ${t.need}:1 (${Math.round(t.size)}px${t.weight >= 700 ? ' bold' : ''}, ${A.hex(w.fg)} on ${A.hex(w.bg)}).`,
          details,
        });
      }
    }

    // Form text: the value shown in a text field, textarea or select, and placeholder text,
    // each against the control's own background. Disabled controls are exempt.
    let formCount = 0;
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (formCount >= 30) break;
      const type = el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
      if (el.localName === 'input' && !/^(text|search|email|tel|url|number|password)$/.test(type)) continue;
      if (!A.isVisible(el) || A.isHiddenFromAT(el) || A.isVisuallyHidden(el) || isDisabled(el)) continue;
      const s = A.cs(el);
      if (!s) continue;
      const value = el.localName === 'select' ? Array.from(el.selectedOptions || []).map((o) => A.text(o)).join(' ') : el.value || '';
      const placeholder = el.localName !== 'select' && !value ? (el.getAttribute('placeholder') || '').trim() : '';
      if (!value.trim() && !placeholder) continue;
      const ps = placeholder ? A.cs(el, '::placeholder') : null;
      const fg = placeholder ? A.parseColor(ps ? ps.color : s.color) : textColor(s);
      if (fg.a === 0) continue;
      const t = thresholds(ps || s);
      bringIntoView(el);
      const r = el.getBoundingClientRect();
      const d = decide([sample(el, fg, r.left + r.width / 2, r.top + r.height / 2, null)], t.need);
      checked++;
      if (!d) continue;
      formCount++;
      const who = placeholder ? `Placeholder text "${placeholder.slice(0, 60)}"` : 'Text in this field';
      const details = detailsOf(d, t, placeholder ? placeholder.slice(0, 80) : undefined);
      const w = d.s.min;
      let message;
      if (d.kind === 'image') message = imageMessage(who, d, t);
      else if (d.kind === 'gradient') message = gradientMessage(who, d, t);
      else message = `${who} has contrast ${fmt(w.ratio)}:1, below ${t.need}:1 (${Math.round(t.size)}px${t.weight >= 700 ? ' bold' : ''}, ${A.hex(w.fg)} on ${A.hex(w.bg)}).`;
      A.add({ test: '13.C', level: d.level, impact: d.level === 'violation' && w.ratio < t.need - 1.5 ? 'serious' : 'moderate', el, message, details });
    }
  } finally {
    restoreScroll();
  }
  A.meta.contrastChecked = checked;

  // 13.A: links distinguished from surrounding text by color alone (WCAG F73 / G183). The
  // surrounding text is the text of the link's nearest block-level ancestor outside links and
  // widgets, and there must be more of it than link text (technique informed by axe-core).
  const isBlock = (n) => {
    const d = (A.cs(n) || {}).display || '';
    return !!d && d !== 'none' && d !== 'contents' && !/^inline/.test(d);
  };
  const WIDGET = 'a[href], button, input, select, textarea, script, style, template';
  const blockTexts = new Map();
  const blockText = (block) => {
    if (blockTexts.has(block)) return blockTexts.get(block);
    let text = '';
    let colorEl = null;
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          if (c.nodeValue.trim()) {
            text += c.nodeValue;
            if (!colorEl) colorEl = n;
          }
          continue;
        }
        if (c.nodeType !== 1 || c.matches(WIDGET) || A.INTERACTIVE_ROLES.has(A.role(c))) continue;
        if (!A.isVisible(c) || isBlock(c)) continue;
        walk(c);
      }
    };
    walk(block);
    const out = { text: text.replace(/\s+/g, ' ').trim(), colorEl };
    blockTexts.set(block, out);
    return out;
  };
  const decorated = (x) => /underline|overline|line-through/.test(x.textDecorationLine || x.textDecoration || '');
  let linkCount = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    if (linkCount >= 20) break;
    if (!A.isVisible(a) || A.isAriaHidden(a)) continue;
    const parent = a.parentElement;
    if (!parent || parent.closest('nav, [role="navigation"], header, footer, [role="banner"], [role="contentinfo"], ul.menu, .menu, .nav, button')) continue;
    if (a.querySelector('img, svg')) continue;
    let block = parent;
    while (block.parentElement && block !== document.body && !isBlock(block)) block = block.parentElement;
    const { text, colorEl } = blockText(block);
    if (!colorEl || text.length <= A.text(a).length) continue;
    const sa = A.cs(a);
    const st = A.cs(colorEl);
    const sb = A.cs(block);
    if (!sa || !st || !sb) continue;
    // Non-color cues: a text decoration, a bottom border, a different weight, style or size, a background.
    if (decorated(sa) || Array.from(a.children).some((c) => decorated(A.cs(c) || {}))) continue;
    if (parseFloat(sa.borderBottomWidth) > 0 && sa.borderBottomStyle !== 'none') continue;
    if (sa.fontWeight !== st.fontWeight || sa.fontStyle !== st.fontStyle || sa.fontSize !== st.fontSize) continue;
    if (A.parseColor(sa.backgroundColor).a > 0 && sa.backgroundColor !== sb.backgroundColor) continue;
    if (sa.color === st.color) continue;
    const linkVsText = A.contrast(A.parseColor(sa.color), A.parseColor(st.color));
    if (linkVsText >= 3) continue;
    linkCount++;
    A.add({ test: '13.A', impact: 'moderate', el: a, message: `Inline link is distinguished from surrounding text only by color, and the link/text contrast is ${linkVsText.toFixed(1)}:1 (below 3:1). Add an underline or another non-color cue.` });
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
