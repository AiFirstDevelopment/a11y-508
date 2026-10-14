import { Injectable, inject } from '@angular/core';
import { Api } from './api';
import { EnvInfo } from './types';

// The dashboard resumes where it was (docs/plans/resume.md): it opens on the step the person was on
// (stored server-side as lastStep), on a live run, or on an interrupted fix loop; only Start over
// sends it back to Set up.

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
  if (p.startsWith('/review')) return '/review';
  if (p.startsWith('/history')) return '/history';
  return null;
}

// Where the dashboard opens: a live run's step, an interrupted fix loop's Fix step, else the step
// the person was on.
export function landing(e: Pick<EnvInfo, 'run' | 'lastStep'>): string | null {
  const r = e.run;
  if (r && (r.status === 'running' || r.status === 'interrupted') && r.kind !== 'install') return ['loop', 'dry-run'].includes(r.kind) ? '/fix-loop' : '/live';
  return e.lastStep || null;
}

export interface Interrupted {
  at: string;
  round: number | null;
  n: number | null;
  m: number | null;
  kind: string;
  attemptInProgress: boolean;
  discard: string[];
}

export interface StartOverInfo {
  report: boolean;
  ledger: boolean;
  rounds: number;
  attempts: number;
  history: number;
  url: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "13 Oct 2026, 4:52 PM", in the viewer's time zone.
export function when(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const h = d.getHours();
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function interruptedText(i: Interrupted): string {
  const where = i.n && i.m ? ` at fix ${i.n} of ${i.m}` : i.round ? ` in round ${i.round}` : '';
  return `The fix loop was interrupted${where} on ${when(i.at)} (the dashboard was closed).`;
}

// "the report, the ledger with 8 attempts, and the history for this URL"
export function startOverText(s: StartOverInfo): string {
  const parts: string[] = [];
  if (s.report) parts.push('the report');
  if (s.ledger) parts.push(`the ledger with ${s.attempts} attempt${s.attempts === 1 ? '' : 's'}`);
  if (s.history) parts.push('the history for this URL');
  if (!parts.length) return 'nothing yet: there is no report, ledger or history for this URL';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts[parts.length - 1]}`;
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

  interrupted(): Promise<Interrupted | null> {
    return this.api.get<Interrupted | null>('/api/runs/interrupted');
  }

  continueLoop(): Promise<unknown> {
    return this.api.post('/api/runs/resume', {});
  }

  startOverInfo(): Promise<StartOverInfo> {
    return this.api.get<StartOverInfo>('/api/start-over');
  }

  async startOver(): Promise<void> {
    await this.api.post('/api/start-over', { confirm: true });
    this.saved = null;
  }

  quit(stopRun: boolean): Promise<unknown> {
    return this.api.post('/api/quit', stopRun ? { stopRun: true } : {});
  }
}
