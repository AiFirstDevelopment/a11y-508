// A crawl's browser that goes away mid-crawl (docs/plans/browser-diary.md): its own launched
// browser is started again once and the crawl goes on from the next page; a second death ends the
// crawl with the cause; a --connect browser that goes away ends the crawl with a plain error (no
// stack trace), and the --connect path never sends Browser.close. Each death is in the diary.
//
// A11Y_508_TEST_KILL_BROWSER_AFTER=<n>[,<m>] kills the crawl's launched browser once n pages are recorded.
// `node test/browser-gone.mjs -g <text>` runs only the checks whose name contains text.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startFixtureSite, TOKEN } from './fixture-site.mjs';
import { connectChrome, findChrome } from '../src/chrome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'bin', 'a11y-508.mjs');
const g = process.argv.indexOf('-g');
const grep = g > 0 ? process.argv[g + 1] : null;
// Directories this file created, the only ones it removes.
const made = [];
const temp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
const diaryOf = (home) => (existsSync(join(home, 'diary.ndjson')) ? readFileSync(join(home, 'diary.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: '1', TOKEN, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, child });
    });
  });
}
const QUICK = ['--concurrency', '1', '--max-pages', '6', '--no-zoom', '--max-screenshots', '0', '--fail-on', 'none'];

let failures = 0;
const check = async (name, fn) => {
  if (grep && !name.includes(grep)) return;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String(e && e.stack ? e.stack : e).split('\n').join('\n       ')}`);
  }
};

const site = await startFixtureSite();
const base = site.base;
console.log('browser gone:');

await check('guard 5: the crawl\'s browser killed after page 2 is started again, pages 3+ are audited, and the coverage notes say so', async () => {
  const home = temp('a11y-508-gone-home-');
  const out = temp('a11y-508-gone-out-');
  const r = await cli([base, ...QUICK, '--out', out, '--json'], { A11Y_508_HOME: home, A11Y_508_TEST_KILL_BROWSER_AFTER: '2' });
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  assert.ok(report.pages.length >= 4, `pages: ${report.pages.length}`);
  const later = report.pages.slice(2);
  // Audited in the browser started again (app.html answers 404 without a session, as always).
  assert.ok(later.filter((p) => !p.error).length >= 2 && later.every((p) => !/browser|CDP/i.test(p.error || '')), JSON.stringify(later.map((p) => [p.url, p.error])));
  const note = report.summary.coverage.notes.find((n) => /The crawl's browser closed after 2 page\(s\)/.test(n));
  assert.ok(note && /started again and the crawl went on from the next page/.test(note), JSON.stringify(report.summary.coverage.notes));
  assert.match(note, /killed \(exit code none, signal SIGKILL\)|killed \(exit code 1/);
  const d = diaryOf(home);
  const died = d.find((e) => e.type === 'crawl-browser-died');
  assert.ok(died && died.relaunching === true && died.pagesDone === 2, JSON.stringify(d));
  assert.ok(d.some((e) => e.type === 'crawl-browser-relaunched' && e.afterPages === 2), JSON.stringify(d));
  assert.ok(d.every((e) => !JSON.stringify(e).includes(TOKEN)), 'the token is never in the diary');
});

await check('AC8: a second death ends the crawl with the recorded cause, and no stack trace', async () => {
  const home = temp('a11y-508-gone-home-');
  const out = temp('a11y-508-gone-out-');
  const r = await cli([base, ...QUICK, '--out', out], { A11Y_508_HOME: home, A11Y_508_TEST_KILL_BROWSER_AFTER: '2,3' });
  const all = r.stdout + r.stderr;
  assert.equal(r.code, 2, all);
  assert.match(all, /error the browser the crawl was using closed again: Chrome killed/);
  assert.doesNotMatch(all, /\n\s+at /, 'no stack trace');
  assert.equal(diaryOf(home).filter((e) => e.type === 'crawl-browser-died').length, 2);
});

// A Chrome the test starts with a DevTools port, standing in for the dashboard's own window.
async function portBrowser() {
  const profile = temp('a11y-508-gone-profile-');
  const proc = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  let port = '';
  for (let i = 0; i < 50 && !port; i++) {
    port = (readFileSync(portFile, 'utf8').split('\n')[0] || '').trim();
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  const exited = new Promise((r) => proc.once('exit', r));
  return { proc, port, exited, alive: async () => fetch(`http://127.0.0.1:${port}/json/version`).then((x) => x.ok, () => false) };
}

await check('guard 7: the --connect path never sends Browser.close, and the browser stays up', async () => {
  const b = await portBrowser();
  try {
    const conn = await connectChrome(b.port, { returnUrl: null });
    const sent = [];
    const send = conn.cdp.send.bind(conn.cdp);
    conn.cdp.send = (method, ...rest) => {
      sent.push(method);
      return send(method, ...rest);
    };
    const s = await conn.newPage();
    await s.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    await conn.closePage(s);
    await conn.newPage();
    await conn.close({ fast: true });
    assert.ok(sent.length > 0);
    assert.ok(!sent.includes('Browser.close'), sent.join(', '));
    assert.equal(await b.alive(), true, 'the connected browser is still running');
  } finally {
    b.proc.kill('SIGKILL');
    await b.exited;
  }
});

await check('AC7: a --connect crawl whose browser goes away ends with "the browser the crawl was using closed", exit 2, the reason on its done event, no stack trace', async () => {
  const b = await portBrowser();
  const home = temp('a11y-508-gone-home-');
  const out = temp('a11y-508-gone-out-');
  const child = spawn(process.execPath, [BIN, base, ...QUICK, '--out', out, '--connect', b.port, '--events'], { env: { ...process.env, NO_COLOR: '1', TOKEN, A11Y_508_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let killed = false;
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    stdout += d;
    // The first page is recorded: the browser goes away.
    if (!killed && /"type":"page"/.test(stdout)) {
      killed = true;
      b.proc.kill('SIGKILL');
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);
  await b.exited;
  assert.ok(killed, 'a page was recorded before the browser was killed');
  assert.equal(code, 2, stderr);
  const events = stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.match(done.reason || '', /^the browser the crawl was using closed: /);
  assert.ok(events.some((e) => e.type === 'error' && /^the browser the crawl was using closed: /.test(e.message)), stdout);
  assert.doesNotMatch(stderr, /\n\s+at /, 'no stack trace');
  assert.ok(diaryOf(home).some((e) => e.type === 'crawl-browser-died' && e.connected === true), JSON.stringify(diaryOf(home)));
});

site.close();
for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
console.log(failures ? `\n${failures} browser-gone assertion(s) failed` : '\nall browser-gone assertions passed');
process.exitCode = failures ? 1 : 0;
