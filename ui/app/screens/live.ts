import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { resultWord } from '../core/format';
import { RunView } from '../shared/run-view';
import { SignInFlow } from '../core/sign-in';

@Component({
  selector: 'app-live-screen',
  imports: [RunView, RouterLink],
  template: `
    <h1>Live run</h1>
    @if (!store.run()) {
      <p data-testid="no-run">No run in this directory yet. <a routerLink="/run">Start one</a>.</p>
    } @else {
      <p class="status" role="status" data-testid="run-status">{{ status() }}</p>
      @if (store.run()?.['command']; as cmd) {
        <p class="hint">Running <code data-testid="run-command">{{ cmd }}</code></p>
      }
      @if (store.loginWaiting() && store.active()) {
        <p class="notice" role="status" data-testid="login-waiting">A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded.</p>
      }
      @if (signInError()) {
        <div class="notice error" role="alert">{{ signInError() }}</div>
      }
      <div class="actions">
        <button type="button" (click)="stop()" [disabled]="!store.active()">Stop</button>
        @if (store.done() && store.summary()) {
          <a class="button secondary" routerLink="/report">Open the report</a>
        }
      </div>
      @if (store.cannotGetIn()) {
        <div class="notice error" role="alert" data-notice="cannot-get-in">
          <p>The crawler could not get into the app.</p>
          @if (store.bouncedToSignIn()) {
            <p>The app sent the crawler to a sign-in page. Sign in, and the crawl runs again in the signed-in window.</p>
          }
          <div class="actions">
            @if (store.bouncedToSignIn()) {
              <button type="button" (click)="signIn()">Sign in</button>
            }
            <button type="button" [class.secondary]="store.bouncedToSignIn()" (click)="troubleshoot()">Troubleshoot with these settings</button>
          </div>
        </div>
      }
      <app-run-view />
    }
  `,
})
export class LiveScreen {
  readonly store = inject(RunStore);
  private form = inject(FormStore);
  private router = inject(Router);
  private flow = inject(SignInFlow);
  readonly signInError = signal('');

  readonly status = computed(() => {
    const d = this.store.done();
    const s = this.store.summary();
    if (this.store.stopping() && !d) return 'Stopping…';
    if (!d) return `Running: ${this.store.kind()}`;
    if (d['outcome'] === 'stopped') return 'Stopped';
    if (s) return `Finished: ${resultWord(s['result'])}`;
    if (d['outcome'] === 'error') return `Failed (exit code ${d['code']})`;
    return 'Finished';
  });

  async stop(): Promise<void> {
    await this.store.stop();
  }

  // A new run that signs in and crawls in the same window; this screen follows it.
  async signIn(): Promise<void> {
    this.signInError.set('');
    try {
      await this.flow.start();
    } catch (e: any) {
      this.signInError.set(e.message);
    }
  }

  async troubleshoot(): Promise<void> {
    await this.store.start(this.form.body('troubleshoot'));
    this.form.clearToken();
    await this.router.navigateByUrl('/troubleshoot');
  }
}
