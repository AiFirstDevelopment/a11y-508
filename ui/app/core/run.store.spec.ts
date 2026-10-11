import { TestBed } from '@angular/core/testing';
import { RunStore } from './run.store';

const page = (n: number, d: number, v = 1) => ({ type: 'page', seq: n, url: `u${n}`, finalUrl: `u${n}`, title: '', status: 200, error: null, skipped: null, violations: v, reviews: 0, byImpact: { critical: v, serious: 0, moderate: 0, minor: 0 }, durationMs: 10, done: n, discovered: d, limit: 5 });

describe('RunStore', () => {
  let store: RunStore;
  beforeEach(() => {
    store = TestBed.inject(RunStore);
    store.apply({ type: 'run', seq: 0, id: 'r', kind: 'crawl' });
  });

  it('builds the page list and progress from page events', () => {
    store.apply(page(1, 3));
    store.apply(page(2, 4, 2));
    expect(store.pages().length).toBe(2);
    expect(store.progress()).toMatchObject({ done: 2, discovered: 4, limit: 5, finished: false });
    expect(store.totals()[1].critical).toBe(3);
  });
  it('keeps warnings and errors as separate notices', () => {
    store.apply({ type: 'warn', seq: 1, message: 'w' });
    store.apply({ type: 'error', seq: 2, message: 'e' });
    expect(store.notices()).toEqual([{ level: 'warn', message: 'w' }, { level: 'error', message: 'e' }]);
  });
  it('reports an event it does not know instead of dropping it', () => {
    store.apply({ type: 'page-done', seq: 1 });
    expect(store.unknown()).toEqual(['page-done']);
  });
  it('treats exit code 1 as findings, not an error', () => {
    store.apply({ type: 'done', seq: 3, code: 1, outcome: 'findings' });
    expect(store.notices()).toEqual([]);
    store.apply({ type: 'run', seq: 0, id: 'r2', kind: 'crawl' });
    store.apply({ type: 'done', seq: 1, code: 2, outcome: 'error' });
    expect(store.notices()[0].level).toBe('error');
  });
  it('starts each loop round with an empty page list and tracks fix n of m', () => {
    store.apply(page(1, 1));
    store.apply({ type: 'round', seq: 2, round: 2 });
    expect(store.pages()).toEqual([]);
    store.apply({ type: 'step', seq: 3, round: 2, step: 'fix', count: 7 });
    store.apply({ type: 'task', seq: 4, round: 2, n: 3, m: 7, state: 'start' });
    expect(store.task()).toEqual({ n: 3, m: 7, state: 'start' });
    store.apply({ type: 'await-deploy', seq: 5, round: 2, committed: 1, nextRound: 3 });
    expect(store.awaitingDeploy()).toBe(true);
  });
});
