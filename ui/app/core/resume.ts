import { Injectable, inject } from '@angular/core';
import { Api } from './api';
import { EnvInfo } from './types';

// The dashboard resumes where it was (docs/plans/resume.md): it opens on the step the person was on
// (stored server-side as lastStep), on a live run, or on an interrupted fix loop (which the server
// continues by itself, docs/plans/turnkey-loop.md).

// The path the page was opened at, before the router sends '' to Set up. The address the server
// prints (and opens) is '/', which is where the stored step applies; a deep link is kept.
export const INITIAL_PATH = typeof location !== 'undefined' ? location.pathname : '/';
// Its query: /fix-loop?start=1 at load is a reload or a tab Chrome restored, never a fresh click.
export const INITIAL_SEARCH = typeof location !== 'undefined' ? location.search : '';

// The step a route belongs to, as lastStep stores it.
export function stepPath(url: string): string | null {
  const p = url.split(/[?#]/)[0];
  if (p === '/run' || p.startsWith('/run/') || p.startsWith('/sign-in')) return '/run';
  if (p.startsWith('/live') || p.startsWith('/troubleshoot')) return '/live';
  if (p.startsWith('/report')) return '/report';
  if (p.startsWith('/fix-loop')) return '/fix-loop';
  if (p.startsWith('/history')) return '/history';
  return null;
}

// Where the dashboard opens: a live run's step, an interrupted fix loop's Fix step, else the step
// the person was on.
export function landing(e: Pick<EnvInfo, 'run' | 'lastStep'>): string | null {
  const r = e.run;
  if (r && (r.status === 'running' || r.status === 'interrupted') && r.kind !== 'install') return ['loop', 'dry-run'].includes(r.kind) ? '/fix-loop' : '/live';
  // A step stored by an older build for a screen that no longer exists (e.g. /review) is ignored.
  return e.lastStep && stepPath(e.lastStep) === e.lastStep ? e.lastStep : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "13 Oct 2026, 4:52 PM", in the viewer's time zone.
export function when(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const h = d.getHours();
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// The interrupted fix loop the dashboard continued by itself, from its resume event: "The fix loop was
// interrupted at fix 8 of 20 on 13 Oct 2026, 4:52 PM (the dashboard was closed); continuing from
// there. The unfinished change to src/app/x.ts was discarded."
export function continuingText(ev: Record<string, any>): string {
  const n = ev['n'];
  const m = ev['m'];
  const where = n && m ? ` at fix ${n} of ${m}` : ev['round'] ? ` in round ${ev['round']}` : '';
  const on = ev['interruptedAt'] ? ` on ${when(String(ev['interruptedAt']))}` : '';
  const files: string[] = Array.isArray(ev['discarded']) ? ev['discarded'] : [];
  const gone = files.length === 1 ? ` The unfinished change to ${files[0]} was discarded.` : files.length ? ` The unfinished changes to ${files.join(', ')} were discarded.` : '';
  return `The fix loop was interrupted${where}${on} (the dashboard was closed); continuing from there.${gone}`;
}

@Injectable({ providedIn: 'root' })
export class Resume {
  private api = inject(Api);
  // Steps are stored only once the dashboard has decided where to open (the router's first
  // redirect to Set up is not the person's choice).
  private started = false;
  private saved: string | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;

  begin(current: string | null, stored: string | null): void {
    this.saved = stored;
    this.started = true;
    if (current) this.saveStep(current);
  }

  saveStep(path: string | null): void {
    if (!this.started || !path || path === this.saved) return;
    this.saved = path;
    this.api.put('/api/settings', { lastStep: path }).catch(() => (this.saved = null));
  }

  // An open page says so once a minute, so an idle dashboard is never ended under it.
  heartbeat(): void {
    if (this.beat) return;
    this.beat = setInterval(() => void this.api.get('/api/ping').catch(() => {}), 60000);
  }

  quit(stopRun: boolean): Promise<unknown> {
    return this.api.post('/api/quit', stopRun ? { stopRun: true } : {});
  }
}
