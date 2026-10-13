import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { BarChartModule } from '@swimlane/ngx-charts';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { skippedText, discoveryOf, foundText, resultLine, shortUrl } from '../core/format';
import { prefersReducedMotion } from '../core/motion';
import { Finding, IMPACTS, Report } from '../core/types';
import { ChartPanel } from '../shared/chart-panel';

interface Row extends Finding {
  key: number;
  page: string;
}

@Component({
  selector: 'app-report-screen',
  imports: [BarChartModule, ChartPanel, RouterLink],
  template: `
    <h1>{{ heading() }}</h1>
    @if (loading()) {
      <p role="status">Loading the report…</p>
    } @else if (!report()) {
      <p>No report yet. <a routerLink="/run">Run a crawl</a>, or open one from <a routerLink="/history">History</a>.</p>
    } @else {
      @let r = report()!;
      <p class="hint">{{ r.baseUrl }} · finished {{ r.finishedAt }}</p>
      <p class="result" [class.pass]="r.passed && complete()" [class.fail]="!r.passed" [class.incomplete]="r.passed && !complete()" data-testid="result-line">{{ line() }}</p>
      @if (r.summary.coverage?.warnings?.length) {
        <div class="notice warn" role="status" data-testid="coverage-warnings">
          <h2>Coverage warnings</h2>
          <ul>@for (w of r.summary.coverage!.warnings; track $index) { <li>{{ w }}</li> }</ul>
        </div>
      }
      <h2>Totals</h2>
      <dl class="tiles" data-testid="totals">
        @for (i of impacts; track i) {
          <div class="tile" [attr.data-impact]="i"><dt>{{ i }}</dt><dd>{{ r.summary.byImpact[i] }}</dd></div>
        }
        <div class="tile" data-impact="review"><dt>for review</dt><dd>{{ r.summary.reviews }}</dd></div>
      </dl>
      <p><a [href]="htmlLink()" target="_blank" rel="noopener">Open report.html (opens in a new tab)</a></p>

      <h2>Charts</h2>
      <app-chart-panel id="by-impact" heading="Violations by impact" [columns]="impactCols" [rows]="impactRows()">
        <ngx-charts-bar-vertical [view]="[520, 260]" [results]="impactData()" [xAxis]="true" [yAxis]="true" [showXAxisLabel]="true" xAxisLabel="Impact" [showYAxisLabel]="true" yAxisLabel="Violations" [animations]="animations" [tooltipDisabled]="true" />
      </app-chart-panel>
      <app-chart-panel id="by-test" heading="Violations by Trusted Tester test" [columns]="testCols" [rows]="testRows()">
        <ngx-charts-bar-horizontal [view]="[640, testHeight()]" [results]="testData()" [xAxis]="true" [yAxis]="true" [animations]="animations" [tooltipDisabled]="true" />
      </app-chart-panel>
      <app-chart-panel id="worst-pages" heading="The 15 pages with the most violations" [columns]="pageCols" [rows]="worstRows()">
        <ngx-charts-bar-horizontal [view]="[640, 360]" [results]="worstData()" [xAxis]="true" [yAxis]="true" [animations]="animations" [tooltipDisabled]="true" />
      </app-chart-panel>

      @if (beyondHeading(); as bh) {
        <h2 id="beyond-h" data-testid="beyond-heading">{{ bh }}</h2>
        <p class="hint">Rules from WCAG 2.1 and 2.2 and best practices, run because the profile was on (<code>--wcag {{ r.options.wcag }}</code>). Section 508 itself requires WCAG 2.0 AA.</p>
        @if (beyondRows().length) {
          <table data-testid="beyond-tests">
            <caption>Findings beyond Section 508, by rule</caption>
            <thead><tr><th scope="col">Rule</th><th scope="col">Name</th><th scope="col">WCAG</th><th scope="col">Violations</th><th scope="col">Review</th></tr></thead>
            <tbody>@for (b of beyondRows(); track b.test) { <tr><th scope="row">{{ b.test }}</th><td>{{ b.name }}</td><td>{{ b.wcag }}</td><td>{{ b.violations }}</td><td>{{ b.reviews }}</td></tr> }</tbody>
          </table>
        } @else {
          <p>No findings beyond Section 508.</p>
        }
      }

      <h2 id="findings-h">Findings</h2>
      <form class="filters" aria-labelledby="findings-h" (submit)="$event.preventDefault()">
        <div class="field">
          <label for="f-level">Level</label>
          <select id="f-level" (change)="level.set(val($event))"><option value="">All</option><option value="violation">Violations</option><option value="review">Review items</option></select>
        </div>
        <div class="field">
          <label for="f-impact">Impact</label>
          <select id="f-impact" (change)="impact.set(val($event))"><option value="">All</option>@for (i of impacts; track i) { <option [value]="i">{{ i }}</option> }</select>
        </div>
        <div class="field">
          <label for="f-test">Test</label>
          <select id="f-test" (change)="test.set(val($event))">
            <option value="">All</option>
            @if (beyondHeading(); as bh) {
              <optgroup label="Trusted Tester">@for (t of ttTests(); track t) { <option [value]="t">{{ t }}</option> }</optgroup>
              <optgroup [label]="bh" data-testid="beyond-tests-filter">@for (t of beyondTests(); track t) { <option [value]="t">{{ t }}</option> }</optgroup>
            } @else {
              @for (t of tests(); track t) { <option [value]="t">{{ t }}</option> }
            }
          </select>
        </div>
        <div class="field">
          <label for="f-page">Page</label>
          <select id="f-page" (change)="page.set(val($event))"><option value="">All</option>@for (p of pageNames(); track p) { <option [value]="p">{{ short(p) }}</option> }</select>
        </div>
        <div class="field">
          <label for="f-text">Text</label>
          <input id="f-text" type="search" (input)="text.set(val($event))" />
        </div>
        <div class="field">
          <label for="f-group">Group by</label>
          <select id="f-group" (change)="group.set(val($event))"><option value="">Nothing</option><option value="test">Test</option><option value="page">Page</option></select>
        </div>
      </form>
      <p role="status" data-testid="finding-count">{{ filtered().length }} of {{ rows().length }} findings shown</p>
      @for (g of groups(); track g.name) {
        @if (g.name) { <h3>{{ g.name }}</h3> }
        <table class="findings" data-testid="findings">
          <thead><tr><th scope="col">Level</th><th scope="col">Impact</th><th scope="col">Test</th><th scope="col">Page</th><th scope="col">Message</th><th scope="col"><span class="visually-hidden">Details</span></th></tr></thead>
          <tbody>
            @for (f of g.rows.slice(0, 300); track f.key) {
              <tr data-testid="finding-row">
                <td>{{ f.level }}</td><td>{{ f.impact }}</td><td>{{ f.test }}</td><td>{{ short(f.page) }}</td><td>{{ f.message }}</td>
                <td><button type="button" class="secondary small" (click)="selected.set(f)" [attr.aria-label]="'Details for finding: ' + f.message">Details</button></td>
              </tr>
            }
          </tbody>
        </table>
      }
      @if (selected(); as f) {
        <section class="detail" aria-labelledby="detail-h" data-testid="detail">
          <h2 id="detail-h" tabindex="-1">Finding detail</h2>
          <p>{{ f.message }}</p>
          <dl>
            <dt>Test</dt><dd>{{ f.test }} {{ f.name }}</dd>
            <dt>Test condition</dt><dd>{{ condition(f.test) }}</dd>
            <dt>WCAG</dt><dd data-testid="detail-wcag">{{ f.wcag }}</dd>
            <dt>Page</dt><dd>{{ f.page }}</dd>
            @if (f.frame) {
              <dt>Frame</dt><dd><code data-testid="detail-frame">{{ f.frame }}</code></dd>
            }
            <dt>Selector</dt>
            <dd>
              <code data-testid="detail-selector">{{ f.selector || '(page level)' }}</code>
              @if (f.selector && f.selector.includes(' >>> ')) {
                <br /><small data-testid="detail-selector-hint">Each " &gt;&gt;&gt; " steps into the shadow root of a web component or the document of a frame; the path after it is inside that component or frame.</small>
              }
            </dd>
            <dt>HTML</dt><dd><code data-testid="detail-html">{{ f.html }}</code></dd>
          </dl>
          @if (f.screenshot) {
            <img data-testid="detail-screenshot" [src]="shot(f.screenshot)" [alt]="'Screenshot of the element ' + (f.selector || '')" />
          } @else {
            <p>No screenshot for this finding.</p>
          }
          <button type="button" class="secondary" (click)="selected.set(null)">Close detail</button>
        </section>
      }

      <h2>Manual checklist</h2>
      <table>
        <caption>Trusted Tester conditions a person must test</caption>
        <thead><tr><th scope="col">Test</th><th scope="col">Name</th><th scope="col">WCAG</th><th scope="col">Automation</th><th scope="col">Condition</th></tr></thead>
        <tbody>@for (m of r.manual; track m.test) { <tr><th scope="row">{{ m.test }}</th><td>{{ m.name }}</td><td>{{ m.wcag }}</td><td>{{ m.automation }}</td><td>{{ m.condition }}</td></tr> }</tbody>
      </table>
      <h2>Pages</h2>
      <table data-testid="report-pages">
        <caption>Crawled pages</caption>
        <thead><tr><th scope="col">Page</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Violations</th><th scope="col">Review</th><th scope="col">Found</th></tr></thead>
        <tbody>
          @for (p of r.pages; track $index) {
            <tr [attr.data-url]="p.finalUrl || p.url"><th scope="row">{{ short(p.finalUrl || p.url) }}</th><td>{{ p.title }}</td><td>{{ p.error || p.skipped || p.status }}</td><td>{{ count(p.findings, 'violation') }}</td><td>{{ count(p.findings, 'review') }}</td>
              <td data-testid="found">
                @let d = discovery(p);
                {{ found(d) }}
                @if (d.skippedActionsCount) {
                  <span class="modal-note" data-testid="skipped-actions">Not clicked, look like actions: {{ quoted(d) }}</span>
                }
              </td></tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class ReportScreen {
  readonly found = foundText;
  readonly discovery = discoveryOf;
  readonly quoted = skippedText;

  private api = inject(Api);
  private run = inject(RunStore);
  private env = inject(EnvStore);
  readonly id = input<string>();
  readonly report = signal<Report | null>(null);
  readonly loading = signal(true);
  readonly animations = !prefersReducedMotion();
  readonly impacts = IMPACTS;
  readonly short = shortUrl;
  readonly level = signal('');
  readonly impact = signal('');
  readonly test = signal('');
  readonly page = signal('');
  readonly text = signal('');
  readonly group = signal('');
  readonly selected = signal<Row | null>(null);

  readonly reportId = computed(() => this.id() || 'latest');
  readonly heading = computed(() => {
    const id = this.reportId();
    if (id === 'latest') return 'Latest report';
    if (id.startsWith('round-')) return `Report: loop round ${id.slice(6)}`;
    return `Report from ${this.report()?.finishedAt || 'history'}`;
  });
  readonly complete = computed(() => !this.report()?.summary.coverage || this.report()!.summary.coverage!.complete);
  readonly line = computed(() => (this.report() ? resultLine(this.report()!) : ''));
  readonly htmlLink = computed(() => `/api/reports/${encodeURIComponent(this.reportId())}/report.html`);

  readonly impactCols = [{ key: 'impact', label: 'Impact' }, { key: 'violations', label: 'Violations' }];
  readonly impactRows = computed(() => IMPACTS.map((i) => ({ impact: i, violations: this.report()?.summary.byImpact[i] ?? 0 })));
  readonly impactData = computed(() => this.impactRows().map((r) => ({ name: r.impact, value: r.violations })));

  readonly testCols = [{ key: 'test', label: 'Test' }, { key: 'violations', label: 'Violations' }];
  readonly testRows = computed(() => {
    const bt = this.report()?.summary.byTest || {};
    return Object.entries(bt).filter(([, c]) => c.violations > 0).map(([test, c]) => ({ test, violations: c.violations }));
  });
  readonly testData = computed(() => this.testRows().map((r) => ({ name: r.test, value: r.violations })));
  readonly testHeight = computed(() => Math.max(160, this.testRows().length * 22 + 60));

  readonly pageCols = [{ key: 'page', label: 'Page' }, { key: 'violations', label: 'Violations' }];
  readonly worstRows = computed(() =>
    (this.report()?.pages || [])
      .map((p) => ({ page: shortUrl(p.finalUrl || p.url), violations: (p.findings || []).filter((f) => f.level === 'violation').length }))
      .filter((p) => p.violations > 0)
      .sort((a, b) => b.violations - a.violations)
      .slice(0, 15)
  );
  readonly worstData = computed(() => this.worstRows().map((r) => ({ name: r.page, value: r.violations })));

  readonly rows = computed<Row[]>(() => {
    const r = this.report();
    if (!r) return [];
    let key = 0;
    const out: Row[] = [];
    for (const p of r.pages) for (const f of p.findings || []) out.push({ ...f, key: key++, page: p.finalUrl || p.url });
    for (const f of r.site?.findings || []) out.push({ ...f, key: key++, page: (f.pages || []).join(', ') || 'site-wide' });
    return out;
  });
  readonly tests = computed(() => [...new Set(this.rows().map((f) => f.test))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  // With the beyond-508 profile (--wcag 2.1 / 2.2), its rules are listed under a heading of their own.
  readonly beyondHeading = computed(() => {
    const w = this.report()?.options?.wcag;
    return w && w !== '2.0' ? `Beyond Section 508 (WCAG ${w})` : '';
  });
  private isBeyond = (t: string) => !!this.report()?.catalog?.[t]?.beyond508;
  readonly ttTests = computed(() => this.tests().filter((t) => !this.isBeyond(t)));
  readonly beyondTests = computed(() => this.tests().filter((t) => this.isBeyond(t)));
  readonly beyondRows = computed(() => {
    const r = this.report();
    if (!r) return [];
    return Object.entries(r.summary.byTest)
      .filter(([t, c]) => this.isBeyond(t) && (c.violations || c.reviews))
      .map(([test, c]) => ({ test, name: r.catalog[test].name, wcag: r.catalog[test].wcag, violations: c.violations, reviews: c.reviews }));
  });
  readonly pageNames = computed(() => [...new Set(this.rows().map((f) => f.page))]);
  readonly filtered = computed(() => {
    const q = this.text().toLowerCase().trim();
    return this.rows().filter(
      (f) =>
        (!this.level() || f.level === this.level()) &&
        (!this.impact() || f.impact === this.impact()) &&
        (!this.test() || f.test === this.test()) &&
        (!this.page() || f.page === this.page()) &&
        (!q || `${f.message} ${f.selector || ''} ${f.html || ''}`.toLowerCase().includes(q))
    );
  });
  readonly groups = computed(() => {
    const g = this.group();
    if (!g) return [{ name: '', rows: this.filtered() }];
    const map = new Map<string, Row[]>();
    for (const f of this.filtered()) {
      const k = g === 'test' ? f.test : shortUrl(f.page);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(f);
    }
    return [...map.entries()].map(([name, rows]) => ({ name, rows }));
  });

  private title = inject(Title);

  constructor() {
    // Each report has a title of its own.
    effect(() => this.title.setTitle(`${this.heading()} - a11y-508`));
    // The report, again whenever the working directory changes.
    effect(() => {
      const id = this.reportId();
      this.env.cwd();
      untracked(() => void this.load(id, true));
    });
    // When a run finishes while this screen is open, show its report, in place.
    effect(() => {
      const done = this.run.done();
      const runId = done ? (this.run.run()?.['id'] as string) : null;
      untracked(() => {
        if (!runId || runId === this.seenRun) return;
        const first = this.seenRun === undefined;
        this.seenRun = runId;
        if (!first) void this.load(this.reportId(), false);
      });
    });
  }

  private seenRun: string | undefined;

  private loads = 0;
  private async load(id: string, blank: boolean): Promise<void> {
    const n = ++this.loads;
    if (blank) this.loading.set(true);
    this.selected.set(null);
    let r: Report | null = null;
    try {
      r = await this.api.get<Report>(`/api/reports/${encodeURIComponent(id)}`);
    } catch {
      r = null;
    }
    // Only the latest request decides what is shown.
    if (n !== this.loads) return;
    this.report.set(r);
    this.loading.set(false);
  }

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
  condition(test: string): string {
    return this.report()?.catalog?.[test]?.condition || '';
  }
  shot(path: string): string {
    return `/api/reports/${encodeURIComponent(this.reportId())}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  count(findings: Finding[], level: string): number {
    return (findings || []).filter((f) => f.level === level).length;
  }
}
