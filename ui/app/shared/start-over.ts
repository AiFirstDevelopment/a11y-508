import { Component, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { EnvStore } from '../core/env.store';
import { RunStore } from '../core/run.store';
import { Resume, StartOverInfo, startOverText } from '../core/resume';

// Start over: the one way back to the beginning. It names what it discards and asks first; then
// the report, the ledger and the history for the URL are cleared and the wizard starts at Set up.
@Component({
  selector: 'app-start-over',
  template: `
    <button type="button" [class]="big() ? 'secondary' : 'secondary small'" (click)="ask()" [disabled]="run.active()" data-testid="start-over">Start over</button>
    <dialog #dlg aria-labelledby="start-over-h" aria-describedby="start-over-d" data-testid="start-over-confirm">
      <h2 id="start-over-h">Start over?</h2>
      <p id="start-over-d" data-testid="start-over-text">This discards {{ text() }}. The dashboard starts again at Set up.</p>
      @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
      <div class="actions">
        <button type="button" (click)="confirm()" [disabled]="busy()" [attr.aria-busy]="busy() || null" data-testid="start-over-yes">@if (busy()) { <span class="spinner" aria-hidden="true" data-testid="start-over-spinner"></span> }Start over</button>
        <button type="button" class="secondary" (click)="dlg.close()" [disabled]="busy()">Cancel</button>
      </div>
    </dialog>
  `,
})
export class StartOver {
  readonly big = input(false);
  readonly run = inject(RunStore);
  private env = inject(EnvStore);
  private resume = inject(Resume);
  private router = inject(Router);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  readonly text = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  async ask(): Promise<void> {
    this.error.set('');
    let info: StartOverInfo;
    try {
      info = await this.resume.startOverInfo();
    } catch (e: any) {
      this.error.set(e.message);
      info = { report: false, ledger: false, rounds: 0, attempts: 0, history: 0, url: null };
    }
    this.text.set(startOverText(info));
    this.dialog().nativeElement.showModal();
  }

  async confirm(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      try {
        await this.resume.startOver();
      } catch (e: any) {
        this.error.set(e.message);
        return;
      }
      this.run.forget();
      await this.env.load();
      this.dialog().nativeElement.close();
      await this.router.navigateByUrl('/run');
    } finally {
      this.busy.set(false);
    }
  }
}
