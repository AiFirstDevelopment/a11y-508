// Trusted Tester 15.A (CSS generated content), 15.B (CSS positioning / reading order).
window.__a11y508.register(function cssContent(A) {
  let count = 0;
  const seenIcon = new Set();
  for (const el of A.allVisible(5000)) {
    if (count >= 15) break;
    if (A.isAriaHidden(el)) continue;
    for (const pseudo of ['::before', '::after']) {
      const s = A.cs(el, pseudo);
      if (!s) continue;
      const c = s.content;
      if (!c || c === 'none' || c === 'normal' || c === '""' || c === "''" || s.display === 'none') continue;
      if (/^(open-quote|close-quote|no-open-quote|no-close-quote)$/.test(c)) continue;
      if (/counter\(/.test(c)) continue;
      if (/url\(/.test(c)) {
        count++;
        A.add({ test: '15.A', level: 'review', impact: 'moderate', el, message: `An image is inserted with CSS ${pseudo} content. If it conveys information, provide it in text or as an <img> with alt.`, details: { content: c.slice(0, 120) } });
        continue;
      }
      if (/attr\(/.test(c)) {
        count++;
        A.add({ test: '15.A', level: 'review', impact: 'minor', el, message: `Text is inserted with CSS ${pseudo} content from an attribute (${c.slice(0, 60)}). Confirm the same information is available in the DOM text or accessible name.` });
        continue;
      }
      const text = c.replace(/^["']|["']$/g, '');
      if (!text.trim()) continue;
      const privateUse = /[-]|[\u{F0000}-\u{FFFFD}]/u.test(text);
      const words = /[\p{L}\p{N}]{2,}/u.test(text);
      if (privateUse && !words) {
        // icon font glyph
        const owner = el.closest('a[href], button, [role="button"], [role="link"], label, [aria-label], [role="img"]');
        if (owner && A.accName(owner).name) continue;
        if (A.text(el)) continue;
        const key = (el.className || '').toString().split(/\s+/).sort().join(' ');
        if (seenIcon.has(key)) continue;
        seenIcon.add(key);
        count++;
        A.add({ test: '15.A', level: 'review', impact: 'minor', el, message: `Icon-font glyph inserted via CSS ${pseudo} with no text or accessible name nearby. If the icon conveys meaning, provide a text equivalent; if decorative, add aria-hidden="true".` });
      } else if (words) {
        count++;
        A.add({ test: '15.A', level: 'review', impact: 'moderate', el, message: `Text "${text.slice(0, 60)}" is inserted with CSS ${pseudo}. Confirm the same information is available in the DOM (CSS content is not reliably read by assistive technology).` });
      }
    }
  }

  // 15.B: CSS that changes visual order relative to DOM order
  let orderCount = 0;
  const flagged = new Set();
  const sig = (el) => `${el.localName}.${(typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).sort().join('.')}`;
  const seenSig = new Map();
  for (const el of A.allVisible(5000)) {
    if (orderCount >= 10) break;
    const s = A.cs(el);
    if (!s) continue;
    const parent = el.parentElement;
    if (!parent || flagged.has(parent)) continue;
    const ps = A.cs(parent);
    const isFlexOrGrid = ps && /flex|grid/.test(ps.display);
    if (!isFlexOrGrid) continue;
    if (/-reverse$/.test(ps.flexDirection) && parent.children.length > 1) {
      flagged.add(parent);
      orderCount++;
      A.add({ test: '15.B', level: 'review', impact: 'moderate', el: parent, message: `Container uses flex-direction: ${ps.flexDirection}, so its ${parent.children.length} children display in reverse of their DOM order. Confirm the reading order (DOM) still makes sense.` });
      continue;
    }
    const order = parseInt(s.order, 10);
    if (order && order !== 0) {
      flagged.add(parent);
      const key = sig(parent) + '>' + sig(el);
      if (seenSig.has(key)) {
        seenSig.get(key).count++;
        continue;
      }
      const f = { test: '15.B', level: 'review', impact: 'moderate', el, message: `Element uses CSS order: ${order}, so its visual position differs from its DOM position. Screen readers and keyboard focus follow DOM order; confirm meaning is preserved.`, details: { occurrences: 1 } };
      seenSig.set(key, f.details);
      orderCount++;
      A.add(f);
    }
  }

  // Positioned elements with text that appear far above DOM-earlier content
  let posCount = 0;
  const textBlocks = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, dd, blockquote, figcaption, label'))
    .filter((el) => A.isVisible(el) && !A.isAriaHidden(el) && A.text(el).length > 20)
    .slice(0, 400)
    .map((el) => ({ el, top: el.getBoundingClientRect().top + window.scrollY }));
  for (let i = 1; i < textBlocks.length && posCount < 5; i++) {
    const cur = textBlocks[i];
    const prev = textBlocks[i - 1];
    if (cur.top < prev.top - 400) {
      const s = A.cs(cur.el);
      const positioned = ['absolute', 'fixed'].includes(s.position) || ['absolute', 'fixed'].includes((A.cs(cur.el.parentElement) || {}).position) || cur.el.closest('[style*="position"]');
      if (!positioned) continue;
      posCount++;
      A.add({ test: '15.B', level: 'review', impact: 'moderate', el: cur.el, message: `Content appears ${Math.round(prev.top - cur.top)}px above the content that precedes it in the DOM, due to CSS positioning. Confirm reading order without CSS still conveys the intended meaning.` });
    }
  }
});
