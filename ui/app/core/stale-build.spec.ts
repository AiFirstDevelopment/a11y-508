import { NavigationError } from '@angular/router';
import { reloadIfStale } from './stale-build';

const fetchError = new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:5508/chunk-CCSUW9so.js');

function navError(error: unknown, url = '/report'): NavigationError {
  return new NavigationError(1, url, error);
}

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
}

describe('reloadIfStale', () => {
  it('loads the page afresh at the address it was going to when a module of an older build cannot be fetched', () => {
    const gone: string[] = [];
    const storage = new MemoryStorage();
    expect(reloadIfStale(navError(fetchError), (u) => gone.push(u), storage)).toBe(true);
    expect(gone).toEqual(['/report']);
  });

  it('does it once: the same failure after the reload is left to be shown', () => {
    const gone: string[] = [];
    const storage = new MemoryStorage();
    reloadIfStale(navError(fetchError), (u) => gone.push(u), storage);
    expect(reloadIfStale(navError(fetchError, '/fix-loop'), (u) => gone.push(u), storage)).toBe(false);
    expect(gone).toEqual(['/report']);
  });

  it('leaves every other navigation error alone', () => {
    const gone: string[] = [];
    expect(reloadIfStale(navError(new Error('Cannot match any routes')), (u) => gone.push(u), new MemoryStorage())).toBe(false);
    expect(reloadIfStale(navError('something else'), (u) => gone.push(u), new MemoryStorage())).toBe(false);
    expect(gone).toEqual([]);
  });

  it('works without storage (a private window that blocks it)', () => {
    const gone: string[] = [];
    expect(reloadIfStale(navError(fetchError), (u) => gone.push(u), null)).toBe(true);
    expect(gone).toEqual(['/report']);
  });
});
