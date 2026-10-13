import { Component, OnInit, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { ADVANCED, AuthMode, FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { ageText } from '../core/format';
import { SignInFlow } from '../core/sign-in';
import { SetupForm } from '../shared/setup-form';
import { StartOver } from '../shared/start-over';

@Component({
  selector: 'app-run-screen',
  imports: [RouterLink, SetupForm, StartOver],
  template: `
    <h1>Set up</h1>
    @if (noBrowser()) {
      <div class="notice error" role="alert" data-notice="no-browser">
        <p>No Chrome, Chromium or Edge was found on this machine. Give the path to one below; Start stays disabled until you do.</p>
        <label for="chrome-top">Browser executable path</label>
        <input id="chrome-top" type="text" [value]="adv()['chrome'] || ''" (input)="form.setAdvanced('chrome', val($event))" />
      </div>
    }
    <!-- Set up: the app's folder, its URL, and Start (shared with the setup dialog). -->
    <app-setup-form [extraOk]="browserOk()" />
    <!-- The only way back to the beginning: reloading or relaunching opens where the person was. -->
    @if (hasAnalysis()) {
      <p class="hint" data-testid="start-over-line">The results, the fixes and the history so far are kept. To begin again from nothing: <app-start-over /></p>
    }
    @if (run.active()) {
      <p class="hint">A run is active. <a routerLink="/live">Watch it</a>.</p>
    }
    <form (submit)="$event.preventDefault()" aria-labelledby="form-h">
      <h2 id="form-h" class="visually-hidden">Crawl settings</h2>
      @if (commandError() || error()) {
        <div class="notice error" role="alert" data-notice="form-error">{{ commandError() || error() }}</div>
      }
      <!-- Every other setting lives at /run/advanced, which nothing links to. -->
      @if (advanced()) {
      <section data-testid="more-options" aria-labelledby="adv-h">
      <h2 id="adv-h">Advanced settings</h2>
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
          @for (a of flags; track a[0]) {
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
      </section>
      }
    </form>
  `,
})
export class RunScreen implements OnInit {
  // Route data: true on /run/advanced, where the settings beyond the start URL are.
  readonly advanced = input(false);
  readonly form = inject(FormStore);
  readonly env = inject(EnvStore);
  readonly run = inject(RunStore);
  private api = inject(Api);
  readonly hasAnalysis = computed(() => {
    const e = this.env.env();
    return !!e && (!!e.report?.exists || !!e.cwdFacts?.ledger || (e.pastRuns || 0) > 0);
  });
  private router = inject(Router);
  readonly flags = ADVANCED;
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
  // No saved session and no other way chosen on /run/advanced: sign in first.
  private flow = inject(SignInFlow);
  readonly browserOk = computed(() => !this.noBrowser() || !!String(this.adv()['chrome'] || '').trim());
  readonly canStart = computed(() => !!this.form.url().trim() && !this.run.active() && (!this.noBrowser() || !!String(this.adv()['chrome'] || '').trim()));
  private timer: any;

  constructor() {
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

  // The sign-in crawl (--login --stay): a new browser, a new session, and the crawl in that window; Live follows it.
  private async signInCrawl(): Promise<void> {
    if (!this.canStart()) return;
    this.error.set('');
    try {
      await this.flow.start();
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

  // Start opens a fresh browser window to sign in in (or the portal lets the person straight
  // through) and crawls in it (--login --stay); the session file is saved on the way, for the fix
  // loop. Only a way in chosen on /run/advanced (a saved session, a token, cookies, none) runs
  // the headless crawl instead.
  async start(): Promise<void> {
    if (!this.canStart()) return;
    if (!this.form.authChosen()) return this.signInCrawl();
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
