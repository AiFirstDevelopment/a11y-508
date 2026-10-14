import { Component, OnInit, inject, signal } from '@angular/core';
import { Diagnostics, diagnosticsText, entryTime } from '../core/diagnostics';

// The diagnostics diary, newest first: every browser that went away and why, every kill a11y-508
// made or refused, runs that failed, the dashboard starting and stopping. Copy diagnostics puts the
// last 50 entries on the clipboard as text, to paste to a developer.
@Component({
  selector: 'app-diagnostics',
  template: `
    <h1>Diagnostics</h1>
    <p class="hint">What went away and why: the dashboard's browser window, a crawl's browser, a run, the dashboard itself. Copy the list and paste it to a developer when something closes that should not.</p>
    <div class="actions">
      <button type="button" (click)="copy()" data-testid="diagnostics-copy" [disabled]="!diag.entries()?.length">Copy diagnostics</button>
      <button type="button" class="secondary" (click)="diag.load()">Refresh</button>
      <span role="status" data-testid="diagnostics-copied">{{ copied() }}</span>
    </div>
    @if (diag.error()) { <p class="notice error" role="alert">{{ diag.error() }}</p> }
    @if (diag.entries(); as list) {
      @if (list.length) {
        <ol class="diary" data-testid="diagnostics-list" reversed>
          @for (e of list; track $index) {
            <li data-testid="diagnostics-entry">
              <time [attr.datetime]="e.at">{{ time(e.at) }}</time>
              <span class="wrap" data-testid="diagnostics-text">{{ e.text }}</span>
              @if (e.details.length) {
                <details><summary>Details</summary><pre class="wrap">{{ e.details.join('\\n') }}</pre></details>
              }
            </li>
          }
        </ol>
      } @else {
        <p data-testid="diagnostics-empty">Nothing has been recorded yet.</p>
      }
    } @else {
      <p role="status">Loading…</p>
    }
  `,
  styles: [`
    .diary { padding-left: 0; list-style: none; }
    .diary li { border-bottom: 1px solid var(--line, #ddd); padding: 6px 0; }
    .diary time { display: block; color: var(--muted); font-size: 0.85rem; }
    .diary pre { font-size: 0.85rem; margin: 4px 0; }
  `],
})
export class DiagnosticsScreen implements OnInit {
  readonly diag = inject(Diagnostics);
  readonly copied = signal('');
  readonly time = entryTime;
  readonly text = () => diagnosticsText(this.diag.entries() || []);

  ngOnInit(): void {
    void this.diag.load();
  }

  async copy(): Promise<void> {
    const text = this.text();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Without clipboard access: a copy selected and copied the old way, then removed.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const n = Math.min(50, this.diag.entries()?.length || 0);
    this.copied.set(`Copied the last ${n} entr${n === 1 ? 'y' : 'ies'}.`);
  }
}
