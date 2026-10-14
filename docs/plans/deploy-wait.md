# Waiting for a deployment someone else runs: say so, and offer the ways on

slug: deploy-wait
branch: main

On the CBP laptop the loop committed and pushed 11 fixes to branch `a11y-508`, then waited 30 minutes for
cargo-dev (deployed by a pipeline outside this tool, from a branch that is not `a11y-508`) to serve a new build,
and stopped with "The fix loop stopped — the start page's bundles did not change within 30 minutes; stopping.
Rerun the loop once the deployment is live." The counts read "11 fixed, awaiting verification · 6 remaining · 7
need a person", and the person asked "it's not giving me a way to fully restart, what's up?". Pressing Try again
then started "Round 2: re-checking the site" against the old build, which would mark the 11 fixes as not holding.

Never re-crawl before the new build is live: that rule stays. What changes is that the loop and the Fix step say
plainly what is going on (fixes committed on a branch, the site still on the old build, deploy that branch), show
the wait's progress, and offer the real choices: verify now, fix the rest without waiting, keep waiting, stop
waiting. Running out of time is a state, not an error. And the person can see at a glance what has been done
and where they are ("Where you are").

Scope change (from the user, mid-build): the tool is over-scoped. It crawls, has the assistant fix everything it
can, says what it did, and keeps improving in rounds — nothing else. People who use the app report what is left;
the tool never asks a person to decide anything. So the Needs-a-person screen goes (criteria 7–9), and criterion 4
(expandable "no change" notes) is withdrawn: those rows no longer appear.

## Acceptance criteria

1. **While waiting** (`deployed: "bundle-change"`), the Fix step shows: "Waiting for your deployment. 11 fixes
   are committed on branch a11y-508 and pushed to origin. The site at cargo-dev.cbp.dhs.gov still serves the
   build from before them, so they cannot be verified yet. Deploy that branch — or merge it into the branch your
   pipeline builds — and this continues by itself; it checks every 30 s (12 min left)." with the buttons **The
   site is updated — verify now** (today's "Deployed — continue"), **Fix the remaining 6 without waiting** and
   **Stop waiting**. Branch, remote, host and counts are the real values (an unpushed round says "committed on
   branch X" with no remote); the countdown ticks. The poll interval is the config's `deployPoll` (default
   30 s). "Fix the remaining" is shown only when something is open; it runs a round with no crawl and then
   waits again for the same old build. "Stop waiting" ends the run in state 2.
2. **When the wait times out** (or Stop waiting), the loop ends with exit code 4 and the run's outcome
   `awaiting-deploy` (not `error`). The Fix step's notice reads "Your deployment has not arrived yet" with the
   same explanation and the actions **The site is updated — verify now**, **Fix the remaining 6 without
   waiting**, **Keep waiting** and the existing **Start over**. Try again and Run again are not shown.
   - *verify now* starts the next run, which first compares the start page's bundles with the ones recorded
     before the fixes: unchanged, it ends at once (no crawl) and the notice says "The site still serves the old
     build (checked just now); nothing was changed", offering **Verify anyway**, which re-crawls and verifies
     with the warning that fixes not yet deployed will count as not holding.
   - *Fix the remaining* continues from the ledger with no crawl (`--from-report` with no file); the pending
     fixes stay "awaiting verification".
   - *Keep waiting* resumes the wait (`--wait`), the screen as in 1.
   - History shows the round as "awaiting deployment", never as a failure.
3. **The CLI says the same.** When `a11y-508 loop` ends waiting, it prints the explanation and the three
   commands: `a11y-508 loop --verify`, `a11y-508 loop --from-report`, `a11y-508 loop --wait`
   (`--verify-anyway` documented with them). The README's runbook has a short "When the site is deployed by
   someone else" paragraph; `--help` and the exit codes list 4.
4. *(Withdrawn by the scope change: "no change" rows are no longer shown at all, see 9.)*
5. **Any loop start checks first.** Whenever the ledger has pending fixes from a round that waited for a
   bundle change (`ledger.deploy`) and `deployed` is `bundle-change`, the run's first round compares the
   bundles before anything else (Try again, Fix the violations, verify now, a plain `a11y-508 loop`): changed,
   it goes straight to the verifying crawl and the Fix step says "Your deployment arrived: verifying 11 fixes"
   during that crawl; unchanged, it ends as in 2 ("still serves the old build"), unless `--verify-anyway`.
6. **Where you are** (as simplified by 8). One component at the top of the Fix step and of History, always
   visible (no Details to open): a short checklist derived by one function from the ledger, the latest report
   and the live run. It updates live and after a reload shows the same thing (the done lines come from the
   ledger, not the run). Each line links to its place (Results, Changes this run / History).
7. **No Needs-a-person anything.** Removed: the `/review` route and its component and service, the "N need a
   person — review them" links on Fix and History, `GET /api/review`, `POST /api/ledger/decision` and the
   server's review module, the decision fields and "decided by a person" counts in History, the "A person
   reviewed this and says" prompt text, the self-audit coverage of `/review`, `needs-person.spec.ts` and the
   server review tests, docs/plans/needs-a-person.md, and the README's paragraph. Findings the assistant cannot
   fix (triage unsure, attempts used up) are dropped from the dashboard: no "need a person" count, list or
   advice anywhere. The ledger keeps them as status `skipped` (an older ledger's `needs-human` is read as
   `skipped`), which `a11y-508 status` lists; the counts read "N fixed · N remaining" where remaining counts
   only what the loop will still try (open).
8. **Where you are, simpler**: ✓ Crawled 33 pages on 13 Oct, 8:21 PM — 34 findings · ✓ Round 1: 11 fixes
   committed on branch a11y-508 and pushed to origin · ● Now: waiting for your deployment of a11y-508 (checks
   every 30 s, 12 min left) — or "Round 2: re-checking the site (14 of 33 pages)", "Round 2: fixing 3 of 6",
   "your deployment has not arrived yet", "stopped", "finished" · ○ Next: verify the 11 fixes against the new
   build, then fix the 6 remaining. Nothing about a person.
9. **Say what the assistant did.** When a round has committed, the Fix step's headline is "Round 1: fixed 11
   findings in 9 files, committed on branch a11y-508 and pushed to origin", with Changes this run under it (file
   paths, outcome) listing only committed rows: findings it did not change are not shown. Then the deploy-wait
   state of 1–2 and the next round. History per round reads the same: fixed N · remaining N, and its per-round
   changes list only committed rows.

## How this fails silently

a. **The timeout is an error again.** Mutation: the loop returns 1 with an error line on timeout. Test: the
   fixture app's bundle unchanged and a short `deployTimeout`; Keep waiting times out and the Fix step must show
   "Your deployment has not arrived yet", the three buttons, and no Try again.
b. **The quick bundle check is skipped.** Mutation: the round-start check is removed. Test: verify now with the
   bundle unchanged must show "The site still serves the old build (checked just now)" at once, with no crawl
   step in the run and no new ledger round.
c. **Fix the remaining crawls.** Mutation: the server does not pass `--from-report` (or the loop ignores it).
   Test: the started run's `run` event has `fromReport: "ledger"`, it has a fix step and no crawl step or page
   event, and the pending fixes stay pending.
d. **The countdown does not tick.** Mutation: the "left" text is computed from the start, not from now. Test:
   the "… left" text differs between two reads two seconds apart.
e. *(Withdrawn with criterion 4.)*
f. **History says failed.** Mutation: the timeline's round state is `failed`. Server test: `/api/loop/timeline`
   for a ledger awaiting a deployment gives the round `state: "awaiting-deploy"` and the label "awaiting
   deployment".
g. **Where you are has no "Now".** Mutation: the derivation drops the Now line. Test: the panel shows Now as
   waiting, as re-checking with page counts, and as finished.
h. **Where you are reads the run, not the ledger.** Mutation: the round lines come from the live run's commit
   events. Test: after a later run with no commits (verify now, still old) and a reload, "Round 1: … committed on
   branch a11y-508" is still there.
i. **The Needs-a-person route is left in.** Mutation: the `/review` route is restored. Test: `/review` shows the
   unknown-route page, and the Fix step and History contain no "need a person" text.
j. **"No change" rows come back.** Mutation: the Changes list shows every attempt again. Test: after a round in
   which the fake assistant declines some findings, the Changes list holds only committed rows and no "no
   change" text.

## Non-goals

- Deploying, or merging the branch into the pipeline's branch: the tool still never deploys.
- Changing `deployed: "command" | "enter" | "none"`; the round-start check applies only to `bundle-change`.
- A check of the bundles while the wait runs that differs from today's (the poll is the same, only its interval
  is configurable); "verify now" during the wait trusts the person, as "Deployed — continue" did.
- A dry run (`--dry-run`) does not get the round-start bundle check.
- Results detail (screenshots).
