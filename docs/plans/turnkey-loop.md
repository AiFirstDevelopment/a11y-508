# Turnkey loop: the tool decides, the developer never does

slug: turnkey-loop
branch: turnkey-loop

## Intent

Joel, 2026-10-15: "too many options for the developer to understand and learn; make this
turnkey and not require the developer to interpret state or make retry decisions... the tool
should simply run a loop of iterations that proceed without requiring devs to interpret state
of what has happened; if a restart is required from some stage, it should just inform the dev
that it is doing it and why."

Today the dashboard puts about forty choices in front of a person: Continue, Start over, Try
again, Sign in and continue, The site is updated — verify now, Fix the remaining without
waiting, Stop waiting, Keep waiting, Verify anyway, Start anyway, Deployed — continue, Crawl
again, Clear history, Clear fix-loop history, Delete, Troubleshoot with these settings... Each
one is a state the person has to understand first. After this change the loop keeps going by
itself through every one of those situations and says, in one sentence, what it is doing and
why. The only acts left to a person are the ones only a person can do: sign in when the app
asks, deploy the branch, and press Stop. Neither is a decision about the tool.

The rule for every state (running, waiting, ended, failed, interrupted): one plain sentence of
what is happening, at most one button besides Stop, and nothing that asks the person to pick a
recovery path. When the tool restarts something it says so and why ("The fix loop was
interrupted at fix 8 of 20 (the dashboard was closed); continuing from there.").

A survey of every choice point, with file:line and the spec that asserts it, is in this plan's
appendix; the builder works from it.

## Acceptance criteria

1. **One forward action per state, never a choice.** The Fix step shows at most one button
   besides **Stop**: **Fix the violations** when idle, after a Stop ("Stopped. 3 fixes are
   committed.") and after an ended loop that left work — it continues the loop from the ledger
   and the latest report exactly as a start does today; **Run again** (a new crawl) only when
   the loop ended with nothing left to fix. These no longer exist anywhere in `ui/app`: Continue
   (`loop-continue`, `loop-continue-next`), Run again to verify, Start over (`app-start-over`,
   both places), Try again, Sign in and continue (Fix and Live), The site is updated — verify
   now (`verify-now`), Fix the remaining N without waiting, Stop waiting, Keep waiting
   (`keep-waiting`), Verify anyway, Start anyway (`start-anyway`), Deployed — continue, the
   `deploy-not-arrived` notice, the interrupted notice's buttons, Live's Sign in and
   Troubleshoot with these settings, and Set up's Continue / Crawl again (Start is the one
   button; the wizard already lands on the last step). Every ended state shows one sentence of
   what happened and what the tool does next. The loop match check ("wrong repository") becomes
   one line of information above the step, never a gate.

2. **Waiting for a deployment never ends in a question.** `deployTimeout: 0` means no limit;
   `ui/server/loop-defaults.mjs` suggests 0, the CLI default stays 30 minutes. While committed
   fixes await the build, the loop first fixes whatever is still open from the ledger (a round
   with `source: 'ledger'`, no crawl — what "Fix the remaining without waiting" did), then polls
   the start page every `deployPoll` until its bundles change, then crawls to verify. A loop
   started while fixes await a build that is still the old one waits the same way instead of
   ending: exit 4, `still-old`, `stopped-waiting` and `unreachable` never happen from the
   dashboard (`--verify-anyway` stays a CLI flag; the CLI with a positive `deployTimeout` keeps
   exit 4 and its printed commands). The Fix step reads "Waiting for your deployment of branch
   a11y-508 (pushed to origin at 3:28 PM). The site is checked every 30 s, and the 4 fixes are
   verified as soon as the new build is live." followed by "Nothing else is left to fix." or
   "Fixing the 3 remaining findings meanwhile." Stop stays; no other button.

3. **Sign-in is a request, not a decision.** Whenever a round needs a sign-in (the first crawl,
   an expired session before a build check or a verify), the loop opens the sign-in tab (or
   window) and waits without giving up: from the dashboard (`--events`) `interactiveLogin`'s
   `maxWait` is unlimited, `login-waiting` events keep coming, and a tab the person closed is
   opened again (said once: "The sign-in tab was closed; opened it again."). The step says "Sign
   in in the tab that opened; the loop continues by itself once you have." with **Show the
   sign-in tab**. A round whose crawl could not get into the app (no page audited, or every page
   redirected to the sign-in portal) signs in that way and crawls again, once per round, the step
   saying "Your sign-in expired: sign in in the tab that opened, and the crawl runs again." A
   crawl started from Set up does the same on the Crawl step; the "could not get into the app"
   notice and its buttons go. The CLI keeps its 10-minute limit.

4. **An interrupted run continues by itself.** When the server finds a fix loop whose process is
   gone without finishing (`reattach()` in `ui/server/app.mjs`: at startup, on a folder switch,
   and whenever the Fix step loads), it continues it at once, as Continue did: the unfinished
   attempt is marked `interrupted`, its uncommitted changes under the source folders are
   reverted, and the same request runs again with `--resume`. The Fix step says "The fix loop was
   interrupted at fix 8 of 20 on 13 Oct 2026, 4:52 PM (the dashboard was closed); continuing from
   there. The unfinished change to src/app/x.ts was discarded." (the last sentence only when
   something was). An interrupted crawl runs again from its own request, the Crawl step saying
   "The crawl was interrupted (the dashboard was closed); running it again." A dry run is only
   marked resolved. Never while another run is active, and never twice for one interruption.

5. **A run that could not start, or stopped with an error, tries again by itself.** The server
   schedules the same request again and records it on the run (`retry: { attempt, at, reason }`,
   on GET /api/runs/current and in the run's record, so a reload and a server restart keep it):
   after a precondition failure (`precondition` event: not a repository, uncommitted changes, a
   branch git refuses) every 15 seconds until it starts, the step showing the message, the
   remedy, and "The loop starts by itself once that is done."; after any other error (crawl
   failed, push failed, deploy command failed, no page audited, the assistant did not run) after
   1, 2 and 5 minutes, then every 10 minutes, the step showing "<what happened, in plain words>.
   Trying again in 58 s (attempt 2)." with the countdown live. **Stop** during the countdown
   cancels the schedule ("Stopped."). For tests, `A11Y_508_RETRY_DELAYS=2,2` (seconds) and
   `A11Y_508_PRECONDITION_POLL=2` shorten the waits; document them in a code comment only.

6. **No round limit, and "done" says what was done.** From the dashboard the loop has no round
   cap (`--max-rounds 0` = unlimited; the CLI default stays 20). It ends only when nothing is
   open, pending or in review — "Done: nothing left to fix." with **Run again** — or when a
   round committed nothing and nothing is pending — "Done: 5 fixed. 2 findings could not be fixed
   by the assistant; the people who use the app will find them." with **Run again**. "reached
   --max-rounds" and "Done: N fixed, M left" never show.

7. **Set up and History ask nothing.** Set up: **Start** only (no Continue, no Crawl again, no
   Start over; `/run` loses its "To begin again from nothing" line). History: Clear history, Clear
   fix-loop history and each row's Delete are gone; **Run again** stays. The server's DELETE and
   start-over endpoints stay as they are (nothing in the UI calls them).

8. **"Where you are" and the README describe what the tool does, never what the person may
   choose.** The Next line reads, for example, "Next: fix the 3 remaining while your deployment
   is awaited, then verify the 4 fixes against the new build" and "Next: verify the 4 fixes as
   soon as the new build is live". README's dashboard section (steps 2, 4 and 5, "It resumes
   where you were", "Where the dashboard keeps its files") and the fix loop's CLI section are
   updated; no removed button is documented anywhere, and `docs/plans/` is left as history.

## How this fails silently

1. **(a) A removed button comes back.** Mutation: re-add **Try again** to the `failed` ending in
   `fix-loop.ts`. Red: in every ended state the specs exercise, `getByRole('button', { name:
   /Try again|Continue|Start over|verify now|Keep waiting|Verify anyway|Stop waiting|without
   waiting|Sign in and continue|Start anyway|Crawl again|Deployed/ })` `toHaveCount(0)`.
2. **(b) The dashboard's wait still times out.** Mutation: `loop.mjs` treats `deployTimeout: 0`
   as 1 second. Red: with the fixture deploy never changing and `deployPoll` at 1 s, after 5 s the
   Fix step still shows the waiting sentence, the run is still `running`, and no
   `awaiting-deploy` outcome or "has not arrived" text appears.
3. **(c) The remaining findings are not fixed meanwhile.** Mutation: skip the ledger round before
   the wait. Red: with the fake agent declining some findings, the ledger has no round with
   `source: 'ledger'` before the build changes, and the step never says "Fixing the N remaining
   findings meanwhile".
4. **(d) A start against the old build still ends the loop.** Mutation: restore
   `return endAwaiting('still-old', ...)`. Red: starting the loop again while fixes await the
   build shows "still serves the old build" / outcome `awaiting-deploy` instead of the waiting
   sentence and a running run.
5. **(e) The sign-in wait gives up.** Mutation: `maxWait` 2 s in `--events` mode. Red: with nobody
   signing in for 6 s, the step still reads "Sign in in the tab that opened" and the run is still
   running; after the test signs in, the crawl runs. No "Nobody signed in" headline anywhere.
6. **(f) A round that cannot get in ends the loop.** Mutation: remove the re-sign-in. Red: with the
   saved session deleted between rounds (the fixture's auto-login portal then bounces the crawl),
   the loop ends `failed` instead of saying "Your sign-in expired: sign in in the tab that
   opened" and continuing after the sign-in.
7. **(g) An interrupted loop is not resumed.** Mutation: `reattach()` only adopts the run. Red:
   kill the loop mid-fix, start the dashboard again: the Fix step shows no "continuing from
   there" sentence, no new run starts, and the ledger attempt is never marked `interrupted`.
8. **(h) An error is not retried.** Mutation: no schedule after `error`. Red: with origin set to a
   path that does not exist (loop-resilience's push failure) and `A11Y_508_RETRY_DELAYS=2,2`, no
   "Trying again in" text and no second run record within 10 s.
9. **(i) A precondition is not re-checked.** Mutation: no 15-second poll. Red: a dirty tree, then
   `git stash`: no loop starts within 10 s (`A11Y_508_PRECONDITION_POLL=2`); with the poll, one
   does and the step says it started.
10. **(j) A round cap from the dashboard.** Mutation: `loopArgs` passes `--max-rounds 1`. Red: a
    two-round fixture scenario ends "Done: 2 fixed, 1 left" with the second round's fix never
    attempted; with no cap the ledger shows round 2.
11. **(k) Set up or History asks again.** Mutation: re-add **Clear fix-loop history**. Red:
    `toHaveCount(0)` on History for Clear history, Clear fix-loop history and Delete, and on Set up
    for Continue, Crawl again and Start over.
12. **(l) "Where you are" keeps the old words.** Mutation: the Next line says "verify now". Red:
    `ui/app/core/where.spec.ts` and the e2e's `where-next` assertions.

## Non-goals

- The CLI's flags and exits stay: `--verify`, `--verify-anyway`, `--from-report`, `--wait`,
  `--resume`, `--max-rounds`, exit 4 with its printed commands when a positive `deployTimeout`
  runs out, the 10-minute sign-in limit outside `--events`.
- The server's DELETE /api/reports..., DELETE /api/loop/history and /api/start-over endpoints stay
  (their node tests too); only the UI stops calling them.
- Quit's confirmation, the own-browser-window notice (Reopen / Details / Dismiss), the startup
  Retry, the assistant picker with Install / Retry / Test assistant, and the legacy-files
  Move / Leave stay: none is a recovery decision about the loop.
- No change to the checks, the crawler's discovery, the ledger's rules (3 attempts, grouping),
  or the loop's prompts. Troubleshoot stays reachable by its address; nothing links to it.
- No new screens, settings or options. Removing beats explaining.

## Specs that change (from the survey)

e2e: `deploy-wait.spec.ts` (every wait and not-arrived button, Verify anyway), `resume.spec.ts`
(Continue, Start over), `fix-click.spec.ts` (Try again, `loop-continue-next`), `next-step.spec.ts`
(Sign in and continue on Fix and Live), `loop-resilience.spec.ts` (Try again, Run again),
`loop.spec.ts` (Deployed — continue, Clear fix-loop history), `reports.spec.ts` (Clear history),
`loop-match.spec.ts` (Start anyway), `run-control.spec.ts` (Troubleshoot with these settings),
`run-simple.spec.ts` (Live Sign in, Troubleshoot, Continue / Crawl again), `carry.spec.ts`
(Continue / Crawl again), `harness.ts:255` (`startFromRun` uses `crawl-again`). Unit and node:
`ui/app/core/where.spec.ts`, `ui/app/core/outcome.spec.ts`, `test/loop.mjs` (exit 4 paths,
`still-old`), `test/event-schema.mjs` (`still-old`, `stopped-waiting`), `ui/server/test/
runs.test.mjs` and `resume.test.mjs` where they assert the interrupted offer. Keep every assertion
that still holds; replace, never delete, the ones about removed choices with the turnkey
behaviour they stood for.

## Appendix: where each choice lives today

Fix step `ui/app/screens/fix-loop.ts`: `ending` computed 557-583 (`start`, `signin`, `stopped`,
`failed`, `done`; `next` = continue / verify / see-changes); the wait's buttons 243-256
(`verify-now` 249, fix-remaining 251, stop-waiting 253); the `deploy-not-arrived` notice 257-286
(verify 272, from-ledger 274, keep-waiting 276, start-over 277, verify-anyway 281); could-not-start
201-206 with Try again 313; Sign in and continue 310 (`signInAndContinue` 599-603); failed: Try
again 316, Run again 317, See what changed 318; Continue 324; Run again 327; Deployed — continue
338-343; Start anyway 188; `fix()` 1123-1151, `startLoop()` 1159-1169, `?start=1` 909-929.
Notices: `shared/interrupted-notice.ts` (Continue 25 → POST /api/runs/resume; Start over 26),
`shared/start-over.ts` (GET/POST /api/start-over), `shared/where-you-are.ts` with `core/where.ts`
90-130, `shared/sign-in-wait.ts` (Show the sign-in tab → POST /api/sign-in/show).
Set up / Live: `shared/setup-form.ts` 39-41, 106-131 (Start / Continue / Crawl again);
`screens/run.ts` 27-29 (Start over); `screens/live.ts` 48-64, 169-216 (See the results, Sign in and
continue, Try again / Crawl again, the could-not-get-in notice with Sign in and Troubleshoot).
History `screens/history.ts`: Clear history 37/178, Clear fix-loop history 40/184, Delete 73/190,
Run again 103/120.
Server `ui/server/app.mjs`: `startRun` 288-355 (`deploy` 325-333), continue 636-640 (stdin words,
`runs.mjs` 240-246, `run-child.mjs` 76-80), interrupted 641-645, resume 533-550 / 646, start-over
552-583 / 671-672, deletes 680-697, `reattach()` 136-156, `outcomeOf` in `runs.mjs` 12-19 (exit 4 →
`awaiting-deploy`). Loop `src/loop.mjs`: `normalizeConfig` 39-69 (`deployTimeout`), `signInOnly`
196-218, `enterFromDashboard` 221-248, `waitForDeploy` ~520-550, `endAwaiting` 552-569, the start
path for awaiting fixes 640-678, crawl failed 728-737, assistant did not run 1070-1073, push
failed 1086-1088, the wait after a round 1124-1141, max-rounds 1147. Sign-in wait:
`src/login.mjs` `interactiveLogin` 63 (`maxWait` 10 min, "gave up after" 60). Defaults:
`ui/server/loop-defaults.mjs` (`DEPLOY_TIMEOUT`), `ui/server/args.mjs` `loopArgs` 96-132.
