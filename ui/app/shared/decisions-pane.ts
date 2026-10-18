import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import { DecisionGroup as Group, ManualDecision, crawlFileUrl, manualFileUrl, pageHref, pageLabel, parsedFileUrl, seenWords } from '../core/manual';

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
        <p>@if (source() === 'screenshots') {From the screenshots: <a [href]="parsed('report.md')" target="_blank" rel="noopener" data-testid="decisions-pdf">the screenshots and their notes</a>} @else {From the tester's PDF: <a [href]="file('source.pdf')" target="_blank" rel="noopener" data-testid="decisions-pdf">the PDF</a>} · <a [href]="file('decisions.md')" target="_blank" rel="noopener">decisions.md</a>@if (crawl(); as c) { · <a [href]="crawlFile(c)" target="_blank" rel="noopener" data-testid="decisions-crawl">the site as the tool saw it</a>}</p>
        @if (general().length) {
          <h3>The run</h3>
          <ul>@for (d of general(); track $index) { <li data-testid="decision">{{ line(d) }}</li> }</ul>
        }
        @for (g of groups(); track g.finding) {
          <section data-testid="decisions-group">
            <h3>{{ g.finding }}: {{ g.title }} — <a [href]="page(g.page)" target="_blank" rel="noopener" data-testid="pdf-page">{{ label(g.page) }}</a></h3>
            <p class="seen" [attr.data-testid]="g.seenPicture === false ? 'seen-unseen' : 'seen'">{{ seen(g) }}</p>
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
  // The run's own look over the site, when it has one: "crawl/report.html" (docs/plans/manual-crawl-first.md AC 4).
  readonly crawl = signal<string | null>(null);
  readonly error = signal('');
  // Where the run's findings came from (docs/plans/screenshots-in.md AC 5).
  readonly source = signal<string | null>(null);

  async open(id: string): Promise<void> {
    this.id.set(id);
    this.error.set('');
    this.opened.set(true);
    const d = this.pane().nativeElement;
    if (!d.open) d.showModal();
    try {
      const r = await this.api.get<{ groups: Group[]; general: ManualDecision[]; crawl?: string | null; source?: string | null }>(`/api/manual/${encodeURIComponent(id)}/decisions`);
      this.source.set(r.source || null);
      this.groups.set(r.groups || []);
      this.general.set(r.general || []);
      this.crawl.set(r.crawl || null);
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
  crawlFile(rel: string): string {
    return crawlFileUrl(this.id(), rel);
  }
  page(n: number): string {
    return pageHref(this.id(), this.source(), n);
  }
  label(n: number): string {
    return pageLabel(this.source(), n);
  }
  parsed(rel: string): string {
    return parsedFileUrl(this.id(), rel);
  }
  seen(g: { page: number; seen?: string | null; seenPicture?: boolean | null }): string {
    return seenWords(g);
  }
  line(d: ManualDecision): string {
    const at = new Date(d.at);
    const when = Number.isNaN(at.getTime()) ? '' : `${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · `;
    return `${when}${d.stage} · ${d.by}: ${d.decision}${d.reason ? ` — ${d.reason}` : ''}`;
  }
}
