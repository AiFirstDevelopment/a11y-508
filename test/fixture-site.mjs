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
  '/frames/inner.html': '<!doctype html><html lang="en"><title>Offer of the week</title><body style="margin:8px"><p>This week only.</p><img src="/img/offer.png" width="40" height="40"></body></html>',
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

export async function startFixtureSite({ port = 0, host = '127.0.0.1', token = TOKEN, autoLogin = false, dropForms = 2 } = {}) {
  const state = { externalHits: [], unauthorized: [], cookieHeaders: [], dangerHits: [], dropsLeft: dropForms };

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
    if (FRAMES[path]) {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(FRAMES[path]);
    }
    if (path === '/submit') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Submitted</title><main><h1>Submitted</h1></main></html>');
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
