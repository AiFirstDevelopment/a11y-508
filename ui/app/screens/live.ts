import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RunStore } from '../core/run.store';
import { phaseText, resultWord, routeParts } from '../core/format';
import { detailsOpen, setDetailsOpen } from '../core/details';
import { RunView } from '../shared/run-view';
import { SignInWait } from '../shared/sign-in-wait';
import { EnvStore } from '../core/env.store';
import { Starter } from '../core/starter';
import { SIGN_IN_HEADLINE, plainReason, signInFailed } from '../core/outcome';

@Component({
  selector: 'app-live-screen',
  imports: [RunView, RouterLink, SignInWait],
  template: `
    <h1>Crawl</h1>
    @if (!store.run()) {
      <p data-testid="no-run">No run in this directory yet. <a routerLink="/run">Start one</a>.</p>
    } @else {
      <!-- What it is doing, in one line; counts, not details. -->
      <p class="big-status" role="status" data-testid="crawl-status">{{ bigStatus() }}</p>
      @if (originLine(); as o) { <p class="hint" data-testid="crawl-origin">{{ o }}</p> }
      @if (store.loginWaiting() && store.active()) {
        <app-sign-in-wait testId="crawl-login-waiting" />
      }
      <!-- No "0 of 0 pages" for a crawl that ended before it found any page. -->
      @if (crawled()) {
        <div class="thin-progress">
          <progress aria-labelledby="crawl-pages" [value]="store.progress().done" [max]="store.progress().discovered || 1"></progress>
          <span id="crawl-pages" data-testid="crawl-pages">{{ store.progress().done }} of {{ store.progress().discovered }} pages</span>
        </div>
        <p data-testid="crawl-counts">{{ counts() }}</p>
      }
      <p class="hint" data-testid="crawl-elapsed">{{ elapsed() }}</p>
      @if (env.env()?.signIn === 'separate-window' && store.loginWaiting() && store.active()) {
        <p class="hint" data-testid="separate-window">The sign-in is in a separate browser window (Chrome was not found for the dashboard's own window).</p>
      }
      @if (signInError()) {
        <div class="notice error" role="alert">{{ signInError() }}</div>
      }
      <!-- One big button: Stop while it runs; afterwards the step forward. -->
      <div class="actions">
        @if (store.active()) {
          <button type="button" class="big" (click)="stop()">Stop</button>
        } @else if (store.done()) {
          @switch (next()) {
            @case ('results') { <a class="button big" routerLink="/report" data-testid="see-results">See the results</a> }
            @case ('again') { <button type="button" class="big" (click)="again()" data-testid="crawl-run-again">Run again</button> }
          }
        }
      </div>
      <details class="details" data-testid="details" [open]="showDetails()" (toggle)="toggled($event)">
        <summary>Details<span class="visually-hidden"> of the crawl</span></summary>
        <p class="status" role="status" data-testid="run-status">{{ status() }}</p>
        @if (store.run()?.['command']; as cmd) {
          <p class="hint">Running <code data-testid="run-command">{{ cmd }}</code></p>
        }
        <app-run-view />
      </details>
    }
  `,
})
export class LiveScreen implements OnDestroy {
  readonly store = inject(RunStore);
  private starter = inject(Starter);
  readonly env = inject(EnvStore);
  readonly signInError = signal('');
  // Details (the command, the chart, the pages table, notices, raw output): closed by default.
  readonly showDetails = signal(detailsOpen('crawl'));
  readonly now = signal(Date.now());
  private ticker = setInterval(() => this.now.set(Date.now()), 1000);

  ngOnDestroy(): void {
    clearInterval(this.ticker);
  }

  toggled(e: Event): void {
    const open = (e.target as HTMLDetailsElement).open;
    this.showDetails.set(open);
    setDetailsOpen('crawl', open);
  }

  // Violations and review items: the pages' so far, and once the crawl is done the site-wide
  // ones too (the summary's totals), named as such, so this line and the Done line agree.
  readonly totals = computed(() => {
    const t = this.store.pages().reduce((a, p) => ({ v: a.v + p.violations, r: a.r + p.reviews }), { v: 0, r: 0 });
    const sum = this.store.summary()?.['summary'];
    if (!sum) return { v: t.v, r: t.r, sv: 0, sr: 0 };
    const v = sum.violations ?? t.v;
    const r = sum.reviews ?? t.r;
    return { v, r, sv: Math.max(0, v - t.v), sr: Math.max(0, r - t.r) };
  });
  readonly counts = computed(() => {
    const t = this.totals();
    return `${t.v} violation${t.v === 1 ? '' : 's'}${t.sv ? `, ${t.sv} site-wide` : ''} · ${t.r} to review${t.sr ? `, ${t.sr} site-wide` : ''}`;
  });
  readonly elapsed = computed(() => {
    const t0 = this.store.startedAt();
    if (!t0) return '';
    const end = this.store.done() ? Date.parse(String(this.store.done()!['at'])) || this.now() : this.now();
    const s = Math.max(0, Math.round((end - t0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} elapsed`;
  });
  // The one line: starting, the sign-in wait, the page being analyzed and its phase, or how it ended.
  readonly bigStatus = computed(() => {
    const st = this.store;
    const d = st.done();
    if (d) {
      if (d['outcome'] === 'stopped') return 'Stopped';
      if (st.cannotGetIn() && !st.pages().some((p) => !p.error && !p.skipped)) return st.bouncedToSignIn() ? 'The crawler could not get into the app: it was sent to a sign-in page.' : 'The crawler could not get into the app.';
      const s = st.summary();
      if (s) {
        const sum = s['summary'] || {};
        return `Done: ${sum.audited ?? st.pages().length} pages · ${this.counts()}`;
      }
      if (signInFailed([...this.errors(), d['reason'] as string])) return SIGN_IN_HEADLINE;
      if (d['outcome'] === 'error') return this.errors().length || d['reason'] ? plainReason(this.errors().at(-1) || String(d['reason'])) : `The crawl failed (exit code ${d['code']}).`;
      return 'Done';
    }
    if (st.stopping()) return 'Stopping…';
    const since = st.loginWaitingSince();
    if (st.loginWaiting() && since && st.origin()?.type === 'sign-in-again') return 'Your sign-in expired: sign in in the tab that opened, and the crawl runs again.';
    if (st.loginWaiting() && since) {
      const s = Math.max(0, Math.round((this.now() - since) / 1000));
      return this.env.env()?.signIn === 'tab' ? `Sign in in the tab that just opened · ${s} s` : `Waiting for you to sign in in the browser window · ${s} s`;
    }
    const f = Object.values(st.inFlight()).sort((a, b) => b.receivedAt - a.receivedAt)[0];
    if (!f) {
      // Between pages, and between the sign-in and the first page: not "Starting the browser" again.
      const p = st.progress();
      if (st.pages().length) return `Next page · ${p.done} of ${p.discovered} done`;
      if (st.loginWaitingSince() || st.sessionSaved()) return 'Signed in · loading the first page';
      return 'Starting the browser';
    }
    const path = routeParts(f.url).path;
    const dd = f.detail || {};
    const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US');
    switch (f.phase) {
      case 'loading': return `Loading ${path}`;
      case 'search': return phaseText(f);
      case 'checks': return `Analyzing ${path} · ${n(dd['elements'])} elements`;
      case 'keyboard': return `Analyzing ${path} · keyboard pass ${n(dd['stops'])} of ${n(dd['of'])}`;
      default: return `Analyzing ${path} · ${phaseText(f).replace(/^./, (c) => c.toLowerCase())}`;
    }
  });

  readonly crawled = computed(() => !this.store.done() || this.store.pages().length > 0 || this.store.progress().discovered > 0);
  // The errors the CLI said, without the dashboard's own "The run failed" wrapper.
  private readonly errors = computed(() => this.store.notices().filter((n) => n.level === 'error' && !/^The run failed( \(exit code|: )/.test(n.message)).map((n) => n.message));
  // The step forward once the crawl has ended: its results, or another crawl. (A crawl sent to a
  // sign-in page signs in and runs again by itself; one interrupted runs again by itself.)
  readonly next = computed<'results' | 'again' | null>(() => {
    const d = this.store.done();
    if (!d || d['outcome'] === 'interrupted') return null;
    if (this.store.summary() && !this.store.cannotGetIn()) return 'results';
    return 'again';
  });
  // How this crawl came to be when the tool started it by itself.
  readonly originLine = computed(() => {
    const o = this.store.origin();
    if (this.store.done()?.['outcome'] === 'interrupted') return 'The crawl was interrupted (the dashboard was closed); running it again.';
    if (!o) return '';
    if (o.type === 'rerun') return 'The crawl was interrupted (the dashboard was closed); running it again.';
    if (o.type === 'sign-in-again' && this.store.active() && !this.store.loginWaiting()) return 'Signed in again; crawling.';
    return '';
  });
  async again(): Promise<void> {
    this.signInError.set('');
    try {
      await this.starter.startCrawl();
    } catch (e: any) {
      this.signInError.set(e.message);
    }
  }

  readonly status = computed(() => {
    const d = this.store.done();
    const s = this.store.summary();
    if (this.store.stopping() && !d) return 'Stopping…';
    if (!d && this.store.loginWaiting()) return `Sign in on the tab that opened in Chrome${this.store.loginWaitingHost() ? ` (${this.store.loginWaitingHost()})` : ''}.`;
    if (!d) return `Running: ${this.store.kind()}`;
    if (d['outcome'] === 'stopped') return 'Stopped';
    if (s) return `Finished: ${resultWord(s['result'])}`;
    if (d['outcome'] === 'error') return `Failed (exit code ${d['code']})`;
    return 'Finished';
  });

  async stop(): Promise<void> {
    await this.store.stop();
  }
}
