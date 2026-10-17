import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { readSse } from './sse';
import { CANNOT_GET_IN, Discovery, OFF_ORIGIN, PhaseEvent, Progress, cumulative, spoken } from './format';
import { ByImpact, Remedy, RetryInfo, RunEvent, RunInfo } from './types';
import { ManualState, applyManual, emptyManual } from './manual';

// One fix attempt of the loop: the finding, the files changed, what became of them, and how long the
// assistant and the check took.
export interface ChangeRow {
  round: number;
  n: number | null;
  test: string;
  message: string;
  elements?: number | null;
  files: string[];
  outcome: string;
  commit: string | null;
  agentMs: number | null;
  gateMs: number | null;
  gateCode: number | null;
  gateTail: string | null;
}

export interface PageRow {
  url: string;
  finalUrl: string;
  title: string;
  status: number | null;
  error: string | null;
  skipped: string | null;
  violations: number;
  reviews: number;
  byImpact: ByImpact;
  durationMs: number;
  round: number | null;
  // A modal dialog that was open when the page loaded, and whether Escape closed it.
  modalOnLoad: { selector: string; name: string; dismissed: boolean } | null;
  // What discovery did (the page event's additive fields; absent from an older CLI).
  discovery: Discovery;
  // 404 from the server, rendered by the app anyway (audited).
  servedWith: number | null;
  // The page's findings (absent from an older CLI).
  findings: { test: string; level: string; impact: string; message: string; selector: string }[];
}

// One call of the fixing assistant (a fix, or a triage batch), with its output as it arrives.
export interface AgentCall {
  round: number;
  task: number;
  kind: 'fix' | 'triage';
  n: number | null;
  m: number | null;
  label: string;
  // A triage call: how many review items the round triages.
  count?: number | null;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
  text: string;
  // When the assistant last printed anything (its start until then), how long the loop gives it,
  // and after how long a silence the screen says it is still being waited on.
  lastOutputAt?: number;
  timeoutMs?: number | null;
  quietMs?: number | null;
  // Refused for quota or rate limit: the retry starts at `until`.
  wait?: { until: number; attempt: number; attempts: number } | null;
  // A fix task can be one problem on several elements.
  elements?: number;
}

// The last 64 KB of a call's output are kept.
export const AGENT_OUTPUT_MAX = 64 * 1024;
// The output pane keeps the run's last 2000 lines.
export const PANE_MAX_LINES = 2000;

export interface Notice {
  level: 'warn' | 'error';
  message: string;
}

// CLI warnings that are not news on the dashboard (see apply()).
export const SIGN_IN_LINES = /^A browser window is open on |holds live credentials; keep it out of version control/;

// Every event type the app understands. Anything else gets an "unknown
// event" notice rather than being dropped in silence.
export const KNOWN_EVENTS = new Set([
  'run', 'raw', 'stopping', 'done', 'start', 'info', 'warn', 'error', 'page', 'coverage', 'summary', 'troubleshoot',
  'login-waiting', 'session-saved', 'round', 'step', 'task', 'ledger', 'await-deploy', 'agent-output', 'progress', 'precondition', 'agent-wait', 'agent-result', 'gate', 'gate-output', 'commit', 'changes', 'attempt', 'bisect',
  'resume', 'deployment', 'deploy-check', 'marker', 'fallback', 'retry', 'rerun', 'sign-in-again', 'sign-in-opening', 'sign-in-failed',
  'manual', 'manual-decision',
]);

// The current run, built from its event stream.
@Injectable({ providedIn: 'root' })
export class RunStore {
  private api = inject(Api);
  private abort: AbortController | null = null;

  readonly run = signal<RunEvent | null>(null);
  // A run of kind "manual" (a tester's PDF): its stages, plan and decisions.
  readonly manual = signal<ManualState>(emptyManual());
  readonly pages = signal<PageRow[]>([]);
  readonly progress = signal<Progress>({ done: 0, discovered: 0, limit: null, finished: false, result: null });
  readonly notices = signal<Notice[]>([]);
  readonly unknown = signal<string[]>([]);
  readonly raw = signal<string[]>([]);
  readonly summary = signal<RunEvent | null>(null);
  readonly troubleshoot = signal<any | null>(null);
  readonly loginWaiting = signal(false);
  readonly sessionSaved = signal<RunEvent | null>(null);
  readonly round = signal<number | null>(null);
  readonly step = signal<RunEvent | null>(null);
  readonly task = signal<{ n: number; m: number; state: string } | null>(null);
  // The open findings the round's fix tasks cover, from its fix step (more than the tasks when grouped).
  readonly fixFindings = signal<number | null>(null);
  readonly ledger = signal<RunEvent | null>(null);
  readonly awaitingDeploy = signal(false);
  // The wait for a deployment (its await-deploy event: branch, remote, host, counts, until, intervalMs),
  // and how the run ended about it (its deployment event: arrived, still-old, timeout, stopped-waiting).
  readonly deployWait = signal<RunEvent | null>(null);
  // The last check of the site's build while fixes wait for a deployment (its deploy-check event).
  readonly deployCheck = signal<RunEvent | null>(null);
  readonly deployment = signal<RunEvent | null>(null);
  // The loop could not start: a set-up error before its first round, with its remedy.
  readonly precondition = signal<RunEvent | null>(null);
  // The round whose crawl has begun in this run (a round started from the report has none).
  readonly crawlRound = signal<number | null>(null);
  // An assistant call given up (timed out, refused for quota, no answer), in the loop's plain words.
  readonly gaveUp = signal<string | null>(null);
  // The output pane: one log for the whole run (each call under a heading line, the loop's own steps
  // between them), and when it last grew.
  readonly paneLog = signal('');
  readonly paneAt = signal(0);
  // The gate in hand (the build and tests run on a fix), for the status line.
  // The run's fix attempts, as they end (one row each), and how long the last finished check took.
  readonly changes = signal<ChangeRow[]>([]);
  readonly lastGateMs = signal<number | null>(null);
  readonly gate = signal<{ round: number; n: number | null; m: number | null; check: string; part: string; startedAt: number; endedAt: number | null; ok: boolean | null } | null>(null);
  // The loop: the run's first round (it re-checks the site first), and how many fixes the round committed.
  readonly firstRound = signal<number | null>(null);
  readonly committed = signal(0);
  // The round that started from the report the person had just seen (no crawl), if any.
  readonly reportRound = signal<number | null>(null);
  readonly agentCall = signal<AgentCall | null>(null);
  // Pages in flight (progress events), by URL, with when each event arrived; and when the sign-in wait began.
  readonly inFlight = signal<Record<string, PhaseEvent & { receivedAt: number }>>({});
  readonly loginWaitingSince = signal<number | null>(null);
  // The host of the page the sign-in tab opened on (from login-waiting), for "Sign in on the tab…".
  readonly loginWaitingHost = signal<string | null>(null);
  // When the current run started (its run event).
  readonly startedAt = signal<number | null>(null);
  readonly done = signal<RunEvent | null>(null);
  readonly stopping = signal(false);
  readonly connected = signal(false);
  // How this run came to be when the tool started it by itself: a try again (retry), an interrupted
  // fix loop continued (resume), an interrupted crawl run again (rerun), a crawl signed in again.
  readonly origin = signal<RunEvent | null>(null);
  // The sign-in this round opens because the crawl could not get in (step sign-in), and whether the
  // sign-in tab was closed and opened again.
  readonly signInAgain = signal(false);
  readonly loginReopened = signal(false);
  // The server's word on the current run once it has ended: the try again it scheduled, if any.
  readonly retry = signal<RetryInfo | null>(null);
  // A PDF run's promised rerun (its done's rerun) that the server withdrew: it could not start, or Stop cancelled it.
  readonly rerunWithdrawn = signal(false);
  // The fallback assistant taking a fix (its fallback event): which fix, and by whom.
  readonly fallback = signal<{ round: number; n: number; assistant: string } | null>(null);
  private watching: ReturnType<typeof setTimeout> | null = null;

  readonly active = computed(() => !!this.run() && !this.done());
  // A try again is coming (not cancelled, not started yet): the step counts down, and Stop cancels it.
  readonly retryPending = computed(() => {
    const r = this.retry();
    return !!r && !r.cancelled && !r.firedAt && !!this.done();
  });
  readonly kind = computed(() => (this.run()?.['kind'] as string) || null);
  readonly totals = computed(() => cumulative(this.pages()));
  readonly remedies = computed(() => (this.done()?.['remedies'] as Remedy[]) || []);
  readonly cannotGetIn = computed(() => {
    const d = this.done();
    if (!d || !['crawl'].includes(this.kind() || '')) return false;
    const s = this.summary();
    if (s && s['summary'] && !s['summary'].audited) return true;
    return this.notices().some((n) => CANNOT_GET_IN.test(n.message)) || this.pages().some((p) => p.error && CANNOT_GET_IN.test(p.error));
  });

  // The crawl could not get in because the app sent it off to another origin, a sign-in portal.
  readonly bouncedToSignIn = computed(
    () => this.cannotGetIn() && (this.notices().some((n) => OFF_ORIGIN.test(n.message)) || this.pages().some((p) => OFF_ORIGIN.test(p.skipped || '') || OFF_ORIGIN.test(p.error || '')))
  );

  private reset(): void {
    this.pages.set([]);
    this.progress.set({ done: 0, discovered: 0, limit: null, finished: false, result: null });
    this.notices.set([]);
    this.unknown.set([]);
    this.raw.set([]);
    this.summary.set(null);
    this.troubleshoot.set(null);
    this.loginWaiting.set(false);
    this.sessionSaved.set(null);
    this.round.set(null);
    this.step.set(null);
    this.task.set(null);
    this.ledger.set(null);
    this.awaitingDeploy.set(false);
    this.deployWait.set(null);
    this.deployCheck.set(null);
    this.deployment.set(null);
    this.precondition.set(null);
    this.crawlRound.set(null);
    this.gaveUp.set(null);
    this.paneLog.set('');
    this.paneAt.set(0);
    this.gate.set(null);
    this.changes.set([]);
    this.lastGateMs.set(null);
    this.firstRound.set(null);
    this.committed.set(0);
    this.reportRound.set(null);
    this.agentCall.set(null);
    this.inFlight.set({});
    this.loginWaitingSince.set(null);
    this.loginWaitingHost.set(null);
    this.done.set(null);
    this.stopping.set(false);
    this.origin.set(null);
    this.signInAgain.set(false);
    this.loginReopened.set(false);
    this.retry.set(null);
    this.rerunWithdrawn.set(false);
    this.fallback.set(null);
    this.manual.set(emptyManual());
  }

  // Appends to the pane: text as it is, or a line of its own (started on a new line).
  private pane(text: string, line = false): void {
    if (!text) return;
    this.paneLog.update((log) => {
      let next = line ? `${log && !log.endsWith('\n') ? log + '\n' : log}${text}\n` : log + text;
      const lines = next.split('\n');
      if (lines.length > PANE_MAX_LINES + 1) next = lines.slice(-(PANE_MAX_LINES + 1)).join('\n');
      return next;
    });
    this.paneAt.set(Date.now());
  }

  apply(ev: RunEvent): void {
    switch (ev.type) {
      case 'run':
        this.reset();
        this.run.set(ev);
        this.startedAt.set(Date.parse(String(ev['at'])) || Date.now());
        break;
      case 'raw':
        this.raw.update((r) => [...r, `${ev['stream'] === 'stderr' ? '! ' : ''}${ev['line']}`]);
        break;
      case 'start':
        this.progress.update((p) => ({ ...p, limit: ev['maxPages'] ?? p.limit }));
        break;
      case 'info':
        break;
      case 'warn':
        // The sign-in's own lines: the wait is the status line (login-waiting), and the
        // session file is the dashboard's to look after. The raw output keeps both.
        if (SIGN_IN_LINES.test(ev['message'])) break;
        this.notices.update((n) => [...n, { level: 'warn', message: ev['message'] }]);
        break;
      case 'error':
        this.notices.update((n) => [...n, { level: ev.type as 'warn' | 'error', message: ev['message'] }]);
        break;
      case 'page': {
        const row: PageRow = {
          url: ev['url'], finalUrl: ev['finalUrl'], title: ev['title'], status: ev['status'], error: ev['error'], skipped: ev['skipped'],
          violations: ev['violations'], reviews: ev['reviews'], byImpact: ev['byImpact'], durationMs: ev['durationMs'], round: ev['round'] ?? null,
          modalOnLoad: ev['modalOnLoad'] ?? null,
          servedWith: ev['servedWith'] ?? null,
          findings: Array.isArray(ev['findings']) ? ev['findings'] : [],
          discovery: { links: ev['links'] ?? 0, clicked: ev['clicked'] ?? null, clickedNew: ev['clickedNew'] ?? null, skippedActions: ev['skippedActions'] ?? [], skippedActionsCount: ev['skippedActionsCount'] ?? 0, searched: ev['searched'] ?? null, searchResults: ev['searchResults'] ?? null },
        };
        this.pages.update((p) => [...p, row]);
        this.inFlight.update((m) => {
          const { [ev['url']]: _, ...rest } = m;
          return rest;
        });
        this.progress.update((p) => ({ ...p, done: ev['done'], discovered: ev['discovered'], limit: ev['limit'] ?? p.limit }));
        break;
      }
      case 'coverage':
        break;
      case 'summary':
        this.summary.set(ev);
        this.progress.update((p) => ({ ...p, finished: true, result: ev['result'] }));
        break;
      case 'troubleshoot':
        this.troubleshoot.set(ev['result']);
        break;
      case 'progress':
        this.inFlight.update((m) => ({ ...m, [ev['url']]: { url: ev['url'], phase: ev['phase'], detail: ev['detail'] ?? null, elapsedMs: ev['elapsedMs'] ?? 0, receivedAt: Date.now() } }));
        break;
      case 'login-waiting':
        if (!this.loginWaiting()) notify('Sign in needed', `Sign in in the tab that opened for ${String(ev['url'] || 'the app')}; the loop continues by itself once you have.`);
        if (ev['reopened']) this.loginReopened.set(true);
        this.loginWaiting.set(true);
        this.loginWaitingSince.set(Date.parse(String(ev['at'])) || Date.now());
        try {
          this.loginWaitingHost.set(new URL(String(ev['url'])).host || null);
        } catch {
          this.loginWaitingHost.set(null);
        }
        break;
      case 'session-saved':
        this.loginWaiting.set(false);
        this.sessionSaved.set(ev);
        break;
      case 'round':
        this.signInAgain.set(false);
        this.round.set(ev['round']);
        if (this.firstRound() === null) this.firstRound.set(ev['round']);
        this.committed.set(0);
        this.gaveUp.set(null);
        this.pages.set([]);
        this.summary.set(null);
        this.task.set(null);
        this.awaitingDeploy.set(false);
        this.progress.set({ done: 0, discovered: 0, limit: this.progress().limit, finished: false, result: null });
        break;
      case 'step': {
        if (ev['step'] === 'sign-in') {
          this.signInAgain.set(true);
          this.pane(`— Round ${ev['round']}: the sign-in expired; signing in again, then the crawl runs again —`, true);
          break;
        }
        this.step.set(ev);
        const at = Date.parse(String(ev['at'])) || Date.now();
        // A triage batch ends when the next step (or the next batch) starts.
        this.agentCall.update((c) => (c && c.kind === 'triage' && !c.endedAt && (ev['step'] !== 'triage' || ev['batch'] !== c.task) ? { ...c, endedAt: at, outcome: 'done' } : c));
        // A triage call starts now: the assistant prints nothing until it ends, so the pane and
        // its timer start with the call, not with its first output.
        const cur = this.agentCall();
        if (ev['step'] === 'triage' && typeof ev['batch'] === 'number' && !(cur && cur.kind === 'triage' && cur.round === ev['round'] && cur.task === ev['batch'])) {
          this.agentCall.set({ round: ev['round'], task: ev['batch'], kind: 'triage', n: ev['batch'], m: ev['batches'] ?? null, count: ev['count'] ?? null, label: `${ev['count']} review item${ev['count'] === 1 ? '' : 's'}`, startedAt: at, endedAt: null, outcome: null, text: '', lastOutputAt: Date.now(), timeoutMs: ev['timeoutMs'] ?? null, quietMs: ev['quietMs'] ?? null, wait: null });
        }
        if (ev['step'] === 'crawl') {
          this.crawlRound.set(ev['round']);
          this.pane(`— Round ${ev['round']}: re-checking the site —`, true);
        }
        if (ev['step'] === 'report') this.pane(`— Round ${ev['round']}: starting from the report you just saw —`, true);
        if (ev['step'] === 'ledger') this.pane(`— Round ${ev['round']}: fixing the remaining findings without waiting (no crawl) —`, true);
        if (ev['step'] === 'triage' && typeof ev['batch'] === 'number' && this.agentCall()?.startedAt === at && this.agentCall()?.kind === 'triage') {
          this.pane(`— Review items${(ev['batches'] ?? 1) > 1 ? `, batch ${ev['batch']} of ${ev['batches']}` : ''}: asking about ${ev['count']} review item${ev['count'] === 1 ? '' : 's'} —`, true);
        }
        if (ev['step'] === 'push') this.pane(`Pushing ${ev['committed']} fix${ev['committed'] === 1 ? '' : 'es'}`, true);
        if (ev['step'] === 'push') notify(`Round ${ev['round']}: ${ev['committed']} fix${ev['committed'] === 1 ? '' : 'es'} pushed`, 'Waiting for the deployment next; the loop goes on by itself.');
        if (ev['step'] === 'deploy' || ev['step'] === 'await-deploy') this.pane('Waiting for the new build to go live', true);
        if (typeof ev['committed'] === 'number') this.committed.set(ev['committed']);
        if (ev['step'] === 'report') this.reportRound.set(ev['round']);
        if (ev['step'] === 'fix') {
          this.task.set({ n: 0, m: ev['count'], state: 'start' });
          this.fixFindings.set(typeof ev['findings'] === 'number' ? ev['findings'] : null);
        }
        break;
      }
      case 'task': {
        this.task.set({ n: ev['n'], m: ev['m'], state: ev['state'] });
        const at = Date.parse(String(ev['at'])) || Date.now();
        if (ev['state'] === 'start') {
          const els = Number(ev['elements']) > 1 ? ` (${ev['elements']} elements)` : '';
          this.pane(`— Fix ${ev['n']} of ${ev['m']}${els}: ${ev['test']} ${String(ev['message'] || '')} —`, true);
          this.agentCall.set({ round: ev['round'], task: ev['n'], kind: 'fix', n: ev['n'], m: ev['m'], label: `${ev['test']} ${String(ev['message'] || '').slice(0, 80)}`, startedAt: at, endedAt: null, outcome: null, text: '', lastOutputAt: Date.now(), timeoutMs: ev['timeoutMs'] ?? null, quietMs: ev['quietMs'] ?? null, wait: null, elements: Number(ev['elements']) || 1 });
        } else {
          this.agentCall.update((c) => (c && c.kind === 'fix' && c.task === ev['n'] ? { ...c, endedAt: at, outcome: ev['outcome'] || null } : c));
        }
        break;
      }
      case 'agent-output': {
        this.pane(String(ev['text'] || ''));
        const at = Date.parse(String(ev['at'])) || Date.now();
        this.agentCall.update((c) => {
          const same = c && c.round === ev['round'] && c.task === ev['task'] && c.kind === ev['kind'];
          const call: AgentCall = same ? c! : { round: ev['round'], task: ev['task'], kind: ev['kind'], n: null, m: null, label: ev['kind'] === 'triage' ? `review batch ${ev['task']}` : `finding ${ev['task']}`, startedAt: at, endedAt: null, outcome: null, text: '' };
          return { ...call, text: (call.text + ev['text']).slice(-AGENT_OUTPUT_MAX), lastOutputAt: Date.now(), wait: null };
        });
        break;
      }
      case 'gate': {
        const each = typeof ev['n'] === 'number';
        const part = String(ev['part'] || 'check');
        const took = spoken(Number(ev['durationMs']) || 0);
        if (ev['state'] === 'start') {
          this.gate.set({ round: ev['round'], n: ev['n'] ?? null, m: ev['m'] ?? null, check: String(ev['check'] || ''), part, startedAt: Date.now(), endedAt: null, ok: null });
          this.pane(part === 'test' ? `Running the tests once for the round's fixes: ${ev['check']}` : `Checking ${each ? 'the fix' : "the round's fixes"} with ${ev['check']}`, true);
        } else {
          this.gate.update((g) => (g ? { ...g, endedAt: Date.now(), ok: !!ev['ok'] } : g));
          const what = part === 'build' ? 'Build' : part === 'test' ? 'Tests' : 'Build and tests';
          if (ev['ok']) this.pane(`${what} passed in ${took}`, true);
          else if (each || part === 'test') this.pane(`${part === 'build' ? 'Build' : part === 'test' ? 'Tests' : 'Build or tests'} failed after ${took}${ev['reason'] ? ` — ${ev['reason']}` : ''}`, true);
          else this.pane(`Build or tests failed — the round's fixes are rolled back (${ev['reason'] || `exit ${ev['code'] ?? '?'}`}):\n${String(ev['tail'] || '')}`, true);
        }
        break;
      }
      case 'bisect':
        if (ev['state'] === 'start') this.pane(`The tests failed; finding which of the round's ${ev['count']} fixes broke them`, true);
        else this.pane(`Fix ${ev['n']} (${ev['test']} ${ev['message']}) broke the tests — it is reverted`, true);
        break;
      case 'gate-output':
        this.pane(String(ev['text'] || ''));
        break;
      case 'commit':
        this.pane(`Committed as ${ev['commit']}`, true);
        break;
      case 'changes':
        this.pane(`Changed: ${(Array.isArray(ev['files']) ? ev['files'] : []).join(', ')}`, true);
        break;
      case 'attempt': {
        const row: ChangeRow = {
          round: ev['round'], n: ev['n'] ?? null, test: String(ev['test'] || ''), message: String(ev['message'] || ''), elements: ev['elements'] ?? null,
          files: Array.isArray(ev['files']) ? ev['files'] : [], outcome: String(ev['outcome'] || ''), commit: ev['commit'] ?? null,
          agentMs: ev['agentMs'] ?? null, gateMs: ev['gateMs'] ?? null, gateCode: ev['gateCode'] ?? null, gateTail: ev['gateTail'] ?? null,
        };
        // How long the last check took, as the ledger records it for the attempt.
        if (typeof row.gateMs === 'number') this.lastGateMs.set(row.gateMs);
        // A round's rollback updates the rows it reverted.
        this.changes.update((list) => {
          const i = list.findIndex((x) => x.round === row.round && x.n === row.n && x.n !== null);
          return i >= 0 ? list.map((x, k) => (k === i ? row : x)) : [...list, row];
        });
        if (row.outcome === 'failed-gate' && typeof ev['n'] === 'number' && this.gate()?.n !== null) this.pane(`Reverted — ${ev['reason'] || `the check failed (exit ${row.gateCode ?? '?'})`}:\n${row.gateTail || '(no output)'}`, true);
        break;
      }
      case 'agent-wait':
        this.agentCall.update((c) => (c && c.round === ev['round'] && c.task === ev['task'] && c.kind === ev['kind'] ? { ...c, wait: { until: Date.now() + Number(ev['delayMs'] || 0), attempt: ev['attempt'], attempts: ev['attempts'] }, lastOutputAt: Date.now() + Number(ev['delayMs'] || 0) } : c));
        break;
      case 'agent-result':
        this.agentCall.update((c) => (c && c.round === ev['round'] && c.task === ev['task'] && c.kind === ev['kind'] ? { ...c, wait: null } : c));
        if (!ev['ok'] && ev['message']) this.gaveUp.set(ev['message']);
        break;
      case 'ledger':
        this.ledger.set(ev);
        break;
      case 'await-deploy':
        this.awaitingDeploy.set(true);
        this.deployWait.set(ev);
        if (typeof ev['committed'] === 'number') this.committed.set(ev['committed']);
        break;
      case 'deploy-check':
        if (ev['result'] === 'changed') notify('Deployment arrived', `Verifying ${ev['pending']} fix${ev['pending'] === 1 ? '' : 'es'} against the new build.`);
        this.deployCheck.set(ev);
        this.pane(checkLine(ev), true);
        break;
      case 'fallback':
        this.fallback.set({ round: Number(ev['round']) || 0, n: Number(ev['n']) || 0, assistant: String(ev['assistant'] || '') });
        this.pane(`Fix ${ev['n']} of ${ev['m']}: ${String(ev['assistant'])} this time, after ${ev['after']} tries that made no fix that held`, true);
        break;
      case 'marker':
        this.pane(`Build marker ${String(ev['token'])} committed in ${String(ev['file'])}: the fixes are verified against a build that serves it`, true);
        break;
      case 'sign-in-opening':
        this.pane(`Opening the sign-in in ${ev['how'] === 'tab' ? 'a tab of this window' : 'a window'} (${String(ev['why'] || '')})`, true);
        break;
      case 'sign-in-failed':
        notify('The sign-in did not happen', String(ev['reason'] || ''));
        this.pane(`The sign-in did not happen: ${String(ev['reason'] || '')}`, true);
        this.notices.update((n) => [...n, { level: 'error', message: `The sign-in did not happen: ${String(ev['reason'] || '')}` }]);
        break;
      case 'precondition':
        notify('The fix loop could not start', `${String(ev['message'] || '')} ${String(ev['remedy'] || '')}`.trim());
        this.precondition.set(ev);
        break;
      case 'deployment':
        this.deployment.set(ev);
        if (ev['state'] === 'arrived') this.pane(`Your deployment arrived: verifying ${ev['pending']} fix${ev['pending'] === 1 ? '' : 'es'}`, true);
        // No build from before the fixes on record (no-baseline): nothing to say; the round verifies.
        if (ev['state'] === 'verify-anyway' && ev['reason'] !== 'no-baseline') this.pane(ev['reason'] === 'unreachable' ? 'Could not read the start page to check its build; going by your word that the site is updated' : 'Verifying anyway: fixes not yet deployed count as not holding', true);
        break;
      // Continue after an interruption: the unfinished fix's changes it discarded, in the pane.
      case 'manual':
      case 'manual-decision':
        this.manual.update((m) => applyManual(m, ev));
        break;
      case 'resume':
        this.origin.set(ev);
        for (const f of (ev['discarded'] as string[]) || []) this.pane(`Discarded the unfinished change to ${f}`, true);
        this.pane(ev['n'] && ev['m'] ? `Continuing the fix loop interrupted at fix ${ev['n']} of ${ev['m']}, with no new crawl` : 'Continuing the interrupted fix loop, with no new crawl', true);
        break;
      case 'retry':
        this.origin.set(ev);
        this.pane(`Trying again (attempt ${ev['attempt']})${ev['reason'] ? `: ${ev['reason']}` : ''}`, true);
        break;
      case 'rerun':
      case 'sign-in-again':
        this.origin.set(ev);
        break;
      case 'stopping':
        this.stopping.set(true);
        break;
      case 'done':
        notify(doneTitle(ev), doneBody(ev));
        this.done.set(ev);
        this.loginWaiting.set(false);
        this.inFlight.set({});
        this.awaitingDeploy.set(false);
        this.agentCall.update((c) => (c && !c.endedAt ? { ...c, endedAt: Date.parse(String(ev['at'])) || Date.now(), outcome: ev['outcome'] === 'stopped' ? 'stopped' : 'ended' } : c));
        this.progress.update((p) => ({ ...p, finished: true }));
        // The CLI's own reason, when it gave one (a browser that went away).
        if (ev['outcome'] === 'error') this.notices.update((n) => [...n, { level: 'error', message: ev['reason'] ? `The run failed: ${ev['reason']} (exit code ${ev['code']}).` : `The run failed (exit code ${ev['code']}).` }]);
        break;
      default:
        if (!KNOWN_EVENTS.has(ev.type)) this.unknown.update((u) => [...u, ev.type]);
    }
  }

  // Follows the current run's event stream from its first event; once it has ended, watches for the
  // run the tool starts next by itself (a try again, a continuation, a crawl signed in again).
  async connect(): Promise<void> {
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      const res = await this.api.stream('/api/runs/current/events', ctrl.signal);
      if (!res.ok) return;
      this.connected.set(true);
      await readSse(res, (d) => {
        try {
          this.apply(JSON.parse(d));
        } catch {}
      });
    } catch {
      // aborted or the server went away
    } finally {
      if (this.abort === ctrl) {
        this.connected.set(false);
        if (this.done()) this.watch();
      }
    }
  }

  // After a run's end: GET /api/runs/current every second, for its try again (the countdown) and for
  // the next run the server starts (followed at once). For 15 s after the end, and for as long as a try
  // again or a continuation is coming.
  watch(until = Date.now() + 15_000): void {
    if (this.watching) clearTimeout(this.watching);
    let asked = 0;
    const tick = async () => {
      this.watching = null;
      const id = this.run()?.['id'];
      let cur: RunInfo | null = null;
      try {
        cur = await this.api.get<RunInfo | null>('/api/runs/current');
      } catch {}
      if (id !== this.run()?.['id'] || this.active()) return;
      if (cur && cur.id !== id) return void this.connect();
      if (cur && cur.id === id) this.retry.set(cur.retry || null);
      // An interruption the server has not taken up yet: asking for the environment is what makes it go on.
      if (cur && cur.status === 'interrupted' && ++asked % 3 === 1) void this.api.get('/api/env').catch(() => {});
      if (cur && cur.id === id && this.done()?.['rerun'] && !(cur as RunInfo & { rerun?: unknown }).rerun) this.rerunWithdrawn.set(true);
      const coming = (cur && cur.status === 'interrupted') || (!!this.done()?.['rerun'] && !this.rerunWithdrawn()) || this.retryPending() || (!!this.retry()?.firedAt && !this.retry()?.cancelled);
      if (coming || Date.now() < until) this.watching = setTimeout(tick, 1000);
    };
    this.watching = setTimeout(tick, 0);
  }

  // After a switch of directory: the finished run belonged to the old one.
  forget(): void {
    this.abort?.abort();
    this.abort = null;
    this.connected.set(false);
    this.reset();
    this.run.set(null);
  }

  // The run is this page's from the moment the server accepts it: until its own events arrive the
  // store holds it as started (active, of its kind), so no screen offers to start another meanwhile.
  async start(body: unknown): Promise<void> {
    const r = await this.api.post<{ id?: string; kind?: string; status?: string } | null>('/api/runs', body);
    await this.adoptStarted(r);
  }

  // A run the server has just started (POST /api/runs, or a PDF's upload): this page's from now on.
  async adoptStarted(r: { id?: string; kind?: string; status?: string } | null): Promise<void> {
    if (r && r.id && r.status === 'running' && this.run()?.['id'] !== r.id) {
      this.reset();
      this.run.set({ type: 'run', seq: -1, id: r.id, kind: r.kind });
      this.startedAt.set(Date.now());
    }
    void this.connect();
  }

  async install(agent: string): Promise<void> {
    await this.api.post('/api/agent/install', { agent });
    void this.connect();
  }

  // Stop: the run, or, between tries, the try again that was coming.
  async stop(): Promise<void> {
    const r = await this.api.post<{ cancelled?: boolean } | null>('/api/runs/current/stop');
    if (r && r.cancelled) {
      const cur = this.retry();
      if (cur) this.retry.set({ ...cur, cancelled: true });
      if (this.done()?.['rerun']) this.rerunWithdrawn.set(true);
      this.watch(Date.now() + 2000);
    }
  }
}

// One check of the site's build while fixes wait for a deployment, in words: when, and what it saw.
export function checkLine(ev: Record<string, unknown>): string {
  const at = new Date(String(ev['at'] || ''));
  const when = Number.isNaN(at.getTime()) ? 'just now' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const how = ev['via'] === 'browser' ? ' (read through the browser with your sign-in)' : '';
  const r = ev['result'];
  const expected = ev['expected'] ? String(ev['expected']) : '';
  const served = ev['marker'] ? String(ev['marker']) : '';
  if (r === 'changed') return expected && served === expected ? `Checked at ${when}: the build with this round's marker ${expected} is live${how}. Verifying the fixes.` : `Checked at ${when}: a new build is live${how}. Verifying the fixes.`;
  if (r === 'unreadable') return `Checked at ${when}: the start page could not be read (${String(ev['reason'] || 'the site may be down, or behind a sign-in')}).`;
  if (r === 'no-baseline') return `Checked at ${when}: no build from before the fixes is on record, so this one is verified${how}.`;
  if (expected) return `Checked at ${when}: still a build without this round's marker ${expected}${served ? ` (it serves ${served})` : ''}${how}.`;
  return `Checked at ${when}: still the build from before the fixes${how}.`;
}

// A desktop notification, only when this tab is not in front (someone watching the page needs none)
// and only once the person has allowed them (asked when the loop is started).
export function notify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
    const n = new Notification(`a11y-508: ${title}`, { body, tag: `a11y-508-${title}` });
    n.onclick = () => {
      try {
        window.focus();
        n.close();
      } catch {}
    };
  } catch {}
}
export function askToNotify(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
  } catch {}
}
function doneTitle(ev: Record<string, unknown>): string {
  const o = ev['outcome'];
  if (o === 'ok') return 'Fix loop finished: nothing left to fix';
  if (o === 'findings') return 'Fix loop finished';
  if (o === 'stopped') return 'Fix loop stopped';
  if (o === 'awaiting-deploy') return 'Fix loop waiting for your deployment';
  if (o === 'interrupted') return 'Fix loop interrupted';
  return 'Fix loop ended with an error';
}
function doneBody(ev: Record<string, unknown>): string {
  const o = ev['outcome'];
  if (o === 'error') return String(ev['reason'] || `exit code ${ev['code']}`);
  if (o === 'findings') return 'Nothing more the assistant could fix this time.';
  return '';
}
