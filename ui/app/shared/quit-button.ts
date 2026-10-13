import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { RunStore } from '../core/run.store';
import { Resume } from '../core/resume';

// Quit: the dashboard ends (its server, and its own window). Closing the window does not end it,
// so this is the way to, besides Ctrl+C in its terminal. With a run active it asks first, since the
// run ends with it.
@Component({
  selector: 'app-quit',
  template: `
    @if (ended()) {
      <p class="notice" role="status" data-testid="quit-done">The dashboard has ended. Start it again with <code>npm run ui</code>; it opens where you were.</p>
    } @else {
      <div class="quit-bar"><button type="button" class="link small" (click)="ask()" data-testid="quit">Quit<span class="visually-hidden"> the dashboard</span></button></div>
    }
    <dialog #dlg aria-labelledby="quit-h" aria-describedby="quit-d" data-testid="quit-confirm">
      <h2 id="quit-h">Quit while the {{ what() }} runs?</h2>
      <p id="quit-d">Quitting ends the dashboard and stops the {{ what() }}. To leave it running, close this window instead; launching the dashboard again shows it.</p>
      @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
      <div class="actions">
        <button type="button" (click)="quit(true)" data-testid="quit-yes">Stop it and quit</button>
        <button type="button" class="secondary" (click)="dlg.close()">Cancel</button>
      </div>
    </dialog>
  `,
  styles: [`.quit-bar { display: flex; justify-content: flex-end; padding: 4px 24px 0; }`],
})
export class QuitButton {
  private run = inject(RunStore);
  private resume = inject(Resume);
  private dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  readonly ended = signal(false);
  readonly error = signal('');
  readonly what = signal('run');

  private name(kind: string | null): string {
    return kind === 'loop' ? 'fix loop' : kind === 'dry-run' ? 'dry run' : kind === 'install' ? 'install' : 'crawl';
  }

  async ask(): Promise<void> {
    this.error.set('');
    if (this.run.active()) {
      this.what.set(this.name(this.run.kind()));
      this.dialog().nativeElement.showModal();
      return;
    }
    await this.quit(false);
  }

  async quit(stopRun: boolean): Promise<void> {
    try {
      await this.resume.quit(stopRun);
    } catch (e: any) {
      // A run the page had not heard of yet: ask about it.
      if (e?.status === 409) {
        this.what.set(this.name(e.body?.kind || null));
        if (!this.dialog().nativeElement.open) this.dialog().nativeElement.showModal();
        return;
      }
      this.error.set(e.message);
      if (!this.dialog().nativeElement.open) this.dialog().nativeElement.showModal();
      return;
    }
    if (this.dialog().nativeElement.open) this.dialog().nativeElement.close();
    this.ended.set(true);
  }
}
