import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import { parsedFileUrl, pdfPageUrl } from '../core/manual';

interface ParsedPage {
  heading: string;
  n: number;
  facts: string[];
  text: string[];
  none: string | null;
  picture: string | null;
  images: { file: string; label: string }[];
}

// Show the parsed report (docs/plans/pdf-parse.md AC 9): report.md, what the assistant read instead of
// the PDF, rendered: per page its facts, its text, then the picture of the page and each embedded
// picture as a thumbnail.
export function parseReport(md: string): { head: string[]; pages: ParsedPage[] } {
  const [first, ...rest] = String(md || '').split(/^## /m);
  const head = first.split('\n').map((l) => l.replace(/^# /, '')).filter((l) => l.trim());
  const pages = rest.map((block) => {
    const lines = block.split('\n');
    const heading = lines[0].trim();
    const p: ParsedPage = { heading, n: Number((/^Page (\d+)/.exec(heading) || [])[1]) || 0, facts: [], text: [], none: null, picture: null, images: [] };
    for (const l of lines.slice(1)) {
      if (l.startsWith('> ')) p.text.push(l.slice(2));
      else if (l.startsWith('Picture of the page: ')) p.picture = l.slice('Picture of the page: '.length).trim();
      else if (l.startsWith('Pictures on the page: ')) {
        for (const m of l.slice('Pictures on the page: '.length).matchAll(/(pages\/[\w-]+\.png) \(([^)]*)\)/g)) p.images.push({ file: m[1], label: m[2] });
      } else if (l.startsWith('Text: ')) p.none = l.slice('Text: '.length);
      else if (l.trim() && l !== 'Text, in reading order:') p.facts.push(l);
    }
    return p;
  });
  return { head, pages };
}

@Component({
  selector: 'app-parsed-report-pane',
  template: `
    <dialog #pane class="pane" id="parsed-report" aria-labelledby="parsed-title" data-testid="parsed-panel" (close)="opened.set(false)">
      @if (opened()) {
        <div class="pane-head">
          <h2 id="parsed-title">The parsed report</h2>
          <button type="button" class="secondary" data-testid="parsed-close" (click)="close()">Close</button>
        </div>
        @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
        <p>What the assistant read instead of the PDF: <a [href]="file('report.md')" target="_blank" rel="noopener" data-testid="parsed-md">report.md</a> · <a [href]="file('manifest.json')" target="_blank" rel="noopener">manifest.json</a></p>
        @for (l of head(); track $index) { <p class="head" data-testid="parsed-head">{{ l }}</p> }
        @for (p of pages(); track p.heading) {
          <section data-testid="parsed-page" [attr.data-page]="p.n">
            <h3>{{ p.heading }} · <a [href]="pdfPage(p.n)" target="_blank" rel="noopener">PDF page {{ p.n }}</a></h3>
            @for (f of p.facts; track $index) { <p class="fact" data-testid="parsed-fact">{{ f }}</p> }
            @if (p.text.length) {
              <blockquote data-testid="parsed-text">@for (t of p.text; track $index) {<span>{{ t }}</span>}</blockquote>
            } @else if (p.none) { <p class="muted">Text: {{ p.none }}</p> }
            @if (p.picture) {
              <a [href]="file(p.picture)" target="_blank" rel="noopener"><img class="page" [src]="file(p.picture)" [alt]="'Page ' + p.n + ' of the PDF'" data-testid="parsed-picture" /></a>
            }
            @if (p.images.length) {
              <div class="thumbs">
                @for (im of p.images; track im.file) {
                  <figure><a [href]="file(im.file)" target="_blank" rel="noopener"><img [src]="file(im.file)" [alt]="'A picture embedded on page ' + p.n" data-testid="parsed-image" /></a><figcaption>{{ im.label }}</figcaption></figure>
                }
              </div>
            }
          </section>
        }
      }
    </dialog>
  `,
  styles: [`
    dialog.pane { position: fixed; inset: 0 0 0 auto; margin: 0; height: 100vh; max-height: none; width: min(860px, 100vw); max-width: none; box-sizing: border-box; border: 0; border-left: 2px solid var(--accent); border-radius: 0; padding: 16px 20px 24px; overflow: auto; }
    .pane-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .pane-head h2 { margin: 0; }
    .head { margin: 2px 0; }
    section { margin: 0 0 24px; }
    .fact { margin: 2px 0; overflow-wrap: anywhere; }
    .muted { color: var(--muted); }
    blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--muted); }
    blockquote span { display: block; overflow-wrap: anywhere; }
    img.page { width: 100%; border: 1px solid var(--muted); display: block; margin: 6px 0; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
    .thumbs figure { margin: 0; }
    .thumbs img { max-width: 200px; border: 1px solid var(--muted); display: block; }
    .thumbs figcaption { color: var(--muted); font-size: 0.85rem; }
  `],
})
export class ParsedReportPane {
  private api = inject(Api);
  private pane = viewChild.required<ElementRef<HTMLDialogElement>>('pane');
  readonly opened = signal(false);
  readonly id = signal<string | null>(null);
  readonly head = signal<string[]>([]);
  readonly pages = signal<ParsedPage[]>([]);
  readonly error = signal('');

  async open(id: string): Promise<void> {
    this.id.set(id);
    this.error.set('');
    this.opened.set(true);
    const d = this.pane().nativeElement;
    if (!d.open) d.showModal();
    try {
      const md = await this.api.get<string>(`/api/manual/${encodeURIComponent(id)}/parsed/report.md`);
      const r = parseReport(typeof md === 'string' ? md : '');
      this.head.set(r.head);
      this.pages.set(r.pages);
    } catch (e: any) {
      this.error.set(`The parsed report could not be read: ${e?.message || e}`);
    }
  }

  close(): void {
    const d = this.pane().nativeElement;
    if (d.open) d.close();
    this.opened.set(false);
  }

  file(rel: string): string {
    return parsedFileUrl(this.id(), rel);
  }
  pdfPage(n: number): string {
    return pdfPageUrl(this.id(), n);
  }
}
