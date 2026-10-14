import { describe, expect, it } from 'vitest';
import { every, timeLeft, whereYouAre, WhereLive } from './where';
import type { LoopTimeline } from './types';

const timeline: LoopTimeline = {
  rounds: [{ round: 1, at: '2026-10-13T20:21:00.000Z', found: 30, reviews: 4, pages: 33, audited: 33, fixed: 11, covered: 11, commits: 9, remaining: 6, source: 'report', branch: 'a11y-508', pushed: true, remote: 'origin', state: 'awaiting-deploy' }],
  deploy: { round: 1, branch: 'a11y-508', remote: 'origin', pushed: true, host: 'cargo-dev.example.gov', since: '2026-10-13T20:40:00.000Z' },
  total: { rounds: 1, fixed: 0, pending: 11, of: 17, remaining: 6 },
};
const counts = { pending: 11, open: 6, skipped: 7 };
const live = (over: Partial<WhereLive>): WhereLive => ({ kind: 'loop', active: true, outcome: null, round: 1, step: null, crawled: null, task: null, waiting: null, deployment: null, verifying: null, loginWaiting: false, reason: null, ...over });

describe('where you are', () => {
  it('lists the crawl and the round from the ledger, then Now and Next, and nothing about a person', () => {
    const now = Date.parse('2026-10-13T20:50:00.000Z');
    const lines = whereYouAre({ report: null, timeline, counts, live: live({ waiting: { branch: 'a11y-508', intervalMs: 30_000, until: now + 12 * 60_000 } }), now });
    expect(lines.map((l) => l.kind)).toEqual(['done', 'done', 'now', 'next']);
    expect(lines[0].text).toMatch(/^Crawled 33 pages on .+ — 34 findings$/);
    expect(lines[1].text).toBe('Round 1: 11 fixes committed on branch a11y-508 and pushed to origin');
    expect(lines[2].text).toBe('Now: waiting for your deployment of a11y-508 (checks every 30 s, 12 min left)');
    expect(lines[3].text).toBe('Next: verify the 11 fixes against the new build, then fix the 6 remaining');
    expect(lines.map((l) => l.text).join(' ')).not.toMatch(/person/);
  });
  it('says what the live run is doing, and how it ended', () => {
    const base = { report: null, timeline, counts, now: 0 };
    expect(whereYouAre({ ...base, live: live({ round: 2, step: 'crawl', crawled: { done: 14, discovered: 33 } }) })[2].text).toBe('Now: round 2: re-checking the site (14 of 33 pages)');
    expect(whereYouAre({ ...base, live: live({ round: 2, step: 'fix', task: { n: 3, m: 6 } }) })[2].text).toBe('Now: round 2: fixing 3 of 6');
    expect(whereYouAre({ ...base, live: live({ active: false, outcome: 'awaiting-deploy', deployment: 'still-old' }) })[2].text).toBe('Now: your deployment has not arrived yet — the site still serves the old build');
    expect(whereYouAre({ ...base, live: live({ active: false, outcome: 'awaiting-deploy', deployment: 'unreachable' }) })[2].text).toBe("Now: could not check the site's build");
    expect(whereYouAre({ ...base, live: live({ active: false, outcome: 'findings' }) })[2].text).toBe('Now: finished');
  });
  it('counts down in words', () => {
    expect(timeLeft(12 * 60_000)).toBe('12 min left');
    expect(timeLeft(4 * 60_000 + 5_000)).toBe('4 min 05 s left');
    expect(timeLeft(35_000)).toBe('35 s left');
    expect(every(30_000)).toBe('every 30 s');
    expect(every(120_000)).toBe('every 2 min');
  });
});
