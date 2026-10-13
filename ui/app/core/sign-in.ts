import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { EnvStore } from './env.store';
import { FormStore } from './form.store';
import { RunStore } from './run.store';

// The sign-in: a login run (--login-only) that saves a11y-508-state.json.
// Started from the Run screen, the Live screen's notice and the Sign in route.
@Injectable({ providedIn: 'root' })
export class SignInFlow {
  private run = inject(RunStore);
  private form = inject(FormStore);
  private env = inject(EnvStore);

  readonly isLogin = computed(() => this.run.kind() === 'login');
  readonly active = computed(() => this.isLogin() && this.run.active());
  readonly saved = computed(() => (this.isLogin() ? this.run.sessionSaved() : null));
  readonly failed = computed(() => this.isLogin() && !!this.run.done() && !this.run.sessionSaved());
  readonly error = computed(() => {
    if (!this.failed()) return '';
    const errors = this.run.notices().filter((n) => n.level === 'error' && !/^The run failed \(exit code/.test(n.message));
    const d = this.run.done();
    if (d?.['outcome'] === 'stopped') return 'Sign-in was stopped before a session was saved.';
    return errors.length ? errors.map((n) => n.message).join(' ') : `Sign-in did not finish (exit code ${d?.['code']}).`;
  });

  constructor() {
    // Once a session is saved, the next run uses it, and the screens read its age again.
    effect(() => {
      const done = this.isLogin() && this.run.done();
      const saved = this.saved();
      untracked(() => {
        if (saved) this.form.useSession();
        if (done) void this.env.load();
      });
    });
  }

  async start(): Promise<void> {
    this.form.rememberUrl();
    await this.run.start({ kind: 'login', url: this.form.url().trim(), options: {}, auth: { mode: 'none' } });
  }
}
