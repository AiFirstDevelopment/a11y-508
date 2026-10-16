// The start page's build, as the sorted <script src> / <link href> references it loads: what the
// fix loop compares to see a new deployment (deployed: bundle-change). A plain fetch first (cheap);
// when that fails or does not reach the app (an error status, no references, or a redirect to
// another host -- a sign-in portal), the page is loaded in the crawler's own headless Chrome with
// the crawl's way in (saved session, cookies, TOKEN header and storage) and read from the live DOM.
// Resolves { signature, via, portal } -- signature null when neither way could read the app; portal
// true when the browser, with the crawl's way in, still ended on another host (a sign-in portal: the
// saved session has expired, or there is none).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchChrome } from './chrome.mjs';
import { Page } from './page.mjs';
import { loadState } from './login.mjs';

const REFS = /<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi;
// The build marker the fix loop commits into the app's index.html with each round it pushes (src/loop.mjs
// stampBuildMarker): <meta name="a11y-508-build" content="r12-abc">. A build that serves it is one
// made from that push, so the loop verifies against the right build, not an earlier one the pipeline
// finished late.
export const MARKER_NAME = 'a11y-508-build';
const MARKER = /<meta\b[^>]*\bname=["']a11y-508-build["'][^>]*\bcontent=["']([^"']+)["'][^>]*>|<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']a11y-508-build["'][^>]*>/i;
export function markerIn(html) {
  const m = MARKER.exec(String(html || ''));
  return m ? m[1] || m[2] || null : null;
}
// The signature is one line per script or stylesheet reference the start page loads: the reference
// and a hash of what it serves, so a deployment that keeps its file names (a build without output
// hashing) is seen as well as one that renames them. Other links (icons, manifests) carry "?", as
// does a reference that could not be read; the hashes cover up to MAX_ASSETS same-origin files.
const MAX_ASSETS = 12;
const MAX_BYTES = 4 * 1024 * 1024;
const STYLE = /<link[^>]+rel=["'][^"']*stylesheet/i;
const sha = (text) => createHash('sha256').update(String(text).slice(0, MAX_BYTES)).digest('hex');
async function hashedLines(html, refs, base, headers) {
  const assets = new Set();
  for (const m of html.matchAll(/<(script|link)[^>]*>/gi)) {
    const ref = /(?:src|href)=["']([^"']+)["']/i.exec(m[0]);
    if (ref && (m[1].toLowerCase() === 'script' || STYLE.test(m[0]))) assets.add(ref[1]);
  }
  const lines = [];
  let read = 0;
  for (const ref of refs) {
    let h = '?';
    try {
      const u = new URL(ref, base);
      if (assets.has(ref) && u.origin === new URL(base).origin && read < MAX_ASSETS) {
        read++;
        const r = await fetch(u.href, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (r.ok) h = sha(await r.text());
      }
    } catch {}
    lines.push(`${ref} ${h}`);
  }
  return lines.join('\n');
}

// Whether a signature carries content hashes (one an earlier version wrote has names only).
export function hasHashes(sig) {
  return typeof sig === 'string' && /(^|\n)\S+ [0-9a-f]{64}(\n|$)/.test(sig);
}

// Whether two signatures are the same build. A reference whose hash is unknown on either side ("?",
// or a names-only signature an earlier version recorded) compares by its name.
export function sameBuild(a, b) {
  if (a == null || b == null) return a === b;
  const parse = (sig) => new Map(String(sig).split('\n').filter(Boolean).map((l) => {
    const i = l.lastIndexOf(' ');
    return i > 0 && /^(?:[0-9a-f]{64}|\?)$/.test(l.slice(i + 1)) ? [l.slice(0, i), l.slice(i + 1)] : [l, '?'];
  }));
  const x = parse(a);
  const y = parse(b);
  if (x.size !== y.size) return false;
  for (const [ref, h] of x) {
    if (!y.has(ref)) return false;
    const g = y.get(ref);
    if (h !== '?' && g !== '?' && h !== g) return false;
  }
  return true;
}
const TOKEN_KEYS = ['token', 'access_token', 'accessToken', 'id_token', 'idToken', 'jwt', 'auth_token', 'authToken'];

function tokenValue() {
  const t = (process.env.TOKEN || '').trim();
  if (!t) return null;
  const hasScheme = /^\S+\s+\S/.test(t);
  return { value: hasScheme ? t : `Bearer ${t}`, raw: hasScheme ? t.replace(/^\S+\s+/, '') : t };
}

async function byFetch(url) {
  try {
    const headers = { 'cache-control': 'no-cache', pragma: 'no-cache' };
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
    const app = res.ok && sameHost && refs.length > 0;
    const marker = app ? markerIn(html) : null;
    const reason = !sameHost ? `a plain request is sent to ${new URL(res.url || url).host}` : !res.ok ? `a plain request gets HTTP ${res.status}` : null;
    return { ok: res.ok && sameHost, signature: app ? await hashedLines(html, refs, res.url || url, headers) : refs.join('\n'), app, reason, marker };
  } catch (e) {
    return { ok: false, signature: null, app: false, reason: `a plain request fails (${e && e.message ? e.message : e})` };
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
    // Never an old copy: no browser cache, and every request asks caches on the way (a CDN, a proxy)
    // for a fresh answer.
    try {
      await session.send('Network.enable');
      await session.send('Network.setCacheDisabled', { cacheDisabled: true });
      await session.send('Network.setExtraHTTPHeaders', { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
    } catch {}
    // The page's own load gets most of the time; the launch and the hashing share the rest.
    const r = await page.goto(url, Math.max(10000, timeout - 20000));
    if (r.error) return { refs: null, portal: false, reason: `the page did not load (${r.error})` };
    if (r.timedOut) return { refs: null, portal: false, reason: 'the page did not finish loading in time' };
    // A gateway that answers 401 or 403 wants a sign-in, like a portal that the page is sent to. Any
    // other status is no verdict: a single-page app's deep link is often served with a 404 and
    // renders all the same, so the page is read for what it loads.
    if (r.status === 401 || r.status === 403) return { refs: null, portal: true, reason: `the browser gets HTTP ${r.status}, so a sign-in is needed` };
    let host = null;
    try {
      host = new URL(r.finalUrl).host;
    } catch {}
    // Still on the sign-in portal: its build is not the app's.
    if (host !== new URL(url).host) return { refs: null, portal: true, reason: `the browser is sent to ${host || 'another host'} (a sign-in portal)` };
    // The same lines as the fetch path, read in the page (its session and headers apply to the fetches).
    const refs = await page.evaluate(`(async () => {
      const els = [...document.querySelectorAll('script[src], link[href]')];
      const refOf = (e) => e.getAttribute(e.tagName === 'SCRIPT' ? 'src' : 'href');
      const assets = new Set(els.filter((e) => e.tagName === 'SCRIPT' || /\\bstylesheet\\b/i.test(e.getAttribute('rel') || '')).map(refOf));
      const refs = els.map(refOf).filter(Boolean).sort();
      const hash = async (text) => {
        const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.slice(0, ${MAX_BYTES})));
        return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
      };
      const lines = [];
      let read = 0;
      for (const ref of refs) {
        let h = '?';
        try {
          const u = new URL(ref, location.href);
          if (assets.has(ref) && u.origin === location.origin && read < ${MAX_ASSETS}) {
            read++;
            const r = await fetch(u.href, { credentials: 'include', cache: 'no-store' });
            if (r.ok) h = await hash(await r.text());
          }
        } catch {}
        lines.push(ref + ' ' + h);
      }
      const meta = document.querySelector('meta[name="a11y-508-build"]');
      return JSON.stringify({ lines: lines.join('\\n'), marker: meta ? meta.getAttribute('content') : null });
    })()`, { awaitPromise: true });
    let read = null;
    try {
      read = JSON.parse(refs);
    } catch {}
    if (read && typeof read.lines === 'string' && read.lines) return { refs: read.lines, portal: false, reason: null, marker: read.marker || null };
    return { refs: null, portal: false, reason: `${r.status && r.status >= 400 ? `the browser gets HTTP ${r.status} and ` : ''}the page loads no scripts or stylesheets` };
  })();
  try {
    return await Promise.race([work, new Promise((r) => (timer = setTimeout(() => r({ refs: null, portal: false, reason: `the check ran out of time (${Math.round(timeout / 1000)} s)` }), timeout)))]);
  } catch (e) {
    return { refs: null, portal: false, reason: `the browser could not check it (${e && e.message ? e.message : e})` };
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
    // The launch may still be under way when the time runs out: close whatever it started.
    const b = browser || (await Promise.race([work.then(() => browser, () => browser), new Promise((r) => setTimeout(() => r(browser), 5000))]));
    if (b) await b.close({ fast: true }).catch(() => {});
  }
}

// Resolves { signature, via, portal, reason, marker }: reason says, in words, why there is no
// signature; marker is the build marker the page serves (null when none).
export async function bundleSignature(url, { args = [], cwd = process.cwd(), timeout = 90000 } = {}) {
  const f = await byFetch(url);
  if (f.app) return { signature: f.signature, via: 'fetch', portal: false, reason: null, marker: f.marker || null };
  const b = await byBrowser(url, { args, cwd, timeout });
  if (b.refs !== null) return { signature: b.refs, via: 'browser', portal: false, reason: null, marker: b.marker || null };
  // The page answered on its own host but loads no scripts or styles: that is its build.
  if (f.ok) return { signature: f.signature, via: 'fetch', portal: false, reason: null, marker: f.marker || null };
  return { signature: null, via: null, portal: b.portal, reason: [b.reason, f.reason].filter(Boolean).join('; ') || null, marker: null };
}
