import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'run' },
  { path: 'run', title: 'Run a crawl - a11y-508', loadComponent: () => import('./screens/run').then((m) => m.RunScreen) },
  // Not linked from anywhere: the crawl's settings beyond the start URL, and the loop's settings.
  { path: 'run/advanced', title: 'Run a crawl: advanced settings - a11y-508', data: { advanced: true }, loadComponent: () => import('./screens/run').then((m) => m.RunScreen) },
  { path: 'live', title: 'Live run - a11y-508', loadComponent: () => import('./screens/live').then((m) => m.LiveScreen) },
  { path: 'report', title: 'Latest report - a11y-508', loadComponent: () => import('./screens/report').then((m) => m.ReportScreen) },
  { path: 'report/:id', title: 'Report - a11y-508', loadComponent: () => import('./screens/report').then((m) => m.ReportScreen) },
  { path: 'troubleshoot', title: 'Troubleshoot - a11y-508', loadComponent: () => import('./screens/troubleshoot').then((m) => m.TroubleshootScreen) },
  { path: 'sign-in', title: 'Sign in - a11y-508', loadComponent: () => import('./screens/sign-in').then((m) => m.SignInScreen) },
  { path: 'fix-loop/settings', title: 'Fix loop settings - a11y-508', data: { settings: true }, loadComponent: () => import('./screens/fix-loop').then((m) => m.FixLoopScreen) },
  { path: 'fix-loop', title: 'Fix loop - a11y-508', loadComponent: () => import('./screens/fix-loop').then((m) => m.FixLoopScreen) },
  { path: 'history', title: 'History - a11y-508', loadComponent: () => import('./screens/history').then((m) => m.HistoryScreen) },
  { path: '**', title: 'Not found - a11y-508', loadComponent: () => import('./screens/not-found').then((m) => m.NotFoundScreen) },
];
