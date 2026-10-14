// The start page's build, as the sorted <script src> / <link href> references it loads: what the
// fix loop compares to see a new deployment (deployed: bundle-change). A plain fetch first (cheap);
// when that fails or does not reach the app (an error status, no references, or a redirect to
// another host -- a sign-in portal), the page is loaded in the crawler's own headless Chrome with
// the crawl's way in (saved session, cookies, TOKEN header and storage) and read from the live DOM.
// Resolves { signature, via, portal } -- signature null when neither way could read the app; portal
// true when the browser, with the crawl's way in, still ended on another host (a sign-in portal: the
// saved session has expired, or there is none).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchChrome } from './chrome.mjs';
import { Page } from './page.mjs';
import { loadState } from './login.mjs';

const REFS = /<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi;
const TOKEN_KEYS = ['token', 'access_token', 'accessToken', 'id_token', 'idToken', 'jwt', 'auth_token', 'authToken'];

function tokenValue() {
  const t = (process.env.TOKEN || '').trim();
  if (!t) return null;
  const hasScheme = /^\S+\s+\S/.test(t);
  return { value: hasScheme ? t : `Bearer ${t}`, raw: hasScheme ? t.replace(/^\S+\s+/, '') : t };
}

async function byFetch(url) {
  try {
    const headers = {};
    const tok = tokenValue();
    if (tok) headers.authorization = tok.value;
    const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const html = await res.text();
    const refs = [...html.matchAll(REFS)].map((m) => m[1]).sort();
    const sameHost = (() => {
      try {
        return new URL(res.url || url).host === new URL(url).host;
      } catch {
        return false;
      }
    })();
    return { ok: res.ok && sameHost, signature: refs.join('\n'), app: res.ok && sameHost && refs.length > 0 };
  } catch {
    return { ok: false, signature: null, app: false };
  }
}

// The crawl options that say how a crawl gets in, read from the crawl's own arguments.
async function crawlOptions(url, args, cwd) {
  const { parseArgs } = await import('./cli.mjs');
  let o;
  try {
    o = parseArgs([url, ...args.map(String)]);
  } catch {
    o = parseArgs([url]);
  }
  const start = new URL(url);
  const origins = new Set([start.origin]);
  for (const a of o.authOrigins || []) {
    try {
      origins.add(new URL(a).origin);
    } catch {}
  }
  const tok = tokenValue();
  const keys = tok ? [...new Set([...(o.tokenStorage ? TOKEN_KEYS : []), ...(o.tokenStorageKeys || [])])] : [];
  const auth = tok ? { header: o.tokenHeader || 'Authorization', value: tok.value, origins, storage: keys.length ? { keys, value: tok.raw } : null } : null;
  let state = null;
  const file = o.stateFile || (o.login ? 'a11y-508-state.json' : null);
  if (file && existsSync(resolve(cwd, file))) {
    try {
      state = loadState(resolve(cwd, file));
    } catch {}
  }
  return {
    chrome: o.chrome, noSandbox: o.noSandbox,
    page: { viewport: o.viewport, auth, extraHeaders: o.extraHeaders || [], state, cookies: o.cookies || [], cookieOrigins: (o.cookies || []).length ? [...origins] : [], userAgent: o.userAgent, settle: o.settle },
  };
}

async function byBrowser(url, { args, cwd, timeout }) {
  let browser = null;
  let timer = null;
  const work = (async () => {
    const opts = await crawlOptions(url, args, cwd);
    browser = await launchChrome({ chromePath: opts.chrome, viewport: opts.page.viewport, noSandbox: opts.noSandbox, headless: true });
    const session = await browser.newPage();
    const page = new Page(session, opts.page);
    await page.init();
    const r = await page.goto(url, timeout);
    if (r.error || (r.status && r.status >= 400)) return { refs: null, portal: false };
    let host = null;
    try {
      host = new URL(r.finalUrl).host;
    } catch {}
    // Still on the sign-in portal: its build is not the app's.
    if (host !== new URL(url).host) return { refs: null, portal: true };
    const refs = await page.evaluate(`[...document.querySelectorAll('script[src], link[href]')].map((e) => e.getAttribute(e.tagName === 'SCRIPT' ? 'src' : 'href')).filter(Boolean).sort()`);
    return { refs: Array.isArray(refs) ? refs.join('\n') : null, portal: false };
  })();
  try {
    return await Promise.race([work, new Promise((r) => (timer = setTimeout(() => r({ refs: null, portal: false }), timeout)))]);
  } catch {
    return { refs: null, portal: false };
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
    // The launch may still be under way when the time runs out: close whatever it started.
    const b = browser || (await Promise.race([work.then(() => browser, () => browser), new Promise((r) => setTimeout(() => r(browser), 5000))]));
    if (b) await b.close({ fast: true }).catch(() => {});
  }
}

export async function bundleSignature(url, { args = [], cwd = process.cwd(), timeout = 30000 } = {}) {
  const f = await byFetch(url);
  if (f.app) return { signature: f.signature, via: 'fetch', portal: false };
  const b = await byBrowser(url, { args, cwd, timeout });
  if (b.refs !== null) return { signature: b.refs, via: 'browser', portal: false };
  // The page answered on its own host but loads no scripts or styles: that is its build.
  if (f.ok) return { signature: f.signature, via: 'fetch', portal: false };
  return { signature: null, via: null, portal: b.portal };
}
