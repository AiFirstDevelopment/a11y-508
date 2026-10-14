// Interactive passes that run after the static in-page checks:
// event-listener probe (4.A, 5.D), keyboard tab-through (4.C, 4.D, 4.E, 4.F),
// disclosure activation (4.A, 4.G, 4.H + re-check of revealed content), 200% zoom (18.A);
// with the beyond-508 profile (--wcag 2.1 / 2.2), text spacing (1.4.12) and reflow at 320 px (1.4.10),
// and in the Tab pass, focus not obscured (2.4.11) and focus indicator contrast (1.4.11).

import { sleep } from './page.mjs';
import { discoverFrames, inFrame } from './frames.mjs';

const CLICKY = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick']);

export async function listenerProbe(page, meta, add) {
  const pointer = meta.pointerCandidates || [];
  const selects = meta.selectCandidates || [];
  const clickable = [];
  if (!pointer.length && !selects.length) return clickable;
  let delegated = false;
  try {
    const docTypes = await page.listenerTypes('document', true);
    const bodyTypes = await page.listenerTypes('document.body', true);
    delegated = [...docTypes, ...bodyTypes].some((t) => CLICKY.has(t));
  } catch {}
  let direct = 0;
  let maybe = 0;
  for (const sel of pointer) {
    if (direct + maybe >= 25) break;
    let types = [];
    try {
      types = await page.listenerTypes(sel);
    } catch {
      continue;
    }
    if (types.some((t) => CLICKY.has(t))) {
      direct++;
      clickable.push(sel);
      const kb = types.some((t) => /^key/.test(t));
      add({ test: '4.A', level: 'violation', impact: 'serious', selector: sel, message: `Element has a ${types.filter((t) => CLICKY.has(t)).join('/')} listener but is not keyboard focusable${kb ? ' (it has a key handler, but focus can never reach it)' : ''}. Use a <button>/<a>, or add tabindex="0", a role, and key handling.` });
    } else if (delegated) {
      maybe++;
      add({ test: '4.A', level: 'review', impact: 'moderate', selector: sel, message: 'Element shows a pointer cursor and the page uses delegated click handling, but the element is not keyboard focusable. Confirm it is not an interactive control.' });
    }
  }
  for (const sel of selects) {
    let types = [];
    try {
      types = await page.listenerTypes(sel);
    } catch {
      continue;
    }
    if (types.includes('change') || types.includes('input')) {
      add({ test: '5.D', level: 'review', impact: 'moderate', selector: sel, message: 'Select has a change/input listener. Confirm changing the selection does not submit the form, navigate, or move focus unexpectedly without warning.' });
    }
  }
  // The elements with a click listener of their own: pointer targets the static checks cannot see.
  return clickable;
}

// A Tab sample from inside a same-origin frame, as part of the page: named with the frame's prefix,
// placed in the top document, keyed and ordered after the frame element itself, with the top
// document's address (the frame's own is not the page's).
const fromFrame = (outer, inner, fr) => ({
  ...inner,
  href: outer.href,
  key: `${fr.path} >>> ${inner.key}`,
  domIndex: outer.domIndex + (inner.domIndex + 1) / 1e6,
  selector: `${fr.path} >>> ${inner.selector}`,
  // The frame may have scrolled to show the focused element since it was found.
  rect: inner.rect ? {
    ...inner.rect,
    x: Math.round(inner.rect.x + fr.offset.x + fr.scroll.x - ((inner.scroll && inner.scroll.x) || 0)),
    y: Math.round(inner.rect.y + fr.offset.y + fr.scroll.y - ((inner.scroll && inner.scroll.y) || 0)),
  } : inner.rect,
  inDialog: inner.inDialog || outer.inDialog,
  frame: fr.path,
});

// scope.modal: the pass runs inside a modal dialog open on load, before Escape closes it. A modal
// keeps focus inside itself by design and Escape is its way out, so focus that cannot leave it is
// not judged a keyboard trap there.
export async function keyboardPass(page, add, opts, scope = {}) {
  const beyond = !!opts.wcag && opts.wcag !== '2.0';
  const wcag22 = opts.wcag === '2.2';
  const prep = await page.evaluate('window.__a11y508.kbPrepare()');
  const startHref = prep.href;
  // Focus moves into same-origin frames as the browser tabs through them: each frame's baseline is
  // taken too, and a sample that lands on a frame element is followed into the frame's document.
  let frames = [];
  try {
    frames = (await discoverFrames(page)).frames;
    for (const fr of frames) {
      const p = await page.evaluate('window.__a11y508.kbPrepare()', { contextId: fr.contextId }).catch(() => null);
      if (p) prep.count += p.count;
    }
  } catch {}
  const sample = async () => {
    let s = await page.evaluate('window.__a11y508.kbSample()');
    while (s && !s.isBody && s.inIframe) {
      // A frame's path is its element's selector, prefixed as a sample from its parent frame is.
      const fr = frames.find((f) => f.path === s.selector);
      if (!fr) break;
      let inner = null;
      try {
        inner = await page.evaluate('window.__a11y508.kbSample()', { contextId: fr.contextId });
      } catch {}
      if (!inner || inner.isBody) break;
      s = fromFrame(s, inner, fr);
    }
    return s;
  };
  const max = Math.min(opts.maxTabs, prep.count * 2 + 10);
  const seq = [];
  const seen = new Set();
  let last = null;
  let same = 0;
  let revisits = 0;
  let trap = false;
  let navigated = false;
  let bodyHits = 0;

  for (let i = 0; i < max; i++) {
    if (page.progress) page.progress('keyboard', { stops: i + 1, of: max });
    await page.press('Tab');
    await sleep(35);
    let s;
    try {
      s = await sample();
    } catch {
      break;
    }
    if (!s) break;
    if (s.href !== startHref) {
      navigated = true;
      add({ frame: last ? last.frame : undefined, test: '4.E', level: 'violation', impact: 'serious', selector: last ? last.selector : 'body', html: last ? last.html : '', message: `Moving keyboard focus ${last ? 'to this element' : 'into the page'} caused navigation to ${s.href}. Focus must not trigger a change of context.` });
      break;
    }
    if (s.isBody) {
      bodyHits++;
      // Wrapped past the last tabbable element. In a modal, focus left the dialog's last control for
      // the browser, and the next Tab brings it back to the first, which the pass may not have seen
      // yet: it started after the control the dialog focused on opening.
      if (seq.length && !(scope.modal && bodyHits === 1)) break;
      if (bodyHits > 2) break;
      continue;
    }
    if (last && s.key === last.key && s.composite) {
      // Focus is moving inside an iframe, a native media player, or a shadow-DOM widget that this page cannot inspect.
      if (++same === 1 && s.inIframe) add({ frame: s.frame, test: '4.A', level: 'review', impact: 'minor', selector: s.selector, html: s.html, rect: s.rect, message: 'Keyboard focus entered an iframe. Its contents were not tab-tested from this page; audit the frame URL separately.' });
      if (same > 25) break;
      continue;
    }
    if (last && s.key === last.key) {
      // Focus did not move. Either the end of the page was reached (headless Chrome keeps focus on the
      // last element) or this is a trap. Shift+Tab distinguishes the two.
      await page.press('Tab', 8);
      await sleep(35);
      let back;
      try {
        back = await sample();
      } catch {
        break;
      }
      if (back && !back.isBody && back.key === s.key && !scope.modal) {
        trap = true;
        add({ frame: s.frame, test: '4.C', level: 'violation', impact: 'critical', selector: s.selector, html: s.html, rect: s.rect, message: 'Keyboard trap: neither Tab nor Shift+Tab moves focus away from this element. Keyboard users cannot move past it.' });
      }
      break;
    }
    if (seen.has(s.key)) {
      if (seq.length && s.key === seq[0].key) break;
      if (++revisits > 5) break;
      last = s;
      continue;
    }
    if (!s.visible || !s.inViewport || (s.hadBaseline && s.diff.length === 0)) {
      // Skip links and focus styles often animate in; re-sample after transitions have had time to finish.
      await sleep(320);
      try {
        const again = await sample();
        if (again && !again.isBody && again.key === s.key) s = again;
      } catch {}
    }
    seen.add(s.key);
    seq.push(s);
    last = s;
    if (s.inIframe) continue;
    if (beyond && s.faint && s.inViewport) {
      add({ frame: s.frame, test: '4.D', level: 'violation', impact: 'serious', selector: s.selector, html: s.html, rect: s.rect, beyond508: true, message: 'Keyboard focus landed on an element that is almost transparent (opacity under 0.1, counting its ancestors), so the focus cannot be seen. Make it visible when it has focus, or remove it from the tab order. (IBM Equal Access treats opacity under 0.1 as hidden, a rule stricter than WCAG; beyond-508 profile.)' });
    } else if (!s.visible || !s.inViewport) {
      add({ frame: s.frame, test: '4.D', level: 'violation', impact: 'serious', selector: s.selector, html: s.html, rect: s.rect, message: `Keyboard focus landed on an element that is not visible (${!s.visible ? 'hidden or zero-size' : 'outside the viewport'}). Focus must be visible; hidden controls should be removed from the tab order or revealed on focus.` });
    } else if (wcag22 && s.obscured === 'full') {
      add({ frame: s.frame, test: '2.4.11', level: 'violation', impact: 'serious', selector: s.selector, html: s.html, rect: s.rect, details: { obscuredBy: s.obscuredBy }, message: `Keyboard focus landed on an element that is entirely hidden by ${s.obscuredBy ? `fixed or sticky content (${s.obscuredBy})` : 'fixed or sticky content'}. Users cannot see where focus is; add scroll-padding for the sticky area, or keep the focused element out from under it.` });
    } else if (s.covered) {
      add({ frame: s.frame, test: '4.D', level: 'review', impact: 'moderate', selector: s.selector, html: s.html, rect: s.rect, message: 'Focused element is overlapped by another element (for example a sticky header or overlay). Confirm the focus indicator is actually visible.' });
    } else if (s.hadBaseline && s.diff.length === 0 && s.proxied) {
      add({ frame: s.frame, test: '4.D', level: 'violation', impact: 'serious', selector: s.selector, html: s.html, rect: s.rect, message: `No visible change on this label or the custom ${s.proxied} box when its visually hidden ${s.proxied} input receives keyboard focus. Style the label or the box on :focus-visible (for example input:focus-visible + label).` });
    } else if (s.hadBaseline && s.diff.length === 0) {
      add({ frame: s.frame, test: '4.D', level: 'violation', impact: 'serious', selector: s.selector, html: s.html, rect: s.rect, message: 'No visible change when this element receives keyboard focus (no outline, border, background, or other style change). Provide a visible focus indicator.' });
    } else if (beyond && s.weakIndicator) {
      const w = s.weakIndicator;
      add({ frame: s.frame, test: '1.4.11', level: 'review', impact: 'moderate', selector: s.selector, html: s.html, rect: s.rect, details: w, message: w.prop === 'outline-color'
        ? `The focus indicator is a ${w.to} outline on ${w.from}, ${w.ratio}:1, below the 3:1 a focus indicator needs against what is behind it. Confirm focus is visible, or use a darker or lighter outline.`
        : `The focus indicator is a change of ${w.prop} from ${w.from} to ${w.to}, ${w.ratio}:1 against ${w.against}, below the 3:1 a focus indicator needs to be seen. Confirm focus is visible, or make the change stronger.` });
    }
  }

  const inversions = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].inDialog || seq[i - 1].inDialog) continue;
    if (seq[i].domIndex < seq[i - 1].domIndex) inversions.push({ from: seq[i - 1].selector, fromName: seq[i - 1].name, to: seq[i].selector, toName: seq[i].name });
  }
  if (inversions.length) {
    add({ test: '4.F', level: 'review', impact: 'moderate', selector: inversions[0].to, message: `Keyboard focus order differs from DOM order at ${inversions.length} point(s) (positive tabindex or scripted focus). Confirm the focus order preserves meaning and operability.`, details: { inversions: inversions.slice(0, 8) } });
  }
  return { tabbed: seq.length, trap, navigated, tabbable: prep.count };
}

// The page opened a modal dialog on load and the static checks saw only the dialog: press Escape
// once; if the dialog closed, run the static checks again on the page behind it and label what
// they find. Returns { dismissed, run, added }.
export const BEHIND_MODAL = 'after closing the modal shown on load';
export async function modalOnLoadPass(page, add, fingerprints) {
  await page.press('Escape');
  await sleep(400);
  const still = await page.evaluate('window.__a11y508.modalOnLoad()');
  if (still) return { dismissed: false, run: null, added: 0 };
  const run = await page.evaluate('window.__a11y508.run()');
  let added = 0;
  for (const f of run.findings) {
    if (fingerprints.has(`${f.test}|${f.selector}|${f.message}`)) continue;
    f.state = BEHIND_MODAL;
    add(f);
    added++;
  }
  return { dismissed: true, run, added };
}

// A reload brings back the modal dialog the page opens on load. When the first load's modal closed
// with Escape, press it once more so the pass that reloaded sees the page, not the dialog.
// Returns true when a modal was open and is now closed.
export async function redismissModal(page) {
  const open = await page.evaluate('window.__a11y508.modalOnLoad()');
  if (!open) return false;
  await page.press('Escape');
  await sleep(400);
  return !(await page.evaluate('window.__a11y508.modalOnLoad()'));
}

export async function disclosurePass(page, add, fingerprints, opts, reload) {
  const out = { candidates: 0, activated: 0, revealedFindings: 0 };
  // The top document first, then each same-origin frame's (found after the top document's
  // activations, which may have reloaded the page), within one budget of --max-activations.
  let budget = opts.maxActivations;
  const top = await disclosureScope(page, add, fingerprints, reload, null, budget, out, opts);
  budget -= top;
  if (budget > 0) {
    let frames = [];
    try {
      frames = (await discoverFrames(page)).frames;
    } catch {}
    for (const fr of frames) {
      if (budget <= 0) break;
      budget -= await disclosureScope(page, add, fingerprints, reload, fr, budget, out, opts);
    }
  }
  return out;
}

// The disclosure pass over one document: the top one (fr null) or a same-origin frame's, whose
// findings are named with the frame's prefix. Returns how many candidates it had.
async function disclosureScope(page, add, fingerprints, reload, fr, max, out, opts) {
  let ctx = fr ? fr.contextId : undefined;
  const ev = (expr) => page.evaluate(expr, { contextId: ctx });
  const wrap = (sel) => (fr && sel ? `${fr.path} >>> ${sel}` : sel);
  const put = (f) => add(fr ? { ...f, selector: wrap(f.selector), frame: fr.path } : f);
  // After a reload the frame's context is new: find the frame again by its path.
  const reopen = async () => {
    await reload();
    if (!fr) return true;
    const again = (await discoverFrames(page).catch(() => ({ frames: [] }))).frames.find((x) => x.path === fr.path);
    if (!again) return false;
    ctx = again.contextId;
    fr = again;
    return true;
  };
  let cands = [];
  try {
    cands = await ev(`window.__a11y508.disclosureCandidates(${max})`);
  } catch {
    return 0;
  }
  out.candidates += cands.length;
  const state = (sel) => ev(`window.__a11y508.disclosureState(${JSON.stringify(sel)})`);
  for (const [i, c] of cands.entries()) {
    if (page.progress) page.progress('disclosures', { done: i, of: cands.length });
    // Enter or Space on a search button runs the search: with the date range set first.
    if (!fr) await guardRange(page, opts, c.selector).catch(() => false);
    let focused = false;
    try {
      focused = await ev(`window.__a11y508.focusSelector(${JSON.stringify(c.selector)})`);
    } catch {
      break;
    }
    if (!focused) continue;
    const before = await state(c.selector);
    await page.press('Enter');
    await sleep(350);
    let st;
    try {
      st = await state(c.selector);
    } catch {
      st = null;
    }
    if (!st || st.href !== before.href) {
      put({ test: '6.A', level: 'review', impact: 'minor', selector: c.selector, message: `Activating "${c.name}" with Enter navigated to ${st ? st.href : 'another page'} although it is marked aria-expanded. Confirm the control's purpose is clear.` });
      if (!(await reopen())) break;
      continue;
    }
    if (!st.expanded) {
      await page.press('Space');
      await sleep(350);
      st = await state(c.selector);
      if (!st.exists) continue;
    }
    if (!st.expanded) {
      if (c.native) put({ test: '4.A', level: 'review', impact: 'moderate', selector: c.selector, message: `"${c.name}" did not change aria-expanded after Enter or Space. Confirm it works with the keyboard and that its expanded state is updated.` });
      else put({ test: '4.A', level: 'violation', impact: 'serious', selector: c.selector, message: `Custom control "${c.name}" did not respond to Enter or Space. Keyboard users cannot operate it.` });
      continue;
    }
    out.activated++;
    if (st.dialog) {
      if (!st.focusInDialog) put({ test: '4.G', level: 'violation', impact: 'serious', selector: st.dialog, message: `Dialog opened by "${c.name}" but keyboard focus did not move into it (focus is on ${st.activeSelector || 'body'}).` });
      await page.press('Escape');
      await sleep(300);
      const after = await state(c.selector);
      if (after.exists && !after.dialog) {
        if (!after.focusOnTrigger) put({ test: '4.H', level: 'violation', impact: 'moderate', selector: c.selector, message: `After closing the dialog opened by "${c.name}", focus did not return to the triggering control (it is on ${after.activeSelector || 'body'}).` });
      } else if (after.exists) {
        put({ test: '4.A', level: 'review', impact: 'moderate', selector: st.dialog, message: `Dialog opened by "${c.name}" did not close with Escape. Confirm a keyboard-operable close control exists and focus is managed (4.G/4.H).` });
      }
    }
    let res;
    try {
      res = await ev(fr ? 'window.__a11y508.run({ frame: true })' : 'window.__a11y508.run()');
    } catch {
      continue;
    }
    for (const f of res.findings) {
      const g = fr ? inFrame(f, fr) : f;
      const fp = `${g.test}|${g.selector}|${g.message}`;
      if (fingerprints.has(fp)) continue;
      g.state = `after activating "${c.name}" (${wrap(c.selector)})`;
      add(g);
      out.revealedFindings++;
    }
  }
  return cands.length;
}

// Clicks controls that look like navigation but have no href (router links on
// buttons, menu items with click handlers) and reports the same-origin URLs
// they lead to, so the crawler can audit pages it could not otherwise see.
// Anything named like an action (Save, Delete, Sign out ...) is never clicked.
export async function routeDiscoveryPass(page, meta, opts, reload, origin) {
  const startHref = await page.evaluate('location.href');
  const { candidates, skipped, capped } = await page.evaluate(`window.__a11y508.navCandidates(${opts.maxClicks}, ${JSON.stringify(meta.pointerCandidates || [])})`);
  const out = { candidates: candidates.length, clicked: 0, urls: [], offOrigin: 0, skipped: skipped.slice(0, 20), skippedCount: skipped.length, capped, routes: [] };
  const found = new Set();
  const here = async () => page.evaluate('location.href').catch(() => null);
  for (const [i, c] of candidates.entries()) {
    if (page.progress) page.progress('discovery', { clicked: i, of: candidates.length });
    if ((await here()) !== startHref) await reload();
    // A search button clicked here runs the search: with the date range set first.
    await guardRange(page, opts, c.selector).catch(() => false);
    let pt = null;
    try {
      pt = await page.evaluate(`window.__a11y508.prepareClick(${JSON.stringify(c.selector)})`);
    } catch {}
    if (!pt) continue;
    try {
      await page.click(pt.x, pt.y);
    } catch {
      continue;
    }
    out.clicked++;
    let href = null;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      await sleep(150);
      href = await here();
      if (href && href !== startHref) break;
    }
    if (!href || href === startHref) {
      await sleep(500); // a full-page navigation may still be loading
      href = await here();
    }
    if (!href || href === startHref) continue;
    let u;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (u.origin !== origin) {
      out.offOrigin++;
      continue;
    }
    if (!found.has(href)) {
      found.add(href);
      out.urls.push(href);
      out.routes.push({ name: c.name, selector: c.selector, url: href });
    }
  }
  if ((await here()) !== startHref) await reload();
  return out;
}

export async function zoomPass(page, add, shoot) {
  const before = await page.evaluate('window.__a11y508.layoutIssues()');
  await page.setZoom(2);
  await sleep(400);
  let after;
  try {
    after = await page.evaluate('window.__a11y508.layoutIssues()');
    const clipped = after.clipped.filter((c) => !before.clipped.some((b) => b.selector === c.selector));
    const overlaps = after.overlaps.filter((o) => !before.overlaps.some((b) => b.a === o.a && b.b === o.b));
    for (const c of clipped) {
      const f = { test: '18.A', level: 'violation', impact: 'serious', selector: c.selector, html: c.html, rect: c.rect, message: `Text "${c.text}" is clipped at 200% zoom (overflow hidden; ${c.overflowX > 4 ? `${c.overflowX}px cut horizontally` : `${c.overflowY}px cut vertically`}). Content is lost when text is enlarged.` };
      if (shoot) await shoot(f);
      add(f);
    }
    for (const o of overlaps) {
      const f = { test: '18.A', level: 'violation', impact: 'moderate', selector: o.a, html: o.html, rect: o.rect, message: `At 200% zoom, text "${o.textA}" overlaps "${o.textB}" (${o.b}), making one or both unreadable.` };
      if (shoot) await shoot(f);
      add(f);
    }
    if (before.textLength > 200 && after.textLength < before.textLength * 0.85) {
      add({ test: '18.A', level: 'review', impact: 'moderate', selector: 'body', message: `Visible text drops by ${Math.round(100 - (after.textLength / before.textLength) * 100)}% at 200% zoom (responsive layout hides content). Confirm the hidden content and functionality remain reachable, e.g. through a menu.` });
    }
  } finally {
    await page.setZoom(1);
    await sleep(150);
  }
  return { clipped: after ? after.clipped.length : 0, overlaps: after ? after.overlaps.length : 0 };
}

// WCAG 1.4.12 (beyond-508 profile): apply the text-spacing values as a bookmarklet would, then look
// for text that is clipped or overlaps only with them, like the zoom pass. The style is removed
// afterwards; restored says it is gone.
export async function spacingPass(page, add, shoot) {
  const before = await page.evaluate('window.__a11y508.layoutIssues()');
  await page.evaluate('window.__a11y508.applyTextSpacing()');
  await sleep(200);
  let after;
  let restored = false;
  try {
    after = await page.evaluate('window.__a11y508.layoutIssues()');
    const clipped = after.clipped.filter((c) => !before.clipped.some((b) => b.selector === c.selector));
    const overlaps = after.overlaps.filter((o) => !before.overlaps.some((b) => b.a === o.a && b.b === o.b));
    for (const c of clipped) {
      const f = { test: '1.4.12', level: 'violation', impact: 'serious', selector: c.selector, html: c.html, rect: c.rect, message: `Text "${c.text}" is clipped when the user's text spacing is applied (line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em; overflow hidden, ${c.overflowX > 4 ? `${c.overflowX}px cut horizontally` : `${c.overflowY}px cut vertically`}). Let the container grow with its text.` };
      if (shoot) await shoot(f);
      add(f);
    }
    for (const o of overlaps) {
      const f = { test: '1.4.12', level: 'violation', impact: 'moderate', selector: o.a, html: o.html, rect: o.rect, message: `With the user's text spacing applied, text "${o.textA}" overlaps "${o.textB}" (${o.b}), making one or both unreadable.` };
      if (shoot) await shoot(f);
      add(f);
    }
  } finally {
    restored = await page.evaluate('window.__a11y508.removeTextSpacing()').catch(() => false);
    await sleep(100);
  }
  return { clipped: after ? after.clipped.length : 0, overlaps: after ? after.overlaps.length : 0, restored };
}

// WCAG 1.4.10 (beyond-508 profile): lay the page out 320 CSS px wide and report what still needs
// horizontal scrolling. The viewport is set back afterwards, as the zoom pass does; restored says
// the page is at its configured width again.
export async function reflowPass(page, add) {
  const width = page.viewport.width;
  let restored = false;
  let found = 0;
  await page.setViewportWidth(320);
  await sleep(400);
  try {
    const r = await page.evaluate('window.__a11y508.reflowIssues()');
    for (const i of r.issues) {
      found++;
      // No rect: it was measured at 320 px, and screenshots are taken at the configured width.
      const f = { test: '1.4.10', level: 'violation', impact: 'serious', selector: i.selector, html: i.html, details: { right: i.right, width: i.width, viewport: r.viewport }, message: `At 320 CSS px wide (400% zoom), this element reaches ${i.right}px (it is ${i.width}px wide), so the page has to be scrolled sideways to read it. Let it shrink or wrap; only content that needs two dimensions (tables, images, maps, code) may scroll.` };
      add(f);
    }
  } finally {
    await page.setViewportWidth(width);
    await sleep(150);
    restored = await page.evaluate('window.innerWidth').then((w) => w === width).catch(() => false);
  }
  return { issues: found, restored };
}

// The label of what a search revealed: "after searching the last 3 months".
export const searchLabel = (months) => `after searching the last ${months} month${months === 1 ? '' : 's'}`;

// Waits until the page stops changing: the same element count, resource count and address for
// 500 ms (a search's request answered and rendered), then 500 ms more; at most `max` ms.
async function settle(page, max = 8000) {
  const until = Date.now() + max;
  let last = null;
  let since = Date.now();
  await sleep(250);
  while (Date.now() < until) {
    let sig = null;
    try {
      await page.ensureInjected();
      sig = await page.evaluate('window.__a11y508.searchSignature()');
    } catch {}
    if (sig && sig === last) {
      if (Date.now() - since >= 500) break;
    } else {
      last = sig;
      since = Date.now();
    }
    await sleep(150);
  }
  await sleep(500);
}

// Opens a custom dropdown (a click, then Alt+ArrowDown if no options show), chooses the preset
// A.comboOptions picks by clicking it (Enter if the click does not take), and closes whatever it
// left open with Escape. Returns the choice ({ text, days, short }) or null.
const ALT = 1;
async function comboPreset(page, sel, months) {
  const A = 'window.__a11y508';
  const q = JSON.stringify(sel);
  const options = async () => {
    let r = { options: [], choice: null };
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      r = await page.evaluate(`${A}.comboOptions(${q}, ${months})`);
      if (r.options.length) break;
      await sleep(100);
    }
    return r;
  };
  await page.evaluate(`${A}.comboMark()`);
  let r = await page.evaluate(`${A}.comboOptions(${q}, ${months})`);
  if (!r.options.length) {
    const pt = await page.evaluate(`${A}.prepareClick(${q})`).catch(() => null);
    if (pt) {
      await page.click(pt.x, pt.y);
      r = await options();
    }
    if (!r.options.length && (await page.evaluate(`${A}.comboFocus(${q})`))) {
      await page.press('ArrowDown', ALT);
      r = await options();
    }
  }
  let chosen = null;
  if (r.choice) {
    const o = JSON.stringify(r.choice.selector);
    const pt = await page.evaluate(`${A}.prepareClick(${o})`).catch(() => null);
    if (pt) {
      await page.click(pt.x, pt.y);
      await sleep(200);
    }
    let taken = !!pt && (await page.evaluate(`${A}.optionTaken(${o})`));
    if (!taken && (await page.evaluate(`${A}.comboActivate(${q}, ${o})`))) {
      await page.press('Enter');
      await sleep(200);
      taken = await page.evaluate(`${A}.optionTaken(${o})`);
    }
    // Reported only when it took: else the form falls back to its date fields.
    if (taken) chosen = r.choice;
  }
  for (let i = 0; i < 2 && (await page.evaluate(`${A}.comboIsOpen(${q})`)); i++) {
    if (i === 0) await page.evaluate(`${A}.comboFocus(${q})`);
    await page.press('Escape');
    await sleep(150);
  }
  return chosen;
}

// The date range, set on every load: each search or filter scope with a date range or preset is set
// to the last --search-months months (the search pass's own choice, nothing submitted), and what was
// set is recorded in the page so a pass about to run a search can tell whether the app changed it
// (guardRange). page.ranges collects one entry per scope for the page's report. --no-forms: nothing.
const A = 'window.__a11y508';
async function fillRange(page, sel, months) {
  const q = JSON.stringify(sel);
  const fill = await page.evaluate(`${A}.fillSearch(${q}, ${months}, { dates: false, required: false })`);
  if (!fill) return null;
  let via = fill.via || null;
  for (const c of fill.preset ? [] : fill.combos) {
    const got = await comboPreset(page, c, months).catch(() => null);
    if (!got) continue;
    Object.assign(fill, { preset: got.text, presetDays: got.days, short: got.short });
    via = { kind: 'combo', selector: c };
    break;
  }
  if (!fill.preset) {
    const rest = await page.evaluate(`${A}.fillSearch(${q}, ${months}, { presets: false, required: false })`);
    if (!rest || !rest.dates) return null;
    Object.assign(fill, { from: rest.from, to: rest.to });
    via = { kind: 'dates', from: rest.fromSel || null, to: rest.toSel || null };
  }
  const rec = { selector: sel, preset: fill.preset || null, presetDays: fill.presetDays || null, short: !!fill.short, from: fill.from || null, to: fill.to || null, via };
  await page.evaluate(`${A}.rangeRecord(${q}, ${JSON.stringify(rec)})`);
  return rec;
}

export async function applyRanges(page, opts) {
  if (!opts.forms) return [];
  await page.ensureInjected();
  const scopes = await page.evaluate(`(() => { ${A}._ranges = {}; return ${A}.rangeScopes(10); })()`);
  if (!scopes.length) return [];
  const scroll = await page.evaluate(`${A}.scrollPosition()`).catch(() => null);
  const set = [];
  for (const s of scopes) {
    const rec = await fillRange(page, s.selector, opts.searchMonths).catch(() => null);
    if (!rec) continue;
    set.push(rec);
    // One entry per form for the report, however often the page is loaded.
    if (page.ranges && !page.ranges.forms.some((f) => f.selector === rec.selector)) {
      const { via, ...shown } = rec;
      page.ranges.forms.push(shown);
    }
  }
  // Left as loaded: nothing focused, Tab starting from the top of the page again (a focused element
  // removed at the start of the body moves the browser's starting point there), scrolled back.
  await page.evaluate(`(() => {
    const a = document.activeElement;
    if (a && a !== document.body) a.blur();
    if (document.body) {
      const m = document.createElement('span');
      m.tabIndex = -1;
      document.body.prepend(m);
      m.focus({ preventScroll: true });
      m.blur();
      m.remove();
    }
    ${scroll ? `window.scrollTo(${scroll.x}, ${scroll.y});` : ''}
    return true;
  })()`).catch(() => {});
  return set;
}

// Before a pass activates `sel` (or presses Enter on the focused element, with `enter`): when that
// submits a scope whose range was set on this load and the app has changed the range since, it is
// set again. Returns true when it was.
export async function guardRange(page, opts, sel, enter = false) {
  if (!opts.forms) return false;
  const scope = await page.evaluate(`${A}.rangeTarget(${JSON.stringify(sel)}, ${!!enter})`).catch(() => null);
  if (!scope) return false;
  if (await page.evaluate(`${A}.rangeIntact(${JSON.stringify(scope)})`).catch(() => true)) return false;
  const rec = await fillRange(page, scope, opts.searchMonths).catch(() => null);
  if (rec && page.ranges) page.ranges.reapplied++;
  return !!rec;
}

// Search-form discovery: fills and submits the forms that look like searches or filters (at most
// three), with a date range from `opts.searchMonths` months ago to today, then follows what they
// reveal: links in the results, result rows and "view" controls, and pagination (within
// --max-clicks). The page's audit is what it was before the search, plus a re-check of the result
// area labelled "after searching the last N months". Returns null when the page has no such form.
export async function searchPass(page, add, fingerprints, opts, reload, origin) {
  const months = opts.searchMonths;
  const label = searchLabel(months);
  await page.ensureInjected();
  const { forms, skipped } = await page.evaluate('window.__a11y508.searchForms(3)');
  if (!forms.length) return skipped.length ? { filled: 0, submitted: 0, results: 0, urls: [], empty: 0, revealedFindings: 0, skipped } : null;
  if (page.progress) page.progress('search', { months, forms: forms.length });
  const startHref = await page.evaluate('location.href');
  const out = { filled: 0, submitted: 0, results: 0, urls: [], empty: 0, revealedFindings: 0, skipped, forms: [] };
  const known = new Set();
  const here = async () => page.evaluate('location.href').catch(() => null);
  const fresh = async () => {
    if ((await here()) !== startHref) await reload();
    await page.ensureInjected();
  };
  // Fills and submits one form; returns what it filled, or null.
  const run = async (f) => {
    await fresh();
    await page.evaluate('window.__a11y508.markBeforeSearch()');
    const sel = JSON.stringify(f.selector);
    const fill = await page.evaluate(`window.__a11y508.fillSearch(${sel}, ${months}, { dates: false, required: false })`);
    if (!fill) return null;
    // A preset in a custom dropdown, when the form had none in its own fields.
    for (const c of fill.preset ? [] : fill.combos) {
      const got = await comboPreset(page, c, months).catch(() => null);
      if (!got) continue;
      Object.assign(fill, { preset: got.text, presetDays: got.days, short: got.short });
      break;
    }
    const rest = await page.evaluate(`window.__a11y508.fillSearch(${sel}, ${months}, { presets: false, dates: ${!fill.preset} })`);
    if (rest) Object.assign(fill, { dates: rest.dates, from: rest.from, to: rest.to, required: rest.required });
    let pt = null;
    if (f.submit) pt = await page.evaluate(`window.__a11y508.prepareClick(${JSON.stringify(f.submit)})`).catch(() => null);
    if (pt) await page.click(pt.x, pt.y);
    else {
      await page.evaluate(`(() => { const s = window.__a11y508.query(${JSON.stringify(f.selector)}); const el = s && s.querySelector('input:not([type=hidden]), select, textarea'); if (el) el.focus(); return !!el; })()`);
      await page.press('Enter');
    }
    await settle(page);
    await page.ensureInjected().catch(() => {});
    return fill;
  };
  let clicks = opts.maxClicks;
  for (const f of forms) {
    let fill;
    try {
      fill = await run(f);
    } catch {
      continue;
    }
    if (!fill) continue;
    out.filled++;
    out.submitted++;
    const found = [];
    const note = (url) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        return;
      }
      if (u.origin !== origin || known.has(u.href) || u.href === startHref) return;
      known.add(u.href);
      found.push(u.href);
    };
    const href = await here();
    const navigated = href && href !== startHref;
    // A form that navigates (a GET form): its result page is queued itself.
    if (navigated) note(href);
    let res = { links: [], candidates: [] };
    try {
      res = await page.evaluate(`window.__a11y508.searchResults(${Math.max(0, clicks)})`);
    } catch {}
    for (const l of res.links) note(l);
    // The result area, re-checked in place (a navigated result page gets its own audit).
    if (!navigated) {
      try {
        const again = await page.evaluate('window.__a11y508.run()');
        for (const g of again.findings) {
          const fp = `${g.test}|${g.selector}|${g.message}`;
          if (fingerprints.has(fp)) continue;
          g.state = label;
          add(g);
          out.revealedFindings++;
        }
      } catch {}
    }
    // Result rows and controls without links: clicked one by one, the search redone in between.
    for (const [i, c] of res.candidates.entries()) {
      if (clicks <= 0) break;
      if (i > 0 || (await here()) !== (navigated ? href : startHref)) {
        try {
          if (!(await run(f))) break;
        } catch {
          break;
        }
      }
      const before = await here();
      const pt = await page.evaluate(`window.__a11y508.prepareClick(${JSON.stringify(c.selector)})`).catch(() => null);
      if (!pt) continue;
      clicks--;
      await page.click(pt.x, pt.y).catch(() => {});
      let after = before;
      const until = Date.now() + 2000;
      while (Date.now() < until && after === before) {
        await sleep(150);
        after = await here();
      }
      if (after && after !== before) note(after);
    }
    // The first two results of a search are queued whatever the query-variant limit says.
    out.urls.push(...found.map((url, k) => ({ url, priority: k < 2 })));
    out.results += found.length;
    out.forms.push({ name: f.name, selector: f.selector, from: fill.from || null, to: fill.to || null, preset: fill.preset, presetDays: fill.presetDays, short: !!fill.short, results: found.length, navigated: !!navigated });
    if (!found.length && !res.candidates.length && (fill.dates || fill.preset)) out.empty++;
  }
  if ((await here()) !== startHref) await reload();
  return out;
}
