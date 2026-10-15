import { localTime } from './format';
import type { Tally, LoopTimeline } from './types';
import { plainReason, signInFailed } from './outcome';

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
  // Waiting for a deployment: the await-deploy event's facts (until null: no limit; meanwhile: the
  // remaining findings are being fixed from the ledger while it waits).
  waiting: { branch: string; intervalMs: number; until: number | null; meanwhile?: number } | null;
  // The run's deployment event: arrived, still-old, unreachable, timeout, stopped-waiting, verify-anyway.
  deployment: string | null;
  // How many fixes the arrived deployment is verifying.
  verifying: number | null;
  loginWaiting: boolean;
  // Why it stopped, when it failed.
  reason: string | null;
  // The try again the server scheduled after it (precondition, error, wait), when one is coming.
  retrying?: { kind: string; attempt: number } | null;
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

// "3:28 PM", in the viewer's time zone.
export function clock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
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
  // What the tool does next, never what the person may choose.
  const next = pending && open
    ? `fix the ${open} remaining while your deployment is awaited, then verify the ${plural(pending, 'fix', 'fixes')} against the new build`
    : pending ? `verify the ${plural(pending, 'fix', 'fixes')} as soon as the new build is live`
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
    if (live.waiting && live.waiting.meanwhile) return `fixing the ${live.waiting.meanwhile} remaining while your deployment of ${live.waiting.branch} is awaited`;
    if (live.waiting) return `waiting for your deployment of ${live.waiting.branch} (checks ${every(live.waiting.intervalMs)}${live.waiting.until !== null ? `, ${timeLeft(live.waiting.until - now)}` : ''})`;
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
    if (live.retrying && live.retrying.kind === 'precondition') return 'the fix loop could not start yet; it starts by itself once that is done';
    if (live.retrying && live.retrying.kind === 'wait') return 'waiting for your deployment';
    if (live.retrying && live.outcome !== 'interrupted') {
      const said = plainReason(live.reason || 'the fix loop ended with an error').replace(/\.$/, '');
      return `stopped: ${said.charAt(0).toLowerCase()}${said.slice(1)}; trying again by itself`;
    }
    if (live.outcome === 'awaiting-deploy') return live.deployment === 'still-old' ? 'your deployment has not arrived yet — the site still serves the old build' : live.deployment === 'unreachable' ? "could not check the site's build" : 'your deployment has not arrived yet';
    if (live.outcome === 'interrupted') return 'the fix loop was interrupted; continuing from there';
    if ((live.outcome === 'stopped' || live.outcome === 'error') && signInFailed([live.reason])) return 'nobody signed in, so the site was not checked';
    if (live.outcome === 'stopped') return 'stopped';
    if (live.outcome === 'error') {
      const said = plainReason(live.reason || 'the fix loop ended with an error').replace(/\.$/, '');
      return `stopped: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
    }
    return 'finished';
  }
  if (timeline?.deploy && counts['pending']) return `your fixes wait for a deployment of ${timeline.deploy.branch}`;
  return 'nothing is running';
}

// A span in the words a person uses: "2 h 41 min", "41 min", "50 s".
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// The whole run so far in one line. live: the loop is running, so the time runs to now.
export function tallyLine(t: Tally, now: number, live: boolean): string {
  const start = t.startedAt ? Date.parse(t.startedAt) : NaN;
  const end = live ? now : t.lastAt ? Date.parse(t.lastAt) : NaN;
  const time = Number.isFinite(start) && Number.isFinite(end) && end > start ? ` in ${span(end - start)}` : '';
  const parts = [`${t.rounds} round${t.rounds === 1 ? '' : 's'}${time}`, `${t.found} found`, `${t.verified} verified fixed`];
  if (t.pending) parts.push(`${t.pending} awaiting verification`);
  if (t.open) parts.push(`${t.open} open`);
  if (t.skipped) parts.push(`${t.skipped} could not be fixed`);
  if (t.adequate) parts.push(`${t.adequate} judged fine`);
  if (t.calls) parts.push(`${t.calls} assistant call${t.calls === 1 ? '' : 's'}, ${span(t.agentMs / t.calls)} each on average`);
  if (t.didNotHold) parts.push(`${t.didNotHold} fix${t.didNotHold === 1 ? '' : 'es'} did not hold after a deployment`);
  return parts.join(' · ');
}

// When fixes keep failing to hold after deployments and almost none verify, the builds the site
// serves most likely do not include the loop's branch: said once, with the one thing that changes it.
export function notHoldingLine(t: Tally): string | null {
  if (t.didNotHold < 2 || t.didNotHold <= t.verifiedTotal) return null;
  const b = t.branch || "the loop's branch";
  return `${t.didNotHold} fixes counted as not holding after your deployments, and ${t.verifiedTotal} verified: the builds the site serves do not seem to include branch ${b}. Merge it into the branch your pipeline builds; until then the fixes are tried again against builds without them.`;
}
