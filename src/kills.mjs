// Every process-tree kill a11y-508 makes goes through here, so that (1) none can reach the
// dashboard's own browser, the dashboard server, or the process doing the killing and its
// ancestors, and (2) each one is remembered: a "last kill" in this process and a `kill` line in the
// diary (src/diary.mjs), so the dashboard can say "a11y-508 had just run Stop" when its browser
// goes away seconds later, even when the kill was made by the CLI in another process.
//
// Protected: this process, its parent chain (`ps` on POSIX; on Windows only process.ppid, no
// PowerShell or wmic), the pids registered with protectPid (the server registers its own browser),
// and every dashboard server and its own browser recorded in <state base>/server-<port>.json.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateBase } from './home.mjs';
import { readDiary, writeDiary, KILL_WORDS } from './diary.mjs';

const registered = new Map();
export function protectPid(pid, label) {
  if (Number.isInteger(pid) && pid > 0) registered.set(pid, label);
}
export function unprotectPid(pid) {
  registered.delete(pid);
}

function ancestors() {
  const out = new Map([[process.pid, 'the process doing the killing']]);
  if (process.ppid > 1) out.set(process.ppid, 'its parent process');
  if (process.platform === 'win32') return out;
  let p = process.ppid;
  for (let i = 0; i < 20 && p > 1; i++) {
    let next;
    try {
      next = parseInt(spawnSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8' }).stdout, 10);
    } catch {
      break;
    }
    if (!Number.isInteger(next) || next <= 1) break;
    if (!out.has(next)) out.set(next, 'an ancestor of the process doing the killing');
    p = next;
  }
  return out;
}

function recordedDashboards(env) {
  const out = new Map();
  let names = [];
  try {
    names = readdirSync(stateBase(env)).filter((n) => /^server-\d+\.json$/.test(n));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(stateBase(env), n), 'utf8'));
      if (Number.isInteger(r.pid)) out.set(r.pid, 'the dashboard server');
      if (Number.isInteger(r.ownBrowserPid)) out.set(r.ownBrowserPid, "the dashboard's own browser");
    } catch {}
  }
  return out;
}

// What pid is, when it must never be killed; null otherwise.
export function protectedLabel(pid, env = process.env) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (registered.has(pid)) return registered.get(pid);
  const fromFiles = recordedDashboards(env);
  if (fromFiles.has(pid)) return fromFiles.get(pid);
  const up = ancestors();
  return up.get(pid) || null;
}

// The set of protected pids (for the Windows sweep, which must never add one).
export function protectedPids(env = process.env) {
  return new Set([...registered.keys(), ...recordedDashboards(env).keys(), ...ancestors().keys()]);
}

// Null when pid may be killed; otherwise the refusal, written to the diary.
export function refuseKill(pid, kind, env = process.env) {
  const label = protectedLabel(pid, env);
  if (!label) return null;
  const message = `refused to kill process ${pid} (${label}) for ${KILL_WORDS[kind] || kind}`;
  writeDiary({ type: 'kill-refused', kill: kind, target: pid, label, message }, { env });
  return { refused: true, pid, label, message };
}

let last = null;
// A kill a11y-508 is about to make: kept in this process and written to the diary.
// 'test' (a test helper ending its own processes) is not recorded. The same kill of the same
// process within a second (Stop, then its process-tree kill) is written once.
export function recordKill(kind, detail = {}, env = process.env) {
  if (kind === 'test') return null;
  const now = Date.now();
  const repeat = last && last.kill === kind && (last.target ?? null) === (detail.target ?? null) && now - last.at < 1000;
  last = { kill: kind, at: now, ...detail };
  if (!repeat) writeDiary({ type: 'kill', kill: kind, ...detail }, { env });
  return last;
}

// The kill made within ms before `now`, by this process or (from the diary) by any other; null if none.
export function lastKill({ withinMs = 5000, now = Date.now(), env = process.env } = {}) {
  if (last && now - last.at <= withinMs && now >= last.at - 1000) return last;
  for (const e of readDiary({ env, limit: 50 })) {
    if (e.type !== 'kill') continue;
    const at = Date.parse(e.at);
    if (now - at <= withinMs && now >= at - 1000) return { ...e, at };
    if (now - at > withinMs) break;
  }
  return null;
}

// Tests only: forget the in-process last kill.
export function _resetKills() {
  last = null;
  registered.clear();
}
