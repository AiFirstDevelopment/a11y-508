// One-time interactive sign-in. Opens a visible browser on the start URL,
// waits for the user to finish logging in (through an external single-sign-on
// portal if the app uses one), then captures the cookies and web storage the
// app left behind so the headless crawl can reuse them. Only cookies for the
// app's own origins are kept; the portal's are never written to disk.

import { readFileSync, writeFileSync } from 'node:fs';
import { sleep } from './page.mjs';

const STATE_VERSION = 1;

function cookieBelongsTo(cookie, hostnames) {
  const d = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return !!d && hostnames.some((h) => h === d || h.endsWith('.' + d));
}

function waitForEnter() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (chunk) => {
      if (!/[\r\n]/.test(String(chunk))) return;
      stdin.off('data', onData);
      stdin.pause();
      resolve();
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

const currentOrigin = (session) => session.evaluate('location.origin').catch(() => '');

export async function interactiveLogin({ browser, startUrl, origins, timeout, log }) {
  if (!process.stdin.isTTY) throw new Error('--login needs an interactive terminal (stdin is not a TTY); sign in once locally and pass the saved file with --state');
  const session = await browser.newPage();
  await session.send('Page.enable');
  await session.send('Network.enable').catch(() => {});
  await browser.cdp.send('Target.activateTarget', { targetId: session.targetId }).catch(() => {});
  await session.send('Page.navigate', { url: startUrl });
  log.warn(`A browser window is open on ${startUrl}. Sign in there, wait until the app itself has loaded, then press Enter here.`);
  await waitForEnter();

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
  const hostnames = origins.map((o) => new URL(o).hostname.toLowerCase());
  const kept = cookies.filter((c) => cookieBelongsTo(c, hostnames));
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
