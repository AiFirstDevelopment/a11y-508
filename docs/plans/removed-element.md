# A removed element is already fixed, and the assistant may not swap in another element

slug: removed-element
branch: removed-element

## Intent

Joel's screenshot run of 2026-10-18 (build e43877e): one screenshot from Kathy, "No keyboard access to
Refresh button" in the Hot List, with her question "Unable to verify, has this element been removed?".
The tool found the right page and the Hot List, but not the button. The locate answer swapped in a
different element: "the Search button in this new panel serves the same purpose as the old Refresh
button", with selector `app-form-panel button:first-of-type`. The plan then read the real source,
`hotlist.component.html`, and found the refresh button gone ("No code change is necessary"). That is
the right answer to Kathy, but it came as a plan item waiting for approval, when it should have been
"already fixed: the element was removed" with nothing to approve.

After this change:
- The locate step may answer `removed: true` with a reason. It may not offer a different element as a
  stand-in. An answer whose reason says "equivalent", "replaced by", "serves the same purpose" or "instead",
  or that names another control's text, is not taken as found.
- The plan step may answer per item `noChange: true` with `removed: true` and a reason. Such an item
  leaves the plan and becomes Already fixed.
- Whenever the tester's element is said to be removed (by locate or plan), the run lists it under a new
  heading, **Already fixed: removed (N)**, with the reason and the evidence. When nothing is left to
  plan, the run ends without asking for approval.

## Acceptance criteria

1. **Locate may say removed, never a stand-in.** `manualLocatePrompt` (src/agent.mjs) adds `removed:
   true|false`, with the rule: "If the element is not on the page or in the source, say removed: true
   with what you checked. Never give a different element in its place, even one with a similar
   purpose." In `src/manual.mjs`, the locate result handling:
   - `removed: true`: the finding gets `removed: { by: 'locate', reason }`. It is not captured again,
     and a decision `check / agent / 'the element has been removed' / reason` is logged.
   - A stand-in answer is rejected: the reason matches
     `/\b(equivalent|replaced (by|with)|serves the same|same purpose|instead of|in place of|substitute)\b/i`,
     or the answer's selectors match an element whose accessible name is not the finding's element words.
     Use the simpler check, the reason regex, and write the selector part only if it is cheap. A rejected
     answer keeps the finding unlocated, with the decision `check / tool / 'did not take a different
     element in its place' / <the reason it gave>`.
2. **Plan may say removed.** `manualPlanPrompt` adds per item `noChange: true|false` and
   `removed: true|false` with a reason: "When the code shows the element no longer exists, say
   noChange: true and removed: true, and name the file you read." An item answered that way leaves the
   plan, becomes `removed: { by: 'plan', reason, files }` and gets a decision. If no items are left in
   the plan, nothing is approved: the run ends with the Done sentence.
3. **Already fixed: removed.** In the panel, add a section **Already fixed: removed (N)**, open when
   it is the only content. Each row has the finding, its quote and picture link, "The element has been
   removed: <reason>", and the files or the deployed page that show it. The same section goes in
   `already-fixed.md` and `decisions.md`. The Done sentence counts these: "Nothing to fix: 1 element
   has been removed since the tester looked." When removals and other kinds are mixed, they are added
   to the existing counts. A tester-verified-fixed finding that is removed counts with the others as
   already fixed.
4. **Fake agent and tests.** `test/fake-agent.mjs` adds three knobs:
   - `FAKE_MANUAL_LOCATE_STANDIN=F1`: the locate answers with another selector and the reason "the
     Search button serves the same purpose".
   - `FAKE_MANUAL_LOCATE_REMOVED=F1`
   - `FAKE_MANUAL_PLAN_REMOVED=F1`: noChange and removed, with a file.

   The e2e tests use a screenshot run: the screenshots helper and fixtures from
   docs/plans/screenshots-in.md, or the deck if that is simpler.

## How this fails silently

1. **(a) The stand-in is taken.** With `FAKE_MANUAL_LOCATE_STANDIN=F1`, F1 must stay unlocated, its
   item must say the tool could not find it, and the decision "did not take a different element in its
   place" must be logged. Mutation: accept every locate answer. That turns the test red.
2. **(b) A locate removal is planned.** With `FAKE_MANUAL_LOCATE_REMOVED=F1`, F1 must not be a plan item,
   and the **Already fixed: removed (1)** row must show the reason. Mutation: ignore `removed`. That
   turns the test red.
3. **(c) A plan removal waits for approval.** With `FAKE_MANUAL_PLAN_REMOVED=F1` and F1 the only open
   finding, the run must end with "Nothing to fix: 1 element has been removed since the tester
   looked.", with no **Approve plan** button and no fix commit. Mutation: keep noChange items in the
   plan. That turns the test red.
4. **(d) Removed is not in the report.** `already-fixed.md` and `decisions.md` must contain the
   "removed" section with the reason. A unit test checks this.

## Non-goals

No change to the crawl, the parse, the read, the check verdicts or the fix stage.

## Where things live

- `src/agent.mjs`: `manualLocatePrompt` (~576-610) and `manualPlanPrompt` (~701).
- `src/manual.mjs`: the locate handling (~830-875), the plan handling (~1000-1100), the already-fixed
  rows and Done sentence (~930-990, the `done` event), and the decision lines.
- UI: `ui/app/screens/manual-panel.ts` (sections), `ui/app/core/manual.ts`,
  `ui/app/shared/decisions-pane.ts`.
- Tests: `test/fake-agent.mjs` (manual-locate ~220, manual-plan ~240), `ui/e2e/manual.spec.ts`,
  `test/manual-read.mjs`.

Rebuild `ui/dist` with Node 22 before running specs. `freshness` must pass. Local gate:
`npm --prefix ui run typecheck && npm --prefix ui test && npm test && npm --prefix ui run e2e`.
