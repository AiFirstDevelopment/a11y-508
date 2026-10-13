// The ledger: every finding the loop has seen, keyed by fingerprint, with its
// status and history across rounds. It lives at a11y-508-work/ledger.json in
// the repository being fixed and is the only state the loop keeps, which is
// what lets the loop be stopped and resumed at any point.
//
// Statuses: review (awaiting triage), adequate (triage closed it), open (to be
// fixed), pending (fixed, waiting for a crawl after deployment to confirm),
// verified (confirmed gone after a fix), gone (disappeared without a fix),
// needs-human (the loop gave up on it), wont-fix (set by a person). A person's decision on a
// finding (the dashboard's Needs a person screen) is kept as entry.decision; see decide().

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const fingerprint = (f) => `${f.test}|${f.selector || ''}|${f.message}`;
export const ACTIVE = new Set(['review', 'open', 'pending']);

export function loadLedger(file) {
  if (!existsSync(file)) return { version: 1, rounds: [], findings: {} };
  const l = JSON.parse(readFileSync(file, 'utf8'));
  if (!l.findings || !Array.isArray(l.rounds)) throw new Error(`${file} is not an a11y-508 ledger`);
  return l;
}

export function saveLedger(file, ledger) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
}

export const pageKey = (p) => p.finalUrl || p.url;

// Folds one crawl report into the ledger and returns what changed.
export function applyReport(ledger, report, round, { maxAttempts = 3 } = {}) {
  const audited = new Set(report.pages.filter((p) => !p.error && !p.skipped).map(pageKey));
  const seen = new Map();
  const note = (f, page) => {
    const fp = fingerprint(f);
    const e = seen.get(fp) || { finding: f, pages: new Set() };
    e.pages.add(page);
    seen.set(fp, e);
  };
  for (const p of report.pages) for (const f of p.findings || []) note(f, pageKey(p));
  for (const f of (report.site && report.site.findings) || []) note(f, 'site');

  const diff = { new: [], still: [], failed: [], verified: [], gone: [], reopened: [], unchecked: [], gaveUp: [] };
  for (const entry of Object.values(ledger.findings)) {
    const cur = seen.get(entry.fingerprint);
    if (cur) {
      entry.lastSeenRound = round;
      entry.pages = [...cur.pages];
      if (entry.status === 'pending') {
        const last = entry.attempts[entry.attempts.length - 1];
        if (last) last.outcome = 'still-present';
        entry.status = 'open';
        diff.failed.push(entry);
        if (entry.attempts.length >= maxAttempts) {
          entry.status = 'needs-human';
          entry.reason = `still present after ${entry.attempts.length} fix attempts`;
          diff.gaveUp.push(entry);
        }
      } else if (entry.status === 'open' || entry.status === 'review') {
        diff.still.push(entry);
      } else if (entry.status === 'verified' || entry.status === 'gone') {
        entry.status = 'open';
        diff.reopened.push(entry);
      }
      continue;
    }
    const checked = entry.pages.includes('site') || entry.pages.some((u) => audited.has(u));
    if (!checked) {
      diff.unchecked.push(entry);
      continue;
    }
    if (entry.status === 'pending') {
      const last = entry.attempts[entry.attempts.length - 1];
      if (last) last.outcome = 'verified';
      entry.status = 'verified';
      entry.verifiedRound = round;
      diff.verified.push(entry);
    } else if (ACTIVE.has(entry.status) || entry.status === 'needs-human') {
      entry.status = 'gone';
      entry.goneRound = round;
      diff.gone.push(entry);
    }
  }
  for (const [fp, cur] of seen) {
    if (ledger.findings[fp]) continue;
    const f = cur.finding;
    ledger.findings[fp] = {
      fingerprint: fp,
      test: f.test,
      name: f.name,
      wcag: f.wcag,
      level: f.level,
      impact: f.impact,
      message: f.message,
      selector: f.selector || '',
      // Only a finding inside a same-origin frame has one.
      ...(f.frame ? { frame: f.frame } : {}),
      html: f.html || '',
      state: f.state || null,
      pages: [...cur.pages],
      status: f.level === 'violation' ? 'open' : 'review',
      firstSeenRound: round,
      lastSeenRound: round,
      attempts: [],
    };
    diff.new.push(ledger.findings[fp]);
  }
  const counts = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.length]));
  ledger.rounds.push({
    round,
    at: report.finishedAt,
    pages: report.summary.pages,
    audited: report.summary.audited,
    violations: report.summary.violations,
    reviews: report.summary.reviews,
    coverage: report.summary.coverage || null,
    diff: counts,
  });
  return diff;
}

export const byStatus = (ledger, status) => Object.values(ledger.findings).filter((e) => e.status === status);

const IMPACT_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
export function openFindings(ledger) {
  return byStatus(ledger, 'open').sort((a, b) => (IMPACT_RANK[a.impact] ?? 9) - (IMPACT_RANK[b.impact] ?? 9) || b.pages.length - a.pages.length);
}

export const isDone = (ledger) => !Object.values(ledger.findings).some((e) => ACTIVE.has(e.status));

// A person's decision on a finding that needs one: "adequate" (looks fine) and "wont-fix" close it
// for good -- no later crawl reopens it and the loop never fixes or re-asks it; "open" sends it back
// to the assistant with the note as guidance, its attempts reset so the loop tries again (the
// earlier ones are kept as earlierAttempts). Returns the entry; throws with { status } otherwise.
export const DECISIONS = ['adequate', 'wont-fix', 'open'];
export function decide(ledger, fp, { status, note = '', at = new Date().toISOString() } = {}) {
  const fail = (message, code = 400) => Object.assign(new Error(message), { status: code });
  const entry = ledger.findings[fp];
  if (!entry) throw fail('no such finding in the ledger', 404);
  if (!DECISIONS.includes(status)) throw fail(`decision must be one of ${DECISIONS.join(', ')}`);
  const text = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
  if (status === 'wont-fix' && !text) throw fail("say why it won't be fixed");
  // Only a finding that needs a person, or one a person already decided (changing their mind).
  if (entry.status !== 'needs-human' && !(entry.decision && entry.decision.by === 'person')) throw fail(`this finding is ${entry.status}, not waiting for a person`, 409);
  const round = ledger.rounds.length ? ledger.rounds[ledger.rounds.length - 1].round : 0;
  entry.decision = { by: 'person', status, note: text, at, round };
  entry.status = status;
  if (status === 'open') {
    entry.earlierAttempts = [...(entry.earlierAttempts || []), ...(entry.attempts || [])];
    entry.attempts = [];
    delete entry.reason;
  }
  return entry;
}

// The decision a person sent back with a finding ("Ask the assistant to fix it"), for its fix prompt.
export const personNote = (entry) => (entry && entry.decision && entry.decision.by === 'person' && entry.decision.status === 'open' && entry.decision.note) || '';

export function statusCounts(ledger) {
  const c = {};
  for (const e of Object.values(ledger.findings)) c[e.status] = (c[e.status] || 0) + 1;
  return c;
}
