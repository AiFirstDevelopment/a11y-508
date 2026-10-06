// Interactive passes that run after the static in-page checks:
// event-listener probe (4.A, 5.D), keyboard tab-through (4.C, 4.D, 4.E, 4.F),
// disclosure activation (4.A, 4.G, 4.H + re-check of revealed content), 200% zoom (18.A).

import { sleep } from './page.mjs';

const CLICKY = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick']);

export async function listenerProbe(page, meta, add) {
  const pointer = meta.pointerCandidates || [];
  const selects = meta.selectCandidates || [];
  if (!pointer.length && !selects.length) return;
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
}

export async function keyboardPass(page, add, opts) {
  const prep = await page.evaluate('window.__a11y508.kbPrepare()');
  const startHref = prep.href;
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
    await page.press('Tab');
    await sleep(35);
    let s;
    try {
      s = await page.evaluate('window.__a11y508.kbSample()');
    } catch {
      break;
    }
    if (!s) break;
    if (s.href !== startHref) {
      navigated = true;
      add({ test: '4.E', level: 'violation', impact: 'serious', selector: last ? last.selector : 'body', html: last ? last.html : '', message: `Moving keyboard focus ${last ? 'to this element' : 'into the page'} caused navigation to ${s.href}. Focus must not trigger a change of context.` });
      break;
    }
    if (s.isBody) {
      bodyHits++;
      if (seq.length) break; // wrapped past the last tabbable element
      if (bodyHits > 2) break;
      continue;
    }
    if (last && s.key === last.key && s.composite) {
      // Focus is moving inside an iframe, a native media player, or a shadow-DOM widget that this page cannot inspect.
      if (++same === 1 && s.inIframe) add({ test: '4.A', level: 'review', impact: 'minor', selector: s.selector, html: s.html, rect: s.rect, message: 'Keyboard focus entered an iframe. Its contents were not tab-tested from this page; audit the frame URL separately.' });
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
        back = await page.evaluate('window.__a11y508.kbSample()');
      } catch {
        break;
      }
      if (back && !back.isBody && back.key === s.key) {
        trap = true;
        add({ test: '4.C', level: 'violation', impact: 'critical', selector: s.selector, html: s.html, rect: s.rect, message: 'Keyboard trap: neither Tab nor Shift+Tab moves focus away from this element. Keyboard users cannot move past it.' });
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
        const again = await page.evaluate('window.__a11y508.kbSample()');
        if (again && !again.isBody && again.key === s.key) s = again;
      } catch {}
    }
    seen.add(s.key);
    seq.push(s);
    last = s;
    if (s.inIframe) continue;
    if (!s.visible || !s.inViewport) {
      add({ test: '4.D', level: 'violation', impact: 'serious', selector: s.selector, html: s.html, rect: s.rect, message: `Keyboard focus landed on an element that is not visible (${!s.visible ? 'hidden or zero-size' : 'outside the viewport'}). Focus must be visible; hidden controls should be removed from the tab order or revealed on focus.` });
    } else if (s.covered) {
      add({ test: '4.D', level: 'review', impact: 'moderate', selector: s.selector, html: s.html, rect: s.rect, message: 'Focused element is overlapped by another element (for example a sticky header or overlay). Confirm the focus indicator is actually visible.' });
    } else if (s.hadBaseline && s.diff.length === 0) {
      add({ test: '4.D', level: 'violation', impact: 'serious', selector: s.selector, html: s.html, rect: s.rect, message: 'No visible change when this element receives keyboard focus (no outline, border, background, or other style change). Provide a visible focus indicator.' });
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

export async function disclosurePass(page, add, fingerprints, opts, reload) {
  const cands = await page.evaluate(`window.__a11y508.disclosureCandidates(${opts.maxActivations})`);
  const out = { candidates: cands.length, activated: 0, revealedFindings: 0 };
  const state = (sel) => page.evaluate(`window.__a11y508.disclosureState(${JSON.stringify(sel)})`);
  for (const c of cands) {
    let focused = false;
    try {
      focused = await page.evaluate(`window.__a11y508.focusSelector(${JSON.stringify(c.selector)})`);
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
      add({ test: '6.A', level: 'review', impact: 'minor', selector: c.selector, message: `Activating "${c.name}" with Enter navigated to ${st ? st.href : 'another page'} although it is marked aria-expanded. Confirm the control's purpose is clear.` });
      await reload();
      continue;
    }
    if (!st.expanded) {
      await page.press('Space');
      await sleep(350);
      st = await state(c.selector);
      if (!st.exists) continue;
    }
    if (!st.expanded) {
      if (c.native) add({ test: '4.A', level: 'review', impact: 'moderate', selector: c.selector, message: `"${c.name}" did not change aria-expanded after Enter or Space. Confirm it works with the keyboard and that its expanded state is updated.` });
      else add({ test: '4.A', level: 'violation', impact: 'serious', selector: c.selector, message: `Custom control "${c.name}" did not respond to Enter or Space. Keyboard users cannot operate it.` });
      continue;
    }
    out.activated++;
    if (st.dialog) {
      if (!st.focusInDialog) add({ test: '4.G', level: 'violation', impact: 'serious', selector: st.dialog, message: `Dialog opened by "${c.name}" but keyboard focus did not move into it (focus is on ${st.activeSelector || 'body'}).` });
      await page.press('Escape');
      await sleep(300);
      const after = await state(c.selector);
      if (after.exists && !after.dialog) {
        if (!after.focusOnTrigger) add({ test: '4.H', level: 'violation', impact: 'moderate', selector: c.selector, message: `After closing the dialog opened by "${c.name}", focus did not return to the triggering control (it is on ${after.activeSelector || 'body'}).` });
      } else if (after.exists) {
        add({ test: '4.A', level: 'review', impact: 'moderate', selector: st.dialog, message: `Dialog opened by "${c.name}" did not close with Escape. Confirm a keyboard-operable close control exists and focus is managed (4.G/4.H).` });
      }
    }
    let res;
    try {
      res = await page.evaluate('window.__a11y508.run()');
    } catch {
      continue;
    }
    for (const f of res.findings) {
      const fp = `${f.test}|${f.selector}|${f.message}`;
      if (fingerprints.has(fp)) continue;
      f.state = `after activating "${c.name}" (${c.selector})`;
      add(f);
      out.revealedFindings++;
    }
  }
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
