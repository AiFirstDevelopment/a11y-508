import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { readSse } from './sse';
import { CANNOT_GET_IN, Progress, cumulative } from './format';
import { ByImpact, Remedy, RunEvent } from './types';

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
}

export interface Notice {
  level: 'warn' | 'error';
  message: string;
}

// Every event type the app understands. Anything else gets an "unknown
// event" notice rather than being dropped in silence.
export const KNOWN_EVENTS = new Set([
  'run', 'raw', 'stopping', 'done', 'start', 'info', 'warn', 'error', 'page', 'coverage', 'summary', 'troubleshoot',
  'login-waiting', 'session-saved', 'round', 'step', 'task', 'ledger', 'await-deploy',
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
    this.done.set(null);
    this.stopping.set(false);
  }

  apply(ev: RunEvent): void {
    switch (ev.type) {
      case 'run':
        this.reset();
        this.run.set(ev);
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
      case 'error':
        this.notices.update((n) => [...n, { level: ev.type as 'warn' | 'error', message: ev['message'] }]);
        break;
      case 'page': {
        const row: PageRow = {
          url: ev['url'], finalUrl: ev['finalUrl'], title: ev['title'], status: ev['status'], error: ev['error'], skipped: ev['skipped'],
          violations: ev['violations'], reviews: ev['reviews'], byImpact: ev['byImpact'], durationMs: ev['durationMs'], round: ev['round'] ?? null,
        };
        this.pages.update((p) => [...p, row]);
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
      case 'login-waiting':
        this.loginWaiting.set(true);
        break;
      case 'session-saved':
        this.loginWaiting.set(false);
        this.sessionSaved.set(ev);
        break;
      case 'round':
        this.round.set(ev['round']);
        this.pages.set([]);
        this.summary.set(null);
        this.task.set(null);
        this.awaitingDeploy.set(false);
        this.progress.set({ done: 0, discovered: 0, limit: this.progress().limit, finished: false, result: null });
        break;
      case 'step':
        this.step.set(ev);
        if (ev['step'] === 'fix') this.task.set({ n: 0, m: ev['count'], state: 'start' });
        break;
      case 'task':
        this.task.set({ n: ev['n'], m: ev['m'], state: ev['state'] });
        break;
      case 'ledger':
        this.ledger.set(ev);
        break;
      case 'await-deploy':
        this.awaitingDeploy.set(true);
        break;
      case 'stopping':
        this.stopping.set(true);
        break;
      case 'done':
        this.done.set(ev);
        this.awaitingDeploy.set(false);
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

  async start(body: unknown): Promise<void> {
    await this.api.post('/api/runs', body);
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
