import { describe, expect, it } from 'vitest';
import { plainReason, signInFailed, SIGN_IN_HEADLINE } from './outcome';
import { whereYouAre, WhereLive } from './where';

const RAW = 'crawl failed: the crawl produced no report (exit 2):\nwarn A browser window is open on https://app.example.gov/\nerror login failed: gave up after 10 minutes waiting for sign-in to finish';
const live = (over: Partial<WhereLive>): WhereLive => ({ kind: 'loop', active: false, outcome: 'error', round: 1, step: 'crawl', crawled: null, task: null, waiting: null, deployment: null, verifying: null, loginWaiting: false, reason: null, ...over });

describe('how a run ended, in plain words', () => {
  it('knows a sign-in that timed out', () => {
    expect(signInFailed([RAW])).toBe(true);
    expect(signInFailed(['push failed: no remote', null])).toBe(false);
  });
  it('says the first clause as a sentence', () => {
    expect(plainReason(RAW)).toBe('The site could not be checked: the crawl produced no report.');
    expect(plainReason('push failed: fatal: no configured push destination')).toBe('Push failed.');
    expect(plainReason('no page could be audited this round; the loop cannot continue.')).toBe('No page could be audited this round.');
    expect(plainReason('The run failed: browser went away (exit code 2).')).toBe('Browser went away.');
    expect(plainReason('')).toBe('Something went wrong.');
  });
  it('Where you are says it plainly, and the next line is what the tool does, never a request to the person', () => {
    const lines = whereYouAre({ report: null, timeline: null, counts: { open: 5 }, live: live({ reason: RAW }), now: 0 });
    expect(lines.find((l) => l.kind === 'now')!.text).toBe(`Now: ${SIGN_IN_HEADLINE.charAt(0).toLowerCase()}${SIGN_IN_HEADLINE.slice(1, -1)}`);
    expect(lines.find((l) => l.kind === 'next')!.text).toBe('Next: fix the 5 remaining');
    const push = whereYouAre({ report: null, timeline: null, counts: {}, live: live({ reason: 'push failed: no remote' }), now: 0 });
    expect(push.find((l) => l.kind === 'now')!.text).toBe('Now: stopped: push failed');
  });
});
