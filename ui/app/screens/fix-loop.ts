import { Component, ElementRef, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { LineChartModule } from '@swimlane/ngx-charts';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { prefersReducedMotion } from '../core/motion';
import { AgentTest, LedgerInfo, Preset } from '../core/types';
import { ChartPanel } from '../shared/chart-panel';
import { RunView } from '../shared/run-view';

const STATUSES: [string, string][] = [
  ['open', 'Open'], ['review', 'Awaiting triage'], ['pending', 'Pending verification'], ['verified', 'Verified fixed'],
  ['needs-human', 'Needs a person'], ['adequate', 'Adequate'], ['gone', 'Gone'], ['wont-fix', "Won't fix"],
];
const LISTS: [string, string][] = [['open', 'Open'], ['pending', 'Pending verification'], ['review', 'Awaiting triage'], ['needs-human', 'Needs a person']];

@Component({
  selector: 'app-fix-loop-screen',
  imports: [ChartPanel, LineChartModule, RunView],
  template: `
    <h1>Fix loop</h1>
    @if (env.env()?.inGitRepo === false) {
      <p class="notice warn" role="status" data-testid="not-git">{{ env.env()?.cwd }} is not a git repository. The loop commits each fix, so it needs one; a dry run and a crawl do not.</p>
    }
    <p class="notice warn">The assistant's changes are committed without review. The <code>check</code> command below is the only gate between a fix and a commit.</p>

    <section aria-labelledby="agent-h">
      <h2 id="agent-h">Fixing assistant</h2>
      <fieldset class="picker" data-testid="picker">
        <legend>Choose the assistant the loop runs</legend>
        @for (p of presets(); track p.name) {
          <div class="choice preset" [class.missing]="!p.found" [attr.data-preset]="p.name" [attr.data-found]="p.found">
            <input type="radio" name="agent" [id]="'agent-' + p.name" [value]="p.name" [checked]="choice() === p.name" (change)="choose(p.name)" [attr.aria-describedby]="'agent-' + p.name + '-d'" />
            <label [for]="'agent-' + p.name">{{ p.label }}</label>
            <div class="desc" [id]="'agent-' + p.name + '-d'">
              @if (p.found) {
                <span data-testid="version">{{ p.version || 'version unknown' }}</span> · found {{ p.where === 'PATH' ? 'on PATH' : 'through ' + p.where }} at <code data-testid="where">{{ p.path }}</code><br />
                runs <code data-testid="agent-command">{{ p.command }}</code>
              } @else {
                <strong>not installed</strong>
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
            <input id="custom-command" type="text" [value]="custom()" (input)="custom.set($any($event.target).value)" (change)="saveAgent()" />
            @if (custom() && !custom().includes('{promptFile}')) {
              <p class="notice error" role="alert">The command must contain {{ '{' }}promptFile{{ '}' }}.</p>
            }
          </div>
        }
      </fieldset>

      @if (chosenPreset(); as p) {
        @if (!p.found) {
          <div class="install" data-testid="install-panel">
            <p>{{ p.label }} is not installed. It installs with <code data-testid="install-command">{{ p.install }}</code>, run in your shell, <strong data-testid="shell-name">{{ shell() }}</strong>.</p>
            <button type="button" (click)="askInstall()" [disabled]="store.active()">{{ installFailed() ? 'Retry' : 'Install' }}</button>
          </div>
        }
      }
      <dialog #confirm aria-labelledby="confirm-h" data-testid="install-confirm">
        <h2 id="confirm-h">Install {{ chosenPreset()?.label }}?</h2>
        <p>This runs <code>{{ chosenPreset()?.install }}</code> in {{ shell() }} as a login shell.</p>
        <div class="actions">
          <button type="button" (click)="install()">Run the install</button>
          <button type="button" class="secondary" (click)="confirmDialog()?.nativeElement?.close()">Cancel</button>
        </div>
      </dialog>
      @if (store.kind() === 'install') {
        <section aria-labelledby="install-h" data-testid="install-run">
          <h3 id="install-h">Installing {{ store.run()?.['agent'] }}</h3>
          <pre data-testid="install-output" tabindex="0" aria-label="Install output">{{ installOutput() }}</pre>
          @if (store.done(); as d) {
            @if (d['found']) {
              <p class="ok" role="status" data-testid="install-result">Installed. {{ store.run()?.['agent'] }} is ready to use.</p>
            } @else {
              <div class="notice error" role="alert" data-testid="install-result">
                <p>The install did not make the assistant available (exit code <span data-testid="install-code">{{ d['code'] }}</span>).</p>
                @for (r of store.remedies(); track r.id) {
                  <div class="remedy" [attr.data-remedy]="r.id">
                    <p>{{ r.text }}</p>
                    @if (r.command) {
                      <pre data-testid="remedy-command" tabindex="0" aria-label="Remedy command">{{ r.command }}</pre>
                      <button type="button" class="secondary small" (click)="copy(r.command)">Copy<span class="visually-hidden"> the command for {{ r.id }}</span></button>
                    }
                  </div>
                }
              </div>
            }
          }
        </section>
      }

      <div class="actions">
        <button type="button" class="secondary" (click)="testAgent()" [disabled]="testing() || !agentSpec()">Test assistant</button>
        <span role="status" data-testid="test-status">{{ testing() ? 'Testing… this calls the assistant once.' : testText() }}</span>
      </div>
      @if (testResult(); as t) {
        @if (t.status !== 'ready' && t.output.length) {
          <pre data-testid="test-output" tabindex="0" aria-label="Assistant output">{{ t.output.join('\\n') }}</pre>
        }
      }
    </section>

    <section aria-labelledby="config-h">
      <h2 id="config-h">Loop settings (a11y-508.config.json)</h2>
      <form (submit)="$event.preventDefault(); saveConfig()" class="config" data-testid="config-form">
        <div class="field"><label for="c-url">Start URL</label><input id="c-url" type="url" [value]="cfg()['url'] || ''" (input)="set('url', v($event))" /></div>
        <div class="field"><label for="c-args">Crawl options, one per line</label><textarea id="c-args" rows="2" [value]="lines(cfg()['args'])" (input)="set('args', toLines(v($event)))"></textarea></div>
        <div class="field"><label for="c-source">Folders the assistant may edit, one per line</label><textarea id="c-source" rows="2" [value]="lines(cfg()['source'])" (input)="set('source', toLines(v($event)))"></textarea></div>
        <div class="field"><label for="c-check">Check command (build and test)</label><input id="c-check" type="text" [value]="cfg()['check'] || ''" (input)="set('check', v($event))" /></div>
        <div class="field"><label for="c-checkEvery">Run the check</label>
          <select id="c-checkEvery" (change)="set('checkEvery', v($event))"><option value="finding" [selected]="cfg()['checkEvery'] !== 'round'">after each fix</option><option value="round" [selected]="cfg()['checkEvery'] === 'round'">once per round</option></select></div>
        <div class="field"><label for="c-branch">Branch to commit on</label><input id="c-branch" type="text" [value]="cfg()['branch'] || ''" (input)="set('branch', v($event))" /></div>
        <div class="choice"><input id="c-push" type="checkbox" [checked]="cfg()['push'] !== false" (change)="set('push', $any($event.target).checked)" /><label for="c-push">Push each round's commits</label></div>
        <div class="field"><label for="c-deployed">How the loop knows the new build is live</label>
          <select id="c-deployed" (change)="set('deployed', v($event))">
            @for (d of deployedOptions; track d[0]) { <option [value]="d[0]" [selected]="(cfg()['deployed'] || '') === d[0]">{{ d[1] }}</option> }
          </select></div>
        <div class="field"><label for="c-deploy">Deploy command</label><input id="c-deploy" type="text" [value]="cfg()['deploy'] || ''" (input)="set('deploy', v($event))" /></div>
        <div class="field"><label for="c-maxAttempts">Fix attempts per finding</label><input id="c-maxAttempts" type="number" min="1" [value]="cfg()['maxAttempts'] ?? ''" (input)="setNum('maxAttempts', v($event))" /></div>
        <div class="field"><label for="c-deployTimeout">Deploy timeout (ms)</label><input id="c-deployTimeout" type="number" min="0" [value]="cfg()['deployTimeout'] ?? ''" (input)="setNum('deployTimeout', v($event))" /></div>
        <div class="field"><label for="c-agentTimeout">Assistant timeout per task (ms)</label><input id="c-agentTimeout" type="number" min="0" [value]="cfg()['agentTimeout'] ?? ''" (input)="setNum('agentTimeout', v($event))" /></div>
        <div class="field"><label for="c-triageBatch">Review items per triage prompt</label><input id="c-triageBatch" type="number" min="1" [value]="cfg()['triageBatch'] ?? ''" (input)="setNum('triageBatch', v($event))" /></div>
        <div class="actions"><button type="submit" class="secondary">Save settings</button><span role="status" data-testid="config-status">{{ configStatus() }}</span></div>
        @if (configErrors().length) {
          <div class="notice error" role="alert" data-testid="config-errors"><ul>@for (e of configErrors(); track $index) { <li>{{ e }}</li> }</ul></div>
        }
      </form>
    </section>

    <section aria-labelledby="run-h">
      <h2 id="run-h">Run the loop</h2>
      @if (!cfg()['check']) {
        <div class="choice"><input id="no-gate" type="checkbox" [checked]="noGate()" (change)="noGate.set($any($event.target).checked)" /><label for="no-gate">Run without a check command (fixes are committed with no build or test gate)</label></div>
      }
      <div class="field small"><label for="rounds-to-run">Rounds to run</label><input id="rounds-to-run" type="number" min="1" [value]="rounds()" (input)="rounds.set(v($event))" /></div>
      <div class="actions">
        <button type="button" class="secondary" (click)="startLoop('dry-run')" [disabled]="store.active()">Dry run</button>
        <button type="button" (click)="startLoop('loop')" [disabled]="!canStart()" data-testid="loop-start">Start</button>
        <button type="button" class="secondary" (click)="store.stop()" [disabled]="!store.active() || !isLoop()">Stop</button>
        @if (startWarning()) { <span class="hint warn-text" data-testid="start-warning">{{ startWarning() }}</span> }
      </div>
      @if (runError()) { <div class="notice error" role="alert">{{ runError() }}</div> }
      @if (store.awaitingDeploy()) {
        <div class="notice warn" role="status">
          <p>The round's fixes are committed. Deploy them, then continue.</p>
          <button type="button" (click)="store.continueAfterDeploy()">Deployed — continue</button>
        </div>
      }
      @if (isLoop()) {
        <p role="status" data-testid="loop-step">{{ stepText() }}</p>
        <app-run-view [showChart]="false" />
      }
    </section>

    <section aria-labelledby="ledger-h">
      <h2 id="ledger-h">Ledger</h2>
      @if (ledger()?.exists) {
        <p data-testid="ledger-line">{{ ledger()?.line }}</p>
        <dl class="tiles" data-testid="ledger-counts">
          @for (s of statuses; track s[0]) {
            <div class="tile" [attr.data-status]="s[0]"><dt>{{ s[1] }}</dt><dd>{{ ledger()?.counts?.[s[0]] || 0 }}</dd></div>
          }
        </dl>
        @for (l of lists; track l[0]) {
          @if (ledger()?.lists?.[l[0]]?.length) {
            <h3>{{ l[1] }} ({{ ledger()?.lists?.[l[0]]?.length }})</h3>
            <ul class="ledger-list" [attr.data-list]="l[0]">
              @for (e of ledger()?.lists?.[l[0]]; track $index) {
                <li>{{ e.test }} {{ e.impact }}: {{ e.message }} [{{ e.pages }} page(s), {{ e.attempts }} attempt(s)]{{ e.reason ? ' ' + e.reason : '' }}</li>
              }
            </ul>
          }
        }
        @if (roundRows().length) {
          <app-chart-panel id="rounds" heading="Open and verified findings by round" [columns]="roundCols" [rows]="roundRows()">
            <ngx-charts-line-chart [view]="[640, 240]" [results]="roundSeries()" [xAxis]="true" [yAxis]="true" [legend]="true" legendTitle="Findings" [showXAxisLabel]="true" xAxisLabel="Round" [animations]="animations" [tooltipDisabled]="true" />
          </app-chart-panel>
        }
      } @else {
        <p>No ledger yet. A dry run records what the crawl finds without changing anything.</p>
      }
    </section>
  `,
})
export class FixLoopScreen implements OnInit {
  private api = inject(Api);
  readonly env = inject(EnvStore);
  readonly store = inject(RunStore);
  private form = inject(FormStore);
  readonly confirmDialog = viewChild<ElementRef<HTMLDialogElement>>('confirm');
  readonly animations = !prefersReducedMotion();
  readonly statuses = STATUSES;
  readonly lists = LISTS;
  readonly deployedOptions: [string, string][] = [['', 'the default (command if a deploy command is set, else press Continue)'], ['command', 'run the deploy command'], ['bundle-change', "watch the start page's bundles change"], ['enter', 'I press Deployed — continue'], ['none', 'no deploy (served from the working tree)']];

  readonly cfg = signal<Record<string, any>>({});
  readonly configErrors = signal<string[]>([]);
  readonly configStatus = signal('');
  readonly choice = signal<string | null>(null);
  readonly custom = signal('');
  readonly testResult = signal<AgentTest | null>(null);
  readonly testing = signal(false);
  readonly noGate = signal(false);
  readonly rounds = signal('20');
  readonly runError = signal('');
  readonly ledger = signal<LedgerInfo | null>(null);

  readonly presets = computed<Preset[]>(() => this.env.env()?.presets || []);
  readonly shell = computed(() => this.env.env()?.shell?.name || 'your shell');
  readonly chosenPreset = computed(() => this.presets().find((p) => p.name === this.choice()) || null);
  readonly agentSpec = computed(() => (this.choice() === 'custom' ? this.custom().trim() : this.choice()) || '');
  readonly agentReady = computed(() => (this.choice() === 'custom' ? this.custom().includes('{promptFile}') : !!this.chosenPreset()?.found));
  readonly isLoop = computed(() => ['loop', 'dry-run'].includes(this.store.kind() || ''));
  readonly canStart = computed(() => this.agentReady() && (!!this.cfg()['check'] || this.noGate()) && !this.store.active());
  readonly installFailed = computed(() => this.store.kind() === 'install' && !!this.store.done() && !this.store.done()!['found']);
  readonly installOutput = computed(() => this.store.raw().map((l) => l.replace(/^! /, '')).join('\n'));
  readonly testText = computed(() => {
    const t = this.testResult();
    if (!t) return '';
    if (t.status === 'ready') return `ready (answered in ${(t.durationMs / 1000).toFixed(1)}s)`;
    if (t.status === 'timed-out') return 'timed out';
    return 'not signed in or failed';
  });
  readonly startWarning = computed(() => {
    if (!this.agentReady()) return 'Choose an installed assistant first.';
    const t = this.testResult();
    if (!t) return 'The assistant has not been tested yet.';
    if (t.status !== 'ready') return 'The last test of this assistant did not pass.';
    return '';
  });
  readonly stepText = computed(() => {
    const r = this.store.round();
    const s = this.store.step();
    const t = this.store.task();
    if (this.store.done()) return `${this.store.kind() === 'dry-run' ? 'Dry run' : 'Loop'} finished${this.store.done()?.['outcome'] === 'stopped' ? ' (stopped)' : ''}.`;
    if (!r) return 'Starting…';
    if (this.store.awaitingDeploy()) return `Round ${r}: waiting for deploy`;
    const step = s?.['step'];
    if (step === 'fix' || step === 'gate' || step === 'commit') return `Round ${r}: ${step === 'fix' ? '' : step + ', '}fix ${t?.n || 0} of ${t?.m || 0}`;
    if (step === 'deploy' || step === 'await-deploy') return `Round ${r}: waiting for deploy`;
    return `Round ${r}: ${step || 'crawl'}`;
  });

  readonly roundCols = [{ key: 'round', label: 'Round' }, { key: 'open', label: 'Open violations' }, { key: 'verified', label: 'Verified fixed (total)' }];
  readonly roundRows = computed(() => {
    let verified = 0;
    return (this.ledger()?.rounds || []).map((r) => {
      verified += r.diff['verified'] || 0;
      return { round: r.round, open: r.violations, verified };
    });
  });
  readonly roundSeries = computed(() => [
    { name: 'Open violations', series: this.roundRows().map((r) => ({ name: String(r.round), value: r.open })) },
    { name: 'Verified fixed', series: this.roundRows().map((r) => ({ name: String(r.round), value: r.verified })) },
  ]);

  constructor() {
    effect(() => {
      this.store.ledger();
      this.store.done();
      this.env.cwd();
      void this.loadLedger();
    });
    // After a switch of directory, the new directory's config; an edit in
    // progress is discarded (the server never saw it).
    let seen: string | null = null;
    effect(() => {
      const cwd = this.env.cwd();
      untracked(() => {
        if (!cwd) return;
        if (seen && seen !== cwd) void this.loadConfig();
        seen = cwd;
      });
    });
    effect(() => {
      const d = this.store.done();
      if (d && this.store.kind() === 'install') void this.env.load();
    });
  }

  async ngOnInit(): Promise<void> {
    await this.env.load();
    await this.loadConfig();
  }

  private configLoads = 0;
  async loadConfig(): Promise<void> {
    const n = ++this.configLoads;
    let c: { config: Record<string, any> } | null = null;
    try {
      c = await this.api.get<{ config: Record<string, any> }>('/api/config');
    } catch {}
    if (n !== this.configLoads || !c) return;
    this.cfg.set(c.config || {});
    this.configErrors.set([]);
    this.configStatus.set('');
    const a = c.config?.['agent'];
    this.choice.set(null);
    this.custom.set('');
    if (a) {
      if (['claude', 'gemini', 'codex'].includes(a)) this.choice.set(a);
      else {
        this.choice.set('custom');
        this.custom.set(a);
      }
    }
    const spec = this.agentSpec();
    this.testResult.set((spec && this.env.env()?.lastTest?.[spec]) || null);
  }

  private ledgerLoads = 0;
  async loadLedger(): Promise<void> {
    const n = ++this.ledgerLoads;
    try {
      const l = await this.api.get<LedgerInfo>('/api/ledger');
      if (n === this.ledgerLoads) this.ledger.set(l);
    } catch {}
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

  async choose(name: string): Promise<void> {
    this.choice.set(name);
    const spec = this.agentSpec();
    this.testResult.set((spec && this.env.env()?.lastTest?.[spec]) || null);
    if (name !== 'custom') await this.saveAgent();
  }

  async saveAgent(): Promise<void> {
    const spec = this.agentSpec();
    if (!spec || (this.choice() === 'custom' && !spec.includes('{promptFile}'))) return;
    this.set('agent', spec);
    await this.saveConfig();
  }

  async saveConfig(): Promise<void> {
    const c = { ...this.cfg() };
    if (!c['url'] && this.form.url()) c['url'] = this.form.url();
    try {
      const r = await this.api.put<{ config: Record<string, any>; warnings: string[] }>('/api/config', { config: c });
      this.cfg.set(r.config);
      this.configErrors.set([]);
      this.configStatus.set(`Saved${r.warnings?.length ? ` (${r.warnings.join('; ')})` : ''}.`);
    } catch (e: any) {
      this.configErrors.set(e.body?.errors || [e.message]);
      this.configStatus.set('Not saved.');
    }
  }

  askInstall(): void {
    this.confirmDialog()?.nativeElement.showModal();
  }

  async install(): Promise<void> {
    this.confirmDialog()?.nativeElement.close();
    const p = this.chosenPreset();
    if (!p) return;
    try {
      await this.store.install(p.name);
    } catch (e: any) {
      this.runError.set(e.message);
    }
  }

  async testAgent(): Promise<void> {
    this.testing.set(true);
    try {
      this.testResult.set(await this.api.post<AgentTest>('/api/agent/test', { agent: this.agentSpec() }));
    } catch (e: any) {
      this.testResult.set({ agent: this.agentSpec(), command: '', status: 'failed', code: null, durationMs: 0, output: [e.message] });
    } finally {
      this.testing.set(false);
    }
  }

  async startLoop(kind: 'loop' | 'dry-run'): Promise<void> {
    this.runError.set('');
    try {
      await this.store.start({ kind, maxRounds: kind === 'loop' ? this.rounds() : undefined, auth: this.form.auth(true), agent: kind === 'loop' ? this.agentSpec() : undefined });
      this.form.clearToken();
    } catch (e: any) {
      this.runError.set(e.message);
    }
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  }
}
