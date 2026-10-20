# One push per deployment: the fix loop batches its fixes instead of pushing each leftover

slug: fewer-pushes
branch: fewer-pushes

## Intent

Joel's run of 2026-10-19 on g2g-ui (build 4d43a36), and the team's complaint the day after: "too many
PRs, which means too many iterations". The team opens a PR (and deploys) for every push the loop makes
to the `a11y-508` branch. That run pushed four times for what was two deployments' worth of work:

- Round 1 fixed 8 findings as 4 tasks and pushed (marker r1). One task ran out of time, one had an
  assistant that exited with no result file.
- Round 2 was a "meanwhile" round (the dashboard's wait has no limit, so whatever is still open is
  fixed from the ledger while the build is awaited, src/loop.mjs, `meanwhileNext`). It fixed one
  leftover and **pushed** (marker r2). The r1 deployment the team was making no longer counted; the
  loop now waited for r2.
- Round 3, after the r2 deployment: 3 verified, 4 did not hold, re-fixed and pushed (marker r3).
- Round 4, again "meanwhile": one finding, pushed (marker r4). That is the deployment the team was
  still being asked for the next morning.

After this change, the loop makes **at most one push per deployment**. Fixes made while a deployment
is awaited are committed locally and go out with the next push, after the awaited deployment has
arrived and been verified. A task whose assistant gave no answer (ran out of time, crashed, wrote no
result) is tried once more in the same round, before the push, instead of becoming a leftover that
costs its own push. The fix prompts already ask the assistant to rebuild the SPA and the launching
application (commit 4f2e044), so a fix that does not compile no longer costs a deployment either.

Turnkey, as always (memory: a11y-508-turnkey-loop): nobody chooses anything. The sentence says what is
happening, for example "Fixed 2 more while your deployment is awaited; they go out with the next push".

## Acceptance criteria

1. **A meanwhile round does not push.** When the loop fixes from the ledger while a deployment is
   awaited (`meanwhile`), its fix commits are made but `git push` is not run, no build marker is
   committed, and `ledger.deploy.marker` stays the marker the awaited push carried. The loop goes on
   waiting for that marker's build.
2. **Held fixes are not verified against a build that does not have them.** A fix committed in a
   meanwhile round is recorded as held (not pushed): it is not counted as "awaiting your deployment"
   for the build being awaited, and the verification crawl after that build arrives never marks it
   "did not hold", reopens it, or counts an attempt against it. It is verified only against a build
   made from a push that included it.
3. **Held fixes go out with the next push.** After the awaited build arrives and its round is done,
   the loop pushes once: the held commits together with that round's own fixes, with one new build
   marker. If that round commits nothing of its own, the held commits are still pushed (with a
   marker), so they are never left behind. One push, one marker, per deployment.
4. **A run never ends with held fixes unpushed.** If the loop would stop (nothing left it can fix,
   max rounds, all verified) while fixes are held, it pushes them and waits for their deployment
   first. Stop (the person's) leaves them committed locally and a later Start/resume pushes them
   (the ledger keeps them held across a restart).
5. **No-answer tasks are retried in the same round.** A fix task whose assistant call ended without
   a usable answer (timed out, exited without a result file, or the result file is not valid JSON) is
   run once more in the same round, before the round commits and pushes. A task that answered
   `fixed: false` with a reason (for example "rendered by a library") is not retried. The retry counts
   as an attempt toward `maxAttempts`, and quota retries (`quotaDelays`) are unchanged.
6. **The dashboard says what is held.** While fixes are held, the home sentence says how many and that
   they go out with the next push after the awaited deployment, e.g. "Waiting for your deployment
   (pushed 2:01 PM, checked 3:18 PM: still the old build); 2 more fixes are ready and go out with the
   next push". The counts line shows them in a group of their own, not in "awaiting your deployment",
   and the fixes panel (the counts link) lists them with the state "committed; goes out with the next
   push". Nothing asks a person to decide.
7. **The log says it.** Diagnostics' "What happened" gets one line per meanwhile round, "Round N: held
   K commit(s) for the next push (a deployment is awaited)", and the push line after the build says
   how many held commits it carried: "Round N: pushed M commit(s), K of them held while the
   deployment was awaited".

## How this fails silently

1. **A meanwhile round still pushes** — the push count looks fine in a short test but each leftover
   costs a deployment again. Mutation: restore the push for meanwhile rounds. A test counts pushes to
   the origin across a run with one leftover and expects exactly one push per deployment.
2. **Held fixes verified against the old build** — they come back "did not hold" and are re-fixed in a
   loop, which is worse than today. Mutation: count held fixes as pending for the awaited build. A test
   holds a fix, delivers the awaited build without it, and expects the held fix untouched (no attempt
   added, not reopened).
3. **Held commits lost** — the round after the build commits nothing and the held commits never reach
   origin. Mutation: push only when the round itself committed. A test where the verification round
   has nothing new expects the held commits on origin with a new marker.
4. **The marker moves without a push** — the wait looks for a marker the site can never serve and waits
   forever (the r4 symptom). Mutation: stamp a marker in a meanwhile round. A test asserts
   `ledger.deploy.marker` and the index.html on origin are unchanged by a meanwhile round.
5. **Retry storms** — a no-answer retry that loops, or retries an honest `fixed: false`. Mutation: retry
   every non-fixed task. A test with a fake assistant that answers `fixed: false` with a reason expects
   exactly one call for it in the round; one that times out once then fixes expects two calls and one
   commit in the same round, and one push.
6. **Held state lost on restart** — after the dashboard restarts, held commits are treated as pushed and
   awaited. Mutation: drop the held flag from the saved ledger. A resume test expects them still held
   and pushed with the next push.

## Non-goals

- The PDF/screenshots run (src/manual.mjs) keeps its own push and wait; this is the crawl fix loop only.
- No change to how a deployment is detected (marker, bundles) or to `deployed: command|enter|none`
  beyond not pushing in meanwhile rounds. With `deployed: command` there is no meanwhile round today and
  nothing changes.
- No local serving or local verification of fixes; only the deployed site can say a fix held.
- No new settings and no new buttons.

## Where things live

- src/loop.mjs: `meanwhileNext` / `meanwhile`, the marker stamp (`stampBuildMarker`), the push
  (`git(cwd, ['push', ...])`), `ledger.deploy`, `byStatus(ledger, 'pending')`, the fix task loop
  (`tasks`, `withOutput`, attempts), `awaitingDeploy()`.
- src/ledger.mjs: statuses and counts.
- ui/app/screens/home.ts: the sentence (`waiting()`), `counts()`, the fixes panel (`fixed()` and its
  groups, `openFixes(ev, group)`).
- ui/app/screens/diagnostics.ts and the run's events: "What happened" lines.
- Tests: test/loop.mjs, test/loop-app.mjs (the loop against a fixture app with a fake assistant and a
  fake origin), ui/e2e/one-screen.spec.ts and ui/e2e/deploy-wait.spec.ts (the dashboard through a whole
  run with a deploy step), ui/e2e/harness.ts.
