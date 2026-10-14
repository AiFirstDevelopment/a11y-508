import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { EnvInfo } from './types';

// The working directory last chosen in this browser (a per-viewer convenience).
export const CWD_KEY = 'a11y508.cwd';
export function rememberedCwd(): string | null {
  try {
    return localStorage.getItem(CWD_KEY);
  } catch {
    return null;
  }
}
export function rememberCwd(path: string): void {
  try {
    localStorage.setItem(CWD_KEY, path);
  } catch {}
}

@Injectable({ providedIn: 'root' })
export class EnvStore {
  private api = inject(Api);
  readonly env = signal<EnvInfo | null>(null);
  readonly error = signal<string | null>(null);
  // The working directory; screens that read from it re-read when it changes.
  readonly cwd = computed(() => this.env()?.cwd ?? null);

  // Every startup call gives up after this long, with a notice (never a blank screen).
  static readonly TIMEOUT_MS = 20000;

  async load(refresh = false): Promise<EnvInfo | null> {
    try {
      const e = await this.api.get<EnvInfo>(`/api/env${refresh ? '?refresh=1' : ''}`, refresh ? 0 : EnvStore.TIMEOUT_MS);
      this.env.set(e);
      this.error.set(null);
      return e;
    } catch (e: any) {
      this.error.set(e.status === 401 ? 'This page has no session secret, so it cannot talk to the dashboard. In the terminal, run "npm run ui" again: it opens the dashboard at the address that carries the secret. Or open the address it printed when it started.' : e.message);
      return null;
    }
  }

  // Switches the server's working directory; throws the server's error.
  // carry: the start URL; when the latest report is for it, the analysis comes along to the new folder.
  async switchTo(path: string, carry = ''): Promise<EnvInfo> {
    const e = await this.api.put<EnvInfo>('/api/cwd', carry ? { path, carry } : { path }, EnvStore.TIMEOUT_MS);
    rememberCwd(e.cwd);
    this.env.set(e);
    this.error.set(null);
    return e;
  }
}
