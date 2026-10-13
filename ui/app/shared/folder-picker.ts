import { ChangeDetectorRef, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Starter } from '../core/starter';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { DirEntry, DirListing, FACTS } from '../core/types';

export const RECENT_KEY = 'a11y508.recentDirs';
export const HIDDEN_KEY = 'a11y508.showHiddenDirs';
const RECENT_MAX = 8;

// Per-viewer conveniences in the browser: the recent folders and the hidden
// toggle. Storage can be missing or throw (private windows); both are optional.
function readRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function writeRecents(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
}

// The dialog that chooses the app's repository folder, opened by Browse… on Set up. A
// browser cannot hand a page a filesystem path, so the local server lists the
// folders and the dialog browses them.
@Component({
  selector: 'app-folder-picker',
  template: `
    <dialog #dlg class="picker" aria-labelledby="picker-h" data-testid="folder-picker" (close)="closed()">
      @if (isOpen()) {
        <h2 id="picker-h">Choose the app's repository folder</h2>
        <p class="hint">Now: <code data-testid="picker-current">{{ env.cwd() }}</code></p>
        <form class="picker-path" (submit)="$event.preventDefault(); go()">
          <label for="picker-path">Path</label>
          <div class="inline">
            <input
              #pathInput
              id="picker-path"
              type="text"
              autocomplete="off"
              spellcheck="false"
              [value]="pathText()"
              (input)="typed(val($event))"
              [attr.aria-invalid]="error() ? 'true' : null"
              [attr.aria-describedby]="error() ? 'picker-error picker-path-hint' : 'picker-path-hint'"
            />
            <button type="submit" class="secondary">Go<span class="visually-hidden"> to this path</span></button>
          </div>
          <p id="picker-path-hint" class="hint">An absolute path, or ~ for your home folder.</p>
          @if (error()) {
            <p id="picker-error" class="notice error" role="alert" data-testid="picker-error">{{ error() }}</p>
          }
        </form>

        <nav aria-label="Folder path" class="crumbs" data-testid="crumbs">
          <ol>
            <li>
              <button type="button" class="link" (click)="browse(null)" [attr.aria-current]="listing()?.roots ? 'location' : null">{{ rootsLabel() }}</button>
            </li>
            @for (c of listing()?.crumbs || []; track c.path; let last = $last) {
              <li>
                <button type="button" class="link" (click)="browse(c.path)" [attr.aria-current]="last ? 'location' : null" [attr.data-path]="c.path">{{ c.name }}</button>
              </li>
            }
          </ol>
        </nav>

        <div class="choice">
          <input type="checkbox" id="picker-hidden" [checked]="showHidden()" (change)="setHidden($any($event.target).checked)" />
          <label for="picker-hidden">Show hidden folders</label>
        </div>
        <p id="picker-list-label" class="list-label">{{ listing() ? 'Folders in ' + (listing()!.path || rootsLabel()) : 'Loading folders…' }}</p>
        @if (visible().length) {
          <ul
            #list
            role="listbox"
            id="picker-list"
            tabindex="0"
            aria-labelledby="picker-list-label"
            [attr.aria-activedescendant]="active() >= 0 ? 'picker-opt-' + active() : null"
            (keydown)="key($event)"
            data-testid="picker-list"
          >
            @for (d of visible(); track d.path; let i = $index) {
              <li role="option" [id]="'picker-opt-' + i" [attr.aria-selected]="i === active()" [class.active]="i === active()" [attr.data-name]="d.name" (click)="active.set(i)" (dblclick)="openRow(i)">
                <span class="dir-name">{{ d.name }}</span>
                @for (f of factsOf(d); track f) {
                  <span class="badge" [attr.data-fact]="f"> {{ f }}</span>
                }
              </li>
            }
          </ul>
        } @else {
          <p data-testid="picker-empty">No folders here.</p>
        }
        <div class="actions">
          <button type="button" class="secondary" (click)="openRow(active())" [disabled]="active() < 0">Open<span class="visually-hidden"> the selected folder</span></button>
        </div>

        @if (recents().length) {
          <h3 id="recent-h">Recent</h3>
          <ul class="recents" aria-labelledby="recent-h" data-testid="recents">
            @for (r of recents(); track r) {
              <li [attr.data-path]="r">
                <button type="button" class="link" (click)="browse(r)">{{ r }}</button>
                @if (missing().has(r)) {
                  <span class="badge missing" data-testid="recent-missing"> missing</span>
                }
              </li>
            }
          </ul>
        }

        <div class="actions">
          <button type="button" (click)="choose()" [disabled]="!listing()?.path || busy()">Choose this folder</button>
          @if (env.env() && env.env()!.cwd !== env.env()!.launchDir) {
            <button type="button" class="secondary" (click)="backToStart()" [disabled]="busy()" [attr.title]="env.env()!.launchDir">Back to where I started</button>
          }
          <button type="button" class="secondary" (click)="cancel()">Cancel</button>
        </div>
      }
    </dialog>
  `,
})
export class FolderPicker {
  private api = inject(Api);
  private cdr = inject(ChangeDetectorRef);
  readonly env = inject(EnvStore);
  readonly run = inject(RunStore);
  private form = inject(FormStore);
  // The control that opened the picker (Browse… on Set up): focus goes back to it on close.
  private returnFocus: HTMLElement | null = null;
  private dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');
  private list = viewChild<ElementRef<HTMLUListElement>>('list');

  readonly reason = 'A run is active; the working directory can change once it has finished.';
  readonly isOpen = signal(false);
  readonly listing = signal<DirListing | null>(null);
  readonly pathText = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly active = signal(-1);
  readonly showHidden = signal(this.readHidden());
  readonly recents = signal<string[]>([]);
  readonly missing = signal<Set<string>>(new Set());

  // Browse… in Set up asks the picker to open.
  private starter = inject(Starter);
  private seenBrowse = this.starter.browseRequests();
  private browseEffect = effect(() => {
    const n = this.starter.browseRequests();
    untracked(() => {
      if (n !== this.seenBrowse) {
        this.seenBrowse = n;
        void this.open();
      }
    });
  });

  readonly rootsLabel = computed(() => (this.env.env()?.platform === 'win32' ? 'All drives' : 'This computer'));
  readonly visible = computed<DirEntry[]>(() => (this.listing()?.dirs || []).filter((d) => this.showHidden() || !d.hidden));

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  factsOf(d: DirEntry): string[] {
    return FACTS.filter((f) => d.facts[f]);
  }

  private readHidden(): boolean {
    try {
      return localStorage.getItem(HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  setHidden(on: boolean): void {
    this.showHidden.set(on);
    this.active.set(this.visible().length ? 0 : -1);
    try {
      localStorage.setItem(HIDDEN_KEY, on ? '1' : '0');
    } catch {}
  }

  async open(): Promise<void> {
    if (this.isOpen() || this.run.active()) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.error.set('');
    this.listing.set(null);
    this.pathText.set(this.env.cwd() || '');
    this.recents.set(readRecents());
    this.missing.set(new Set());
    this.isOpen.set(true);
    // Render the content, then open it modal with focus in the path field.
    this.cdr.detectChanges();
    this.dlg().nativeElement.showModal();
    this.pathInput()?.nativeElement.focus();
    void this.checkRecents();
    if (this.env.cwd()) await this.browse(this.env.cwd());
  }

  // Marks recents whose directory no longer answers.
  private async checkRecents(): Promise<void> {
    const gone = new Set<string>();
    await Promise.all(
      this.recents().map(async (r) => {
        try {
          await this.api.get(`/api/dirs?path=${encodeURIComponent(r)}`);
        } catch (e: any) {
          if (e.status === 404) gone.add(r);
        }
      })
    );
    this.missing.set(gone);
  }

  // Lists a directory (null: the roots). On an error the listing stays as it
  // was. Only the latest request counts: the listing opened with must not
  // land on top of a path typed while it was loading.
  private browses = 0;
  private edits = 0;
  typed(text: string): void {
    this.edits++;
    this.pathText.set(text);
  }
  async browse(path: string | null): Promise<boolean> {
    const n = ++this.browses;
    const edits = this.edits;
    try {
      const l = await this.api.get<DirListing>(path === null ? '/api/dirs' : `/api/dirs?path=${encodeURIComponent(path)}`);
      if (n !== this.browses) return false;
      this.listing.set(l);
      // A path typed while this was loading stays in the field.
      if (edits === this.edits) this.pathText.set(l.path || '');
      this.error.set('');
      this.active.set(this.visible().length ? 0 : -1);
      return true;
    } catch (e: any) {
      if (n === this.browses) this.error.set(e.message);
      return false;
    }
  }

  async go(): Promise<void> {
    const p = this.pathText().trim();
    if (!p) return;
    await this.browse(p);
  }

  async openRow(i: number): Promise<void> {
    const d = this.visible()[i];
    if (!d) return;
    if (await this.browse(d.path)) this.list()?.nativeElement.focus();
  }

  key(e: KeyboardEvent): void {
    const n = this.visible().length;
    if (!n) return;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(n - 1, this.active() + 1),
      ArrowUp: () => Math.max(0, this.active() - 1),
      Home: () => 0,
      End: () => n - 1,
    };
    if (moves[e.key]) {
      e.preventDefault();
      this.active.set(moves[e.key]());
      this.cdr.detectChanges();
      document.getElementById(`picker-opt-${this.active()}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void this.openRow(this.active());
    }
  }

  async choose(): Promise<void> {
    const p = this.listing()?.path;
    if (p) await this.switchTo(p);
  }

  async backToStart(): Promise<void> {
    const p = this.env.env()?.launchDir;
    if (p) await this.switchTo(p);
  }

  private async switchTo(path: string): Promise<void> {
    this.busy.set(true);
    const before = this.env.env();
    try {
      const after = await this.env.switchTo(path);
      // The finished run belonged to the old directory.
      this.run.forget();
      // Auth follows the new directory's saved session.
      if (after.session.exists && !before?.session.exists) this.form.authMode.set('state');
      else if (!after.session.exists && this.form.authMode() === 'state') this.form.authMode.set('token');
      writeRecents([after.cwd, ...readRecents().filter((r) => r !== after.cwd)].slice(0, RECENT_MAX));
      this.dlg().nativeElement.close();
    } catch (e: any) {
      this.error.set(e.message);
    } finally {
      this.busy.set(false);
    }
  }

  cancel(): void {
    this.dlg().nativeElement.close();
  }

  // Escape, Cancel and Choose all end here: focus goes back to Browse….
  closed(): void {
    this.isOpen.set(false);
    this.listing.set(null);
    this.returnFocus?.focus();
  }
}
