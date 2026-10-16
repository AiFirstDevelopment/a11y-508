import type { Tally } from './types';

// The loop's numbers in words: the tally line (Diagnostics), and the time helpers it uses.


// "12 min left", "4 min 05 s left", "35 s left".
export function timeLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 600) return `${Math.round(s / 60)} min left`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s left`;
  return `${s} s left`;
}

// "3:28 PM", in the viewer's time zone.
export function clock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "every 30 s", "every 2 min".
export function every(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 || s % 60 ? `every ${s} s` : `every ${s / 60} min`;
}

// A span in the words a person uses: "2 h 41 min", "41 min", "50 s".
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// The whole run so far in one line. live: the loop is running, so the time runs to now.
export function tallyLine(t: Tally, now: number, live: boolean): string {
  const start = t.startedAt ? Date.parse(t.startedAt) : NaN;
  const end = live ? now : t.lastAt ? Date.parse(t.lastAt) : NaN;
  const time = Number.isFinite(start) && Number.isFinite(end) && end > start ? ` in ${span(end - start)}` : '';
  const parts = [`${t.rounds} round${t.rounds === 1 ? '' : 's'}${time}`, `${t.found} found`, `${t.verified} verified fixed`];
  if (t.pending) parts.push(`${t.pending} awaiting verification`);
  if (t.open) parts.push(`${t.open} open`);
  if (t.skipped) parts.push(`${t.skipped} could not be fixed`);
  if (t.adequate) parts.push(`${t.adequate} judged fine`);
  if (t.calls) parts.push(`${t.calls} assistant call${t.calls === 1 ? '' : 's'}, ${span(t.agentMs / t.calls)} each on average`);
  if (t.didNotHold) parts.push(`${t.didNotHold} fix${t.didNotHold === 1 ? '' : 'es'} did not hold after a deployment`);
  return parts.join(' · ');
}

// When fixes keep failing to hold after deployments and almost none verify: the builds that arrived
// were made before those pushes (a pipeline that lags the loop), the site's builds leave the loop's
// branch out, or the fixes did not take. Said once, in those words, with what the loop does about it.
export function notHoldingLine(t: Tally): string | null {
  if (t.didNotHold < 2 || t.didNotHold <= t.verifiedTotal) return null;
  const b = t.branch || "the loop's branch";
  return `${t.didNotHold} fixes counted as not holding after your deployments, and ${t.verifiedTotal} verified. Either the builds that arrived were made before those pushes (a pipeline that lags the loop), the site's builds do not include branch ${b}, or the fixes did not take. Each such fix is tried again, up to its attempts.`;
}
