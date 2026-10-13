import { cumulative, progressLabel, resultLine, ageText, savedAgo, phaseText, routeParts, localTime, foundText, discoveryOf, CANNOT_GET_IN } from './format';

const s = (o: any) => ({ audited: 3, byImpact: { critical: 0, serious: 0, moderate: 1, minor: 0 }, ...o });

describe('format', () => {
  it('labels the progress bar', () => {
    expect(progressLabel({ done: 0, discovered: 0, limit: null, finished: false, result: null })).toBe('Starting the browser');
    expect(progressLabel({ done: 12, discovered: 40, limit: 200, finished: false, result: null })).toBe('12 of 40 pages found (limit 200)');
    expect(progressLabel({ done: 40, discovered: 40, limit: 200, finished: true, result: 'fail' })).toBe('Finished: 40 of 40 pages found (limit 200), FAIL');
  });
  it('never reads a plain PASS when coverage is incomplete', () => {
    expect(resultLine({ passed: true, summary: s({ coverage: { complete: false } }) })).toBe('PASS on 3 pages, but coverage is incomplete');
    expect(resultLine({ passed: true, summary: s({ coverage: { complete: true } }) })).toBe('PASS');
    expect(resultLine({ passed: false, summary: s({ audited: 0 }) })).toBe('FAIL (no page could be audited)');
    expect(resultLine({ passed: false, summary: s({ byImpact: { critical: 2, serious: 1, moderate: 0, minor: 0 } }), options: { failOn: ['critical', 'serious'] } })).toBe('FAIL (2 critical, 1 serious violations)');
  });
  it('accumulates impacts page by page', () => {
    const z = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    expect(cumulative([{ byImpact: { ...z, critical: 1 } }, { byImpact: { ...z, critical: 2, minor: 1 } }])).toEqual([{ ...z, critical: 1 }, { ...z, critical: 3, minor: 1 }]);
  });
  it('recognises the runbook\'s "could not get in" outputs', () => {
    for (const t of ['redirected off-origin to https://sso', 'FAIL (no page could be audited)', 'HTTP 401', 'net::ERR_CONNECTION_REFUSED']) expect(CANNOT_GET_IN.test(t)).toBe(true);
    expect(CANNOT_GET_IN.test('HTTP 404')).toBe(false);
  });
  it('describes a session age', () => {
    expect(ageText(30_000)).toBe('just now');
    expect(ageText(5 * 60_000)).toBe('5 minutes old');
  });
  it('says what discovery did on a page', () => {
    expect(foundText({ links: 12, clicked: 8, clickedNew: 3, skippedActions: [], skippedActionsCount: 0 })).toBe('12 links · 8 clicked → 3 new');
    expect(foundText({ links: 1, clicked: null, clickedNew: null, skippedActions: [], skippedActionsCount: 0 })).toBe('1 link');
    expect(foundText({ links: 2, clicked: 5, clickedNew: 3, skippedActions: [], skippedActionsCount: 0, searched: 1, searchResults: 8 })).toBe('2 links · 5 clicked → 3 new · 1 search → 8 results');
    expect(discoveryOf({ info: { links: ['a', 'b'] }, discovery: { clicked: 4, urls: ['x'], skipped: [{ name: 'Delete' }], skippedCount: 1 } })).toEqual({ links: 2, clicked: 4, clickedNew: 1, skippedActions: ['Delete'], skippedActionsCount: 1 });
    expect(discoveryOf({}).clicked).toBeNull();
  });
  it('shows timestamps in local time, never as ISO', () => {
    const iso = '2026-10-13T11:10:00.000Z';
    expect(localTime(iso)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)));
    expect(localTime(iso)).not.toMatch(/T\d\d:\d\d.*Z/);
    expect(localTime('')).toBe('');
    expect(localTime('not a date')).toBe('not a date');
  });
  it('names the phase a page is in', () => {
    expect(phaseText({ url: 'http://x/a', phase: 'checks', detail: { elements: 1240 }, elapsedMs: 0 })).toBe('Checking 1,240 elements');
    expect(phaseText({ url: 'http://x/a', phase: 'keyboard', detail: { stops: 38, of: 120 }, elapsedMs: 0 })).toBe('Keyboard pass: 38 of 120 tab stops');
    expect(phaseText({ url: 'http://x/a', phase: 'loading', detail: null, elapsedMs: 0 })).toBe('Loading http://x/a');
  });
  it('splits a route from its query', () => {
    expect(routeParts('http://x/a/b?from=1&to=2')).toEqual({ path: '/a/b', query: '?from=1&to=2' });
    expect(routeParts('http://x/#/layout')).toEqual({ path: '/#/layout', query: '' });
  });
  it('says when a session was saved', () => {
    expect(savedAgo(30_000)).toBe('just now');
    expect(savedAgo(5 * 60_000)).toBe('5 min ago');
    expect(savedAgo(60 * 60_000)).toBe('1 hour ago');
    expect(savedAgo(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });
});
