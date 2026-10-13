import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { phaseText, resultWord, routeParts } from '../core/format';
import { detailsOpen, setDetailsOpen } from '../core/details';
import { RunView } from '../shared/run-view';
import { SignInFlow } from '../core/sign-in';
import { EnvStore } from '../core/env.store';

@Component({
  selector: 'app-live-screen',
  imports: [RunView, RouterLink],
  template: `
    <h1>Crawl</h1>
    @if (!store.run()) {
      <p data-testid="no-run">No run in this directory yet. <a routerLink="/run">Start one</a>.</p>
    } @else {
      <!-- What it is doing, in one line; counts, not details. -->
      <p class="big-status" role="status" data-testid="crawl-status">{{ bigStatus() }}</p>
      <div class="thin-progress">
        <progress aria-labelledby="crawl-pages" [value]="store.progress().done" [max]="store.progress().discovered || 1"></progress>
        <span id="crawl-pages" data-testid="crawl-pages">{{ store.progress().done }} of {{ store.progress().discovered }} pages</span>
      </div>
      <p data-testid="crawl-counts">{{ counts() }}</p>
      <p class="hint" data-testid="crawl-elapsed">{{ elapsed() }}</p>
      @if (env.env()?.signIn === 'separate-window' && store.loginWaiting() && store.active()) {
        <p class="hint" data-testid="separate-window">The sign-in is in a separate browser window (Chrome was not found for the dashboard's own window).</p>
      }
      @if (signInError()) {
        <div class="notice error" role="alert">{{ signInError() }}</div>
      }
      <div class="actions">
        <button type="button" class="big" (click)="stop()" [disabled]="!store.active()">Stop</button>
      </div>
      @if (store.cannotGetIn()) {
        <div class="notice error" role="alert" data-notice="cannot-get-in">
          <p>The crawler could not get into the app.</p>
          @if (store.bouncedToSignIn()) {
            <p>The app sent the crawler to a sign-in page. Sign in, and the crawl runs again in the signed-in window.</p>
          }
          <div class="actions">
            @if (store.bouncedToSignIn()) {
              <button type="button" (click)="signIn()">Sign in</button>
            }
            <button type="button" [class.secondary]="store.bouncedToSignIn()" (click)="troubleshoot()">Troubleshoot with these settings</button>
          </div>
        </div>
      }
      <details class="details" data-testid="details" [open]="showDetails()" (toggle)="toggled($event)">
        <summary>Details<span class="visually-hidden"> of the crawl</span></summary>
        <p class="status" role="status" data-testid="run-status">{{ status() }}</p>
        @if (store.run()?.['command']; as cmd) {
          <p class="hint">Running <code data-testid="run-command">{{ cmd }}</code></p>
        }
        @if (store.done() && store.summary()) {
          <p><a class="button secondary" routerLink="/report">Open the report</a></p>
        }
        <app-run-view />
      </details>
    }
  `,
})
export class LiveScreen implements OnDestroy {
  readonly store = inject(RunStore);
  private form = inject(FormStore);
  private router = inject(Router);
  private flow = inject(SignInFlow);
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
      const s = st.summary();
      if (s) {
        const sum = s['summary'] || {};
        return `Done: ${sum.audited ?? st.pages().length} pages · ${this.counts()}`;
      }
      return d['outcome'] === 'error' ? `Failed (exit code ${d['code']})` : 'Done';
    }
    if (st.stopping()) return 'Stopping…';
    const since = st.loginWaitingSince();
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
      case 'screenshots': return `Taking screenshots · ${n(dd['done'])} of ${n(dd['of'])}`;
      case 'loading': return `Loading ${path}`;
      case 'checks': return `Analyzing ${path} · ${n(dd['elements'])} elements`;
      case 'keyboard': return `Analyzing ${path} · keyboard pass ${n(dd['stops'])} of ${n(dd['of'])}`;
      default: return `Analyzing ${path} · ${phaseText(f).replace(/^./, (c) => c.toLowerCase())}`;
    }
  });

  readonly status = computed(() => {
    const d = this.store.done();
    const s = this.store.summary();
    if (this.store.stopping() && !d) return 'Stopping…';
    if (!d && this.store.loginWaiting()) return 'A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded.';
    if (!d) return `Running: ${this.store.kind()}`;
    if (d['outcome'] === 'stopped') return 'Stopped';
    if (s) return `Finished: ${resultWord(s['result'])}`;
    if (d['outcome'] === 'error') return `Failed (exit code ${d['code']})`;
    return 'Finished';
  });

  async stop(): Promise<void> {
    await this.store.stop();
  }

  // A new run that signs in and crawls in the same window; this screen follows it.
  async signIn(): Promise<void> {
    this.signInError.set('');
    try {
      await this.flow.start();
    } catch (e: any) {
      this.signInError.set(e.message);
    }
  }

  async troubleshoot(): Promise<void> {
    await this.store.start(this.form.body('troubleshoot'));
    this.form.clearToken();
    await this.router.navigateByUrl('/troubleshoot');
  }
}
