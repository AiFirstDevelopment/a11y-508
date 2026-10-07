// --troubleshoot: load only the start URL with the configured auth and explain
// what happened. Records every main-frame navigation hop (HTTP redirects and
// script-driven navigations), whether the auth header actually went out, the
// web storage keys and cookies the app's own scripts touched before leaving,
// what is in storage and the cookie jar afterwards, and ends with a verdict
// and the next thing to try. Nothing is audited and no report is written.

import { Page } from './page.mjs';

const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|logon|sso|oidc|saml|auth)(\/|$|\?)/i;
const BINDING = '__a11y508_diag';

// Runs before any page script: wraps web storage and document.cookie so the
// app's reads and writes are reported over a CDP binding, with keys only.
const PROBE = `(() => {
  const send = (store, op, key) => { try { window.${BINDING}(JSON.stringify({ store, op, key: String(key), url: location.href })); } catch {} };
  const P = Storage.prototype;
  for (const op of ['getItem', 'setItem', 'removeItem']) {
    const orig = P[op];
    P[op] = function (key, ...rest) {
      let which = 'storage';
      try { which = this === window.localStorage ? 'localStorage' : this === window.sessionStorage ? 'sessionStorage' : 'storage'; } catch {}
      send(which, op, key);
      return orig.call(this, key, ...rest);
    };
  }
  const cd = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cd && cd.get && cd.set) Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    get() { send('cookie', 'read', ''); return cd.get.call(this); },
    set(v) { send('cookie', 'write', String(v).split('=')[0].trim()); return cd.set.call(this, v); },
  });
})();`;

const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname + x.search;
  } catch {
    return String(u);
  }
};

export async function troubleshoot({ browser, startUrl, opts }) {
  const session = await browser.newPage();
  const page = new Page(session, opts);
  await page.init();
  const s = session;
  const startOrigin = new URL(startUrl).origin;
  const auth = opts.auth;
  const authOrigins = auth ? new Set(auth.origins) : new Set([startOrigin]);

  const hops = [];
  const access = [];
  const urls = new Map(); // requestId -> url
  const authSeen = { withHeader: 0, without: 0, documentWithHeader: null };
  let firstLoaderId = null;

  s.on('Network.requestWillBeSent', (p) => {
    urls.set(p.requestId, p.request.url);
    if (p.type !== 'Document' || p.frameId !== page.mainFrameId) return;
    if (firstLoaderId === null) firstLoaderId = p.loaderId;
    if (p.redirectResponse) {
      hops.push({ kind: 'redirect', from: p.redirectResponse.url, status: p.redirectResponse.status, to: p.request.url });
    } else {
      const initiator = (p.initiator && p.initiator.type) || 'other';
      hops.push({ kind: p.loaderId === firstLoaderId ? 'start' : 'navigation', url: p.request.url, initiator });
    }
  });
  s.on('Network.responseReceived', (p) => {
    if (p.type === 'Document' && p.frameId === page.mainFrameId) hops.push({ kind: 'response', url: p.response.url, status: p.response.status, mimeType: p.response.mimeType });
  });
  s.on('Network.requestWillBeSentExtraInfo', (p) => {
    const url = urls.get(p.requestId);
    if (!url) return;
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {}
    if (!authOrigins.has(origin)) return;
    const name = (auth ? auth.header : 'authorization').toLowerCase();
    const has = Object.keys(p.headers || {}).some((h) => h.toLowerCase() === name);
    if (has) authSeen.withHeader++;
    else authSeen.without++;
    if (authSeen.documentWithHeader === null && hops.some((h) => h.kind === 'start' && h.url === url)) authSeen.documentWithHeader = has;
  });
  await s.send('Runtime.addBinding', { name: BINDING });
  s.on('Runtime.bindingCalled', (p) => {
    if (p.name !== BINDING) return;
    try {
      access.push(JSON.parse(p.payload));
    } catch {}
  });
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

  const nav = await page.goto(startUrl, opts.timeout);

  let final = { url: nav.finalUrl || startUrl, title: '', links: 0, textLength: 0, storage: { local: [], session: [] } };
  if (!nav.error) {
    try {
      final = {
        ...final,
        ...(await page.evaluate(
          `(() => { const keys = (st) => { const o = []; try { for (let i = 0; i < st.length; i++) o.push(st.key(i)); } catch {} return o; };
            return { url: location.href, title: document.title, links: document.querySelectorAll('a[href]').length, textLength: (document.body && document.body.innerText || '').trim().length, storage: { local: keys(localStorage), session: keys(sessionStorage) } }; })()`
        )),
      };
    } catch {}
  }
  let cookies = [];
  try {
    ({ cookies } = await s.send('Network.getAllCookies'));
  } catch {}
  cookies = cookies.map((c) => ({ name: c.name, domain: c.domain, httpOnly: !!c.httpOnly, secure: !!c.secure }));
  await browser.closePage(session).catch(() => {});

  // Summarize storage access: keys read before the page left (or ever).
  const reads = {};
  const writes = {};
  let cookieReads = 0;
  const cookieWrites = new Set();
  for (const a of access) {
    if (a.store === 'cookie') {
      if (a.op === 'read') cookieReads++;
      else cookieWrites.add(a.key);
      continue;
    }
    const bucket = a.op === 'getItem' ? reads : writes;
    (bucket[a.store] ||= new Set()).add(a.key);
  }
  const seeded = new Set(auth && auth.storage ? auth.storage.keys : []);
  for (const st of Object.values((opts.state && opts.state.storage) || {})) for (const k of [...Object.keys(st.local || {}), ...Object.keys(st.session || {})]) seeded.add(k);
  const readKeys = (store) => [...(reads[store] || [])].map((k) => ({ key: k, seeded: seeded.has(k), present: (store === 'localStorage' ? final.storage.local : final.storage.session).includes(k) }));

  // Verdict.
  let finalOrigin = '';
  let finalPath = '';
  try {
    finalOrigin = new URL(final.url).origin;
    finalPath = new URL(final.url).pathname;
  } catch {}
  const firstResponse = hops.find((h) => h.kind === 'response' || h.kind === 'redirect');
  const serverRedirectedFirst = firstResponse && firstResponse.kind === 'redirect';
  const scriptHop = hops.find((h) => h.kind === 'navigation' && h.initiator === 'script');
  const keysRead = [...readKeys('localStorage').map((k) => 'localStorage.' + k.key), ...readKeys('sessionStorage').map((k) => 'sessionStorage.' + k.key)];
  const unseeded = [...readKeys('localStorage'), ...readKeys('sessionStorage')].filter((k) => !k.seeded && !k.present).map((k) => k.key);
  let verdict;
  let next;
  let ok = false;
  if (nav.error) {
    verdict = `The start URL could not be loaded: ${nav.error}${nav.retries ? ` (after ${nav.retries} retries)` : ''}.`;
    next = 'Check that the URL is reachable from this machine (VPN, proxy, DNS). net::ERR_SOCKET_NOT_CONNECTED and ERR_CONNECTION_RESET usually mean a proxy or VPN dropped the connection.';
  } else if (finalOrigin !== startOrigin) {
    if (serverRedirectedFirst) {
      verdict = `The server answered the very first request with HTTP ${firstResponse.status} to ${shortUrl(firstResponse.to)} before any page script ran, and the browser ended up on ${shortUrl(final.url)}.`;
      next = 'A bearer token or a web storage key cannot change a server-side redirect; the server wants its own session cookie. Run once with --login-only, sign in in the window that opens, then crawl with --state a11y-508-state.json.';
    } else {
      verdict = `The start page loaded (HTTP ${nav.status}), then its own script navigated to ${scriptHop ? shortUrl(scriptHop.url) : 'another page'} and the browser ended up on ${shortUrl(final.url)}, off the start origin.`;
      next = unseeded.length
        ? `Before leaving, the app read ${unseeded.map((k) => `"${k}"`).join(', ')} from web storage and found nothing there. If that is where it keeps its token, add --token-storage ${unseeded[0]} (repeat for others). If the app needs more than a raw token (an SSO session, a JSON blob), run once with --login-only and crawl with --state.`
        : `The app did not find what it needs in web storage${keysRead.length ? ` (it read ${keysRead.join(', ')})` : ''}${cookieReads ? ' and read document.cookie' : ''}. Run once with --login-only, sign in in the window that opens, then crawl with --state a11y-508-state.json.`;
    }
  } else if (scriptHop && shortUrl(final.url) !== shortUrl(startUrl)) {
    verdict = `The start page loaded, then its own script navigated to ${shortUrl(scriptHop.url)}${nav.status && nav.status >= 400 ? ` (which answered HTTP ${nav.status})` : ''}${LOGIN_PATH.test(finalPath) ? ', a sign-in page' : ''}.`;
    next = unseeded.length
      ? `Before leaving, the app read ${unseeded.map((k) => `"${k}"`).join(', ')} from web storage and found nothing there. If that is where it keeps its token, add --token-storage ${unseeded[0]} (repeat for others). If the app needs more than a raw token (an SSO session, a JSON blob), run once with --login-only and crawl with --state.`
      : `The app did not find what it needs${keysRead.length ? ` (it read ${keysRead.join(', ')})` : ' in web storage'}${cookieReads ? ' and read document.cookie' : ''}. Run once with --login-only, sign in in the window that opens, then crawl with --state a11y-508-state.json.`;
  } else if (nav.status && nav.status >= 400) {
    verdict = `The start URL answered HTTP ${nav.status}.`;
    next = nav.status === 401 || nav.status === 403
      ? auth
        ? `The ${auth.header} header was ${authSeen.documentWithHeader === false ? 'NOT ' : ''}sent on the page request; the server rejected it. Check that TOKEN is current and meant for this host, and --token-header if the server expects a different header name.`
        : 'No TOKEN is set. Export TOKEN=<token> or, for a session-based app, run once with --login-only.'
      : 'Check the URL; the crawl needs a page that returns 200.';
  } else if (LOGIN_PATH.test(finalPath)) {
    verdict = `The browser ended up on the app's own sign-in page ${shortUrl(final.url)}.`;
    next = 'Run once with --login-only, sign in in the window that opens, then crawl with --state a11y-508-state.json.';
  } else {
    ok = true;
    verdict = `Landed on ${shortUrl(final.url)} ("${final.title}"), HTTP ${nav.status}, ${final.links} link(s), ${final.textLength} characters of text. Authentication is working.`;
    next = final.links === 0
      ? 'No links were found, so a crawl would stop after this page. If the app renders after a delay, raise --settle (for example --settle 3000). Otherwise run the crawl.'
      : 'Run the crawl with the same options.';
  }

  return {
    ok,
    startUrl,
    auth: auth
      ? { header: auth.header, origins: [...auth.origins], seededKeys: auth.storage ? auth.storage.keys : [], sentOn: authSeen.withHeader, missingOn: authSeen.without, onDocument: authSeen.documentWithHeader }
      : null,
    session: opts.state ? { cookies: opts.state.cookies.length, origins: Object.keys(opts.state.storage || {}) } : null,
    navigation: { hops, retries: nav.retries || 0, error: nav.error || null, status: nav.status, timedOut: !!nav.timedOut, final: { url: final.url, title: final.title, links: final.links, textLength: final.textLength } },
    storage: { read: { localStorage: readKeys('localStorage'), sessionStorage: readKeys('sessionStorage') }, written: { localStorage: [...(writes.localStorage || [])], sessionStorage: [...(writes.sessionStorage || [])] }, present: final.storage, cookieReads, cookieWrites: [...cookieWrites] },
    cookies,
    verdict,
    next,
  };
}

export function formatTroubleshoot(r) {
  const lines = [];
  const list = (a) => (a.length ? a.join(', ') : '(none)');
  lines.push(`a11y-508 troubleshoot  ${r.startUrl}`);
  lines.push('');
  if (r.auth) {
    lines.push(`auth       ${r.auth.header} header on ${r.auth.origins.join(', ')}`);
    lines.push(`           sent on ${r.auth.sentOn} request(s) to those origins${r.auth.missingOn ? `, missing on ${r.auth.missingOn}` : ''}${r.auth.onDocument === false ? ' (NOT on the page request itself)' : ''}`);
    lines.push(`           TOKEN seeded into web storage as ${list(r.auth.seededKeys)}`);
  } else lines.push('auth       no TOKEN set');
  lines.push(`session    ${r.session ? `${r.session.cookies} cookie(s) and web storage for ${r.session.origins.join(', ')} from --state` : 'none (no --state)'}`);
  lines.push('');
  lines.push('navigation');
  let n = 0;
  for (const h of r.navigation.hops) {
    if (h.kind === 'start') lines.push(`  ${++n}. GET ${shortUrl(h.url)}`);
    else if (h.kind === 'redirect') lines.push(`     -> HTTP ${h.status} redirect to ${shortUrl(h.to)}`);
    else if (h.kind === 'response') lines.push(`     -> HTTP ${h.status} ${h.mimeType || ''}`);
    else lines.push(`  ${++n}. ${h.initiator === 'script' ? 'page script navigated to' : 'navigated to'} ${shortUrl(h.url)}`);
  }
  if (r.navigation.error) lines.push(`  error: ${r.navigation.error}`);
  if (r.navigation.retries) lines.push(`  (${r.navigation.retries} transient error(s) retried)`);
  lines.push(`  landed on ${shortUrl(r.navigation.final.url)}  title "${r.navigation.final.title}"  ${r.navigation.final.links} link(s)`);
  lines.push('');
  lines.push('web storage the app read (seeded = written by a11y-508 before load, present = there after load)');
  const fmt = (ks) => (ks.length ? ks.map((k) => `${k.key}${k.seeded ? ' [seeded]' : ''}${k.present ? ' [present]' : ' [missing]'}`).join(', ') : '(none)');
  lines.push(`  localStorage:   ${fmt(r.storage.read.localStorage)}`);
  lines.push(`  sessionStorage: ${fmt(r.storage.read.sessionStorage)}`);
  lines.push(`  written by the app: ${list([...r.storage.written.localStorage.map((k) => 'localStorage.' + k), ...r.storage.written.sessionStorage.map((k) => 'sessionStorage.' + k)])}`);
  lines.push(`  document.cookie: read ${r.storage.cookieReads} time(s)${r.storage.cookieWrites.length ? `, wrote ${list(r.storage.cookieWrites)}` : ''}`);
  lines.push(`  keys present after load: localStorage ${list(r.storage.present.local)}; sessionStorage ${list(r.storage.present.session)}`);
  lines.push('');
  lines.push(`cookies    ${r.cookies.length ? r.cookies.map((c) => `${c.name}@${c.domain}${c.httpOnly ? ' (httpOnly)' : ''}`).join(', ') : '(none)'}`);
  lines.push('');
  lines.push(`verdict    ${r.verdict}`);
  lines.push(`next       ${r.next}`);
  return lines.join('\n') + '\n';
}
