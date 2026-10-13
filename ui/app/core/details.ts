// Whether a step's Details disclosure is open, remembered in this browser (a per-viewer
// convenience; storage can be missing or throw).
const key = (step: string) => `a11y508.details.${step}`;
export function detailsOpen(step: string): boolean {
  try {
    return localStorage.getItem(key(step)) === '1';
  } catch {
    return false;
  }
}
export function setDetailsOpen(step: string, open: boolean): void {
  try {
    localStorage.setItem(key(step), open ? '1' : '0');
  } catch {}
}
