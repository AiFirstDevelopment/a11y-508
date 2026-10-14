import { NavigationError } from '@angular/router';

// A page built before the last update asks for files the server no longer has (their names carry
// a hash of their content), and the router reports "Failed to fetch dynamically imported module".
// The page then loads itself afresh at the address it was going to, once: a second failure for
// the same file is shown as it is, so a real outage does not become an endless reload.
export const STALE_BUILD = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|error loading dynamically imported module/i;
const KEY = 'a11y508.reloaded-for';

export function reloadIfStale(e: NavigationError, assign: (url: string) => void = (url) => location.assign(url), storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): boolean {
  const message = String((e.error && e.error.message) ?? e.error ?? '');
  if (!STALE_BUILD.test(message)) return false;
  let last = '';
  try {
    last = storage?.getItem(KEY) || '';
  } catch {}
  if (last === message) return false;
  try {
    storage?.setItem(KEY, message);
  } catch {}
  assign(e.url || location.pathname);
  return true;
}

function safeStorage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}
