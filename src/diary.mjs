// The diagnostics diary: one JSON line per thing that went wrong or ended, appended to
// <state base>/diary.ndjson (~/.a11y-508, %APPDATA%\a11y-508 on Windows, A11Y_508_HOME in tests) by
// the dashboard's server and by the CLI alike: a browser that exited (with its exit code, signal and
// last stderr lines), a kill a11y-508 made or refused, a run that failed, the server starting and
// stopping. Nothing here ever throws: a diary that cannot be written must not end a run.
//
// Credentials never reach it: the values registered with addDiarySecrets (a run's token, cookies,
// header values), TOKEN from the environment, and anything after "Bearer", "cookie:",
// "authorization:" or a "token=" are written as [redacted].

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateBase } from './home.mjs';

export const DIARY_FILE = 'diary.ndjson';
const MAX_BYTES = 1024 * 1024;
const KEEP_LINES = 2000;

export const diaryPath = (env = process.env) => join(stateBase(env), DIARY_FILE);

const secrets = new Set();
// Values that must never be written (a token, a cookie or a header value), at least 4 characters.
export function addDiarySecrets(list) {
  for (const s of list || []) if (typeof s === 'string' && s.trim().length >= 4) secrets.add(s.trim());
}

const PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [redacted]'],
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-[a-z0-9-]*(?:token|key|auth)[a-z0-9-]*)(\s*[:=]\s*)("?)[^\s";,]{2,}[^\n"]*/gi, '$1$2$3[redacted]'],
  [/\b((?:access_|id_|auth_|refresh_)?token|api_?key|password|secret)=([^\s&"]{2,})/gi, '$1=[redacted]'],
];

export function redactDiary(text, env = process.env) {
  let t = String(text);
  const list = [...secrets, env.TOKEN && env.TOKEN.trim()].filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
  for (const s of list) t = t.split(s).join('[redacted]');
  for (const [re, to] of PATTERNS) t = t.replace(re, to);
  return t;
}

// Every string in the entry (keys stay), redacted before it is serialised.
function deepRedact(v, env, depth = 0) {
  if (typeof v === 'string') return redactDiary(v, env);
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepRedact(x, env, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = deepRedact(x, env, depth + 1);
  return out;
}

// Appends one entry: { at, pid, source, type, ... }. Returns the entry as written, or null.
export function writeDiary(entry, { env = process.env, source = null } = {}) {
  try {
    const e = { at: new Date().toISOString(), pid: process.pid, ...(source ? { source } : {}), ...entry };
    const red = deepRedact(e, env);
    const line = JSON.stringify(red);
    const file = diaryPath(env);
    mkdirSync(stateBase(env), { recursive: true, mode: 0o700 });
    trim(file);
    appendFileSync(file, line + '\n', { mode: 0o600 });
    return red;
  } catch {
    return null;
  }
}

// Past ~1 MB the oldest lines are dropped (the newest KEEP_LINES stay).
function trim(file) {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    writeFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
  } catch {}
}

// The entries, newest first (at most limit).
export function readDiary({ env = process.env, limit = 200 } = {}) {
  let text;
  try {
    text = readFileSync(diaryPath(env), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i].trim()) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e);
    } catch {}
  }
  return out;
}

// The last n lines of a browser's stderr, kept as it arrives (a ring of lines; the pipe is always
// drained, so the browser never blocks on a full pipe).
export function stderrRing(stream, n = 50) {
  const lines = [];
  let partial = '';
  if (stream) {
    stream.on('data', (d) => {
      const parts = (partial + d).split(/\r?\n/);
      partial = parts.pop();
      for (const l of parts) {
        if (!l.trim()) continue;
        lines.push(l.slice(0, 500));
        if (lines.length > n) lines.shift();
      }
      if (partial.length > 4000) partial = partial.slice(-4000);
    });
    stream.on('error', () => {});
  }
  return () => (partial.trim() ? [...lines, partial.slice(0, 500)].slice(-n) : [...lines]);
}

// How a browser's exit reads to a person: killed, crashed, closed normally, or exited unexpectedly.
export function exitCause(code, signal, platform = process.platform) {
  if (signal) return 'killed';
  if (code === 0) return 'closed normally';
  if (platform === 'win32' && code === 1) return 'killed';
  // A Windows exception code (0xC0000005 and friends), as Node reports it: unsigned or negative.
  if (typeof code === 'number' && (code >= 0xc0000000 || code < 0)) return 'crashed';
  if (code === null || code === undefined) return 'exited';
  return 'exited unexpectedly';
}

export function codeText(code) {
  if (code === null || code === undefined) return 'none';
  if (typeof code === 'number' && (code >= 0xc0000000 || code < 0)) return `0x${(code >>> 0).toString(16).toUpperCase()}`;
  return String(code);
}

// The kill paths, in words.
export const KILL_WORDS = {
  stop: 'Stop',
  'check-time-limit': 'the check time limit',
  'crawl-close': "closing a crawl's browser",
  'detection-timeout': 'the assistant detection time limit',
  quit: 'Quit',
};
