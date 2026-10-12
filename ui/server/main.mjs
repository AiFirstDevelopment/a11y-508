#!/usr/bin/env node
// The a11y-508 dashboard: `node ui/server/main.mjs [--port 5508] [--no-open]
// [--dir <path>]`, run in (or pointed at) the repository to audit and fix.
// Zero dependencies; the built app is committed under ui/dist, so nothing
// has to be installed.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createDashboard } from './app.mjs';
import { realDir } from './dirs.mjs';

const argv = process.argv.slice(2);
const opt = { port: 5508, open: true, dir: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-open') opt.open = false;
  else if (a === '--port') opt.port = parseInt(argv[++i], 10);
  else if (a.startsWith('--port=')) opt.port = parseInt(a.slice(7), 10);
  else if (a === '--dir') opt.dir = argv[++i] ?? '';
  else if (a.startsWith('--dir=')) opt.dir = a.slice(6);
  else if (a === '-h' || a === '--help') {
    process.stdout.write('Usage: node ui/server/main.mjs [--port <n>] [--no-open] [--dir <path>]\n\nStarts the a11y-508 dashboard on 127.0.0.1 for the current directory, or for --dir.\n');
    process.exit(0);
  } else {
    process.stderr.write(`error: unknown option ${a}\n`);
    process.exit(2);
  }
}
if (!Number.isInteger(opt.port) || opt.port < 0 || opt.port > 65535) {
  process.stderr.write('error: --port expects a port number\n');
  process.exit(2);
}

// --dir is resolved against the directory the server is launched from, and
// must be a readable directory before anything listens.
let cwd = process.cwd();
if (opt.dir !== null) {
  if (!opt.dir) {
    process.stderr.write('error: --dir expects a directory\n');
    process.exit(2);
  }
  try {
    cwd = realDir(resolve(process.cwd(), opt.dir));
  } catch (e) {
    process.stderr.write(`error: --dir ${opt.dir}: ${e.message}\n`);
    process.exit(2);
  }
}

const dash = createDashboard({ cwd });
await dash.listen(opt.port);
if (dash.build.fresh === false) process.stdout.write(`warn ${dash.build.reason}\n`);
process.stdout.write(`a11y-508 dashboard for ${cwd}\n`);
process.stdout.write(`open: ${dash.url}\n`);
process.stdout.write('This address carries a one-time secret for this launch; keep it to yourself. Press Ctrl+C to stop.\n');

function openBrowser(url) {
  // start's first quoted argument is a window title. Node writes an empty
  // argument as "", which is that empty title; a literal '""' would reach
  // cmd as "\"\"" and become the title and a stray argument.
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => process.stdout.write('could not open a browser; open the address above by hand\n'));
    child.unref();
  } catch {
    process.stdout.write('could not open a browser; open the address above by hand\n');
  }
}
if (opt.open) openBrowser(dash.url);

let closing = false;
const shutdown = async () => {
  if (closing) process.exit(130);
  closing = true;
  await dash.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
