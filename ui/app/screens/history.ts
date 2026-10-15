import { Component, Injector, afterNextRender, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { BarChartModule } from '@swimlane/ngx-charts';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { fixedLine, resultWord, localTime, shortUrl } from '../core/format';
import { prefersReducedMotion } from '../core/motion';
import { CrawledRoutes, ReportListEntry } from '../core/types';
import { foundText, skippedText } from '../core/format';
import { ChartPanel } from '../shared/chart-panel';
import { WhereYouAre } from '../shared/where-you-are';
import { ChangeRow, ChangesTable } from '../shared/changes-table';
import { Starter } from '../core/starter';
import { detailsOpen, setDetailsOpen } from '../core/details';

interface LoopRound { round: number; at: string | null; found: number; fixed: number; commits: number; remaining: number; label?: string | null; state?: string; changes?: Omit<ChangeRow, 'round'>[] }
interface LoopTimeline { rounds: LoopRound[]; total: { rounds: number; fixed: number; pending?: number; of: number; remaining: number } }

// One timeline: the crawls and the fix loop's rounds, newest first.
@Component({
  selector: 'app-history-screen',
  imports: [RouterLink, ChartPanel, BarChartModule, WhereYouAre, ChangesTable],
  template: `
    <h1>History</h1>
    <app-where-you-are />
    <p>Every crawl and every round of the fix loop, newest first. They are kept outside the app's repository, in the tool's own folder for it (~/.a11y-508/repos/…: report/, history/, work/; <code>a11y-508 status</code> prints where).</p>
    @if (error()) {
      <div class="notice error" role="alert">{{ error() }}</div>
    }
    <p role="status" class="hint" data-testid="history-status">{{ status() }}</p>
    @if (timeline(); as t) {
      <p data-testid="loop-summary">Fix loop: {{ t.total.rounds }} round{{ t.total.rounds === 1 ? '' : 's' }} · {{ t.total.of }} violations · {{ counts(t.total) }}</p>
    }
    @if (list().length) {
      <table data-testid="history">
        <caption>Crawls and fix-loop rounds</caption>
        <thead><tr><th scope="col">Event</th><th scope="col">Finished</th><th scope="col">Pages audited</th><th scope="col">Violations found</th><th scope="col">Review</th><th scope="col">Fixed</th><th scope="col">Remaining</th><th scope="col">Commits</th></tr></thead>
        <tbody>
          @for (r of list(); track r.id) {
            @let lr = loopRound(r);
            <tr [attr.data-id]="r.id" [attr.data-source]="r.source">
              <th scope="row"><a [routerLink]="r.id === 'latest' ? ['/report'] : ['/report', r.id]">{{ name(r) }}</a>
                @if (r.source !== 'round') { <span class="hint"> {{ word(r.result) }}</span> }
                @if (lr?.label) { <span class="hint" data-testid="round-state"> {{ lr!.label }}</span> }</th>
              <td><time [attr.datetime]="r.finishedAt" [attr.title]="r.finishedAt" data-testid="finished">{{ local(r.finishedAt) }}</time></td>
              <td data-testid="audited">
                <a [routerLink]="r.id === 'latest' ? ['/report'] : ['/report', r.id]" fragment="pages" data-testid="audited-link" [attr.aria-label]="auditedLabel(r)">{{ auditedText(r) }}</a>
                @if (!r.summary.coverageComplete) { <span class="hint" data-testid="coverage-flag"> coverage incomplete</span> }
              </td>
              <td data-testid="found">{{ lr ? lr.found : r.summary.violations }}</td>
              <td>{{ r.summary.reviews }}</td>
              <td data-testid="fixed">{{ lr ? lr.fixed : '—' }}</td>
              <td data-testid="remaining">
                @if (lr) {
                  <span>{{ lr.remaining }}</span>
                } @else {
                  —
                }
              </td>
              <td data-testid="commits">{{ lr ? lr.commits : '—' }}</td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <p>No reports yet. <a routerLink="/run">Run a crawl</a>.</p>
    }
    @if (routes(); as rt) {
      <!-- Every route audited across the rounds, and why the crawl did not reach more: the one place to look. -->
      <details class="details" id="routes" data-testid="routes-crawled" [open]="routesOpen()" (toggle)="routesOpen.set($any($event.target).open)">
        <summary data-testid="routes-summary">Routes crawled: {{ rt.routes.length }}@if (rt.rounds) { across {{ rt.rounds }} round{{ rt.rounds === 1 ? '' : 's' }} }</summary>
        <h2 id="routes-h" tabindex="-1">Routes crawled</h2>
        @if (rt.coverage.warnings.length) {
          <div class="notice warn" role="status" data-testid="routes-coverage">
            <p>Why the last crawl did not reach more pages:</p>
            <ul>@for (w of rt.coverage.warnings; track $index) { <li>{{ w }}</li> }</ul>
          </div>
        } @else if (rt.routes.length) {
          <p class="hint" data-testid="routes-coverage">The last crawl reached every page it could find.</p>
        }
        <table data-testid="routes-table">
          <caption>Every route audited, with what the crawler found on it</caption>
          <thead><tr><th scope="col">Route</th><th scope="col">Title</th><th scope="col">Rounds</th><th scope="col">Last result</th><th scope="col">Violations</th><th scope="col">Review</th><th scope="col">Found on it</th></tr></thead>
          <tbody>
            @for (r of rt.routes; track r.url) {
              <tr [attr.data-url]="r.url">
                <th scope="row"><a [routerLink]="['/report']" [queryParams]="{ route: r.url }" [attr.title]="r.url">{{ r.path }}</a>@if (r.foundBy && r.foundBy !== 'link') { <span class="hint"> (found by {{ r.foundBy }})</span> }</th>
                <td>{{ r.title || '—' }}</td>
                <td>{{ r.rounds.length ? r.rounds.join(', ') : '—' }}</td>
                <td>{{ r.status || '—' }}</td>
                <td>{{ r.violations }}</td>
                <td>{{ r.reviews }}</td>
                <td>@if (r.found) { {{ found(r.found) }}@if (r.found.skippedActionsCount) { <span class="modal-note"> Not clicked, look like actions: {{ skipped(r.found) }}</span> } } @else { — }</td>
              </tr>
            }
          </tbody>
        </table>
        @if (rt.coverage.notes.length) {
          <details><summary>Coverage notes ({{ rt.coverage.notes.length }})</summary><ul>@for (n of rt.coverage.notes; track $index) { <li>{{ n }}</li> }</ul></details>
        }
      </details>
    }
    @if (timeline(); as t) {
      @for (lr of t.rounds; track lr.round) {
        @if (lr.changes?.length) {
          <details class="round-changes" [attr.data-round]="lr.round" data-testid="round-changes">
            <summary data-testid="round-summary">Fix round {{ lr.round }}: fixed {{ lr.fixed }} · remaining {{ lr.remaining }}@if (lr.label) { · {{ lr.label }}}</summary>
            <app-changes-table [rows]="rowsOf(lr)" [label]="'Changes in fix round ' + lr.round" />
          </details>
        }
      }
    }
    @if (timeline()) {
      <details class="details" data-testid="details" [open]="showDetails()" (toggle)="toggled($event)">
        <summary>Details<span class="visually-hidden"> of the history</span></summary>
        <app-chart-panel id="remaining" heading="Violations remaining after each round" [columns]="remainingCols" [rows]="remainingRows()">
          <ngx-charts-bar-vertical [view]="[480, 180]" [results]="remainingData()" [xAxis]="true" [yAxis]="true" [showXAxisLabel]="true" xAxisLabel="Round" [showYAxisLabel]="true" yAxisLabel="Remaining" [animations]="animations" [tooltipDisabled]="true" />
        </app-chart-panel>
      </details>
    }
    @if (list().length || againUrl()) {
      <div class="actions next">
        <button type="button" class="big" (click)="runAgain()" [disabled]="run.active()" data-testid="run-again">Run again</button>
      </div>
    }
  `,
})
export class HistoryScreen {
  private api = inject(Api);
  private env = inject(EnvStore);
  readonly run = inject(RunStore);
  private starter = inject(Starter);
  readonly showDetails = signal(detailsOpen('history'));
  toggled(e: Event): void {
    const open = (e.target as HTMLDetailsElement).open;
    this.showDetails.set(open);
    setDetailsOpen('history', open);
  }
  // Run again: the next crawl from the same set up (a fresh sign-in window), then Results and Fix.
  async runAgain(): Promise<void> {
    this.error.set('');
    try {
      await this.starter.startCrawl(this.againUrl());
    } catch (e: any) {
      this.error.set(e.message);
    }
  }
  readonly list = signal<ReportListEntry[]>([]);
  readonly timeline = signal<LoopTimeline | null>(null);
  readonly routes = signal<CrawledRoutes | null>(null);
  readonly routesOpen = signal(false);
  readonly found = foundText;
  readonly skipped = skippedText;
  private injector = inject(Injector);
  // /history#routes (the tally's link): the Routes crawled section open, its heading focused.
  readonly fragment = toSignal(inject(ActivatedRoute).fragment, { initialValue: null as string | null });
  readonly word = resultWord;
  readonly local = localTime;
  readonly animations = !prefersReducedMotion();
  private loads = 0;
  readonly error = signal('');
  readonly status = signal('');
  // The start URL for Run again: the latest crawl's, else the loop config's.
  private configUrl = signal('');
  readonly againUrl = computed(() => this.list().find((r) => r.source === 'latest')?.baseUrl || this.configUrl());
  rowsOf(lr: LoopRound): ChangeRow[] {
    return (lr.changes || []).map((c) => ({ ...c, round: lr.round }));
  }
  // The loop's totals in the Fix step's words.
  counts(t: LoopTimeline['total']): string {
    return fixedLine({ verified: t.fixed, pending: t.pending || 0, open: t.remaining });
  }
  readonly remainingCols = [{ key: 'round', label: 'Round' }, { key: 'remaining', label: 'Remaining' }];
  readonly remainingRows = computed(() => (this.timeline()?.rounds || []).map((r) => ({ round: r.round, remaining: r.remaining })));
  readonly remainingData = computed(() => this.remainingRows().map((r) => ({ name: String(r.round), value: r.remaining })));

  constructor() {
    // The list, again whenever the working directory changes.
    effect(() => {
      this.env.cwd();
      untracked(() => void this.load());
    });
    effect(() => {
      const wanted = this.fragment() === 'routes' && !!this.routes();
      if (!wanted) return;
      untracked(() => {
        this.routesOpen.set(true);
        afterNextRender(() => {
          const h = document.getElementById('routes-h');
          if (!h) return;
          h.scrollIntoView({ block: 'start' });
          h.focus({ preventScroll: true });
        }, { injector: this.injector });
      });
    });
  }

  private async load(): Promise<void> {
    const n = ++this.loads;
    let l: ReportListEntry[] = [];
    let t: LoopTimeline | null = null;
    let rt: CrawledRoutes | null = null;
    try {
      [l, t, rt] = await Promise.all([this.api.get<ReportListEntry[]>('/api/reports'), this.api.get<LoopTimeline | null>('/api/loop/timeline'), this.api.get<CrawledRoutes>('/api/loop/routes').catch(() => null)]);
    } catch {}
    if (n !== this.loads) return;
    this.list.set(l);
    this.routes.set(rt && rt.routes.length ? rt : null);
    this.api.get<{ config: Record<string, any> }>('/api/config').then((c) => this.configUrl.set(String(c?.config?.['url'] || ''))).catch(() => {});
    this.timeline.set(t);
  }

  loopRound(r: ReportListEntry): LoopRound | null {
    return r.source === 'round' ? this.timeline()?.rounds.find((x) => x.round === r.round) || null : null;
  }

  // The pages audited, as "2" or "2 of 9" when some pages were crawled but not audited (an error, or
  // the same page as one already audited); the link opens that report on its Pages list.
  auditedText(r: ReportListEntry): string {
    const { pages, audited } = r.summary;
    return pages > audited ? `${audited} of ${pages}` : String(audited);
  }
  auditedLabel(r: ReportListEntry): string {
    const { pages, audited } = r.summary;
    const which = pages > audited ? `${audited} of ${pages} pages` : `${audited} page${audited === 1 ? '' : 's'}`;
    return `See which ${which} ${audited === 1 && pages <= audited ? 'was' : 'were'} audited in ${this.name(r)}`;
  }
  name(r: ReportListEntry): string {
    if (r.source === 'round') return `Fix round ${r.round}`;
    const route = r.baseUrl ? shortUrl(r.baseUrl) : '';
    return `${r.source === 'latest' ? 'Crawl' : 'Earlier crawl'} of ${route} (${r.baseUrl})`;
  }
}
