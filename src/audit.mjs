// Audit one page: navigate, run in-page checks, interactive passes.

import { BEYOND, testInfo } from './checks/catalog.mjs';
import { listenerProbe, keyboardPass, disclosurePass, zoomPass, spacingPass, reflowPass, routeDiscoveryPass, modalOnLoadPass, redismissModal, searchPass, applyRanges } from './passes.mjs';
import { discoverFrames, inFrame, MAX_FRAME_DEPTH, BETWEEN_IMAGES } from './frames.mjs';
import { fromLibrary } from './library-dom.mjs';

// What a document that the server called an error actually rendered: enough
// text, or scripts with a real element tree, means an application page.
function renderedContent(page) {
  return page.evaluate(
    '(() => { const b = document.body; const text = b ? (b.innerText || b.textContent || "").replace(/\\s+/g, " ").trim() : ""; return { text: text.length, scripts: document.scripts.length, elements: b ? b.getElementsByTagName("*").length : 0 }; })()'
  );
}

export async function auditPage(page, url, ctx) {
  if (ctx.progress) ctx.progress.start(url);
  // The passes report where they are through the page (--events only).
  page.progress = ctx.progress ? (phase, detail = null) => ctx.progress.phase(url, phase, detail) : null;
  // The date ranges set on this page's loads (src/passes.mjs applyRanges), one entry per form.
  page.ranges = { forms: [], reapplied: 0 };
  try {
    const result = await auditPageIn(page, url, ctx);
    if (page.ranges.forms.length) result.ranges = page.ranges;
    return result;
  } finally {
    if (ctx.progress) ctx.progress.end(url);
    page.progress = null;
    page.ranges = null;
  }
}

async function auditPageIn(page, url, ctx) {
  const { opts } = ctx;
  const t0 = Date.now();
  const result = { url, finalUrl: url, status: null, title: '', headings: [], error: null, skipped: null, timedOut: false, findings: [], info: null, passes: {}, errors: [] };
  const fingerprints = new Set();
  // 13.C lists text colored between an image's bounds in one review item per page. A later run of
  // the checks (behind a load-time modal, after a disclosure) merges its new elements into that item
  // instead of adding a second one; each merged element keeps the state it was found in.
  const mergeBetween = (f) => {
    const prev = result.findings.find((x) => x.test === f.test && x.selector === BETWEEN_IMAGES);
    if (!prev) return false;
    const known = new Set(prev.details.elements.map((e) => e.selector));
    const fresh = f.details.elements.filter((e) => !known.has(e.selector)).map((e) => (f.state ? { ...e, state: f.state } : e));
    if (!fresh.length) return true;
    prev.details.elements.push(...fresh);
    prev.details.total += fresh.length;
    const total = prev.details.total;
    const shown = prev.details.elements.slice(0, 20).map((e) => e.selector).join(', ');
    prev.message = prev.message.replace(/^\d+ /, `${total} `).replace(/Check each visually: .*$/, `Check each visually: ${shown}${total > 20 ? ` and ${total - 20} more` : ''}.`);
    return true;
  };
  const add = (f) => {
    if (f.test === '13.C' && f.selector === BETWEEN_IMAGES && f.details && f.details.elements && mergeBetween(f)) return;
    const fp = `${f.test}|${f.selector}|${f.message}`;
    if (fingerprints.has(fp)) return;
    fingerprints.add(fp);
    const info = testInfo(f.test);
    result.findings.push({
      test: f.test,
      name: info.name,
      wcag: info.wcag,
      level: f.level || 'violation',
      impact: f.impact || 'moderate',
      message: f.message,
      selector: f.selector || '',
      html: f.html || '',
      rect: f.rect || null,
      details: f.details,
      state: f.state,
      // Only findings inside a same-origin frame carry the frame's selector.
      frame: f.frame,
      // Set by the in-page checks on an element rendered by a UI library; read and removed by dropLibrary.
      library: f.library || undefined,
      // Only beyond-508 findings carry the key, so a default report.json keeps its shape.
      beyond508: f.beyond508 || BEYOND[f.test] ? true : undefined,
    });
  };
  const beyond = !!opts.wcag && opts.wcag !== '2.0';
  // Findings on elements rendered by a UI library (src/library-dom.mjs) are dropped: their authors
  // tested them and the assistant cannot edit node_modules. Only the count is kept. The passes
  // interact with those elements as before; this runs on the page's findings once they are in.
  // inPage: also resolve the remaining top-document selectors in the page (the ancestor rule).
  const dropLibrary = async (inPage) => {
    let flags = [];
    if (inPage) {
      const open = result.findings.filter((f) => !f.library && !f.frame && f.selector && f.selector !== BETWEEN_IMAGES);
      try {
        const got = open.length ? await page.evaluate(`window.__a11y508.libraryAt(${JSON.stringify(open.map((f) => f.selector))})`) : [];
        flags = open.filter((f, i) => got && got[i]);
      } catch {}
    }
    const drop = new Set(flags);
    const kept = result.findings.filter((f) => {
      const lib = f.library || drop.has(f) || fromLibrary(f);
      delete f.library;
      return !lib;
    });
    const n = result.findings.length - kept.length;
    if (n) {
      result.findings = kept;
      result.dropped = { library: ((result.dropped && result.dropped.library) || 0) + n };
    }
  };

  // How long each pass took, so a slow page says where its time went (Routes crawled shows it).
  const timing = {};
  const timed = async (phase, fn) => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timing[phase] = (timing[phase] || 0) + Date.now() - t;
    }
  };
  result.timing = timing;
  let nav;
  try {
    nav = await timed('loading', () => page.goto(url, opts.timeout));
  } catch (e) {
    result.error = e.message;
    result.durationMs = Date.now() - t0;
    return result;
  }
  if (nav.retries) result.navRetries = nav.retries;
  if (nav.error) {
    result.error = nav.error;
    result.durationMs = Date.now() - t0;
    return result;
  }
  result.status = nav.status;
  result.finalUrl = nav.finalUrl;
  result.timedOut = nav.timedOut;
  if (nav.status && nav.status >= 400) {
    // Many single-page apps answer 404 for a deep link and serve the app with
    // it anyway; the browser shows the page, so the crawler audits it too,
    // and the coverage section says the server called it not found.
    const rendered = (nav.status === 404 || nav.status === 410) && (!nav.mimeType || /html/i.test(nav.mimeType)) ? await renderedContent(page).catch(() => null) : null;
    if (rendered && (rendered.text >= 200 || (rendered.scripts >= 1 && rendered.elements >= 20))) {
      result.servedWith = nav.status;
    } else {
      result.error = `HTTP ${nav.status}`;
      if (nav.status === 401 || nav.status === 403) result.error += opts.auth ? ' (TOKEN was sent; check that it is valid for this site)' : ' (no TOKEN set; export TOKEN=... to authenticate)';
      result.durationMs = Date.now() - t0;
      return result;
    }
  }
  if (nav.mimeType && !/html|xml/i.test(nav.mimeType)) {
    result.skipped = `not an HTML document (${nav.mimeType})`;
    result.durationMs = Date.now() - t0;
    return result;
  }
  try {
    if (new URL(nav.finalUrl).origin !== ctx.origin) {
      result.skipped = `redirected off-origin to ${nav.finalUrl}`;
      if (/login|log-in|signin|sign-in|auth|sso|oauth|oidc|saml|account|session/i.test(nav.finalUrl)) {
        result.skipped += ' (looks like a sign-in page: run once with --login to sign in and save the session, then crawl with --state)';
      }
      result.durationMs = Date.now() - t0;
      return result;
    }
  } catch {}

  const reload = async () => {
    await page.goto(result.finalUrl, opts.timeout).catch(() => {});
    await page.ensureInjected().catch(() => {});
    // The modal shown on load comes back with the page; dismiss it again as the first load did.
    if (result.modalOnLoad && result.modalOnLoad.dismissed && (await redismissModal(page).catch(() => false))) {
      result.modalOnLoad.redismissed = (result.modalOnLoad.redismissed || 0) + 1;
    }
    // Every load: the date range at the last --search-months months before anything is pressed.
    await applyRanges(page, opts).catch(() => {});
  };

  try {
    await page.ensureInjected();
    // The date range at the last --search-months months before any check or pass runs; behind a
    // modal shown on load, once Escape has closed it (filling first could close the modal early).
    const setRanges = async () => {
      try {
        await applyRanges(page, opts);
      } catch (e) {
        result.errors.push(`date range: ${e.message}`);
      }
    };
    if (!(await page.evaluate('window.__a11y508.modalOnLoad()').catch(() => null))) await setRanges();
    result.info = await page.evaluate('window.__a11y508.pageInfo()');
    result.title = result.info.title;
    // What is on the page, beside its title: the PDF run's route list shows them so a screenshot can be
    // matched to a page (docs/plans/manual-crawl-first.md AC 2).
    result.headings = Array.isArray(result.info.headings) ? result.info.headings : [];
    // A modal dialog open on load (a cookie or consent banner) hides the page from every check.
    const modal = await page.evaluate('window.__a11y508.modalOnLoad()');
    if (page.progress) page.progress('checks', { elements: await page.evaluate('document.getElementsByTagName("*").length').catch(() => 0) });
    let base = await page.evaluate('window.__a11y508.run()');
    for (const f of base.findings) add(f);
    if (base.meta.errors && base.meta.errors.length) result.errors.push(...base.meta.errors.map((e) => `check: ${e}`));
    for (const [test, n] of Object.entries(base.meta.truncated || {})) result.errors.push(`${test}: ${n} additional finding(s) not listed (per-test cap)`);
    result.passes.static = { findings: base.findings.length, contrastChecked: base.meta.contrastChecked, scrollRestored: base.meta.scrollRestored };
    if (modal) {
      // The modal's own controls get the Tab pass before Escape closes it; the page behind it gets
      // its own pass later, as every page does.
      if (opts.interact) {
        try {
          result.passes.keyboardModal = await keyboardPass(page, add, opts, { modal: true });
          if (result.passes.keyboardModal.navigated) await reload();
        } catch (e) {
          result.errors.push(`keyboard pass in the modal: ${e.message}`);
        }
      }
      const behind = await modalOnLoadPass(page, add, fingerprints);
      result.modalOnLoad = { ...modal, dismissed: behind.dismissed };
      if (behind.dismissed) await setRanges();
      if (behind.run) {
        result.passes.static.behindModal = behind.added;
        result.passes.static.scrollRestored = result.passes.static.scrollRestored && behind.run.meta.scrollRestored;
        if (behind.run.meta.errors && behind.run.meta.errors.length) result.errors.push(...behind.run.meta.errors.map((e) => `check: ${e}`));
        base = behind.run;
      }
    }

    // Same-origin frames, audited as part of the page once the top document's checks (and the page
    // behind a modal shown on load) are done. Closed shadow roots and frames from other origins
    // cannot be read: each is a coverage note on the page.
    const unaudited = { closedShadow: [...((base.meta && base.meta.closedShadow) || [])], crossOriginFrames: [], deepFrames: 0 };
    // Custom elements with light-DOM content that may also render a closed root: { tag, selector, contextId }.
    const closedCandidates = ((base.meta && base.meta.closedCandidates) || []).map((c) => ({ ...c }));
    let found = { frames: [] };
    try {
      found = await discoverFrames(page);
      unaudited.crossOriginFrames = found.crossOrigin;
      unaudited.deepFrames = found.deep;
      let inFrames = 0;
      for (const [i, fr] of found.frames.entries()) {
        if (page.progress) page.progress('frames', { done: i, of: found.frames.length });
        let run;
        try {
          run = await page.evaluate('window.__a11y508.run({ frame: true })', { contextId: fr.contextId });
        } catch (e) {
          result.errors.push(`frame ${fr.path}: ${e.message}`);
          continue;
        }
        for (const f of run.findings) add(inFrame(f, fr));
        inFrames += run.findings.length;
        if (run.meta.errors && run.meta.errors.length) result.errors.push(...run.meta.errors.map((e) => `check in frame ${fr.path}: ${e}`));
        for (const [test, n] of Object.entries(run.meta.truncated || {})) result.errors.push(`${test} in frame ${fr.path}: ${n} additional finding(s) not listed (per-test cap)`);
        for (const tag of run.meta.closedShadow || []) if (!unaudited.closedShadow.includes(tag)) unaudited.closedShadow.push(tag);
        for (const c of run.meta.closedCandidates || []) closedCandidates.push({ ...c, contextId: fr.contextId });
      }
      if (found.frames.length) result.passes.frames = { audited: found.frames.length, findings: inFrames };
    } catch (e) {
      result.errors.push(`frames: ${e.message}`);
    }
    for (const c of closedCandidates) {
      if (unaudited.closedShadow.includes(c.tag)) continue;
      try {
        if (await page.closedRootHasText(c.selector, c.contextId)) unaudited.closedShadow.push(c.tag);
      } catch (e) {
        result.errors.push(`closed shadow root: ${e.message}`);
      }
    }
    // "No accessible name" violations, checked against Chrome's own accessibility tree.
    try {
      if (page.progress) page.progress('names', { checked: 0, of: result.findings.filter((f) => f.level === 'violation').length });
      const ax = await confirmNames(page, result.findings, found.frames);
      if (ax) result.passes.axNames = ax;
    } catch (e) {
      result.errors.push(`accessibility tree: ${e.message}`);
    }
    const notes = coverageNotes(unaudited);
    if (notes.length) {
      result.unaudited = unaudited;
      result.coverageNotes = notes;
    }

    let clickable = [];
    try {
      clickable = await listenerProbe(page, base.meta, add);
    } catch (e) {
      result.errors.push(`listener probe: ${e.message}`);
    }
    // 2.5.8 for elements the static checks cannot see as targets: those with a click listener.
    if (opts.wcag === '2.2' && clickable.length) {
      try {
        const found = await page.evaluate(`window.__a11y508.targetSizeFor(${JSON.stringify(clickable)})`);
        for (const f of found) add(f);
      } catch (e) {
        result.errors.push(`target size: ${e.message}`);
      }
    }

    if (opts.interact) {
      try {
        result.passes.keyboard = await timed('keyboard', () => keyboardPass(page, add, opts));
        if (result.passes.keyboard.navigated) await reload();
      } catch (e) {
        result.errors.push(`keyboard pass: ${e.message}`);
      }
      try {
        result.passes.disclosure = await timed('disclosures', () => disclosurePass(page, add, fingerprints, opts, reload));
      } catch (e) {
        result.errors.push(`disclosure pass: ${e.message}`);
      }
    }

    if (opts.zoom) {
      try {
        if (page.progress) page.progress('zoom');
        result.passes.zoom = await timed('zoom', () => zoomPass(page, add));
      } catch (e) {
        result.errors.push(`zoom pass: ${e.message}`);
      }
    }
    // Beyond-508 profile only, so a default run costs nothing extra.
    if (beyond) {
      try {
        result.passes.spacing = await spacingPass(page, add);
      } catch (e) {
        result.errors.push(`text spacing pass: ${e.message}`);
      }
      try {
        result.passes.reflow = await reflowPass(page, add);
      } catch (e) {
        result.errors.push(`reflow pass: ${e.message}`);
      }
    }

    await dropLibrary(true);
    // Searches and filters, filled with a date range and submitted: the results they reveal are
    // re-checked here and the pages behind them queued. The page's own audit is what it was before.
    if (opts.forms) {
      try {
        await reload();
        const s = await timed('search', () => searchPass(page, add, fingerprints, opts, reload, ctx.origin));
        if (s) result.search = s;
      } catch (e) {
        result.errors.push(`search forms: ${e.message}`);
      }
      await dropLibrary(true);
    }
    // Last, because it clicks around and reloads: find pages reachable only
    // through click handlers so the crawler can queue them.
    if (opts.followClicks && opts.maxClicks > 0) {
      try {
        await reload();
        result.discovery = await timed('discovery', () => routeDiscoveryPass(page, base.meta, opts, reload, ctx.origin));
      } catch (e) {
        result.errors.push(`route discovery: ${e.message}`);
      }
    }
    // Links the disclosure pass brought in (a menu rendered on activation) are pages found, like click discovery's.
    const revealed = result.passes && result.passes.disclosure && Array.isArray(result.passes.disclosure.urls) ? result.passes.disclosure.urls : [];
    if (revealed.length) {
      const d = result.discovery || { candidates: 0, clicked: 0, urls: [], offOrigin: 0, skipped: [], skippedCount: 0, capped: 0, routes: [], revealed: 0 };
      const had = new Set(d.urls || []);
      for (const u of revealed) if (!had.has(u)) {
        had.add(u);
        d.urls = [...(d.urls || []), u];
        d.revealed = (d.revealed || 0) + 1;
      }
      result.discovery = d;
    }
    if (result.search && result.search.submitted) result.discovery = { ...(result.discovery || {}), forms: { filled: result.search.filled, submitted: result.search.submitted, results: result.search.results } };
  } catch (e) {
    result.error = `audit failed: ${e.message}`;
  }
  await dropLibrary(false);

  result.durationMs = Date.now() - t0;
  return result;
}

// The "no accessible name" violations: an element our name computation could not name. Chrome's
// accessibility tree is the tiebreaker, since that is what assistive technology reads.
const NO_NAME = {
  '5.A': /has no label or accessible name\.$/,
  '6.A': /^(Link|Button) has no accessible name\.|^Image button has no alt text or accessible name\.|^Image map area has no alt text;/,
  '7.A': /^Image has no alt attribute and no accessible name\.|^<(object|embed) [^>]*> has no text alternative\.|^(<svg role="img">|role="img") has no accessible name\./,
  '5.C': /^Dialog has no accessible name|^role="(dialog|alertdialog)" has no accessible name/,
};
export const MAX_AX_LOOKUPS = 50;
// Characters that are not a name (icon-font glyphs, variation selectors, zero-width characters),
// as 00-core.js strips them: a glyph Chrome puts in a name is still not a name anyone can hear.
const NON_TEXT = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u200B-\u200D\u2060\uFEFF]/gu;

// Looks up each "no accessible name" violation's element in Chrome's accessibility tree (one call
// each, none when a page has more than MAX_AX_LOOKUPS). Where Chrome names it, the finding becomes
// a review item quoting Chrome's name; where Chrome agrees, it stays. Returns the counts, or null
// when the page has no such finding.
async function confirmNames(page, findings, frames) {
  const cands = findings.filter((f) => f.level === 'violation' && NO_NAME[f.test] && NO_NAME[f.test].test(f.message));
  if (!cands.length) return null;
  if (cands.length > MAX_AX_LOOKUPS) return { candidates: cands.length, checked: 0, named: 0, note: `${cands.length} findings without an accessible name, more than ${MAX_AX_LOOKUPS}: not checked against Chrome's accessibility tree` };
  let checked = 0;
  let named = 0;
  for (const f of cands) {
    let selector = f.selector;
    let contextId;
    if (f.frame) {
      const fr = frames.find((x) => x.path === f.frame);
      if (!fr || !selector.startsWith(`${fr.path} >>> `)) continue;
      selector = selector.slice(fr.path.length + 5);
      contextId = fr.contextId;
    }
    let name;
    try {
      name = await page.axName(selector, contextId);
    } catch {
      continue;
    }
    if (name === null) continue;
    checked++;
    const text = name.replace(NON_TEXT, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    named++;
    const quoted = name.replace(/\s+/g, ' ').trim();
    f.message = `Chrome's accessibility tree names this element "${quoted}", which the checks could not compute: ${f.message} Confirm "${quoted}" is the right name and that it comes from markup assistive technology reads, such as a label, aria-label or text content.`;
    f.level = 'review';
    f.impact = 'moderate';
    f.details = { ...(f.details || {}), chromeName: quoted };
  }
  return { candidates: cands.length, checked, named };
}

// The page's coverage notes: what it holds that the checks could not read.
function coverageNotes(u) {
  const notes = [];
  if (u.closedShadow.length) notes.push(`${u.closedShadow.length} component(s) with a closed shadow root were not audited: ${u.closedShadow.join(', ')}. Their contents cannot be read from the page; audit them in the component's own tests.`);
  if (u.crossOriginFrames.length) notes.push(`${u.crossOriginFrames.length} frame(s) from other origins were not audited: ${[...new Set(u.crossOriginFrames)].join(', ')}. Audit those origins separately.`);
  if (u.deepFrames) notes.push(`${u.deepFrames} frame(s) nested more than ${MAX_FRAME_DEPTH} levels deep were not audited.`);
  return notes;
}
