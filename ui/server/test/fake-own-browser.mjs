// A stand-in for the dashboard's own Chrome (A11Y_508_OWN_BROWSER_PATH; a .mjs path is run with
// Node): it answers /json/version on a port it writes to <profile>/DevToolsActivePort, as Chrome
// with --remote-debugging-port=0 does, and prints a line to stderr. GET /exit?code=N makes it print
// "FATAL: fake browser went away (test)" to stderr and exit with code N, as a browser that is
// killed or crashes. Each launch is appended to <profile>/fake-launches.log. It ends when the
// process that started it is gone, so it never outlives a test.

import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const profile = (process.argv.find((a) => a.startsWith('--user-data-dir=')) || '').slice('--user-data-dir='.length);
const debugging = process.argv.some((a) => a.startsWith('--remote-debugging-port'));
const url = process.argv[process.argv.length - 1];
if (profile) appendFileSync(join(profile, 'fake-launches.log'), JSON.stringify({ pid: process.pid, url, at: new Date().toISOString() }) + '\n');

// A second launch on the profile in use (a new window, no DevTools port) hands over to the running
// one and exits, as Chrome does.
if (!debugging) process.exit(0);

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ Browser: 'FakeChrome/1.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake` }));
  }
  if (u.pathname === '/exit') {
    const code = Number(u.searchParams.get('code') || 3);
    res.writeHead(200);
    res.end('bye');
    process.stderr.write('[fake-browser] FATAL: fake browser went away (test)\n', () => setTimeout(() => process.exit(code), 20));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  process.stderr.write(`[fake-browser] started, pid ${process.pid}\n`);
  if (profile) writeFileSync(join(profile, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/fake\n`);
});

const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 500).unref();
// Kept alive by the server; the interval above only watches the parent.
