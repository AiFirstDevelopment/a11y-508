import { Component, computed, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { RunStore } from '../core/run.store';

// The sign-in wait, in one sentence, and a button that brings the sign-in tab to the front
// (POST /api/sign-in/show). The server already brings it forward once when the wait starts. The wait
// has no limit from the dashboard, and a sign-in tab the person closed is opened again (said once).
@Component({
  selector: 'app-sign-in-wait',
  template: `
    <div class="notice" role="status" [attr.data-testid]="testId()">
      <p>{{ sentence() }}</p>
      @if (store.loginReopened()) { <p class="hint" data-testid="sign-in-reopened">The sign-in tab was closed; opened it again.</p> }
      <button type="button" class="secondary" data-testid="show-sign-in-tab" (click)="show()">Show the sign-in tab</button>
      @if (missed()) { <p class="hint" data-testid="show-sign-in-tab-missed">{{ missed() }}</p> }
    </div>
  `,
})
export class SignInWait {
  readonly testId = input('sign-in-wait');
  // 'loop': the fix loop's sign-in (the loop goes on by itself once signed in); 'crawl': a crawl's.
  readonly kind = input<'loop' | 'crawl'>('crawl');
  readonly store = inject(RunStore);
  private api = inject(Api);
  readonly missed = signal('');
  readonly sentence = computed(() => {
    if (this.kind() === 'loop') return this.store.signInAgain() ? 'Your sign-in expired: sign in in the tab that opened, and the crawl runs again.' : 'Sign in in the tab that opened; the loop continues by itself once you have.';
    const host = this.store.loginWaitingHost();
    return `Sign in on the tab that opened in Chrome${host ? ` (${host})` : ''}.`;
  });

  async show(): Promise<void> {
    this.missed.set('');
    try {
      await this.api.post('/api/sign-in/show');
    } catch {
      this.missed.set('The sign-in tab could not be brought forward. Look for it in your Chrome windows.');
    }
  }
}
