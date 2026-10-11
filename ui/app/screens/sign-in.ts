import { Component, effect, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EnvStore } from '../core/env.store';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';

@Component({
  selector: 'app-sign-in-screen',
  imports: [RouterLink],
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
          <p>A Chrome window has opened. Sign in there and stay on the app's page; this screen updates by itself when the session is saved.</p>
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
  private env = inject(EnvStore);

  constructor() {
    effect(() => {
      if (this.store.kind() === 'login' && this.store.sessionSaved()) {
        this.form.authMode.set('state');
        void this.env.load();
      }
    });
  }

  async signIn(): Promise<void> {
    await this.store.start({ kind: 'login', url: this.form.url().trim(), options: {}, auth: { mode: 'none' } });
  }
}
