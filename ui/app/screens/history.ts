import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BarChartModule } from '@swimlane/ngx-charts';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { fixedLine, resultWord, localTime, shortUrl } from '../core/format';
import { prefersReducedMotion } from '../core/motion';
import { ReportListEntry } from '../core/types';
import { ChartPanel } from '../shared/chart-panel';
import { NeedsPersonLink } from '../shared/needs-person-link';
import { ChangeRow, ChangesTable } from '../shared/changes-table';
import { Starter } from '../core/starter';
import { detailsOpen, setDetailsOpen } from '../core/details';

interface LoopRound { round: number; at: string | null; found: number; fixed: number; commits: number; remaining: number; needsHuman: number; changes?: Omit<ChangeRow, 'round'>[] }
interface LoopTimeline { rounds: LoopRound[]; total: { rounds: number; fixed: number; pending?: number; of: number; remaining: number; needsHuman: number; decided?: number } }

// One timeline: the crawls and the fix loop's rounds, newest first.
@Component({
  selector: 'app-history-screen',
  imports: [RouterLink, ChartPanel, BarChartModule, NeedsPersonLink, ChangesTable],
  template: `
    <h1>History</h1>
    <p>Every crawl and every round of the fix loop, newest first. The latest crawl stays in a11y-508-report/; earlier ones move to a11y-508-history/; the loop's rounds are in a11y-508-work/.</p>
    @if (error()) {
      <div class="notice error" role="alert">{{ error() }}</div>
    }
    <p role="status" class="hint" data-testid="history-status">{{ status() }}</p>
    @if (timeline(); as t) {
      <p data-testid="loop-summary">Fix loop: {{ t.total.rounds }} round{{ t.total.rounds === 1 ? '' : 's' }} · {{ t.total.of }} violations · {{ counts(t.total) }}@if (t.total.decided) { · {{ t.total.decided }} decided by a person}</p>
      <app-needs-person-link [count]="t.total.needsHuman" />
    }
    @if (earlier().length || timeline()) {
      <div class="actions">
        @if (earlier().length) {
          <button type="button" class="secondary" (click)="clear()" data-testid="clear-history">Clear history</button>
        }
        @if (timeline()) {
          <button type="button" class="secondary" (click)="clearLoop()" [disabled]="loopRunning()" data-testid="clear-loop-history">Clear fix-loop history</button>
        }
      </div>
    }
    @if (list().length) {
      <table data-testid="history">
        <caption>Crawls and fix-loop rounds</caption>
        <thead><tr><th scope="col">Event</th><th scope="col">Finished</th><th scope="col">Pages audited</th><th scope="col">Violations found</th><th scope="col">Review</th><th scope="col">Fixed</th><th scope="col">Remaining</th><th scope="col">Commits</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          @for (r of list(); track r.id) {
            @let lr = loopRound(r);
            <tr [attr.data-id]="r.id" [attr.data-source]="r.source">
              <th scope="row"><a [routerLink]="r.id === 'latest' ? ['/report'] : ['/report', r.id]">{{ name(r) }}</a>
                @if (r.source !== 'round') { <span class="hint"> {{ word(r.result) }}</span> }</th>
              <td><time [attr.datetime]="r.finishedAt" [attr.title]="r.finishedAt" data-testid="finished">{{ local(r.finishedAt) }}</time></td>
              <td>{{ r.summary.audited }}</td>
              <td data-testid="found">{{ lr ? lr.found : r.summary.violations }}</td>
              <td>{{ r.summary.reviews }}</td>
              <td data-testid="fixed">{{ lr ? lr.fixed : '—' }}</td>
              <td data-testid="remaining">
                @if (lr) {
                  <span>{{ lr.remaining }}</span>
                  @if (lr.needsHuman) { <span> ({{ lr.needsHuman }} need a person)</span> }
                } @else {
                  —
                }
              </td>
              <td data-testid="commits">{{ lr ? lr.commits : '—' }}</td>
              <td>
                @if (r.source === 'history') {
                  <button type="button" class="secondary small" (click)="remove(r)" [attr.aria-label]="'Delete ' + name(r) + ', finished ' + local(r.finishedAt)">Delete</button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <p>No reports yet. <a routerLink="/run">Run a crawl</a>.</p>
    }
    @if (timeline(); as t) {
      @for (lr of t.rounds; track lr.round) {
        @if (lr.changes?.length) {
          <details class="round-changes" [attr.data-round]="lr.round" data-testid="round-changes">
            <summary>Fix round {{ lr.round }}: changes ({{ lr.changes!.length }})</summary>
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
  readonly word = resultWord;
  readonly local = localTime;
  readonly animations = !prefersReducedMotion();
  private loads = 0;
  readonly error = signal('');
  readonly status = signal('');
  // The reports in a11y-508-history/, which Clear history and Delete remove.
  readonly earlier = computed(() => this.list().filter((r) => r.source === 'history'));
  // The start URL for Run again: the latest crawl's, else the loop config's.
  private configUrl = signal('');
  readonly againUrl = computed(() => this.list().find((r) => r.source === 'latest')?.baseUrl || this.configUrl());
  readonly loopRunning = computed(() => this.run.active() && ['loop', 'dry-run'].includes(this.run.kind() || ''));
  rowsOf(lr: LoopRound): ChangeRow[] {
    return (lr.changes || []).map((c) => ({ ...c, round: lr.round }));
  }
  // The loop's totals in the Fix step's words.
  counts(t: LoopTimeline['total']): string {
    return fixedLine({ verified: t.fixed, pending: t.pending || 0, open: t.remaining, 'needs-human': t.needsHuman });
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
  }

  private async load(): Promise<void> {
    const n = ++this.loads;
    let l: ReportListEntry[] = [];
    let t: LoopTimeline | null = null;
    try {
      [l, t] = await Promise.all([this.api.get<ReportListEntry[]>('/api/reports'), this.api.get<LoopTimeline | null>('/api/loop/timeline')]);
    } catch {}
    if (n !== this.loads) return;
    this.list.set(l);
    this.api.get<{ config: Record<string, any> }>('/api/config').then((c) => this.configUrl.set(String(c?.config?.['url'] || ''))).catch(() => {});
    this.timeline.set(t);
  }

  loopRound(r: ReportListEntry): LoopRound | null {
    return r.source === 'round' ? this.timeline()?.rounds.find((x) => x.round === r.round) || null : null;
  }

  async clear(): Promise<void> {
    const n = this.earlier().length;
    if (!confirm(`Remove ${n} earlier report${n === 1 ? '' : 's'} from a11y-508-history? The latest report and the loop's rounds stay. This cannot be undone.`)) return;
    await this.del('/api/reports/history', (r) => `Removed ${r.removed} earlier report${r.removed === 1 ? '' : 's'}.`);
  }

  async clearLoop(): Promise<void> {
    const n = this.timeline()?.total.rounds || 0;
    if (!confirm(`Remove the fix loop's ${n} round${n === 1 ? '' : 's'} and its ledger from a11y-508-work? The next loop starts from round 1. This cannot be undone.`)) return;
    await this.del('/api/loop/history', (r) => `Removed ${r.removed} fix-loop round${r.removed === 1 ? '' : 's'} and the ledger.`);
  }

  async remove(e: ReportListEntry): Promise<void> {
    if (!confirm(`Delete the report of ${e.baseUrl} that finished ${localTime(e.finishedAt)}? This cannot be undone.`)) return;
    await this.del(`/api/reports/${encodeURIComponent(e.id)}`, () => 'Report deleted.');
  }

  private async del(path: string, said: (r: { removed: number }) => string): Promise<void> {
    this.error.set('');
    try {
      const r = await this.api.delete<{ removed: number }>(path);
      this.status.set(said(r));
    } catch (e: any) {
      this.error.set(e.message);
    }
    await this.load();
  }

  name(r: ReportListEntry): string {
    if (r.source === 'round') return `Fix round ${r.round}`;
    const route = r.baseUrl ? shortUrl(r.baseUrl) : '';
    return `${r.source === 'latest' ? 'Crawl' : 'Earlier crawl'} of ${route} (${r.baseUrl})`;
  }
}
