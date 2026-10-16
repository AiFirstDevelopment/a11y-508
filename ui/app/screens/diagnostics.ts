import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Diagnostics, entryTime } from '../core/diagnostics';
import { Driver } from '../core/driver';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { Starter } from '../core/starter';
import { foundText, localTime } from '../core/format';
import { countsLine, span } from '../core/now';
import { tallyLine } from '../core/where';
import { CrawledRoutes, Journal, LoopTimeline, Report, ReportListEntry, TimelineRound } from '../core/types';
import { QuitButton } from '../shared/quit-button';

// Keys whose values are secrets, anywhere in the config; and the crawl options that carry one.
const SECRET_KEY = /token|secret|password|cookie|authorization|header|^deploy$/i;
const SECRET_FLAG = /^--(header|cookie|token)/;

// The config with its secrets blanked: values under secret-looking keys, and the value after a
// --header or --cookie in its crawl options.
export function stripSecrets(c: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(c || {})) {
    if (SECRET_KEY.test(k)) out[k] = '[removed]';
    else if (typeof v === 'string' && /^[a-z]+:\/\/[^/@\s]+@/i.test(v)) out[k] = v.replace(/\/\/[^/@\s]+@/, '//[removed]@');
    else if (Array.isArray(v)) out[k] = v.map((x, i) => (i > 0 && SECRET_FLAG.test(String(v[i - 1])) ? '[removed]' : /^--(header|cookie)=/.test(String(x)) ? String(x).replace(/=.*/, '=[removed]') : x));
    else if (v && typeof v === 'object') out[k] = stripSecrets(v);
    else out[k] = v;
  }
  return out;
}

// Diagnostics: everything useful to the tool's developer, on one page, in one order, as plain
// sections; Copy diagnostics and Download diagnostics give the whole page as text. At the bottom,
// Change folder or URL, Advanced, and Quit.
@Component({
  selector: 'app-diagnostics',
  imports: [RouterLink, QuitButton],
  template: `
    <h1>Diagnostics</h1>
    <p><a routerLink="/">Back to the dashboard</a></p>
    <div class="actions">
      <button type="button" (click)="copy()" data-testid="copy-diagnostics">Copy diagnostics</button>
      <button type="button" class="secondary" (click)="download()" data-testid="download-diagnostics">Download diagnostics</button>
      <span role="status" data-testid="diagnostics-copied">{{ copied() }}</span>
    </div>
    @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
    <article #page class="diagnostics" data-testid="diagnostics-page" aria-label="Diagnostics">
      <section aria-labelledby="d-setup"><h2 id="d-setup">Build and setup</h2>
        <dl class="facts" data-testid="d-setup">
          <dt>Build</dt><dd>{{ env.env()?.revision || env.env()?.version || '—' }}</dd>
          <dt>Platform</dt><dd>{{ env.env()?.platform || '—' }}</dd>
          <dt>Folder</dt><dd data-testid="d-folder">{{ env.cwd() || '—' }}</dd>
          <dt>URL</dt><dd>{{ driver.url() || '—' }}</dd>
          <dt>Config</dt><dd>{{ env.env()?.config?.file || '—' }}{{ driver.repoConfig() ? " (the repository's own)" : '' }}</dd>
        </dl>
        <pre class="wrap" data-testid="d-config">{{ configText() }}</pre>
      </section>

      <section aria-labelledby="d-counts"><h2 id="d-counts">Counts</h2>
        <p data-testid="d-counts-line">{{ counts() || 'Nothing found yet.' }}</p>
        @if (tally(); as t) { <p data-testid="d-tally">{{ t }}</p> }
        @if (timeLine(); as tl) { <p data-testid="d-time">{{ tl }}</p> }
      </section>

      <section aria-labelledby="d-journal"><h2 id="d-journal">What happened</h2>
        @if (journal()?.entries?.length) {
          <ol class="plain" data-testid="d-journal-list">
            @for (e of journal()!.entries; track $index) { <li>{{ e.at ? local(e.at) : '' }} {{ e.text }}@if (e.count && e.count > 1) { ({{ e.count }} times, until {{ local(e.until || null) }})}</li> }
          </ol>
        } @else { <p>Nothing yet.</p> }
      </section>

      <section aria-labelledby="d-rounds"><h2 id="d-rounds">Rounds</h2>
        @if (timeline()?.rounds?.length) {
          <table data-testid="d-rounds-table">
            <thead><tr><th scope="col">Round</th><th scope="col">Finished</th><th scope="col">Source</th><th scope="col">Pages audited</th><th scope="col">Found</th><th scope="col">Fixed</th><th scope="col">Verified</th><th scope="col">Did not hold</th><th scope="col">Open after</th><th scope="col">Commits</th><th scope="col">State</th></tr></thead>
            <tbody>
              @for (r of timeline()!.rounds; track r.round) {
                <tr><th scope="row">{{ r.round }}</th><td>{{ local(r.at) }}</td><td>{{ r.source || 'crawl' }}</td><td>{{ r.audited ?? '—' }}</td><td>{{ r.found }}</td><td>{{ r.fixed }}</td><td>{{ r.verified ?? 0 }}</td><td>{{ r.failed ?? 0 }}</td><td>{{ r.remaining }}</td><td>{{ r.commits }}</td><td>{{ r.label || 'done' }}</td></tr>
              }
            </tbody>
          </table>
        } @else { <p>No rounds yet.</p> }
      </section>

      <section aria-labelledby="d-routes"><h2 id="d-routes">Routes crawled</h2>
        @if (routes()?.routes?.length) {
          <table data-testid="d-routes-table">
            <thead><tr><th scope="col">Route</th><th scope="col">Title</th><th scope="col">Rounds</th><th scope="col">Last result</th><th scope="col">Violations</th><th scope="col">Review</th><th scope="col">Found on it</th><th scope="col">Took</th></tr></thead>
            <tbody>
              @for (r of routes()!.routes; track r.url) {
                <tr [attr.data-url]="r.url"><th scope="row">{{ r.url }}@if (r.foundBy && r.foundBy !== 'link') { (found by {{ r.foundBy }})}</th><td>{{ r.title || '—' }}</td><td>{{ r.rounds.length ? r.rounds.join(', ') : '—' }}</td><td>{{ r.status || '—' }}</td><td>{{ r.violations }}</td><td>{{ r.reviews }}</td><td data-testid="d-route-found">{{ r.found ? found(r.found) : '—' }}</td><td>{{ took(r) }}</td></tr>
              }
            </tbody>
          </table>
          <h3>Coverage of the last crawl</h3>
          @if (routes()!.coverage.warnings.length) {
            <ul data-testid="d-coverage-warnings">@for (w of routes()!.coverage.warnings; track $index) { <li>{{ w }}</li> }</ul>
          } @else { <p>It reached every page it could find.</p> }
          @if (routes()!.coverage.notes.length) {
            <h3>Coverage notes</h3>
            <ul data-testid="d-coverage-notes">@for (n of routes()!.coverage.notes; track $index) { <li>{{ n }}</li> }</ul>
          }
        } @else { <p>No route crawled yet.</p> }
      </section>

      <section aria-labelledby="d-findings"><h2 id="d-findings">Findings in the latest report</h2>
        @if (report(); as rep) {
          <p>{{ reportName() }}: {{ rep.baseUrl }}, finished {{ local(rep.finishedAt) }}, {{ rep.summary.audited }} of {{ rep.summary.pages }} pages audited, {{ rep.summary.violations }} violations, {{ rep.summary.reviews }} review items.</p>
          @for (p of findingPages(); track p.url) {
            <h3>{{ p.url }}</h3>
            <table data-testid="d-findings-table">
              <thead><tr><th scope="col">Test</th><th scope="col">Level</th><th scope="col">Impact</th><th scope="col">Message</th><th scope="col">Selector</th><th scope="col">Page</th></tr></thead>
              <tbody>
                @for (f of p.findings; track $index) {
                  <tr data-testid="d-finding"><td>{{ f.test }}</td><td>{{ f.level }}</td><td>{{ f.impact }}</td><td>{{ f.message }}</td><td data-testid="d-finding-selector">{{ f.selector || '—' }}{{ f.frame ? ' (in frame ' + f.frame + ')' : '' }}</td><td>{{ p.url }}</td></tr>
                }
              </tbody>
            </table>
          }
        } @else { <p>No report yet.</p> }
      </section>

      <section aria-labelledby="d-skipped"><h2 id="d-skipped">Could not be fixed</h2>
        @if (skipped().length) {
          <ul data-testid="d-skipped-list">@for (e of skipped(); track $index) { <li>{{ e.test }} {{ e.impact }}: {{ e.message }} [{{ e.selector }}] — {{ e.reason || 'no reason recorded' }} ({{ e.pages }} page{{ e.pages === 1 ? '' : 's' }}, {{ e.attempts }} attempt{{ e.attempts === 1 ? '' : 's' }})</li> }</ul>
        } @else { <p>Nothing.</p> }
      </section>

      <section aria-labelledby="d-deploy"><h2 id="d-deploy">Deploy record</h2>
        @if (deploy(); as d) {
          <dl class="facts" data-testid="d-deploy">
            <dt>Branch</dt><dd>{{ d['branch'] || '—' }}</dd>
            <dt>Remote</dt><dd>{{ d['remote'] || '—' }} ({{ d['pushed'] ? 'pushed' : 'not pushed' }}{{ d['pushedAt'] ? ' at ' + local(d['pushedAt']) : '' }})</dd>
            <dt>Round</dt><dd>{{ d['round'] }}</dd>
            <dt>Marker awaited</dt><dd>{{ d['marker'] || '—' }}{{ d['markerFile'] ? ' in ' + d['markerFile'] : '' }}</dd>
            <dt>Marker served</dt><dd>{{ served() }}</dd>
            <dt>Waiting since</dt><dd>{{ local(d['since'] || null) }}</dd>
          </dl>
        } @else { <p>No fixes wait for a deployment.</p> }
      </section>

      <section aria-labelledby="d-changes"><h2 id="d-changes">Changes by round</h2>
        @if (changedRounds().length) {
          @for (r of changedRounds(); track r.round) {
            <h3>Round {{ r.round }}</h3>
            <table data-testid="d-changes-table">
              <thead><tr><th scope="col">Finding</th><th scope="col">Files</th><th scope="col">Commit</th><th scope="col">Assistant</th><th scope="col">Check</th><th scope="col">Story</th></tr></thead>
              <tbody>
                @for (c of r.changes!; track $index) {
                  <tr><td>{{ c.test }} {{ c.message }}{{ c.elements > 1 ? ' (' + c.elements + ' elements)' : '' }}</td><td>{{ (c.files || []).join(', ') || '—' }}</td><td>{{ c.commit || '—' }}</td><td>{{ c.agentMs != null ? spanOf(c.agentMs) : '—' }}</td><td>{{ c.gateMs != null ? spanOf(c.gateMs) : '—' }}</td><td>{{ c.story || '—' }}</td></tr>
                }
              </tbody>
            </table>
          }
        } @else { <p>No changes yet.</p> }
      </section>

      <section aria-labelledby="d-assistants"><h2 id="d-assistants">Assistants</h2>
        <p data-testid="d-assistant">Runs: {{ driver.agent() ? driver.label(driver.agent()) + ' (' + driver.agent() + ')' : 'none' }} · fallback: {{ driver.fallback() ? driver.label(driver.fallback()) : 'none' }}</p>
        <ul>
          @for (p of presets(); track p.name) { <li>{{ p.label }}: {{ p.found ? (p.version || 'version unknown') + ', at ' + p.path + ' (found ' + (p.where === 'PATH' ? 'on PATH' : 'through ' + p.where) + ')' : 'not installed' }}</li> }
          @if (env.env()?.detecting) { <li>Still detecting…</li> }
        </ul>
      </section>

      <section aria-labelledby="d-diary"><h2 id="d-diary">Diagnostics diary</h2>
        @if (diag.entries(); as list) {
          @if (list.length) {
            <ol class="plain diary" data-testid="diagnostics-list">
              @for (e of list.slice(0, 50); track $index) {
                <li data-testid="diagnostics-entry"><time [attr.datetime]="e.at">{{ time(e.at) }}</time>{{ ' · ' }}<span class="wrap" data-testid="diagnostics-text">{{ e.text }}</span>@if (e.details.length) {<pre class="wrap">{{ e.details.join('\\n') }}</pre>}</li>
              }
            </ol>
          } @else { <p data-testid="diagnostics-empty">Nothing has been recorded yet.</p> }
        } @else { <p role="status">Loading…</p> }
      </section>

      <section aria-labelledby="d-output"><h2 id="d-output">Output of the {{ store.active() ? 'current' : 'last' }} run</h2>
        @if (store.run(); as r) {
          <p>{{ r['kind'] }} run {{ r['id'] }}, started {{ local(r['at'] || null) }}{{ store.done() ? ', ended ' + (store.done()!['outcome'] || '') : ', running' }}</p>
          @if (r['command']) { <pre class="wrap" data-testid="d-command">{{ r['command'] }}</pre> }
          <pre class="wrap output" data-testid="d-output-text" tabindex="0">{{ output() }}</pre>
        } @else { <p>No run in this folder yet.</p> }
      </section>
    </article>

    <nav class="bottom-links" aria-label="Settings">
      <ul class="plain">
        <li><a href="#" (click)="$event.preventDefault(); changeSetup()" data-testid="change-setup">Change folder or URL</a></li>
        <li><a routerLink="/advanced" data-testid="advanced-link">Advanced</a></li>
      </ul>
    </nav>
    <app-quit />
  `,
  styles: [`
    .diagnostics section { border-top: 1px solid var(--line); margin-top: 16px; }
    .diagnostics table { font-size: 0.85rem; }
    .facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
    .facts dd { margin: 0; overflow-wrap: anywhere; }
    .output { max-height: 480px; overflow: auto; }
    .diary pre { font-size: 0.85rem; margin: 4px 0; }
  `],
})
export class DiagnosticsScreen {
  readonly env = inject(EnvStore);
  readonly store = inject(RunStore);
  readonly driver = inject(Driver);
  readonly diag = inject(Diagnostics);
  private api = inject(Api);
  private starter = inject(Starter);
  private pageEl = viewChild<ElementRef<HTMLElement>>('page');
  readonly copied = signal('');
  readonly error = signal('');
  readonly time = entryTime;
  readonly local = localTime;
  readonly found = foundText;
  readonly spanOf = span;

  readonly timeline = signal<LoopTimeline | null>(null);
  readonly routes = signal<CrawledRoutes | null>(null);
  readonly journal = signal<Journal | null>(null);
  readonly reports = signal<ReportListEntry[]>([]);
  readonly report = signal<Report | null>(null);

  readonly presets = computed(() => this.env.env()?.presets || []);
  readonly configText = computed(() => JSON.stringify(stripSecrets(this.driver.cfg()), null, 2));
  readonly counts = computed(() => countsLine((this.store.ledger()?.['counts'] as Record<string, number>) || this.driver.ledger()?.counts));
  readonly tally = computed(() => {
    const t = this.timeline()?.total?.tally;
    return t ? tallyLine(t, Date.now(), this.store.active()) : '';
  });
  readonly timeLine = computed(() => {
    const t = this.journal()?.time;
    if (!t) return '';
    const parts = ([[t.crawling, 'crawling'], [t.fixing, 'fixing'], [t.waiting, 'waiting for deployments'], [t.signIn, 'waiting for a sign-in']] as [number, string][]).filter(([ms]) => ms >= 1000).map(([ms, w]) => `${span(ms)} ${w}`);
    return parts.length ? `Time per phase: ${parts.join(' · ')}` : '';
  });
  readonly reportName = computed(() => {
    const r = this.reports()[0];
    return !r ? '' : r.source === 'round' ? `Round ${r.round}'s crawl` : r.source === 'latest' ? 'The latest crawl' : 'An earlier crawl';
  });
  // Every page's findings, review items included, and the site-wide ones.
  readonly findingPages = computed(() => {
    const r = this.report();
    if (!r) return [];
    const pages = (r.pages || []).filter((p) => p.findings?.length).map((p) => ({ url: p.finalUrl || p.url, findings: p.findings }));
    if (r.site?.findings?.length) pages.push({ url: 'Site-wide', findings: r.site.findings });
    return pages;
  });
  readonly skipped = computed(() => this.driver.ledger()?.lists?.['skipped'] || []);
  readonly deploy = computed(() => (this.driver.ledger()?.deploy as Record<string, any> | null | undefined) || null);
  readonly served = computed(() => {
    const c = this.store.deployCheck();
    if (!c) return 'not checked in this run';
    return `${c['marker'] ? String(c['marker']) : 'no marker'} (checked ${localTime(String(c['at'] || ''))}: ${String(c['result'] || '')})`;
  });
  readonly changedRounds = computed<TimelineRound[]>(() => (this.timeline()?.rounds || []).filter((r) => r.changes?.length));
  readonly output = computed(() => {
    const notices = this.store.notices().map((n) => `${n.level}: ${n.message}`);
    const pane = this.store.paneLog().replace(/\n$/, '');
    const raw = this.store.raw();
    return [...notices, ...(pane ? ['--- the loop and the assistant ---', pane] : []), ...(raw.length ? ['--- raw output ---', ...raw] : [])].join('\n') || '(no output)';
  });

  took(r: { found: { tookMs?: number | null; timing?: Record<string, number> | null } | null }): string {
    const ms = r.found?.tookMs;
    if (typeof ms !== 'number') return '—';
    const parts = Object.entries(r.found?.timing || {}).filter(([, v]) => v >= Math.max(5000, ms * 0.15)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${span(v)}`);
    return `${span(ms)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }

  constructor() {
    // Everything again after a switch of folder, and as the loop records rounds.
    effect(() => {
      this.env.cwd();
      this.store.ledger();
      this.store.done();
      untracked(() => void this.load());
    });
  }

  private loads = 0;
  async load(): Promise<void> {
    const n = ++this.loads;
    void this.diag.load();
    try {
      const [t, rt, j, l] = await Promise.all([
        this.api.get<LoopTimeline | null>('/api/loop/timeline').catch(() => null),
        this.api.get<CrawledRoutes>('/api/loop/routes').catch(() => null),
        this.api.get<Journal>('/api/loop/journal').catch(() => null),
        this.api.get<ReportListEntry[]>('/api/reports').catch(() => [] as ReportListEntry[]),
      ]);
      if (n !== this.loads) return;
      this.timeline.set(t);
      this.routes.set(rt);
      this.journal.set(j);
      this.reports.set(l || []);
      const latest = (l || [])[0];
      this.report.set(latest ? await this.api.get<Report>(`/api/reports/${encodeURIComponent(latest.id)}`).catch(() => null) : null);
      this.error.set('');
    } catch (e: any) {
      this.error.set(e.message);
    }
  }

  // The whole page, as text.
  text(): string {
    return (this.pageEl()?.nativeElement.innerText || '').trim() + '\n';
  }

  async copy(): Promise<void> {
    const text = this.text();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Without clipboard access: a copy selected and copied the old way, then removed.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    this.copied.set('Copied the whole page.');
  }

  download(): void {
    const blob = new Blob([this.text()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `a11y-508-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.copied.set('Downloaded.');
  }

  changeSetup(): void {
    this.starter.openSetup();
  }
}
