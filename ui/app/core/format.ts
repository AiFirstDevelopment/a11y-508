// Pure helpers the screens share; unit-tested in format.spec.ts.

import { ByImpact, IMPACTS } from './types';

export interface Progress {
  done: number;
  discovered: number;
  limit: number | null;
  finished: boolean;
  result: string | null;
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
}

export function foundText(d: Discovery): string {
  const links = `${d.links} link${d.links === 1 ? '' : 's'}`;
  if (d.clicked === null || d.clicked === undefined) return links;
  return `${links} · ${d.clicked} clicked → ${d.clickedNew ?? 0} new`;
}

// The controls discovery left alone: "Delete", "Sign out" and 3 more.
export function skippedText(d: Discovery): string {
  const names = d.skippedActions.map((n) => `"${n}"`).join(', ');
  const more = d.skippedActionsCount - d.skippedActions.length;
  return more > 0 ? `${names} and ${more} more` : names;
}

// The same facts from a page in report.json (info.links, discovery).
export function discoveryOf(p: { info?: { links?: unknown[] } | null; discovery?: { clicked?: number; urls?: unknown[]; skipped?: { name?: string; selector?: string }[]; skippedCount?: number } | null }): Discovery {
  const d = p.discovery || null;
  return {
    links: p.info && Array.isArray(p.info.links) ? p.info.links.length : 0,
    clicked: d ? d.clicked || 0 : null,
    clickedNew: d ? (d.urls || []).length : null,
    skippedActions: d ? (d.skipped || []).map((x) => x.name || x.selector || '').filter(Boolean) : [],
    skippedActionsCount: d ? d.skippedCount || 0 : 0,
  };
}

// An off-origin redirect: the app sent the crawler to a sign-in portal.
export const OFF_ORIGIN = /redirected off-origin to/;

// The runbook's "could not get in" outputs.
export const CANNOT_GET_IN = /redirected off-origin to|FAIL \(no page could be audited\)|the start page could not be audited|HTTP 401|HTTP 403|net::ERR_/;
