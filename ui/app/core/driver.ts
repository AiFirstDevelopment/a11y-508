import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api } from './api';
import { EnvStore } from './env.store';
import { FormStore } from './form.store';
import { RunStore, askToNotify } from './run.store';
import { SignInFlow } from './sign-in';
import { LedgerInfo, LoopDefaults, Preset } from './types';

// The installed assistant chosen when nothing names one, in this order.
export const PREFERENCE = ['claude', 'gemini', 'codex'];

// The one thing the dashboard does (docs/plans/simple-screen.md): Start runs the fix loop (it crawls,
// fixes, pushes, waits for the build, verifies, and goes round again until nothing is left), or, in a
// folder the loop cannot work in, the crawl alone. Nobody chooses anything: the assistant is the one
// the person picked under Advanced, else the config's, else the first installed one.
@Injectable({ providedIn: 'root' })
export class Driver {
  private api = inject(Api);
  private env = inject(EnvStore);
  private form = inject(FormStore);
  private store = inject(RunStore);
  private flow = inject(SignInFlow);

  // The loop's config (the dashboard's own, or the repository's), the remembered assistant, what the
  // server inferred about the repository, and the ledger.
  readonly cfg = signal<Record<string, any>>({});
  readonly configExists = signal(false);
  readonly repoConfig = signal(false);
  readonly settingsAgent = signal<string | null>(null);
  readonly defaults = signal<LoopDefaults | null>(null);
  readonly ledger = signal<LedgerInfo | null>(null);
  private configLoading = signal(true);
  private defaultsLoading = signal(true);
  // From the click until the server has the run (or says why not).
  readonly starting = signal(false);
  readonly error = signal('');

  readonly presets = computed<Preset[]>(() => this.env.env()?.presets || []);
  // Still finding out what Start needs: the assistants, the repository, the config.
  readonly pending = computed(() => !this.env.env() || !!this.env.env()!.detecting || this.configLoading() || this.defaultsLoading());
  // The assistant the loop runs: the one chosen under Advanced, else the config's, else the first installed.
  readonly agent = computed(() => {
    const named = this.settingsAgent() || (typeof this.cfg()['agent'] === 'string' ? this.cfg()['agent'] : '');
    if (named) return named;
    return PREFERENCE.map((n) => this.presets().find((p) => p.name === n && p.found)).find(Boolean)?.name || '';
  });
  // A second installed assistant takes a finding the first fails twice on (the config's, if it names one).
  readonly fallback = computed(() => {
    const c = this.cfg()['fallback'];
    if (typeof c === 'string' && c) return c;
    if (c === null || c === '') return '';
    return this.presets().find((p) => p.found && p.name !== this.agent())?.name || '';
  });
  // The start URL: what Set up holds, else the config's.
  readonly url = computed(() => (this.form.url().trim() || String(this.cfg()['url'] || '')).trim());
  // Why Start only crawls: the loop needs the app's git repository (with its package.json) and an
  // installed assistant. Empty when it fixes.
  readonly whyNoFix = computed(() => {
    const d = this.defaults();
    if (!d) return '';
    if (!d.repo.git) return "fixing needs the app's git repository, and this folder is not one";
    if (!d.package.exists) return "fixing needs the app's repository, and this folder has no package.json";
    const a = this.agent();
    const preset = this.presets().find((p) => p.name === a);
    if (!a) return 'no assistant is installed (Claude Code, Gemini CLI or Codex)';
    if (preset && !preset.found) return `${preset.label} is not installed`;
    return '';
  });

  // A name a person knows: "Gemini CLI"; a custom command is "the assistant".
  label(spec: string | null | undefined): string {
    const s = String(spec || '');
    const p = this.presets().find((x) => x.name === s || (!!x.path && (s === x.path || s.startsWith(`${x.path} `) || s.startsWith(`"${x.path}"`))));
    return p ? p.label : 'the assistant';
  }

  constructor() {
    // Everything again after a switch of folder, and the ledger as the loop changes it.
    effect(() => {
      const cwd = this.env.cwd();
      untracked(() => {
        if (cwd) void this.load();
      });
    });
    effect(() => {
      this.store.ledger();
      this.store.done();
      untracked(() => {
        if (this.env.cwd()) void this.loadLedger();
      });
    });
    // The assistants are detected in the background: ask again until they are known.
    let poll: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const detecting = !!this.env.env()?.detecting;
      untracked(() => {
        if (poll) clearTimeout(poll);
        if (detecting) poll = setTimeout(() => void this.env.load(), 1000);
      });
    });
  }

  private loads = 0;
  // The folder the config and defaults were read for.
  private loadedFor: string | null = null;
  async load(): Promise<void> {
    const n = ++this.loads;
    this.loadedFor = this.env.cwd();
    this.configLoading.set(true);
    this.defaultsLoading.set(true);
    const [c, s, d] = await Promise.all([
      this.api.get<{ exists: boolean; repository?: boolean; config: Record<string, any> }>('/api/config').catch(() => null),
      this.api.get<Record<string, any>>('/api/settings').catch(() => ({}) as Record<string, any>),
      this.api.get<LoopDefaults>('/api/loop/defaults').catch(() => null),
    ]);
    if (n !== this.loads) return;
    this.cfg.set(c?.config || {});
    this.configExists.set(!!c?.exists);
    this.repoConfig.set(!!c?.repository);
    this.settingsAgent.set(typeof s?.['agent'] === 'string' && s['agent'] ? s['agent'] : null);
    this.defaults.set(d);
    this.configLoading.set(false);
    this.defaultsLoading.set(false);
    void this.loadLedger();
  }

  private ledgerLoads = 0;
  async loadLedger(): Promise<void> {
    const n = ++this.ledgerLoads;
    try {
      const l = await this.api.get<LedgerInfo>('/api/ledger');
      if (n === this.ledgerLoads) this.ledger.set(l);
    } catch {}
  }

  // The config as the loop will read it: what is set, with the inferred values filling the rest, and
  // the deployment watched for (it happens outside this tool) with no time limit. start: Start's (the
  // URL on screen and the assistant that runs); else Advanced's (only what is missing is filled).
  completed(given: Record<string, any> = this.cfg(), start = true): Record<string, any> {
    const c = { ...given };
    const d = this.defaults();
    if (start && this.form.url().trim()) c['url'] = this.form.url().trim();
    else if (!c['url'] && this.url()) c['url'] = this.url();
    if (start) c['agent'] = this.agent();
    if (d) {
      if (!Array.isArray(c['source']) || !c['source'].length) c['source'] = d.effective.source;
      if (c['check'] === undefined && d.effective.check) c['check'] = d.effective.check;
      if (!c['branch']) c['branch'] = d.effective.branch;
      if (c['push'] === undefined) c['push'] = !!d.effective.push && !!d.repo.remote;
      if (c['maxAttempts'] === undefined) c['maxAttempts'] = d.effective.maxAttempts;
    }
    if (c['fallback'] === undefined && this.fallback()) c['fallback'] = this.fallback();
    if (!c['deployed'] && !c['deploy']) {
      c['deployed'] = 'bundle-change';
      if (c['deployTimeout'] === undefined) c['deployTimeout'] = 0;
    }
    return c;
  }

  // Until Start knows what it needs (or five minutes).
  private async ready(): Promise<void> {
    const until = Date.now() + 5 * 60_000;
    while (this.pending() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  }

  // Start: the whole thing, in one click. A click that comes while the assistants are still being
  // detected waits for them ("Starting…"), then starts.
  async start(): Promise<void> {
    // Desktop notifications from here on (a sign-in needed, a round pushed, the loop ended): asked once, on this click.
    askToNotify();
    if (this.starting() || this.store.active()) return;
    this.starting.set(true);
    this.error.set('');
    try {
      // The URL as the run will use it, remembered (which also makes the dashboard's own folder for
      // this one, where a sign-in's session is saved: the sign-in waits forever without it).
      if (!this.form.url().trim() && this.url()) this.form.url.set(this.url());
      this.form.rememberUrl();
      // Just switched folders: that folder's config and defaults first.
      if (this.loadedFor !== this.env.cwd()) await this.load();
      await this.ready();
      if (this.store.active()) return;
      if (!this.whyNoFix()) {
        if (!this.repoConfig()) {
          const r = await this.api.put<{ config: Record<string, any> }>('/api/config', { config: this.completed() });
          this.cfg.set(r.config);
          this.configExists.set(true);
        }
        // The assistant is remembered for this folder (this also makes the dashboard's own folder for
        // it, where the sign-in's session is saved).
        await this.api.put('/api/settings', { agent: this.agent() }).catch(() => {});
        // The loop signs in first, in a tab of the dashboard's window, unless a way in was chosen under Advanced.
        await this.store.start({ kind: 'loop', auth: this.form.auth(true), agent: this.agent(), signIn: !this.form.authChosen() });
      } else {
        if (!this.form.url().trim() && this.url()) this.form.url.set(this.url());
        await this.api.put('/api/settings', {}).catch(() => {});
        if (!this.form.authChosen()) await this.flow.start();
        else await this.store.start(this.form.body('crawl'));
      }
    } catch (e: any) {
      this.error.set(e?.body?.errors?.join('; ') || e?.message || String(e));
    } finally {
      this.form.clearToken();
      this.starting.set(false);
    }
  }

  stop(): Promise<void> {
    return this.store.stop();
  }
}
