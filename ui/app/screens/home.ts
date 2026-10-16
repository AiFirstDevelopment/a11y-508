import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Driver } from '../core/driver';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { Starter } from '../core/starter';
import { continuingText } from '../core/resume';
import { plainReason } from '../core/outcome';
import { clockOf, countsLine, hostOf, lowerFirst, plural, span, upperFirst } from '../core/now';

// A finding's words, cut at a word once they are long.
function short(text: string, max = 72): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : max).replace(/[\s,;:.]+$/, '')}…`;
}

// The one screen (docs/plans/simple-screen.md): the folder and URL, one sentence of what is happening
// now, one line of numbers, one button (Start, or Stop while anything runs), and Diagnostics.
@Component({
  selector: 'app-home-screen',
  imports: [RouterLink],
  template: `
    <h1 class="app-name">a11y-508@if (env.env()?.revision; as rev) {{{ ' ' }}<span class="build" data-testid="build-revision" title="The commit this dashboard runs">build {{ rev }}</span> }</h1>
    @if (env.env(); as e) {
      <p class="place" data-testid="where">
        <span data-testid="folder" [attr.title]="e.cwd"><span class="visually-hidden">Folder: </span>{{ e.cwd }}</span>
        <span aria-hidden="true"> · </span>
        <span data-testid="url"><span class="visually-hidden">URL: </span>{{ driver.url() || 'no URL yet' }}</span>
      </p>
    }
    <p class="big-status" role="status" data-testid="now">{{ now() }}</p>
    @if (counts(); as c) { <p data-testid="counts">{{ c }}</p> }
    <div class="actions">
      @if (running()) {
        <button type="button" class="big" data-testid="go" (click)="driver.stop()" [disabled]="driver.starting() && !store.active()">Stop</button>
      } @else {
        <button type="button" class="big" data-testid="go" (click)="driver.start()" [disabled]="!driver.url()">Start</button>
      }
      @if (signingIn()) {
        <button type="button" class="secondary" data-testid="show-sign-in-tab" (click)="showSignIn()">Show the sign-in tab</button>
      }
    </div>
    @if (driver.error() || missed()) { <p class="notice error" role="alert" data-testid="start-error">{{ driver.error() || missed() }}</p> }
    <p class="diagnostics-link"><a routerLink="/diagnostics" data-testid="diagnostics-link">Diagnostics</a></p>
  `,
  styles: [`
    .place { overflow-wrap: anywhere; color: var(--muted); }
    .app-name .build { font-size: 0.5em; font-weight: normal; color: var(--muted); }
  `],
})
export class HomeScreen implements OnDestroy {
  readonly env = inject(EnvStore);
  readonly store = inject(RunStore);
  readonly driver = inject(Driver);
  private api = inject(Api);
  private starter = inject(Starter);
  readonly missed = signal('');
  private tick = signal(Date.now());
  private ticker = setInterval(() => this.tick.set(Date.now()), 1000);

  constructor() {
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

  // Anything running, about to run again, or being started: the button is Stop.
  readonly running = computed(() => {
    const s = this.store;
    const r = s.retry();
    return s.active() || s.retryPending() || (!!s.done() && (s.done()!['outcome'] === 'interrupted' || (!!r && !!r.firedAt && !r.cancelled))) || this.driver.starting();
  });
  readonly signingIn = computed(() => this.store.loginWaiting() && this.store.active());

  async showSignIn(): Promise<void> {
    this.missed.set('');
    try {
      await this.api.post('/api/sign-in/show');
    } catch {
      this.missed.set('The sign-in tab could not be brought forward. Look for it in your Chrome windows.');
    }
  }

  // The ledger's counts, live while the loop runs; a crawl alone has only what it found.
  readonly counts = computed(() => {
    const live = this.store.ledger()?.['counts'] as Record<string, number> | undefined;
    const c = live || this.driver.ledger()?.counts;
    const ended = this.loopKind() && !!this.store.done() && !this.running();
    if (c && Object.keys(c).length) return countsLine(c, ended);
    // A crawl under way, with no ledger yet: what it has found so far, never an older report's total.
    if (this.store.active()) {
      const so = this.store.pages().reduce((a, p) => a + (p.violations || 0) + (p.reviews || 0), 0);
      return so ? `${so} found` : '';
    }
    const sum = this.store.kind() === 'crawl' ? this.store.summary()?.['summary'] : null;
    const r = this.env.env()?.report;
    const found = sum ? (sum.violations || 0) + (sum.reviews || 0) : r?.exists ? (r.violations || 0) + (r.reviews || 0) : 0;
    return found ? `${found} found` : '';
  });

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

  // "Pushed 3 fixes to a11y-508; waiting for your deployment (pushed 11:51 AM, checked 2:31 PM: still the old build)"
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
    return `${pushed ? 'Pushed' : 'Committed'} ${plural(n, 'fix', 'fixes')} ${pushed ? 'to' : 'on'} ${this.branch()}; waiting for your deployment (${when})`;
  }

  private ended(): string {
    const s = this.store;
    const d = s.done()!;
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
