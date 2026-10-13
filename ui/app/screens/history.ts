import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { resultWord, localTime } from '../core/format';
import { ReportListEntry } from '../core/types';

@Component({
  selector: 'app-history-screen',
  imports: [RouterLink],
  template: `
    <h1>History</h1>
    <p>Every crawl, newest first, with the fix loop's rounds beside them. The latest crawl stays in a11y-508-report/; earlier ones move to a11y-508-history/.</p>
    @if (error()) {
      <div class="notice error" role="alert">{{ error() }}</div>
    }
    <p role="status" class="hint" data-testid="history-status">{{ status() }}</p>
    @if (earlier().length) {
      <div class="actions">
        <button type="button" class="secondary" (click)="clear()" data-testid="clear-history">Clear history</button>
      </div>
    }
    @if (list().length) {
      <table data-testid="history">
        <caption>Reports</caption>
        <thead><tr><th scope="col">Report</th><th scope="col">Finished</th><th scope="col">Result</th><th scope="col">Pages audited</th><th scope="col">Violations</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          @for (r of list(); track r.id) {
            <tr [attr.data-id]="r.id" [attr.data-source]="r.source">
              <th scope="row"><a [routerLink]="r.id === 'latest' ? ['/report'] : ['/report', r.id]">{{ name(r) }}</a></th>
              <td><time [attr.datetime]="r.finishedAt" [attr.title]="r.finishedAt" data-testid="finished">{{ local(r.finishedAt) }}</time></td>
              <td>{{ word(r.result) }}</td>
              <td>{{ r.summary.audited }}</td>
              <td>{{ r.summary.violations }}</td>
              <td>
                @if (r.source === 'history') {
                  <button type="button" class="secondary small" (click)="remove(r)" [attr.aria-label]="'Delete ' + name(r) + ', finished ' + local(r.finishedAt)">Delete</button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <p>No reports yet. <a routerLink="/run">Run a crawl</a>.</p>
    }
  `,
})
export class HistoryScreen {
  private api = inject(Api);
  private env = inject(EnvStore);
  readonly list = signal<ReportListEntry[]>([]);
  readonly word = resultWord;
  readonly local = localTime;
  private loads = 0;
  readonly error = signal('');
  readonly status = signal('');
  // The reports in a11y-508-history/, which Clear history and Delete remove.
  readonly earlier = computed(() => this.list().filter((r) => r.source === 'history'));

  constructor() {
    // The list, again whenever the working directory changes.
    effect(() => {
      this.env.cwd();
      untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    const n = ++this.loads;
    let l: ReportListEntry[] = [];
    try {
      l = await this.api.get<ReportListEntry[]>('/api/reports');
    } catch {}
    if (n === this.loads) this.list.set(l);
  }

  async clear(): Promise<void> {
    const n = this.earlier().length;
    if (!confirm(`Remove ${n} earlier report${n === 1 ? '' : 's'} from a11y-508-history? The latest report and the loop's rounds stay. This cannot be undone.`)) return;
    await this.del('/api/reports/history', (r) => `Removed ${r.removed} earlier report${r.removed === 1 ? '' : 's'}.`);
  }

  async remove(e: ReportListEntry): Promise<void> {
    if (!confirm(`Delete the report of ${e.baseUrl} that finished ${localTime(e.finishedAt)}? This cannot be undone.`)) return;
    await this.del(`/api/reports/${encodeURIComponent(e.id)}`, () => 'Report deleted.');
  }

  private async del(path: string, said: (r: { removed: number }) => string): Promise<void> {
    this.error.set('');
    try {
      const r = await this.api.delete<{ removed: number }>(path);
      this.status.set(said(r));
    } catch (e: any) {
      this.error.set(e.message);
    }
    await this.load();
  }

  name(r: ReportListEntry): string {
    if (r.source === 'latest') return `Latest crawl of ${r.baseUrl}`;
    if (r.source === 'round') return `Loop round ${r.round} of ${r.baseUrl}`;
    return `Earlier crawl of ${r.baseUrl}`;
  }
}
