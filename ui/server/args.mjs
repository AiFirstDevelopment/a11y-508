// The Run form as CLI arguments: one table of the crawl flags the dashboard
// may set, the auth modes, and the command line a person can paste into a
// terminal or CI. Everything is validated by the core's own parseArgs.

import { relative, resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../src/cli.mjs';

export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = join(TOOL_DIR, 'bin', 'a11y-508.mjs');
export const DEFAULT_STATE_FILE = 'a11y-508-state.json';

// Flags the form may set. --out, --json, --quiet, --events, --login and
// --troubleshoot belong to the server; --state and --cookie to auth.
// --no-screenshots and --max-screenshots are no-ops now, still accepted from saved configs.
export const FLAGS = {
  'max-pages': 'value', 'max-depth': 'value', concurrency: 'value', include: 'list', exclude: 'list', 'fail-on': 'value',
  viewport: 'value', timeout: 'value', settle: 'value', header: 'list', 'token-header': 'value', 'auth-origin': 'list',
  'token-storage': 'list', 'no-token-storage': 'switch', 'no-interact': 'switch', 'no-zoom': 'switch', 'no-screenshots': 'switch',
  'max-screenshots': 'value', 'max-tabs': 'value', 'max-activations': 'value', 'max-clicks': 'value', 'no-follow-clicks': 'switch', 'no-forms': 'switch', 'search-months': 'value',
  'user-agent': 'value', chrome: 'value', 'no-sandbox': 'switch', wcag: 'value',
};

export const AUTH_MODES = ['token', 'env', 'state', 'cookies', 'none', 'signin'];

export class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function optionArgs(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new BadRequest('options must be an object');
  const out = [];
  for (const [k, v] of Object.entries(options)) {
    const kind = FLAGS[k];
    if (!kind) throw new BadRequest(`unknown or reserved option "${k}"`);
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (kind === 'switch') {
      if (v !== true) throw new BadRequest(`option "${k}" is a switch; send true`);
      out.push(`--${k}`);
    } else if (kind === 'list') {
      const list = Array.isArray(v) ? v : [v];
      for (const x of list) if (String(x).trim()) out.push(`--${k}`, String(x));
    } else {
      if (typeof v === 'object') throw new BadRequest(`option "${k}" takes one value`);
      out.push(`--${k}`, String(v));
    }
  }
  return out;
}

// The auth part of the arguments and environment. The token itself never
// appears in arguments; it goes only into the child's environment.
export function authArgs(auth = { mode: 'none' }) {
  const mode = (auth && auth.mode) || 'none';
  if (!AUTH_MODES.includes(mode)) throw new BadRequest(`unknown auth mode "${mode}"`);
  // The dashboard's Sign in: sign in in a visible window, save the session, and crawl in that window.
  if (mode === 'signin' && auth.connect) return { args: ['--connect', String(auth.connect), '--login', '--state', auth.file || DEFAULT_STATE_FILE], token: 'none' };
  if (mode === 'signin') return { args: ['--login', '--stay', '--state', auth.file || DEFAULT_STATE_FILE], token: 'none' };
  if (mode === 'state') return { args: ['--state', auth.file || DEFAULT_STATE_FILE], token: 'none' };
  if (mode === 'cookies') {
    const cookies = (Array.isArray(auth.cookies) ? auth.cookies : String(auth.cookies || '').split('\n')).map((c) => String(c).trim()).filter(Boolean);
    return { args: cookies.flatMap((c) => ['--cookie', c]), token: 'none' };
  }
  if (mode === 'token') return { args: [], token: 'form' };
  if (mode === 'env') return { args: [], token: 'env' };
  return { args: [], token: 'none' };
}

export function validateUrl(url) {
  if (!url || typeof url !== 'string') throw new BadRequest('a start URL is required');
  return url.trim();
}

// The CLI arguments (after the bin path) for a crawl-like run, without the
// server's own --events. Throws BadRequest with the core's message on a bad form.
export function crawlArgs({ kind = 'crawl', url, options, auth }) {
  const u = validateUrl(url);
  const a = authArgs(auth);
  const args = [u, ...optionArgs(options), ...a.args];
  if (kind === 'troubleshoot') args.push('--troubleshoot');
  if (kind === 'login') {
    const stateFile = (auth && auth.file) || DEFAULT_STATE_FILE;
    return { args: [u, ...optionArgs(options), '--login-only', '--state', stateFile], token: 'none' };
  }
  try {
    parseArgs(args);
  } catch (e) {
    throw new BadRequest(e.message);
  }
  return { args, token: a.token };
}

// The fix loop from the dashboard has no round cap (--max-rounds 0): it ends when nothing is left to
// fix, or when it is stopped. maxRounds is no longer read.
export function loopArgs({ kind, url, options, auth, agent, signIn = false, config = null, stateFile = null, connect = null, fromReport = null, resume = false, deploy = null }) {
  const a = authArgs(auth);
  const args = ['loop'];
  if (url) args.push(validateUrl(url));
  if (kind === 'dry-run') args.push('--dry-run');
  // The Fix loop's first round signs in, in a visible window (--login --stay).
  if (signIn && kind === 'loop') args.push('--sign-in-first');
  // The report the person just saw stands in for round 1's crawl (the loop checks it is usable).
  // true: from the ledger with no crawl (fix the remaining without waiting for a deployment).
  if (fromReport === true && kind === 'loop') args.push('--from-report');
  else if (fromReport && kind === 'loop') args.push('--from-report', fromReport);
  // Fixes waiting for a deployment: check first (also the default), crawl anyway, or keep waiting.
  if (deploy === 'verify' && kind === 'loop') args.push('--verify');
  if (deploy === 'verify-anyway' && kind === 'loop') args.push('--verify-anyway');
  if (deploy === 'wait' && kind === 'loop') args.push('--wait');
  // Continue after an interruption: the last round goes on from the ledger, with no crawl.
  if (resume && kind === 'loop') args.push('--resume');
  if (kind === 'loop') args.push('--max-rounds', '0');
  if (agent) args.push('--agent', agent);
  // The dashboard's config (kept out of the repository), when it is not the default file.
  if (config) args.push('--config', config);
  const crawl = [...optionArgs(options), ...a.args];
  // The session file (the dashboard's own): every round's crawl uses it, and --sign-in-first saves it.
  if (stateFile && !crawl.some((x) => /^--(state|login|login-only|cookie)$/.test(x))) crawl.push('--state', stateFile);
  // Sign-ins in the dashboard's own browser, as tabs of its window (round 1's, and one an expired session needs).
  if (connect) crawl.push('--connect', String(connect));
  args.push(...crawl);
  try {
    parseArgs(crawl);
  } catch (e) {
    throw new BadRequest(e.message);
  }
  return { args, token: a.token };
}

const shq = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const psq = (s) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "''")}'`);
const cmdq = (s) => (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`);

// What a person would type in a terminal in the dashboard's working directory,
// in the dashboard's shell: POSIX syntax (Git Bash too), or PowerShell or cmd
// syntax when that is the shell on Windows. The token is never in it.
export function commandLine({ cwd, args, token, shell = 'sh' }) {
  let bin = relative(cwd, BIN);
  if (isAbsolute(bin) || bin.startsWith('..')) bin = BIN;
  const none = token === 'none';
  if (shell === 'powershell') return `${none ? '' : "$env:TOKEN='...'; "}node ${psq(bin)} ${args.map(psq).join(' ')}`;
  if (shell === 'cmd') return `${none ? '' : 'set "TOKEN=..." && '}node ${cmdq(bin)} ${args.map(cmdq).join(' ')}`;
  const env = none ? '' : 'TOKEN=$TOKEN ';
  return `${env}node ${shq(bin)} ${args.map(shq).join(' ')}`;
}

// The manual flow (docs/plans/manual-findings.md): `manual <pdf>`, with the loop's config and the
// crawl's way in for the evidence browser (the dashboard's session file, its own browser for a sign-in).
export function manualArgs({ pdf, url = null, options, auth, agent = null, config = null, stateFile = null, connect = null }) {
  if (!pdf || typeof pdf !== 'string') throw new BadRequest('a PDF is required');
  const a = authArgs(auth);
  const args = ['manual', pdf];
  if (url) args.push(validateUrl(url));
  if (agent) args.push('--agent', agent);
  if (config) args.push('--config', config);
  const crawl = [...optionArgs(options), ...a.args];
  if (stateFile && !crawl.some((x) => /^--(state|login|login-only|cookie)$/.test(x))) crawl.push('--state', stateFile);
  if (connect) crawl.push('--connect', String(connect));
  args.push(...crawl);
  try {
    parseArgs(crawl);
  } catch (e) {
    throw new BadRequest(e.message);
  }
  return { args, token: a.token };
}
