import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
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
export class HistoryScreen implements OnInit {
  private api = inject(Api);
  readonly list = signal<ReportListEntry[]>([]);
  readonly word = resultWord;

  async ngOnInit(): Promise<void> {
    try {
      this.list.set(await this.api.get<ReportListEntry[]>('/api/reports'));
    } catch {
      this.list.set([]);
    }
  }

  name(r: ReportListEntry): string {
    if (r.source === 'latest') return `Latest crawl of ${r.baseUrl}`;
    if (r.source === 'round') return `Loop round ${r.round} of ${r.baseUrl}`;
    return `Earlier crawl of ${r.baseUrl}`;
  }
}
