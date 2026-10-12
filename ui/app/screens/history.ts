import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { EnvStore } from '../core/env.store';
import { resultWord } from '../core/format';
import { ReportListEntry } from '../core/types';

@Component({
  selector: 'app-history-screen',
  imports: [RouterLink],
  template: `
    <h1>History</h1>
    <p>Every crawl, newest first, with the fix loop's rounds beside them. The latest crawl stays in a11y-508-report/; earlier ones move to a11y-508-history/.</p>
    @if (list().length) {
      <table data-testid="history">
        <caption>Reports</caption>
        <thead><tr><th scope="col">Report</th><th scope="col">Finished</th><th scope="col">Result</th><th scope="col">Pages audited</th><th scope="col">Violations</th></tr></thead>
        <tbody>
          @for (r of list(); track r.id) {
            <tr [attr.data-id]="r.id" [attr.data-source]="r.source">
              <th scope="row"><a [routerLink]="r.id === 'latest' ? ['/report'] : ['/report', r.id]">{{ name(r) }}</a></th>
              <td>{{ r.finishedAt }}</td>
              <td>{{ word(r.result) }}</td>
              <td>{{ r.summary.audited }}</td>
              <td>{{ r.summary.violations }}</td>
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
  private loads = 0;

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

  name(r: ReportListEntry): string {
    if (r.source === 'latest') return `Latest crawl of ${r.baseUrl}`;
    if (r.source === 'round') return `Loop round ${r.round} of ${r.baseUrl}`;
    return `Earlier crawl of ${r.baseUrl}`;
  }
}
