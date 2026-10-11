import { Component, input, signal } from '@angular/core';

export interface TableColumn {
  key: string;
  label: string;
}

// Every chart sits in one of these: a heading, the chart (projected), and a
// toggle that shows the same numbers as a table, because an SVG chart is not
// accessible on its own.
@Component({
  selector: 'app-chart-panel',
  template: `
    <section class="chart-panel" [attr.aria-labelledby]="id() + '-h'">
      <h3 [id]="id() + '-h'">{{ heading() }}</h3>
      <div class="chart" role="img" [attr.aria-label]="heading() + '. The same numbers are in the data table.'">
        <!-- The drawing is for sighted readers; its numbers are in the table, so nothing in it takes focus. -->
        <div inert><ng-content /></div>
      </div>
      <button type="button" class="secondary" [attr.aria-expanded]="open()" [attr.aria-controls]="id() + '-table'" (click)="open.set(!open())">
        {{ open() ? 'Hide data table' : 'Show data table' }}<span class="visually-hidden"> for {{ heading() }}</span>
      </button>
      @if (open()) {
        <table [id]="id() + '-table'" class="data-table" [attr.data-chart]="id()">
          <caption>{{ heading() }}</caption>
          <thead>
            <tr>
              @for (c of columns(); track c.key) {
                <th scope="col">{{ c.label }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track $index) {
              <tr>
                @for (c of columns(); track c.key; let first = $first) {
                  @if (first) {
                    <th scope="row">{{ r[c.key] }}</th>
                  } @else {
                    <td>{{ r[c.key] }}</td>
                  }
                }
              </tr>
            }
          </tbody>
        </table>
      }
    </section>
  `,
})
export class ChartPanel {
  readonly id = input.required<string>();
  readonly heading = input.required<string>();
  readonly columns = input.required<TableColumn[]>();
  readonly rows = input.required<Record<string, string | number>[]>();
  readonly open = signal(false);
}
