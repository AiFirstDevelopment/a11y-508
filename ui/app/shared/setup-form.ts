import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { EnvStore } from '../core/env.store';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { Starter } from '../core/starter';

// Set up: the app's repository folder, the app's URL, and Start. On the Set up step (/run) and
// in the setup dialog on a first visit. A crawl needs neither git nor a package.json, so those
// are a warning line, not a block.
@Component({
  selector: 'app-setup-form',
  template: `
    <div class="field">
      <label [for]="ids + 'folder'">App's repository folder</label>
      <div class="inline">
        <input [id]="ids + 'folder'" type="text" data-testid="setup-folder" [value]="folder()" (input)="folder.set(val($event))" [attr.aria-describedby]="warning() ? ids + 'folder-warn' : null" />
        <button type="button" class="secondary small" (click)="browse()" [disabled]="run.active()">Browse…</button>
      </div>
      @if (warning()) {
        <p class="hint warn-text" [id]="ids + 'folder-warn'" data-testid="setup-warning">{{ warning() }}</p>
      }
    </div>
    <div class="field">
      <label [for]="ids + 'url'">Start URL</label>
      <input [id]="ids + 'url'" name="url" type="url" required [value]="form.url()" (input)="form.url.set(val($event))" (blur)="form.rememberUrl()" placeholder="https://app.example.gov" />
    </div>
    @if (env.env()?.signIn === 'separate-window') {
      <p class="hint" data-testid="separate-window">Sign-in opens a separate browser window (Chrome was not found for the dashboard's own window).</p>
    }
    @if (error()) {
      <div class="notice error" role="alert" data-notice="setup-error">{{ error() }}</div>
    }
    <div class="actions">
      <button type="button" class="big" (click)="start()" [disabled]="!canStart()" data-testid="setup-start">Start</button>
      @if (run.active()) {
        <p class="hint">A run is active.</p>
      }
    </div>
  `,
})
export class SetupForm {
  // Ids are prefixed, so the dialog's form and the page's do not collide.
  readonly idPrefix = input('');
  // Extra condition from the host (the Run screen's browser path).
  readonly extraOk = input(true);
  readonly started = output<void>();
  readonly env = inject(EnvStore);
  readonly form = inject(FormStore);
  readonly run = inject(RunStore);
  private starter = inject(Starter);
  readonly folder = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  get ids(): string {
    return this.idPrefix();
  }

  constructor() {
    // The folder field follows the working directory (Change…, Browse…).
    effect(() => {
      const cwd = this.env.cwd();
      untracked(() => {
        if (cwd) this.folder.set(cwd);
      });
    });
  }

  readonly warning = computed(() => {
    const e = this.env.env();
    if (!e || this.folder().trim() !== e.cwd) return '';
    const noGit = e.inGitRepo === false;
    const noPkg = !!e.cwdFacts && e.cwdFacts.package === false;
    if (!noGit && !noPkg) return '';
    const what = noGit && noPkg ? 'is not a git repository and has no package.json' : noGit ? 'is not a git repository' : 'has no package.json';
    return `This folder ${what}: a crawl works, but the fix loop needs the app's repository.`;
  });
  readonly canStart = computed(() => !!this.form.url().trim() && !!this.folder().trim() && !this.run.active() && !this.busy() && this.extraOk());

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  browse(): void {
    this.starter.browseRequests.update((n) => n + 1);
  }

  // Saves both (the folder through a switch, the URL), then the crawl.
  async start(): Promise<void> {
    if (!this.canStart()) return;
    this.error.set('');
    this.busy.set(true);
    try {
      const want = this.folder().trim();
      if (want !== this.env.cwd()) await this.env.switchTo(want);
      this.form.rememberUrl();
      this.started.emit();
      await this.starter.startCrawl();
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }
}
