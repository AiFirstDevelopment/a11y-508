import { describe, expect, it } from 'vitest';
import { countsLine, countsParts, span } from './now';

describe("the one screen's line of numbers", () => {
  it('names only the parts that are not zero, found being every finding the ledger knows', () => {
    expect(countsLine({ open: 5, verified: 1, pending: 4, skipped: 15 })).toBe('25 found · 1 verified fixed · 4 awaiting your deployment · 15 could not be fixed');
    expect(countsLine({ open: 3 })).toBe('3 found');
    // Review items left out, and findings judged fine, are not counted.
    expect(countsLine({ open: 3, ignored: 9, adequate: 2 })).toBe('3 found');
    expect(countsLine({})).toBe('');
    expect(countsLine(null)).toBe('');
    // Once the loop has finished, what is still open or undecided could not be fixed either.
    expect(countsLine({ verified: 5, open: 1, review: 1, skipped: 1 }, true)).toBe('8 found · 5 verified fixed · 3 could not be fixed');
  });
  it('has parts the screen can render one by one, the last being the link to what could not be fixed', () => {
    expect(countsParts({ open: 5, verified: 1, pending: 4, skipped: 15 })).toEqual([
      { key: 'found', n: 25, text: '25 found' },
      { key: 'verified', n: 1, text: '1 verified fixed' },
      { key: 'pending', n: 4, text: '4 awaiting your deployment' },
      { key: 'unfixed', n: 15, text: '15 could not be fixed' },
    ]);
    expect(countsParts({ open: 2 }, true).map((p) => p.key)).toEqual(['found', 'unfixed']);
    // Fixes held while a deployment is awaited: a group of their own, never "awaiting your deployment".
    expect(countsParts({ open: 1, pending: 3, held: 2 })).toEqual([
      { key: 'found', n: 6, text: '6 found' },
      { key: 'pending', n: 3, text: '3 awaiting your deployment' },
      { key: 'held', n: 2, text: '2 ready for the next push' },
    ]);
    expect(countsParts(null)).toEqual([]);
  });
  it('says a time span in minutes once it is one', () => {
    expect(span(45_000)).toBe('45 s');
    expect(span(4 * 60_000 + 20_000)).toBe('4 min');
    expect(span(130 * 60_000)).toBe('2 h 10 min');
  });
});
