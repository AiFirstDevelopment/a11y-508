import { Component, OnInit, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { EnvStore } from './core/env.store';
import { RunStore } from './core/run.store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip" href="#main">Skip to main content</a>
    <header class="top">
      <p class="brand">a11y-508 <span>dashboard</span></p>
      <nav aria-label="Main">
        <ul>
          @for (l of links; track l.path) {
            <li><a [routerLink]="l.path" routerLinkActive="active" ariaCurrentWhenActive="page">{{ l.label }}</a></li>
          }
        </ul>
      </nav>
      @if (env.env(); as e) {
        <p class="where">Working directory <code>{{ e.cwd }}</code> · tool {{ e.version }}</p>
      }
    </header>
    <main id="main" tabindex="-1">
      @if (env.error()) {
        <div class="notice error" role="alert">{{ env.error() }}</div>
      }
      @if (env.env()?.build?.fresh === false) {
        <div class="notice warn" role="status">{{ env.env()?.build?.reason }}</div>
      }
      <router-outlet />
    </main>
  `,
})
export class App implements OnInit {
  readonly env = inject(EnvStore);
  private run = inject(RunStore);
  readonly links = [
    { path: '/run', label: 'Run' },
    { path: '/live', label: 'Live run' },
    { path: '/report', label: 'Report' },
    { path: '/troubleshoot', label: 'Troubleshoot' },
    { path: '/sign-in', label: 'Sign in' },
    { path: '/fix-loop', label: 'Fix loop' },
    { path: '/history', label: 'History' },
  ];

  async ngOnInit(): Promise<void> {
    const e = await this.env.load();
    if (e?.run) void this.run.connect();
  }
}
