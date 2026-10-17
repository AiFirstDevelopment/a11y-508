import { Routes } from '@angular/router';
import { ReportsComponent } from './reports.component';
import { SummaryComponent } from './summary.component';
import { DetailComponent } from './detail.component';

export const REPORTS_ROUTES: Routes = [
  { path: '', component: ReportsComponent },
  { path: 'summary', component: SummaryComponent },
  { path: ':year/detail', component: DetailComponent },
];
