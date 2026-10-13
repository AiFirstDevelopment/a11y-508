// The reports the dashboard can show: the latest crawl (a11y-508-report/), the
// earlier ones (a11y-508-history/<finishedAt>/), and each loop round
// (a11y-508-work/round-N/). Every file is served from inside its own report
// directory and nowhere else.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

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
