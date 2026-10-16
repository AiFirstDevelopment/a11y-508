import { describe, expect, it } from 'vitest';
import { countsLine, span } from './now';

describe("the one screen's line of numbers", () => {
  it('names only the parts that are not zero, found being every finding the ledger knows', () => {
    expect(countsLine({ open: 5, verified: 1, pending: 4, skipped: 15 })).toBe('25 found · 1 verified fixed · 4 awaiting your deployment · 15 could not be fixed');
    expect(countsLine({ open: 3 })).toBe('3 found');
    expect(countsLine({})).toBe('');
    expect(countsLine(null)).toBe('');
  });
  it('says a time span in minutes once it is one', () => {
    expect(span(45_000)).toBe('45 s');
    expect(span(4 * 60_000 + 20_000)).toBe('4 min');
    expect(span(130 * 60_000)).toBe('2 h 10 min');
  });
});
