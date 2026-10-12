import { Injectable, signal } from '@angular/core';

export type AuthMode = 'token' | 'env' | 'state' | 'cookies' | 'none';

// Advanced flags: [flag, label, kind]. Everything parseArgs accepts that the
// form may set; --out, --json, --quiet and --events belong to the server.
// 'profile' is a checkbox for --wcag 2.2, the rules beyond Section 508.
export const ADVANCED: [string, string, 'value' | 'list' | 'switch' | 'profile'][] = [
  ['wcag', 'Also check WCAG 2.2 (beyond Section 508)', 'profile'],
  ['max-depth', 'Maximum link depth', 'value'],
  ['concurrency', 'Parallel tabs', 'value'],
  ['viewport', 'Viewport (WIDTHxHEIGHT)', 'value'],
  ['timeout', 'Page load timeout (ms)', 'value'],
  ['settle', 'Extra wait after load (ms)', 'value'],
  ['header', 'Extra request headers ("Name: value", one per line)', 'list'],
  ['token-header', 'Header that carries the token', 'value'],
  ['auth-origin', 'Other origins that receive the token (one per line)', 'list'],
  ['token-storage', 'Web storage keys to seed the token into (one per line)', 'list'],
  ['no-token-storage', 'Do not seed the token into web storage', 'switch'],
  ['no-interact', 'Skip the keyboard and disclosure passes', 'switch'],
  ['no-zoom', 'Skip the 200% zoom pass', 'switch'],
  ['no-screenshots', 'Do not capture element screenshots', 'switch'],
  ['max-screenshots', 'Screenshots per page', 'value'],
  ['max-tabs', 'Maximum Tab presses per page', 'value'],
  ['max-activations', 'Disclosure controls activated per page', 'value'],
  ['max-clicks', 'Navigation controls clicked per page', 'value'],
  ['no-follow-clicks', 'Follow href links only (do not click controls)', 'switch'],
  ['user-agent', 'User agent', 'value'],
  ['chrome', 'Browser executable path', 'value'],
  ['no-sandbox', 'Pass --no-sandbox to Chrome', 'switch'],
];

// The Run form, shared by Run, Troubleshoot, Sign in and Fix loop.
@Injectable({ providedIn: 'root' })
export class FormStore {
  readonly url = signal('');
  readonly authMode = signal<AuthMode>('token');
  readonly token = signal('');
  readonly cookies = signal('');
  readonly maxPages = signal('');
  readonly include = signal('');
  readonly exclude = signal('');
  readonly failOn = signal('critical,serious');
  readonly advanced = signal<Record<string, string | boolean>>({});

  setAdvanced(flag: string, value: string | boolean): void {
    this.advanced.update((a) => ({ ...a, [flag]: value }));
  }

  options(): Record<string, unknown> {
    const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    const o: Record<string, unknown> = {};
    if (this.maxPages().trim()) o['max-pages'] = this.maxPages().trim();
    if (lines(this.include()).length) o['include'] = lines(this.include());
    if (lines(this.exclude()).length) o['exclude'] = lines(this.exclude());
    if (this.failOn().trim() && this.failOn().trim() !== 'critical,serious') o['fail-on'] = this.failOn().trim();
    for (const [flag, , kind] of ADVANCED) {
      const v = this.advanced()[flag];
      if (kind === 'switch') {
        if (v === true) o[flag] = true;
      } else if (kind === 'profile') {
        if (v === true) o[flag] = '2.2';
      } else if (kind === 'list') {
        if (typeof v === 'string' && lines(v).length) o[flag] = lines(v);
      } else if (typeof v === 'string' && v.trim()) o[flag] = v.trim();
    }
    return o;
  }

  // The token goes into the request only; the field is cleared once sent.
  auth(includeToken: boolean): Record<string, unknown> {
    const mode = this.authMode();
    if (mode === 'token') return includeToken && this.token() ? { mode, token: this.token() } : { mode };
    if (mode === 'cookies') return { mode, cookies: this.cookies().split('\n').map((c) => c.trim()).filter(Boolean) };
    return { mode };
  }

  body(kind: string, includeToken = true): Record<string, unknown> {
    return { kind, url: this.url().trim(), options: this.options(), auth: this.auth(includeToken) };
  }

  clearToken(): void {
    this.token.set('');
  }

  addTokenStorage(key: string): void {
    const cur = String(this.advanced()['token-storage'] || '');
    const keys = cur.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!keys.includes(key)) keys.push(key);
    this.setAdvanced('token-storage', keys.join('\n'));
  }
}
