// One-time interactive sign-in. Opens a visible browser on the start URL,
// waits for the user to finish logging in (through an external single-sign-on
// portal if the app uses one), then captures the cookies and web storage the
// app left behind so the headless crawl can reuse them. Cookies are kept for
// the app's origins and for the hosts the sign-in bounced through, because
// apps that re-check the SSO session on every load need the portal's cookie
// as much as their own.

import { readFileSync, writeFileSync } from 'node:fs';
import { sleep } from './page.mjs';

const STATE_VERSION = 1;
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|logon|sso|oidc|saml|callback|auth)(\/|$|\?)/i;
const STABLE_SECONDS = 6;

function cookieBelongsTo(cookie, hostnames) {
  const d = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return !!d && hostnames.some((h) => h === d || h.endsWith('.' + d));
}

function waitForEnter() {
  const stdin = process.stdin;
  let onData;
  const promise = new Promise((resolve) => {
    onData = (chunk) => {
      if (/[\r\n]/.test(String(chunk))) resolve();
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
  const cancel = () => {
    stdin.off('data', onData);
    stdin.pause();
  };
  return { promise, cancel };
}

const currentOrigin = (session) => session.evaluate('location.origin').catch(() => '');

// Resolves once the tab has sat on the app's own origin, fully loaded, on a
// non-login path, without navigating, for STABLE_SECONDS in a row.
async function settledOnApp(session, origin, maxWait) {
  const deadline = Date.now() + maxWait;
  let last = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    let href = '';
    let o = '';
    let path = '';
    let ready = '';
    try {
      [href, o, path, ready] = await session.evaluate('[location.href, location.origin, location.pathname, document.readyState]');
    } catch {}
    stable = o === origin && ready === 'complete' && !LOGIN_PATH.test(path) && href === last ? stable + 1 : 0;
    last = href;
    if (stable >= STABLE_SECONDS) return;
  }
  throw new Error(`gave up after ${Math.round(maxWait / 60000)} minutes waiting for sign-in to finish`);
}

export async function interactiveLogin({ browser, startUrl, origins, timeout, log, maxWait = 10 * 60 * 1000 }) {
  const session = await browser.newPage();
  await session.send('Page.enable');
  await session.send('Network.enable').catch(() => {});
  const { frameTree } = await session.send('Page.getFrameTree');
  const mainFrameId = frameTree.frame.id;
  const visited = new Set();
  session.on('Page.frameNavigated', ({ frame }) => {
    if (frame.id !== mainFrameId) return;
    try {
      visited.add(new URL(frame.url).origin);
    } catch {}
  });
  await browser.cdp.send('Target.activateTarget', { targetId: session.targetId }).catch(() => {});
  await session.send('Page.navigate', { url: startUrl });
  const startOrigin = new URL(startUrl).origin;
  const tty = !!process.stdin.isTTY;
  log.warn(`A browser window is open on ${startUrl}. Sign in there. The crawl continues by itself once the app has loaded and stayed put for ${STABLE_SECONDS} seconds${tty ? ', or press Enter here' : ''}.`);
  const enter = tty ? waitForEnter() : null;
  try {
    await Promise.race([settledOnApp(session, startOrigin, maxWait), ...(enter ? [enter.promise] : [])]);
  } finally {
    if (enter) enter.cancel();
  }

  let origin = await currentOrigin(session);
  if (!origins.includes(origin)) {
    log.info(`browser is on ${origin || 'an unknown page'}; returning to ${startUrl} to capture the session`);
    await session.send('Page.navigate', { url: startUrl });
    await session.waitFor('Page.loadEventFired', { timeout }).catch(() => {});
    await sleep(1000);
    origin = await currentOrigin(session);
    if (!origins.includes(origin)) throw new Error(`the app still sends the browser to ${origin || 'another page'}; sign-in did not complete, so no session was captured`);
  }

  let cookies = [];
  try {
    ({ cookies } = await session.send('Network.getAllCookies'));
  } catch {
    ({ cookies } = await session.send('Storage.getCookies'));
  }
  const hostnames = [...new Set([...origins, ...visited].map((o) => {
    try {
      return new URL(o).hostname.toLowerCase();
    } catch {
      return '';
    }
  }).filter(Boolean))];
  const kept = cookies.filter((c) => cookieBelongsTo(c, hostnames));
  log.info(`session: keeping cookies for ${[...new Set(kept.map((c) => c.domain))].join(', ') || 'no hosts'}`);
  const storage = await session.evaluate(
    '(() => { const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; }; return { local: dump(localStorage), session: dump(sessionStorage) }; })()'
  );
  await browser.closePage(session).catch(() => {});
  return { version: STATE_VERSION, capturedAt: new Date().toISOString(), origins: [origin], cookies: kept, storage: { [origin]: storage } };
}

export function stateSummary(state) {
  const items = Object.values(state.storage || {}).reduce((n, s) => n + Object.keys(s.local || {}).length + Object.keys(s.session || {}).length, 0);
  return `${(state.cookies || []).length} cookie(s), ${items} web storage item(s) for ${(state.origins || Object.keys(state.storage || {})).join(', ')}`;
}

export function saveState(file, state) {
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function loadState(file) {
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read session file ${file}: ${e.message}`);
  }
  if (!state || typeof state !== 'object' || !Array.isArray(state.cookies) || !state.storage || typeof state.storage !== 'object') {
    throw new Error(`${file} is not an a11y-508 session file (expected "cookies" and "storage"); create one with --login`);
  }
  return state;
}
