import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';

// One entry of the diagnostics diary (src/diary.mjs), in the server's plain words.
export interface DiaryEntry {
  at: string;
  type: string;
  text: string;
  details: string[];
}

// The dashboard's own browser: open, closed (with the last exit, in words), or none.
export interface OwnBrowser {
  status: 'open' | 'closed' | 'none';
  pid: number | null;
  lastExit: (DiaryEntry & { code: number | null; signal: string | null; kill: string | null; doing: string | null }) | null;
  dismissed: boolean;
  canReopen: boolean;
}

// The time an entry was written, as a person reads it: "Oct 14, 4:52:07 PM".
export function entryTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

// The entries as text to paste to a developer: the newest `limit`, each with its details indented.
export function diagnosticsText(entries: DiaryEntry[], limit = 50): string {
  return entries
    .slice(0, limit)
    .map((e) => [`${e.at}  ${e.text}`, ...e.details.map((d) => `    ${d}`)].join('\n'))
    .join('\n');
}

@Injectable({ providedIn: 'root' })
export class Diagnostics {
  private api = inject(Api);
  readonly own = signal<OwnBrowser | null>(null);
  readonly entries = signal<DiaryEntry[] | null>(null);
  readonly error = signal('');
  private timer: ReturnType<typeof setInterval> | null = null;

  // The own browser's state, now and every few seconds (the notice must appear in any window
  // still looking at the dashboard, and after a reopen).
  watch(everyMs = 3000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), everyMs);
  }

  async refresh(): Promise<void> {
    try {
      this.own.set(await this.api.get<OwnBrowser>('/api/own-browser', 10000));
    } catch {}
  }

  async load(): Promise<void> {
    try {
      const r = await this.api.get<{ entries: DiaryEntry[]; ownBrowser: OwnBrowser }>('/api/diagnostics', 20000);
      this.entries.set(r.entries);
      this.own.set(r.ownBrowser);
      this.error.set('');
    } catch (e: any) {
      this.error.set(e.message);
    }
  }

  // What a second launch does: a new window in the dashboard's own browser, or that browser again.
  async reopen(): Promise<void> {
    await this.api.post('/api/open', {});
    await this.refresh();
  }

  async dismiss(): Promise<void> {
    this.own.set(await this.api.post<OwnBrowser>('/api/own-browser/dismiss', {}));
  }
}
