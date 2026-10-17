import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import { DecisionGroup as Group, ManualDecision, manualFileUrl, pdfPageUrl, seenWords } from '../core/manual';

// Show decisions (docs/plans/manual-findings.md AC 9): a PDF run's decision log, grouped by finding,
// each headed by its title and its PDF page, then its decisions in order, its commits and its
// before and after screenshots. What decisions.md says, on screen.
@Component({
  selector: 'app-decisions-pane',
  template: `
    <dialog #pane class="pane" id="decisions" aria-labelledby="decisions-title" data-testid="decisions-panel" (close)="opened.set(false)">
      @if (opened()) {
        <div class="pane-head">
          <h2 id="decisions-title">Decisions</h2>
          <button type="button" class="secondary" data-testid="decisions-close" (click)="close()">Close</button>
        </div>
        @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
        <p>From the tester's PDF: <a [href]="file('source.pdf')" target="_blank" rel="noopener" data-testid="decisions-pdf">the PDF</a> · <a [href]="file('decisions.md')" target="_blank" rel="noopener">decisions.md</a></p>
        @if (general().length) {
          <h3>The run</h3>
          <ul>@for (d of general(); track $index) { <li data-testid="decision">{{ line(d) }}</li> }</ul>
        }
        @for (g of groups(); track g.finding) {
          <section data-testid="decisions-group">
            <h3>{{ g.finding }}: {{ g.title }} — <a [href]="page(g.page)" target="_blank" rel="noopener" data-testid="pdf-page">PDF page {{ g.page }}</a></h3>
            <p class="seen" data-testid="seen">{{ seen(g) }}</p>
            @for (x of g.seenMore || []; track x.page) { <p class="seen" data-testid="seen-more">{{ seen(x) }}</p> }
            @if (g.quote) { <blockquote>{{ g.quote }}</blockquote> }
            <ul>@for (d of g.decisions; track $index) { <li data-testid="decision">{{ line(d) }}</li> }</ul>
            @for (c of g.commits; track c.sha) {
              <p data-testid="decisions-commit"><span class="label">Commit: </span>@if (c.url) {<a [href]="c.url" target="_blank" rel="noopener">{{ c.short }}</a>} @else {<code>{{ c.short }}</code>} · {{ c.files.join(', ') }}</p>
            }
            <div class="shots">
              @for (s of g.screenshots; track s.path) {
                <figure><img [src]="file(s.path)" [alt]="g.finding + ' ' + s.label.toLowerCase() + ' in the deployed site'" data-testid="decisions-shot" /><figcaption>{{ s.label }}</figcaption></figure>
              }
            </div>
          </section>
        }
      }
    </dialog>
  `,
  styles: [`
    dialog.pane { position: fixed; inset: 0 0 0 auto; margin: 0; height: 100vh; max-height: none; width: min(720px, 100vw); max-width: none; box-sizing: border-box; border: 0; border-left: 2px solid var(--accent); border-radius: 0; padding: 16px 20px 24px; overflow: auto; }
    .pane-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .pane-head h2 { margin: 0; }
    section { margin: 0 0 20px; }
    li { overflow-wrap: anywhere; margin: 0 0 4px; }
    .label { color: var(--muted); }
    .shots { display: flex; flex-wrap: wrap; gap: 8px; }
    figure { margin: 0; }
    figure img { max-width: 300px; border: 1px solid var(--muted); }
    blockquote { margin: 4px 0; padding-left: 10px; border-left: 3px solid var(--muted); }
    .seen { font-style: italic; margin: 4px 0; overflow-wrap: anywhere; }
  `],
})
export class DecisionsPane {
  private api = inject(Api);
  private pane = viewChild.required<ElementRef<HTMLDialogElement>>('pane');
  readonly opened = signal(false);
  readonly id = signal<string | null>(null);
  readonly groups = signal<Group[]>([]);
  readonly general = signal<ManualDecision[]>([]);
  readonly error = signal('');

  async open(id: string): Promise<void> {
    this.id.set(id);
    this.error.set('');
    this.opened.set(true);
    const d = this.pane().nativeElement;
    if (!d.open) d.showModal();
    try {
      const r = await this.api.get<{ groups: Group[]; general: ManualDecision[] }>(`/api/manual/${encodeURIComponent(id)}/decisions`);
      this.groups.set(r.groups || []);
      this.general.set(r.general || []);
    } catch (e: any) {
      this.error.set(`The decisions could not be read: ${e?.message || e}`);
    }
  }

  close(): void {
    const d = this.pane().nativeElement;
    if (d.open) d.close();
    this.opened.set(false);
  }

  file(rel: string): string {
    return manualFileUrl(this.id(), rel);
  }
  page(n: number): string {
    return pdfPageUrl(this.id(), n);
  }
  seen(g: { page: number; seen?: string | null }): string {
    return seenWords(g);
  }
  line(d: ManualDecision): string {
    const at = new Date(d.at);
    const when = Number.isNaN(at.getTime()) ? '' : `${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · `;
    return `${when}${d.stage} · ${d.by}: ${d.decision}${d.reason ? ` — ${d.reason}` : ''}`;
  }
}
