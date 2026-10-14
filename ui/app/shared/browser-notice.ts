import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Diagnostics } from '../core/diagnostics';

// At the top of the wizard, once the dashboard's own browser window went away: why (the diary's
// sentence), Reopen the window, and Details (the Diagnostics screen). It stays until dismissed.
@Component({
  selector: 'app-browser-notice',
  imports: [RouterLink],
  template: `
    @if (show(); as o) {
      <section class="notice warn" role="region" aria-labelledby="browser-gone-h" data-testid="browser-notice">
        <h2 id="browser-gone-h" class="visually-hidden">The dashboard's browser window closed</h2>
        <p class="wrap" data-testid="browser-notice-text">{{ o.lastExit!.text }}</p>
        <div class="actions">
          @if (o.status !== 'open') {
            @if (o.canReopen) {
              <button type="button" (click)="reopen()" [disabled]="busy()" data-testid="browser-reopen">Reopen the window</button>
            }
          } @else {
            <p class="hint" role="status" data-testid="browser-reopened">The window is open again.</p>
          }
          <a routerLink="/diagnostics" data-testid="browser-details">Details</a>
          <button type="button" class="link" (click)="dismiss()" data-testid="browser-dismiss">Dismiss</button>
        </div>
        @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
      </section>
    }
  `,
})
export class BrowserNotice {
  private diag = inject(Diagnostics);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly show = computed(() => {
    const o = this.diag.own();
    return o && o.lastExit && !o.dismissed ? o : null;
  });

  constructor() {
    this.diag.watch();
  }

  async reopen(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.diag.reopen();
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  async dismiss(): Promise<void> {
    try {
      await this.diag.dismiss();
    } catch (e: any) {
      this.error.set(e.message);
    }
  }
}
