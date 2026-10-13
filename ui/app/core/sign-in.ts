import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { EnvStore } from './env.store';
import { FormStore } from './form.store';
import { RunStore } from './run.store';

// The sign-in. The Run screen's Sign in (and the Live notice's) starts one crawl
// with auth mode "signin" (--login --stay): a visible Chrome window opens, the
// person signs in, the session is saved, and the crawl runs in that window.
// The Sign in route keeps the older login-only run.
@Injectable({ providedIn: 'root' })
export class SignInFlow {
  private run = inject(RunStore);
  private form = inject(FormStore);
  private env = inject(EnvStore);

  // A run that signs in: the login-only kind, or a crawl with --login --stay.
  readonly isSignIn = computed(() => this.run.kind() === 'login' || (this.run.kind() === 'crawl' && / --login --stay( |$)/.test(String(this.run.run()?.['command'] || ''))));
  // Signing in: the run is going and no session has been saved yet.
  readonly active = computed(() => this.isSignIn() && this.run.active() && !this.run.sessionSaved());
  readonly saved = computed(() => (this.isSignIn() ? this.run.sessionSaved() : null));
  readonly failed = computed(() => this.isSignIn() && !!this.run.done() && !this.run.sessionSaved());
  readonly error = computed(() => {
    if (!this.failed()) return '';
    const errors = this.run.notices().filter((n) => n.level === 'error' && !/^The run failed \(exit code/.test(n.message));
    const d = this.run.done();
    if (d?.['outcome'] === 'stopped') return 'Sign-in was stopped before a session was saved.';
    return errors.length ? errors.map((n) => n.message).join(' ') : `Sign-in did not finish (exit code ${d?.['code']}).`;
  });

  constructor() {
    // Once a session is saved, later runs use it, and the screens read its age again.
    effect(() => {
      const saved = this.saved();
      const done = this.isSignIn() && this.run.done();
      untracked(() => {
        if (saved) this.form.useSession();
        if (saved || done) void this.env.load();
      });
    });
  }

  // Sign in and crawl in the same window, with the Run form's options.
  // url: the Run form's by default; the Fix loop passes its config's.
  async start(url = this.form.url().trim()): Promise<void> {
    this.form.rememberUrl();
    await this.run.start({ kind: 'crawl', url, options: this.form.options(), auth: { mode: 'signin' } });
  }

  // The Sign in route: sign in and save the session, without crawling.
  async startLoginOnly(): Promise<void> {
    this.form.rememberUrl();
    await this.run.start({ kind: 'login', url: this.form.url().trim(), options: {}, auth: { mode: 'none' } });
  }
}
