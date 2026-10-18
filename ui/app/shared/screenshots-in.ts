import { Component, HostListener, OnDestroy, computed, inject, input, signal, ElementRef, viewChild } from '@angular/core';
import { Driver } from '../core/driver';

// Screenshots in (docs/plans/screenshots-in.md AC 1): screenshots pasted (Ctrl+V / Cmd+V anywhere on
// the dashboard), picked or dropped, each a row with its thumbnail, a one-line note of what is wrong
// in it and Remove, in the order they were added; Fix these N screenshots sends them. Plain page
// state: a reload keeps nothing.

export const MAX_SHOTS = 40;
export const MAX_SHOT_BYTES = 10 * 1024 * 1024;
// The server's sentences (src/screenshots.mjs), word for word.
export const NOT_A_SHOT = 'That is not a screenshot: only PNG, JPEG or WebP pictures can be added, at most 40 of them, 10 MB each.';
export const TOO_MANY_SHOTS = 'That is more than 40 screenshots: add at most 40 of them, 10 MB each.';
export const SHOT_TOO_BIG = 'That screenshot is larger than 10 MB: add at most 40 screenshots, 10 MB each.';

interface Shot {
  key: number;
  file: Blob;
  name: string;
  url: string;
  note: string;
}

// 'png' | 'jpeg' | 'webp' by the file's first bytes, or null.
async function imageType(blob: Blob): Promise<string | null> {
  let b: Uint8Array;
  try {
    b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  } catch {
    return null;
  }
  if (b.length < 12) return null;
  const text = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x89 && text(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'webp';
  return null;
}

export const NOT_NOW = 'Screenshots can be added when no run is going and the site\'s address is set.';
const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

@Component({
  selector: 'app-screenshots-in',
  template: `
    <input #picker type="file" multiple accept="image/png,image/jpeg,image/webp" hidden data-testid="shots-input" (change)="onPick($event)" />
    @if (error()) { <p class="notice error" role="alert" data-testid="shots-error">{{ error() }}</p> }
    @if (enabled()) {
      <div class="drop" data-testid="shots-drop" [class.over]="over()" (dragover)="onDragOver($event)" (dragleave)="over.set(false)" (drop)="onDrop($event)">
        Drop screenshots here, or paste one: Ctrl+V / Cmd+V
      </div>
      @if (shots().length) {
        <ol class="shots" data-testid="shots-list">
          @for (s of shots(); track s.key; let i = $index) {
            <li data-testid="shot-row" [attr.data-shot]="i + 1">
              <img class="thumb" [src]="s.url" [alt]="'Screenshot ' + (i + 1)" data-testid="shot-thumb" [attr.data-shot]="i + 1" [attr.data-name]="s.name" />
              <div class="row">
                <label [attr.for]="'shot-note-' + s.key">Screenshot {{ i + 1 }}: What is wrong here</label>
                <input type="text" [id]="'shot-note-' + s.key" maxlength="300" [value]="s.note" (input)="setNote(s, $event)" data-testid="shot-note" placeholder="Optional, one line" />
                <button type="button" class="secondary" data-testid="shot-remove" (click)="remove(s)" [attr.aria-label]="'Remove screenshot ' + (i + 1)">Remove</button>
              </div>
            </li>
          }
        </ol>
        <button type="button" data-testid="shots-fix" (click)="fix()" [disabled]="driver.starting()">{{ fixWords() }}</button>
      }
    }
  `,
  styles: [`
    .drop { border: 2px dashed var(--muted); border-radius: 6px; padding: 10px 14px; margin: 0 0 10px; color: var(--muted); }
    .drop.over { border-color: var(--accent); }
    ol.shots { list-style: none; padding: 0; margin: 0 0 10px; }
    ol.shots li { display: flex; gap: 10px; align-items: center; margin: 0 0 8px; }
    img.thumb { width: 96px; max-height: 72px; object-fit: contain; border: 1px solid var(--muted); flex: none; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; flex: 1; min-width: 0; }
    .row label { flex-basis: 100%; }
    .row input { flex: 1; min-width: 12em; }
  `],
})
export class ScreenshotsIn implements OnDestroy {
  readonly driver = inject(Driver);
  // Whether screenshots can be added now: nothing runs and there is a URL.
  readonly enabled = input(false);
  readonly shots = signal<Shot[]>([]);
  readonly error = signal('');
  readonly over = signal(false);
  readonly fixWords = computed(() => (this.shots().length === 1 ? 'Fix this 1 screenshot' : `Fix these ${this.shots().length} screenshots`));
  private picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');
  private next = 1;
  // Adds run one after another, so the order is the order they were added.
  private queue: Promise<void> = Promise.resolve();

  pick(): void {
    this.picker().nativeElement.click();
  }

  onPick(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    this.add(files);
  }

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.over.set(true);
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.over.set(false);
    this.add(Array.from(ev.dataTransfer?.files || []));
  }

  // A paste anywhere on the dashboard: an image is added; anything else is refused, except text
  // pasted into a text box, which is that box's.
  @HostListener('document:paste', ['$event'])
  onPaste(ev: ClipboardEvent): void {
    const data = ev.clipboardData;
    const files = [...Array.from(data?.items || []).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter((f): f is File => !!f)];
    if (!files.length && data?.files?.length) files.push(...Array.from(data.files));
    // A screenshot pasted while none can be added (a run is going, or the site's address is not set) says so.
    if (!this.enabled()) {
      if (files.length) this.error.set(NOT_NOW);
      return;
    }
    if (!files.length) {
      if (!editable(ev.target)) this.error.set(NOT_A_SHOT);
      return;
    }
    ev.preventDefault();
    this.add(files);
  }

  add(files: File[]): void {
    this.queue = this.queue.then(async () => {
      let refused = '';
      for (const f of files) {
        if (this.shots().length >= MAX_SHOTS) {
          refused = TOO_MANY_SHOTS;
          break;
        }
        if (f.size > MAX_SHOT_BYTES) {
          refused ||= SHOT_TOO_BIG;
          continue;
        }
        const type = await imageType(f);
        if (!type) {
          refused ||= NOT_A_SHOT;
          continue;
        }
        const key = this.next++;
        const name = f.name || `screenshot-${key}.${type === 'jpeg' ? 'jpg' : type}`;
        this.shots.update((l) => [...l, { key, file: f, name, url: URL.createObjectURL(f), note: '' }]);
      }
      this.error.set(refused);
    });
  }

  setNote(s: Shot, ev: Event): void {
    const v = (ev.target as HTMLInputElement).value.replace(/[\r\n]+/g, ' ').slice(0, 300);
    this.shots.update((l) => l.map((x) => (x.key === s.key ? { ...x, note: v } : x)));
  }

  remove(s: Shot): void {
    URL.revokeObjectURL(s.url);
    this.shots.update((l) => l.filter((x) => x.key !== s.key));
    this.error.set('');
  }

  async fix(): Promise<void> {
    const list = this.shots();
    if (!list.length) return;
    this.error.set('');
    const ok = await this.driver.startScreenshots(list.map((s) => ({ file: s.file, name: s.name, note: s.note.trim() })));
    if (ok) this.clear();
  }

  private clear(): void {
    for (const s of this.shots()) URL.revokeObjectURL(s.url);
    this.shots.set([]);
  }

  ngOnDestroy(): void {
    this.clear();
  }
}
