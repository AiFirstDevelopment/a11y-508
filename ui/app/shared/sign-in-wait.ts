import { Component, computed, inject, input, signal } from '@angular/core';
import { Api } from '../core/api';
import { RunStore } from '../core/run.store';

// The sign-in wait, in one sentence, and a button that brings the sign-in tab to the front
// (POST /api/sign-in/show). The server already brings it forward once when the wait starts.
@Component({
  selector: 'app-sign-in-wait',
  template: `
    <div class="notice" role="status" [attr.data-testid]="testId()">
      <p>{{ sentence() }}</p>
      <button type="button" class="secondary" data-testid="show-sign-in-tab" (click)="show()">Show the sign-in tab</button>
      @if (missed()) { <p class="hint" data-testid="show-sign-in-tab-missed">{{ missed() }}</p> }
    </div>
  `,
})
export class SignInWait {
  readonly testId = input('sign-in-wait');
  private store = inject(RunStore);
  private api = inject(Api);
  readonly missed = signal('');
  readonly sentence = computed(() => {
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
