import { Routes, UrlSegment } from '@angular/router';

// The screens of the wizard that was (docs/plans/simple-screen.md): each, with anything under it, is
// now the one screen.
const OLD = ['run', 'live', 'report', 'fix-loop', 'history', 'troubleshoot', 'sign-in'];
const old = (segments: UrlSegment[]) => (segments.length && OLD.includes(segments[0].path) ? { consumed: segments } : null);

export const routes: Routes = [
  { path: '', pathMatch: 'full', title: 'a11y-508', loadComponent: () => import('./screens/home').then((m) => m.HomeScreen) },
  { path: 'diagnostics', title: 'Diagnostics - a11y-508', loadComponent: () => import('./screens/diagnostics').then((m) => m.DiagnosticsScreen) },
  // Linked only from the bottom of Diagnostics: the assistant, the crawl's and the loop's settings.
  { path: 'advanced', title: 'Advanced - a11y-508', loadComponent: () => import('./screens/advanced').then((m) => m.AdvancedScreen) },
  { matcher: old, redirectTo: '/' },
  { path: '**', title: 'Not found - a11y-508', loadComponent: () => import('./screens/not-found').then((m) => m.NotFoundScreen) },
];
