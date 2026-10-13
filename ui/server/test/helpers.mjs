import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEnv, stopTree } from './platform.mjs';

export const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.mjs');
// The checkout these tests run from: never removed, whatever a test passes.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Every directory the tests create, so removal can refuse anything else.
const created = new Set();
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
// Where a test may remove things: the system temp directory, and the session scratchpad if one is named.
const bases = () => [tmpdir(), process.env.A11Y_508_TEST_SCRATCH].filter(Boolean).map(real);
const inside = (child, parent) => {
  const r = relative(parent, child);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

export const tmp = (p) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  created.add(d);
  return d;
};

// Throws unless `path` is one the tests created (or lies inside one), under the temp directory or
// the scratchpad, and neither the repository nor an ancestor of it nor anything with a .git segment.
export function assertRemovable(path) {
  if (typeof path !== 'string' || !path) throw new Error(`refusing to remove ${JSON.stringify(path)}: not a path`);
  const p = real(path);
  const root = real(REPO_ROOT);
  const refuse = (why) => {
    throw new Error(`refusing to remove ${p}: ${why}`);
  };
  if (p === root || inside(root, p)) refuse(`it is the repository ${root} or contains it`);
  if (inside(p, root)) refuse(`it is inside the repository ${root}`);
  if (p.split(/[\\/]/).includes('.git')) refuse('the path contains .git');
  if (!bases().some((b) => inside(p, b))) refuse(`it is not under the temp directory (${bases().join(', ')})`);
  if (![...created].some((c) => c === p || inside(p, c))) refuse('the tests did not create it');
  return p;
}

// The only way the tests remove a directory or file.
export function removeTemp(path, opts = {}) {
  const p = assertRemovable(path);
  if (!existsSync(p)) return;
  rmSync(p, { recursive: true, force: true, maxRetries: 10, ...opts });
}

export { stub } from './platform.mjs';

// The real server, as a person starts it, in its own working directory.
export async function startServer({ cwd: given, env = {}, args = [] } = {}) {
  // The working directory is removed on stop only if these helpers made it (removeTemp refuses anything else).
  const cwd = given || tmp('a11y-508-srv-');
  assertRemovable(cwd);
  const proc = spawn(process.execPath, [MAIN, '--no-open', '--port', '0', ...args], { cwd, env: mergeEnv(process.env, { TOKEN: '', A11Y_508_HOME: tmp('a11y-508-home-'), ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const url = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no start: ${out}`)), 30000);
    proc.stdout.on('data', () => {
      const m = /open: (http:\S+)/.exec(out);
      if (m) {
        clearTimeout(t);
        ok(m[1]);
      }
    });
    proc.on('exit', () => fail(new Error(`exited: ${out}`)));
  });
  const u = new URL(url);
  const port = Number(u.port);
  const secret = /secret=([0-9a-f]+)/.exec(u.hash)[1];
  const call = (method, path, { body, headers = {}, secret: s = secret, host = `127.0.0.1:${port}` } = {}) =>
    new Promise((ok, fail) => {
      const h = { host, ...headers };
      if (s) h['x-a11y-508-secret'] = s;
      const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
      if (data) h['content-type'] = 'application/json';
      const req = request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          ok({ status: res.statusCode, text, json, headers: res.headers });
        });
      });
      req.on('error', fail);
      if (data) req.write(data);
      req.end();
    });
  const waitDone = async (ms = 120000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const r = await call('GET', '/api/runs/current');
      if (r.json && r.json.status === 'done') return r.json;
      await new Promise((ok) => setTimeout(ok, 300));
    }
    throw new Error('run did not finish');
  };
  const stop = async () => {
    await stopTree(proc);
    removeTemp(cwd);
  };
  return { cwd, port, secret, url, call, waitDone, stop, output: () => out };
}
