import { Component, inject, input } from '@angular/core';
import { EnvStore } from '../core/env.store';
import { commitUrl } from '../core/git-links';
import { spoken } from '../core/format';

// One fix attempt of the loop: the finding, the files the working tree showed changed, what became
// of them, and how long the assistant and the check took.
export interface ChangeRow {
  round: number;
  n: number | null;
  test: string;
  message: string;
  elements?: number | null;
  files: string[];
  outcome: string;
  commit: string | null;
  agentMs: number | null;
  gateMs: number | null;
  gateCode: number | null;
  gateTail: string | null;
  // The finding's whole story in a line (History's rows): found, fixed, did not hold, verified, given up.
  story?: string | null;
}

// The "Changes this run" list (and History's per round): one row per fix attempt.
@Component({
  selector: 'app-changes-table',
  template: `
    <table class="changes" [attr.aria-label]="label()" data-testid="changes-table">
      <thead><tr><th scope="col">Finding</th><th scope="col">Files changed</th><th scope="col">Outcome</th><th scope="col">Assistant</th><th scope="col">Check</th></tr></thead>
      <tbody>
        @for (r of rows(); track $index) {
          <tr [attr.data-outcome]="r.outcome">
            <th scope="row" class="wrap">{{ r.test }} {{ r.message }}@if (r.elements && r.elements > 1) { <span class="hint"> ({{ r.elements }} elements)</span> }@if (r.story) { <div class="hint" data-testid="change-story">{{ r.story }}</div> }</th>
            <td class="wrap" data-testid="change-files">
              @if (r.files.length) {
                <ul class="plain">@for (f of r.files; track f) { <li><code>{{ f }}</code></li> }</ul>
              } @else { — }
            </td>
            <td data-testid="change-outcome">
              @if (r.outcome === 'committed' && link(r.commit); as href) {
                committed <a [href]="href" target="_blank" rel="noopener" data-testid="commit-link">{{ r.commit }}</a>
              } @else if (r.outcome === 'failed-gate') {
                <details><summary>reverted: check failed{{ r.gateCode !== null ? ' (exit ' + r.gateCode + ')' : '' }}</summary><pre tabindex="0">{{ r.gateTail || '(no output)' }}</pre></details>
              } @else {
                {{ outcomeText(r) }}
              }
            </td>
            <td>{{ r.agentMs !== null ? time(r.agentMs) : '—' }}</td>
            <td>{{ r.gateMs !== null ? time(r.gateMs) : '—' }}</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class ChangesTable {
  private env = inject(EnvStore);
  link(sha: string | null): string | null {
    return commitUrl(this.env.env()?.remoteWeb, sha);
  }
  readonly rows = input<ChangeRow[]>([]);
  readonly label = input('Changes');
  time(ms: number): string {
    return spoken(ms);
  }
  outcomeText(r: ChangeRow): string {
    if (r.outcome === 'committed') return `committed ${r.commit || ''}`.trim();
    if (r.outcome === 'timed-out') return 'timed out';
    if (r.outcome === 'commit-failed') return 'commit failed';
    return 'no change';
  }
}
