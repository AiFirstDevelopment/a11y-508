import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { EnvInfo } from './types';

@Injectable({ providedIn: 'root' })
export class EnvStore {
  private api = inject(Api);
  readonly env = signal<EnvInfo | null>(null);
  readonly error = signal<string | null>(null);
  // The working directory; screens that read from it re-read when it changes.
  readonly cwd = computed(() => this.env()?.cwd ?? null);

  async load(refresh = false): Promise<EnvInfo | null> {
    try {
      const e = await this.api.get<EnvInfo>(`/api/env${refresh ? '?refresh=1' : ''}`);
      this.env.set(e);
      this.error.set(null);
      return e;
    } catch (e: any) {
      this.error.set(e.status === 401 ? 'This page has no session secret. Open the address the dashboard printed when it started.' : e.message);
      return null;
    }
  }

  // Switches the server's working directory; throws the server's error.
  async switchTo(path: string): Promise<EnvInfo> {
    const e = await this.api.put<EnvInfo>('/api/cwd', { path });
    this.env.set(e);
    this.error.set(null);
    return e;
  }
}
