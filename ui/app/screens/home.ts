import { Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Driver } from '../core/driver';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { Starter } from '../core/starter';
import { continuingText } from '../core/resume';
import { plainReason } from '../core/outcome';
import { LedgerItem } from '../core/types';
import { commitUrl } from '../core/git-links';
import { clockOf, countsParts, hostOf, lowerFirst, plural, span, upperFirst, type CountsPart } from '../core/now';
import { ManualPanel } from './manual-panel';
import { DecisionsPane } from '../shared/decisions-pane';
import { ParsedReportPane } from '../shared/parsed-report-pane';
import { ScreenshotsIn } from '../shared/screenshots-in';

// A finding's words, cut at a word once they are long.
function short(text: string, max = 72): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : max).replace(/[\s,;:.]+$/, '')}…`;
}

// Where a PDF run was when the dashboard was closed, from the stage its own files saved.
const PDF_STAGES: Record<string, string> = {
  read: 'while reading', check: 'while checking the deployed site', review: 'at the plan review', fix: 'while fixing', deploy: 'while waiting for the deployment', verify: 'while verifying',
};
function continuingPdf(stage: unknown, shots = false): string {
  const at = PDF_STAGES[String(stage || '')];
  return `The dashboard was closed during the ${shots ? 'screenshots' : 'PDF'} run${at ? ` (${at === 'while reading' ? `while reading the ${shots ? 'screenshots' : 'PDF'}` : at})` : ''}; continuing from there.`;
}

// The one screen (docs/plans/simple-screen.md): the folder and URL, one sentence of what is happening
// now, one line of numbers, one button (Start, or Stop while anything runs), and Diagnostics.
@Component({
  selector: 'app-home-screen',
  imports: [RouterLink, ManualPanel, DecisionsPane, ParsedReportPane, ScreenshotsIn],
  template: `
    <h1 class="app-name">a11y-508@if (env.env()?.revision; as rev) {{{ ' ' }}<span class="build" data-testid="build-revision" title="The commit this dashboard runs">build {{ rev }}</span> }</h1>
    @if (env.env(); as e) {
      <p class="place" data-testid="where">
        <span data-testid="folder" [attr.title]="e.cwd"><span class="visually-hidden">Folder: </span>{{ e.cwd }}</span>
        <span aria-hidden="true"> · </span>
        <span data-testid="url"><span class="visually-hidden">URL: </span>@if (driver.url()) {<a [href]="driver.url()" target="_blank" rel="noopener" data-testid="url-link">{{ driver.url() }}</a>} @else {no URL yet}</span>
        @if (driver.url()) {
          <button type="button" class="secondary small copy-url" data-testid="copy-url" (click)="copyUrl()">{{ copied() ? 'Copied' : 'Copy' }}<span class="visually-hidden"> the app URL to the clipboard</span></button>
        }
        <span aria-hidden="true"> · </span>
        <button type="button" class="secondary small" data-testid="edit-setup" (click)="starter.openSetup()" [disabled]="running()">Edit<span class="visually-hidden"> the repository folder and start URL</span></button>
      </p>
    }
    <p class="big-status" role="status" data-testid="now">@for (seg of nowParts(); track $index) {@if (seg.link) {<a [href]="seg.link === 'output-link' ? '#assistant-output' : '#pages-so-far'" [attr.data-testid]="seg.link" (click)="seg.link === 'output-link' ? openOutput($event) : openPages($event)">{{ seg.text }}</a>} @else {{{ seg.text }}}}</p>
    @if (readFailedNow(); as who) {
      <p data-testid="read-failed-said"><a routerLink="/diagnostics" fragment="assistant-calls" data-testid="see-what-said">See what {{ who }} said</a></p>
    }
    @if (counts().length) {
      <p data-testid="counts">@for (c of counts(); track c.key) {@if (!$first) {<span aria-hidden="true"> · </span>}@if (c.key === 'unfixed') {<a href="#could-not-be-fixed" data-testid="unfixed-link" (click)="openUnfixed($event)">{{ c.text }}</a>} @else if (c.key === 'verified' || c.key === 'pending' || c.key === 'held') {<a href="#fixes" [attr.data-testid]="c.key + '-link'" (click)="openFixes($event, c.key)">{{ c.text }}</a>} @else {<span>{{ c.text }}</span>}}</p>
    }
    <div class="actions">
      @if (running()) {
        <button type="button" class="big" data-testid="go" (click)="driver.stop()" [disabled]="driver.starting() && !store.active()">Stop</button>
      } @else {
        <button type="button" class="big" data-testid="go" (click)="driver.start()" [disabled]="!driver.url()">Start</button>
      }
      @if (signingIn()) {
        <button type="button" class="secondary" data-testid="show-sign-in-tab" (click)="showSignIn()">Show the sign-in tab</button>
      }
      <!-- The second way in (docs/plans/manual-findings.md): a tester's PDF, chosen with the system's file chooser. -->
      @if (!running()) {
        <button type="button" class="secondary" data-testid="manual-pdf" (click)="pdfInput.click()" [disabled]="!driver.url()">{{ manualEnded() ? 'Choose a PDF' : 'Fix from a test report (PDF)' }}</button>
        <!-- Or screenshots alone (docs/plans/screenshots-in.md): picked, dropped or pasted, each with a note. -->
        <button type="button" class="secondary" data-testid="add-shots" (click)="shotsIn.pick()" [disabled]="!driver.url()">Add screenshots</button>
      }
      <input #pdfInput type="file" accept="application/pdf" hidden data-testid="manual-pdf-input" (change)="onPdf($event)" />
    </div>
    <app-screenshots-in #shotsIn [enabled]="!running() && !!driver.url()" />
    @if (store.kind() === 'manual' || lastManual()) {
      <p class="manual-links">@if (decisionsFor(); as id) {<a href="#decisions" data-testid="show-decisions" (click)="openDecisions($event, id)">{{ store.kind() === 'manual' ? 'Show decisions' : 'Show decisions from the last run' }}</a>}@if (parsedFor(); as id) {@if (decisionsFor()) {<span aria-hidden="true"> · </span>}<a href="#parsed-report" data-testid="show-parsed" (click)="openParsed($event, id)">{{ store.manual().source === 'screenshots' ? 'Show the screenshots' : 'Show the parsed report' }}</a>}</p>
    }
    <app-manual-panel />
    <app-decisions-pane #decisions />
    <app-parsed-report-pane #parsedPane />
    @if (driver.error() || missed()) { <p class="notice error" role="alert" data-testid="start-error">{{ driver.error() || missed() }}</p> }
    <p class="diagnostics-link"><a routerLink="/diagnostics" data-testid="diagnostics-link">Log</a><span aria-hidden="true"> · </span><a href="#start-over" data-testid="start-over" (click)="startOver($event)">Start over</a></p>
    @if (resetError()) { <p class="notice error" role="alert">{{ resetError() }}</p> }
    <!-- The fixes: what each one fixed, where, the element, the files it changed and its commit. -->
    <dialog #fixesPanel class="pane" id="fixes" aria-labelledby="fixes-title" data-testid="fixes-panel" (close)="fixesOpen.set(false)">
      @if (fixesOpen()) {
        <div class="pane-head">
          <h2 id="fixes-title">{{ plural(fixed().length, 'fix', 'fixes') }}</h2>
          <button type="button" class="secondary" data-testid="fixes-close" (click)="closeFixes()">Close</button>
        </div>
        @if (!fixed().length) { <p>Nothing is fixed yet.</p> }
        <ol>
          @for (e of fixed(); track $index) {
            <li data-testid="fixes-item">
              <p class="what"><strong>{{ e.test }}</strong> {{ e.impact }}: {{ e.message }}</p>
              <p data-testid="fixes-state"><span class="label">State: </span>{{ e.state }}</p>
              <p data-testid="fixes-where"><span class="label">Where: </span>
                @for (r of routesOf(e); track r; let last = $last) {
                  @if (r === 'site') { the whole site } @else { <a [href]="r" target="_blank" rel="noopener" [title]="r">{{ pathOf(r) }}</a> }@if (!last) {, }
                }
              </p>
              <p><span class="label">Element: </span><code>{{ e.selector || 'the page' }}</code></p>
              @for (f of e.fixes || []; track f.commit) {
                <p data-testid="fixes-commit"><span class="label">Commit: </span>@if (commitLink(f.commit); as u) {<a [href]="u" target="_blank" rel="noopener">{{ f.commit.slice(0, 7) }}</a>} @else {<code>{{ f.commit.slice(0, 7) }}</code>}@if (f.round) { (round {{ f.round }})}@if (f.files.length) { · {{ f.files.join(', ') }}}</p>
                @if (f.note) { <p class="note">{{ f.note }}</p> }
              }
            </li>
          }
        </ol>
      }
    </dialog>
    <!-- What the assistant is printing, as it prints it. -->
    <dialog #outputPanel class="pane" id="assistant-output" aria-labelledby="output-title" data-testid="output-panel" (close)="outputOpen.set(false)">
      @if (outputOpen()) {
        <div class="pane-head">
          <h2 id="output-title">What {{ assistantName() }} is doing</h2>
          <button type="button" class="secondary" data-testid="output-close" (click)="closeOutput()">Close</button>
        </div>
        @if (store.agentCall(); as c) {
          <p data-testid="output-task">{{ c.kind === 'fix' ? 'Fixing' : 'Judging' }} {{ c.label }}@if (c.endedAt) { (finished)}</p>
          <pre #outputText class="output" data-testid="output-text" tabindex="0" aria-live="off">{{ c.text || 'Nothing printed yet.' }}</pre>
        } @else { <p>The assistant is not working right now.</p> }
      }
    </dialog>
    <!-- The pages crawled so far: each one's route, title and findings. -->
    <dialog #pagesPanel class="pane" id="pages-so-far" aria-labelledby="pages-title" data-testid="pages-panel" (close)="pagesOpen.set(false)">
      @if (pagesOpen()) {
        <div class="pane-head">
          <h2 id="pages-title">{{ plural(store.pages().length, 'page') }}, {{ plural(foundSoFar(), 'finding') }}</h2>
          <button type="button" class="secondary" data-testid="pages-close" (click)="closePages()">Close</button>
        </div>
        <ol>
          @for (p of store.pages(); track $index) {
            <li data-testid="pages-item">
              <p class="what"><a [href]="p.finalUrl || p.url" target="_blank" rel="noopener" [title]="p.finalUrl || p.url" data-testid="pages-route">{{ pathOf(p.finalUrl || p.url) }}</a>@if (p.title) { · {{ p.title }}}</p>
              @if (p.error || p.skipped) { <p data-testid="pages-error">Not audited: {{ p.error || p.skipped }}</p> }
              @else if (!p.findings.length) { <p data-testid="pages-none">{{ p.violations + p.reviews ? plural(p.violations + p.reviews, 'finding') : 'No findings' }}</p> }
              @else {
                <ul>
                  @for (f of p.findings; track $index) {
                    <li data-testid="pages-finding"><strong>{{ f.test }}</strong> {{ f.level === 'violation' ? f.impact : 'to review' }}: {{ f.message }} <code>{{ f.selector || 'the page' }}</code></li>
                  }
                </ul>
              }
            </li>
          }
        </ol>
      }
    </dialog>
    <!-- What could not be fixed: a panel from the right, one entry per finding with why, where and the element. -->
    <dialog #unfixedPanel class="pane" id="could-not-be-fixed" aria-labelledby="unfixed-title" data-testid="unfixed-panel" (close)="unfixedOpen.set(false)">
      @if (unfixedOpen()) {
        <div class="pane-head">
          <h2 id="unfixed-title">{{ plural(unfixed().length, 'could not be fixed', 'could not be fixed') }}</h2>
          <button type="button" class="secondary" data-testid="unfixed-close" (click)="closeUnfixed()">Close</button>
        </div>
        @if (!unfixed().length) { <p>Nothing is on record yet.</p> }
        <ol>
          @for (e of unfixed(); track $index) {
            <li data-testid="unfixed-item">
              <p class="what"><strong>{{ e.test }}</strong> {{ e.impact }}: {{ e.message }}</p>
              <p data-testid="unfixed-why"><span class="label">Why: </span>{{ e.why || e.reason || 'no reason was recorded' }}</p>
              <p data-testid="unfixed-where"><span class="label">Where: </span>
                @for (r of routesOf(e); track r; let last = $last) {
                  @if (r === 'site') { the whole site } @else { <a [href]="r" target="_blank" rel="noopener" [title]="r">{{ pathOf(r) }}</a> }@if (!last) {, }
                }
                @if (!routesOf(e).length) { not recorded }
              </p>
              <p data-testid="unfixed-element"><span class="label">Element: </span><code>{{ e.selector || 'the page' }}</code></p>
              @if (e.html) { <pre><code>{{ e.html }}</code></pre> }
            </li>
          }
        </ol>
      }
    </dialog>
  `,
  styles: [`
    .place { overflow-wrap: anywhere; color: var(--muted); }
    .app-name .build { font-size: 0.5em; font-weight: normal; color: var(--muted); }
    dialog.pane { position: fixed; inset: 0 0 0 auto; margin: 0; height: 100vh; max-height: none; width: min(640px, 100vw); max-width: none; box-sizing: border-box; border: 0; border-left: 2px solid var(--accent); border-radius: 0; padding: 16px 20px 24px; overflow: auto; }
    .pane-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .pane-head h2 { margin: 0; }
    .pane ol { padding-left: 22px; margin: 16px 0 0; }
    .pane li { margin: 0 0 18px; }
    .pane li p { margin: 2px 0; overflow-wrap: anywhere; }
    .pane ul { padding-left: 18px; margin: 4px 0 0; }
    .pane pre.output { max-height: calc(100vh - 140px); overflow: auto; font-size: 0.8rem; }
    .pane ul li { margin: 0 0 4px; overflow-wrap: anywhere; }
    .pane .label { color: var(--muted); }
    .pane .note { color: var(--muted); font-style: italic; }
    .pane pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.85rem; background: #f4f4f4; padding: 6px 8px; margin: 4px 0 0; border-radius: 4px; }
  `],
})
export class HomeScreen implements OnDestroy {
  readonly env = inject(EnvStore);
  readonly store = inject(RunStore);
  readonly driver = inject(Driver);
  private api = inject(Api);
  readonly starter = inject(Starter);
  readonly missed = signal('');
  readonly unfixedOpen = signal(false);
  readonly resetError = signal('');
  // Start over: stops any run and forgets this app's rounds, fixes, reports and log; sign-in, settings and commits stay.
  async startOver(ev?: Event): Promise<void> {
    ev?.preventDefault();
    if (!confirm('Start over? This stops any run and erases every round, fix, report and log entry for this app. Your sign-in, settings and the commits already made stay.')) return;
    this.resetError.set('');
    try {
      await this.api.post('/api/reset');
      location.assign('/');
    } catch (e: any) {
      this.resetError.set(`Could not start over: ${e?.message || e}`);
    }
  }
  // The PDF the person chose: it goes to the server, which starts the run (or refuses it in one sentence).
  onPdf(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files && input.files[0];
    input.value = '';
    if (file) void this.driver.startManual(file);
  }
  private decisionsPane = viewChild.required<DecisionsPane>('decisions');
  // The latest PDF run on record, for Show decisions when the current run is another.
  readonly lastManual = signal<string | null>(null);
  private loadManualRuns = async () => {
    try {
      const list = await this.api.get<{ id: string; decisions: boolean }[]>('/api/manual/runs');
      this.lastManual.set(list.find((r) => r.decisions)?.id || null);
    } catch {}
  };
  // The PDF run whose decisions Show decisions opens: the current one once it has any, else the last.
  readonly decisionsFor = computed(() => {
    if (this.store.kind() === 'manual') {
      const m = this.store.manual();
      return m.id && (m.decisions.length || this.store.done()) ? m.id : null;
    }
    return this.lastManual();
  });
  openDecisions(ev: Event, id: string): void {
    ev.preventDefault();
    void this.decisionsPane().open(id);
  }
  // Show the parsed report (docs/plans/pdf-parse.md AC 9): once the current PDF run's PDF is parsed.
  private parsedPane = viewChild.required<ParsedReportPane>('parsedPane');
  readonly parsedFor = computed(() => {
    if (this.store.kind() !== 'manual') return null;
    const m = this.store.manual();
    return m.id && m.parsed ? m.id : null;
  });
  openParsed(ev: Event, id: string): void {
    ev.preventDefault();
    void this.parsedPane().open(id, this.store.manual().source);
  }
  // A PDF run that has ended: how.
  readonly manualEnded = computed(() => {
    if (this.store.kind() !== 'manual' || !this.store.done()) return null;
    return this.store.manual();
  });
  // A PDF run that ended because the PDF could not be read: who could not, for the link to what it said.
  readonly readFailedNow = computed(() => {
    const m = this.manualEnded();
    return m?.readFailed && this.now() === m.readFailed ? m.readFailedBy || this.assistant() : null;
  });
  readonly pagesOpen = signal(false);
  readonly fixesOpen = signal(false);
  // Which group the link opened: the verified fixes, those awaiting the deployment, or those held for the next push.
  private fixesGroup = signal<'verified' | 'pending' | 'held'>('verified');
  private fixesPanel = viewChild.required<ElementRef<HTMLDialogElement>>('fixesPanel');
  // The group the opened link counts.
  readonly fixed = computed(() => {
    const l = this.driver.ledger()?.lists;
    if (!l) return [];
    const pending = (l['pending'] || []).map((e) => ({ ...e, state: 'committed and pushed; waiting for your deployment to verify it' }));
    const verified = (l['verified'] || []).map((e) => ({ ...e, state: 'verified: gone on a later crawl' }));
    const held = (l['held'] || []).map((e) => ({ ...e, state: 'committed; goes out with the next push' }));
    const g = this.fixesGroup();
    return g === 'pending' ? pending : g === 'held' ? held : verified;
  });
  commitLink(sha: string): string | null {
    return commitUrl(this.env.env()?.remoteWeb, sha);
  }
  openFixes(ev?: Event, group: string = 'verified'): void {
    ev?.preventDefault();
    this.fixesGroup.set(group === 'pending' || group === 'held' ? group : 'verified');
    void this.driver.loadLedger();
    this.fixesOpen.set(true);
    const d = this.fixesPanel().nativeElement;
    if (!d.open) d.showModal();
  }
  closeFixes(): void {
    const d = this.fixesPanel().nativeElement;
    if (d.open) d.close();
    this.fixesOpen.set(false);
  }
  readonly outputOpen = signal(false);
  private outputPanel = viewChild.required<ElementRef<HTMLDialogElement>>('outputPanel');
  private outputText = viewChild<ElementRef<HTMLPreElement>>('outputText');
  readonly assistantName = computed(() => this.assistant() || 'the assistant');
  private pagesPanel = viewChild.required<ElementRef<HTMLDialogElement>>('pagesPanel');
  private unfixedPanel = viewChild.required<ElementRef<HTMLDialogElement>>('unfixedPanel');
  readonly plural = plural;
  private tick = signal(Date.now());
  private ticker = setInterval(() => this.tick.set(Date.now()), 1000);

  constructor() {
    // The output follows the assistant: scrolled to its latest line as it prints.
    effect(() => {
      this.store.agentCall()?.text;
      const el = this.outputText()?.nativeElement;
      if (el) setTimeout(() => (el.scrollTop = el.scrollHeight));
    });
    // The PDF runs on record, at first and whenever a run ends.
    effect(() => {
      this.store.done();
      this.env.cwd();
      untracked(() => void this.loadManualRuns());
    });
    // Nothing known to crawl: Set up, as on a first visit.
    effect(() => {
      const missing = !this.driver.pending() && !this.driver.url() && !this.store.run() && !this.env.env()?.run;
      untracked(() => {
        if (missing) this.starter.openSetup();
      });
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.ticker);
  }

  // Anything running, about to run again, or being started: the button is Stop. A PDF run the
  // dashboard's restart ended is about to run again from the moment it ended (its done says so).
  readonly running = computed(() => {
    const s = this.store;
    const r = s.retry();
    const d = s.done();
    return s.active() || s.retryPending() || (!!d && (d['outcome'] === 'interrupted' || (!!d['rerun'] && !s.rerunWithdrawn()) || (!!r && !!r.firedAt && !r.cancelled))) || this.driver.starting();
  });
  readonly signingIn = computed(() => this.store.loginWaiting() && this.store.active());

  // The start URL onto the clipboard ("Copied" for a moment); a browser that refuses leaves the link to copy by hand.
  readonly copied = signal(false);
  async copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.driver.url());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {}
  }

  async showSignIn(): Promise<void> {
    this.missed.set('');
    try {
      await this.api.post('/api/sign-in/show');
    } catch {
      this.missed.set('The sign-in tab could not be brought forward. Look for it in your open browser windows.');
    }
  }

  // Once the loop has ended, what is still open or undecided could not be fixed either.
  private loopEnded = computed(() => this.loopKind() && !!this.store.done() && !this.running());

  // The ledger's counts, live while the loop runs; a crawl alone has only what it found.
  readonly counts = computed<CountsPart[]>(() => {
    // A PDF run has its own numbers in its sentence; the crawl loop's ledger is not its.
    if (this.store.kind() === 'manual') return [];
    const live = this.store.ledger()?.['counts'] as Record<string, number> | undefined;
    const c = live || this.driver.ledger()?.counts;
    if (c && Object.keys(c).length) return countsParts(c, this.loopEnded());
    const one = (n: number): CountsPart[] => (n ? [{ key: 'found', n, text: `${n} found` }] : []);
    // A crawl under way, with no ledger yet: what it has found so far, never an older report's total.
    if (this.store.active()) return one(this.store.pages().reduce((a, p) => a + (p.violations || 0) + (p.reviews || 0), 0));
    const sum = this.store.kind() === 'crawl' ? this.store.summary()?.['summary'] : null;
    const r = this.env.env()?.report;
    return one(sum ? (sum.violations || 0) + (sum.reviews || 0) : r?.exists ? (r.violations || 0) + (r.reviews || 0) : 0);
  });

  // What could not be fixed, as the line counts it: given up on, and once the loop has ended, still open or undecided.
  readonly unfixed = computed<LedgerItem[]>(() => {
    const lists = this.driver.ledger()?.lists;
    if (!lists) return [];
    return [...(lists['skipped'] || []), ...(this.loopEnded() ? [...(lists['open'] || []), ...(lists['review'] || [])] : [])];
  });
  readonly routesOf = (e: LedgerItem): string[] => e.routes || [];
  pathOf(url: string): string {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.hash}` || '/';
    } catch {
      return url;
    }
  }
  readonly foundSoFar = computed(() => this.store.pages().reduce((a, p) => a + (p.violations || 0) + (p.reviews || 0), 0));
  // The sentence, with "6 pages" and "24 findings" as links to the pages panel while there are pages to show.
  readonly nowParts = computed<{ text: string; link?: string }[]>(() => {
    const text = this.now();
    // While the assistant works, its name is a link to what it is printing.
    const c = this.store.agentCall();
    const who = this.assistant();
    if (c && !c.endedAt && who) {
      const at = text.search(new RegExp(`(?<=^Asking | with )${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      if (at >= 0) return [{ text: text.slice(0, at) }, { text: who, link: 'output-link' }, { text: text.slice(at + who.length) }].filter((x) => x.text);
    }
    if (!this.store.pages().length || !/^(Crawling |Done: crawled )/.test(text)) return [{ text }];
    const out: { text: string; link?: string }[] = [];
    let last = 0;
    for (const m of text.matchAll(/\d+ pages?(?= so far|,)|\d+ findings?/g)) {
      if (m.index! > last) out.push({ text: text.slice(last, m.index) });
      out.push({ text: m[0], link: /page/.test(m[0]) ? 'pages-link' : 'findings-link' });
      last = m.index! + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  });
  openOutput(ev?: Event): void {
    ev?.preventDefault();
    this.outputOpen.set(true);
    const d = this.outputPanel().nativeElement;
    if (!d.open) d.showModal();
  }
  closeOutput(): void {
    const d = this.outputPanel().nativeElement;
    if (d.open) d.close();
    this.outputOpen.set(false);
  }
  openPages(ev?: Event): void {
    ev?.preventDefault();
    this.pagesOpen.set(true);
    const d = this.pagesPanel().nativeElement;
    if (!d.open) d.showModal();
  }
  closePages(): void {
    const d = this.pagesPanel().nativeElement;
    if (d.open) d.close();
    this.pagesOpen.set(false);
  }
  openUnfixed(ev?: Event): void {
    ev?.preventDefault();
    void this.driver.loadLedger();
    this.unfixedOpen.set(true);
    const d = this.unfixedPanel().nativeElement;
    if (!d.open) d.showModal();
  }
  closeUnfixed(): void {
    const d = this.unfixedPanel().nativeElement;
    if (d.open) d.close();
    this.unfixedOpen.set(false);
  }

  private host = computed(() => hostOf(String(this.store.run()?.['url'] || '') || this.driver.url()));
  private assistant = computed(() => this.driver.label(String((this.store.run()?.['meta'] as Record<string, unknown> | undefined)?.['agent'] || '') || this.driver.agent()));
  private loopKind = computed(() => ['loop', 'dry-run'].includes(this.store.kind() || ''));
  private ledgerCounts = computed<Record<string, number>>(() => (this.store.ledger()?.['counts'] as Record<string, number>) || this.driver.ledger()?.counts || {});

  // The one sentence: what is happening now, in the person's words.
  readonly now = computed(() => {
    const s = this.store;
    if (this.driver.starting() && !s.active()) return 'Starting…';
    if (!s.run()) return this.idle();
    if (s.done()) return this.ended();
    if (s.stopping()) return 'Stopping…';
    if (s.loginWaiting()) {
      const tab = s.loginReopened() ? 'the tab that opened again (the first was closed)' : 'the tab that opened';
      return s.signInAgain() || s.origin()?.type === 'sign-in-again' ? `Your sign-in expired: sign in in ${tab}; this continues by itself` : `Sign in in ${tab}; this continues by itself`;
    }
    if (s.kind() === 'install') return `Installing ${String(s.run()?.['agent'] || 'the assistant')}…`;
    if (s.kind() === 'manual') return this.manualNow();
    if (!this.loopKind()) return this.crawling();
    return this.looping();
  });

  private idle(): string {
    const host = this.host();
    if (!this.driver.url()) return 'Choose the app\'s folder and URL to start.';
    const why = this.driver.whyNoFix();
    if (why) return `Ready to crawl ${host}; nothing will be fixed: ${why}.`;
    return this.driver.ledger()?.exists ? `Ready to go on with ${host}: verify what is fixed, fix what is open, and crawl again.` : `Ready to crawl ${host} and fix what it finds.`;
  }

  private crawling(): string {
    const s = this.store;
    const pages = s.pages().length;
    if (!pages && s.origin()?.type === 'rerun' && !this.loopKind()) return 'The crawl was interrupted (the dashboard was closed); running it again';
    const findings = s.pages().reduce((a, p) => a + (p.violations || 0) + (p.reviews || 0), 0);
    return `Crawling ${this.host()}: ${plural(pages, 'page')} so far, ${plural(findings, 'finding')}`;
  }

  private looping(): string {
    const s = this.store;
    const now = this.tick();
    const r = s.round();
    const c = s.agentCall();
    const o = s.origin();
    const who = this.assistant();
    const g = s.gate();
    // An interrupted loop continued by the dashboard: said until the first fix it goes on with is done.
    if (o && o.type === 'resume' && !s.changes().length && !(g && !g.endedAt) && !s.awaitingDeploy()) return continuingText(o);
    // The check runs inside the fix's task, after the assistant: it comes first.
    if (g && !g.endedAt && g.round === r) return g.part === 'test' ? `Running the tests once for the round: ${g.check}` : `Checking ${g.n ? 'the fix' : "the round's fixes"}: ${g.check}`;
    if (c && !c.endedAt) {
      if (c.wait && c.wait.until > now) return `${upperFirst(who)} is rate-limited; trying again in ${span(c.wait.until - now)}`;
      if (c.kind === 'fix') {
        const fb = s.fallback();
        const by = fb && fb.round === c.round && fb.n === (c.n ?? c.task) ? this.driver.label(fb.assistant) : who;
        return `Fixing ${short(c.label)} (${c.n ?? c.task} of ${c.m ?? s.task()?.m ?? '?'}) with ${by}, ${span(now - c.startedAt)}`;
      }
      return `Asking ${who} about ${plural(Number(c.count ?? 0) || 0, 'review item')}${c.m && c.m > 1 ? ` (batch ${c.n ?? c.task} of ${c.m})` : ''}, ${span(now - c.startedAt)}`;
    }
    // The build the fixes wait for is live: the next crawl verifies them.
    const dep = s.deployment();
    if (dep && dep['state'] === 'arrived' && (r === null || Number(dep['round']) >= r - 1)) return `Your deployment arrived: verifying ${plural(Number(dep['pending']) || 0, 'fix', 'fixes')}`;
    if (s.awaitingDeploy()) return this.waiting();
    // The dashboard's own restarts, while nothing of the new run has happened yet.
    if (o && o.type === 'retry' && !r) {
      const why = lowerFirst(String(o['reason'] || '').replace(/\.$/, ''));
      if (o['kind'] === 'precondition') return `Starting by itself now that it can (attempt ${o['attempt']})`;
      if (o['kind'] === 'wait') return `Watching for your deployment again: ${why}`;
      return `Trying again (attempt ${o['attempt']}): ${lowerFirst(plainReason(why).replace(/\.$/, ''))}`;
    }
    if (!r) return 'Starting the fix loop…';
    const step = String(s.step()?.['step'] || '');
    if (step === 'commit' && s.step()?.['n']) return `Committing fix ${s.step()?.['n']} of ${s.step()?.['m']}`;
    if (step === 'deploy' || step === 'await-deploy') return this.waiting();
    if (step === 'push') return `Pushing ${plural(s.committed(), 'fix', 'fixes')} to ${this.branch()}`;
    if (step === 'fix') return `Fixing ${plural(Number(s.task()?.m ?? s.step()?.['count'] ?? 0), 'finding')} with ${who}`;
    if (step === 'triage') return `Asking ${who} about ${plural(Number(s.step()?.['count'] ?? 0), 'review item')}`;
    if (step === 'report') return 'Fixing from the last crawl';
    if (step === 'ledger') return 'Fixing what is still open, with no crawl';
    return this.crawling();
  }

  private branch(): string {
    const w: Record<string, any> = this.store.deployWait() || {};
    return String(w['branch'] || this.driver.ledger()?.deploy?.branch || this.driver.cfg()['branch'] || this.driver.defaults()?.effective.branch || 'the branch');
  }

  // "Pushed 3 fixes to a11y-508; waiting for your deployment (pushed 11:51 AM, checked 2:31 PM: still the old build)",
  // and while fixes are held for the next push: "…; 2 more fixes are ready and go out with the next push".
  private waiting(): string {
    const w: Record<string, any> = this.store.deployWait() || {};
    const d = this.driver.ledger()?.deploy;
    const n = Number(w['pending'] ?? this.ledgerCounts()['pending'] ?? 0);
    const pushed = w['pushed'] ?? d?.pushed;
    const at = clockOf(w['pushedAt'] || d?.pushedAt);
    const check = this.store.deployCheck();
    let checked = 'not checked yet';
    if (check) {
      const r = check['result'];
      const what = r === 'changed' ? 'the new build is live' : r === 'unreadable' ? 'the start page could not be read' : r === 'no-baseline' ? 'no earlier build on record' : 'still the old build';
      checked = `checked ${clockOf(check['at']) || 'just now'}: ${what}`;
    }
    const when = [pushed && at ? `pushed ${at}` : '', checked].filter(Boolean).join(', ');
    const held = Number(this.ledgerCounts()['held'] || 0);
    const more = held ? `; ${held} more ${held === 1 ? 'fix is ready and goes' : 'fixes are ready and go'} out with the next push` : '';
    return `${pushed ? 'Pushed' : 'Committed'} ${plural(n, 'fix', 'fixes')} ${pushed ? 'to' : 'on'} ${this.branch()}; waiting for your deployment (${when})${more}`;
  }

  // A PDF run, as it goes (docs/plans/manual-findings.md).
  private manualNow(): string {
    const m = this.store.manual();
    const who = this.assistant();
    const ev = m.last || {};
    const n = (k: string) => Number(ev[k]) || 0;
    // A run from screenshots (docs/plans/screenshots-in.md AC 5) says so where a PDF run says "the PDF".
    const shots = m.source === 'screenshots';
    const theSource = shots ? 'the screenshots' : 'the PDF';
    // Taken up again after the dashboard was closed: said until the run is back at its own stage.
    const o = this.store.origin();
    if (o && o.type === 'rerun' && [null, 'start', 'parsed', 'findings', 'already-fixed'].includes(m.stage)) return continuingPdf(o['stage'], shots);
    if (shots && m.stage === 'read' && m.candidates) return `Reading ${plural(m.candidates.pages, 'screenshot')}; asking the assistant what each shows.`;
    if (shots && m.stage === 'parsed' && m.parsed) return `Reading ${plural(m.parsed.pages, 'screenshot')}.`;
    switch (m.stage) {
      case null:
      case 'start':
        return shots ? 'Reading the screenshots' : 'Reading the PDF';
      // The parse (docs/plans/pdf-parse.md AC 8/9): the first pass's count, then the assistant reads the parse.
      case 'parse':
      case 'parsed': {
        const p = m.parse || (m.parsed ? { pages: m.parsed.pages, withPictures: m.parsed.withPictures } : null);
        return p ? `Reading the PDF: ${plural(p.pages, 'page')} (${p.withPictures} with pictures).` : 'Reading the PDF';
      }
      // The site, looked over before the assistant is asked (docs/plans/manual-crawl-first.md AC 4): the
      // pages found so far, from the crawl's page events.
      case 'crawl': {
        const found = m.crawl?.found || 0;
        return `Looking over the deployed site so the tool knows its pages${found ? ` (${found} found so far)` : ''}.`;
      }
      case 'read':
        if (m.noText) return `The PDF has no text; the assistant is working from the pictures of its ${plural(m.parsed?.pages || n('pages'), 'page')}.`;
        return m.candidates ? `Reading the PDF: ${plural(m.candidates.findings, 'finding')} on ${plural(m.candidates.pages, 'page')}; asking the assistant what each page shows.` : `Reading the PDF with ${who}`;
      case 'read-again': {
        const why = m.readAgain || '';
        if (ev['unopened']) return `The assistant ${why.slice(3)}; asking it again to look at ${(ev['missing'] || []).length === 1 ? 'that picture' : 'those pictures'}.`;
        if (/^it did not answer for /.test(why)) return `The assistant ${why.slice(3)}; asking it again for ${(ev['missing'] || []).length === 1 ? 'that page' : 'those pages'}.`;
        return !why || why === 'its answer had no list of findings' ? "The assistant's answer had no list of findings; asking it again." : `The assistant could not read ${theSource} (${why}); asking it again.`;
      }
      case 'locate':
        return `The tool could not find ${plural(n('count'), 'element')} on the deployed site; asking ${who} where ${n('count') === 1 ? 'it is' : 'they are'}`;
      case 'findings':
        if (ev['message']) return String(ev['message']);
        return `Checking the deployed site for ${plural(m.findings || 0, 'finding')} from ${theSource}`;
      case 'check':
        return `Checking the deployed site for ${plural(m.findings || 0, 'finding')} from ${theSource}`;
      case 'capture':
        return ev['label'] === 'before' ? `Checking the deployed site for ${plural(m.findings || n('m'), 'finding')} from ${theSource} (${n('n')} of ${n('m')})` : `Checking the deployed site for ${plural(n('m'), 'fix', 'fixes')} (${n('n')} of ${n('m')})`;
      case 'judge':
        return `Asking ${who} which findings the deployed site still has`;
      case 'already-fixed':
      case 'planning':
        return `Writing the plan with ${who}`;
      case 'plan':
      case 'review':
      case 'approve-refused': {
        const held = m.plan?.reason === 'revised' ? m.plan.notHeld : 0;
        return held ? `${plural(held, 'fix', 'fixes')} did not hold in the deployed site after two tries. Review the revised plan.` : 'Approve the plan to start fixing, or edit an item and send it to the assistant.';
      }
      case 'confirming':
        return `Asking ${who} to confirm your ${n('count') === 1 ? 'change' : 'changes'}`;
      case 'approved':
        return 'Approved: starting the fixes';
      case 'fix':
        return `Fixing ${short(String(ev['title'] || ev['finding'] || ''))} (${n('n')} of ${n('m')})${n('attempt') > 1 ? ' again' : ''} with ${who}`;
      case 'gate':
        return `Checking the fix: ${String(ev['check'] || '')}`;
      case 'commit':
        return `Committed the fix for ${String(ev['finding'] || '')}`;
      case 'push':
        return `Pushing ${plural(n('committed'), 'fix', 'fixes')} to ${String(ev['branch'] || 'the branch')}`;
      case 'deploy':
      case 'await-deploy':
      case 'deploy-check': {
        const c = m.deployCheck;
        const checked = c ? `checked ${clockOf(c['at']) || 'just now'}: ${c['result'] === 'changed' ? 'the new build is live' : c['result'] === 'unreadable' ? 'the start page could not be read' : 'still the old build'}` : 'not checked yet';
        const w = m.deployWait || {};
        return `Pushed ${plural(Number(w['committed']) || m.commits, 'fix', 'fixes')} to ${String(w['branch'] || 'the branch')}; waiting for your deployment (${checked})`;
      }
      case 'verify':
        return `Checking the deployed site for ${plural(n('count'), 'fix', 'fixes')}`;
      case 'verdicts': {
        const not = (ev['items'] || []).filter((v: any) => v.verdict !== 'fixed').length;
        return not ? `${plural(not, 'fix', 'fixes')} did not hold in the deployed site` : 'Every fix holds in the deployed site';
      }
      case 'retry':
        return `${plural(n('count'), 'fix', 'fixes')} did not hold in the deployed site; fixing ${n('count') === 1 ? 'it' : 'them'} again`;
      case 'replanning':
        return `Writing a revised plan with ${who} for ${plural(n('count'), 'fix', 'fixes')} that did not hold`;
      default:
        return `Working on ${theSource} with ${who}`;
    }
  }

  private ended(): string {
    const s = this.store;
    const d = s.done()!;
    if (s.kind() === 'manual') {
      const m = s.manual();
      if (m.done) return m.done.message;
      if (m.noFindings) return m.noFindings;
      if ((d['rerun'] && !s.rerunWithdrawn()) || d['outcome'] === 'interrupted') return continuingPdf((d['rerun'] as Record<string, unknown> | undefined)?.['stage'], m.source === 'screenshots');
      if (d['outcome'] === 'stopped') return 'Stopped.';
      if (m.readFailed) return m.readFailed;
      if (m.parseFailed) return m.parseFailed;
      const errors = s.notices().filter((x) => x.level === 'error' && !/^The run failed( \(exit code|: )/.test(x.message)).map((x) => x.message);
      const pre = s.precondition();
      if (pre) return `Could not start: ${String(pre['message'] || '')}. ${String(pre['remedy'] || '')}`;
      return `Stopped: ${lowerFirst(plainReason(errors[errors.length - 1] || String(d['reason'] || `the ${m.source === 'screenshots' ? 'screenshots' : 'PDF'} run ended with exit code ${d['code']}`)).replace(/\.$/, ''))}`;
    }
    const r = s.retry();
    const now = this.tick();
    const errors = s.notices().filter((n) => n.level === 'error' && !/^The run failed( \(exit code|: )/.test(n.message)).map((n) => n.message);
    const reason = errors[errors.length - 1] || (d['reason'] ? String(d['reason']) : '');
    if (d['outcome'] === 'interrupted') return this.loopKind() ? 'The fix loop was interrupted (the dashboard was closed); continuing from there' : 'The crawl was interrupted (the dashboard was closed); running it again';
    if (r && r.firedAt && !r.cancelled) return 'Trying again…';
    if (r && !r.cancelled) {
      const pre = s.precondition();
      if (r.kind === 'precondition') return `Could not start yet: ${String(pre?.['message'] || r.reason || '')}. ${String(pre?.['remedy'] || '').replace(/\.?$/, '.')} This starts by itself once that is done.`.replace(/ \. /, ' ');
      if (r.kind === 'wait') return /updated/.test(r.reason || '') ? `Restarting: ${r.reason}` : `Waiting for your deployment: ${r.reason || 'the new build has not arrived yet'}`;
      const secs = Math.max(0, (Date.parse(r.at) || now) - now);
      return `Trying again in ${span(secs)}: ${lowerFirst(plainReason(r.reason || reason || `the loop ended with exit code ${d['code']}`).replace(/\.$/, ''))}`;
    }
    if (d['outcome'] === 'stopped' || (r && r.cancelled)) return 'Stopped';
    if (!this.loopKind()) {
      const sum = s.summary()?.['summary'];
      if (s.cannotGetIn()) return `Could not get into ${this.host()}${s.bouncedToSignIn() ? ': it sent the crawler to a sign-in page' : ''}`;
      if (sum) {
        const found = (sum.violations || 0) + (sum.reviews || 0);
        const why = this.driver.whyNoFix();
        return `Done: crawled ${plural(sum.audited ?? s.pages().length, 'page')}, ${plural(found, 'finding')}${why ? `; nothing was fixed: ${why}` : ''}`;
      }
      if (d['outcome'] === 'error') return `The crawl failed: ${lowerFirst(plainReason(reason || `exit code ${d['code']}`).replace(/\.$/, ''))}`;
      return 'Done';
    }
    if (d['outcome'] === 'error' || errors.length) return `Stopped: ${lowerFirst(plainReason(reason || `the loop ended with exit code ${d['code']}`).replace(/\.$/, ''))}`;
    const c = this.ledgerCounts();
    const fixed = (c['verified'] || 0) + (c['pending'] || 0);
    const left = (c['open'] || 0) + (c['skipped'] || 0) + (c['review'] || 0);
    if (!fixed && !left) return 'Done: nothing to fix';
    return `Done: ${fixed} fixed${left ? `, ${left} could not be fixed` : ''}`;
  }
}
