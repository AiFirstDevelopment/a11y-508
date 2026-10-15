import { describe, expect, it } from 'vitest';
import { every, notHoldingLine, tallyLine, timeLeft, whereYouAre, WhereLive } from './where';
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
    const lines = whereYouAre({ report: null, timeline, counts, live: live({ waiting: { branch: 'a11y-508', intervalMs: 30_000, until: null } }), now });
    expect(lines.map((l) => l.kind)).toEqual(['done', 'done', 'now', 'next']);
    expect(lines[0].text).toMatch(/^Crawled 33 pages on .+ — 34 findings$/);
    expect(lines[1].text).toBe('Round 1: 11 fixes committed on branch a11y-508 and pushed to origin');
    expect(lines[2].text).toBe('Now: waiting for your deployment of a11y-508 (checks every 30 s)');
    expect(lines[3].text).toBe('Next: fix the 6 remaining while your deployment is awaited, then verify the 11 fixes against the new build');
    expect(lines.map((l) => l.text).join(' ')).not.toMatch(/person/);
    // A wait with a limit (a repository's own config) still counts down.
    expect(whereYouAre({ report: null, timeline, counts, live: live({ waiting: { branch: 'a11y-508', intervalMs: 30_000, until: now + 12 * 60_000 } }), now })[2].text).toBe('Now: waiting for your deployment of a11y-508 (checks every 30 s, 12 min left)');
  });
  // docs/plans/turnkey-loop.md AC 8 / guard l: what the tool does, never what the person may choose.
  it('turnkey AC8 / guard l: the Next line says what the tool does next, never a choice', () => {
    const now = Date.parse('2026-10-13T20:50:00.000Z');
    const meanwhile = whereYouAre({ report: null, timeline, counts: { pending: 4, open: 3 }, live: live({ step: 'fix', task: { n: 1, m: 3 }, waiting: { branch: 'a11y-508', intervalMs: 30_000, until: null, meanwhile: 3 } }), now });
    expect(meanwhile.find((l) => l.kind === 'now')!.text).toBe('Now: fixing the 3 remaining while your deployment of a11y-508 is awaited');
    expect(meanwhile.find((l) => l.kind === 'next')!.text).toBe('Next: fix the 3 remaining while your deployment is awaited, then verify the 4 fixes against the new build');
    const waiting = whereYouAre({ report: null, timeline, counts: { pending: 4 }, live: live({ waiting: { branch: 'a11y-508', intervalMs: 30_000, until: null } }), now });
    expect(waiting.find((l) => l.kind === 'next')!.text).toBe('Next: verify the 4 fixes as soon as the new build is live');
    const retrying = whereYouAre({ report: null, timeline, counts: { pending: 4 }, live: live({ active: false, outcome: 'error', reason: 'push failed: no remote', retrying: { kind: 'error', attempt: 2 } }), now });
    expect(retrying.find((l) => l.kind === 'now')!.text).toBe('Now: stopped: push failed; trying again by itself');
    const blocked = whereYouAre({ report: null, timeline, counts: { open: 4 }, live: live({ active: false, outcome: 'error', retrying: { kind: 'precondition', attempt: 2 } }), now });
    expect(blocked.find((l) => l.kind === 'now')!.text).toBe('Now: the fix loop could not start yet; it starts by itself once that is done');
    for (const l of [...meanwhile, ...waiting, ...retrying, ...blocked]) expect(l.text).not.toMatch(/verify now|without waiting|Keep waiting|Try again|Continue|Start over|sign in, and/i);
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

describe('the tally', () => {
  const t = { rounds: 12, startedAt: '2026-10-15T11:30:00.000Z', lastAt: '2026-10-15T14:00:00.000Z', found: 15, verified: 1, pending: 4, open: 2, skipped: 8, adequate: 0, gone: 0, review: 0, commits: 20, calls: 31, agentMs: 31 * 220_000, didNotHold: 10, verifiedTotal: 1, branch: 'a11y-508' };
  it('says the whole run in one line, timed to now while the loop runs', () => {
    expect(tallyLine(t, Date.parse('2026-10-15T14:11:00.000Z'), true)).toBe('12 rounds in 2 h 41 min · 15 found · 1 verified fixed · 4 awaiting verification · 2 open · 8 could not be fixed · 31 assistant calls, 4 min each on average · 10 fixes did not hold after a deployment');
    expect(tallyLine(t, Date.parse('2026-10-15T14:11:00.000Z'), false)).toMatch(/^12 rounds in 2 h 30 min · /);
  });
  it('names the branch the builds seem to leave out when fixes keep not holding, and keeps quiet otherwise', () => {
    expect(notHoldingLine(t)).toBe('10 fixes counted as not holding after your deployments, and 1 verified: the builds the site serves do not seem to include branch a11y-508. Merge it into the branch your pipeline builds; until then the fixes are tried again against builds without them.');
    expect(notHoldingLine({ ...t, didNotHold: 1 })).toBeNull();
    expect(notHoldingLine({ ...t, didNotHold: 3, verifiedTotal: 3 })).toBeNull();
  });
});
