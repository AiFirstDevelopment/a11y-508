import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEnv, stopTree } from './platform.mjs';

export const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.mjs');
export const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

export { stub } from './platform.mjs';

// The real server, as a person starts it, in its own working directory.
export async function startServer({ cwd = tmp('a11y-508-srv-'), env = {}, args = [] } = {}) {
  const proc = spawn(process.execPath, [MAIN, '--no-open', '--port', '0', ...args], { cwd, env: mergeEnv(process.env, { TOKEN: '', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
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
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10 });
  };
  return { cwd, port, secret, url, call, waitDone, stop, output: () => out };
}
