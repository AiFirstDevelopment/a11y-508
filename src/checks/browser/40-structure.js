// Trusted Tester 9.A (bypass), 10.A-10.D (headings, lists).
window.__a11y508.register(function structure(A) {
  const body = A.bodyFontSize();
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).filter((h) => A.isVisible(h) || A.isVisuallyHidden(h));
  const levelOf = (h) => {
    const m = /^h([1-6])$/.exec(h.localName);
    if (h.getAttribute('role') === 'heading') {
      const l = parseInt(h.getAttribute('aria-level') || '', 10);
      return Number.isNaN(l) ? 2 : l;
    }
    return m ? +m[1] : 2;
  };

  const outline = [];
  let prev = 0;
  let h1s = 0;
  for (const h of headings) {
    if (A.isAriaHidden(h)) continue;
    const lvl = levelOf(h);
    const name = A.accName(h).name;
    if (!name) {
      A.add({ test: '10.B', impact: 'serious', el: h, message: 'Heading is empty. Empty headings are announced with no content and break the outline.' });
      continue;
    }
    if (h.getAttribute('role') === 'heading' && !h.hasAttribute('aria-level')) {
      A.add({ test: '10.C', level: 'review', impact: 'minor', el: h, message: 'role="heading" without aria-level defaults to level 2. Set aria-level explicitly.' });
    }
    if (prev && lvl > prev + 1) {
      A.add({ test: '10.C', level: 'review', impact: 'moderate', el: h, message: `Heading level jumps from h${prev} to h${lvl}. Confirm the visual hierarchy matches the programmatic levels.` });
    }
    if (lvl === 1) h1s++;
    const fs = parseFloat(A.cs(h).fontSize) || body;
    if (fs < body * 0.9 && A.isVisible(h)) {
      A.add({ test: '10.C', level: 'review', impact: 'minor', el: h, message: `h${lvl} renders at ${Math.round(fs)}px, smaller than body text (${Math.round(body)}px). Confirm it is visually a heading.` });
    }
    outline.push({ level: lvl, text: name.slice(0, 120), selector: A.selector(h) });
    prev = lvl;
  }
  if (h1s > 1) A.add({ test: '10.C', level: 'review', impact: 'minor', selector: 'h1', message: `${h1s} h1 headings on the page. Confirm the structure is intentional.` });
  const pageText = A.text(document.body);
  if (!outline.length && pageText.length > 1500) {
    A.add({ test: '10.B', level: 'review', impact: 'moderate', selector: 'body', message: 'Page has substantial content but no headings. Confirm no visual headings exist that should be marked up.' });
  }
  if (outline.length) {
    A.add({ test: '10.A', level: 'review', impact: 'minor', selector: 'headings', message: `Heading outline (${outline.length}). Confirm each heading describes its section.`, details: { outline } });
  }

  // Visual headings that are not programmatic headings (10.B)
  let fakeHeadings = 0;
  const candidates = document.querySelectorAll('p, div, span, b, strong, td, dt, label, a');
  for (const el of candidates) {
    if (fakeHeadings >= 15) break;
    if (!A.isVisible(el) || A.isAriaHidden(el)) continue;
    if (el.closest('h1, h2, h3, h4, h5, h6, [role="heading"], button, nav, [role="navigation"], table, li, header, footer, [role="banner"], [role="contentinfo"], form, figure, blockquote, summary, label, a[href]')) continue;
    if (el.localName === 'a' || el.localName === 'label') continue;
    const text = A.text(el);
    if (text.length < 3 || text.length > 80 || /[.!?:;,]$/.test(text)) continue;
    if (el.children.length && Array.from(el.children).some((c) => A.cs(c).display !== 'inline')) continue;
    const s = A.cs(el);
    if (s.display === 'inline' && el.localName !== 'span' && el.localName !== 'b' && el.localName !== 'strong') continue;
    const fs = parseFloat(s.fontSize) || body;
    const bold = parseInt(s.fontWeight, 10) >= 600 || s.fontWeight === 'bold' || s.fontWeight === 'bolder';
    const big = fs >= body * 1.25;
    if (!(big && (bold || fs >= body * 1.5)) && !(bold && fs > body && s.display !== 'inline')) continue;
    // must be followed by a block of longer text
    const next = (el.localName === 'span' || el.localName === 'b' || el.localName === 'strong' ? el.parentElement : el);
    const sib = next && next.nextElementSibling;
    if (!sib || A.text(sib).length < 40) continue;
    fakeHeadings++;
    A.add({ test: '10.B', level: 'review', impact: 'moderate', el, message: `"${text.slice(0, 60)}" is styled like a heading (${Math.round(fs)}px${bold ? ', bold' : ''}) but is a <${el.localName}>. If it is a visual heading, mark it up as one.` });
  }

  // Lists (10.D)
  const renders = (c) => {
    const s = A.cs(c);
    return !!s && s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse';
  };
  for (const list of document.querySelectorAll('ul, ol')) {
    // An explicit role other than list (tablist, menu, none ...) means it is not a list to assistive technology.
    const explicit = A.explicitRole(list);
    if (explicit && explicit !== 'list') continue;
    const bad = Array.from(list.children).filter((c) => !/^(li|script|template)$/.test(c.localName) && renders(c));
    if (bad.length) A.add({ test: '10.D', impact: 'moderate', el: list, message: `<${list.localName}> has ${bad.length} direct child(ren) that are not <li> (${bad.slice(0, 3).map((c) => c.localName).join(', ')}).` });
  }
  for (const li of document.querySelectorAll('li')) {
    const p = li.parentElement;
    if (p && !/^(ul|ol|menu)$/.test(p.localName) && p.getAttribute('role') !== 'list') {
      A.add({ test: '10.D', impact: 'moderate', el: li, message: `<li> is not inside a <ul>, <ol>, or role="list" container (parent is <${p.localName}>).` });
    }
  }
  for (const l of document.querySelectorAll('[role="list"]')) {
    if (!l.querySelector('[role="listitem"]')) A.add({ test: '10.D', impact: 'moderate', el: l, message: 'role="list" contains no role="listitem" children.' });
  }
  for (const li of document.querySelectorAll('[role="listitem"]')) {
    if (!li.parentElement || !li.parentElement.closest('[role="list"], ul, ol')) A.add({ test: '10.D', impact: 'moderate', el: li, message: 'role="listitem" is not inside a role="list" container.' });
  }
  // Visually apparent lists built from text (bullet characters / numbering)
  const BULLET = /^\s*([•‣◦⁃∙▪●■○–—\-\*·→>]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,5}[.)])\s+\S/;
  let fakeLists = 0;
  const blocks = document.querySelectorAll('p, div, td, dd, section, article');
  for (const block of blocks) {
    if (fakeLists >= 10) break;
    if (!A.isVisible(block) || A.isAriaHidden(block)) continue;
    if (block.closest('ul, ol, [role="list"], pre, code, table, nav, h1, h2, h3, h4, h5, h6')) continue;
    if (block.querySelector('ul, ol, table, pre, code')) continue;
    // lines inside this block separated by <br>
    if (block.querySelector(':scope > br, :scope > span > br')) {
      const lines = (block.innerText || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
      let run = 0;
      for (const line of lines) {
        run = BULLET.test(line) ? run + 1 : 0;
        if (run >= 2) break;
      }
      if (run >= 2) {
        fakeLists++;
        A.add({ test: '10.D', impact: 'moderate', el: block, message: 'Consecutive lines start with bullet or numbering characters but are not marked up as a list. Use <ul>/<ol>.', details: { sample: lines.slice(0, 4) } });
        continue;
      }
    }
    // consecutive sibling blocks each starting with a bullet/number
    const kids = Array.from(block.children).filter((c) => /^(p|div)$/.test(c.localName) && A.isVisible(c));
    let run = 0;
    let firstEl = null;
    for (const k of kids) {
      const t = (k.innerText || A.text(k)).split('\n')[0];
      if (BULLET.test(t) && !k.querySelector('ul, ol')) {
        if (!run) firstEl = k;
        run++;
        if (run >= 2) break;
      } else run = 0;
    }
    if (run >= 2 && firstEl) {
      fakeLists++;
      A.add({ test: '10.D', impact: 'moderate', el: firstEl, message: 'Consecutive paragraphs start with bullet or numbering characters but are not marked up as a list. Use <ul>/<ol>.' });
    }
  }

  // Bypass blocks (9.A). A skip link works only if assistive technology can reach it, a sighted
  // keyboard user can see it once it has focus, and its target exists and is not hidden.
  // Technique informed by axe-core; no code taken from it.
  const linkName = (a) => A.accName(a).name || A.nameFromContent(a, true);
  const skipLinks = Array.from(document.querySelectorAll('a[href^="#"]')).filter((a) => /skip|jump|main content|to content|navigation/i.test(linkName(a)) && a.getAttribute('href').length > 1);
  const main = document.querySelector('main, [role="main"]');
  const navLinks = document.querySelectorAll('nav a[href], [role="navigation"] a[href], header a[href], [role="banner"] a[href]').length;
  // Does an author style rule for :focus, :focus-visible or :focus-within (on the link or an
  // ancestor) apply to the link and change how it is laid out or shown?
  const REVEAL = /(^|;)\s*(left|right|top|bottom|inset|position|clip|clip-path|transform|translate|width|height|max-width|max-height|margin[\w-]*|opacity|overflow|z-index|font-size|text-indent|visibility|display)\s*:/i;
  const focusReveals = (a) => {
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules && !rule.selectorText) {
          if (visit(rule.cssRules)) return true;
          continue;
        }
        if (!rule.selectorText || !/:focus/.test(rule.selectorText) || !REVEAL.test(rule.style.cssText)) continue;
        for (const sel of rule.selectorText.split(',')) {
          if (!/:focus/.test(sel)) continue;
          try {
            // A rule that hides the link only while it lacks focus (:not(:focus), as Bootstrap's
            // visually-hidden-focusable does) reveals it on focus just as a :focus rule does.
            if (a.matches(sel.replace(/:not\(\s*:focus(-visible|-within)?\s*\)/g, '').replace(/:focus(-visible|-within)?/g, '') || '*')) return true;
          } catch {}
        }
      }
      return false;
    };
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // a cross-origin sheet cannot be read
      }
      if (rules && visit(rules)) return true;
    }
    return false;
  };
  const targetOf = (a) => {
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    return { id, target: document.getElementById(id) || document.querySelector(`[name="${CSS.escape(id)}"]`) };
  };
  // Why the skip link does not work, or '' when it does. level: violation, or review when a script
  // might still reveal it.
  // While a modal dialog is open (on load, before the crawler dismisses it), everything outside it is
  // hidden from assistive technology on purpose; the run behind the modal judges the skip links.
  const modalOpen = !!A.openModal();
  const skipProblem = (a) => {
    const { id, target } = targetOf(a);
    if (!target) return { level: 'violation', message: `Skip link target "#${id}" does not exist on the page.` };
    if (!modalOpen && A.isHiddenFromAT(a)) return { level: 'violation', message: `Skip link "${linkName(a)}" is hidden from assistive technology (aria-hidden, inert, or outside an open modal), so it does not provide a way to bypass blocks.` };
    if (A.isHiddenForEveryone(a)) return { level: 'violation', message: `Skip link "${linkName(a)}" is hidden for everyone (display:none, visibility:hidden or the hidden attribute), so keyboard users can never reach it and it does not provide a way to bypass blocks. Hide it off-screen and reveal it on :focus instead.` };
    const closed = target.closest('details:not([open])');
    if (A.isHiddenForEveryone(target) || (!modalOpen && A.isHiddenFromAT(target)) || (closed && !closed.querySelector(':scope > summary')?.contains(target))) {
      return { level: 'violation', message: `Skip link target "#${id}" is hidden (${closed ? 'inside a closed <details>' : 'display:none, visibility:hidden, aria-hidden or inert'}), so following the link moves focus nowhere useful and it does not provide a way to bypass blocks.` };
    }
    if (A.isVisuallyHidden(a) && !focusReveals(a)) return { level: 'review', message: `Skip link "${linkName(a)}" is visually hidden and no :focus style reveals it, so sighted keyboard users may never see it. Confirm it becomes visible when it receives focus.` };
    return null;
  };
  const problems = skipLinks.map((a) => [a, skipProblem(a)]);
  for (const [a, p] of problems) {
    if (p) A.add({ test: '9.A', level: p.level, impact: p.level === 'violation' ? 'serious' : 'moderate', el: a, message: p.message });
  }
  // A link that may yet be revealed by a script (review) still counts as a way to bypass blocks.
  const validSkip = problems.some(([, p]) => !p || p.level === 'review');
  if (!validSkip && !main && !outline.length) {
    A.add({ test: '9.A', impact: 'serious', selector: 'body', message: 'No mechanism to bypass repetitive content: no working skip link, no <main>/role="main" landmark, and no headings.' });
  } else if (!validSkip && navLinks >= 8) {
    A.add({ test: '9.A', level: 'review', impact: 'minor', selector: 'nav', message: `${navLinks} navigation links precede the content and there is no skip link. Bypass relies on ${main ? 'landmarks' : ''}${main && outline.length ? ' and ' : ''}${outline.length ? 'headings' : ''}, which Trusted Tester accepts; confirm keyboard users can reach the main content efficiently.` });
  }
});
