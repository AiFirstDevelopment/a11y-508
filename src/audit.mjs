// Audit one page: navigate, run in-page checks, interactive passes, screenshots.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEYOND, testInfo } from './checks/catalog.mjs';
import { listenerProbe, keyboardPass, disclosurePass, zoomPass, spacingPass, reflowPass, routeDiscoveryPass, modalOnLoadPass, redismissModal } from './passes.mjs';

// The selector of the page-level 13.C item set by 60-sensory-contrast.js.
const BETWEEN_IMAGES = 'text over images';

export async function auditPage(page, url, ctx) {
  const { opts } = ctx;
  const t0 = Date.now();
  const result = { url, finalUrl: url, status: null, title: '', error: null, skipped: null, timedOut: false, findings: [], info: null, passes: {}, errors: [] };
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
      screenshot: f.screenshot,
      // Only beyond-508 findings carry the key, so a default report.json keeps its shape.
      beyond508: f.beyond508 || BEYOND[f.test] ? true : undefined,
    });
  };
  const beyond = !!opts.wcag && opts.wcag !== '2.0';

  let nav;
  try {
    nav = await page.goto(url, opts.timeout);
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
    result.error = `HTTP ${nav.status}`;
    if (nav.status === 401 || nav.status === 403) result.error += opts.auth ? ' (TOKEN was sent; check that it is valid for this site)' : ' (no TOKEN set; export TOKEN=... to authenticate)';
    result.durationMs = Date.now() - t0;
    return result;
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
  };

  try {
    await page.ensureInjected();
    result.info = await page.evaluate('window.__a11y508.pageInfo()');
    result.title = result.info.title;
    // A modal dialog open on load (a cookie or consent banner) hides the page from every check.
    const modal = await page.evaluate('window.__a11y508.modalOnLoad()');
    let base = await page.evaluate('window.__a11y508.run()');
    for (const f of base.findings) add(f);
    if (base.meta.errors && base.meta.errors.length) result.errors.push(...base.meta.errors.map((e) => `check: ${e}`));
    for (const [test, n] of Object.entries(base.meta.truncated || {})) result.errors.push(`${test}: ${n} additional finding(s) not listed (per-test cap)`);
    result.passes.static = { findings: base.findings.length, contrastChecked: base.meta.contrastChecked, scrollRestored: base.meta.scrollRestored };
    if (modal) {
      const behind = await modalOnLoadPass(page, add, fingerprints);
      result.modalOnLoad = { ...modal, dismissed: behind.dismissed };
      if (behind.run) {
        result.passes.static.behindModal = behind.added;
        result.passes.static.scrollRestored = result.passes.static.scrollRestored && behind.run.meta.scrollRestored;
        if (behind.run.meta.errors && behind.run.meta.errors.length) result.errors.push(...behind.run.meta.errors.map((e) => `check: ${e}`));
        base = behind.run;
      }
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
        result.passes.keyboard = await keyboardPass(page, add, opts);
        if (result.passes.keyboard.navigated) await reload();
      } catch (e) {
        result.errors.push(`keyboard pass: ${e.message}`);
      }
      try {
        result.passes.disclosure = await disclosurePass(page, add, fingerprints, opts, reload);
      } catch (e) {
        result.errors.push(`disclosure pass: ${e.message}`);
      }
    }

    const shoot = opts.screenshots ? makeShooter(page, ctx, result) : null;
    if (opts.zoom) {
      try {
        result.passes.zoom = await zoomPass(page, add, shoot);
      } catch (e) {
        result.errors.push(`zoom pass: ${e.message}`);
      }
    }
    // Beyond-508 profile only, so a default run costs nothing extra.
    if (beyond) {
      try {
        result.passes.spacing = await spacingPass(page, add, shoot);
      } catch (e) {
        result.errors.push(`text spacing pass: ${e.message}`);
      }
      try {
        result.passes.reflow = await reflowPass(page, add);
      } catch (e) {
        result.errors.push(`reflow pass: ${e.message}`);
      }
    }

    if (shoot) {
      let n = 0;
      for (const f of result.findings) {
        if (n >= opts.maxScreenshots) break;
        if (f.screenshot || !f.rect) continue;
        await shoot(f);
        if (f.screenshot) n++;
      }
    }
    // Last, because it clicks around and reloads: find pages reachable only
    // through click handlers so the crawler can queue them.
    if (opts.followClicks && opts.maxClicks > 0) {
      try {
        await reload();
        result.discovery = await routeDiscoveryPass(page, base.meta, opts, reload, ctx.origin);
      } catch (e) {
        result.errors.push(`route discovery: ${e.message}`);
      }
    }
  } catch (e) {
    result.error = `audit failed: ${e.message}`;
  }

  result.durationMs = Date.now() - t0;
  return result;
}

function makeShooter(page, ctx, result) {
  const dir = join(ctx.outDir, 'screenshots');
  mkdirSync(dir, { recursive: true });
  let counter = 0;
  const pageIdx = ctx.nextPageIndex();
  return async (f) => {
    if (!f.rect || f.rect.width < 1 || f.rect.height < 1) return;
    try {
      const png = await page.screenshot(f.rect);
      if (!png) return;
      const name = `p${pageIdx}-${++counter}.png`;
      writeFileSync(join(dir, name), png);
      f.screenshot = `screenshots/${name}`;
    } catch (e) {
      result.errors.push(`screenshot: ${e.message}`);
    }
  };
}
