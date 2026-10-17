import { Component, computed, input, output, signal } from '@angular/core';
import { ManualComponent } from '../core/manual';

let nextId = 0;

// The component picker of a plan item (docs/plans/manual-findings.md AC 5): a searchable listbox of
// the repository's components. Typing filters by name, selector or path; only a listed entry can be
// chosen (a click, or Enter on the highlighted option); what is typed is never the value.
@Component({
  selector: 'app-component-picker',
  template: `
    <div class="picker" data-testid="component-picker">
      <label [for]="inputId">Component</label>
      <p class="chosen" data-testid="component-chosen">@if (value(); as v) {<code>{{ v.name }}</code>@if (v.selector) { &lt;{{ v.selector }}&gt;} · {{ v.file || 'no file' }}} @else {none chosen}</p>
      @if (!disabled()) {
        <input [id]="inputId" type="text" role="combobox" autocomplete="off" aria-autocomplete="list" [attr.aria-expanded]="open()" [attr.aria-controls]="listId"
          [attr.aria-activedescendant]="open() && active() >= 0 && matches().length ? listId + '-' + active() : null" placeholder="Type to find another component"
          data-testid="component-search" [value]="query()" (input)="onInput($event)" (keydown)="onKey($event)" (focus)="open.set(true)" (blur)="close()" />
        @if (open()) {
          <ul role="listbox" [id]="listId" [attr.aria-label]="'Components'" data-testid="component-options">
            @for (c of matches(); track c.file + c.name; let i = $index) {
              <li role="option" [id]="listId + '-' + i" [attr.aria-selected]="i === active()" [class.active]="i === active()" data-testid="component-option" (mousedown)="$event.preventDefault(); choose(c)">
                <strong>{{ c.name }}</strong>@if (c.selector) { &lt;{{ c.selector }}&gt;} <span class="file">{{ c.file }}</span>
              </li>
            }
            @if (!matches().length) { <li role="option" aria-disabled="true" class="none" data-testid="component-none">No component matches “{{ query() }}”</li> }
          </ul>
        }
      }
    </div>
  `,
  styles: [`
    .picker { position: relative; margin: 4px 0; }
    .picker label { color: var(--muted); }
    .picker .chosen { margin: 2px 0; overflow-wrap: anywhere; }
    .picker input { width: 100%; box-sizing: border-box; }
    .picker ul { list-style: none; margin: 2px 0 0; padding: 0; max-height: 220px; overflow: auto; border: 1px solid var(--muted); background: var(--bg, #fff); }
    .picker li { padding: 4px 8px; cursor: pointer; overflow-wrap: anywhere; }
    .picker li.active { outline: 2px solid var(--accent); outline-offset: -2px; }
    .picker li.none { cursor: default; color: var(--muted); }
    .picker .file { color: var(--muted); font-size: 0.85em; }
  `],
})
export class ComponentPicker {
  readonly components = input<ManualComponent[]>([]);
  readonly value = input<ManualComponent | null>(null);
  readonly disabled = input(false);
  readonly pick = output<ManualComponent>();
  readonly inputId = `component-picker-${++nextId}`;
  readonly listId = `${this.inputId}-list`;
  readonly query = signal('');
  readonly open = signal(false);
  readonly active = signal(0);
  readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.components();
    const list = q ? all.filter((c) => [c.name, c.selector || '', c.file || ''].some((x) => x.toLowerCase().includes(q))) : all;
    return list.slice(0, 50);
  });

  onInput(ev: Event): void {
    this.query.set((ev.target as HTMLInputElement).value);
    this.open.set(true);
    this.active.set(0);
  }

  onKey(ev: KeyboardEvent): void {
    const n = this.matches().length;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this.open.set(true);
      if (n) this.active.set((this.active() + 1) % n);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (n) this.active.set((this.active() - 1 + n) % n);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      // Only a listed entry: with nothing matching, Enter chooses nothing.
      const c = this.matches()[this.active()];
      if (this.open() && c) this.choose(c);
    } else if (ev.key === 'Escape') {
      this.close();
    }
  }

  choose(c: ManualComponent): void {
    this.pick.emit({ name: c.name, file: c.file, selector: c.selector || null });
    this.query.set('');
    this.open.set(false);
  }

  close(): void {
    this.open.set(false);
    this.query.set('');
  }
}
