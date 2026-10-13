import { Injectable, inject } from '@angular/core';
import { Api } from './api';
import { DecisionStatus, PersonDecision, ReviewList } from './types';

// The words for each decision, on the buttons and in the line a decided card shows.
export const DECISION_WORDS: Record<DecisionStatus, string> = {
  adequate: 'Looks fine',
  'wont-fix': "Won't fix",
  open: 'Ask the assistant to fix it',
};

// "13 Oct 2026, 4:52 PM", in the viewer's own clock.
export function decidedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(d);
  const part = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${part('day')} ${part('month')} ${part('year')}, ${time}`;
}

export function decisionLine(d: PersonDecision): string {
  return `Decided by you on ${decidedAt(d.at)} — ${DECISION_WORDS[d.status] || d.status}`;
}

// A page's route as Results shows it: the path, with the query string hidden.
export function routeOf(url: string): { path: string; query: string } {
  try {
    const u = new URL(url);
    return { path: u.pathname || '/', query: u.search + u.hash };
  } catch {
    return { path: url, query: '' };
  }
}

@Injectable({ providedIn: 'root' })
export class ReviewService {
  private api = inject(Api);

  list(): Promise<ReviewList> {
    return this.api.get<ReviewList>('/api/review');
  }

  decide(fingerprint: string, status: DecisionStatus, note: string): Promise<{ fingerprint: string; status: string; decision: PersonDecision }> {
    return this.api.post('/api/ledger/decision', { fingerprint, status, note });
  }
}
