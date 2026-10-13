// Locate and launch the Chrome/Edge/Chromium already installed on the machine.
// Nothing is downloaded. Communication uses --remote-debugging-pipe, so no
// debugging port is opened.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, Session } from './cdp.mjs';
import { WebSocketClient, cdpStreams } from './ws.mjs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Chromium\\Application\\chrome.exe`,
  ],
};

export function findChrome(explicit) {
  const fromEnv = explicit || process.env.CHROME_PATH || process.env.CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw new Error(`Chrome not found at ${fromEnv} (from --chrome / CHROME_PATH)`);
  }
  for (const p of CANDIDATES[process.platform] || []) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    'No Chrome, Chromium, or Edge found. Install one or set CHROME_PATH to the browser executable.'
  );
}

// The report's browser field: the browser's name, or { name, launchRetries } when it needed a
// second launch, so a default report keeps its shape.
export function browserField(browser) {
  const name = `${browser.version.product} (${browser.exe})`;
  return browser.launchRetries ? { name, launchRetries: browser.launchRetries } : name;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms).unref());

// Kills a process and everything under it: taskkill /T on Windows; elsewhere the descendants
// from ps, deepest first, then the process itself.
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  const kids = new Map();
  try {
    const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout || '';
    for (const line of out.split('\n')) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (!p) continue;
      if (!kids.has(pp)) kids.set(pp, []);
      kids.get(pp).push(p);
    }
  } catch {}
  const all = [];
  const walk = (p) => {
    for (const c of kids.get(p) || []) walk(c);
    all.push(p);
  };
  walk(pid);
  for (const p of all) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
}

// Chrome's child processes can keep files in the profile directory open for a
// moment after the browser exits (EBUSY / EPERM on Windows), so removal is
// retried with backoff and reports failure instead of throwing.
async function removeDir(dir) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch {
      await delay(Math.min(2000, 250 * 2 ** attempt));
    }
  }
  return !existsSync(dir);
}

// How long a launched browser has to answer its first DevTools call.
const LAUNCH_TIMEOUT = 30000;

// A browser that never answers its first call (seen once on a Windows CI runner, where the same
// commit then passed) gets one more launch with a fresh profile directory before the run fails.
// launchRetries on the result says it happened. A browser that exits with an error is not retried.
export async function launchChrome({ chromePath, viewport = { width: 1280, height: 800 }, noSandbox = false, headless = true, launchTimeout = LAUNCH_TIMEOUT } = {}) {
  const exe = findChrome(chromePath);
  let first;
  try {
    first = await startBrowser({ exe, viewport, noSandbox, headless, launchTimeout });
  } catch (e) {
    if (!e.noAnswer) throw e;
    let second;
    try {
      second = await startBrowser({ exe, viewport, noSandbox, headless, launchTimeout });
    } catch (e2) {
      if (e2.noAnswer) e2.message += ', on two launches';
      throw e2;
    }
    second.launchRetries = 1;
    second.firstProfile = e.userDataDir;
    return second;
  }
  return first;
}

async function startBrowser({ exe, viewport, noSandbox, headless, launchTimeout }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'a11y-508-'));
  const args = [
    ...(headless ? ['--headless=new', '--disable-gpu'] : ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']),
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-translate',
    '--disable-features=TranslateUI,OptimizationHints,MediaRouter',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
    '--use-mock-keychain',
  ];
  if (noSandbox || process.env.A11Y_508_NO_SANDBOX === '1') args.push('--no-sandbox');
  args.push('about:blank');

  // A .js/.mjs "browser" is a stand-in run with Node (test/chrome-launch.mjs), so a test can play
  // the browser's side of the pipe on every platform without a native executable.
  const script = /\.m?js$/i.test(exe);
  const proc = spawn(script ? process.execPath : exe, script ? [exe, ...args] : args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const stderr = [];
  proc.stderr.on('data', (d) => {
    stderr.push(String(d));
    if (stderr.length > 50) stderr.shift();
  });

  const cdp = new Cdp(proc.stdio[3], proc.stdio[4]);
  const exited = new Promise((resolve) => proc.once('exit', resolve));

  // Sanity check the connection.
  let timer;
  try {
    await Promise.race([
      cdp.send('Browser.getVersion'),
      exited.then((code) => {
        throw new Error(`Chrome exited with code ${code} before connecting.\n${stderr.join('')}`);
      }),
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          const err = new Error(`Chrome did not respond within ${Math.round(launchTimeout / 1000)}s`);
          err.noAnswer = true;
          rej(err);
        }, launchTimeout);
      }),
    ]);
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    try {
      proc.kill('SIGKILL');
    } catch {}
    // The killed browser must be gone, and its pipes closed, before its profile can be removed
    // (Windows keeps open files locked) and before a second browser starts.
    await Promise.race([exited, delay(5000)]);
    for (const stream of [proc.stdio[3], proc.stdio[4], proc.stderr]) {
      try {
        if (stream) stream.destroy();
      } catch {}
    }
    await removeDir(userDataDir);
    e.userDataDir = userDataDir;
    throw e;
  }

  const version = await cdp.send('Browser.getVersion');

  async function newPage() {
    // Headless, each tab gets a window of its own. Tabs sharing a window are
    // hidden behind the front one, and a hidden tab draws no frames, so
    // Page.captureScreenshot in it never returns (seen on Linux: with
    // --concurrency 2 or more the first page's screenshots stalled the crawl).
    // The visible login browser keeps a single window.
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', ...(headless ? { newWindow: true } : {}) });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(cdp, sessionId, targetId);
  }

  async function closePage(session) {
    session.detachAll();
    try {
      await cdp.send('Target.closeTarget', { targetId: session.targetId });
    } catch {}
  }

  // Resolves to { userDataDir, removed }. Lets Chrome exit on its own before
  // killing it, because a killed browser leaves renderer processes that still
  // hold profile files open.
  // fast: the Stop path (Ctrl+C, the dashboard's Stop). Ask the browser to close, give it 2
  // seconds, then kill it and every process under it. The end of a crawl closes gracefully.
  async function close({ fast = false } = {}) {
    if (fast) {
      cdp.send('Browser.close').catch(() => {});
      const exitedInTime = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
      if (!exitedInTime) killTree(proc.pid);
      await Promise.race([exited, delay(1000)]);
    } else {
      try {
        await Promise.race([cdp.send('Browser.close'), delay(3000)]);
      } catch {}
      const exitedCleanly = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
      if (!exitedCleanly) {
        try {
          proc.kill('SIGKILL');
        } catch {}
        await Promise.race([exited, delay(2000)]);
      }
    }
    // Chrome's crash handler can outlive the browser holding inherited copies
    // of the DevTools pipe, which would keep this process alive after the run.
    for (const stream of [proc.stdio[3], proc.stdio[4], proc.stderr]) {
      try {
        if (stream) stream.destroy();
      } catch {}
    }
    const removed = await removeDir(userDataDir);
    return { userDataDir, removed };
  }

  return { exe, proc, cdp, version, userDataDir, newPage, closePage, close };
}

// Attaches to a browser that is already running (--connect <port | ws://…>): the dashboard's own
// window. Tabs open in that window (newWindow: false) and come to the front; close() closes the
// tabs this run opened, never the browser, and brings the tab whose URL starts with
// A11Y_508_RETURN_URL (the dashboard's) back to the front.
export async function connectChrome(target, { returnUrl = process.env.A11Y_508_RETURN_URL || null } = {}) {
  let wsUrl = String(target);
  if (/^\d+$/.test(wsUrl)) {
    const res = await fetch(`http://127.0.0.1:${wsUrl}/json/version`).catch((e) => {
      throw new Error(`no browser is listening on port ${target} (${e.message})`);
    });
    const v = await res.json();
    wsUrl = v.webSocketDebuggerUrl;
  }
  const ws = await WebSocketClient.connect(wsUrl);
  const { reader, writer } = cdpStreams(ws);
  const cdp = new Cdp(writer, reader);
  const version = await cdp.send('Browser.getVersion');
  const opened = new Set();
  // A tab handed over by the sign-in (it keeps its page; the crawl continues in it).
  let handoff = null;

  async function newPage() {
    if (handoff) {
      const s = handoff;
      handoff = null;
      return s;
    }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: false });
    opened.add(targetId);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Target.activateTarget', { targetId }).catch(() => {});
    return new Session(cdp, sessionId, targetId);
  }

  async function closePage(session) {
    session.detachAll();
    opened.delete(session.targetId);
    try {
      await cdp.send('Target.closeTarget', { targetId: session.targetId });
    } catch {}
  }

  async function close() {
    for (const targetId of [...opened]) {
      try {
        await Promise.race([cdp.send('Target.closeTarget', { targetId }), delay(2000)]);
      } catch {}
    }
    opened.clear();
    if (returnUrl) {
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const back = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(returnUrl));
        if (back) await cdp.send('Target.activateTarget', { targetId: back.targetId });
      } catch {}
    }
    ws.close();
    return { userDataDir: null, removed: true };
  }

  return {
    exe: version.product, proc: null, cdp, version, userDataDir: null, connected: true, newPage, closePage, close,
    // The sign-in's tab, kept for the crawl (see login.mjs keepOpen).
    handOver(session) {
      handoff = session;
      opened.add(session.targetId);
    },
  };
}
