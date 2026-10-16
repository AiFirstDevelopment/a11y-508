import { Component, ElementRef, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Api } from './core/api';
import { EnvStore, rememberCwd, rememberedCwd } from './core/env.store';
import { RunStore } from './core/run.store';
import { FormStore } from './core/form.store';
import { FolderPicker } from './shared/folder-picker';
import { SetupForm } from './shared/setup-form';
import { BrowserNotice } from './shared/browser-notice';
import { Resume } from './core/resume';
import { Starter } from './core/starter';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, FolderPicker, SetupForm, BrowserNotice],
  template: `
    <a class="skip" href="#main">Skip to main content</a>
    <app-folder-picker />
    <main id="main" tabindex="-1">
      <app-browser-notice />
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
        <p class="hint">Choose the app's repository and its URL. Start crawls the app and fixes what it finds; a sign-in opens in a tab when the app asks for one.</p>
        <app-setup-form idPrefix="setup-" (started)="closeSetup()" />
      }
    </dialog>
  `,
})
export class App implements OnInit {
  readonly env = inject(EnvStore);
  private run = inject(RunStore);
  private api = inject(Api);
  private starter = inject(Starter);
  private setupDialog = viewChild.required<ElementRef<HTMLDialogElement>>('setup');
  readonly ready = signal(false);
  readonly setupOpen = signal(false);
  private resume = inject(Resume);

  constructor() {
    // The environment is read again after any run, so the screens know what exists now.
    let seen: string | null = null;
    effect(() => {
      const d = this.run.done();
      const id = d ? String(this.run.run()?.['id'] || '') : null;
      untracked(() => {
        if (!d || id === seen) return;
        seen = id;
        void this.env.load();
      });
    });
    // Set up, asked for (nothing to crawl yet; Change folder or URL on Diagnostics).
    let asked = this.starter.setupRequests();
    effect(() => {
      const n = this.starter.setupRequests();
      untracked(() => {
        if (n === asked) return;
        asked = n;
        this.openSetup();
      });
    });
  }

  private openSetup(): void {
    this.setupOpen.set(true);
    setTimeout(() => {
      const d = this.setupDialog().nativeElement;
      if (!d.open) d.showModal();
      (d.querySelector('input') as HTMLInputElement | null)?.focus();
    });
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
    const serverKnows = !!e.restored || (!!e.last?.cwd && e.last.cwd === e.cwd) || !!e.lastStep || !!e.run;
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
    this.resume.heartbeat();
    if (needSetup) this.openSetup();
  }
}
