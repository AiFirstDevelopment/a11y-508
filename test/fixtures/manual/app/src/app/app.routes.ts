import { Routes } from '@angular/router';
import { HomeComponent } from './home/home.component';

// The fixture app's router (docs/plans/pictures-and-routes.md AC 4/8): the tool reads its routes when
// no crawl has run. test/manual-site.mjs serves / and /search; /reports is a route the router names
// that the deployed site shows its Not Found view for (HTTP 200), and /gone answers HTTP 404.
export const routes: Routes = [
  { path: '', component: HomeComponent, pathMatch: 'full' },
  { path: 'search', loadComponent: () => import('./search/search-bar.component').then((m) => m.SearchBarComponent) },
  { path: 'reports', component: HomeComponent },
  { path: 'gone', component: HomeComponent },
  { path: 'items/:id', component: HomeComponent },
  { path: '**', component: HomeComponent },
];
