import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormStore } from '../core/form.store';
import { RunStore } from '../core/run.store';
import { shortUrl } from '../core/format';

@Component({
  selector: 'app-troubleshoot-screen',
  imports: [RouterLink],
  template: `
    <h1>Troubleshoot</h1>
    <p>Loads only the start URL with the sign-in settings from the <a routerLink="/run">Run</a> screen and explains what happened.</p>
    <div class="actions">
      <button type="button" (click)="runIt()" [disabled]="store.active() || !form.url()">Troubleshoot {{ form.url() || 'the start URL' }}</button>
    </div>
    @if (store.kind() === 'troubleshoot' && store.active()) {
      <p role="status">Loading the start page…</p>
    }
    @if (result(); as r) {
      <section aria-labelledby="verdict-h" data-testid="troubleshoot">
        <h2 id="verdict-h">Verdict</h2>
        <p data-testid="verdict" [class.ok]="r.ok">{{ r.verdict }}</p>
        <h2>Next step</h2>
        <p data-testid="next">{{ r.next }}</p>
        @if (nextFlag(); as key) {
          <button type="button" (click)="retryWithStorage(key)" data-testid="next-button">Retry with --token-storage {{ key }}</button>
        } @else if (needsLogin()) {
          <a class="button" routerLink="/sign-in" data-testid="next-button">Sign in</a>
        }
        <h2>Navigation</h2>
        <ol class="timeline" data-testid="hops">
          @for (h of r.navigation.hops; track $index) {
            <li>
              @switch (h.kind) {
                @case ('start') { GET {{ short(h.url) }} }
                @case ('redirect') { HTTP {{ h.status }} redirect to {{ short(h.to) }} }
                @case ('response') { HTTP {{ h.status }} {{ h.mimeType }} }
                @default { {{ h.initiator === 'script' ? 'The page script navigated to' : 'Navigated to' }} {{ short(h.url) }} }
              }
            </li>
          }
        </ol>
        <p>Landed on {{ short(r.navigation.final.url) }}, title “{{ r.navigation.final.title }}”, {{ r.navigation.final.links }} link(s).</p>
        <h2>Authentication</h2>
        @if (r.auth) {
          <p data-testid="header-went-out">The {{ r.auth.header }} header was sent on {{ r.auth.sentOn }} request(s){{ r.auth.onDocument === false ? ', but NOT on the page request itself' : r.auth.onDocument ? ', including the page request' : '' }}.</p>
        } @else {
          <p data-testid="header-went-out">No token was set, so no header was sent.</p>
        }
        <h2>What the app read</h2>
        <ul>
          <li>localStorage: {{ keys(r.storage.read.localStorage) }}</li>
          <li>sessionStorage: {{ keys(r.storage.read.sessionStorage) }}</li>
          <li>Cookies afterwards: {{ cookies(r.cookies) }}</li>
        </ul>
      </section>
    } @else if (!store.active()) {
      <p>No troubleshoot result yet.</p>
    }
  `,
})
export class TroubleshootScreen {
  readonly store = inject(RunStore);
  readonly form = inject(FormStore);
  private router = inject(Router);
  readonly short = shortUrl;
  readonly result = computed(() => (this.store.kind() === 'troubleshoot' ? this.store.troubleshoot() : null));
  readonly nextFlag = computed(() => /--token-storage (\S+?)[.,)]?(\s|$)/.exec(this.result()?.next || '')?.[1] || null);
  readonly needsLogin = computed(() => /--login-only/.test(this.result()?.next || ''));

  keys(list: { key: string; seeded: boolean; present: boolean }[]): string {
    return list.length ? list.map((k) => `${k.key}${k.seeded ? ' (seeded)' : ''}${k.present ? '' : ' (missing)'}`).join(', ') : 'nothing';
  }
  cookies(list: { name: string; domain: string }[]): string {
    return list.length ? list.map((c) => `${c.name} on ${c.domain}`).join(', ') : 'none';
  }

  async runIt(): Promise<void> {
    await this.store.start(this.form.body('troubleshoot'));
    this.form.clearToken();
  }

  async retryWithStorage(key: string): Promise<void> {
    this.form.addTokenStorage(key);
    await this.store.start(this.form.body('crawl'));
    this.form.clearToken();
    await this.router.navigateByUrl('/live');
  }
}
