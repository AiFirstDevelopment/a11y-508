# The PDF run reads clearly: one sentence, no false "Stopped", a Done list, a way out of a failed read

slug: manual-findings-clarity
branch: manual-findings-clarity

## Intent

The manual-findings flow (docs/plans/manual-findings.md, merged 2026-10-16 as 0571a9b) works, but
its builder named four places a developer would find confusing, and one e2e test was left red.
Joel, 2026-10-16: "Is there anything you can do ... to make some of the things less confusing?"
This plan fixes each of them, under the rules the dashboard already follows (docs/plans/
turnkey-loop.md): one plain sentence of what is happening, at most one button besides Stop, the
tool restarts a stage itself and says why, and every ended state says what was done.

1. **The same sentence twice during review.** `manualNow()` (home.ts:522-527) and the panel's
   `reviewLine()` (manual-panel.ts:167-172) both say "Approve the plan to start fixing, or edit
   an item and send it to the assistant."
2. **"Stopped" flashes after a dashboard restart.** Quit writes `outcome: 'stopped'` on the run;
   on relaunch `afterRun` starts the rerun 200 ms later (app.mjs:303-311), and until then the
   screen reads "Stopped" with a **Start** button, then flips to the resumed run.
3. **Done hides everything.** When the run ends the plan section and the decision log disappear
   (manual-panel.ts:37, :78); what was fixed is only in the Done sentence and behind **Show
   decisions**.
4. **A failed read is a dead end.** When the assistant's answer has no findings list the run
   ends with "The assistant could not read the PDF: its answer had no list of findings." and the
   only button is the generic PDF one; nothing is tried again and nothing says what to do.
5. **`turnkey AC8: the README documents no removed button` is red** because the README documents
   the **Start over** link beside Log (README.md:52). That link was added deliberately on
   2026-10-16 (f0fb752, "One screen: Start over is a link beside Log") after the turnkey work, so
   the test's list is stale, not the README.

## Acceptance criteria

1. **One sentence during review.** The review instruction appears once on the page: the main
   "what is happening" sentence (`manualNow()`). The panel's `review-step` line is removed; the
   plan's buttons (**Send changes**, **Approve plan**) sit directly under the items. The revised
   plan's sentence ("2 fixes did not hold in the deployed site after two tries. Review the
   revised plan.") likewise appears once, and both use `plural()`.

2. **A restart continues, and says so, from the first paint.** When the dashboard quits during
   a PDF run, the run record written by `gone()` (run-journal.mjs:173) carries
   `rerun: { reason: 'dashboard-restart' }` at the moment it is marked done — not 200 ms later —
   so that no `GET /api/runs/current` ever returns a quit PDF run without it. On relaunch the
   screen's first sentence is "The dashboard was closed during the PDF run (at the plan review);
   continuing from there." with the stage in parentheses taken from the saved `state.json`
   (reading the PDF / checking the deployed site / the plan review / fixing / waiting for the
   deployment / verifying), the button is **Stop**, and the word "Stopped" is never shown for
   that run. The same sentence covers the interrupted case (home.ts:570), so one sentence serves
   both. A PDF run that the person stopped with **Stop** still reads "Stopped." and is not rerun.

3. **Done shows what was done.** When the run ends `fixed` the panel keeps its content and
   adds **Fixed and confirmed in the deployed site (N)**, open, one row per approved item: the
   finding's title, the tester's quote, **PDF page 4** (link to `source.pdf#page=4`), the deployed
   URL checked, the commit(s) as links (`commitLink`), the assistant's verdict reason, and the
   before and after screenshots side by side (thumbnails, each opening the full image). **Already
   fixed in the deployed site (K)** stays below it, collapsed unless N is 0. **Decisions (M)**
   stays as a collapsed section (no longer hidden when done), and **Show decisions** keeps opening
   the full log. Items removed from the plan by the developer appear under a collapsed **Left out
   of the plan (J)** with the developer's reason if one was logged. The Done sentence is
   unchanged.

4. **A failed read is tried again, then explained.** When the read answer has no findings list,
   the tool asks the assistant once more (a decision `read / tool / "asked again" / reason` is
   logged, and the sentence meanwhile reads "The assistant's answer had no list of findings;
   asking it again."). If the second answer also has none, the run ends with "<Assistant label>
   could not read the PDF (its answer had no list of findings). Choose another PDF, or pick
   another assistant under Advanced." — the label from `PRESET_INFO` (Gemini CLI, Claude Code,
   Codex) or the custom command's first word — and the one button is **Choose another PDF**
   (already the text when `noFindings`; now also for `readFailed`). The same applies when the
   agent process fails or times out during the read.

5. **The turnkey README test is green, and the README documents the PDF run.** 'Start over'
   leaves the list in turnkey.spec.ts:326-331 (the companion test at :313 still asserts no
   *button* named Start over). README's dashboard section gains one paragraph on **Fix from a
   test report (PDF)**: choose the PDF; the assistant reads it and checks the deployed site;
   findings already fixed are reported with their PDF page; the plan is reviewed and approved
   (the one decision the tool asks of a person, and why); fixes are pushed, confirmed in the
   deployed site, tried once more, then re-planned; every decision is in **Show decisions**. It
   mentions `a11y-508 manual <pdf>` in the CLI section. No removed-button label appears.

## How this fails silently

1. **(a) The duplicate comes back.** Mutation: restore `review-step`. Red: during review
   `page.getByText(REVIEW)` has count 1 (new assertion in the AC6 test at manual.spec.ts:265).
2. **(b) "Stopped" flashes on restart.** Mutation: set `rerun` in the 200 ms timer instead of in
   `gone()`. Red: a spec that quits the dashboard mid-review, relaunches it, and for 3 s polls
   both `GET /api/runs/current` (must carry `rerun` or be running; never a bare `stopped` PDF run)
   and the page text every 100 ms (never "Stopped"; the first non-empty sentence contains
   "continuing from there"; the button reads Stop). A second case stops the run with **Stop**,
   relaunches, and expects "Stopped." with no rerun.
3. **(c) Done still hides the list.** Mutation: keep `!m.done` on the panel. Red: after the
   full-flow test's Done sentence, the **Fixed and confirmed** section has one row per fixed item,
   each with a `PDF page N` link, a commit link and two screenshots; the **Decisions** section is
   present.
4. **(d) The read is not retried.** Mutation: remove the second ask. Red: with
   `FAKE_MANUAL_READ_FAIL=1` (the fake agent answers without a findings list the first time) the
   run must reach the plan and `decisions.ndjson` must hold `by: tool, decision: asked again`;
   under the mutation it ends `readFailed`.
5. **(e) A failed read offers nothing.** Mutation: keep the generic sentence and button. Red:
   with `FAKE_MANUAL_READ_FAIL=2` the sentence names the assistant and "Advanced" and the button
   reads **Choose another PDF**, which opens the file chooser.
6. **(f) The README test goes red again, or documents a removed button.** Red: `turnkey AC8`
   passes with the new paragraph in place; a second assertion checks the README contains "Fix
   from a test report (PDF)" and "a11y-508 manual".

## Non-goals

- No change to the flow's stages, prompts (other than asking the read again), evidence capture,
  the plan's data, the picker, or the decision log's format.
- No new settings. No change to the crawl loop or its screens.
- The Start over link stays as it is (f0fb752).
- Screenshots are served from the run's evidence folder (`GET /api/manual/:id/evidence/...` if
  not already there); no image processing or thumbnail generation beyond CSS sizing.

## Where things live (for the builder)

UI: `ui/app/screens/home.ts` (`now()` 402, `manualNow()` 502-561, `ended()` 563-577,
`running()` 293, PDF button 52-53, Show decisions 57-58, `decisionsFor()` 213-219),
`ui/app/screens/manual-panel.ts` (Already fixed 21-36, plan 37-77, `reviewLine()` 167-172,
decisions 78-83, `editable()` 113, `canApprove()` 161), `ui/app/core/manual.ts` (`applyManual`
77-140: keep `verdicts`, `plan`, `alreadyFixed`, `decisions` after done), `ui/app/core/run.store.ts`
(`manual` 102, events 475-477, cleared 231), `ui/app/core/git-links.ts`, `ui/app/shared/
decisions-pane.ts`. Server: `ui/server/run-journal.mjs` (`kill()` 233-238, `gone()` 173),
`ui/server/app.mjs` (`reattach()` 170-189, manual `afterRun` 303-311, `continueInterrupted`
383-388, `/api/manual/runs` 946, `/api/manual/:id/decisions` 950-953 — each group already has
status, commits with url, screenshots, title, page, quote). Core: `src/manual.mjs` (read failure
346-351, `finish()` 240-245, Done 798-803, `savePlan` 450-455; the saved stage for the restart
sentence is in `state.json`), `src/agent.mjs` `PRESET_INFO` 22. Tests: `ui/e2e/manual.spec.ts`
(helpers 29-75; full flow 143; review/restart 265-292; `REVIEW` 18), `ui/e2e/turnkey.spec.ts`
313 and 326-331, `test/fake-agent.mjs` (`manual()` 113, manual-read 121 — add
`FAKE_MANUAL_READ_FAIL=<n>`), `test/event-schema.mjs` if the run record or events gain fields.
Rebuild `ui/dist` with Node 22 before each spec run; `npm --prefix ui run freshness` must pass.
Local gate: `npm --prefix ui run typecheck && npm --prefix ui test && npm test && npm --prefix ui
run e2e`.
