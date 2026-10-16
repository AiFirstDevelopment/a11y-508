import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Driver } from '../core/driver';
import { EnvStore } from '../core/env.store';
import { ADVANCED, AuthMode, FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { ageText } from '../core/format';
import { Preset } from '../core/types';

// Advanced (linked from the bottom of Diagnostics, nowhere else): the assistant the loop runs, the
// crawl's settings beyond the URL, and the loop's settings. Start on the one screen uses them.
@Component({
  selector: 'app-advanced-screen',
  imports: [RouterLink],
  template: `
    <h1>Advanced</h1>
    <p class="hint">Start on <a routerLink="/">the dashboard</a> uses these. Nothing here needs changing for the loop to run.</p>

    <section aria-labelledby="agent-h" data-testid="assistant-settings">
      <h2 id="agent-h">Assistant</h2>
      @if (env.env()?.detecting) {
        <p role="status">Detecting assistants…</p>
      } @else {
        <fieldset class="picker" data-testid="picker">
          <legend>The assistant the loop runs</legend>
          @for (p of presets(); track p.name) {
            <div class="choice preset" [class.missing]="!p.found" [attr.data-preset]="p.name" [attr.data-found]="p.found">
              <input type="radio" name="agent" [id]="'agent-' + p.name" [value]="p.name" [checked]="choice() === p.name" (change)="choose(p.name)" [attr.aria-describedby]="'agent-' + p.name + '-d'" />
              <label [for]="'agent-' + p.name">{{ p.label }}</label>
              <div class="desc" [id]="'agent-' + p.name + '-d'">
                @if (p.found) {
                  <span data-testid="version">{{ p.version || 'version unknown' }}</span> · found {{ p.where === 'PATH' ? 'on PATH' : 'through ' + p.where }} at <code data-testid="where">{{ p.path }}</code><br />
                  runs <code data-testid="agent-command">{{ p.command }}</code>
                  @if (p.runCommand) { <br />by hand, in your shell: <code data-testid="run-command">{{ p.runCommand }}</code> }
                } @else {
                  <strong>not installed</strong> (it installs with <code>{{ p.install }}</code>)
                }
              </div>
            </div>
          }
          <div class="choice preset" data-preset="custom">
            <input type="radio" name="agent" id="agent-custom" value="custom" [checked]="choice() === 'custom'" (change)="choose('custom')" />
            <label for="agent-custom">Custom command</label>
          </div>
          @if (choice() === 'custom') {
            <div class="field indent">
              <label for="custom-command">Command (must contain {{ '{' }}promptFile{{ '}' }}; may use {{ '{' }}resultFile{{ '}' }})</label>
              <input id="custom-command" type="text" [value]="custom()" (input)="custom.set(v($event))" (change)="saveAgent()" />
              @if (custom() && !custom().includes('{promptFile}')) {
                <p class="notice error" role="alert">The command must contain {{ '{' }}promptFile{{ '}' }}.</p>
              }
            </div>
          }
        </fieldset>
      }
    </section>

    <section aria-labelledby="crawl-h" data-testid="more-options">
      <h2 id="crawl-h">Crawl</h2>
      @if (commandError()) {
        <div class="notice error" role="alert" data-notice="form-error">{{ commandError() }}</div>
      }
      <fieldset>
        <legend>How the crawler signs in</legend>
        <div class="choice">
          <input type="radio" id="auth-token" name="auth" value="token" [checked]="form.checkedMode() === 'token'" (change)="mode('token')" />
          <label for="auth-token">A token</label>
        </div>
        @if (form.mode() === 'token') {
          <div class="field indent">
            <label for="token">Token (sent as the Authorization header; held in the dashboard's memory only)</label>
            <input id="token" name="token" type="password" autocomplete="off" [value]="form.token()" (input)="form.token.set(v($event))" />
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
            <textarea id="cookies" rows="2" [value]="form.cookies()" (input)="form.cookies.set(v($event))"></textarea>
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
          <input id="max-pages" type="number" min="1" inputmode="numeric" [value]="form.maxPages()" (input)="form.maxPages.set(v($event))" placeholder="200" />
        </div>
        <div class="field">
          <label for="fail-on">Fail on impacts</label>
          <input id="fail-on" type="text" [value]="form.failOn()" (input)="form.failOn.set(v($event))" aria-describedby="fail-on-hint" />
          <p class="hint" id="fail-on-hint">critical, serious, moderate, minor, or none</p>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="include">Only audit URLs matching (one pattern per line)</label>
          <textarea id="include" rows="2" [value]="form.include()" (input)="form.include.set(v($event))"></textarea>
        </div>
        <div class="field">
          <label for="exclude">Skip URLs matching (one pattern per line)</label>
          <textarea id="exclude" rows="2" [value]="form.exclude()" (input)="form.exclude.set(v($event))"></textarea>
        </div>
      </div>
      <div class="grid">
        @for (a of flags; track a[0]) {
          @if (a[2] === 'switch' || a[2] === 'profile') {
            <div class="choice">
              <input type="checkbox" [id]="'adv-' + a[0]" [checked]="adv()[a[0]] === true" (change)="form.setAdvanced(a[0], $any($event.target).checked)" />
              <label [for]="'adv-' + a[0]">{{ a[1] }} <code>--{{ a[0] }}{{ a[2] === 'profile' ? ' 2.2' : '' }}</code></label>
            </div>
          } @else if (a[2] === 'list') {
            <div class="field">
              <label [for]="'adv-' + a[0]">{{ a[1] }} <code>--{{ a[0] }}</code></label>
              <textarea [id]="'adv-' + a[0]" rows="2" [value]="adv()[a[0]] || ''" (input)="form.setAdvanced(a[0], v($event))"></textarea>
            </div>
          } @else {
            <div class="field">
              <label [for]="'adv-' + a[0]">{{ a[1] }} <code>--{{ a[0] }}</code></label>
              <input type="text" [id]="'adv-' + a[0]" [value]="adv()[a[0]] || ''" (input)="form.setAdvanced(a[0], v($event))" />
            </div>
          }
        }
      </div>
      <h3 id="cmd-h">The same crawl on the command line</h3>
      <p class="hint">Run it in <code data-testid="command-cwd">{{ env.cwd() }}</code></p>
      <pre data-testid="command" tabindex="0" role="region" aria-labelledby="cmd-h">{{ command() || '(no start URL yet)' }}</pre>
    </section>

    <section aria-labelledby="settings-h" data-testid="loop-more">
      <h2 id="settings-h">Fix loop</h2>
      @if (driver.repoConfig()) {
        <p class="hint" data-testid="repo-config">The repository's a11y-508.config.json is used as is; it is not changed from here.</p>
      }
      <form (submit)="$event.preventDefault(); saveConfig()" class="config" data-testid="config-form">
        <p class="hint">Settings are saved as you change them.</p>
        <div class="field"><label for="c-url">Start URL</label><input id="c-url" type="url" [value]="cfg()['url'] || ''" (input)="set('url', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-args">Crawl options, one per line</label><textarea id="c-args" rows="2" [value]="lines(cfg()['args'])" (input)="set('args', toLines(v($event)))" (change)="saveConfig()"></textarea></div>
        <div class="field"><label for="c-source">Folders the assistant may edit, one per line</label><textarea id="c-source" rows="2" [value]="lines(cfg()['source'] || eff()?.source)" (input)="set('source', toLines(v($event)))" (change)="saveConfig()"></textarea></div>
        <div class="field"><label for="c-check">Check command (build and test)</label><input id="c-check" type="text" [value]="cfg()['check'] ?? (eff()?.check || '')" (input)="set('check', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-checkEvery">Run the check</label>
          <select id="c-checkEvery" (change)="set('checkEvery', v($event)); saveConfig()"><option value="finding" [selected]="cfg()['checkEvery'] !== 'round'">after each fix</option><option value="round" [selected]="cfg()['checkEvery'] === 'round'">once per round</option></select></div>
        <div class="field"><label for="c-branch">Branch to commit on</label><input id="c-branch" type="text" [value]="cfg()['branch'] || eff()?.branch || ''" (input)="set('branch', v($event))" (change)="saveConfig()" /></div>
        <div class="choice"><input id="c-push" type="checkbox" [checked]="cfg()['push'] ?? eff()?.push ?? true" (change)="set('push', $any($event.target).checked); saveConfig()" /><label for="c-push">Push each round's commits</label></div>
        <div class="field"><label for="c-maxAttempts">Fix attempts per finding</label><input id="c-maxAttempts" type="number" min="1" [value]="cfg()['maxAttempts'] ?? eff()?.maxAttempts ?? ''" (input)="setNum('maxAttempts', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-agentTimeout">Assistant timeout per task (ms)</label><input id="c-agentTimeout" type="number" min="0" [value]="cfg()['agentTimeout'] ?? ''" (input)="setNum('agentTimeout', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-triageBatch">Review items per triage prompt</label><input id="c-triageBatch" type="number" min="1" [value]="cfg()['triageBatch'] ?? ''" (input)="setNum('triageBatch', v($event))" (change)="saveConfig()" /></div>
        <p><span role="status" data-testid="config-status">{{ configStatus() }}</span></p>
        @if (configErrors().length) {
          <div class="notice error" role="alert" data-testid="config-errors"><ul>@for (e of configErrors(); track $index) { <li>{{ e }}</li> }</ul></div>
        }
      </form>
    </section>
    <p><a routerLink="/diagnostics">Back to Diagnostics</a></p>
  `,
})
export class AdvancedScreen {
  readonly env = inject(EnvStore);
  readonly form = inject(FormStore);
  readonly driver = inject(Driver);
  private run = inject(RunStore);
  private api = inject(Api);
  readonly flags = ADVANCED;
  readonly adv = computed(() => this.form.advanced() as Record<string, any>);
  readonly presets = computed<Preset[]>(() => this.env.env()?.presets || []);
  readonly eff = computed(() => this.driver.defaults()?.effective || null);
  // The loop's config as edited here (saved on change).
  readonly cfg = signal<Record<string, any>>({});
  readonly configErrors = signal<string[]>([]);
  readonly configStatus = signal('');
  readonly choice = signal<string | null>(null);
  readonly custom = signal('');
  readonly command = signal('');
  readonly commandError = signal('');
  readonly sessionText = computed(() => {
    const s = this.env.env()?.session;
    return s?.exists ? ` (${s.file}, ${ageText(s.ageMs)})` : ' (none saved yet)';
  });
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // The config and the assistant as the driver read them (again after a switch of folder).
    effect(() => {
      const c = this.driver.cfg();
      const a = this.driver.agent();
      untracked(() => {
        this.cfg.set({ ...c });
        if (['claude', 'gemini', 'codex'].includes(a)) this.choice.set(a);
        else if (a) {
          this.choice.set('custom');
          this.custom.set(a);
        } else this.choice.set(null);
      });
    });
    // The command line for the crawl, as the form changes.
    effect(() => {
      this.env.cwd();
      const body = this.form.body('crawl', false);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refreshCommand(body), 150);
    });
  }

  v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
  lines(x: unknown): string {
    return Array.isArray(x) ? x.join('\n') : '';
  }
  toLines(s: string): string[] {
    return s.split('\n').map((x) => x.trim()).filter(Boolean);
  }
  mode(m: AuthMode): void {
    this.form.choose(m);
  }
  set(key: string, value: unknown): void {
    this.cfg.update((c) => {
      const n = { ...c };
      if (value === '' || (Array.isArray(value) && !value.length)) delete n[key];
      else n[key] = value;
      return n;
    });
  }
  setNum(key: string, value: string): void {
    this.set(key, value === '' ? '' : Number(value));
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

  async choose(name: string): Promise<void> {
    this.choice.set(name);
    if (name !== 'custom') await this.saveAgent();
  }

  // The choice is remembered in the dashboard's settings (never in a repository's config); the
  // dashboard's own config records it too.
  async saveAgent(): Promise<void> {
    const spec = this.choice() === 'custom' ? this.custom().trim() : this.choice() || '';
    if (!spec || (this.choice() === 'custom' && !spec.includes('{promptFile}'))) return;
    await this.api.put('/api/settings', { agent: spec }).catch(() => {});
    this.driver.settingsAgent.set(spec);
    if (this.driver.repoConfig()) return;
    this.set('agent', spec);
    await this.saveConfig();
  }

  async saveConfig(): Promise<void> {
    if (this.driver.repoConfig()) {
      this.configStatus.set("Not saved: the repository's a11y-508.config.json is used as is.");
      return;
    }
    try {
      const r = await this.api.put<{ config: Record<string, any>; warnings: string[] }>('/api/config', { config: this.driver.completed(this.cfg(), false) });
      this.driver.cfg.set(r.config);
      this.driver.configExists.set(true);
      this.configErrors.set([]);
      this.configStatus.set(`Saved${r.warnings?.length ? ` (${r.warnings.join('; ')})` : ''}.`);
    } catch (e: any) {
      this.configErrors.set(e.body?.errors || [e.message]);
      this.configStatus.set('Not saved.');
    }
  }

  // A run in progress: nothing here changes it.
  readonly active = computed(() => this.run.active());
}
