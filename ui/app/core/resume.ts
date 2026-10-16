import { Injectable, inject } from '@angular/core';
import { Api } from './api';

// The dashboard resumes where it was (docs/plans/resume.md, simple-screen.md): it always opens on the
// one screen, which shows a live run, or the last one's outcome; an interrupted fix loop is continued
// by the server by itself (docs/plans/turnkey-loop.md).

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
  private beat: ReturnType<typeof setInterval> | null = null;

  // An open page says so once a minute, so an idle dashboard is never ended under it.
  heartbeat(): void {
    if (this.beat) return;
    this.beat = setInterval(() => void this.api.get('/api/ping').catch(() => {}), 60000);
  }

  quit(stopRun: boolean): Promise<unknown> {
    return this.api.post('/api/quit', stopRun ? { stopRun: true } : {});
  }
}
