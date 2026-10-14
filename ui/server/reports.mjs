// The reports the dashboard can show: the latest crawl (a11y-508-report/), the
// earlier ones (a11y-508-history/<finishedAt>/), and each loop round
// (a11y-508-work/round-N/). Every file is served from inside its own report
// directory and nowhere else.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export const REPORT_DIR = 'a11y-508-report';
export const HISTORY_DIR = 'a11y-508-history';
export const WORK_DIR = 'a11y-508-work';

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

export function resultOf(r) {
  const s = r.summary || {};
  if (!s.audited) return 'nothing-audited';
  if (!r.passed) return 'fail';
  return s.coverage && !s.coverage.complete ? 'incomplete' : 'pass';
}

function entry(id, source, dir, extra = {}) {
  const r = readJson(join(dir, 'report.json'));
  if (!r) return null;
  const s = r.summary || {};
  return {
    id, source, ...extra,
    finishedAt: r.finishedAt || null, startedAt: r.startedAt || null, baseUrl: r.baseUrl || null, passed: !!r.passed, result: resultOf(r),
    summary: { pages: s.pages, audited: s.audited, violations: s.violations, reviews: s.reviews, byImpact: s.byImpact, coverageComplete: !s.coverage || s.coverage.complete },
  };
}

// id -> absolute directory, for the ids listReports hands out; null otherwise.
export function reportDir(cwd, id) {
  if (id === 'latest') return join(cwd, REPORT_DIR);
  let m = /^round-(\d{1,6})$/.exec(id);
  if (m) return join(cwd, WORK_DIR, `round-${m[1]}`);
  m = /^h-([0-9A-Za-z.\-_]{1,80})$/.exec(id);
  if (m && !m[1].startsWith('.')) return join(cwd, HISTORY_DIR, m[1]);
  return null;
}

export function listReports(cwd) {
  const out = [];
  const latest = entry('latest', 'latest', join(cwd, REPORT_DIR));
  if (latest) out.push(latest);
  const hist = join(cwd, HISTORY_DIR);
  if (existsSync(hist)) for (const d of readdirSync(hist)) {
    const e = /^[0-9A-Za-z.\-_]{1,80}$/.test(d) && !d.startsWith('.') ? entry(`h-${d}`, 'history', join(hist, d)) : null;
    if (e) out.push(e);
  }
  const work = join(cwd, WORK_DIR);
  if (existsSync(work)) for (const d of readdirSync(work)) {
    const m = /^round-(\d+)$/.exec(d);
    const e = m ? entry(d, 'round', join(work, d), { round: Number(m[1]) }) : null;
    if (e) out.push(e);
  }
  return out.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
}

export function readReport(cwd, id) {
  const dir = reportDir(cwd, id);
  if (!dir) return null;
  const r = readJson(join(dir, 'report.json'));
  return r ? { id, ...r } : null;
}

// A file inside the report directory, or null when the path escapes it.
export function confinedFile(cwd, id, rel) {
  const dir = reportDir(cwd, id);
  if (!dir || typeof rel !== 'string' || rel.includes('\0')) return null;
  const root = resolve(dir);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

// Before a crawl: the previous a11y-508-report/ moves to
// a11y-508-history/<finishedAt>/, so the latest report stays where the
// README's runbook says it is.
export function moveLatestToHistory(cwd) {
  const latest = join(cwd, REPORT_DIR);
  const r = readJson(join(latest, 'report.json'));
  if (!r) return null;
  const stamp = String(r.finishedAt || new Date(statSync(latest).mtimeMs).toISOString()).replace(/:/g, '-');
  mkdirSync(join(cwd, HISTORY_DIR), { recursive: true });
  let name = stamp;
  for (let i = 2; existsSync(join(cwd, HISTORY_DIR, name)); i++) name = `${stamp}-${i}`;
  renameSync(latest, join(cwd, HISTORY_DIR, name));
  return name;
}

// Deleting from History: only a11y-508-history/<name>/ entries, by their h- id.
// The latest report and the loop's rounds are never deleted this way.
// Returns { status, body } for the route.
export function deleteHistoryEntry(cwd, id) {
  const m = /^h-([0-9A-Za-z.\-_]{1,80})$/.exec(String(id));
  if (!m || m[1].startsWith('.')) return { status: 400, body: { error: 'only a report from a11y-508-history can be deleted' } };
  const root = resolve(cwd, HISTORY_DIR);
  const dir = resolve(root, m[1]);
  if (!dir.startsWith(root + sep) || dir.slice(root.length + 1).includes(sep)) return { status: 400, body: { error: 'only a report from a11y-508-history can be deleted' } };
  if (!existsSync(dir)) return { status: 404, body: { error: 'no such report' } };
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  return { status: 200, body: { removed: 1 } };
}

// The fix loop's rounds as a timeline: per round, from the ledger, the violations its crawl found,
// the earlier fixes verified gone at that crawl, the commits it made, and what remained after it
// (for the last round, the ledger's open count; before that, found less committed).
export function loopTimeline(ledger, counts) {
  if (!ledger || !Array.isArray(ledger.rounds) || !ledger.rounds.length) return null;
  // Per round: the commits made (one per fix task: a group of findings shares one) and the findings they covered.
  const commits = {};
  const covered = {};
  for (const e of Object.values(ledger.findings || {})) {
    for (const a of e.attempts || []) {
      if (!a.commit) continue;
      (commits[a.round] = commits[a.round] || new Set()).add(a.commit);
      covered[a.round] = (covered[a.round] || 0) + 1;
    }
  }
  const last = ledger.rounds[ledger.rounds.length - 1].round;
  // Each round's fix attempts, as the Fix step's "Changes this run" list shows them.
  const changes = {};
  for (const e of Object.values(ledger.findings || {})) {
    for (const a of e.attempts || []) {
      if (!a || typeof a.round !== 'number') continue;
      const outcome = a.commit ? 'committed' : a.outcome === 'failed-gate' ? 'failed-gate' : a.note === 'agent timed out' ? 'timed-out' : a.outcome === 'still-present' ? 'committed' : 'no-change';
      // The findings of one fix task share its attempt: one row, with how many elements it covered.
      const list = (changes[a.round] = changes[a.round] || []);
      const same = typeof a.n === 'number' ? list.find((x) => x.n === a.n) : null;
      if (same) {
        same.elements = (same.elements || 1) + 1;
        continue;
      }
      list.push({ elements: 1,
        n: a.n ?? null, test: e.test, message: e.message, files: Array.isArray(a.files) ? a.files : [], outcome, commit: a.commit || null,
        agentMs: a.agentMs ?? null, gateMs: a.gateMs ?? null, gateCode: a.gateCode ?? null,
        gateTail: a.gateOutput ? String(a.gateOutput).split('\n').filter((l) => l.trim()).slice(-15).join('\n') : null,
      });
    }
  }
  for (const list of Object.values(changes)) list.sort((x, y) => (x.n ?? 0) - (y.n ?? 0));
  const rounds = ledger.rounds.map((r) => {
    const made = covered[r.round] || 0;
    const fixed = (r.diff && r.diff.verified) || 0;
    return { round: r.round, at: r.at || null, found: r.violations, fixed, commits: commits[r.round] ? commits[r.round].size : 0, changes: changes[r.round] || [], remaining: r.round === last ? counts.open || 0 : Math.max(0, r.violations - made), needsHuman: r.round === last ? counts['needs-human'] || 0 : 0 };
  });
  const fixed = counts.verified || 0;
  const remaining = counts.open || 0;
  const needsHuman = counts['needs-human'] || 0;
  // Findings a person closed (looks fine, won't fix) on the Needs a person screen: resolved, not remaining.
  const decided = Object.values(ledger.findings || {}).filter((e) => e.decision && e.decision.by === 'person' && ['adequate', 'wont-fix'].includes(e.status)).length;
  return { rounds, total: { rounds: rounds.length, fixed, pending: counts.pending || 0, of: fixed + remaining + (counts.pending || 0) + needsHuman + decided, remaining, needsHuman, decided } };
}

// Clear the fix loop's history: its rounds (a11y-508-work/round-N/) and the ledger. The prompts
// and logs stay.
export function clearLoopHistory(cwd) {
  const root = resolve(cwd, WORK_DIR);
  if (!existsSync(root)) return { removed: 0 };
  let removed = 0;
  for (const d of readdirSync(root)) {
    if (!/^round-\d+$/.test(d) && d !== 'ledger.json') continue;
    rmSync(join(root, d), { recursive: true, force: true, maxRetries: 5 });
    if (d !== 'ledger.json') removed++;
  }
  return { removed };
}

// Clear history: every entry directly under a11y-508-history/, and nothing else.
export function clearHistory(cwd) {
  const root = resolve(cwd, HISTORY_DIR);
  if (!existsSync(root)) return { removed: 0 };
  let removed = 0;
  for (const d of readdirSync(root)) {
    const target = resolve(root, d);
    if (!target.startsWith(root + sep)) continue;
    rmSync(target, { recursive: true, force: true, maxRetries: 5 });
    removed++;
  }
  return { removed };
}

// Whether two start URLs are the same analysis: the same origin and path (the query and a
// trailing slash do not matter).
export function sameStartUrl(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

// The analysis belongs to the URL, not the folder: when the folder changes and the URL does not,
// the latest report for that URL, its history entries and the loop's work folder go along to the
// new folder. Moved when the old folder is not a git repository or git does not track them there
// (the dashboard wrote them); copied otherwise. Nothing already in the new folder is overwritten:
// a latest report there for another URL goes to its history first. Returns what was carried.
export function carryAnalysis(from, to, url, { inGit }) {
  const out = { report: false, history: 0, work: false, moved: false };
  if (!url || resolve(from) === resolve(to)) return out;
  const latest = readJson(join(from, REPORT_DIR, 'report.json'));
  if (!latest || !sameStartUrl(latest.baseUrl, url)) return out;
  const there = readJson(join(to, REPORT_DIR, 'report.json'));
  if (there && sameStartUrl(there.baseUrl, url) && String(there.finishedAt) >= String(latest.finishedAt)) return out;
  const tracked = (rel) => inGit(from) && spawnSync('git', ['ls-files', '--', rel], { cwd: from, encoding: 'utf8', windowsHide: true }).stdout.trim() !== '';
  const move = !inGit(from) || ![REPORT_DIR, HISTORY_DIR, WORK_DIR].some(tracked);
  out.moved = move;
  const put = (src, dst) => {
    mkdirSync(dirname(dst), { recursive: true });
    if (move) {
      try {
        renameSync(src, dst);
        return;
      } catch {}
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true, maxRetries: 5 });
    } else cpSync(src, dst, { recursive: true });
  };
  if (there) moveLatestToHistory(to);
  else rmSync(join(to, REPORT_DIR), { recursive: true, force: true, maxRetries: 5 });
  put(join(from, REPORT_DIR), join(to, REPORT_DIR));
  out.report = true;
  const hist = join(from, HISTORY_DIR);
  if (existsSync(hist)) {
    for (const d of readdirSync(hist)) {
      const r = readJson(join(hist, d, 'report.json'));
      if (!r || !sameStartUrl(r.baseUrl, url) || existsSync(join(to, HISTORY_DIR, d))) continue;
      put(join(hist, d), join(to, HISTORY_DIR, d));
      out.history++;
    }
  }
  // The loop's work folder: when its rounds are for this URL and the new folder has none.
  const work = join(from, WORK_DIR);
  if (existsSync(work) && !existsSync(join(to, WORK_DIR))) {
    const rounds = readdirSync(work).filter((d) => /^round-\d+$/.test(d)).map((d) => readJson(join(work, d, 'report.json'))).filter(Boolean);
    if (rounds.length && rounds.every((r) => sameStartUrl(r.baseUrl, url))) {
      put(work, join(to, WORK_DIR));
      out.work = true;
    }
  }
  return out;
}
