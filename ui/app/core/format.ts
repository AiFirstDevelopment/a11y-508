// Pure helpers the screens share; unit-tested in format.spec.ts.

import { ByImpact, IMPACTS } from './types';

export interface Progress {
  done: number;
  discovered: number;
  limit: number | null;
  finished: boolean;
  result: string | null;
}

// The same analysis: two start URLs with the same origin and path (query and trailing slash aside).
export function sameStartUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  try {
    const x = new URL(String(a));
    const y = new URL(String(b));
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

export function progressLabel(p: Progress): string {
  if (!p.done && !p.finished) return 'Starting the browser';
  const limit = p.limit ? ` (limit ${p.limit})` : '';
  if (p.finished) return `Finished: ${p.done} of ${p.discovered} pages found${limit}${p.result ? `, ${resultWord(p.result)}` : ''}`;
  return `${p.done} of ${p.discovered} pages found${limit}`;
}

export function resultWord(result: string): string {
  return { pass: 'PASS', fail: 'FAIL', incomplete: 'PASS, coverage incomplete', 'nothing-audited': 'FAIL, nothing audited' }[result] || result;
}

// The one-line result: a pass with coverage warnings never reads as a plain PASS.
export function resultLine(r: { passed: boolean; summary: { audited: number; byImpact: ByImpact; coverage?: { complete: boolean } }; options?: { failOn: string[] } }): string {
  const s = r.summary;
  if (!s.audited) return 'FAIL (no page could be audited)';
  if (!r.passed) {
    const failOn = r.options?.failOn || ['critical', 'serious'];
    const parts = failOn.filter((i) => (s.byImpact as any)[i]).map((i) => `${(s.byImpact as any)[i]} ${i}`);
    return `FAIL (${parts.join(', ')} violations)`;
  }
  if (s.coverage && !s.coverage.complete) return `PASS on ${s.audited} pages, but coverage is incomplete`;
  return 'PASS';
}

export function emptyImpacts(): ByImpact {
  return { critical: 0, serious: 0, moderate: 0, minor: 0 };
}

// Running totals by impact after each page, for the live stacked chart.
export function cumulative(pages: { byImpact: ByImpact }[]): ByImpact[] {
  const acc = emptyImpacts();
  return pages.map((p) => {
    for (const i of IMPACTS) acc[i] += p.byImpact[i] || 0;
    return { ...acc };
  });
}

export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash || '/';
  } catch {
    return u;
  }
}

export function ageText(ms: number | undefined): string {
  if (ms === undefined) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} old`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} old`;
  return `${Math.round(h / 24)} days old`;
}

// A timestamp in the viewer's own locale and time zone: "Oct 13, 2026, 7:10 AM".
// The data stays ISO (UTC); the screens show this, with the ISO string in <time datetime>.
export const LOCAL_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
export function localTime(iso: string | number | Date | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : new Intl.DateTimeFormat(undefined, LOCAL_TIME).format(d);
}

// "session saved 5 min ago": the Run screen's sign-in state.
export function savedAgo(ms: number | undefined): string {
  if (ms === undefined) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

// What discovery did on a page, for the Found column: "12 links · 8 clicked → 3 new",
// or "12 links" when click discovery did not run there.
export interface Discovery {
  links: number;
  clicked: number | null;
  clickedNew: number | null;
  skippedActions: string[];
  skippedActionsCount: number;
  // Search-form discovery: forms submitted, and the result pages they led to (absent when none ran).
  searched?: number | null;
  searchResults?: number | null;
}

export function foundText(d: Discovery): string {
  const links = `${d.links} link${d.links === 1 ? '' : 's'}`;
  const clicks = d.clicked === null || d.clicked === undefined ? '' : ` · ${d.clicked} clicked → ${d.clickedNew ?? 0} new`;
  const search = d.searched ? ` · ${d.searched} search${d.searched === 1 ? '' : 'es'} → ${d.searchResults ?? 0} result${d.searchResults === 1 ? '' : 's'}` : '';
  return links + clicks + search;
}

// The controls discovery left alone: "Delete", "Sign out" and 3 more.
export function skippedText(d: Discovery): string {
  const names = d.skippedActions.map((n) => `"${n}"`).join(', ');
  const more = d.skippedActionsCount - d.skippedActions.length;
  return more > 0 ? `${names} and ${more} more` : names;
}

// The same facts from a page in report.json (info.links, discovery).
export function discoveryOf(p: { info?: { links?: unknown[] } | null; discovery?: { clicked?: number; urls?: unknown[]; skipped?: { name?: string; selector?: string }[]; skippedCount?: number; forms?: { submitted: number; results: number } } | null }): Discovery {
  const d = p.discovery || null;
  return {
    links: p.info && Array.isArray(p.info.links) ? p.info.links.length : 0,
    clicked: d && d.clicked !== undefined ? d.clicked || 0 : null,
    clickedNew: d && d.clicked !== undefined ? (d.urls || []).length : null,
    ...(d && d.forms ? { searched: d.forms.submitted, searchResults: d.forms.results } : {}),
    skippedActions: d ? (d.skipped || []).map((x) => x.name || x.selector || '').filter(Boolean) : [],
    skippedActionsCount: d ? d.skippedCount || 0 : 0,
  };
}

// A page's route for display: the path, and the query (shown collapsed as "?…").
export function routeParts(u: string): { path: string; query: string } {
  try {
    const x = new URL(u);
    return { path: (x.pathname || '/') + (x.hash && !x.search ? x.hash : ''), query: x.search + (x.search ? x.hash : '') };
  } catch {
    return { path: u, query: '' };
  }
}

// What a page in flight is doing (a progress event), for the Live screen.
export interface PhaseEvent {
  url: string;
  phase: string;
  detail: Record<string, number> | null;
  elapsedMs: number;
}

const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US');
export function phaseText(e: PhaseEvent): string {
  const d = e.detail || {};
  switch (e.phase) {
    case 'loading': return `Loading ${e.url}`;
    case 'checks': return `Checking ${n(d['elements'])} elements`;
    case 'keyboard': return `Keyboard pass: ${n(d['stops'])} of ${n(d['of'])} tab stops`;
    case 'disclosures': return `Opening disclosures: ${n(d['done'])} of ${n(d['of'])}`;
    case 'frames': return `Frames: ${n(d['done'])} of ${n(d['of'])}`;
    case 'zoom': return 'Checking at 200% zoom';
    case 'names': return 'Confirming names with the accessibility tree';
    case 'screenshots': return `Screenshots: ${n(d['done'])} of ${n(d['of'])}`;
    case 'discovery': return `Looking for pages behind controls: ${n(d['clicked'])} of ${n(d['of'])}`;
    case 'search': return `Searching the last ${n(d['months'])} month${d['months'] === 1 ? '' : 's'} · ${n(d['forms'])} form${d['forms'] === 1 ? '' : 's'}`;
    default: return e.phase;
  }
}

// The Status cell of a page the server answered 404 for and the app rendered anyway.
export const SOFT_404_TITLE = "The server answers 404 for this route, which the app rendered anyway, so it was audited. Refreshing the browser on it shows the same; serve the app with a 200 for unknown routes (a deployment setting) to fix it.";

// An off-origin redirect: the app sent the crawler to a sign-in portal.
export const OFF_ORIGIN = /redirected off-origin to/;

// The runbook's "could not get in" outputs.
export const CANNOT_GET_IN = /redirected off-origin to|FAIL \(no page could be audited\)|the start page could not be audited|HTTP 401|HTTP 403|net::ERR_/;

// A duration as a person says it: "45 s", "1 m 10 s"; whole minutes as "15 min" when asked.
export function spoken(ms: number, minutes = false): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  if (minutes && total % 60 === 0) return `${total / 60} min`;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return sec ? `${m} m ${sec} s` : `${m} min`;
}

// The fix loop's counts in the words the Fix step and History share: "3 verified fixed · 1 fixed,
// awaiting verification · 19 remaining · 4 need a person" (a part that is 0 is left out; "0 fixed"
// when nothing is fixed yet).
export function fixedLine(c: Record<string, number | undefined>): string {
  const v = c['verified'] || 0;
  const p = c['pending'] || 0;
  const nh = c['needs-human'] || 0;
  const parts: string[] = [];
  if (v) parts.push(`${v} verified fixed`);
  if (p) parts.push(`${p} fixed, awaiting verification`);
  if (!v && !p) parts.push('0 fixed');
  parts.push(`${c['open'] || 0} remaining`);
  if (nh) parts.push(`${nh} need${nh === 1 ? 's' : ''} a person`);
  return parts.join(' · ');
}
