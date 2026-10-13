import { Component, ElementRef, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { ADVANCED, AuthMode, FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { ageText, localTime, savedAgo } from '../core/format';
import { SignInFlow } from '../core/sign-in';

@Component({
  selector: 'app-run-screen',
  imports: [RouterLink],
  template: `
    <h1>Run a crawl</h1>
    @if (noBrowser()) {
      <div class="notice error" role="alert" data-notice="no-browser">
        <p>No Chrome, Chromium or Edge was found on this machine. Give the path to one below; Start stays disabled until you do.</p>
        <label for="chrome-top">Browser executable path</label>
        <input id="chrome-top" type="text" [value]="adv()['chrome'] || ''" (input)="form.setAdvanced('chrome', val($event))" />
      </div>
    }
    <form (submit)="$event.preventDefault(); start()" aria-labelledby="form-h">
      <h2 id="form-h" class="visually-hidden">Crawl settings</h2>
      <div class="field">
        <label for="url">Start URL</label>
        <input id="url" name="url" type="url" required [value]="form.url()" (input)="form.url.set(val($event))" (blur)="form.rememberUrl()" placeholder="https://app.example.gov" />
      </div>
      <div class="signin-state">
        <p role="status" id="signin-state" data-testid="signin-state" tabindex="-1" #signinState>
          @if (flow.active()) {
            A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded.
          } @else if (flow.failed()) {
            <span class="err-text">Sign-in did not finish: {{ flow.error() }}</span>
          } @else if (signedIn()) {
            <span class="ok">Signed in · session saved {{ savedText() }} (<time [attr.datetime]="savedAt().iso" [attr.title]="savedAt().iso">{{ savedAt().local }}</time>)</span>
          } @else {
            Not signed in
          }
        </p>
        @if (!flow.active()) {
          @if (flow.failed()) {
            <button type="button" (click)="signIn()" [disabled]="!canSignIn()">Try again</button>
          } @else if (signedIn()) {
            <button type="button" class="link" (click)="signIn()" [disabled]="!canSignIn()">Sign in again</button>
          } @else {
            <button type="button" (click)="signIn()" [disabled]="!canSignIn()">Sign in</button>
          }
        } @else {
          <button type="button" class="secondary" (click)="run.stop()">Cancel sign-in</button>
        }
      </div>
      @if (commandError() || error()) {
        <div class="notice error" role="alert" data-notice="form-error">{{ commandError() || error() }}</div>
      }
      <div class="actions">
        <!-- Without a session the way in is Sign in; Start appears once there is one, or a way is chosen under More options. -->
        @if (!needsSignIn()) {
          <button type="submit" [disabled]="!canStart()">Start</button>
        }
        @if (run.active()) {
          <p class="hint">A run is active. <a routerLink="/live">Watch it</a>.</p>
        }
      </div>
      <details class="more" data-testid="more-options">
      <summary>More options…</summary>
      <fieldset>
        <legend>How the crawler signs in</legend>
        <div class="choice">
          <input type="radio" id="auth-token" name="auth" value="token" [checked]="form.checkedMode() === 'token'" (change)="mode('token')" />
          <label for="auth-token">A token</label>
        </div>
        @if (form.mode() === 'token') {
          <div class="field indent">
            <label for="token">Token (sent as the Authorization header; held in the dashboard's memory only)</label>
            <input id="token" name="token" type="password" autocomplete="off" [value]="form.token()" (input)="form.token.set(val($event))" />
            @if (env.env()?.tokenHeld && !form.token()) {
              <p class="hint">A token entered earlier is held for this session; leave this empty to use it again.</p>
            }
          </div>
        }
        <div class="choice">
          <input type="radio" id="auth-env" name="auth" value="env" [checked]="form.checkedMode() === 'env'" [disabled]="!env.env()?.tokenInEnv" (change)="mode('env')" />
          <label for="auth-env">Use TOKEN from my shell{{ env.env()?.tokenInEnv ? '' : ' (not set when the dashboard started)' }}</label>
        </div>
        <div class="choice">
          <input type="radio" id="auth-state" name="auth" value="state" [checked]="form.checkedMode() === 'state'" [disabled]="!env.env()?.session?.exists" (change)="mode('state')" />
          <label for="auth-state">Use saved session{{ sessionText() }}</label>
        </div>
        <div class="choice">
          <input type="radio" id="auth-cookies" name="auth" value="cookies" [checked]="form.checkedMode() === 'cookies'" (change)="mode('cookies')" />
          <label for="auth-cookies">Cookies</label>
        </div>
        @if (form.mode() === 'cookies') {
          <div class="field indent">
            <label for="cookies">Cookies, one "name=value" per line</label>
            <textarea id="cookies" rows="2" [value]="form.cookies()" (input)="form.cookies.set(val($event))"></textarea>
          </div>
        }
        <div class="choice">
          <input type="radio" id="auth-none" name="auth" value="none" [checked]="form.checkedMode() === 'none'" (change)="mode('none')" />
          <label for="auth-none">No sign-in</label>
        </div>
      </fieldset>
      <div class="row">
        <div class="field">
          <label for="max-pages">Maximum pages</label>
          <input id="max-pages" type="number" min="1" inputmode="numeric" [value]="form.maxPages()" (input)="form.maxPages.set(val($event))" placeholder="200" />
        </div>
        <div class="field">
          <label for="fail-on">Fail on impacts</label>
          <input id="fail-on" type="text" [value]="form.failOn()" (input)="form.failOn.set(val($event))" aria-describedby="fail-on-hint" />
          <p class="hint" id="fail-on-hint">critical, serious, moderate, minor, or none</p>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="include">Only audit URLs matching (one pattern per line)</label>
          <textarea id="include" rows="2" [value]="form.include()" (input)="form.include.set(val($event))"></textarea>
        </div>
        <div class="field">
          <label for="exclude">Skip URLs matching (one pattern per line)</label>
          <textarea id="exclude" rows="2" [value]="form.exclude()" (input)="form.exclude.set(val($event))"></textarea>
        </div>
      </div>
      <details class="advanced">
        <summary>Advanced</summary>
        <div class="grid">
          @for (a of advanced; track a[0]) {
            @if (a[0] !== 'chrome' || !noBrowser()) {
              @if (a[2] === 'switch') {
                <div class="choice">
                  <input type="checkbox" [id]="'adv-' + a[0]" [checked]="adv()[a[0]] === true" (change)="form.setAdvanced(a[0], $any($event.target).checked)" />
                  <label [for]="'adv-' + a[0]">{{ a[1] }} <code>--{{ a[0] }}</code></label>
                </div>
              } @else if (a[2] === 'profile') {
                <div class="choice">
                  <input type="checkbox" [id]="'adv-' + a[0]" [checked]="adv()[a[0]] === true" (change)="form.setAdvanced(a[0], $any($event.target).checked)" />
                  <label [for]="'adv-' + a[0]">{{ a[1] }} <code>--{{ a[0] }} 2.2</code></label>
                </div>
              } @else if (a[2] === 'list') {
                <div class="field">
                  <label [for]="'adv-' + a[0]">{{ a[1] }} <code>--{{ a[0] }}</code></label>
                  <textarea [id]="'adv-' + a[0]" rows="2" [value]="adv()[a[0]] || ''" (input)="form.setAdvanced(a[0], val($event))"></textarea>
                </div>
              } @else {
                <div class="field">
                  <label [for]="'adv-' + a[0]">{{ a[1] }} <code>--{{ a[0] }}</code></label>
                  <input type="text" [id]="'adv-' + a[0]" [value]="adv()[a[0]] || ''" (input)="form.setAdvanced(a[0], val($event))" />
                </div>
              }
            }
          }
        </div>
      </details>
      <section class="command" aria-labelledby="cmd-h">
        <h2 id="cmd-h">The same run on the command line</h2>
        <p class="hint">Run it in <code data-testid="command-cwd">{{ env.cwd() }}</code></p>
        <pre data-testid="command" tabindex="0" role="region" aria-label="Equivalent command">{{ command() || '(enter a start URL)' }}</pre>
        <button type="button" class="secondary" (click)="copy()" [disabled]="!command()">Copy command</button>
        <span role="status" class="hint">{{ copied() }}</span>
      </section>
      </details>
    </form>
  `,
})
export class RunScreen implements OnInit {
  readonly form = inject(FormStore);
  readonly env = inject(EnvStore);
  readonly run = inject(RunStore);
  private api = inject(Api);
  private router = inject(Router);
  readonly advanced = ADVANCED;
  readonly adv = computed(() => this.form.advanced() as Record<string, any>);
  readonly command = signal('');
  readonly copied = signal('');
  // A Start or Sign in that failed, apart from the form's own errors, which
  // the command check reports (and clears) as the form changes.
  readonly error = signal('');
  readonly commandError = signal('');
  readonly noBrowser = computed(() => this.env.env()?.browser.found === false);
  readonly sessionText = computed(() => {
    const s = this.env.env()?.session;
    return s?.exists ? ` (${s.file}, ${ageText(s.ageMs)})` : ' (none saved yet)';
  });
  readonly flow = inject(SignInFlow);
  private statusEl = viewChild<ElementRef<HTMLElement>>('signinState');
  readonly signedIn = computed(() => !!this.env.env()?.session?.exists || !!this.flow.saved());
  readonly savedText = computed(() => {
    const s = this.env.env()?.session;
    return s?.exists ? savedAgo(s.ageMs) : 'just now';
  });
  readonly savedAt = computed(() => {
    const s = this.env.env()?.session;
    const t = s?.exists && s.ageMs !== undefined ? new Date(Date.now() - s.ageMs) : new Date();
    return { iso: t.toISOString(), local: localTime(t) };
  });
  readonly canSignIn = computed(() => !!this.form.url().trim() && !this.run.active());
  // No saved session and no other way chosen under More options: sign in first.
  readonly needsSignIn = computed(() => !this.form.hasWayIn());
  readonly canStart = computed(() => !!this.form.url().trim() && !this.run.active() && !this.needsSignIn() && (!this.noBrowser() || !!String(this.adv()['chrome'] || '').trim()));
  private timer: any;

  constructor() {
    // When a sign-in finishes, focus moves to its status, which says how it ended.
    let wasActive = false;
    effect(() => {
      const active = this.flow.active();
      if (wasActive && !active) untracked(() => setTimeout(() => this.statusEl()?.nativeElement.focus()));
      wasActive = active;
    });
    effect(() => {
      // The command is written for the working directory, so it follows a switch.
      this.env.cwd();
      const body = this.form.body('crawl', false);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refreshCommand(body), 150);
    });
  }

  async ngOnInit(): Promise<void> {
    await this.env.load();
  }

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  mode(m: AuthMode): void {
    this.form.choose(m);
  }

  async signIn(): Promise<void> {
    if (!this.canSignIn()) return;
    this.error.set('');
    try {
      await this.flow.start();
      // The crawl runs in the sign-in window; Live shows the wait, then the pages.
      await this.router.navigateByUrl('/live');
    } catch (e: any) {
      this.error.set(e.message);
    }
  }

  private async refreshCommand(body: Record<string, unknown>): Promise<void> {
    if (!body['url']) return this.command.set('');
    try {
      const r = await this.api.get<{ command: string }>(`/api/command?form=${encodeURIComponent(JSON.stringify(body))}`);
      this.command.set(r.command);
      this.commandError.set('');
    } catch (e: any) {
      this.command.set('');
      this.commandError.set(e.message);
    }
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.command());
      this.copied.set('Copied.');
    } catch {
      this.copied.set('Could not copy; select the command and copy it by hand.');
    }
  }

  async start(): Promise<void> {
    if (!this.canStart()) return;
    this.error.set('');
    try {
      this.form.rememberUrl();
      await this.run.start(this.form.body('crawl'));
      this.form.clearToken();
      await this.router.navigateByUrl('/live');
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.form.clearToken();
    }
  }
}
