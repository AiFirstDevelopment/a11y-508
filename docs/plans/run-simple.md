# The Run screen for the common case

Written 2026-10-13. For apps behind a single sign-on portal: one assumed way in,
the browser sign-in with the saved session.

## What the Run screen shows

1. **Start URL**, prefilled from the last URL started or typed in this browser (localStorage `a11y508.startUrl`).
2. **Sign-in state** (`role="status"`): *Not signed in* with **Sign in**; while the `login` run (`--login-only`) is open, "A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded."; then *Signed in · session saved just now* (or *N min ago* for a session on disk, with **Sign in again**); a failed or cancelled sign-in shows its error and **Try again**. Focus moves to the status when a sign-in ends.
3. **Start**, disabled with the hint *Sign in first* until a session exists or a way in is chosen under More options. With a session and no explicit choice, runs use `--state a11y-508-state.json`.
4. **More options…** (`<details>`, closed): the token / TOKEN-from-shell / saved session / cookies / no sign-in choices (the only way to run without a session), the include/exclude/max pages/fail-on fields, **Advanced**, and the equivalent command line with Copy.

The nav no longer links to `/sign-in`; the route still renders. The Live screen's
"could not get into the app" notice adds **Sign in** when the crawl was redirected
off-origin; it starts the sign-in and returns to Run.

## Tests: ui/e2e/run-simple.spec.ts

| Mutation | Red assertion |
|---|---|
| M1: `<details class="more" … open>` (hide-by-default removed) | (a) `more-options` `toHaveJSProperty('open', false)`: received `true` |
| M2: unchosen auth mode ignores the saved session (`'none'`) | (b) `run-command` `toContainText('--state a11y-508-state.json')`; (c) the same, on the command without `--state` |
| M3: Live notice's **Sign in** button removed | (d) `notice.getByRole('button', { name: 'Sign in' }).click()` times out |
| M4: `localStorage.setItem(URL_KEY, …)` removed | (e) new page in the same context: `Start URL` `toHaveValue('http://127.0.0.1:9/remembered')`, received `""` |

Changed existing specs (no assertion removed): `harness.ts` gains `moreOptions()`,
and `fillRun` opens More options before token/max pages/fail-on/advanced fields;
agents, loop, reports, folder-picker, crawl and run-control open it before using
the auth radios or the command box; `sign-in.spec.ts` drives the inline **Sign in**
(plus a check that `/sign-in` still renders and is not in the nav);
folder-picker AC 1 opens `/sign-in` by address; `self-audit.spec.ts` audits
`/sign-in` with a second one-page crawl, since nothing links to it now.
