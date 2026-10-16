// The reports the dashboard can show: the latest crawl (report/), the earlier ones
// (history/<finishedAt>/), and each loop round (work/round-N/), all in the tool's own folder for
// the repository under the state base (src/home.mjs), never in the repository. Every file is
// served from inside its own report directory and nowhere else.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { historyDir, migrateRepo, reportDir as latestDir, workDir } from '../../src/home.mjs';
import { discoveryFacts } from '../../src/report.mjs';

export { historyDir, latestDir, workDir };
export const ledgerPath = (cwd) => join(workDir(cwd), 'ledger.json');

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
  if (id === 'latest') return latestDir(cwd);
  let m = /^round-(\d{1,6})$/.exec(id);
  if (m) return join(workDir(cwd), `round-${m[1]}`);
  m = /^h-([0-9A-Za-z.\-_]{1,80})$/.exec(id);
  if (m && !m[1].startsWith('.')) return join(historyDir(cwd), m[1]);
  return null;
}

export function listReports(cwd) {
  const out = [];
  const latest = entry('latest', 'latest', latestDir(cwd));
  if (latest) out.push(latest);
  const hist = historyDir(cwd);
  if (existsSync(hist)) for (const d of readdirSync(hist)) {
    const e = /^[0-9A-Za-z.\-_]{1,80}$/.test(d) && !d.startsWith('.') ? entry(`h-${d}`, 'history', join(hist, d)) : null;
    if (e) out.push(e);
  }
  const work = workDir(cwd);
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

// Before a crawl: the previous report/ moves to history/<finishedAt>/, so the
// latest report stays where the README says it is.
export function moveLatestToHistory(cwd) {
  const latest = latestDir(cwd);
  const r = readJson(join(latest, 'report.json'));
  if (!r) return null;
  const stamp = String(r.finishedAt || new Date(statSync(latest).mtimeMs).toISOString()).replace(/:/g, '-');
  const hist = historyDir(cwd);
  mkdirSync(hist, { recursive: true });
  let name = stamp;
  for (let i = 2; existsSync(join(hist, name)); i++) name = `${stamp}-${i}`;
  renameSync(latest, join(hist, name));
  return name;
}

// Deleting from History: only history/<name>/ entries, by their h- id.
// The latest report and the loop's rounds are never deleted this way.
// Returns { status, body } for the route.
export function deleteHistoryEntry(cwd, id) {
  const m = /^h-([0-9A-Za-z.\-_]{1,80})$/.exec(String(id));
  if (!m || m[1].startsWith('.')) return { status: 400, body: { error: 'only an earlier report from History can be deleted' } };
  const root = resolve(historyDir(cwd));
  const dir = resolve(root, m[1]);
  if (!dir.startsWith(root + sep) || dir.slice(root.length + 1).includes(sep)) return { status: 400, body: { error: 'only an earlier report from History can be deleted' } };
  if (!existsSync(dir)) return { status: 404, body: { error: 'no such report' } };
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  return { status: 200, body: { removed: 1 } };
}

// One finding's whole story in a line: "found round 1 on /layout/home → fixed round 2 (a1b2c3), did not
// hold → fixed round 4 (d4e5f6), verified round 5".
export function storyOf(e) {
  const short = (u) => {
    try {
      const x = new URL(u);
      return `${x.pathname}${x.search}`;
    } catch {
      return String(u || '');
    }
  };
  const parts = [`found round ${e.firstSeenRound || 1}${e.pages && e.pages[0] && e.pages[0] !== 'site' ? ` on ${short(e.pages[0])}` : ''}`];
  for (const a of e.attempts || []) {
    if (!a) continue;
    if (a.commit && a.outcome === 'verified') parts.push(`fixed round ${a.round} (${a.commit}), verified${e.verifiedRound ? ` round ${e.verifiedRound}` : ''}`);
    else if (a.commit && a.outcome === 'still-present') parts.push(`fixed round ${a.round} (${a.commit}), did not hold`);
    else if (a.commit) parts.push(`fixed round ${a.round} (${a.commit})${a.outcome === 'pending' ? ', awaiting verification' : ''}`);
    else if (a.outcome === 'failed-gate') parts.push(`a fix broke the build round ${a.round}, reverted`);
    else if (a.outcome === 'interrupted') parts.push(`interrupted round ${a.round}`);
    else if (a.note === 'agent timed out') parts.push(`the assistant ran out of time round ${a.round}`);
    else if (a.outcome === 'no-change') parts.push(`no change round ${a.round}${a.note ? ` (${String(a.note).slice(0, 80)})` : ''}`);
  }
  if (e.status === 'skipped') parts.push(`given up${e.reason ? ` (${e.reason})` : ''}`);
  else if (e.status === 'gone') parts.push(`gone on its own${e.goneRound ? ` round ${e.goneRound}` : ''}`);
  return parts.join(' → ');
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
      // Only what the assistant changed and committed: a finding it did not change is not listed.
      if (outcome !== 'committed') continue;
      // The findings of one fix task share its attempt: one row, with how many elements it covered.
      const list = (changes[a.round] = changes[a.round] || []);
      const same = typeof a.n === 'number' ? list.find((x) => x.n === a.n) : null;
      if (same) {
        same.elements = (same.elements || 1) + 1;
        continue;
      }
      list.push({ elements: 1, story: storyOf(e),
        n: a.n ?? null, test: e.test, message: e.message, files: Array.isArray(a.files) ? a.files : [], outcome, commit: a.commit || null, note: a.note || null,
        agentMs: a.agentMs ?? null, gateMs: a.gateMs ?? null, gateCode: a.gateCode ?? null,
        gateTail: a.gateOutput ? String(a.gateOutput).split('\n').filter((l) => l.trim()).slice(-15).join('\n') : null,
      });
    }
  }
  for (const list of Object.values(changes)) list.sort((x, y) => (x.n ?? 0) - (y.n ?? 0));
  // Rounds whose committed fixes still wait for a deployment (ledger.deploy): "awaiting deployment",
  // never a failure.
  const waitingRounds = new Set();
  if (ledger.deploy) {
    for (const e of Object.values(ledger.findings || {})) {
      if (e.status !== 'pending') continue;
      const a = (e.attempts || [])[e.attempts.length - 1];
      if (a && a.commit) waitingRounds.add(a.round);
    }
  }
  const rounds = ledger.rounds.map((r) => {
    const made = covered[r.round] || 0;
    const fixed = (r.diff && r.diff.verified) || 0;
    const state = waitingRounds.has(r.round) ? 'awaiting-deploy' : 'done';
    return {
      round: r.round, at: r.at || null, found: r.violations, commits: commits[r.round] ? commits[r.round].size : 0, covered: made, changes: changes[r.round] || [],
      // fixed: the findings the round's commits covered; verified: earlier fixes its crawl confirmed.
      // remaining: what the round left open (recorded at its end); for the last round, the ledger's open count now.
      fixed: made, verified: fixed, remaining: r.round === last ? counts.open || 0 : typeof r.openAfter === 'number' ? r.openAfter : Math.max(0, r.violations - made),
      source: r.source || 'crawl', pages: r.pages ?? null, audited: r.audited ?? null, reviews: r.reviews ?? null, failed: (r.diff && r.diff.failed) || 0,
      branch: r.branch || null, pushed: !!r.pushed, remote: r.remote || null,
      state, label: state === 'awaiting-deploy' ? 'awaiting deployment' : null,
    };
  });
  const fixed = counts.verified || 0;
  const remaining = counts.open || 0;
  const deploy = ledger.deploy ? { round: ledger.deploy.round, branch: ledger.deploy.branch, remote: ledger.deploy.remote, pushed: !!ledger.deploy.pushed, host: ledger.deploy.host, since: ledger.deploy.since } : null;
  // The whole run so far in a few numbers: the Fix step and History show them in one line.
  const every = Object.values(ledger.findings || {});
  const calls = every.flatMap((e) => e.attempts || []).filter((a) => a && typeof a.agentMs === 'number');
  const allCommits = new Set(every.flatMap((e) => (e.attempts || []).filter((a) => a && a.commit).map((a) => a.commit)));
  const tally = {
    rounds: rounds.length, startedAt: ledger.rounds[0].at || null, lastAt: ledger.rounds[ledger.rounds.length - 1].at || null,
    found: every.length, verified: fixed, pending: counts.pending || 0, open: remaining, skipped: counts.skipped || 0, adequate: counts.adequate || 0, gone: counts.gone || 0, review: counts.review || 0,
    commits: allCommits.size, calls: calls.length, agentMs: calls.reduce((a, x) => a + x.agentMs, 0),
    didNotHold: ledger.rounds.reduce((a, r) => a + ((r.diff && r.diff.failed) || 0), 0), verifiedTotal: ledger.rounds.reduce((a, r) => a + ((r.diff && r.diff.verified) || 0), 0),
    branch: (ledger.deploy && ledger.deploy.branch) || [...ledger.rounds].reverse().map((r) => r.branch).find(Boolean) || null,
  };
  return { rounds, deploy, total: { rounds: rounds.length, fixed, pending: counts.pending || 0, of: fixed + remaining + (counts.pending || 0), remaining, tally } };
}

// Clear the fix loop's history: its rounds (work/round-N/) and the ledger. The prompts
// and logs stay.
export function clearLoopHistory(cwd) {
  const root = resolve(workDir(cwd));
  if (!existsSync(root)) return { removed: 0 };
  let removed = 0;
  for (const d of readdirSync(root)) {
    if (!/^round-\d+$/.test(d) && d !== 'ledger.json') continue;
    rmSync(join(root, d), { recursive: true, force: true, maxRetries: 5 });
    if (d !== 'ledger.json') removed++;
  }
  return { removed };
}

// Clear history: every entry directly under history/, and nothing else.
export function clearHistory(cwd) {
  const root = resolve(historyDir(cwd));
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
// new folder's own place under the state base. They are the tool's own files, never in either
// repository, so they move. Nothing already there is overwritten: a latest report there for
// another URL goes to its history first. Returns what was carried.
export function carryAnalysis(from, to, url) {
  const out = { report: false, history: 0, work: false, moved: false };
  if (!url || resolve(from) === resolve(to)) return out;
  // Either folder may still hold the old in-repository folders.
  migrateRepo(from);
  migrateRepo(to);
  const latest = readJson(join(latestDir(from), 'report.json'));
  if (!latest || !sameStartUrl(latest.baseUrl, url)) return out;
  const there = readJson(join(latestDir(to), 'report.json'));
  if (there && sameStartUrl(there.baseUrl, url) && String(there.finishedAt) >= String(latest.finishedAt)) return out;
  out.moved = true;
  const put = (src, dst) => {
    mkdirSync(dirname(dst), { recursive: true });
    try {
      renameSync(src, dst);
      return;
    } catch {}
    cpSync(src, dst, { recursive: true });
    rmSync(src, { recursive: true, force: true, maxRetries: 5 });
  };
  if (there) moveLatestToHistory(to);
  else rmSync(latestDir(to), { recursive: true, force: true, maxRetries: 5 });
  put(latestDir(from), latestDir(to));
  out.report = true;
  const hist = historyDir(from);
  if (existsSync(hist)) {
    for (const d of readdirSync(hist)) {
      const r = readJson(join(hist, d, 'report.json'));
      if (!r || !sameStartUrl(r.baseUrl, url) || existsSync(join(historyDir(to), d))) continue;
      put(join(hist, d), join(historyDir(to), d));
      out.history++;
    }
  }
  // The loop's work folder: when its rounds are for this URL and the new folder has none.
  const work = workDir(from);
  if (existsSync(work) && !existsSync(workDir(to))) {
    const rounds = readdirSync(work).filter((d) => /^round-\d+$/.test(d)).map((d) => readJson(join(work, d, 'report.json'))).filter(Boolean);
    if (rounds.length && rounds.every((r) => sameStartUrl(r.baseUrl, url))) {
      put(work, workDir(to));
      out.work = true;
    }
  }
  return out;
}

// Every route the loop's rounds (and the latest crawl) have audited, merged by URL: how often, with
// what result, and what the crawler found on it (links, controls clicked, pages behind them, controls
// it refused to click); with the latest crawl's coverage warnings. "Why not more pages", in one place.
export function crawledRoutes(cwd) {
  const sources = [];
  const work = workDir(cwd);
  if (existsSync(work)) for (const d of readdirSync(work)) {
    const m = /^round-(\d+)$/.exec(d);
    const r = m ? readJson(join(work, d, 'report.json')) : null;
    if (r) sources.push({ round: Number(m[1]), report: r });
  }
  sources.sort((a, b) => a.round - b.round);
  const latest = readJson(join(latestDir(cwd), 'report.json'));
  if (latest && !sources.some((s) => s.report.finishedAt === latest.finishedAt)) sources.push({ round: null, report: latest });
  sources.sort((a, b) => String(a.report.finishedAt || '').localeCompare(String(b.report.finishedAt || '')));
  const pathOf = (url) => {
    try {
      const u = new URL(url);
      return `${u.pathname || '/'}${u.search}${u.hash}`;
    } catch {
      return url;
    }
  };
  const byUrl = new Map();
  for (const { round, report } of sources) {
    for (const p of report.pages || []) {
      const url = p.finalUrl || p.url;
      const row = byUrl.get(url) || { url, path: pathOf(url), title: null, rounds: [], audited: 0, errors: 0, skipped: 0, status: null, violations: 0, reviews: 0, found: null, foundBy: null, lastAt: null };
      if (round != null && !row.rounds.includes(round)) row.rounds.push(round);
      if (p.error) {
        row.errors++;
        row.status = `error: ${p.error}`;
      } else if (p.skipped) {
        row.skipped++;
        row.status = `skipped: ${p.skipped}`;
      } else {
        row.audited++;
        row.status = 'audited';
        row.title = p.title || row.title;
        row.violations = (p.findings || []).filter((f) => f.level === 'violation').length;
        row.reviews = (p.findings || []).filter((f) => f.level !== 'violation').length;
      }
      row.found = discoveryFacts(p);
      row.foundBy = p.foundBy || row.foundBy || 'link';
      row.lastAt = report.finishedAt || row.lastAt;
      byUrl.set(url, row);
    }
  }
  const last = sources[sources.length - 1];
  const cov = (last && last.report.summary && last.report.summary.coverage) || { complete: true, warnings: [], notes: [] };
  return {
    routes: [...byUrl.values()].sort((a, b) => a.path.localeCompare(b.path)),
    rounds: sources.filter((s) => s.round != null).length,
    discovered: last && last.report.summary ? last.report.summary.pages || 0 : 0,
    coverage: { complete: cov.complete !== false, warnings: cov.warnings || [], notes: cov.notes || [] },
  };
}
