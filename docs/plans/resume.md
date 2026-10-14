# The dashboard resumes where it was; only an explicit Start over resets it

slug: resume
branch: main

On the CBP laptop the user left for 45 minutes; when they came back the dashboard's browser window was gone, the
fix loop with it, and launching the dashboard again started the wizard from Set up. Today `ui/server/main.mjs`
ends the dashboard when its own browser window closes ("Closing that browser ends the dashboard", line ~130),
the loop is a child of the server, and nothing about the run survives the server. A fix loop runs for an hour or
more; it must not depend on a browser window or a terminal staying open, and reopening the dashboard must land
on the step the person was on, with the run still going or ready to continue. Going back to the beginning is a
deliberate act with a confirmation, never a side effect.

## Acceptance criteria

1. Closing the dashboard's browser window does not end the server or any run. The server ends on Ctrl+C in its
   terminal, on a **Quit** action in the dashboard (under the header, with a confirmation when a run is active),
   or when idle for 24 hours with no run and no open browser. Launching `npm run ui` (or the `ui` command) when
   a dashboard is already serving that port just opens the browser to it instead of failing or starting a second
   one, and says so in the terminal.
2. A run (crawl, loop, sign-in) is checkpointed on disk as it goes: its events stream is appended to
   `<work folder>/runs/<id>.events.ndjson` (the same NDJSON the dashboard receives), with a `run.json` holding
   kind, args, pid, startedAt, cwd, url. The run process is started detached from the server (own process
   group; on Windows `detached: true` with `windowsHide`), so a server restart does not kill it.
3. On start, the server looks for the newest `run.json` for the current folder: if its pid is alive it
   **reattaches** — the dashboard shows the live run, its full pane log, counts and status, exactly as if the
   window had never closed — and tails the events file for the rest; Stop still works (process-tree kill).
   If the pid is dead and the events file has no `done`, the run is **interrupted**.
4. The dashboard opens on the step the person was on. The wizard step, the folder and the URL are stored
   server-side (`settings.json`: `lastStep`); on load the app goes straight there: Fix with the live run, or
   Results/Fix/History with the last report and ledger. Set up is shown only when nothing is known yet, when the
   remembered folder is gone, or after **Start over**.
5. An interrupted loop is explained and continuable: the Fix step shows "The fix loop was interrupted at fix 8
   of 20 on 13 Oct 2026, 4:52 PM (the dashboard was closed)" with **Continue** and **Start over**. Continue
   starts the loop from the latest report with the existing ledger (no crawl); the attempt that was in progress
   is marked `interrupted`, and the uncommitted changes under the source folders that belong to it (the ledger
   has an attempt with no outcome) are listed on screen and reverted by Continue, with the file list in the pane
   ("Discarded the unfinished change to src/app/…"). Uncommitted changes when no attempt was in progress are the
   person's own and stay a precondition error with its remedy, as today.
6. **Start over** (on Set up and on the interrupted notice) asks for confirmation naming what it discards
   ("the report, the ledger with 8 attempts, and the history for this URL"), then clears the work folder's
   ledger and the stored step so the wizard starts at Set up. Nothing else resets it: not a reload, not a
   relaunch, not changing the folder (the folder-carry behaviour stays).
7. Everything above works on Windows (detached process with Git Bash CI; `path.win32`-safe; no POSIX-only
   signals — use the existing process-tree kill).
8. A click on **Fix the violations** always leads, within the same page, to the running view (status line +
   Stop) or to a visible notice saying why it did not start; the button is never shown enabled while a start is
   in flight or while a loop is active. If the click arrives before the screen is ready (assistants still being
   detected, repo match pending), the start waits for readiness and proceeds, with "Starting…" shown meanwhile.
9. After a reload or a crash restore, the Fix step shows the live run when one is active, and otherwise the
   outcome of the last run for this folder (from the run journal) exactly as it looked before the reload — "The
   fix loop could not start…" with its remedy and Try again, "The fix loop stopped…", or "Loop finished" with
   See what changed — until a new run starts. `start=1` never auto-starts a second run when one is live or when
   the last run's outcome is shown.

   Seen on a Windows laptop: on /fix-loop?start=1 (from Results) one click on Fix the violations, then Chrome
   crashed and restored the tab, which showed the button again with no status, no notice and no run. Causes in
   the code: the restored tab's `start=1` re-ran the auto-start, which either silently did nothing (it required
   `canStart()` at that instant, false while assistants are detected or the repository is read) or started a
   second run beside the last one's outcome (`store.active()` cannot see a run before the page has replayed it);
   a click before the screen was ready was swallowed (`fix()` returned when `!canStart()`, the button disabled
   without a word); from the click to the run's first event the button stayed enabled with nothing on screen;
   and after a relaunch the server forgot a finished fix loop (only a live or interrupted one was reattached), so
   its outcome was gone.

## How this fails silently

1. The browser's exit still shuts the server down. Mutation: restore the `proc.on('exit', shutdown)` — the
   server test that starts the dashboard with a fake "own browser" process, kills that process and asserts the
   server still answers `/api/env` must fail.
2. The run is not detached and dies with the server. Mutation: drop `detached` — the test starting a long fake
   loop, killing the server process, and asserting the run pid is still alive and the events file keeps growing
   must fail.
3. Reattach shows a run without its earlier events. Mutation: start tailing at the end of the file — the test
   restarting the server mid-run and asserting the first pane lines are present must fail.
4. The dashboard opens on Set up although a step is stored. Mutation: ignore `lastStep` — the Playwright test
   reloading after a crawl and asserting it lands on Results must fail.
5. An interrupted run is shown as "Loop finished"/"stopped" without Continue. Mutation: treat a missing `done`
   as `done` — the test with a run.json whose pid is dead and no `done` event asserting the "interrupted" text
   and the Continue button must fail.
6. Continue reverts files that are not the attempt's. Mutation: revert everything dirty — the test with one
   dirty file from the in-progress attempt and one the "person" edited outside the source folders asserting
   only the first is reverted must fail.
7. Start over resets without confirmation, or something else resets. Mutation: skip the confirm — the test
   asserting the dialog text must fail; mutation: clear the ledger on reload — the test asserting the ledger
   survives a reload must fail.
8. A click is lost when the screen is not ready. Mutation: swallow the click when not ready (`fix()` returns
   while detection or the repository read is pending) — the e2e that clicks during pending detection and expects
   "Starting…" and then the running view must fail.
9. A reload loses the last run's outcome, or repeats the start. Mutation: make `/api/env` omit finished runs —
   the e2e that starts a loop that fails at a precondition, reloads, and expects the "could not start" notice
   must fail; mutation: re-enable auto-start on restore — the e2e that reloads with start=1 after a finished run
   and expects no new run must fail.

## Non-goals

- Surviving a machine restart with the run still running (a dead run becomes "interrupted", which is enough).
- Running the dashboard as a service.
- Changing what the loop does within a round.

## Notes for the builder

- Server: `ui/server/main.mjs` (own browser, shutdown), `ui/server/runs.mjs` (spawning runs, events, `done`),
  `ui/server/state-dir.mjs` (settings), `ui/server/app.mjs` (routes). App: `ui/app/core/run.store.ts`,
  `ui/app/core/starter.ts`, the wizard routing, `ui/app/screens/fix-loop.ts`, `ui/app/screens/setup-form.ts`.
  Loop: `src/loop.mjs` (ledger attempts; `WORK_DIR`).
- Test helpers may delete only directories they created under the OS temp dir; never the repository root, never
  a path a caller passed in. Never run a test with the repository root as its working directory. Never start a
  test server with the repository root as its folder.
- All suites local; push to `main` directly, early (criteria 1–3 first); rebuild `ui/dist` and `build-info.json`
  from committed source before pushing a UI change.
