// The one screen's words (docs/plans/simple-screen.md): the line of numbers, and the small helpers
// the sentence is made of. Shared with Diagnostics.

// "25 found · 1 verified fixed · 4 awaiting your deployment · 15 could not be fixed": the ledger's
// counts, only the parts that are not zero. found: every finding the ledger knows.
export function countsLine(c: Record<string, number | undefined> | null | undefined): string {
  if (!c) return '';
  const found = Object.values(c).reduce<number>((a, n) => a + (n || 0), 0);
  const parts: [number, string][] = [
    [found, 'found'],
    [c['verified'] || 0, 'verified fixed'],
    [c['pending'] || 0, 'awaiting your deployment'],
    [c['skipped'] || 0, 'could not be fixed'],
  ];
  return parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(' · ');
}

// "45 s", "4 min", "2 h 10 min".
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// "11:51 AM", in the viewer's time zone.
export function clockOf(iso: unknown): string {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// The host of a URL, or the URL itself.
export function hostOf(url: string | null | undefined): string {
  try {
    return new URL(String(url || '')).host || String(url || '');
  } catch {
    return String(url || '') || 'the site';
  }
}

export const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
export const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
