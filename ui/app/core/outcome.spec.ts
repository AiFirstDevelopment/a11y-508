import { describe, expect, it } from 'vitest';
import { plainReason, signInFailed } from './outcome';

const RAW = 'crawl failed: the crawl produced no report (exit 2):\nwarn A browser window is open on https://app.example.gov/\nerror login failed: gave up after 10 minutes waiting for sign-in to finish';

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
});
