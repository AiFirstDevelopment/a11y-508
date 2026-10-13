# The Run screen for the common case

Written 2026-10-13. For apps behind a single sign-on portal: one assumed way in,
the browser sign-in with the saved session.

## What the Run screen shows

1. **Start URL**, prefilled from the last URL started or typed in this browser (localStorage `a11y508.startUrl`).
2. **Sign-in state** (`role="status"`): *Not signed in* with **Sign in**. Sign in starts one run of kind `crawl` with auth mode `signin` (`--login --stay --state a11y-508-state.json`) and goes to Live: Live shows "A Chrome window is open: sign in there and stay on the app page. This continues by itself once the app has loaded." until `session-saved`, then the pages as the crawl runs in that same window (one tab). No Start click. Back on Run: *Signed in · session saved just now* (or *N min ago* for a session on disk, with **Sign in again**, which does the same); a failed or cancelled sign-in shows its error and **Try again**. Focus moves to the status when a sign-in ends while Run is open.
3. **Start**, disabled with the hint *Sign in first* until a session exists or a way in is chosen under More options. With a session and no explicit choice, runs use `--state a11y-508-state.json`.
4. **More options…** (`<details>`, closed): the token / TOKEN-from-shell / saved session / cookies / no sign-in choices (the only way to run without a session), the include/exclude/max pages/fail-on fields, **Advanced**, and the equivalent command line with Copy.

The nav no longer links to `/sign-in`; the route still renders and still runs the
older `login` kind (`--login-only`). The Live screen's "could not get into the app"
notice adds **Sign in** when the crawl was redirected off-origin; it starts a
`signin` crawl and Live follows it.

## The CLI: `--login --stay`

After the interactive sign-in the visible browser is kept (its sign-in tab too, so the
window stays), the session file is saved as before, and the crawl runs in that browser
with `--concurrency 1`. Headed launches add `--disable-backgrounding-occluded-windows`
and `--disable-renderer-backgrounding`. `report.json` records `options.stay: true` only
when the crawl really ran in the sign-in browser. `--stay` without `--login`, or with
`--login-only`, exits 2.

## Discovery per page

The `page` event gains `links`, `clicked`, `clickedNew` (null when click discovery did
not run), `skippedActions` and `skippedActionsCount`. The Live and Report page tables
have a **Found** column (`8 links · 3 clicked → 2 new`) and name the controls not
clicked because they look like actions.

## Tests: ui/e2e/run-simple.spec.ts

| Mutation | Red assertion |
|---|---|
| M1: `<details class="more" … open>` (hide-by-default removed) | (a) `more-options` `toHaveJSProperty('open', false)`: received `true` |
| M2: unchosen auth mode ignores the saved session (`'none'`) | (b) `run-command` `toContainText('--state a11y-508-state.json')`; (c) the same, on the command without `--state` |
| M3: Live notice's **Sign in** button removed | (d) `notice.getByRole('button', { name: 'Sign in' }).click()` times out |
| M4: `localStorage.setItem(URL_KEY, …)` removed | (e) new page in the same context: `Start URL` `toHaveValue('http://127.0.0.1:9/remembered')`, received `""` |
| M5: Found column reads links only | crawl.spec "discovery": `found` expected `8 links · 3 clicked → 2 new`, received `8 links` |
| M6: `--stay` closes the sign-in browser and crawls headless | sign-in.spec `--login --stay`: `report.options.stay` expected `true`, received `undefined` |
| M7: the sign-in warning filter removed | run-simple (b): warn notice with "A browser window is open" expected count 0, received 1 |
| M8: npm's placeholder `test` treated as a real one | server loop-defaults test 2 (and 1): `package.test` expected `null` |
| M9: the loop ignores the saved session (`sessionArgs` returns `[]`) | test/loop.mjs: the sessionArgs unit check and "each round crawls with --state and says so once" fail |
| M10: the dashboard drops `agent-output` events | loop.spec AC 14: `agent-output` expected to contain "fake agent: reading the prompt", received "(no output yet)" |

Changed existing specs (no assertion removed): `harness.ts` gains `moreOptions()`,
and `fillRun` opens More options before token/max pages/fail-on/advanced fields;
agents, loop, reports, folder-picker, crawl and run-control open it before using
the auth radios or the command box; `sign-in.spec.ts` drives the inline **Sign in**
(plus a check that `/sign-in` still renders and is not in the nav);
folder-picker AC 1 opens `/sign-in` by address; `self-audit.spec.ts` audits
`/sign-in` with a second one-page crawl, since nothing links to it now.

## The Fix loop, minimal

`GET /api/loop/defaults` infers the repository facts and suggested settings (config wins).
The screen: "Fixing with …" (*change* opens the picker), the sign-in state, one line of
what will happen, **Fix the violations** (writes the inferred config if none), the run's
progress, the live assistant output pane (`agent-output` events, `role="log"`, Follow,
running timer), the ledger, and **More options…** (every setting, saved on change; a dry
run as *Record findings without fixing*). Deploy settings are not on the screen; the
inferred config watches the bundles (`bundle-change`, 30 min), and **Deployed — continue**
works in that mode too (the loop listens on stdin while it polls).

Changed loop specs (assertions kept unless noted): AC 11 used the deploy fields, which no
longer exist; its rejection case now uses the core's "no start URL" message and the
written config gains the inferred `branch`, `deployed` and `deployTimeout`, plus a check
that no deploy field is on screen. AC 12 / AC 14 / gemini run: set up a package.json (and
for AC 12 a session file covering the start URL), open the picker with *change*, and no
longer set "Rounds to run". Dry runs go through More options.

## One Start, no sign-in concept on screen

Start on the Run screen always runs the sign-in crawl (`--login --stay`) in a fresh browser
(each run launches its own browser with a new temporary profile; none survives a run), unless
a way in (saved session, token, shell token, cookies, none) was chosen under More options….
The session file is saved on the way, for the fix loop. **Fix the violations** passes
`signIn` to the server, which adds the loop's new `--sign-in-first`: round 1 crawls via
`--login --stay`, the later rounds headless with `--state`; a way in chosen on Run skips it.
The Sign in route's login-only run still chooses the saved session for the next Start.

Spec changes: run-simple (a) asserts no sign-in wording/buttons and Start present; (b) Start
launches the `--login --stay` crawl (status line, pages, `options.stay`, session file saved);
(c) a saved session at launch is offered under More options (age shown, unchecked), Start
still signs in afresh, and choosing it runs headless with `--state` and no `--login`; (d)
ends the Live notice's sign-in with Stop (the Run screen's Cancel/Try again/focus state no
longer exists). fix-loop-simple: no sign-in button; a token chosen means no
`--sign-in-first`; a new case asserts `--sign-in-first` with no way in chosen.

## Report routes, History timeline, settings off-screen

- Report: the audited routes, each once, worst first (most critical, then serious …), with
  Site-wide last; the selected route's findings below in compact rows (badge, test, message,
  Details), violations first, most serious first; filters apply within the route. AC 5 now
  selects the forms page in the route list where it used the Page filter, and checks the
  filters against that page's findings; a new test checks each page listed once and that the
  second route shows its own findings and not the first's.
- History: one timeline of crawls and fix rounds (found, fixed, remaining, commits, from the
  ledger via `GET /api/loop/timeline`), a summary line and a remaining-per-round chart, and
  **Clear fix-loop history** (`DELETE /api/loop/history`: rounds and ledger, never during a
  run). loop.spec AC 14 checks the last round's row against `a11y-508 status`.
- Run and Fix loop show no settings: they are at `/run/advanced` and `/fix-loop/settings`,
  which nothing links to; the harness's `moreOptions()`/`loopOptions()` navigate there in-app.
- CLI: Stop while the sign-in window is open now closes that browser (it was left running).

## The wizard, uncluttered steps, and a clean repository

- Stepper (`<nav aria-label="Steps">`, an ordered list): Set up (/run) → Crawl (/live) →
  Results (/report) → Fix (/fix-loop) → History; done steps marked, the current one
  `aria-current="step"`, unavailable ones `aria-disabled` (Results, Fix and History while a crawl
  runs; Fix outside a repository). A crawl watched to its end moves to Results by itself (a viewer
  can keep the Crawl step with `a11y508.stayOnCrawl`, which the specs' returning-viewer `open()`
  sets). Results ends with **Fix the violations** (→ /fix-loop?start=1); Fix, once the loop
  ends, with **See what changed** and **Run again**; History with **Run again**.
- Set up: folder (paste or Browse…, which opens the header picker) + URL + Start, on /run and, on
  a first visit with no remembered directory, as a modal dialog (Escape does nothing while a field
  is empty). The browser remembers the directory (`a11y508.cwd`); a directory that already holds
  the tool's files is taken as remembered.
- Each step shows counts; a Details disclosure (remembered per step) holds the full view.
  `open()` in the harness opens every Details (the full views the specs check); the wizard spec
  checks the default views with `details: false`.
- The dashboard's own files live in `~/.a11y-508/<12 hex>/` (`A11Y_508_HOME` in tests): config,
  session, settings (remembered URL, assistant, rounds per run). A repository's own config is
  used read-only; outputs are added to `.git/info/exclude`; old dashboard files are moved after a
  confirmation.

Spec changes for this (assertions kept unless noted): the nav helper maps the old tab names to
the steps and opens unavailable ones by address; `waitFinished` comes back to the Crawl step if
the wizard moved on; session and config paths in assertions are the state directory's (and the
working directory is checked to hold neither); the self-audit also crawls /fix-loop on its own
(the Fix step is not offered outside a repository); AC 12 seeds the session and config through
the dashboard; loop AC 14 also checks See what changed / Run again and that Run again returns
the wizard to Crawl with Results, Fix and History unavailable.

## The dashboard's own browser, and --connect

`ui/server/main.mjs` launches Chrome (persistent profile `~/.a11y-508/browser-profile`,
`--remote-debugging-port=0`, read from `DevToolsActivePort`) on the dashboard's address; the
server ends with that browser, and Ctrl+C closes it. The CLI's `--connect <port|ws://…>` attaches
over a plain-Node WebSocket client (`src/ws.mjs`, tested by `test/ws.mjs`): tabs in the existing
window (`newWindow: false`), `--concurrency 1`, the sign-in tab handed over to the crawl
(`--login` implies `--stay`), its tabs closed at the end and the dashboard's tab
(`A11Y_508_RETURN_URL`) brought back. The server passes `--connect <port> --login --state …` for
the wizard's crawls and the loop's first round. e2e: `connect.spec.ts` (a Chrome launched with
`--remote-debugging-port=0`: a tab appeared, ≥3 pages audited, its tabs closed, the browser still
open) and `own-browser.spec.ts` (the server without `--no-open`: dashboard and crawl tab in one
window). `start.spec.ts` sets `A11Y_508_OWN_BROWSER=0` to keep testing the system browser path.
