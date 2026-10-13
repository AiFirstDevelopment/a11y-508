import { Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { LineChartModule } from '@swimlane/ngx-charts';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { detailsOpen, setDetailsOpen } from '../core/details';
import { Starter } from '../core/starter';
import { EnvStore } from '../core/env.store';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { prefersReducedMotion } from '../core/motion';
import { localTime } from '../core/format';
import { AgentTest, LedgerInfo, LoopDefaults, LoopMatch, Preset } from '../core/types';
import { ChartPanel } from '../shared/chart-panel';
import { RunView } from '../shared/run-view';

const STATUSES: [string, string][] = [
  ['open', 'Open'], ['review', 'Awaiting triage'], ['pending', 'Pending verification'], ['verified', 'Verified fixed'],
  ['needs-human', 'Needs a person'], ['adequate', 'Adequate'], ['gone', 'Gone'], ['wont-fix', "Won't fix"],
];
const LISTS: [string, string][] = [['open', 'Open'], ['pending', 'Pending verification'], ['review', 'Awaiting triage'], ['needs-human', 'Needs a person']];
// The installed assistant chosen when the config names none.
const PREFERENCE = ['claude', 'gemini', 'codex'];
const OUTCOMES: Record<string, string> = { committed: 'committed', 'no-change': 'no change', 'failed-gate': 'failed the gate', 'commit-failed': 'commit failed', 'timed-out': 'timed out', stopped: 'stopped', done: 'done', ended: 'ended' };

// The Fix loop: it works out what it can (the assistant, the folders, the gate, the branch)
// and shows it, with one button; everything it inferred is editable at /fix-loop/settings.
@Component({
  selector: 'app-fix-loop-screen',
  imports: [ChartPanel, LineChartModule, RunView, RouterLink],
  template: `
    <h1>Fix loop</h1>
    @if (!(store.kind() === 'loop' && store.round())) {
      <p class="hint" data-testid="loop-explainer">Each round re-checks the site, fixes what is open one finding at a time, gates every fix with your build, commits, and waits for the new build before checking again.</p>
    }

    <p data-testid="assistant-line">
      @if (env.env()?.detecting) {
        <span role="status">Detecting assistants…</span>
      } @else if (assistantLabel(); as label) {
        Fixing with <strong>{{ label }}</strong>@if (assistantVersion(); as v) { <span> ({{ v }})</span> }
        <button type="button" class="link" (click)="pickerOpen.set(!pickerOpen())" [attr.aria-expanded]="showPicker()" aria-controls="agent-picker">change<span class="visually-hidden"> the assistant</span></button>
      } @else if (env.env()) {
        No assistant is installed yet. Install one below.
      }
    </p>
    @if (showPicker()) {
      <section id="agent-picker" aria-label="Choose the assistant">
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
                  @if (runCommandFor(p); as rc) {
                    <br />by hand, in your shell: <code data-testid="run-command">{{ rc }}</code>
                    <button type="button" class="secondary small" (click)="copy(rc, p.name)">Copy<span class="visually-hidden"> the command for {{ p.label }}</span></button>
                    <span role="status" class="hint">{{ copied() === p.name ? 'Copied.' : '' }}</span>
                    @if (!store.agentCall()) { <span class="hint"> ({{ promptNote }})</span> }
                  }
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
            <pre data-testid="install-output" tabindex="0" role="region" aria-label="Install output">{{ installOutput() }}</pre>
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
                        <pre data-testid="remedy-command" tabindex="0" role="region" [attr.aria-label]="'Remedy command: ' + r.id">{{ r.command }}</pre>
                        <button type="button" class="secondary small" (click)="copy(r.command, r.id)">Copy<span class="visually-hidden"> the command for {{ r.id }}</span></button>
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
            <pre data-testid="test-output" tabindex="0" role="region" aria-label="Assistant output">{{ t.output.join('\\n') }}</pre>
          }
        }
      </section>
    }

    @if (!isLoop() || store.kind() !== 'loop' || loopEnded()) {
    @if (repoConfig()) {
      <p class="hint" data-testid="repo-config">Using the repository's a11y-508.config.json</p>
    }
    <p data-testid="loop-plan">
      @if (!defaults()) {
        <span class="hint">Reading the repository…</span>
      } @else if (!repoOk()) {
        @if (defaults() && !defaults()!.repo.git) {
          <span class="wrap" data-testid="not-git">Choose the app's repository on <a routerLink="/run">Set up</a>; {{ env.cwd() }} {{ repoProblem() }}.</span>
        } @else {
          <span class="wrap" data-testid="no-package">Choose the app's repository on <a routerLink="/run">Set up</a>; {{ env.cwd() }} {{ repoProblem() }}.</span>
        }
      } @else if (plan(); as pl) {
        Edits <code>{{ pl.source }}</code> · @if (pl.check) {gate <code>{{ pl.check }}</code>} @else {no build or test command found, fixes are committed without a gate} · commits to branch <code>{{ pl.branch }}</code> · @if (pl.push && pl.remote) {pushes to <code>{{ pl.remote }}</code>} @else {does not push}
      }
    </p>
    @if (!loopUrl()) {
      <p class="hint" data-testid="no-url">No start URL yet: run a crawl from Run first.</p>
    }
    @if (wrongRepo() && !store.active()) {
      <div class="notice warn" role="alert" data-testid="wrong-repo">
        <p>This repository does not seem to contain the app's code: none of the findings' markup was found under @for (d of match()!.source; track d; let last = $last) {<code>{{ d }}</code>@if (!last) {, }}. Choose the app's repository on <a routerLink="/run">Set up</a>.</p>
        @if (!startAnyway()) {
          <button type="button" class="link small" (click)="startAnyway.set(true)" data-testid="start-anyway">Start anyway</button>
        }
      </div>
    }

    }
    @if (isLoop() && store.kind() === 'loop') {
      @if (problem(); as pr) {
        <!-- It ended for a reason: what happened and what to do, in the main view. -->
        <section class="notice error" role="alert" aria-labelledby="loop-problem-h" data-testid="loop-problem" [attr.data-kind]="pr.kind">
          <h2 id="loop-problem-h">{{ pr.kind === 'start' ? 'The fix loop could not start' : 'The fix loop stopped' }}</h2>
          <p class="wrap" data-testid="problem-message">{{ pr.message }}</p>
          @if (pr.remedy) { <p class="wrap" data-testid="problem-remedy">{{ pr.remedy }}</p> }
        </section>
        @if (pr.kind === 'stopped') { <p data-testid="fix-counts">{{ fixCounts() }}</p> }
      } @else {
      <!-- While it runs: one line, a bar, counts, and the assistant's last line. -->
      <p class="big-status" role="status" data-testid="fix-status">{{ fixStatus() }}</p>
      @if (store.task(); as t) {
        @if (t.m) {
          <div class="thin-progress">
            <progress aria-labelledby="fix-count" [value]="t.n" [max]="t.m"></progress>
            <span id="fix-count" data-testid="fix-count">{{ t.n }} of {{ t.m }} fixes</span>
          </div>
        }
      }
      <p data-testid="fix-counts">{{ fixCounts() }}</p>
      }
    }
    @if (paneShown()) {
      @if (lastLine(); as ll) { <p class="hint last-line" data-testid="agent-last-line">{{ ll }}</p> }
      <details class="details" data-testid="show-output" [open]="showOutput()" (toggle)="outputToggled($event)">
        <summary>Show output</summary>
      <section class="agent-pane" aria-labelledby="pane-h" data-testid="agent-pane">
        <div class="pane-head">
          <h2 id="pane-h" data-testid="agent-heading">{{ paneHeading() }}</h2>
          <div class="choice"><input type="checkbox" id="pane-follow" [checked]="follow()" (change)="setFollow($any($event.target).checked)" /><label for="pane-follow">Follow</label></div>
        </div>
        <pre #pane class="pane" role="log" aria-live="off" aria-labelledby="pane-h" tabindex="0" data-testid="agent-output" (scroll)="onPaneScroll()">{{ paneText() }}</pre>
      </section>
      </details>
    }
    <div class="actions">
      @if (isLoop() && store.active()) {
        <button type="button" class="big" (click)="store.stop()" data-testid="loop-stop">Stop</button>
      } @else if (problem(); as pr) {
        <button type="button" class="big" (click)="tryAgain()" [disabled]="store.active()" data-testid="try-again">Try again</button>
        @if (pr.kind === 'stopped') {
          <button type="button" class="secondary" (click)="runAgain()" [disabled]="store.active()" data-testid="run-again">Run again</button>
          <a class="button secondary" routerLink="/history" data-testid="see-changes">See what changed</a>
        }
      } @else if (loopEnded()) {
        <a class="button big" routerLink="/history" data-testid="see-changes">See what changed</a>
        <button type="button" class="secondary" (click)="runAgain()" [disabled]="store.active()" data-testid="run-again">Run again</button>
      } @else {
        <button type="button" class="big" (click)="fix()" [disabled]="!canStart()" data-testid="loop-start">Fix the violations</button>
      }
      @if (startWarning()) { <span class="hint warn-text" data-testid="start-warning">{{ startWarning() }}</span> }
    </div>
    @if (runError()) { <div class="notice error" role="alert">{{ runError() }}</div> }
    @if (waitingForBuild()) {
      <div class="notice warn" role="status" data-testid="awaiting-deploy">
        <p>Fixes are committed and pushed. Waiting for the new build on {{ host() }}…</p>
        <button type="button" (click)="store.continueAfterDeploy()">Deployed — continue</button>
      </div>
    }
    <details class="details" data-testid="details" [open]="showDetails()" (toggle)="toggled($event)">
      <summary>Details<span class="visually-hidden"> of the fix loop</span></summary>
    @if (isLoop() && problem()?.kind !== 'start') {
      <p role="status" data-testid="loop-step">{{ stepText() }}</p>
      @if (store.loginWaiting() && store.active()) {
        <p class="notice" role="status" data-testid="loop-login-waiting">A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded.</p>
      }
      <app-run-view [showChart]="false" [links]="false" />
    }

    @if (ledger()?.exists) {
      <section aria-labelledby="ledger-h">
        <h2 id="ledger-h">Ledger</h2>
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
      </section>
    } @else if (ledger()) {
      <p class="hint">No ledger yet. A dry run records what the crawl finds without changing anything.</p>
    }

    </details>

    <!-- Every loop setting lives at /fix-loop/settings, which nothing links to. -->
    @if (settings()) {
    <section data-testid="loop-more" aria-labelledby="settings-h">
      <h2 id="settings-h">Loop settings</h2>
      <form (submit)="$event.preventDefault(); saveConfig()" class="config" data-testid="config-form">
        <p class="hint">Settings are saved to a11y-508.config.json as you change them.</p>
        <div class="field"><label for="c-url">Start URL</label><input id="c-url" type="url" [value]="cfg()['url'] || loopUrl()" (input)="set('url', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-args">Crawl options, one per line</label><textarea id="c-args" rows="2" [value]="lines(cfg()['args'])" (input)="set('args', toLines(v($event)))" (change)="saveConfig()"></textarea></div>
        <div class="field"><label for="c-source">Folders the assistant may edit, one per line</label><textarea id="c-source" rows="2" [value]="lines(cfg()['source'] || plan()?.sourceList)" (input)="set('source', toLines(v($event)))" (change)="saveConfig()"></textarea></div>
        <div class="field"><label for="c-check">Check command (build and test)</label><input id="c-check" type="text" [value]="cfg()['check'] ?? (plan()?.check || '')" (input)="set('check', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-checkEvery">Run the check</label>
          <select id="c-checkEvery" (change)="set('checkEvery', v($event)); saveConfig()"><option value="finding" [selected]="cfg()['checkEvery'] !== 'round'">after each fix</option><option value="round" [selected]="cfg()['checkEvery'] === 'round'">once per round</option></select></div>
        <div class="field"><label for="c-branch">Branch to commit on</label><input id="c-branch" type="text" [value]="cfg()['branch'] || plan()?.branch || ''" (input)="set('branch', v($event))" (change)="saveConfig()" /></div>
        <div class="choice"><input id="c-push" type="checkbox" [checked]="cfg()['push'] ?? plan()?.push ?? true" (change)="set('push', $any($event.target).checked); saveConfig()" /><label for="c-push">Push each round's commits</label></div>
        <div class="field"><label for="c-maxAttempts">Fix attempts per finding</label><input id="c-maxAttempts" type="number" min="1" [value]="cfg()['maxAttempts'] ?? plan()?.maxAttempts ?? ''" (input)="setNum('maxAttempts', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-rounds">Rounds per run</label><input id="c-rounds" type="number" min="1" [value]="rounds() || ''" placeholder="20" (change)="saveRounds(v($event))" /></div>
        <div class="field"><label for="c-agentTimeout">Assistant timeout per task (ms)</label><input id="c-agentTimeout" type="number" min="0" [value]="cfg()['agentTimeout'] ?? ''" (input)="setNum('agentTimeout', v($event))" (change)="saveConfig()" /></div>
        <div class="field"><label for="c-triageBatch">Review items per triage prompt</label><input id="c-triageBatch" type="number" min="1" [value]="cfg()['triageBatch'] ?? ''" (input)="setNum('triageBatch', v($event))" (change)="saveConfig()" /></div>
        <p><span role="status" data-testid="config-status">{{ configStatus() }}</span></p>
        @if (configErrors().length) {
          <div class="notice error" role="alert" data-testid="config-errors"><ul>@for (e of configErrors(); track $index) { <li>{{ e }}</li> }</ul></div>
        }
      </form>
      <div class="actions">
        <button type="button" class="secondary small" (click)="startLoop('dry-run')" [disabled]="store.active()">Record findings without fixing</button>
        <span class="hint">A dry run: one crawl, recorded in the ledger; nothing is changed.</span>
      </div>
    </section>
    }
  `,
})
export class FixLoopScreen implements OnInit, OnDestroy {
  // Route data: true on /fix-loop/settings, where every loop setting is.
  readonly settings = input(false);
  // ?start=1: Results' "Fix the violations" (start once everything is loaded).
  readonly startParam = input<string | undefined>(undefined, { alias: 'start' });
  private starter = inject(Starter);
  readonly showDetails = signal(detailsOpen('fix'));
  // Rounds per Fix the violations (the dashboard's setting; the loop's own default is 20).
  readonly rounds = signal<number | null>(null);
  async saveRounds(v: string): Promise<void> {
    const n = parseInt(v, 10);
    const value = n >= 1 ? n : null;
    this.rounds.set(value);
    try {
      await this.api.put('/api/settings', { rounds: value });
      this.configStatus.set('Saved.');
    } catch (e: any) {
      this.configStatus.set(`Not saved: ${e.message}`);
    }
  }
  readonly showOutput = signal(detailsOpen('output'));
  toggled(e: Event): void {
    const open = (e.target as HTMLDetailsElement).open;
    this.showDetails.set(open);
    setDetailsOpen('fix', open);
  }
  outputToggled(e: Event): void {
    const open = (e.target as HTMLDetailsElement).open;
    this.showOutput.set(open);
    setDetailsOpen('output', open);
  }
  private api = inject(Api);
  readonly env = inject(EnvStore);
  readonly store = inject(RunStore);
  private form = inject(FormStore);
  readonly confirmDialog = viewChild<ElementRef<HTMLDialogElement>>('confirm');
  private paneEl = viewChild<ElementRef<HTMLPreElement>>('pane');
  readonly animations = !prefersReducedMotion();
  readonly statuses = STATUSES;
  readonly lists = LISTS;
  readonly promptNote = 'the prompt file the loop writes';

  readonly cfg = signal<Record<string, any>>({});
  readonly configExists = signal(false);
  // The repository's own a11y-508.config.json (a team's): used as is, never written.
  readonly repoConfig = signal(false);
  readonly defaults = signal<LoopDefaults | null>(null);
  readonly configErrors = signal<string[]>([]);
  readonly configStatus = signal('');
  readonly choice = signal<string | null>(null);
  readonly custom = signal('');
  readonly testResult = signal<AgentTest | null>(null);
  readonly testing = signal(false);
  readonly testStartedAt = signal(0);
  readonly runError = signal('');
  readonly ledger = signal<LedgerInfo | null>(null);
  readonly pickerOpen = signal(false);
  readonly copied = signal('');
  readonly follow = signal(true);
  readonly now = signal(Date.now());
  private detectPoll: any = null;
  private ticker: any = setInterval(() => this.now.set(Date.now()), 1000);

  readonly presets = computed<Preset[]>(() => this.env.env()?.presets || []);
  readonly shell = computed(() => this.env.env()?.shell?.name || 'your shell');
  readonly chosenPreset = computed(() => this.presets().find((p) => p.name === this.choice()) || null);
  readonly agentSpec = computed(() => (this.choice() === 'custom' ? this.custom().trim() : this.choice()) || '');
  readonly agentReady = computed(() => (this.choice() === 'custom' ? this.custom().includes('{promptFile}') : !!this.chosenPreset()?.found));
  readonly anyInstalled = computed(() => this.presets().some((p) => p.found));
  readonly showPicker = computed(() => !!this.env.env() && !this.env.env()!.detecting && (this.pickerOpen() || !this.anyInstalled() || (!!this.chosenPreset() && !this.chosenPreset()!.found) || this.store.kind() === 'install'));
  readonly assistantLabel = computed(() => (this.choice() === 'custom' ? 'a custom command' : this.chosenPreset()?.found ? this.chosenPreset()!.label : null));
  readonly assistantVersion = computed(() => (this.choice() === 'custom' ? null : this.chosenPreset()?.version || (this.chosenPreset()?.found ? 'version unknown' : null)));
  readonly isLoop = computed(() => ['loop', 'dry-run'].includes(this.store.kind() || ''));
  readonly installFailed = computed(() => this.store.kind() === 'install' && !!this.store.done() && !this.store.done()!['found']);
  readonly installOutput = computed(() => this.store.raw().map((l) => l.replace(/^! /, '')).join('\n'));

  // The start URL: the config's, else the one remembered from the Run screen.
  readonly loopUrl = computed(() => String(this.cfg()['url'] || this.form.url() || '').trim());
  readonly repoOk = computed(() => !!this.defaults()?.repo.git && !!this.defaults()?.package.exists);
  readonly repoProblem = computed(() => {
    const d = this.defaults();
    if (!d) return 'is being read';
    if (!d.repo.git && !d.package.exists) return 'is not a git repository and has no package.json';
    return !d.repo.git ? 'is not a git repository' : 'has no package.json';
  });
  readonly plan = computed(() => {
    const d = this.defaults();
    if (!d) return null;
    const c = this.cfg();
    const sourceList: string[] = Array.isArray(c['source']) && c['source'].length ? c['source'] : d.effective.source;
    return {
      sourceList,
      source: sourceList.join(', '),
      check: (c['check'] ?? d.effective.check) || null,
      // The branch the loop will really commit on: the server's, unless the person typed another.
      branch: !c['branch'] || c['branch'] === d.branch?.wanted ? d.effective.branch : c['branch'],
      push: c['push'] ?? d.effective.push,
      remote: d.repo.remote,
      maxAttempts: c['maxAttempts'] ?? d.effective.maxAttempts,
    };
  });
  // The loop has ended (nothing open, stopped, or out of rounds): the step's actions change.
  readonly loopEnded = computed(() => this.store.kind() === 'loop' && !!this.store.done());
  // The loop ended for a reason rather than finishing: before its first round it could not start
  // (a precondition event, with its remedy); after it, it stopped (the CLI's error says why).
  // Stopped by the person, or out of rounds, it simply finished.
  readonly problem = computed<{ kind: 'start' | 'stopped'; message: string; remedy: string | null } | null>(() => {
    const d = this.store.done();
    if (!this.loopEnded() || !d || d['outcome'] === 'stopped') return null;
    const pre = this.store.precondition();
    if (pre) return { kind: 'start', message: String(pre['message'] || ''), remedy: String(pre['remedy'] || '') || null };
    const errors = this.store.notices().filter((n) => n.level === 'error' && !/^The run failed \(exit code/.test(n.message)).map((n) => n.message);
    if (d['outcome'] !== 'error' && !errors.length) return null;
    const message = errors[errors.length - 1] || `The loop ended with exit code ${d['code']}.`;
    return { kind: this.store.round() === null ? 'start' : 'stopped', message, remedy: null };
  });
  // The status line, in words that explain what the loop is doing and why.
  readonly fixStatus = computed(() => {
    const r = this.store.round();
    const c = this.store.agentCall();
    const t = this.store.task();
    if (this.store.done()) return this.stepText();
    if (this.store.loginWaiting() && this.store.active()) return 'Waiting for you to sign in in the browser window';
    if (!r) return 'Starting…';
    const secs = (from: number) => `${Math.max(0, Math.round((this.now() - from) / 1000))} s`;
    const s = this.store.step();
    const step = s?.['step'];
    const n = this.store.committed();
    const waiting = `Committed ${n} fix${n === 1 ? '' : 'es'} · waiting for the new build on ${this.host()}…`;
    if (this.waitingForBuild()) return waiting;
    // The gate and the commit are this finding's while its task has not ended (or the round's, with no n).
    const current = s?.['n'] === undefined || (t?.n === s?.['n'] && t?.state === 'start');
    if (step === 'gate' && current) return `Round ${r}: checking the fixes${s?.['check'] ? ` (${s['check']})` : ''}`;
    if (step === 'commit' && current) return `Round ${r}: committing fix ${s?.['n']} of ${s?.['m']}`;
    const seen = r === this.store.reportRound() ? ' from the report you just saw' : '';
    if (c && !c.endedAt && c.kind === 'fix') return `Round ${r}: fixing ${c.n ?? c.task} of ${c.m ?? t?.m ?? '?'}${seen} · ${c.label} · ${secs(c.startedAt)}`;
    if (c && !c.endedAt && c.kind === 'triage') return `Round ${r}: triaging ${c.label}${seen}${c.m ? ` · call ${c.n ?? c.task} of ${c.m}` : ''} · ${secs(c.startedAt)}`;
    if (step === 'gate' || step === 'commit') return `Round ${r}: fixing ${t?.n ?? ''} of ${t?.m ?? ''}`;
    if (step === 'push') return `Round ${r}: pushing ${n} fix${n === 1 ? '' : 'es'}`;
    if (step === 'deploy' || step === 'await-deploy') return waiting;
    if (step === 'report') return `Round ${r}: starting from the report you just saw`;
    if (step === 'fix') return `Round ${r}: fixing ${t?.m ?? s?.['count'] ?? ''} open finding${(t?.m ?? s?.['count']) === 1 ? '' : 's'}`;
    if (step === 'triage') return `Round ${r}: triaging ${s?.['count']} review items`;
    // The crawl: the run's first round re-checks the site before anything is changed.
    const p = this.store.progress();
    const pages = p.discovered ? ` (${p.done} of ${p.discovered} pages)` : '';
    if (r === this.store.firstRound()) return `Round ${r}: re-checking the site first${pages} so fixes can be verified against it`;
    return `Round ${r}: re-checking the site${pages}`;
  });
  readonly fixCounts = computed(() => {
    const c = this.store.ledger()?.['counts'] || this.ledger()?.counts || {};
    const fixed = (c['verified'] || 0) + (c['pending'] || 0);
    const nh = c['needs-human'] || 0;
    return `${fixed} fixed · ${c['open'] || 0} remaining${nh ? ` · ${nh} need${nh === 1 ? 's' : ''} a person` : ''}`;
  });
  readonly lastLine = computed(() => {
    const t = this.paneText().split('\n').map((l) => l.trim()).filter(Boolean);
    return t.length ? t[t.length - 1].slice(0, 200) : '';
  });

  // Run again: the next crawl (a fresh sign-in window) from the same set up; Results, then Fix.
  async runAgain(): Promise<void> {
    this.runError.set('');
    try {
      await this.starter.startCrawl(this.loopUrl());
    } catch (e: any) {
      this.runError.set(e.message);
    }
  }

  // Try again: the same loop as Fix the violations, from the same latest report (no new crawl);
  // the loop continues from its ledger. The repository is read again first: the remedy may have changed it.
  async tryAgain(): Promise<void> {
    this.runError.set('');
    const anyway = this.startAnyway();
    await this.loadDefaults();
    this.startAnyway.set(anyway);
    if (!this.canStart()) {
      const why = this.startWarning() || (!this.repoOk() ? `${this.env.cwd()} ${this.repoProblem()}.` : !this.loopUrl() ? 'There is no start URL: run a crawl from Set up first.' : 'The loop cannot start yet.');
      this.runError.set(why);
      return;
    }
    await this.fix();
  }

  // The latest report's markup is nowhere in the folders the loop edits: probably the wrong repository.
  readonly match = signal<LoopMatch | null>(null);
  readonly startAnyway = signal(false);
  readonly wrongRepo = computed(() => {
    const m = this.match();
    return !!m && m.report && m.checked > 0 && m.found === 0;
  });
  readonly canStart = computed(() => this.agentReady() && this.repoOk() && !!this.loopUrl() && !this.store.active() && (!this.wrongRepo() || this.startAnyway()));
  readonly host = computed(() => {
    try {
      return new URL(this.loopUrl()).host;
    } catch {
      return 'the site';
    }
  });
  readonly waitingForBuild = computed(() => this.store.awaitingDeploy() && !this.store.done());
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
    if (t && t.status !== 'ready') return 'The last test of this assistant did not pass.';
    return '';
  });
  readonly stepText = computed(() => {
    const r = this.store.round();
    const s = this.store.step();
    const t = this.store.task();
    const pr = this.problem();
    if (pr) return pr.kind === 'start' ? 'The fix loop could not start.' : 'The fix loop stopped.';
    if (this.store.done()) return `${this.store.kind() === 'dry-run' ? 'Dry run' : 'Loop'} finished${this.store.done()?.['outcome'] === 'stopped' ? ' (stopped)' : ''}.`;
    if (!r) return 'Starting…';
    if (this.store.awaitingDeploy()) return `Round ${r}: waiting for deploy`;
    const step = s?.['step'];
    if (step === 'fix' || step === 'gate' || step === 'commit') return `Round ${r}: ${step === 'fix' ? '' : step + ', '}fix ${t?.n || 0} of ${t?.m || 0}`;
    if (step === 'deploy' || step === 'await-deploy') return `Round ${r}: waiting for deploy`;
    return `Round ${r}: ${step || 'crawl'}`;
  });

  // The assistant's live output: the loop's current call, or Test assistant.
  readonly paneShown = computed(() => this.testing() || !!this.testResult() || !!this.store.agentCall());
  readonly paneText = computed(() => {
    if (this.testing()) return '(waiting for the assistant…)';
    const c = this.store.agentCall();
    if (c && (!this.testResult() || c.startedAt > this.testStartedAt())) return c.text || '(no output yet)';
    const t = this.testResult();
    return t ? t.output.join('\n') || '(no output)' : '';
  });
  readonly paneHeading = computed(() => {
    const who = this.assistantLabel() || 'The assistant';
    const secs = (from: number, to: number | null) => `${Math.max(0, Math.round(((to ?? this.now()) - from) / 1000))} s`;
    if (this.testing()) return `${who}, testing · running ${secs(this.testStartedAt(), null)}`;
    const c = this.store.agentCall();
    if (c && (!this.testResult() || c.startedAt > this.testStartedAt())) {
      const what = c.kind === 'triage' ? `triaging ${c.label}${c.m ? ` · call ${c.n ?? c.task} of ${c.m}` : ''}` : `fixing ${c.n ?? c.task} of ${c.m ?? '?'}: ${c.label}`;
      if (!c.endedAt) return `${who}, ${what} · running ${secs(c.startedAt, null)}`;
      return `${who}, ${what} · ${OUTCOMES[c.outcome || 'done'] || c.outcome} (${secs(c.startedAt, c.endedAt)})`;
    }
    const t = this.testResult();
    return t ? `${who}, test · ${this.testText()}` : who;
  });

  readonly roundCols = [{ key: 'round', label: 'Round' }, { key: 'open', label: 'Open violations' }, { key: 'verified', label: 'Verified fixed (total)' }, { key: 'at', label: 'Finished' }];
  readonly roundRows = computed(() => {
    let verified = 0;
    return (this.ledger()?.rounds || []).map((r) => {
      verified += r.diff['verified'] || 0;
      return { round: r.round, open: r.violations, verified, at: localTime(r.at) };
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
    // After a switch of directory, the new directory's config and defaults; an edit in
    // progress is discarded (the server never saw it).
    let seen: string | null = null;
    effect(() => {
      const cwd = this.env.cwd();
      untracked(() => {
        if (!cwd) return;
        if (seen && seen !== cwd) void Promise.all([this.loadConfig(), this.loadDefaults()]);
        seen = cwd;
      });
    });
    effect(() => {
      const d = this.store.done();
      if (d && this.store.kind() === 'install') void this.env.load();
    });
    // Preselect the installed assistant when the config names none.
    effect(() => {
      const presets = this.presets();
      untracked(() => {
        if (this.choice()) return;
        const p = PREFERENCE.map((n) => presets.find((x) => x.name === n && x.found)).find(Boolean);
        if (p) this.choice.set(p.name);
      });
    });
    // The assistants are detected in the background: ask again until they are known.
    effect(() => {
      const detecting = !!this.env.env()?.detecting;
      untracked(() => {
        clearTimeout(this.detectPoll);
        if (detecting) this.detectPoll = setTimeout(() => void this.env.load(), 1000);
      });
    });
    // Follow the output as it grows, unless the person scrolled up.
    effect(() => {
      this.paneText();
      untracked(() => {
        if (this.follow()) setTimeout(() => this.scrollPane());
      });
    });
  }

  async ngOnInit(): Promise<void> {
    // In parallel: the first /api/env can take seconds (assistant detection),
    // and the config must not arrive after the developer has started editing.
    await Promise.all([this.env.load(), this.loadConfig(), this.loadDefaults()]);
    const spec = this.agentSpec();
    if (!this.testResult() && spec && this.env.env()?.lastTest?.[spec]) this.testResult.set(this.env.env()!.lastTest[spec]);
    if (this.startParam() === '1' && this.canStart()) await this.fix();
  }

  ngOnDestroy(): void {
    clearInterval(this.ticker);
    clearTimeout(this.detectPoll);
  }

  private configLoads = 0;
  async loadConfig(): Promise<void> {
    const n = ++this.configLoads;
    let c: { exists: boolean; repository?: boolean; config: Record<string, any> } | null = null;
    let settings: Record<string, any> = {};
    try {
      [c, settings] = await Promise.all([this.api.get<{ exists: boolean; repository?: boolean; config: Record<string, any> }>('/api/config'), this.api.get<Record<string, any>>('/api/settings').catch(() => ({}))]);
    } catch {}
    if (n !== this.configLoads || !c) return;
    this.cfg.set(c.config || {});
    this.configExists.set(!!c.exists);
    this.repoConfig.set(!!c.repository);
    this.rounds.set(typeof settings['rounds'] === 'number' ? settings['rounds'] : null);
    this.configErrors.set([]);
    this.configStatus.set('');
    // The assistant: the dashboard's remembered choice, else the config's.
    const a = settings['agent'] || c.config?.['agent'];
    this.choice.set(null);
    this.custom.set('');
    if (a) {
      if (['claude', 'gemini', 'codex'].includes(a)) this.choice.set(a);
      else {
        this.choice.set('custom');
        this.custom.set(a);
      }
    } else {
      const p = PREFERENCE.map((x) => this.presets().find((y) => y.name === x && y.found)).find(Boolean);
      if (p) this.choice.set(p.name);
    }
    const spec = this.agentSpec();
    this.testResult.set((spec && this.env.env()?.lastTest?.[spec]) || null);
  }

  private defaultsLoads = 0;
  async loadDefaults(): Promise<void> {
    const n = ++this.defaultsLoads;
    try {
      const [d, m] = await Promise.all([this.api.get<LoopDefaults>('/api/loop/defaults'), this.api.get<LoopMatch>('/api/loop/match').catch(() => null)]);
      if (n !== this.defaultsLoads) return;
      this.defaults.set(d);
      this.match.set(m);
      this.startAnyway.set(false);
    } catch {}
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

  // The runnable command for the next task's prompt file, or a11y-508-work/prompt.md before any loop.
  runCommandFor(p: Preset): string | null {
    const rc = p.runCommand;
    if (!rc) return null;
    const c = this.store.agentCall();
    if (!c) return rc;
    const file = c.kind === 'triage' ? `prompt-r${c.round}-triage-${c.task - 1}.md` : `prompt-r${c.round}-fix-${c.task - 1}.md`;
    return rc.replace(/prompt\.md(?=[^\\/]*$)/, file);
  }

  async choose(name: string): Promise<void> {
    this.choice.set(name);
    const spec = this.agentSpec();
    this.testResult.set((spec && this.env.env()?.lastTest?.[spec]) || null);
    if (name !== 'custom') await this.saveAgent();
  }

  // The choice is remembered in the dashboard's settings (never in a repository's config); the
  // dashboard's own config records it too.
  async saveAgent(): Promise<void> {
    const spec = this.agentSpec();
    if (!spec || (this.choice() === 'custom' && !spec.includes('{promptFile}'))) return;
    await this.api.put('/api/settings', { agent: spec }).catch(() => {});
    if (this.repoConfig()) return;
    this.set('agent', spec);
    await this.saveConfig();
  }

  // The config as it will be written: what the person set, with the inferred values filling the
  // rest, and the deployment watched silently (deployment happens outside this tool).
  private completed(): Record<string, any> {
    const c = { ...this.cfg() };
    if (!c['url'] && this.loopUrl()) c['url'] = this.loopUrl();
    const pl = this.plan();
    if (pl) {
      if (!Array.isArray(c['source']) || !c['source'].length) c['source'] = pl.sourceList;
      if (c['check'] === undefined && pl.check) c['check'] = pl.check;
      if (!c['branch']) c['branch'] = pl.branch;
      if (c['push'] === undefined) c['push'] = !!pl.push && !!pl.remote;
      if (c['maxAttempts'] === undefined) c['maxAttempts'] = pl.maxAttempts;
    }
    if (!c['deployed'] && !c['deploy']) {
      c['deployed'] = 'bundle-change';
      if (c['deployTimeout'] === undefined) c['deployTimeout'] = this.defaults()?.effective.deployTimeout ?? 30 * 60 * 1000;
    }
    return c;
  }

  async saveConfig(): Promise<boolean> {
    if (this.repoConfig()) {
      this.configStatus.set("Not saved: the repository's a11y-508.config.json is used as is.");
      return false;
    }
    // A load still in flight must not replace what is being saved.
    this.configLoads++;
    try {
      const r = await this.api.put<{ exists: boolean; config: Record<string, any>; warnings: string[] }>('/api/config', { config: this.completed() });
      this.cfg.set(r.config);
      this.configExists.set(true);
      this.configErrors.set([]);
      this.configStatus.set(`Saved${r.warnings?.length ? ` (${r.warnings.join('; ')})` : ''}.`);
      return true;
    } catch (e: any) {
      this.configErrors.set(e.body?.errors || [e.message]);
      this.configStatus.set('Not saved.');
      return false;
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
    this.testStartedAt.set(Date.now());
    try {
      this.testResult.set(await this.api.post<AgentTest>('/api/agent/test', { agent: this.agentSpec() }));
    } catch (e: any) {
      this.testResult.set({ agent: this.agentSpec(), command: '', status: 'failed', code: null, durationMs: 0, output: [e.message] });
    } finally {
      this.testing.set(false);
    }
  }

  // Fix the violations: the config from what was inferred (written if there is none, or if the
  // assistant changed), then the loop with its default number of rounds.
  async fix(): Promise<void> {
    if (!this.canStart()) return;
    this.runError.set('');
    if (!this.repoConfig() && (!this.configExists() || this.cfg()['agent'] !== this.agentSpec())) {
      this.set('agent', this.agentSpec());
      if (!(await this.saveConfig())) return;
    }
    await this.api.put('/api/settings', { agent: this.agentSpec() }).catch(() => {});
    await this.startLoop('loop');
  }

  async startLoop(kind: 'loop' | 'dry-run'): Promise<void> {
    this.runError.set('');
    try {
      // Fix the violations signs in first, in a fresh window, unless a way in was chosen on Run
      // (/run/advanced); the later rounds crawl headless with the session it saves.
      await this.store.start({ kind, maxRounds: kind === 'loop' && this.rounds() ? this.rounds() : undefined, auth: this.form.auth(true), agent: kind === 'loop' ? this.agentSpec() : undefined, signIn: kind === 'loop' && !this.form.authChosen() });
      this.form.clearToken();
    } catch (e: any) {
      this.runError.set(e.message);
    }
  }

  setFollow(on: boolean): void {
    this.follow.set(on);
    if (on) this.scrollPane();
  }

  // Scrolling up stops following; Follow (or scrolling back to the end) starts it again.
  onPaneScroll(): void {
    const el = this.paneEl()?.nativeElement;
    if (!el) return;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    if (atEnd !== this.follow()) this.follow.set(atEnd);
  }

  private scrollPane(): void {
    const el = this.paneEl()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  async copy(text: string, what = ''): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(what);
    } catch {
      this.copied.set('');
    }
  }
}
