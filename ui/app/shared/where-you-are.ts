import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { CrawledRoutes, LoopTimeline } from '../core/types';
import { WhereLive, notHoldingLine, tallyLine, whereYouAre } from '../core/where';

// "Where you are": what has happened for this URL and what comes next, at the top of the Fix step
// and of History. Always visible; it follows the live run and reads the ledger again as it changes.
@Component({
  selector: 'app-where-you-are',
  imports: [RouterLink],
  template: `
    <section class="where" aria-labelledby="where-h" data-testid="where-you-are">
      <h2 id="where-h">Where you are</h2>
      <!-- The whole run so far in a few numbers, and the one thing to change when fixes keep not holding. -->
      @if (tally(); as t) { <p class="tally" data-testid="tally">{{ t }}@if (routesCount(); as n) { · <a routerLink="/history" fragment="routes" data-testid="tally-routes">{{ n }} route{{ n === 1 ? '' : 's' }} crawled</a> }</p> }
      @if (notHolding(); as n) { <p class="notice warn" role="status" data-testid="not-holding">{{ n }}</p> }
      <ul class="plain where-list">
        @for (l of lines(); track $index) {
          <li [attr.data-kind]="l.kind" [attr.data-testid]="'where-' + l.kind">
            <span class="where-mark" aria-hidden="true">{{ l.kind === 'done' ? '✓' : l.kind === 'now' ? '●' : '○' }}</span>
            <span class="visually-hidden">{{ l.kind === 'done' ? 'Done: ' : '' }}</span>
            <span [attr.data-testid]="'where-' + l.kind + '-text'">{{ l.text }}</span>
            @if (l.link; as k) { <a class="where-link" [routerLink]="k.path" [fragment]="k.fragment">{{ k.label }}<span class="visually-hidden"> for: {{ l.text }}</span></a> }
          </li>
        }
      </ul>
    </section>
  `,
})
export class WhereYouAre implements OnDestroy {
  private api = inject(Api);
  private env = inject(EnvStore);
  private store = inject(RunStore);
  readonly timeline = signal<LoopTimeline | null>(null);
  readonly now = signal(Date.now());
  readonly routesCount = signal(0);
  readonly tally = computed(() => {
    const t = this.timeline()?.total?.tally;
    return t ? tallyLine(t, this.now(), this.store.active()) : '';
  });
  readonly notHolding = computed(() => {
    const t = this.timeline()?.total?.tally;
    return t ? notHoldingLine(t) : null;
  });
  private ticker = setInterval(() => this.now.set(Date.now()), 1000);
  private loads = 0;

  constructor() {
    // The ledger as it changes (the loop's ledger events, the run's end), and after a switch of folder.
    effect(() => {
      this.store.ledger();
      this.store.done();
      this.store.round();
      this.env.cwd();
      untracked(() => void this.load());
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.ticker);
  }

  async load(): Promise<void> {
    const n = ++this.loads;
    try {
      const t = await this.api.get<LoopTimeline | null>('/api/loop/timeline');
      this.api.get<CrawledRoutes>('/api/loop/routes').then((r) => this.routesCount.set(r?.routes?.length || 0)).catch(() => {});
      if (n === this.loads) this.timeline.set(t);
    } catch {}
  }

  private readonly live = computed<WhereLive | null>(() => {
    const s = this.store;
    if (!s.run()) return null;
    const step = (s.step()?.['step'] as string) || null;
    const p = s.progress();
    const crawling = s.crawlRound() !== null && s.crawlRound() === s.round() && (step === 'crawl' || step === null);
    const w = s.deployWait();
    const t = s.task();
    const dep = s.deployment();
    const done = s.done();
    return {
      kind: s.kind(), active: s.active(), outcome: done ? String(done['outcome'] || '') || null : null,
      round: s.round(), step, crawled: crawling || (s.kind() !== 'loop' && s.kind() !== 'dry-run') ? { done: p.done, discovered: p.discovered } : null,
      task: t && t.m ? { n: t.n, m: t.m } : null,
      waiting: s.awaitingDeploy() && w && w['intervalMs'] ? { branch: String(w['branch'] || ''), intervalMs: Number(w['intervalMs']) || 30_000, until: w['until'] ? Date.parse(String(w['until'])) || Date.now() : null, meanwhile: w['meanwhile'] ? Number(w['open']) || 0 : 0 } : null,
      // An arrival is this round's news only: the crawl right after it verifies the fixes.
      deployment: dep && (dep['state'] !== 'arrived' || Number(dep['round']) + 1 === s.round()) ? String(dep['state']) : null, verifying: dep && typeof dep['pending'] === 'number' ? dep['pending'] : null,
      loginWaiting: s.loginWaiting(),
      retrying: s.retryPending() ? { kind: s.retry()!.kind, attempt: s.retry()!.attempt } : null,
      reason: done && done['reason'] ? String(done['reason']) : s.notices().filter((n) => n.level === 'error' && !/^The run failed( \(exit code|: )/.test(n.message)).map((n) => n.message).pop() || s.notices().filter((n) => n.level === 'error').map((n) => n.message).pop() || null,
    };
  });

  readonly lines = computed(() => whereYouAre({
    report: this.env.env()?.report?.exists ? this.env.env()!.report : null,
    timeline: this.timeline(),
    counts: (this.store.ledger()?.['counts'] as Record<string, number>) || this.countsOf(this.timeline()),
    live: this.live(),
    now: this.now(),
  }));

  // The counts when no ledger event has arrived: the timeline's totals.
  private countsOf(t: LoopTimeline | null): Record<string, number> | null {
    if (!t) return null;
    return { verified: t.total.fixed, pending: t.total.pending || 0, open: t.total.remaining };
  }
}
