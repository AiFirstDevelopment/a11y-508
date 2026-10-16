import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate, timeOf } from '../journal.mjs';

// "What happened": events become dated sentences; repeated checks with the same result are one
// entry with a count, and a committed fix names its files and commit.
test('journal: events narrated, repeated checks folded', () => {
  const at = (s) => `2026-10-15T15:0${s}:00.000Z`;
  const events = [
    { type: 'round', at: at(0), round: 2 },
    { type: 'summary', at: at(1), round: 2, summary: { audited: 2, violations: 5, reviews: 3, coverage: { complete: false } } },
    { type: 'attempt', at: at(2), round: 2, n: 1, m: 2, test: '12.B', message: '2 pages share the title "Home"', files: ['src/app/title-strategy.ts'], outcome: 'committed', commit: 'abc1234' },
    { type: 'attempt', at: at(3), round: 2, n: 2, m: 2, test: '18.A', message: 'text overlaps at 200% zoom', files: [], outcome: 'no-change', note: 'the assistant repeated the same failing step over and over, so its call was ended' },
    { type: 'marker', at: at(4), round: 2, token: 'r2-abc', file: 'src/index.html' },
    { type: 'step', at: at(5), round: 2, step: 'push', committed: 1 },
    { type: 'await-deploy', at: at(6), round: 2, committed: 1, nextRound: 3, branch: 'a11y-508', host: 'cargo-dev.example.gov' },
    { type: 'deploy-check', at: at(7), round: 2, result: 'same', forced: false, host: 'cargo-dev.example.gov', pending: 1, expected: 'r2-abc', marker: 'r1-xyz' },
    { type: 'deploy-check', at: at(8), round: 2, result: 'same', forced: false, host: 'cargo-dev.example.gov', pending: 1, expected: 'r2-abc', marker: 'r1-xyz' },
    { type: 'deploy-check', at: at(9), round: 2, result: 'changed', forced: false, host: 'cargo-dev.example.gov', pending: 1, expected: 'r2-abc', marker: 'r2-abc' },
    { type: 'deployment', at: at(9), state: 'arrived', round: 2, pending: 1 },
    { type: 'done', at: at(9), code: 0, outcome: 'ok' },
  ];
  const got = narrate(events);
  assert.deepEqual(got.map((e) => e.text), [
    'Round 2: re-checking the site',
    'Round 2: crawled 2 pages: 5 violations, 3 to review (coverage incomplete)',
    'Round 2: fixed 12.B 2 pages share the title "Home" in src/app/title-strategy.ts (commit abc1234)',
    'Round 2: the assistant made no change for 18.A text overlaps at 200% zoom (the assistant repeated the same failing step over and over, so its call was ended)',
    'Round 2: build marker r2-abc committed in src/index.html',
    'Round 2: pushed 1 commit',
    'Round 2: waiting for the deployment of a11y-508 to cargo-dev.example.gov',
    'Checked cargo-dev.example.gov: still a build without marker r2-abc (it serves r1-xyz)',
    'Checked cargo-dev.example.gov: the build with marker r2-abc is live',
    'Deployment arrived: verifying 1 fix',
    'The loop finished: nothing left to fix',
  ]);
  const folded = got.find((e) => /still a build without marker/.test(e.text));
  assert.deepEqual([folded.count, folded.until, folded.kind], [2, at(8), 'check']);
  assert.equal(got.find((e) => /made no change/.test(e.text)).kind, 'problem');
  assert.equal(got.find((e) => /fixed 12\.B/.test(e.text)).kind, 'fixed');
  // Where the time went: fixing from the fix step to the push, waiting from the wait to the arrival.
  const tm = timeOf([{ type: 'round', at: at(0), round: 2 }, { type: 'summary', at: at(1), round: 2, summary: {} }, { type: 'step', at: at(2), round: 2, step: 'fix', count: 2 }, ...events.slice(5)]);
  assert.deepEqual([tm.crawling, tm.fixing, tm.waiting, tm.deployments], [60000, 180000, 180000, [180000]]);
});
