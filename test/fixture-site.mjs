// The fixture site the tests crawl: every request needs the bearer token,
// plus a second origin that serves an external image and records whether the
// token leaked to it. Shared by test/run.mjs and the dashboard's Playwright
// harness (ui/e2e/), and runnable on its own:
//
//   node test/fixture-site.mjs [--port 4100] [--auto-login]
//
// autoLogin mode stands in for a sign-in portal: a request without the token
// or the session cookie is sent to /login.html, which waits a second, sets the
// session cookie and the web storage keys app.html expects, and returns to /.
// In that mode the session cookie is accepted in place of the bearer header,
// and app.html expects the session value, never the token, so a saved session
// file holds no token.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
export const TOKEN = 'fixture-token-123';
export const COOKIE = 'fixture-cookie-456';
export const SESSION_COOKIE = 'fixture_session';
export const SESSION_VALUE = 'fixture-session-789';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

// A valid WAV of silence: RIFF header plus 8 kHz, 8-bit mono samples (128 is silence).
// /media/<name>-<n>s.wav is n seconds long, so no binary needs to be committed.
export function silentWav(seconds) {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + samples, 128);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples, 40);
  return buf;
}

const LOGIN_PAGE = (value) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in - a11y-508 test site</title></head>
<body>
<main><h1>Signing you in</h1><p>This stands in for a sign-in portal. It signs in by itself after a second.</p></main>
<script>
  setTimeout(function () {
    document.cookie = '${SESSION_COOKIE}=${value}; path=/';
    localStorage.setItem('access_token', '${value}');
    sessionStorage.setItem('id_token', '${value}');
    localStorage.setItem('fixture_custom_key', '${value}');
    localStorage.setItem('state_key', 'from-state');
    sessionStorage.setItem('state_session_key', 'from-state');
    location.replace('/');
  }, 1000);
</script>
</body>
</html>`;

// A chain of frames four deep for checks-frames.html: each holds the next, and the fourth an image
// with no alt, which is past the depth the crawler audits.
const nested = (n) => `<!doctype html><html lang="en"><title>Nested frame ${n}</title><body style="margin:0"><p>Frame ${n}.</p>${
  n < 4 ? `<iframe src="/frames/d${n + 1}.html" title="Nested frame ${n + 1}" id="d${n + 1}" width="${420 - n * 40}" height="${360 - n * 80}" style="border:1px solid #888"></iframe>` : '<img src="/img/deep.png" width="40" height="40">'
}</body></html>`;
const FRAMES = {
  '/frames/text.html': '<!doctype html><html lang="en"><title>Frame text</title><p>Plain text in a frame, with nothing to focus.</p></html>',
  '/frames/link.html': '<!doctype html><html lang="en"><title>Frame with a link</title><p>Office hours are 9 to 5. <a href="/about.html" id="frame-link">About the office</a></p></html>',
  // checks-frames.html (round 5): no lang, an image with no alt, an unlabelled field, a button with
  // no focus style, a custom disclosure control that ignores Enter and Space, and a web component
  // holding another image with no alt.
  '/frames/form.html': `<!doctype html><html><head><title>Payment form</title><style>body { font-family: sans-serif; margin: 8px; color: #222; background: #fff; } button { outline: none; border: 1px solid #333; background: #fff; color: #222; padding: 4px 10px; font: inherit; } input:focus { outline: 3px solid #f90; }</style></head>
<body><p><img src="/img/card-logo.png" id="ff-logo" width="40" height="24"> Pay by card</p><p><input type="text" id="ff-card"></p><p><button type="button" id="ff-pay">Pay now</button></p><div role="button" tabindex="0" aria-expanded="false" id="ff-more" style="outline: 2px solid transparent">More options</div><pay-badge id="ff-badge"></pay-badge>
<script>customElements.define('pay-badge', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<img src="/img/badge.png" width="24" height="24">'; } });</script></body></html>`,
  '/frames/outer.html': '<!doctype html><html lang="en"><title>Partner offers</title><body style="margin:8px"><p>Offers from our partners.</p><iframe src="/frames/inner.html" title="Offer of the week" id="fr-inner" width="360" height="120" style="border:1px solid #888"></iframe></body></html>',
  // The button has no focus style: the Tab pass reaches it through two frames (follow-up round item 7).
  '/frames/inner.html': '<!doctype html><html lang="en"><title>Offer of the week</title><body style="margin:8px"><p>This week only.</p><img src="/img/offer.png" width="40" height="40"> <button type="button" id="fi-claim" style="outline:none;border:1px solid #333;background:#fff;color:#222">Claim the offer</button></body></html>',
  // Follow-up round item 7: text whose color lies between an image's bounds, inside a frame, and an
  // image with alt text for the frame's 7.A inventory.
  '/frames/between.html': '<!doctype html><html lang="en"><head><title>Photo caption</title><style>body { font-family: sans-serif; margin: 8px; background: #fff; } .photo { background: #fff url(/img/photo.png) center / cover; padding: 12px; } p { font-size: 16px; margin: 4px 0; }</style></head><body><div class="photo"><p id="fb-between" style="color:#767676">Mid grey caption inside the frame</p></div><img id="fb-photo" src="/img/harbour.png" alt="Harbour at dawn" width="40" height="40"></body></html>',
  '/frames/d1.html': nested(1),
  '/frames/d2.html': nested(2),
  '/frames/d3.html': nested(3),
  '/frames/d4.html': nested(4),
  '/frames/tiny.html': '<!doctype html><html lang="en"><title>Small frame</title><body><img src="/img/tiny.png" id="ft-img" width="40" height="40"></body></html>',
  '/frames/modal-behind.html': '<!doctype html><html lang="en"><title>Account summary</title><body><p>Your balance.</p><img src="/img/balance.png" id="fm-img" width="40" height="40"></body></html>',
};

const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolve();
  });
});

// A date as a search form sends it: ISO (2026-07-13) or MM/DD/YYYY.
function parseDate(s) {
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

export async function startFixtureSite({ port = 0, host = '127.0.0.1', token = TOKEN, autoLogin = false, dropForms = 2 } = {}) {
  const state = { externalHits: [], unauthorized: [], cookieHeaders: [], dangerHits: [], searches: [], deleteHits: [], dropsLeft: dropForms };

  const external = createServer((req, res) => {
    state.externalHits.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await listen(external, 0, host);
  const externalUrl = `http://${host}:${external.address().port}/pixel.png`;
  const appValue = autoLogin ? SESSION_VALUE : token;

  const site = createServer((req, res) => {
    if (req.headers.cookie) state.cookieHeaders.push(req.headers.cookie);
    let path = new URL(req.url, 'http://x').pathname;
    if (autoLogin && path === '/login.html') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(LOGIN_PAGE(SESSION_VALUE));
    }
    const bearer = req.headers.authorization === `Bearer ${token}`;
    const session = autoLogin && new RegExp(`(^|;\\s*)${SESSION_COOKIE}=${SESSION_VALUE}(;|$)`).test(req.headers.cookie || '');
    if (!bearer && !session) {
      state.unauthorized.push(req.url);
      if (autoLogin && (path === '/' || extname(path) === '.html')) {
        res.writeHead(302, { location: '/login.html' });
        return res.end();
      }
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('unauthorized');
    }
    if (path === '/danger') {
      state.dangerHits.push(req.method);
      res.writeHead(204);
      return res.end();
    }
    // search.html: results only for a range reaching back two months or more; every search recorded.
    if (path === '/api/search' || path === '/search-results.html') {
      const q = new URL(req.url, 'http://x').searchParams;
      const from = parseDate(q.get('from'));
      const ok = !!from && Date.now() - from.getTime() >= 59 * 24 * 3600 * 1000;
      state.searches.push({ form: path === '/api/search' ? 'date' : 'text', from: q.get('from'), to: q.get('to'), ok });
      if (path === '/api/search') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(ok ? [
          { url: '/result-1.html', title: 'Case 1', opened: 'March', link: true },
          { url: '/result-2.html', title: 'Case 2', opened: 'April', link: true },
          { url: '/result-3.html', title: 'Case 3', opened: 'May', link: false },
        ] : []));
      }
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search results - a11y-508 test site</title></head><body><main><h1>Search results</h1>${ok ? '<ul><li><a href="/result-5.html">Case 5</a></li><li><a href="/result-6.html">Case 6</a></li></ul>' : '<p>No cases found.</p>'}</main></body></html>`);
    }
    // The search-preset fixtures (search-combo, -widest, -buttons, -material): each submit is recorded
    // with the preset's span in days, whether a dropdown was still open, and the dates as typed;
    // results only for a range wide enough, with no dropdown open, and dates in MM/DD/YYYY.
    if (path === '/api/preset-search') {
      const q = new URL(req.url, 'http://x').searchParams;
      const form = q.get('form');
      const days = Number(q.get('days') || 0);
      const open = q.get('open') === '1';
      const from = q.get('from');
      const mdy = /^\d{2}\/\d{2}\/\d{4}$/;
      const need = { combo: 90, widest: 30, buttons: 90, radios: 90 }[form];
      const ok = need ? days >= need && !open : mdy.test(from || '') && mdy.test(q.get('to') || '') && Date.now() - parseDate(from).getTime() >= 59 * 24 * 3600 * 1000;
      state.searches.push({ form, status: q.get('status'), preset: q.get('preset'), days, open, from, to: q.get('to'), ok });
      const links = { combo: [21, 22], widest: [31], buttons: [41], radios: [42], 'mat-placeholder': [51], 'mat-toggle': [52] }[form] || [];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? links.map((n) => `/result-${n}.html`) : []));
    }
    if (path === '/api/delete-filtered') {
      state.deleteHits.push(req.method);
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end('<!doctype html><html lang="en"><title>Deleted</title><main><h1>Deleted</h1></main></html>');
    }
    const result = /^\/result-(\d+)\.html$/.exec(path);
    if (result) {
      // A result page, with a planted finding: an image without alt text. Those of the search-*.html
      // fixtures (21 and up) link back to the fixture list, so the main crawl does not reach search.html.
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Case ${result[1]} - a11y-508 test site</title></head><body><main><h1>Case ${result[1]}</h1><img src="/img/case-${result[1]}.png" width="40" height="40">${Number(result[1]) < 20 ? '<p><a href="/search.html">Back to search</a></p>' : '<p><a href="/about.html">Back to the fixture list</a></p>'}</main></body></html>`);
    }
    if (path === '/forms.html' && state.dropsLeft > 0) {
      state.dropsLeft--;
      return req.socket.destroy();
    }
    if (path === '/') path = '/index.html';
    const ext = extname(path);
    if (path.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    if (path === '/report.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end('%PDF-1.4 fixture');
    }
    const wav = /^\/media\/[\w-]+-(\d+)s\.wav$/.exec(path);
    if (wav) {
      const body = silentWav(Number(wav[1]));
      res.writeHead(200, { 'content-type': TYPES['.wav'], 'content-length': body.length });
      return res.end(body);
    }
    if (path.startsWith('/media/')) {
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
      return res.end('');
    }
    // Documents for the iframes on checks-pack-c.html and the object on checks-pack-a.html: not
    // pages of their own, so the crawler never queues them.
    if (path === '/css/skip.css') {
      // @imported by checks-fu-misc.html: the only rule that reveals #fm-skip-imported.
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('.skip-imported:focus { left: 8px; top: 8px; background: #fff; color: #000; padding: 6px; }\n');
    }
    if (FRAMES[path]) {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(FRAMES[path]);
    }
    if (path === '/submit') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Submitted</title><main><h1>Submitted</h1></main></html>');
    }
    if (path === '/twin-start.html' || path === '/twin.html') {
      // Two addresses for one page: the start route sends the browser on to the
      // page itself, which is also linked directly. The crawler audits it once.
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      if (path === '/twin-start.html') return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Twin start - a11y-508 test site</title><script>location.replace("/twin.html");</script></head><body><p>Redirecting…</p></body></html>');
      return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Twin - a11y-508 test site</title></head><body><main><h1>Twin</h1><p>Reached either directly or from the start route.</p><img src="/pixel.png" width="40" height="40"><p><a href="/">Home</a></p></main></body></html>');
    }
    if (path === '/soft-404.html') {
      // A single-page app's deep link: the server says 404 but serves the app.
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Served with 404 - a11y-508 test site</title></head><body><main><h1>Served with a 404 status</h1><p>This page is what the server sends for a deep link it does not know: the application shell, with a not-found status. A browser renders it, so the crawler audits it and warns about the status.</p><img src="/pixel.png" width="40" height="40"><p><a href="/">Home</a></p></main></body></html>');
    }
    const file = join(fixtures, path);
    if (path === '/landed.html') {
      // Slow landing page for the script redirect from /bounce.html.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(readFileSync(file));
      }, 1500);
      return;
    }
    if (!file.startsWith(fixtures) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
    }
    let body = readFileSync(file);
    if (ext === '.html') body = Buffer.from(body.toString('utf8').replace('EXTERNAL_IMAGE', externalUrl).replace('FIXTURE_TOKEN', appValue));
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
    res.end(body);
  });
  await listen(site, port, host);
  const base = `http://${host}:${site.address().port}/`;
  const close = () => {
    site.closeAllConnections?.();
    external.closeAllConnections?.();
    site.close();
    external.close();
  };
  return Object.assign(state, { base, origin: new URL(base).origin, externalUrl, close, site, external });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const portArg = argv.indexOf('--port');
  const s = await startFixtureSite({ port: portArg >= 0 ? Number(argv[portArg + 1]) : 0, autoLogin: argv.includes('--auto-login') });
  process.stdout.write(`fixture site at ${s.base}${argv.includes('--auto-login') ? ' (autoLogin)' : ''}\n`);
  const stop = () => {
    s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
