import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { readSse } from './sse';
import { CANNOT_GET_IN, Discovery, OFF_ORIGIN, PhaseEvent, Progress, cumulative, spoken } from './format';
import { ByImpact, Remedy, RunEvent } from './types';
import type { ChangeRow } from '../shared/changes-table';

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
  'resume',
]);

// The current run, built from its event stream.
@Injectable({ providedIn: 'root' })
export class RunStore {
  private api = inject(Api);
  private abort: AbortController | null = null;

  readonly run = signal<RunEvent | null>(null);
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
  readonly ledger = signal<RunEvent | null>(null);
  readonly awaitingDeploy = signal(false);
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
  // When the current run started (its run event).
  readonly startedAt = signal<number | null>(null);
  readonly done = signal<RunEvent | null>(null);
  readonly stopping = signal(false);
  readonly connected = signal(false);
  private continued = 0;

  readonly active = computed(() => !!this.run() && !this.done());
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
    this.done.set(null);
    this.stopping.set(false);
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
        this.loginWaiting.set(true);
        this.loginWaitingSince.set(Date.parse(String(ev['at'])) || Date.now());
        break;
      case 'session-saved':
        this.loginWaiting.set(false);
        this.sessionSaved.set(ev);
        break;
      case 'round':
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
        if (ev['step'] === 'triage' && typeof ev['batch'] === 'number' && this.agentCall()?.startedAt === at && this.agentCall()?.kind === 'triage') {
          this.pane(`— Review items${(ev['batches'] ?? 1) > 1 ? `, batch ${ev['batch']} of ${ev['batches']}` : ''}: asking about ${ev['count']} review item${ev['count'] === 1 ? '' : 's'} —`, true);
        }
        if (ev['step'] === 'push') this.pane(`Pushing ${ev['committed']} fix${ev['committed'] === 1 ? '' : 'es'}`, true);
        if (ev['step'] === 'deploy' || ev['step'] === 'await-deploy') this.pane('Waiting for the new build to go live', true);
        if (typeof ev['committed'] === 'number') this.committed.set(ev['committed']);
        if (ev['step'] === 'report') this.reportRound.set(ev['round']);
        if (ev['step'] === 'fix') this.task.set({ n: 0, m: ev['count'], state: 'start' });
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
          if (ev['outcome'] === 'no-change') this.pane('No change was made; the finding stays open', true);
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
        if (typeof ev['committed'] === 'number') this.committed.set(ev['committed']);
        break;
      case 'precondition':
        this.precondition.set(ev);
        break;
      // Continue after an interruption: the unfinished fix's changes it discarded, in the pane.
      case 'resume':
        for (const f of (ev['discarded'] as string[]) || []) this.pane(`Discarded the unfinished change to ${f}`, true);
        this.pane(ev['n'] && ev['m'] ? `Continuing the fix loop interrupted at fix ${ev['n']} of ${ev['m']}, with no new crawl` : 'Continuing the interrupted fix loop, with no new crawl', true);
        break;
      case 'stopping':
        this.stopping.set(true);
        break;
      case 'done':
        this.done.set(ev);
        this.inFlight.set({});
        this.awaitingDeploy.set(false);
        this.agentCall.update((c) => (c && !c.endedAt ? { ...c, endedAt: Date.parse(String(ev['at'])) || Date.now(), outcome: ev['outcome'] === 'stopped' ? 'stopped' : 'ended' } : c));
        this.progress.update((p) => ({ ...p, finished: true }));
        if (ev['outcome'] === 'error') this.notices.update((n) => [...n, { level: 'error', message: `The run failed (exit code ${ev['code']}).` }]);
        break;
      default:
        if (!KNOWN_EVENTS.has(ev.type)) this.unknown.update((u) => [...u, ev.type]);
    }
  }

  // Follows the current run's event stream from its first event.
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
      if (this.abort === ctrl) this.connected.set(false);
    }
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

  async stop(): Promise<void> {
    await this.api.post('/api/runs/current/stop');
  }

  async continueAfterDeploy(): Promise<void> {
    this.awaitingDeploy.set(false);
    this.continued++;
    await this.api.post('/api/runs/current/continue');
  }
}
