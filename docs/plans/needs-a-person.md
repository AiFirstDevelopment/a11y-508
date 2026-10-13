# Needs a person: a review screen that shows where to look and takes the decision

slug: needs-a-person
branch: main

The loop marks a finding "needs a person" when the assistant cannot decide it (an image's alt text, whether labels
describe their inputs, whether page titles identify the page) or has given up on it. Today those findings are a
bullet list under Details on the Fix step — test id, message, "[3 page(s), 0 attempt(s)]" — and a person has no
way to tell where to look or to record what they decided. The crawler already has the evidence: each finding has
its pages, its selector, the rendered HTML and, for most, a cropped screenshot of the element
(`screenshots/*.png` in the report folder, taken from `f.rect` in `src/audit.mjs`); the dashboard already knows how
to find a finding's markup under the source folders (`GET /api/loop/match`). This plan puts that in front of the
person and takes their decision back into the ledger so the loop honours it.

## Acceptance criteria

1. A **Needs a person** screen (route `/review`) lists every finding whose ledger status is `needs-human`, one
   card each, newest round first. The Fix step and History show one line with the count and a link
   ("4 need a person — review them"); the bullet list under the Fix step's Details is gone.
2. Each card says, in plain words: **What to check** (the test's condition and the finding's message), **Where
   to look**: the pages as clickable routes (query strings hidden, as on Results; opening in a new tab of the
   dashboard's own browser, where the person is signed in), the element's screenshot when the finding has one,
   the rendered HTML, the selector, and the likely source files — repo-relative path and line of each place
   under the source folders where the markup's distinctive literals (ids, class names, data-testid, text)
   occur, found the way `/api/loop/match` finds them. A page-level finding (no element, e.g. 12.B titles, 19.A
   ways to locate) says "Whole page" and shows the pages instead of a screenshot.
3. The screenshot is served from the latest report folder for that URL (the same folder Results reads), never
   copied into the dashboard; a finding whose screenshot file is missing shows "No screenshot" rather than a
   broken image.
4. Each card has **Your decision**: *Looks fine* → status `adequate`; *Won't fix* → status `wont-fix`, note
   required; *Ask the assistant to fix it* → status `open` with the note as guidance, attempts reset so the
   loop tries again. The decision (`{ by: 'person', status, note, at }`) is written to the ledger in the work
   folder through a new `POST /api/ledger/decision` and shows on the card afterwards ("Decided by you on
   13 Oct 2026, 4:52 PM — Looks fine").
5. The loop honours decisions: `adequate` and `wont-fix` findings are never fixed or re-asked; a finding sent
   back with a note has the note in its next fix prompt ("A person reviewed this and says: …"); a finding a
   person decided is not reopened by the next crawl unless the person's decision was "fix it".
6. History's round summary counts decisions ("2 decided by a person") and the History screen's totals treat
   `adequate` and `wont-fix` as resolved, not remaining.
7. The screen works with keyboard and screen reader (it is an accessibility tool): each card is a labelled
   region, decisions are real buttons, the note is a labelled textarea, and the dashboard's own self-audit
   (the Playwright self-audit test the UI already has) passes on it.

## How this fails silently

1. The screen lists findings of a status other than `needs-human` (or misses some). Mutation: filter on
   `open` — the test seeding a ledger with two `needs-human` and three `open` findings must fail.
2. Source locations are guessed from the selector rather than searched. Mutation: return an empty list from
   the search — the test asserting the fixture's `site/index.html:NN` path and line must fail.
3. The screenshot `<img>` points at a path that is not served. Mutation: change the served prefix — the test
   asserting the image responds 200 with `image/png` must fail.
4. A decision is shown but not written. Mutation: skip the ledger write — the test reloading the page and
   asserting the decision line must fail; the loop test asserting the finding is skipped must fail.
5. The loop fixes an `adequate`/`wont-fix` finding anyway. Mutation: drop the status check in the loop's open
   selection — the loop test with a decided finding must fail (the fake agent gets called for it).
6. The note does not reach the prompt. Mutation: omit it from `fixPrompt` — the loop test reading the written
   prompt file must fail.
7. The Fix step still renders the old bullet list. Mutation: leave it in — the Playwright test asserting it is
   absent and the link is present must fail.

## Non-goals

- Changing which findings become `needs-human` (triage rules stay).
- Editing source files from the screen.
- Any change to the crawler, checks or screenshots themselves.

## Notes for the builder

- Another agent is editing `ui/app/screens/fix-loop.ts`, `ui/app/screens/history.ts`, `src/loop.mjs` and
  `ui/app/core/run.store.ts` right now (fix-loop pane, counts, gate). Keep your changes to those files to the
  minimum (the one line with the link in fix-loop and history; the status/note checks in loop.mjs); put the
  screen, its service and the server route in new files. Rebase on `origin/main` before every push and resolve
  conflicts by keeping both changes.
- Ledger: `src/ledger.mjs` (statuses, `byStatus`); `ui/server/app.mjs` (`/api/ledger`, `/api/loop/match`,
  report file serving); the Results screen for how routes are shown without query strings; `ui/e2e` harness and
  the fixture site under `test/fixtures` for a report with screenshots.
- Test helpers may delete only directories they created under the OS temp dir; never the repository root, never
  a path a caller passed in. Never run a test with the repository root as its working directory.
- All suites local; push to `main` directly; rebuild `ui/dist` and `build-info.json` from committed source
  before pushing a UI change.
