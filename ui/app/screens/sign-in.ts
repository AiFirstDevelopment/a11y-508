import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { SignInFlow } from '../core/sign-in';
import { SignInWait } from '../shared/sign-in-wait';

@Component({
  selector: 'app-sign-in-screen',
  imports: [RouterLink, SignInWait],
  template: `
    <h1>Sign in</h1>
    <p>For apps behind a sign-in portal: a Chrome window opens on the start URL, you sign in there, and the session is saved to <code>a11y-508-state.json</code> for later crawls.</p>
    <div class="field">
      <label for="signin-url">Start URL</label>
      <input id="signin-url" type="url" [value]="form.url()" (input)="form.url.set($any($event.target).value)" />
    </div>
    <div class="actions">
      <button type="button" (click)="signIn()" [disabled]="store.active() || !form.url()">Open the sign-in window</button>
      @if (store.kind() === 'login' && store.active()) {
        <button type="button" class="secondary" (click)="store.stop()">Cancel</button>
      }
    </div>
    @if (store.kind() === 'login') {
      <div role="status" data-testid="signin-status">
        @if (store.sessionSaved(); as s) {
          <p class="ok">Signed in. The session was saved to {{ s['file'] }} ({{ s['summary'] }}). The Run screen now uses the saved session.</p>
          <a class="button" routerLink="/run">Back to Run</a>
        } @else if (store.loginWaiting()) {
          <app-sign-in-wait testId="signin-waiting" />
        } @else if (store.done()) {
          <p class="notice error">Sign-in did not finish (exit code {{ store.done()?.['code'] }}). Open the raw output on the Live run screen for details.</p>
        } @else {
          <p>Starting the browser…</p>
        }
      </div>
    }
  `,
})
export class SignInScreen {
  readonly store = inject(RunStore);
  readonly form = inject(FormStore);
  // Saving the session switches Run to it (SignInFlow).
  private flow = inject(SignInFlow);

  async signIn(): Promise<void> {
    await this.flow.startLoginOnly();
  }
}
