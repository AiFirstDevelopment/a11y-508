import { localTime } from './format';
import type { LoopTimeline } from './types';

// "Where you are" (docs/plans/deploy-wait.md criteria 6 and 8): what has happened for this URL and
// what comes next, as a short checklist. One function, shared by the Fix step and History. The done
// lines come from the ledger (the timeline) and the latest report, so a reload shows the same; the
// Now line comes from the live run.

export interface WhereLine {
  kind: 'done' | 'now' | 'next';
  text: string;
  // Where the line's place is (Results, Changes this run, History).
  link: { path: string; fragment?: string; label: string } | null;
}

export interface WhereLive {
  // The run the dashboard follows (null when there is none).
  kind: string | null;
  active: boolean;
  outcome: string | null;
  round: number | null;
  step: string | null;
  // The crawl's pages in this round, when it is crawling.
  crawled: { done: number; discovered: number } | null;
  // The fix tasks in hand.
  task: { n: number; m: number } | null;
  // Waiting for a deployment: the await-deploy event's facts.
  waiting: { branch: string; intervalMs: number; until: number } | null;
  // The run's deployment event: arrived, still-old, timeout, stopped-waiting, verify-anyway.
  deployment: string | null;
  // How many fixes the arrived deployment is verifying.
  verifying: number | null;
  loginWaiting: boolean;
  // Why it stopped, when it failed.
  reason: string | null;
}

export interface WhereInput {
  report: { finishedAt?: string; pages?: number | null; violations?: number | null; reviews?: number | null } | null;
  timeline: LoopTimeline | null;
  counts: Record<string, number> | null;
  live: WhereLive | null;
  now: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "12 min left", "4 min 05 s left", "35 s left".
export function timeLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 600) return `${Math.round(s / 60)} min left`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s left`;
  return `${s} s left`;
}

// "every 30 s", "every 2 min".
export function every(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 || s % 60 ? `every ${s} s` : `every ${s / 60} min`;
}

export function whereYouAre(input: WhereInput): WhereLine[] {
  const { report, timeline, live, now } = input;
  const counts = input.counts || {};
  const lines: WhereLine[] = [];
  const rounds = timeline?.rounds || [];
  const first = rounds[0];
  // The crawl the work started from: the ledger's first round, else the latest report.
  const crawl = first && first.source !== 'ledger'
    ? { at: first.at, pages: first.pages ?? null, findings: (first.found || 0) + (first.reviews || 0) }
    : report && report.finishedAt ? { at: report.finishedAt, pages: report.pages ?? null, findings: (report.violations || 0) + (report.reviews || 0) } : null;
  if (crawl) {
    lines.push({ kind: 'done', text: `Crawled ${crawl.pages !== null ? plural(crawl.pages, 'page') : 'the site'} on ${localTime(crawl.at)} — ${plural(crawl.findings, 'finding')}`, link: { path: '/report', label: 'Results' } });
  }
  for (const [i, r] of rounds.entries()) {
    if (i > 0 && r.source === 'crawl') {
      const v = r.verified || 0;
      const f = r.failed || 0;
      lines.push({ kind: 'done', text: `Round ${r.round}: re-checked ${plural(r.audited ?? r.pages ?? 0, 'page')} — ${plural(v, 'fix', 'fixes')} verified${f ? `, ${f} did not hold` : ''}`, link: { path: '/history', label: 'History' } });
    }
    const n = r.covered ?? r.fixed ?? 0;
    if (n > 0) {
      const where = r.branch ? ` on branch ${r.branch}${r.pushed ? ` and pushed to ${r.remote || 'origin'}` : ''}` : '';
      lines.push({ kind: 'done', text: `Round ${r.round}: ${plural(n, 'fix', 'fixes')} committed${where}`, link: { path: '/fix-loop', fragment: 'changes', label: 'Changes this run' } });
    }
  }
  const now_ = nowLine(live, timeline, counts, now);
  if (now_) lines.push({ kind: 'now', text: `Now: ${now_}`, link: null });
  const pending = counts['pending'] || 0;
  const open = counts['open'] || 0;
  const next = pending
    ? `verify the ${plural(pending, 'fix', 'fixes')} against the new build${open ? `, then fix the ${open} remaining` : ''}`
    : open ? `fix the ${open} remaining`
    : counts['review'] ? `ask the assistant about the ${plural(counts['review'], 'review item')}`
    : timeline ? 'nothing left to fix; run again after the next change to the app'
    : crawl ? 'fix the violations' : 'crawl the site';
  lines.push({ kind: 'next', text: `Next: ${next}`, link: null });
  return lines;
}

function nowLine(live: WhereLive | null, timeline: LoopTimeline | null, counts: Record<string, number>, now: number): string {
  const loop = !!live && (live.kind === 'loop' || live.kind === 'dry-run');
  if (live && live.active) {
    if (!loop) return live.crawled && live.crawled.discovered ? `crawling the site (${live.crawled.done} of ${live.crawled.discovered} pages)` : `a ${live.kind || 'run'} is running`;
    if (live.loginWaiting) return 'waiting for you to sign in in the browser window';
    if (live.waiting) return `waiting for your deployment of ${live.waiting.branch} (checks ${every(live.waiting.intervalMs)}, ${timeLeft(live.waiting.until - now)})`;
    const r = live.round;
    if (!r) return 'starting the fix loop';
    if (live.step === 'await-deploy' || live.step === 'deploy') return `waiting for the new build of round ${r}'s fixes`;
    if (live.step === 'crawl' || live.step === null) {
      const pages = live.crawled && live.crawled.discovered ? ` (${live.crawled.done} of ${live.crawled.discovered} pages)` : '';
      if (live.deployment === 'arrived' && live.verifying) return `your deployment arrived — round ${r}: verifying ${plural(live.verifying, 'fix', 'fixes')}${pages}`;
      return `round ${r}: re-checking the site${pages}`;
    }
    if (live.task && live.task.m) return `round ${r}: fixing ${Math.max(1, live.task.n)} of ${live.task.m}`;
    if (live.step === 'triage') return `round ${r}: asking the assistant about review items`;
    if (live.step === 'push') return `round ${r}: pushing the fixes`;
    return `round ${r}: working`;
  }
  if (live && loop && live.outcome) {
    if (live.outcome === 'awaiting-deploy') return live.deployment === 'still-old' ? 'your deployment has not arrived yet — the site still serves the old build' : 'your deployment has not arrived yet';
    if (live.outcome === 'interrupted') return 'the fix loop was interrupted';
    if (live.outcome === 'stopped') return 'stopped';
    if (live.outcome === 'error') return `stopped: ${live.reason || 'the fix loop ended with an error'}`;
    return 'finished';
  }
  if (timeline?.deploy && counts['pending']) return `your fixes wait for a deployment of ${timeline.deploy.branch}`;
  return 'nothing is running';
}
