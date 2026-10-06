// Locate and launch the Chrome/Edge/Chromium already installed on the machine.
// Nothing is downloaded. Communication uses --remote-debugging-pipe, so no
// debugging port is opened.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, Session } from './cdp.mjs';

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

export async function launchChrome({ chromePath, viewport = { width: 1280, height: 800 }, noSandbox = false } = {}) {
  const exe = findChrome(chromePath);
  const userDataDir = mkdtempSync(join(tmpdir(), 'a11y-508-'));
  const args = [
    '--headless=new',
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
    '--disable-gpu',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
    '--use-mock-keychain',
  ];
  if (noSandbox || process.env.A11Y_508_NO_SANDBOX === '1') args.push('--no-sandbox');
  args.push('about:blank');

  const proc = spawn(exe, args, {
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
        timer = setTimeout(() => rej(new Error('Chrome did not respond within 30s')), 30000);
      }),
    ]);
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    try {
      proc.kill('SIGKILL');
    } catch {}
    rmSync(userDataDir, { recursive: true, force: true });
    throw e;
  }

  const version = await cdp.send('Browser.getVersion');

  async function newPage() {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(cdp, sessionId, targetId);
  }

  async function closePage(session) {
    session.detachAll();
    try {
      await cdp.send('Target.closeTarget', { targetId: session.targetId });
    } catch {}
  }

  async function close() {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms).unref());
    try {
      await Promise.race([cdp.send('Browser.close'), delay(3000)]);
    } catch {}
    try {
      proc.kill('SIGKILL');
    } catch {}
    await Promise.race([exited, delay(2000)]);
    rmSync(userDataDir, { recursive: true, force: true });
  }

  return { exe, proc, cdp, version, newPage, closePage, close };
}
