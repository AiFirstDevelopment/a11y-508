import { Component, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AreaChartModule } from '@swimlane/ngx-charts';
import { RunStore } from '../core/run.store';
import { skippedText, foundText, phaseText, progressLabel, routeParts, shortUrl, SOFT_404_TITLE } from '../core/format';
import { prefersReducedMotion } from '../core/motion';
import { IMPACTS } from '../core/types';
import { ChartPanel } from './chart-panel';

// The live part of any run: notices, the progress bars, the stacked chart of
// violations as pages finish, the page list, and the raw output on request.
@Component({
  selector: 'app-run-view',
  imports: [AreaChartModule, ChartPanel, RouterLink],
  template: `
    @let s = store;
    @if (s.notices().length || s.unknown().length) {
      <div class="notices">
        @if (errors().length) {
          <div class="notice error" role="alert" data-notice="error">
            <h3>Errors</h3>
            <ul>@for (n of errors(); track $index) { <li>{{ n.message }}</li> }</ul>
          </div>
        }
        @if (warnings().length) {
          <div class="notice warn" role="status" data-notice="warn">
            <h3>Warnings</h3>
            <ul>@for (n of warnings(); track $index) { <li>{{ n.message }}</li> }</ul>
          </div>
        }
        @if (s.unknown().length) {
          <div class="notice warn" role="status" data-notice="unknown">
            <h3>Unknown events</h3>
            <p>The command line tool sent events this dashboard does not know: {{ unknownList() }}. The dashboard may be older than the tool.</p>
          </div>
        }
      </div>
    }
    <div class="progress-block">
      <label for="crawl-progress" id="crawl-progress-label">{{ label() }}</label>
      @if (phaseLine(); as pl) {
        <p class="hint phase" data-testid="phase-line" aria-live="off">{{ pl }}</p>
      }
      @if (indeterminate()) {
        <progress id="crawl-progress" aria-labelledby="crawl-progress-label"></progress>
      } @else {
        <progress id="crawl-progress" aria-labelledby="crawl-progress-label" [value]="s.progress().done" [max]="s.progress().discovered || 1"></progress>
      }
    </div>
    @if (s.task(); as t) {
      @if (t.m) {
        <div class="progress-block">
          <label for="fix-progress" id="fix-progress-label">fix {{ t.n }} of {{ t.m }}</label>
          <progress id="fix-progress" aria-labelledby="fix-progress-label" [value]="t.n" [max]="t.m"></progress>
        </div>
      }
    }
    @if (showChart() && s.pages().length) {
      <app-chart-panel id="live-chart" heading="Violations so far, by impact" [columns]="liveColumns" [rows]="liveRows()">
        <ngx-charts-area-chart-stacked [view]="[640, 240]" [results]="liveSeries()" [xAxis]="true" [yAxis]="true" [legend]="true"
          legendTitle="Impact" [showXAxisLabel]="true" xAxisLabel="Pages finished" [showYAxisLabel]="true" yAxisLabel="Violations"
          [animations]="animations" [tooltipDisabled]="true" />
      </app-chart-panel>
    }
    <h3 id="pages-h">Pages</h3>
    <table class="pages" aria-labelledby="pages-h" data-testid="page-list">
      <thead>
        <tr><th scope="col">Page</th><th scope="col">Status</th><th scope="col">Violations</th><th scope="col">Review</th><th scope="col">Found</th><th scope="col">Time</th></tr>
      </thead>
      <tbody>
        @for (p of s.pages(); track $index) {
          <tr [attr.data-url]="p.finalUrl">
            <th scope="row">
              @let rp = route(p.finalUrl);
              @if (linkable()) {
                <a class="route-link" routerLink="/report" [queryParams]="{ route: p.finalUrl }" [attr.title]="p.finalUrl"><strong>{{ rp.path }}</strong>@if (rp.query) {<span class="query">?…</span>}</a>
              } @else {
                <span [attr.title]="p.finalUrl"><strong>{{ rp.path }}</strong>@if (rp.query) {<span class="query">?…</span>}</span>
              }
              @if (p.modalOnLoad; as m) {
                <span class="modal-note" data-testid="modal-note">{{ modalNote(m) }}</span>
              }
            </th>
            <td>
              @if (p.error) { {{ p.error }} } @else if (p.skipped) { skipped: {{ p.skipped }} } @else if (p.servedWith) {
                <span data-testid="soft-404" [attr.title]="soft404">{{ p.servedWith }} · app rendered</span>
              } @else { {{ p.status }} }
            </td>
            <td class="num">{{ p.violations }}</td>
            <td class="num">{{ p.reviews }}</td>
            <td data-testid="found">
              {{ found(p.discovery) }}
              @if (p.discovery.skippedActionsCount) {
                <span class="modal-note" data-testid="skipped-actions">Not clicked, look like actions: {{ quoted(p.discovery) }}</span>
              }
            </td>
            <td class="num">{{ (p.durationMs / 1000).toFixed(1) }}s</td>
          </tr>
        } @empty {
          @if (!flight().length) {
            <tr><td colspan="6">No page has finished yet.</td></tr>
          }
        }
        @for (f of flight(); track f.url) {
          <tr data-in-progress="true" [attr.data-in-flight-url]="f.url">
            <th scope="row"><span [attr.title]="f.url"><strong>{{ route(f.url).path }}</strong>@if (route(f.url).query) {<span class="query">?…</span>}</span></th>
            <td data-testid="phase">{{ phase(f) }}</td>
            <td></td><td></td><td></td>
            <td class="num">{{ secs(f) }}</td>
          </tr>
        }
      </tbody>
    </table>
    <details class="raw" (toggle)="rawOpen.set($any($event.target).open)">
      <summary>Show raw output</summary>
      @if (rawOpen()) {
        <pre data-testid="raw-output" tabindex="0" role="region" aria-label="Raw output">{{ s.raw().join('\\n') }}</pre>
      }
    </details>
  `,
})
export class RunView implements OnDestroy {
  readonly found = foundText;
  readonly quoted = skippedText;

  readonly store = inject(RunStore);
  readonly showChart = input(true);
  readonly rawOpen = signal(false);
  readonly animations = !prefersReducedMotion();
  readonly short = shortUrl;
  readonly modalNote = (m: { selector: string; name: string; dismissed: boolean }) =>
    m.dismissed
      ? `A modal dialog (${m.name || m.selector}) was open on load; it closed with Escape and the page behind it was audited.`
      : `A modal dialog (${m.name || m.selector}) was open on load and did not close with Escape; the page behind it was not audited.`;
  readonly errors = computed(() => this.store.notices().filter((n) => n.level === 'error'));
  readonly warnings = computed(() => this.store.notices().filter((n) => n.level === 'warn'));
  readonly unknownList = computed(() => [...new Set(this.store.unknown())].join(', '));
  readonly indeterminate = computed(() => !this.store.progress().done && !this.store.progress().finished);
  readonly label = computed(() => progressLabel(this.store.progress()));
  readonly soft404 = SOFT_404_TITLE;
  readonly route = routeParts;
  // Rows link to the page's findings on the Report screen once the run's report is written.
  readonly links = input(true);
  readonly linkable = computed(() => this.links() && !this.store.active() && !!this.store.summary());
  readonly now = signal(Date.now());
  private ticker = setInterval(() => this.now.set(Date.now()), 1000);
  readonly flight = computed(() => Object.values(this.store.inFlight()));
  readonly secs = (f: { elapsedMs: number; receivedAt: number }) => `${Math.round((f.elapsedMs + Math.max(0, this.now() - f.receivedAt)) / 1000)} s`;
  readonly phase = (f: Parameters<typeof phaseText>[0]) => phaseText(f);
  // The second line under the bar: the sign-in wait, or what the newest page in flight is doing.
  readonly phaseLine = computed(() => {
    const s = this.store;
    if (s.done()) return '';
    const since = s.loginWaitingSince();
    if (s.loginWaiting() && since) return `Waiting for you to sign in in the browser window · ${Math.max(0, Math.round((this.now() - since) / 1000))} s`;
    const f = this.flight().sort((a, b) => b.receivedAt - a.receivedAt)[0];
    return f ? `${phaseText(f)} · ${this.secs(f)}` : '';
  });

  ngOnDestroy(): void {
    clearInterval(this.ticker);
  }
  readonly liveColumns = [{ key: 'page', label: 'Pages finished' }, ...IMPACTS.map((i) => ({ key: i, label: i }))];
  readonly liveRows = computed(() => this.store.totals().map((t, i) => ({ page: i + 1, ...t })));
  readonly liveSeries = computed(() =>
    IMPACTS.map((i) => ({ name: i, series: this.store.totals().map((t, k) => ({ name: k + 1, value: t[i] })) }))
  );
}
