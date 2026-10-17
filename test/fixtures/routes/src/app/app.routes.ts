import { Routes } from '@angular/router';
import { HomeComponent } from './home/home.component';
import { SearchComponent } from './search/search.component';
import { LayoutComponent } from './layout/layout.component';
import { DefaultComponent } from './layout/default.component';
import { FormPanelComponent } from './layout/form-panel.component';
import { WorkflowComponent } from './layout/workflow.component';
import { UserComponent } from './users/user.component';
import { NotFoundComponent } from './not-found.component';

// The fixture router (docs/plans/pictures-and-routes.md AC 4): a flat route, nested children with a
// '' default, a loadChildren to a routes file and to an NgModule, a ':id' parameter, a '**' wildcard.
const HELP_ROUTES: Routes = [{ path: 'help', component: HomeComponent, data: { title: 'Help [and support], {braces}' } }];

export const routes: Routes = [
  { path: '', component: HomeComponent, pathMatch: 'full' },
  { path: 'search', component: SearchComponent, title: "Search 'page'" },
  {
    path: 'layout',
    component: LayoutComponent,
    children: [
      { path: '', redirectTo: 'default', pathMatch: 'full' },
      { path: 'default', component: DefaultComponent }, // a comment with [brackets] and 'quotes'
      { path: 'form-panel', component: FormPanelComponent, data: { title: `Form panel ${'x'}` } },
      /* { path: 'commented-out', component: DefaultComponent }, */
      { path: 'workflow/:id', component: WorkflowComponent, children: [{ path: 'steps', component: WorkflowComponent }] },
    ],
  },
  { path: 'reports', loadChildren: () => import('./reports/reports.routes').then((m) => m.REPORTS_ROUTES) },
  { path: 'admin', loadChildren: () => import('./admin/admin.module').then((m) => m.AdminModule) },
  { path: 'users/:id', component: UserComponent },
  ...HELP_ROUTES,
  { path: '**', component: NotFoundComponent },
];
