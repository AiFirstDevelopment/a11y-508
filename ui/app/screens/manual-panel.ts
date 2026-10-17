import { Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { Api } from '../core/api';
import { RunStore } from '../core/run.store';
import { DecisionGroup, ManualComponent, ManualDecision, PlanItem, manualFileUrl, pdfPageUrl } from '../core/manual';
import { EnvStore } from '../core/env.store';
import { commitUrl } from '../core/git-links';
import { ComponentPicker } from '../shared/component-picker';

interface Draft {
  fix?: string;
  component?: ManualComponent;
  remove?: boolean;
}

// The manual step on the one screen (docs/plans/manual-findings.md): what is already fixed in the
// deployed site, the plan with its edit controls while it waits for approval, and the decision log
// (collapsed). Approval is the only way forward, and it waits as long as it takes. Once the run has
// ended (docs/plans/manual-findings-clarity.md AC 3) it shows what was fixed and confirmed, each with
// its evidence, first; the rest stays, collapsed.
@Component({
  selector: 'app-manual-panel',
  imports: [ComponentPicker],
  template: `
    @if (m(); as m) {
      @if (m.done && fixedRows().length) {
        <details class="section" data-testid="fixed-confirmed" open>
          <summary>Fixed and confirmed in the deployed site ({{ fixedRows().length }})</summary>
          <ol>
            @for (r of fixedRows(); track r.finding) {
              <li data-testid="fixed-item" [attr.data-finding]="r.finding">
                <p class="what"><strong>{{ r.finding }}</strong> {{ r.title }} · <a [href]="page(r.page)" target="_blank" rel="noopener" data-testid="pdf-page">PDF page {{ r.page }}</a></p>
                @if (r.quote) { <blockquote data-testid="quote">{{ r.quote }}</blockquote> }
                @if (r.url) { <p data-testid="checked"><span class="label">Checked: </span><a [href]="r.url" target="_blank" rel="noopener">{{ r.url }}</a></p> }
                <p data-testid="fixed-commits"><span class="label">{{ r.commits.length === 1 ? 'Commit' : 'Commits' }}: </span>@for (c of r.commits; track c.sha; let last = $last) {@if (commitLink(c); as u) {<a [href]="u" target="_blank" rel="noopener" data-testid="fixed-commit">{{ c.short }}</a>} @else {<code data-testid="fixed-commit">{{ c.short }}</code>}@if (!last) {, }}@if (!r.commits.length) {none}</p>
                <p data-testid="reason"><span class="label">Why it counts as fixed: </span>{{ r.reason || 'no reason was given' }}</p>
                <div class="pair">
                  @for (s of r.shots; track s.path) {
                    <figure><a [href]="file(s.path)" target="_blank" rel="noopener"><img class="thumb" [src]="file(s.path)" [alt]="r.finding + ' ' + s.label.toLowerCase() + ' in the deployed site'" data-testid="fixed-shot" /></a><figcaption>{{ s.label }}</figcaption></figure>
                  }
                </div>
              </li>
            }
          </ol>
        </details>
      }
      @if (m.alreadyFixed.length) {
        <details class="section" data-testid="already-fixed" [open]="m.allGone || (!!m.done && !fixedRows().length)">
          <summary>Already fixed in the deployed site ({{ m.alreadyFixed.length }})</summary>
          <ol>
            @for (r of m.alreadyFixed; track r.finding) {
              <li data-testid="already-fixed-item">
                <p class="what"><strong>{{ r.finding }}</strong> {{ r.title }} · <a [href]="page(r.page)" target="_blank" rel="noopener" data-testid="pdf-page">PDF page {{ r.page }}</a></p>
                @if (r.quote) { <blockquote data-testid="quote">{{ r.quote }}</blockquote> }
                <p data-testid="checked"><span class="label">Checked: </span><a [href]="r.url" target="_blank" rel="noopener">{{ r.url }}</a> at {{ time(r.checkedAt) }}</p>
                <p data-testid="reason"><span class="label">Why it counts as fixed: </span>{{ r.reason || 'no reason was given' }}</p>
                @if (r.screenshot) { <img class="shot" [src]="file(r.screenshot)" [alt]="r.finding + ' in the deployed site'" data-testid="screenshot" /> }
              </li>
            }
          </ol>
        </details>
      }
      @if (m.plan) {
        <details class="section" data-testid="plan" [open]="!m.done">
          <summary><h2 id="plan-title">{{ m.plan.reason === 'revised' ? 'The revised plan' : 'The plan' }} <span class="muted">(version {{ m.plan.version }})</span></h2></summary>
          @if (error()) { <p class="notice error" role="alert" data-testid="review-error">{{ error() }}</p> }
          <ol>
            @for (it of m.plan.items; track it.finding) {
              <li data-testid="plan-item" [attr.data-finding]="it.finding" [class.removed]="draft(it).remove">
                <p class="what"><strong>{{ it.finding }}</strong> {{ it.title }} · <a [href]="page(it.page)" target="_blank" rel="noopener" data-testid="pdf-page">PDF page {{ it.page }}</a></p>
                @if (it.quote) { <blockquote data-testid="quote">{{ it.quote }}</blockquote> }
                @if (it.screenshot) { <img class="shot" [src]="file(it.screenshot)" [alt]="it.finding + ' in the deployed site before the fix'" data-testid="screenshot" /> }
                @if (draft(it).remove) {
                  <p data-testid="plan-removed">Removed from the plan (sent with your changes).</p>
                } @else {
                  <label class="field"><span class="label">Fix</span>
                    <textarea rows="2" data-testid="plan-fix" [disabled]="!editable()" [value]="draft(it).fix ?? it.fix" (input)="setFix(it, $event)"></textarea>
                  </label>
                  <app-component-picker [components]="components()" [value]="draft(it).component || it.component" [disabled]="!editable()" (pick)="setComponent(it, $event)" />
                  <p data-testid="plan-files"><span class="label">Files: </span>{{ it.files.join(', ') || 'none yet' }}</p>
                  @if (it.decisions.length) {
                    <ul class="decisions" data-testid="plan-decisions">@for (d of it.decisions; track $index) { <li>{{ d.decision }}@if (d.reason) { — {{ d.reason }}}</li> }</ul>
                  }
                  @if (it.confirm; as c) {
                    <p data-testid="plan-confirm" [class.wrong]="!c.understood">{{ c.understood ? 'The assistant understood: ' : 'The assistant did not understand: ' }}{{ c.text }}</p>
                  }
                  @if (verdict(it.finding); as v) { <p data-testid="plan-verdict">{{ v.verdict === 'fixed' ? 'Fixed in the deployed site' : 'Not fixed in the deployed site' }}: {{ v.reason }}</p> }
                }
                @if (editable()) {
                  <button type="button" class="secondary" data-testid="plan-remove" (click)="toggleRemove(it)">{{ draft(it).remove ? 'Keep in plan' : 'Remove from plan' }}</button>
                }
              </li>
            }
          </ol>
          @if (m.reviewing) {
            <div class="actions">
              @if (unsent().length) { <button type="button" data-testid="send-changes" (click)="send()" [disabled]="busy()">Send changes</button> }
              <button type="button" data-testid="approve-plan" (click)="approve()" [disabled]="!canApprove()">Approve plan</button>
            </div>
          }
        </details>
      }
      @if (m.done && leftOut().length) {
        <details class="section" data-testid="left-out">
          <summary>Left out of the plan ({{ leftOut().length }})</summary>
          <ol>
            @for (r of leftOut(); track r.finding) {
              <li data-testid="left-out-item">
                <p class="what"><strong>{{ r.finding }}</strong> {{ r.title }} · <a [href]="page(r.page)" target="_blank" rel="noopener" data-testid="pdf-page">PDF page {{ r.page }}</a></p>
                @if (r.reason) { <p data-testid="left-out-reason"><span class="label">Removed by you; the planned fix was: </span>{{ r.reason }}</p> }
              </li>
            }
          </ol>
        </details>
      }
      @if (m.decisions.length) {
        <details class="section" data-testid="decision-log">
          <summary>{{ m.done ? 'Decisions' : 'Decisions so far' }} ({{ m.decisions.length }})</summary>
          <ul>@for (d of m.decisions; track $index) { <li>{{ d.finding ? d.finding + ' · ' : '' }}{{ d.stage }} · {{ d.by }}: {{ d.decision }}@if (d.reason) { — {{ d.reason }}}</li> }</ul>
        </details>
      }
    }
  `,
  styles: [`
    .section { margin: 16px 0; }
    .section ol { padding-left: 22px; }
    .section li { margin: 0 0 16px; }
    .section li p { margin: 2px 0; overflow-wrap: anywhere; }
    .section .label, .muted { color: var(--muted); }
    .section h2 { font-size: 1.15rem; display: inline; }
    .section summary { margin: 0 0 8px; }
    .pair { display: flex; flex-wrap: wrap; gap: 8px; }
    .pair figure { margin: 4px 0; }
    .pair figcaption { color: var(--muted); font-size: 0.85rem; }
    .thumb { max-width: 240px; border: 1px solid var(--muted); display: block; }
    .field { display: block; }
    .field textarea { width: 100%; box-sizing: border-box; display: block; }
    .shot { max-width: 320px; border: 1px solid var(--muted); display: block; margin: 4px 0; }
    .removed .what { text-decoration: line-through; }
    .wrong { color: var(--error, #b00020); }
    .decisions { margin: 2px 0; padding-left: 18px; }
    blockquote { margin: 4px 0; padding-left: 10px; border-left: 3px solid var(--muted); }
    .actions { display: flex; gap: 8px; }
  `],
})
export class ManualPanel {
  private api = inject(Api);
  private env = inject(EnvStore);
  readonly store = inject(RunStore);
  readonly m = computed(() => (this.store.kind() === 'manual' ? this.store.manual() : null));
  readonly components = signal<ManualComponent[]>([]);
  readonly drafts = signal<Record<string, Draft>>({});
  readonly busy = signal(false);
  readonly error = signal('');
  readonly showDecisions = output<string>();
  // Edits are made while the plan waits for approval (not while the assistant confirms them).
  readonly editable = computed(() => !!this.m()?.reviewing && !this.busy());

  constructor() {
    // A new version of the plan: the drafts it answered are gone.
    effect(() => {
      this.m()?.plan?.version;
      untracked(() => {
        this.drafts.set({});
        this.busy.set(false);
      });
    });
    // Approve refused (an answer arrived meanwhile that the assistant did not understand): editable again.
    effect(() => {
      this.m()?.approveRefused;
      untracked(() => this.busy.set(false));
    });
    // Once the run has ended: its decision log grouped by finding, for what was fixed and what was left out.
    effect(() => {
      const m = this.m();
      const id = m && m.done ? m.id : null;
      untracked(() => {
        if (id && this.groupsFor !== id) void this.loadGroups(id);
      });
    });
    // The picker's list, once a plan is on screen.
    effect(() => {
      const has = !!this.m()?.plan;
      untracked(() => {
        if (has && !this.components().length) void this.loadComponents();
      });
    });
  }

  private async loadComponents(): Promise<void> {
    try {
      const r = await this.api.get<{ components: ManualComponent[] }>('/api/manual/components');
      this.components.set(r.components || []);
    } catch {}
  }

  private groupsFor: string | null = null;
  readonly groups = signal<DecisionGroup[]>([]);
  private async loadGroups(id: string): Promise<void> {
    this.groupsFor = id;
    try {
      const r = await this.api.get<{ groups: DecisionGroup[] }>(`/api/manual/${encodeURIComponent(id)}/decisions`);
      if (this.groupsFor === id) this.groups.set(r.groups || []);
    } catch {
      this.groupsFor = null;
    }
  }
  // Fixed and confirmed: each finding the deployed site no longer has after a fix, with its last
  // verdict's reason and its screenshots before the fix and from that verification.
  readonly fixedRows = computed(() => this.groups().filter((g) => g.status === 'fixed').map((g) => {
    const v = [...g.decisions].reverse().find((d) => d.stage === 'verify');
    const before = g.screenshots.find((s) => s.path.includes('/before/'));
    const after = (v && v.evidence && g.screenshots.find((s) => s.path === `${v.evidence}/screenshot.png`)) || [...g.screenshots].reverse().find((s) => !s.path.includes('/before/'));
    return { ...g, reason: v ? v.reason : '', shots: [before, after].filter((s): s is { label: string; path: string } => !!s) };
  }));
  // Left out of the plan: removed by the developer, and not fixed or already fixed after all.
  readonly leftOut = computed(() => this.groups().filter((g) => g.status !== 'fixed' && g.status !== 'already-fixed').map((g) => {
    const d: ManualDecision | undefined = [...g.decisions].reverse().find((x) => x.stage === 'plan' && x.by === 'developer' && x.decision === 'removed from the plan');
    return d ? { ...g, reason: d.reason.replace(/^was: /, '') } : null;
  }).filter((r): r is DecisionGroup & { reason: string } => !!r));
  commitLink(c: { sha: string; url: string | null }): string | null {
    return commitUrl(this.env.env()?.remoteWeb, c.sha) || c.url;
  }

  draft(it: PlanItem): Draft {
    return this.drafts()[it.finding] || {};
  }
  // The edited items not yet sent to the assistant.
  readonly unsent = computed(() => {
    const items = this.m()?.plan?.items || [];
    return items.filter((it) => {
      const d = this.drafts()[it.finding];
      if (!d) return false;
      if (d.remove) return true;
      const fix = d.fix !== undefined && d.fix.trim() !== it.fix.trim();
      const comp = !!d.component && (!it.component || d.component.file !== it.component.file || d.component.name !== it.component.name);
      return fix || comp;
    });
  });
  // Approve plan: only with nothing unsent and no answer the assistant did not understand.
  readonly canApprove = computed(() => {
    const m = this.m();
    if (!m || !m.reviewing || !m.plan || this.busy()) return false;
    if (this.unsent().length) return false;
    return !m.plan.items.some((it) => it.confirm && it.confirm.understood === false);
  });
  verdict(finding: string) {
    return this.m()?.verdicts.find((v) => v.finding === finding) || null;
  }

  private patch(it: PlanItem, d: Draft): void {
    this.drafts.update((all) => ({ ...all, [it.finding]: { ...(all[it.finding] || {}), ...d } }));
  }
  setFix(it: PlanItem, ev: Event): void {
    this.patch(it, { fix: (ev.target as HTMLTextAreaElement).value });
  }
  setComponent(it: PlanItem, c: ManualComponent): void {
    this.patch(it, { component: c });
  }
  toggleRemove(it: PlanItem): void {
    this.patch(it, { remove: !this.draft(it).remove });
  }

  async send(): Promise<void> {
    const items = this.unsent().map((it) => {
      const d = this.drafts()[it.finding];
      if (d.remove) return { finding: it.finding, remove: true };
      return { finding: it.finding, fix: d.fix ?? it.fix, ...(d.component || it.component ? { component: d.component || it.component } : {}) };
    });
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.post('/api/manual/review', { items });
    } catch (e: any) {
      this.busy.set(false);
      this.error.set(e?.message || String(e));
    }
  }

  async approve(): Promise<void> {
    if (!this.canApprove()) return;
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.post('/api/manual/approve');
    } catch (e: any) {
      this.busy.set(false);
      this.error.set(e?.message || String(e));
    }
  }

  file(rel: string): string {
    return manualFileUrl(this.m()?.id || null, rel);
  }
  page(n: number): string {
    return pdfPageUrl(this.m()?.id || null, n);
  }
  time(at: string): string {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
}
