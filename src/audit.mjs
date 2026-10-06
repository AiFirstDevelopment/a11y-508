// Audit one page: navigate, run in-page checks, interactive passes, screenshots.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testInfo } from './checks/catalog.mjs';
import { listenerProbe, keyboardPass, disclosurePass, zoomPass } from './passes.mjs';

export async function auditPage(page, url, ctx) {
  const { opts } = ctx;
  const t0 = Date.now();
  const result = { url, finalUrl: url, status: null, title: '', error: null, skipped: null, timedOut: false, findings: [], info: null, passes: {}, errors: [] };
  const fingerprints = new Set();
  const add = (f) => {
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
    });
  };

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
  };

  try {
    await page.ensureInjected();
    result.info = await page.evaluate('window.__a11y508.pageInfo()');
    result.title = result.info.title;
    const base = await page.evaluate('window.__a11y508.run()');
    for (const f of base.findings) add(f);
    if (base.meta.errors && base.meta.errors.length) result.errors.push(...base.meta.errors.map((e) => `check: ${e}`));
    for (const [test, n] of Object.entries(base.meta.truncated || {})) result.errors.push(`${test}: ${n} additional finding(s) not listed (per-test cap)`);
    result.passes.static = { findings: base.findings.length, contrastChecked: base.meta.contrastChecked };

    try {
      await listenerProbe(page, base.meta, add);
    } catch (e) {
      result.errors.push(`listener probe: ${e.message}`);
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

    if (shoot) {
      let n = 0;
      for (const f of result.findings) {
        if (n >= opts.maxScreenshots) break;
        if (f.screenshot || !f.rect) continue;
        await shoot(f);
        if (f.screenshot) n++;
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
