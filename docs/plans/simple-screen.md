# One screen: the loop runs, says what it is doing, and one link holds the diagnostics

slug: simple-screen
branch: simple-screen

## Intent

Joel, 2026-10-16: "I found myself wanting to ask you to create a user guide for this, but then I
realized no, the problem is it's too complicated that it even needs a user guide. Trim out a whole
lot of stuff so that all it does is iteratively fix things like I originally intended, without all
these things to look at and think about, and it can have a single link that you click on to get
diagnostic information that can be useful to you [Claude, the tool's developer]. This tool is way
way way too complicated to use."

So the dashboard becomes one screen. It runs the loop (crawl, fix, push, wait for the build,
verify, again), says in one sentence what it is doing, shows one line of numbers, and has one
button (Start, or Stop while it runs). Everything else that exists today — the five-step wizard,
Results, History, Where you are, the tally, What happened, Routes crawled, Could not be fixed,
Changes this run, Copy summary, Check now, the assistant picker, the Details disclosures — moves
behind one link, **Diagnostics**, as one page a person can read or copy whole and paste to the
tool's developer. Nothing the loop does underneath changes: the build marker, the turnkey waits
and restarts, the search and discovery passes, the fallback assistant, notifications and the
ledger stay exactly as they are. The CLI is untouched.

## Acceptance criteria

1. **One screen at `/`.** It holds, top to bottom: the app's name and build; the folder and URL
   (as text once set; the Set up form only when nothing is known yet, as today's first-visit
   dialog, with Browse… and Start); one sentence of what is happening now (`data-testid="now"`);
   one line of numbers (`data-testid="counts"`: "25 found · 1 verified fixed · 4 awaiting your
   deployment · 15 could not be fixed", only the parts that are not zero); one button
   (`data-testid="go"`: **Start** when idle or finished, **Stop** while anything runs); when a
   sign-in is needed, the sentence says so and **Show the sign-in tab** is beside the button; and
   one link, **Diagnostics** (`data-testid="diagnostics-link"`, to `/diagnostics`). Nothing else:
   no stepper, no tabs, no Results, History, Fix or Crawl screens, no Where you are, no tally,
   no Details, no Changes this run, no Copy summary, no Check now, no assistant picker, no Run
   again, no Fix the violations. Routes `/run`, `/live`, `/report`, `/fix-loop`, `/history`
   and their sub-routes redirect to `/`.
2. **Start does the whole thing.** One click runs: a crawl (signing in through the dashboard's
   browser tab when the app asks, as today), then the fix loop from that crawl with the first
   installed assistant (Claude Code, Gemini CLI or Codex, in that order of preference; the
   second installed one is the fallback), pushing to the loop's branch, waiting for the build
   with the marker, verifying, and going round again until nothing is open, pending or in
   review. The sentence follows every step; the person never chooses anything. Start on a folder
   with a ledger continues (verifies what is pending, fixes what is open, crawls again) — the same
   thing as today's Start-then-Fix-the-violations, without the second click. A loop that is
   running when the dashboard opens is shown as such (reattached), with Stop.
3. **The sentence** is the only state text, always one of these shapes, in the person's words:
   "Crawling cargo-dev.cbp.dhs.gov: 2 pages so far, 15 findings" · "Sign in in the tab that
   opened; this continues by itself" · "Fixing 12.B duplicate page titles (3 of 7) with Gemini
   CLI, 4 min" · "Checking the fix: npm run build" · "Pushed 3 fixes to a11y-508; waiting for
   your deployment (pushed 11:51 AM, checked 2:31 PM: still the old build)" · "Your deployment
   arrived: verifying 4 fixes" · "Trying again in 58 s: push failed (…)" · "Done: 5 fixed, 2
   could not be fixed" · "Stopped". The dashboard's restarts (an update, an interruption, a stop
   with fixes awaiting) show as their sentence while they happen; none needs a click.
4. **Diagnostics is one page, `/diagnostics`**, everything useful to the tool's developer, in this
   order, each as a plain section with a heading: the build, platform, folder, URL and config
   (secrets stripped); the counts and the tally line with the time per phase; the sentence
   history (What happened, newest first); the rounds table; Routes crawled with Found on it and
   Took, and the last crawl's coverage warnings and notes; the latest report's findings by page
   (test, impact, message, selector, page), review items included; Could not be fixed with
   reasons; the ledger's deploy record (branch, marker awaited, marker served); each round's
   changes with the finding's story and commit; the assistant and fallback detected, with
   versions; the diagnostics diary (the last 50 entries); and the raw output of the current or
   last run. A **Copy diagnostics** button (`data-testid="copy-diagnostics"`) puts the whole
   page as plain text on the clipboard, and **Download diagnostics** saves the same as a
   `.txt` file (no new server endpoint needed beyond what exists: compose on the client from
   the existing `/api/*` routes, adding `/api/diagnostics` only if a single fetch is simpler).
   A **Change folder or URL** link and an **Advanced** link (the assistant choice, crawl and
   loop settings, today's `/run/advanced` and `/fix-loop/settings` fields) live at the bottom of
   Diagnostics and nowhere else.
5. **Notifications** stay as they are (asked on Start). The sign-in tab, the build marker, the
   turnkey restarts and waits, the fallback assistant, the search and discovery passes, the
   journal, routes, timeline and ledger endpoints all stay; only the screens change.
6. **The README's dashboard section** describes the one screen and Diagnostics in under 200 words
   and nothing that no longer exists; `docs/plans/` stays as history.

## How this fails silently

1. **(a) A second button or a step comes back.** Mutation: render Run again beside Start when the
   loop is done. Red: the one-screen spec asserts exactly one `main button:visible` in every
   state it reaches (idle, crawling, fixing, waiting, done), apart from Show the sign-in tab, and
   `getByRole('navigation', { name: 'Steps' })` has count 0.
2. **(b) Start stops after the crawl.** Mutation: Start runs the crawl only. Red: after Start on the
   fixture app, the `now` sentence never reaches "Fixing …" and the ledger has no round.
3. **(c) The sentence lies or goes blank.** Mutation: the fixing sentence omits "(3 of 7)" / the
   waiting sentence omits the last check. Red: the spec's regexes on `now` for each state.
4. **(d) Old routes still render.** Mutation: `/history` renders History. Red: `page.goto('/history')`
   ends at `/` with the one screen.
5. **(e) Diagnostics is missing a section.** Mutation: Routes crawled left out of the page. Red: the
   Diagnostics spec asserts every heading from AC 4 in order, and that Copy diagnostics put text
   on the clipboard containing the rounds table's first row and the first finding.
6. **(f) A second click is needed to continue.** Mutation: Start on a folder with a ledger only
   crawls and ends at "Done". Red: with pending fixes and a fixture build that then serves the
   marker, one Start reaches "Your deployment arrived: verifying".

## Non-goals

- No change to `src/` (the crawler, the loop, the CLI) or to `ui/server/` beyond what the one
  screen needs (an `/api/diagnostics` composite is allowed; nothing removed server-side).
- No change to the loop's behaviour, the ledger, the build marker, the fallback, the search or
  discovery passes, notifications.
- No user guide: the screen is the guide.

## Tests

Delete the e2e specs that only test removed screens (wizard, start, fix-click, next-step, carry,
run-simple, reports, history parts of loop.spec, fix-loop-simple, folder-picker parts that assume
the wizard) and replace them with `ui/e2e/one-screen.spec.ts` (AC 1–3, 6; guards a–d, f) and
`ui/e2e/diagnostics.spec.ts` (AC 4; guard e); keep and adapt the specs whose subject survives
(turnkey waits and restarts, deploy-wait, resume, sign-in, own-browser, search-crawl, notify,
security, startup, freshness, self-audit). Every kept spec must pass through the one screen. Unit
and server tests stay as they are unless a removed screen's helper goes with it. The core suites
(`npm test` at the root) must stay green untouched.
