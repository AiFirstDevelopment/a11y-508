import { describe, expect, it } from 'vitest';
import { every, notHoldingLine, tallyLine, timeLeft } from './where';

describe('time in words', () => {
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
    expect(notHoldingLine(t)).toBe('10 fixes counted as not holding after your deployments, and 1 verified. Either the builds that arrived were made before those pushes (a pipeline that lags the loop), the site\'s builds do not include branch a11y-508, or the fixes did not take. Each such fix is tried again, up to its attempts.');
    expect(notHoldingLine({ ...t, didNotHold: 1 })).toBeNull();
    expect(notHoldingLine({ ...t, didNotHold: 3, verifiedTotal: 3 })).toBeNull();
  });
});
