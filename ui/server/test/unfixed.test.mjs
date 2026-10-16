import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOf, routesOf, whyUnfixed, unfixedFacts, fixesOf } from '../unfixed.mjs';

// The one screen's "could not be fixed" panel: why, in plain words, from the ledger's record.
test('unfixed: why, from the last attempt, the triage, or the ledger reason', () => {
  const a = (outcome, extra = {}) => ({ round: 1, outcome, ...extra });
  assert.equal(whyUnfixed({ status: 'skipped', attempts: [a('no-change', { note: 'fake agent does not handle 7.A' }), a('no-change', { note: 'Updated the title instead.' })] }), 'The assistant made no change (2 tries): Updated the title instead.');
  assert.equal(whyUnfixed({ status: 'open', attempts: [a('no-change', { note: 'agent timed out' })] }), 'The assistant made no change (one try): the assistant ran out of time.');
  assert.equal(whyUnfixed({ status: 'open', attempts: [a('no-change', { note: 'agent exit 1, no result file' })] }), 'The assistant made no change (one try): the assistant ended without saying what it did.');
  assert.equal(whyUnfixed({ status: 'skipped', attempts: [a('failed-gate', { note: 'Added alt text.' }), a('failed-gate', { gateReason: 'the check did not finish within 10 min' })] }), 'The fix broke the build or tests, so it was undone (2 tries; the check did not finish within 10 min).');
  assert.equal(whyUnfixed({ status: 'skipped', reason: 'still present after 3 fix attempts', attempts: [a('still-present', { commit: 'abc' }), a('still-present', { commit: 'def' }), a('still-present', { commit: '123' })] }), 'A fix was committed, but the problem was still there on the next crawl (3 tries).');
  assert.equal(whyUnfixed({ status: 'skipped', attempts: [], triage: { decision: 'unsure', reason: 'cannot see the image' } }), 'The assistant could not decide whether this is a problem: cannot see the image.');
  assert.equal(whyUnfixed({ status: 'review', attempts: [] }), 'A person has to judge this one: the checks cannot tell on their own, and it was not decided this time.');
  assert.equal(whyUnfixed({ status: 'skipped', attempts: [], reason: 'the fix broke the tests' }), 'The fix broke the tests.');
  assert.equal(whyUnfixed({ status: 'open', attempts: [] }), 'The loop ended before it got to this one.');
});

test('unfixed: routes are the pages without their query, once each; the whole site stays "site"', () => {
  assert.equal(routeOf('https://app.example.gov/layout/default?from=1&to=2'), 'https://app.example.gov/layout/default');
  assert.equal(routeOf('site'), 'site');
  assert.equal(routeOf('not a url'), 'not a url');
  const entry = { pages: ['https://app.example.gov/a?x=1', 'https://app.example.gov/a?x=2', 'https://app.example.gov/b#top'], html: '<img src="x.png">', attempts: [] , status: 'open' };
  assert.deepEqual(routesOf(entry), ['https://app.example.gov/a', 'https://app.example.gov/b#top']);
  assert.deepEqual(unfixedFacts(entry), { routes: ['https://app.example.gov/a', 'https://app.example.gov/b#top'], html: '<img src="x.png">', why: 'The loop ended before it got to this one.', fixes: [] });
});

test('unfixed: the commits that fixed a finding, with their files', () => {
  assert.deepEqual(fixesOf({ attempts: [{ round: 1, outcome: 'no-change' }, { round: 2, commit: 'abc1234', files: ['src/a.html'], note: 'Added alt text.' }] }), [{ round: 2, commit: 'abc1234', files: ['src/a.html'], note: 'Added alt text.' }]);
  assert.deepEqual(fixesOf({}), []);
});
