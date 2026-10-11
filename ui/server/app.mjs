// The dashboard's local server: plain node:http, no dependencies, Node 18+.
// Serves the built app from ui/dist, and an API on 127.0.0.1 guarded by a
// per-launch secret and a Host check. Drives the CLI as a child process.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { findChrome } from '../../src/chrome.mjs';
import { PRESETS, installRemedies, runAgent, agentEnv } from '../../src/agent.mjs';
import { loadConfig, normalizeConfig, summaryLine, WORK_DIR } from '../../src/loop.mjs';
import { loadLedger, statusCounts, byStatus } from '../../src/ledger.mjs';
import { BIN, BadRequest, DEFAULT_STATE_FILE, crawlArgs, loopArgs, commandLine } from './args.mjs';
import { detectPresets, shellInvocation } from './detect.mjs';
import { Runs } from './runs.mjs';
import { listReports, readReport, confinedFile, moveLatestToHistory, REPORT_DIR } from './reports.mjs';
import { UI_DIR, freshness } from './build-info.mjs';

const pkg = JSON.parse(readFileSync(join(UI_DIR, '..', 'package.json'), 'utf8'));
export const SECRET_HEADER = 'x-a11y-508-secret';
const CONFIG_FILE = 'a11y-508.config.json';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const AGENT_TEST_PROMPT = (resultFile) => `# Check that you can run

This is a connectivity check from the a11y-508 dashboard. Do not read, create, change or delete any file other than the one named below, and do not run any command.

Write a JSON file at ${resultFile} with exactly this content and nothing else:

\`\`\`json
{ "ok": true }
\`\`\`

Machine-readable copy:

\`\`\`json
${JSON.stringify({ kind: 'test', resultFile }, null, 2)}
\`\`\`
`;

export function createDashboard({ cwd = process.cwd(), env = process.env, platform = process.platform, distDir = join(UI_DIR, 'dist'), uiDir = UI_DIR, agentTestTimeout = 180000 } = {}) {
  const secret = randomBytes(24).toString('hex');
  // Report files (<img>, a new tab) cannot send the header, so they take a
  // cookie instead: a separate value that opens report files and nothing else.
  const fileSecret = randomBytes(24).toString('hex');
  const state = { token: null, port: null, presets: null, detecting: null, lastTest: {} };
  const runs = new Runs({ onExit: () => {} });
  const build = freshness(uiDir);

  // A forced detection never reuses one that started before it was asked for.
  const detect = (force = false) => {
    if (state.detecting && !force) return state.detecting;
    if (state.presets && !force) return Promise.resolve(state.presets);
    const p = (state.detecting && force ? state.detecting.catch(() => {}) : Promise.resolve())
      .then(() => detectPresets({ env, platform }))
      .then((d) => {
        state.presets = d;
        return d;
      })
      .finally(() => {
        if (state.detecting === p) state.detecting = null;
      });
    state.detecting = p;
    return p;
  };

  const tokens = () => [state.token, env.TOKEN].filter(Boolean);

  // ---- helpers
  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(text);
  };
  const readBody = (req) => new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new BadRequest('request body too large', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BadRequest('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
  const sendFile = (res, file, extraHeaders = {}) => {
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'x-content-type-options': 'nosniff', ...extraHeaders });
    createReadStream(file).pipe(res);
  };
  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const cookieName = () => `a11y508_${state.port}`;
  const authorized = (req, allowCookie) => {
    const h = req.headers[SECRET_HEADER];
    if (typeof h === 'string' && same(h.replace(/^Bearer\s+/i, '').trim(), secret)) return true;
    if (allowCookie) {
      const m = new RegExp(`(?:^|;\\s*)${cookieName()}=([0-9a-f]+)`).exec(req.headers.cookie || '');
      if (m && same(m[1], fileSecret)) return true;
    }
    return false;
  };
  const hostOk = (req) => {
    const host = String(req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${state.port}` || host === `localhost:${state.port}`;
  };

  // ---- the run environment: TOKEN only when this run is meant to send it
  const childEnv = (tokenMode) => {
    const e = { ...env };
    delete e.TOKEN;
    if (tokenMode === 'form') {
      if (!state.token) throw new BadRequest('enter a token, or choose another way to sign in');
      e.TOKEN = state.token;
    } else if (tokenMode === 'env') {
      if (!env.TOKEN) throw new BadRequest('TOKEN is not set in the environment the dashboard was started from');
      e.TOKEN = env.TOKEN;
    }
    return e;
  };

  const agentCommand = (spec) => {
    if (!spec) return null;
    if (PRESETS[spec]) {
      const p = state.presets && state.presets.presets.find((x) => x.name === spec);
      return p && p.found ? p.command : PRESETS[spec];
    }
    return spec;
  };

  async function startRun(body) {
    const kind = body.kind;
    if (!['crawl', 'troubleshoot', 'login', 'loop', 'dry-run'].includes(kind)) throw new BadRequest(`unknown run kind "${kind}"`);
    if (runs.active) throw new BadRequest(`a ${runs.current.kind} run is already active`, 409);
    const auth = body.auth || { mode: 'none' };
    if (auth.mode === 'token' && typeof auth.token === 'string' && auth.token.trim()) state.token = auth.token.trim();
    let built;
    let meta;
    if (kind === 'loop' || kind === 'dry-run') {
      if (kind === 'loop') await detect();
      const cfg = loadConfig(CONFIG_FILE, cwd);
      const chosen = body.agent || cfg.agent || null;
      const resolved = kind === 'loop' ? agentCommand(chosen) : null;
      // A preset found off PATH runs by its absolute path; otherwise the
      // config's "agent" stands unless the request names another.
      let agentArg = null;
      if (resolved && PRESETS[chosen] && resolved !== PRESETS[chosen]) agentArg = resolved;
      else if (resolved && body.agent) agentArg = body.agent;
      built = loopArgs({ kind, url: body.url, options: body.options, auth, maxRounds: body.maxRounds, agent: agentArg });
      meta = { agent: resolved };
    } else {
      built = crawlArgs({ kind, url: body.url, options: body.options, auth });
    }
    const runEnv = childEnv(built.token);
    let moved = null;
    if (kind === 'crawl') moved = moveLatestToHistory(cwd);
    return runs.start({
      kind, file: process.execPath, args: [BIN, ...built.args, '--events'], env: runEnv, cwd, events: true, secrets: tokens(),
      meta: { ...meta, command: commandLine({ cwd, args: built.args, token: built.token }), url: body.url || null, movedToHistory: moved },
    });
  }

  async function startInstall(body) {
    const keys = Object.keys(body || {});
    if (keys.length !== 1 || keys[0] !== 'agent' || typeof body.agent !== 'string' || !PRESETS[body.agent]) throw new BadRequest('body must be exactly { "agent": "claude" | "gemini" | "codex" }');
    if (runs.active) throw new BadRequest(`a ${runs.current.kind} run is already active`, 409);
    const d = await detect();
    const preset = d.presets.find((p) => p.name === body.agent);
    const command = preset.install;
    const [file, args] = shellInvocation(d.shell, command);
    return runs.start({
      kind: 'install', file, args, env: agentEnv(env), cwd, events: false, secrets: tokens(),
      meta: { agent: body.agent, command, shell: d.shell.name },
      finish: async ({ code, output }) => {
        const again = await detect(true);
        const now = again.presets.find((p) => p.name === body.agent);
        return { agent: body.agent, found: now.found, remedies: installRemedies({ code, output, shell: again.shell.path, platform, found: now.found, npmPrefix: again.npmPrefix }) };
      },
    });
  }

  async function testAgent(body) {
    const spec = body && body.agent;
    if (typeof spec !== 'string' || !spec.trim()) throw new BadRequest('agent is required');
    if (!PRESETS[spec] && !spec.includes('{promptFile}')) throw new BadRequest('a custom command must contain {promptFile}');
    await detect();
    const command = agentCommand(spec);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'a11y-508-agent-test-')));
    const promptFile = join(dir, 'prompt.md');
    const resultFile = join(dir, 'result.json');
    writeFileSync(promptFile, AGENT_TEST_PROMPT(resultFile));
    try {
      const r = await runAgent({ command, promptFile, resultFile, cwd: dir, timeout: agentTestTimeout, env: agentEnv(env) });
      const ok = !!(r.result && r.result.ok === true);
      const out = redactorFor()(`${r.stdout}\n${r.stderr}`).split('\n').filter((l) => l.trim()).slice(-30);
      const result = { agent: spec, command, status: r.timedOut ? 'timed-out' : ok ? 'ready' : 'failed', code: r.code, durationMs: r.durationMs, output: out, at: new Date().toISOString() };
      state.lastTest[spec] = result;
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const redactorFor = () => (t) => tokens().reduce((s, tok) => s.split(tok).join('[redacted]'), t);

  function envInfo(d) {
    let browser;
    try {
      browser = { found: true, path: findChrome() };
    } catch (e) {
      browser = { found: false, path: null, error: e.message };
    }
    const sessionFile = join(cwd, DEFAULT_STATE_FILE);
    let session = { exists: false, file: DEFAULT_STATE_FILE };
    if (existsSync(sessionFile)) {
      const st = statSync(sessionFile);
      let capturedAt = null;
      try {
        capturedAt = JSON.parse(readFileSync(sessionFile, 'utf8')).capturedAt || null;
      } catch {}
      session = { exists: true, file: DEFAULT_STATE_FILE, ageMs: Date.now() - st.mtimeMs, capturedAt };
    }
    const latest = readReport(cwd, 'latest');
    return {
      cwd, version: pkg.version, platform, browser,
      config: { exists: existsSync(join(cwd, CONFIG_FILE)), file: CONFIG_FILE },
      session,
      report: latest ? { exists: true, finishedAt: latest.finishedAt, baseUrl: latest.baseUrl } : { exists: false },
      tokenInEnv: !!env.TOKEN, tokenHeld: !!state.token,
      shell: d.shell, npmPrefix: d.npmPrefix, presets: d.presets, detectedAt: d.detectedAt,
      lastTest: state.lastTest,
      build: { fresh: build.fresh, reason: build.reason },
      run: runs.current ? runSummary(runs.current) : null,
    };
  }
  const runSummary = (r) => ({ id: r.id, kind: r.kind, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt || null, code: r.code, meta: r.meta });

  function ledgerInfo() {
    const file = join(cwd, WORK_DIR, 'ledger.json');
    if (!existsSync(file)) return { exists: false };
    const ledger = loadLedger(file);
    const pick = (status) => byStatus(ledger, status).map((e) => ({ test: e.test, impact: e.impact, message: e.message, pages: e.pages.length, attempts: e.attempts.length, reason: e.reason || null, selector: e.selector }));
    return {
      exists: true, rounds: ledger.rounds, counts: statusCounts(ledger), line: summaryLine(ledger),
      lists: { open: pick('open'), pending: pick('pending'), review: pick('review'), 'needs-human': pick('needs-human') },
    };
  }

  function readConfig() {
    const c = loadConfig(CONFIG_FILE, cwd);
    const { _path, _missing, ...config } = c;
    return { exists: !_missing, file: CONFIG_FILE, config: _missing ? {} : config };
  }

  // The core's own validation. A missing agent is a warning, not an error:
  // a dry run needs none, exactly as `a11y-508 loop --dry-run` accepts it.
  function writeConfig(body) {
    const config = body && body.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new BadRequest('body must be { "config": { ... } }');
    const { errors } = normalizeConfig(config, {}, { interactive: true });
    const hard = errors.filter((e) => !/^no agent/.test(e));
    if (hard.length) {
      const err = new BadRequest(hard.join('; '));
      err.errors = hard;
      throw err;
    }
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n');
    return { ...readConfig(), warnings: errors.filter((e) => /^no agent/.test(e)) };
  }

  // ---- routing
  async function api(req, res, url) {
    const path = url.pathname;
    const m = req.method;
    const reportFile = /^\/api\/reports\/([^/]+)\/(screenshots\/.+|report\.html)$/.exec(path);
    if (!authorized(req, m === 'GET' && !!reportFile)) return send(res, 401, { error: 'missing or wrong session secret' });

    if (reportFile) {
      let rel;
      try {
        rel = decodeURIComponent(reportFile[2]);
      } catch {
        return send(res, 404, { error: 'not found' });
      }
      const file = confinedFile(cwd, decodeURIComponent(reportFile[1]), rel);
      if (!file) return send(res, 404, { error: 'not found' });
      return sendFile(res, file, { 'cache-control': 'no-store' });
    }
    if (m === 'GET' && path === '/api/env') {
      const d = await detect(url.searchParams.get('refresh') === '1');
      return send(res, 200, envInfo(d), { 'set-cookie': `${cookieName()}=${fileSecret}; Path=/api/reports; HttpOnly; SameSite=Strict` });
    }
    if (m === 'POST' && path === '/api/agent/install') return send(res, 202, runSummary(await startInstall(await readBody(req))));
    if (m === 'POST' && path === '/api/agent/test') return send(res, 200, await testAgent(await readBody(req)));
    if (m === 'POST' && path === '/api/runs') return send(res, 202, runSummary(await startRun(await readBody(req))));
    if (m === 'GET' && path === '/api/runs/current') return send(res, 200, runs.current ? runSummary(runs.current) : null);
    if (m === 'GET' && path === '/api/runs/current/events') {
      if (!runs.current) return send(res, 404, { error: 'no run yet' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': stream\n\n');
      const unsubscribe = runs.subscribe((e) => {
        if (e === null) return res.end();
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      });
      req.on('close', () => unsubscribe && unsubscribe());
      return;
    }
    if (m === 'POST' && path === '/api/runs/current/stop') return send(res, 200, { signal: runs.stop() });
    if (m === 'POST' && path === '/api/runs/current/continue') {
      runs.continue();
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && path === '/api/reports') return send(res, 200, listReports(cwd));
    const rm = /^\/api\/reports\/([^/]+)$/.exec(path);
    if (m === 'GET' && rm) {
      const r = readReport(cwd, decodeURIComponent(rm[1]));
      return r ? send(res, 200, r) : send(res, 404, { error: 'no such report' });
    }
    if (m === 'GET' && path === '/api/ledger') return send(res, 200, ledgerInfo());
    if (m === 'GET' && path === '/api/config') return send(res, 200, readConfig());
    if (m === 'PUT' && path === '/api/config') return send(res, 200, writeConfig(await readBody(req)));
    if (m === 'GET' && path === '/api/command') {
      let form;
      try {
        form = JSON.parse(url.searchParams.get('form') || '{}');
      } catch {
        throw new BadRequest('form must be JSON');
      }
      const built = form.kind === 'loop' || form.kind === 'dry-run' ? loopArgs(form) : crawlArgs(form);
      return send(res, 200, { command: commandLine({ cwd, args: built.args, token: built.token }) });
    }
    return send(res, 404, { error: 'not found' });
  }

  function staticFile(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const root = resolve(distDir);
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'bad path');
    }
    const file = resolve(root, '.' + rel);
    const inside = file === root || file.startsWith(root + sep);
    if (inside && extname(file) && existsSync(file) && statSync(file).isFile()) {
      return sendFile(res, file, { 'cache-control': /\.(js|css|woff2)$/.test(file) && /-[A-Z0-9]{8,}\./.test(file) ? 'public, max-age=31536000, immutable' : 'no-store' });
    }
    if (extname(rel) && rel !== '/') return send(res, 404, 'not found');
    const index = join(root, 'index.html');
    if (!existsSync(index)) return send(res, 500, 'The dashboard has not been built: run npm --prefix ui ci && npm --prefix ui run build');
    return sendFile(res, index, { 'cache-control': 'no-store' });
  }

  const server = createServer(async (req, res) => {
    if (!hostOk(req)) return send(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, `http://127.0.0.1:${state.port}`);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else staticFile(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e.status || 500;
      send(res, status, { error: e.message, ...(e.errors ? { errors: e.errors } : {}) });
    }
  });

  async function listen(port = 5508, { tries = 20 } = {}) {
    for (let i = 0; i <= tries; i++) {
      const p = port === 0 ? 0 : port + i;
      try {
        await new Promise((ok, fail) => {
          server.once('error', fail);
          server.listen(p, '127.0.0.1', () => {
            server.off('error', fail);
            ok();
          });
        });
        state.port = server.address().port;
        return state.port;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' || port === 0) throw e;
      }
    }
    throw new Error(`no free port from ${port} to ${port + tries}`);
  }

  function close() {
    runs.killAll();
    server.closeAllConnections?.();
    return new Promise((r) => server.close(() => r()));
  }

  return { server, secret, listen, close, runs, build, detect, get port() { return state.port; }, get url() { return `http://127.0.0.1:${state.port}/#secret=${secret}`; } };
}

export { REPORT_DIR };
