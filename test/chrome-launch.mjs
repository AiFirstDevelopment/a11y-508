// The browser launch retry (src/chrome.mjs), with a stand-in browser: a Node script that speaks
// the DevTools pipe (NUL-terminated JSON on fds 3 and 4) the way Chrome does, or stays silent.
// launchChrome runs a .mjs "browser" with Node, so this works on every platform.
//
//   STUB_MODE=first-silent  the first launch never answers; later launches serve
//   STUB_MODE=never         no launch answers
//   STUB_MODE=serve         every launch serves
//
// Each launch appends { pid, profile } to STUB_LOG.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { launchChrome, browserField } from '../src/chrome.mjs';

const STUB = `import net from 'node:net';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const profile = (process.argv.find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length);
const log = process.env.STUB_LOG;
const before = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
appendFileSync(log, JSON.stringify({ pid: process.pid, profile }) + '\\n');
const mode = process.env.STUB_MODE;
const silent = mode === 'never' || (mode === 'first-silent' && before === 0);
const input = new net.Socket({ fd: 3, readable: true, writable: false });
const output = new net.Socket({ fd: 4, readable: false, writable: true });
if (silent) {
  // Keeps the pipe open and never answers, as the browser on the Windows runner did.
  setInterval(() => {}, 1000);
} else {
  let buf = '';
  input.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.method === 'Browser.getVersion') output.write(JSON.stringify({ id: msg.id, result: { product: 'StubChrome/1.0', protocolVersion: '1.3', revision: '0', userAgent: 'stub', jsVersion: '0' } }) + '\\0');
      else if (msg.method === 'Browser.close') {
        output.write(JSON.stringify({ id: msg.id, result: {} }) + '\\0');
        setTimeout(() => process.exit(0), 50);
      } else output.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'not in the stub' } }) + '\\0');
    }
  });
  input.on('end', () => process.exit(0));
}
`;

const dir = mkdtempSync(join(tmpdir(), 'a11y-508-stub-chrome-'));
const stub = join(dir, 'stub-chrome.mjs');
writeFileSync(stub, STUB);
const launches = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const withMode = async (mode, fn) => {
  const log = join(dir, `${mode}.log`);
  process.env.STUB_MODE = mode;
  process.env.STUB_LOG = log;
  try {
    return await fn(log);
  } finally {
    delete process.env.STUB_MODE;
    delete process.env.STUB_LOG;
  }
};

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String(e && e.stack ? e.stack : e).split('\n').join('\n       ')}`);
  }
};

console.log('chrome launch:');
await check('a browser that answers the first launch is used as is, and the report field stays the name', () => withMode('serve', async (log) => {
  const b = await launchChrome({ chromePath: stub, launchTimeout: 3000 });
  try {
    assert.equal(b.launchRetries, undefined);
    assert.equal(launches(log).length, 1);
    assert.equal(browserField(b), `StubChrome/1.0 (${stub})`);
  } finally {
    await b.close();
  }
}));
await check('AC10: a browser that does not answer its first launch is killed and launched again with a fresh profile', () => withMode('first-silent', async (log) => {
  const b = await launchChrome({ chromePath: stub, launchTimeout: 1500 });
  try {
    assert.equal(b.launchRetries, 1, 'launchRetries');
    assert.equal(b.version.product, 'StubChrome/1.0');
    const [first, second] = launches(log);
    assert.equal(launches(log).length, 2, JSON.stringify(launches(log)));
    assert.notEqual(second.profile, first.profile, 'the second launch has a profile directory of its own');
    assert.equal(b.userDataDir, second.profile);
    assert.equal(alive(first.pid), false, `the first browser (pid ${first.pid}) was killed`);
    assert.equal(existsSync(first.profile), false, 'the first profile directory was removed');
    assert.deepEqual(browserField(b), { name: `StubChrome/1.0 (${stub})`, launchRetries: 1 });
  } finally {
    await b.close();
  }
}));
await check('AC10: a browser that never answers fails after two launches, saying so', () => withMode('never', async (log) => {
  await assert.rejects(launchChrome({ chromePath: stub, launchTimeout: 1000 }), /^Error: Chrome did not respond within 1s, on two launches$/);
  const all = launches(log);
  assert.equal(all.length, 2, JSON.stringify(all));
  for (const l of all) {
    assert.equal(alive(l.pid), false, `pid ${l.pid} was killed`);
    assert.equal(existsSync(l.profile), false, `${l.profile} was removed`);
  }
}));

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} chrome launch assertion(s) failed` : '\nall chrome launch assertions passed');
process.exitCode = failures ? 1 : 0;
