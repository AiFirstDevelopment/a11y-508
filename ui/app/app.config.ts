import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withNavigationErrorHandler } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { routes } from './app.routes';
import { reloadIfStale } from './core/stale-build';

export const appConfig: ApplicationConfig = {
  // reloadIfStale: a page from before an update loads itself afresh instead of showing "Failed to fetch dynamically imported module".
  providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection(), provideRouter(routes, withComponentInputBinding(), withNavigationErrorHandler((e) => void reloadIfStale(e))), provideAnimationsAsync()],
};
