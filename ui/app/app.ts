import { Component, ElementRef, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { Api } from './core/api';
import { EnvStore, rememberCwd, rememberedCwd } from './core/env.store';
import { RunStore } from './core/run.store';
import { FormStore } from './core/form.store';
import { Starter } from './core/starter';
import { FolderPicker } from './shared/folder-picker';
import { SetupForm } from './shared/setup-form';

interface Step {
  n: number;
  label: string;
  path: string;
}

// The workflow, as a wizard: Set up → Crawl → Results → Fix → History.
export const STEPS: Step[] = [
  { n: 1, label: 'Set up', path: '/run' },
  { n: 2, label: 'Crawl', path: '/live' },
  { n: 3, label: 'Results', path: '/report' },
  { n: 4, label: 'Fix', path: '/fix-loop' },
  { n: 5, label: 'History', path: '/history' },
];

// A viewer's choice to stay on the Crawl step when a crawl finishes (a per-viewer setting).
function stayOnCrawl(): boolean {
  try {
    return localStorage.getItem('a11y508.stayOnCrawl') === '1';
  } catch {
    return false;
  }
}

// The step a route belongs to (troubleshooting is part of the crawl; the sign-in route of set up).
export function stepOf(url: string): number {
  const p = url.split(/[?#]/)[0];
  if (p.startsWith('/live') || p.startsWith('/troubleshoot')) return 2;
  if (p.startsWith('/report')) return 3;
  if (p.startsWith('/fix-loop') || p.startsWith('/review')) return 4;
  if (p.startsWith('/history')) return 5;
  return 1;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, FolderPicker, SetupForm],
  template: `
    <a class="skip" href="#main">Skip to main content</a>
    <header class="top">
      <p class="brand">a11y-508 <span>dashboard</span></p>
      <nav aria-label="Steps" data-testid="steps">
        <ol class="steps">
          @for (s of steps; track s.n) {
            @let st = stateOf(s);
            <li [class]="'step ' + st">
              @if (st !== 'disabled') {
                <a [routerLink]="s.path" [attr.aria-current]="st === 'current' ? 'step' : null" [attr.data-step]="s.label">
                  <span class="num" aria-hidden="true">{{ st === 'done' ? '✓' : s.n }}</span> {{ s.label }}@if (st === 'done') {<span class="visually-hidden"> (done)</span>}
                </a>
              } @else {
                <span aria-disabled="true" [attr.data-step]="s.label"><span class="num" aria-hidden="true">{{ s.n }}</span> {{ s.label }}<span class="visually-hidden"> (not available yet)</span></span>
              }
            </li>
          }
        </ol>
      </nav>
      <!-- Where the steps after Set up work: the app's repository folder and its URL, each a way back to Set up. -->
      @if (current() !== 1 && env.env(); as e) {
        <p class="context" data-testid="context">
          <a routerLink="/run" data-testid="cwd" [attr.title]="e.cwd"><span aria-hidden="true">{{ folderName(e.cwd) }}</span><span class="visually-hidden">App's repository folder: {{ e.cwd }}</span></a>
          @if (form.url().trim()) {
            <span aria-hidden="true"> · </span><a routerLink="/run" data-testid="context-url" [attr.title]="form.url()"><span class="visually-hidden">Start URL: </span>{{ shortUrl(form.url()) }}</a>
          }
        </p>
      }
    </header>
    <app-folder-picker />
    <main id="main" tabindex="-1">
      @if (env.error()) {
        <div class="notice error" role="alert">{{ env.error() }}</div>
      }
      @if (env.env()?.build?.fresh === false) {
        <div class="notice warn" role="status">{{ env.env()?.build?.reason }}</div>
      }
      @if (env.env()?.legacy?.length) {
        <div class="notice warn" role="region" aria-labelledby="legacy-h" data-testid="legacy">
          <p id="legacy-h">Move the dashboard's files out of this repository? ({{ env.env()!.legacy!.join(', ') }})</p>
          <div class="actions">
            <button type="button" (click)="migrate(true)">Move</button>
            <button type="button" class="secondary" (click)="migrate(false)">Leave</button>
          </div>
        </div>
      }
      @if (ready()) {
        <router-outlet />
      } @else {
        <!-- Never a blank screen: what the dashboard is waiting for, and after a while a way to try again. -->
        <section class="startup" data-testid="startup" aria-labelledby="startup-h">
          <h1 id="startup-h">Loading…</h1>
          <p role="status" data-testid="startup-note">{{ waited() >= 3 ? 'Still waiting: ' + waitingOn() + '…' : '' }}</p>
          @if (waited() >= 15 || env.error()) {
            <button type="button" (click)="retry()" data-testid="startup-retry">Retry</button>
          }
        </section>
      }
    </main>
    <dialog #setup class="setup" aria-labelledby="setup-h" data-testid="setup-dialog" (cancel)="onCancel($event)">
      @if (setupOpen()) {
        <h2 id="setup-h">Set up</h2>
        <p class="hint">Choose the app's repository and its URL; Start opens a browser window to sign in in, and the crawl runs there.</p>
        <app-setup-form idPrefix="setup-" (started)="closeSetup()" />
      }
    </dialog>
  `,
})
export class App implements OnInit {
  readonly env = inject(EnvStore);
  private run = inject(RunStore);
  private api = inject(Api);
  private router = inject(Router);
  private setupDialog = viewChild.required<ElementRef<HTMLDialogElement>>('setup');
  readonly steps = STEPS;
  readonly ready = signal(false);
  readonly setupOpen = signal(false);
  private url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map((e) => (e as NavigationEnd).urlAfterRedirects), startWith(this.router.url)), { initialValue: '/' });
  readonly current = computed(() => stepOf(this.url()));
  private crawlRunning = computed(() => this.run.active() && ['crawl', 'troubleshoot', 'login'].includes(this.run.kind() || ''));
  private hasReport = computed(() => !!this.env.env()?.report?.exists || (!!this.run.summary() && this.run.kind() === 'crawl'));
  // Which steps make sense now: Set up always; Crawl once a crawl ran; Results, Fix and History
  // not while a crawl runs, and only once there is something to show (Fix: in a repository).
  readonly enabled = computed(() => {
    const e = this.env.env();
    const running = this.crawlRunning();
    const crawled = this.hasReport() || ['crawl', 'troubleshoot', 'login'].includes(this.run.kind() || '');
    return {
      1: true,
      2: crawled,
      3: !running && this.hasReport(),
      4: !running && this.hasReport() && !!e?.inGitRepo,
      5: !running && ((e?.pastRuns || 0) > 0 || this.hasReport()),
    } as Record<number, boolean>;
  });

  stateOf(s: Step): 'current' | 'done' | 'upcoming' | 'disabled' {
    if (s.n === this.current()) return 'current';
    if (!this.enabled()[s.n]) return 'disabled';
    return s.n < this.current() ? 'done' : 'upcoming';
  }

  private starter = inject(Starter);
  constructor() {
    // Where Set up's Continue returns to: the later step the person was on.
    effect(() => {
      const u = this.url();
      untracked(() => {
        if (u.startsWith('/fix-loop')) this.starter.lastStep.set('/fix-loop');
        else if (u.startsWith('/report')) this.starter.lastStep.set('/report');
      });
    });
    // A crawl that finishes while its Crawl step is open moves on to Results by itself (one that
    // could not get in stays, with its notice and Troubleshoot). The environment is read again
    // after any run, so the steps know what exists now.
    let seen: string | null = null;
    // Runs watched while they ran (a finished run replayed on load does not move anything).
    const watched = new Set<string>();
    effect(() => {
      if (this.run.active()) watched.add(String(this.run.run()?.['id'] || ''));
    });
    effect(() => {
      const d = this.run.done();
      const id = d ? String(this.run.run()?.['id'] || '') : null;
      untracked(() => {
        if (!d || id === seen) return;
        seen = id;
        void this.env.load();
        if (!watched.has(id!)) return;
        if (!stayOnCrawl() && this.run.kind() === 'crawl' && d['outcome'] !== 'stopped' && !this.run.cannotGetIn() && this.run.summary() && stepOf(this.router.url) === 2 && !this.router.url.startsWith('/troubleshoot')) {
          void this.router.navigateByUrl('/report');
        }
      });
    });
  }

  // The folder's own name (the full path is in the tooltip and the accessible text).
  folderName(p: string): string {
    return p.split(/[\\/]/).filter(Boolean).pop() || p;
  }
  // The URL without its scheme, shortened from the right.
  shortUrl(u: string): string {
    const s = u.trim().replace(/^https?:\/\//, '');
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
  }

  // Startup: how long it has waited, and on what.
  private startedAt = signal(Date.now());
  private tick = signal(Date.now());
  readonly waited = computed(() => Math.floor((this.tick() - this.startedAt()) / 1000));
  readonly waitingOn = signal('reading the working directory');

  retry(): void {
    void this.start();
  }

  async migrate(move: boolean): Promise<void> {
    try {
      await this.api.post('/api/migrate', { move });
    } catch {}
    await this.env.load();
  }

  // Escape does nothing while the folder or the URL is still empty.
  readonly form = inject(FormStore);
  onCancel(e: Event): void {
    if (!this.form.url().trim() || !this.env.cwd()) e.preventDefault();
    else this.setupOpen.set(false);
  }

  closeSetup(): void {
    this.setupOpen.set(false);
    this.setupDialog().nativeElement.close();
  }

  async ngOnInit(): Promise<void> {
    await this.start();
  }

  private starting = 0;
  async start(): Promise<void> {
    const n = ++this.starting;
    this.startedAt.set(Date.now());
    this.tick.set(Date.now());
    const ticker = setInterval(() => this.tick.set(Date.now()), 500);
    try {
      await this.startIn(n);
    } finally {
      clearInterval(ticker);
    }
  }

  private async startIn(n: number): Promise<void> {
    this.waitingOn.set('reading the working directory');
    let e = await this.env.load();
    if (n !== this.starting) return;
    if (!e) return; // the error notice and Retry are shown
    // The folder: the server's memory first (it starts in the folder chosen last time), then this
    // browser's, if it still exists; else the setup dialog (a folder that already holds the tool's
    // files is taken as the choice).
    const remembered = rememberedCwd();
    const serverKnows = !!e.restored || (!!e.last?.cwd && e.last.cwd === e.cwd);
    let needSetup = false;
    if (serverKnows) {
      rememberCwd(e.cwd);
    } else if (remembered && remembered !== e.cwd) {
      this.waitingOn.set(`switching to ${remembered}`);
      try {
        e = await this.env.switchTo(remembered);
      } catch (err: any) {
        if (err?.status === 0) {
          this.env.error.set(`Could not switch to ${remembered}: ${err.message}.`);
          return;
        }
        if (err?.status !== 409) needSetup = true;
      }
    } else if (!remembered) {
      const f = e.cwdFacts || ({} as any);
      if (e.report?.exists || f.config || f.ledger || e.session?.exists || (e.pastRuns || 0) > 0) rememberCwd(e.cwd);
      else needSetup = true;
    }
    if (n !== this.starting) return;
    this.ready.set(true);
    if (e?.run) void this.run.connect();
    if (needSetup) {
      this.setupOpen.set(true);
      setTimeout(() => {
        const d = this.setupDialog().nativeElement;
        if (!d.open) d.showModal();
        (d.querySelector('input') as HTMLInputElement | null)?.focus();
      });
    }
  }
}
