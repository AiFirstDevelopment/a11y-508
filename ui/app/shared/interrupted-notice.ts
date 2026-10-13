import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RunStore } from '../core/run.store';
import { Interrupted, Resume, interruptedText } from '../core/resume';
import { StartOver } from './start-over';

// The Fix step after the dashboard was closed while the fix loop ran and its process is gone:
// where it was, what Continue discards (the unfinished fix's changes), Continue and Start over.
@Component({
  selector: 'app-interrupted-notice',
  imports: [StartOver],
  template: `
    @if (info(); as i) {
      <section class="notice warn" role="region" aria-labelledby="interrupted-h" data-testid="interrupted">
        <h2 id="interrupted-h">The fix loop was interrupted</h2>
        <p class="wrap" data-testid="interrupted-text">{{ text(i) }}</p>
        @if (i.discard.length) {
          <p>Continue discards the unfinished change to:</p>
          <ul data-testid="interrupted-discard">
            @for (f of i.discard; track f) { <li><code>{{ f }}</code></li> }
          </ul>
        } @else {
          <p class="hint">Continue goes on from the ledger, with no new crawl.</p>
        }
        <div class="actions">
          <button type="button" class="big" (click)="continueLoop()" [disabled]="busy()" data-testid="loop-continue">Continue</button>
          <app-start-over [big]="true" />
        </div>
        @if (error()) { <p class="notice error" role="alert" data-testid="continue-error">{{ error() }}</p> }
      </section>
    }
  `,
})
export class InterruptedNotice {
  private store = inject(RunStore);
  private resume = inject(Resume);
  readonly info = signal<Interrupted | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly text = interruptedText;

  constructor() {
    effect(() => {
      const d = this.store.done();
      const interrupted = d?.['outcome'] === 'interrupted';
      untracked(() => {
        if (!interrupted) return this.info.set(null);
        // The run's own done event says where it was; the server adds what Continue would discard.
        const i = (d?.['interrupted'] || {}) as Partial<Interrupted>;
        this.info.set({ at: String(i.at || d?.['at'] || ''), round: i.round ?? null, n: i.n ?? null, m: i.m ?? null, kind: 'loop', attemptInProgress: false, discard: [] });
        this.resume.interrupted().then((x) => x && this.store.done()?.['outcome'] === 'interrupted' && this.info.set(x)).catch(() => {});
      });
    });
  }

  async continueLoop(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.resume.continueLoop();
      void this.store.connect();
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }
}
