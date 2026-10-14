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

13. The output pane is one log for the whole run, never cleared between calls (capped at the last 2000 lines). Each
    assistant call starts under a heading line ("— Fix 2 of 20: 4.A Element has a click listener … —", "— Review
    items: asking about 10 review items —"); "(no output yet)" appears only before the run's first line.
14. Everything the loop does between assistant calls is in the pane and in the status line with elapsed time: the
    gate ("Checking the fix with npm run build && npm test", its output as it arrives, then "Build and tests passed
    in 1 m 12 s" or "Build or tests failed — the change is reverted and the finding stays open: <last lines>"), the
    commit ("Committed 2 files as a1b2c3d"), the push, the deploy wait. A streaming assistant's closing line reads
    "Gemini CLI is done: 2 files changed — checking the fix next", so it is not read as the loop finishing.
15. The counts move after every commit (a ledger event after each attempt's outcome), worded "1 fixed, awaiting
    verification · 19 remaining · 4 need a person" on the Fix step, in History, and in `a11y-508 status`.
16. The pane's heading and the main status line say the same thing, from one source.

17. Changed files are visible per fix and for the run: the pane says "Changed: <repo-relative paths>" (from the
    working tree, not the assistant's claim), then the gate's outcome, then "Committed as a1b2c3d" or "Reverted —
    the check failed (exit 1): <its last 15 lines>". The Fix step shows **Changes this run** in the main view, one
    row per fix attempt (finding, files, outcome — committed <sha> / reverted: check failed (expandable to the
    check's last lines) / no change / timed out — assistant time, check time); History shows it per round.
18. The ledger records per attempt `agentMs`, `gateMs`, `gateCode`. During the gate the status reads "Checking fix 8
    with npm run build && npm test · 4 m 10 s (the last check took 6 m 02 s)".

19. The check has a time limit: config `checkTimeout` (default 20 min); past it the check's process tree is ended
    (taskkill /T on Windows) and the fix reverted with "the check did not finish within 20 min". When package.json's
    test script runs `ng test` or `karma` in watch mode, the suggested check is `npm run build && npm test --
    --watch=false --browsers=ChromeHeadless`, and the Fix step says why ("ng test watches for changes and never
    exits; the check runs it once").
20. A check of the form `<build> && <test>` is split: the build part runs on every fix, the test part once after the
    round's fixes, before the push. When the round's tests fail (and pass without the round's fixes), the round's
    commits are bisected to find the first fix that breaks them; it is reverted (the later fixes re-applied), its
    attempt marked failed-gate with the test output, and the tests run again — at most 3 reverts, then the round is
    rolled back. Any other check runs whole on every fix. The Fix step says "Each fix is built; the tests run once
    per round".

21. Open findings with the same test id and the same message (its element-specific parts — quoted text, numbers,
    colours — set aside) are one fix task: the prompt lists every element and says "These N findings are the same
    problem on different elements; fix the cause once if there is one, otherwise fix each." The gate and the commit
    run once and every finding in the group gets the attempt (same commit). The status reads "fixing 1 of 6 (8
    elements)", the Changes list shows "(8 elements)". Triage stays per item.

Verification of 13–21 (fix round): the round's tests and the bisect run against the source folders as they were
at a commit (`git restore --source`), never by moving the branch, and a Stop while they run keeps every commit and
blames no fix; only a plain "<build> && <test>" is split (not `cd x && …`, a quoted `&&`, or three commands);
tests that fail or time out with and without the round's fixes leave the fixes kept and say they are untested;
History lists a group's attempt once with its element count and counts its one commit once; the check's whole
process tree is asserted gone after checkTimeout.

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

13. Clear the pane on each new task — the Playwright test asserting the fix-1 lines are still there while fix 2 runs
    fails.
14. Stop emitting the gate events — the loop test asserting gate start/done/output events, and the Playwright test
    asserting "Checking the fix with …" with a counting time and the "Committed … as" line, fail.
15. Drop the ledger event after a commit — the loop test asserting a ledger event with pending ≥ 1 before the next
    fix starts, and the Playwright test asserting the counts had moved when the next fix began, fail.

17. Drop the files from the `changes`/`attempt` events — the Playwright test asserting the fixture's path in the
    pane and in the Changes list fails.
18. Stop recording `gateMs` — the loop test asserting the field and the Playwright test asserting "(the last check
    took" fail.

19. (a) Remove the watch-mode detection — the loop-defaults test with `"test": "ng test"` fails; (b) remove the
    kill — the loop test whose check sleeps past a 2 s checkTimeout fails (it takes the full sleep).
20. (a) Run the tests per fix again — the loop test counting test-script runs fails; (b) skip the bisect — the loop
    test where fix 2 of 3 breaks the tests (expects fixes 1 and 3 committed, fix 2 failed-gate) fails.

21. Group only by object identity (no grouping) — the loop test with four same-test/same-message findings
    (one call, one check, four attempts with one commit) and the Playwright test asserting "(4 elements)" fail.

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
