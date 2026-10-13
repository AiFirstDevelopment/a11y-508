# The fix loop recovers from its own set-up errors and never dead-ends

slug: loop-resilience
branch: main

A fix loop on the CBP laptop stopped before doing anything with
`cannot switch to branch a11y-508: fatal: cannot lock ref 'refs/heads/a11y-508': 'refs/heads/a11y-508/fixes' exists`.
An earlier run (when the default branch was `a11y-508/fixes`) had created that branch; git refs are files, so a
branch `a11y-508/fixes` makes `a11y-508` a directory and plain `a11y-508` can never be created in that repository.
The loop treated it as fatal, exited 2, and the Fix step then showed "Loop finished. 0 fixed · 0 remaining",
"Finished: 0 of 0 pages found", the errors folded under Details, and only "Run again" (a new crawl) as a way out.

The loop must get itself onto a usable branch without stopping, and when it really cannot continue, the Fix step
must say so in plain words with the remedy and a **Try again** that continues from where it stopped (from the
report or the ledger — never a new crawl). Nothing that merely needs a different branch name, a retry, or a
one-line remedy may end the loop.

## Acceptance criteria

1. With a branch `<branch>/<anything>` already in the repository (for example `a11y-508/fixes`) and the loop's
   branch `a11y-508`, the loop continues on the existing nested branch — the most recently committed one when
   there are several — and logs one info line saying which branch it is on and why. The round's fixes are
   committed there. No error, exit code as for a normal round.
2. The reverse: with branch `a11y-508` existing and the loop's branch `a11y-508/fixes`, the loop continues on
   `a11y-508` with the same kind of info line.
3. The Fix step shows the branch the loop will actually use (the "commits to branch" line and `GET
   /api/loop/defaults`'s `effective.branch`): when the suggested `a11y-508` cannot be created because a
   `a11y-508/*` branch exists, the suggestion is that nested branch; the dashboard and the loop agree.
4. Every set-up error that still ends the loop before its first round (not a git repository; uncommitted changes
   under the source folders; a branch that cannot be created or switched to for any other reason) is emitted as
   one event `{ type: 'precondition', code, message, remedy }` (`code` in `not-a-repo | dirty-tree | branch`),
   with `remedy` a sentence a person can act on (for the dirty tree, the file list and "commit or stash them";
   for a branch, the git command that resolves it). The CLI prints message and remedy; the exit code stays 2.
5. On the Fix step, a loop that ended before its first round shows the heading **"The fix loop could not
   start"** with the message and the remedy in the main view (not under Details) and a primary **Try again**
   button. It never shows "Loop finished", "0 fixed · 0 remaining", or a crawl progress line such as
   "Finished: 0 of 0 pages found".
6. A loop that ended after its first round for any other reason (crawl failed, no page audited, push failed,
   deploy failed, assistant failed to start) shows **"The fix loop stopped"**, the reason, the real ledger counts,
   and the same **Try again** button; "Run again" (a new crawl) stays as the secondary action.
7. **Try again** starts a new loop run from the same latest report (`--from-report`, as "Fix the violations"
   does), so no page is re-crawled, and the loop continues from its ledger: findings already fixed are not
   fixed again. While it runs the screen is the normal running view.
8. Everything above holds on Windows (Git Bash in CI, `path.win32`-safe) — the branch logic uses `git
   for-each-ref`/`show-ref`, never the `.git/refs` directory.

9. A round that starts from the report (no crawl) shows nothing about a crawl: no "Starting the browser", no crawl
   progress, no Pages table under Details. The crawl view appears only once a round re-checks the site, with its
   round label.
10. The triage status line reads "Round 1: asking Gemini CLI about 10 review items from the report you just saw ·
    59 s" (the assistant's display name; "the assistant" for a custom command), never "call N of M"; with more
    than one batch it adds "· batch 2 of 3". Under it while triaging: "Review items are findings the checker could
    not decide by itself; the assistant says which are real violations."
11. While an assistant call runs the screen shows it is being waited on: (a) after `quietAfter` (default 30 s) with
    no output, "Waiting on Gemini CLI — no output for 1 m 10 s; it may take a few minutes. The call is given up
    after 15 min."; (b) a quota retry is an `agent-wait` event and the status reads "Gemini CLI is rate-limited;
    trying again in 28 s (retry 1 of 2)", counting down (`quotaDelays` in the config); (c) a call given up is said
    in plain words ("Gemini CLI did not answer within 15 min; the 10 review items stay in review and the loop goes
    on"), from an `agent-result` event.
12. The Gemini and Claude presets stream (`--output-format stream-json`, Claude also `--verbose`); the loop turns
    each streamed event into one readable line for the pane ("Reading src/app.html", "Searching for \"x\" in src",
    "Editing …", "Running npm run build", the assistant's words, "Done: 2 files changed"), never raw JSON; other
    lines pass as they are. The result file stays the source of truth; quota detection also reads the decoded words.

Added in the build after verification: AC 1 also holds when the earlier run's branch exists only on origin (a fresh
clone): the loop checks it out tracking origin. AC 6's "assistant failed to start" ends with an error event
("… did not run: all N calls this round ended without an answer …"), so the Fix step says "The fix loop stopped".

## How this fails silently

1. The nested-branch fallback picks a branch but does not switch to it; commits land on the previous branch.
   Mutation: remove the `checkout` of the chosen branch — the test asserting `rev-parse --abbrev-ref HEAD` after
   the loop equals `a11y-508/fixes` must fail.
2. The fallback picks the oldest nested branch instead of the most recently committed one. Mutation: invert
   the sort — the test with two nested branches must fail.
3. `loop-defaults` suggests `a11y-508` although it cannot be created. Mutation: drop the nested-branch check in
   `loop-defaults.mjs` — the server test must fail.
4. The precondition is logged as a plain error and no `precondition` event is emitted. Mutation: replace the
   event with `log.error` — the CLI `--events` test asserting the event's `code` and `remedy` must fail.
5. The Fix step still says "Loop finished" after a precondition failure. Mutation: remove the precondition
   branch in the template — the Playwright test asserting the "could not start" heading and the absence of
   "Loop finished" / "fixed ·" / "pages found" text must fail.
6. Try again starts a crawl instead of a loop from the report. Mutation: make Try again call `runAgain()` —
   the Playwright test asserting that the run started has `kind: 'loop'` with the report's `finishedAt` and that
   no `crawl` run was created must fail.
7. Try again starts a loop with an empty ledger, so already-fixed findings are fixed again. Mutation: delete the
   ledger before the retried run — the loop test asserting the retried round's fix count must fail.

8. Render the crawl view unconditionally again — the Playwright test asserting that, during triage of a
   from-report round, "Starting the browser" and the Pages table are absent must fail.
9. Put "call" back or drop the batch condition — the Playwright test asserting the exact single-batch triage status
   and the hint must fail.
10. Remove the silence hint — the Playwright test with a silent fake assistant and a 1 s `quietAfter` must fail.
11. Drop the `agent-wait` event — the Playwright test with a fake assistant that answers 429 once must not see the
    countdown.
12. (a) Remove `--output-format stream-json` from the Gemini preset — the preset test fails; (b) relay raw JSON —
    the decoder unit test on recorded Gemini and Claude JSONL fails; (c) buffer stdout until exit — the Playwright
    test asserting the first action line while the call runs fails.

## Non-goals

- Auto-committing or auto-stashing the user's own uncommitted changes.
- Changing what the loop does once a round is under way (fix, gate, commit, push, deploy).
- Any change to the crawler or the checks.

## Notes for the builder

- Branch logic lives in `src/loop.mjs` around the `cfg.branch` block (`git checkout` / `checkout -b`);
  `ui/server/loop-defaults.mjs` suggests the branch; the Fix step is `ui/app/screens/fix-loop.ts`
  (`loopEnded()`, `fixCounts()`, the actions block, `fix()`/`startLoop()`); run exits are turned into `done`
  events in `ui/server/runs.mjs` and read in `ui/app/core/run.store.ts`. Loop tests: `test/loop.mjs` (the `g`
  helper, fixture repo under tmpdir); server tests `ui/server/test`; Playwright `ui/e2e` with its harness.
- Test helpers may delete only directories they created themselves under the OS temp dir; never the repository
  root, never a path a caller passed in. Never run a test with the repository root as its working directory.
- Run every suite locally (`node test/run.mjs`, `node test/loop.mjs`, the server `node:test` suites, Playwright);
  do not wait on CI. Push to `main` directly, early (as soon as the branch fallback and its test are green), then
  the rest. Rebuild `ui/dist` and `build-info.json` before pushing any UI change.
