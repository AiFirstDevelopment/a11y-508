import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import { detailsOpen, setDetailsOpen } from '../core/details';
import { BarChartModule } from '@swimlane/ngx-charts';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { SOFT_404_TITLE, localTime, skippedText, discoveryOf, foundText, resultLine, shortUrl } from '../core/format';
import { prefersReducedMotion } from '../core/motion';
import { Finding, IMPACTS, Report } from '../core/types';
import { ChartPanel } from '../shared/chart-panel';

interface Row extends Finding {
  key: number;
  page: string;
  // The route this finding is listed under: the page's URL, or 'site-wide'.
  route: string;
}

// One entry of the route list: an audited page (or the site-wide findings).
interface Route {
  key: string;
  path: string;
  query: string;
  url: string;
  byImpact: Record<string, number>;
  violations: number;
  reviews: number;
}

const SEVERITY: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
// Violations before review items, the most serious first.
const byWeight = (a: Finding, b: Finding) => (a.level === b.level ? 0 : a.level === 'violation' ? -1 : 1) || (SEVERITY[a.impact] ?? 9) - (SEVERITY[b.impact] ?? 9);

@Component({
  selector: 'app-report-screen',
  imports: [BarChartModule, ChartPanel, RouterLink],
  template: `
    @if (reportId() !== 'latest') {
      <p class="back"><a routerLink="/history" data-testid="back-to-history">Back to History</a></p>
    }
    <h1>{{ heading() }}</h1>
    @if (loading()) {
      <p role="status">Loading the report…</p>
    } @else if (!report()) {
      <p>No report yet. <a routerLink="/run">Run a crawl</a>, or open one from <a routerLink="/history">History</a>.</p>
    } @else {
      @let r = report()!;
      <p class="hint">{{ r.baseUrl }} · finished <time [attr.datetime]="r.finishedAt" [attr.title]="r.finishedAt">{{ local(r.finishedAt) }}</time></p>
      <p class="result" [class.pass]="r.passed && complete()" [class.fail]="!r.passed" [class.incomplete]="r.passed && !complete()" data-testid="result-line">{{ line() }}</p>
      @if (!complete()) {
        <p data-testid="coverage-line">Coverage is incomplete: {{ r.summary.coverage?.warnings?.length || 0 }} warning{{ r.summary.coverage?.warnings?.length === 1 ? '' : 's' }} (under Details). <a routerLink="/troubleshoot" class="small-link">Troubleshoot</a></p>
      }
      <h2 id="findings-h">Findings by page</h2>
      <nav aria-label="Audited pages" data-testid="routes">
        <ul class="routes">
          @for (rt of routes(); track rt.key) {
            <li>
              <button type="button" class="route" data-testid="route" [attr.data-url]="rt.url" [attr.aria-current]="rt.key === route()?.key ? 'true' : null" (click)="selectRoute(rt.key)">
                <span class="mark" [class.bad]="rt.violations > 0" aria-hidden="true">{{ rt.violations ? '✗' : '✓' }}</span>
                <strong class="path">{{ rt.path }}</strong>@if (rt.query) {<span class="query" [attr.title]="rt.url">?…</span>}
                <span class="counts">{{ rt.violations }} violation{{ rt.violations === 1 ? '' : 's' }} · {{ rt.reviews }} review</span>
              </button>
            </li>
          }
        </ul>
      </nav>
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
          <label for="f-text">Text</label>
          <input id="f-text" type="search" (input)="text.set(val($event))" />
        </div>
      </form>
      <p role="status" data-testid="finding-count">{{ filtered().length }} of {{ routeRows().length }} findings on {{ routeName() }} shown</p>
      <table class="findings" data-testid="findings">
        <caption>Findings on {{ routeName() }}</caption>
        <thead><tr><th scope="col">Kind</th><th scope="col">Test</th><th scope="col">Message</th><th scope="col"><span class="visually-hidden">Details</span></th></tr></thead>
        <tbody>
          @for (f of filtered().slice(0, 300); track f.key) {
            <tr data-testid="finding-row">
              <td><span class="badge" [class]="'badge ' + f.level + ' ' + f.impact" data-testid="badge">{{ f.level === 'violation' ? f.impact + ' violation' : 'review · ' + f.impact }}</span></td>
              <td><strong>{{ f.test }}</strong> {{ f.name }}</td>
              <td class="msg">{{ f.message }}</td>
              <td><button type="button" class="secondary small" (click)="selected.set(f)" [attr.aria-label]="'Details for finding: ' + f.message">Details</button></td>
            </tr>
          }
        </tbody>
      </table>
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

      @if (reportId() === 'latest') {
        <div class="actions next">
          <button type="button" class="big" (click)="fixNext()" [disabled]="!fixable()" data-testid="fix-next">Fix the violations</button>
          @if (!fixable()) { <span class="hint">{{ fixReason() }}</span> }
        </div>
      }
      <details class="details" data-testid="details" [open]="showDetails()" (toggle)="toggled($event)">
        <summary>Details<span class="visually-hidden"> of the results</span></summary>
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
            <tr [attr.data-url]="p.finalUrl || p.url"><th scope="row">{{ short(p.finalUrl || p.url) }}</th><td>{{ p.title }}</td><td>@if (!p.error && !p.skipped && p.servedWith) {<span data-testid="soft-404" [attr.title]="soft404">{{ p.servedWith }} · app rendered</span>} @else { {{ p.error || p.skipped || p.status }} }</td><td>{{ count(p.findings, 'violation') }}</td><td>{{ count(p.findings, 'review') }}</td>
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
      </details>
    }
  `,
})
export class ReportScreen {
  readonly found = foundText;
  readonly soft404 = SOFT_404_TITLE;
  readonly local = localTime;
  readonly discovery = discoveryOf;
  readonly quoted = skippedText;

  private api = inject(Api);
  private run = inject(RunStore);
  private router = inject(Router);
  // Details (totals, charts, coverage warnings, the manual checklist, the pages table): closed by default.
  readonly showDetails = signal(detailsOpen('results'));
  toggled(e: Event): void {
    const open = (e.target as HTMLDetailsElement).open;
    this.showDetails.set(open);
    setDetailsOpen('results', open);
  }
  // The next step: Fix, in the app's repository.
  readonly fixable = computed(() => !!this.env.env()?.inGitRepo && !this.run.active());
  readonly fixReason = computed(() => (this.run.active() ? 'A run is active.' : "Fixing needs the app's repository: choose it in Set up."));
  async fixNext(): Promise<void> {
    await this.router.navigateByUrl('/fix-loop?start=1');
  }
  private env = inject(EnvStore);
  readonly id = input<string>();
  // ?route=<page URL>: the page to show (from a row of the Live screen's page table).
  readonly routeParam = input<string | undefined>(undefined, { alias: 'route' });
  readonly report = signal<Report | null>(null);
  readonly loading = signal(true);
  readonly animations = !prefersReducedMotion();
  readonly impacts = IMPACTS;
  readonly short = shortUrl;
  readonly level = signal('');
  readonly impact = signal('');
  readonly test = signal('');
  readonly text = signal('');
  readonly selectedRoute = signal<string | null>(null);
  readonly selected = signal<Row | null>(null);

  readonly reportId = computed(() => this.id() || 'latest');
  readonly heading = computed(() => {
    const id = this.reportId();
    if (id === 'latest') return 'Latest report';
    if (id.startsWith('round-')) return `Report: loop round ${id.slice(6)}`;
    return `Report from ${localTime(this.report()?.finishedAt) || 'history'}`;
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
    for (const p of r.pages) for (const f of p.findings || []) out.push({ ...f, key: key++, page: p.finalUrl || p.url, route: p.finalUrl || p.url });
    for (const f of r.site?.findings || []) out.push({ ...f, key: key++, page: (f.pages || []).join(', ') || 'site-wide', route: 'site-wide' });
    return out;
  });
  // The audited pages, each once, worst first (most critical, then serious … violations), then Site-wide.
  readonly routes = computed<Route[]>(() => {
    const r = this.report();
    if (!r) return [];
    const seen = new Map<string, Route>();
    for (const p of r.pages) {
      if (p.error || p.skipped) continue;
      const url = p.finalUrl || p.url;
      if (seen.has(url)) continue;
      let path = url;
      let query = '';
      try {
        const u = new URL(url);
        path = u.pathname || '/';
        query = u.search + u.hash;
      } catch {}
      const rt: Route = { key: url, path, query, url, byImpact: { critical: 0, serious: 0, moderate: 0, minor: 0 }, violations: 0, reviews: 0 };
      for (const f of p.findings || []) {
        if (f.level === 'violation') {
          rt.violations++;
          rt.byImpact[f.impact] = (rt.byImpact[f.impact] || 0) + 1;
        } else rt.reviews++;
      }
      seen.set(url, rt);
    }
    const worst = (a: Route, b: Route) => IMPACTS.map((i) => b.byImpact[i] - a.byImpact[i]).find((d) => d !== 0) || b.reviews - a.reviews;
    const list = [...seen.values()].sort(worst);
    const site = r.site?.findings || [];
    if (site.length) {
      list.push({ key: 'site-wide', path: 'Site-wide', query: '', url: 'site-wide', byImpact: {}, violations: site.filter((f) => f.level === 'violation').length, reviews: site.filter((f) => f.level !== 'violation').length });
    }
    return list;
  });
  // The selected route: the worst page by default.
  readonly route = computed(() => this.routes().find((r) => r.key === this.selectedRoute()) || this.routes()[0] || null);
  readonly routeName = computed(() => (this.route() ? (this.route()!.key === 'site-wide' ? 'the whole site' : this.route()!.path + (this.route()!.query ? '?…' : '')) : 'no page'));
  readonly routeRows = computed(() => {
    const k = this.route()?.key;
    return this.rows().filter((f) => f.route === k).sort(byWeight);
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
  readonly filtered = computed(() => {
    const q = this.text().toLowerCase().trim();
    return this.routeRows().filter(
      (f) =>
        (!this.level() || f.level === this.level()) &&
        (!this.impact() || f.impact === this.impact()) &&
        (!this.test() || f.test === this.test()) &&
        (!q || `${f.message} ${f.selector || ''} ${f.html || ''}`.toLowerCase().includes(q))
    );
  });
  private title = inject(Title);

  constructor() {
    // Each report has a title of its own.
    // Opened for one page (?route=), the title names it, so each such address has its own.
    effect(() => {
      const want = this.routeParam();
      let page = '';
      if (want) {
        try {
          const u = new URL(want);
          page = `: ${u.pathname}${u.search}`;
        } catch {
          page = `: ${want}`;
        }
      }
      this.title.setTitle(`${this.heading()}${page} - a11y-508`);
    });
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
    this.selectedRoute.set(null);
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
    const want = this.routeParam();
    if (want && this.routes().some((x) => x.key === want)) this.selectedRoute.set(want);
  }

  selectRoute(key: string): void {
    this.selectedRoute.set(key);
    this.selected.set(null);
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
