# The tool lists the findings from the parse; the assistant only says what each page shows

slug: read-from-parse
branch: read-from-parse

## Intent

Joel's first full run of the PDF flow on his real report (2026-10-17, build 00b4958): the parse was
exact — 13 pages, dividers on 1 and 11, nine pages "Verified fixed", two "Still an issue", every
criterion right. The assistant's reading of that parse was not:

- It produced **one** finding for the whole report. The nine pages the tester had verified fixed
  were silently dropped, so nothing was checked against the deployed site and no already-fixed
  report was written.
- It **never looked at the pictures**: its decision reads "the images on pages 12 and 13 show
  form fields with red and green highlighting (validation status)". Page 12 is a bar chart whose
  two series differ only by colour; page 13 is a map whose pin rings differ only by colour. It
  merged the two into one finding and planned a fix in `FormPanelComponent` on the search
  panel — the wrong component for an element that is not the problem.
- Its selectors matched nothing on the deployed page, and nothing noticed.
- In the check stage it gave no verdict at all; the tool fell back to "treated as present".

Every one of those is the assistant being trusted with a list it can shorten and a picture it can
skip. After this change the **tool** builds the list of findings from the parse — one per page
that carries a criterion, with page, status, date, criterion and quote filled in exactly — and
the assistant's job shrinks to what only it can do: for each page, say what the picture shows,
which element the tester means, where it is in the application, and how to find it. It must
answer for every page (the tool asks again for the ones it skipped), it may merge pages only when
they share a criterion, and a finding whose selectors match nothing in the deployed site is sent
back to it once with the real page in front of it before it is planned. What it says it saw is
shown on every plan item and already-fixed row, so a misread is caught at a glance — which is
exactly how Joel caught this one. Picture-reading calls to Gemini CLI run on a model that reads
pictures unless the person chose otherwise.

## Acceptance criteria

1. **The tool builds the candidates.** After the parse, `src/manual.mjs` builds `candidates[]`
   from `manifest.json`, deterministically: one per page that has at least one recognised
   criterion; when no page has one, one per page that is not a divider and has text or a
   picture. Each candidate: `id` (F1, F2, … in page order), `pages: [n]`, `page`, `status`,
   `statusDate`, `criterion` (the page's first), `criterionName`, `wcag` (from the catalogue),
   `quote` (the page's criterion line verbatim, else its first text line, else ''), `picture`,
   `images[]`. The assistant cannot add, drop or renumber candidates; it may split one with
   `extra` (AC 2) and merge with `sameAs` (AC 3). `candidates.json` is written beside
   `findings.json`. The step reads "Reading the PDF: 11 findings on 13 pages; asking the
   assistant what each page shows."

2. **The assistant describes each page, and must answer for all of them.** `manualReadPrompt`
   becomes `manualDescribePrompt`: it lists the candidates as blocks —

   ```
   ## F10 — page 12 — 13.A 1.4.1-color-meaning — open ("Still an issue – 9/28/26")
   Picture of the page: pages/page-12.png   (look at it; the callouts and arrows are only there)
   Text: > 13.A Color is not used as the only visual means ... > Still an issue – 9/28/26
   ```

   — and asks, per candidate: `seen` (two or three sentences: what screen the picture shows, the
   callout's words read from the picture, what the arrows point at), `element`, `route` (one of
   the known routes when one fits), `selectors` (up to 5), `expected`, `sameAs` (an earlier id,
   when this page shows the same element with the same problem), `extra` (a second problem on
   the same page, with the same fields, rare), `decisions`. The result is `{ answers: [...] }`
   keyed by id. The tool checks it: an answer for an id it did not issue is dropped (logged); a
   candidate with no answer, or an answer without `seen` or `element`, is asked again — once,
   with only the missing candidates and the sentence "You did not answer for F3, F7 and F9.
   Answer for each of them." If still missing, the candidate is kept with `seen: null`,
   `element: 'not described by the assistant'`, no selectors, and a decision `read / tool /
   'kept without a description'`. No candidate is ever lost.

3. **Merging is bounded.** `sameAs: 'F2'` is honoured only when both candidates have the same
   `criterion` (or both have none); otherwise it is ignored with a decision (`read / tool /
   'kept F11 separate from F10' / 'they are different criteria' or 'the assistant merged two
   pages whose pictures it described differently'`). A merged finding has `pages` in order,
   `page` the first, the first page's status (a disagreement between merged pages' statuses is
   logged and the finding kept separate instead). `extra` makes a new finding `F10b` with the
   same page facts and the assistant's fields. `findings.json` holds the merged list; the
   sentence after the read says "11 findings read from the PDF: 9 the tester verified fixed, 2
   open." (counts after merging).

4. **A finding the tool cannot find on the page goes back once.** The check capture already
   counts how many elements the assistant's selectors match (`matched`). When the page loaded
   and `matched === 0`, the finding is "unlocated": after the capture of all findings, the tool
   asks the assistant once more for just those (`manualLocatePrompt`): per finding, its `seen`,
   the page picture from the PDF, the deployed page's screenshot and `elements.json` / the
   landmark and control inventory the capture already writes, and the known routes; it answers
   `route` and `selectors` (and may say `notOnThisRoute: true` with the route it thinks is
   right). The tool captures again for those; `matched > 0` clears it. Still 0 → the finding is
   kept with `located: false` and a decision `check / tool / 'could not find the element on
   <route>' / 'the assistant's selectors matched nothing twice'`; its plan item carries the line
   "The tool could not find this element on <route>: the assistant's selectors matched nothing.
   Check the component before approving." The relocation never runs for findings whose page
   did not load.

5. **Every per-item answer is asked again when incomplete.** The check (`manual-check`), verify
   (`manual-verify`) and confirm (`manual-confirm`) answers get the same completeness rule as
   AC 2 through one helper (`askForAll(label, ids, prompt)`): missing ids are asked once more
   with only those items; what is still missing falls back as today (present / not-fixed /
   understood: false) with the decision reading "no verdict from the assistant after two asks".
   The "no verdict" fallback is a last resort, not the first.

6. **What the assistant saw is on the screen.** Each plan item, each already-fixed row, each
   Done row and each decisions-pane group shows, under the page picture, "What the assistant
   saw on page 12: <seen>" (or "The assistant did not describe this page."). The `seen` text is
   also the first line of the finding's block in `decisions.md`.

7. **Pictures get a model that reads pictures.** When the assistant is the `gemini` preset and
   `GEMINI_MODEL` is not set in the environment, the manual flow's calls run with
   `GEMINI_MODEL=gemini-2.5-pro` (set in `agentEnvFor` for manual calls only; the crawl loop and
   CI are unchanged). An explicit `GEMINI_MODEL` always wins. The Assistant calls row on the Log
   page shows the model from the stream's `init` event ("read · Gemini CLI (gemini-2.5-pro) ·
   1 min · answered") when the stream carries one.

8. **The fake agent follows the same contract.** `test/fake-agent.mjs` answers `manual-describe`
   per candidate from the prompt's machine-readable block (its `seen` is "A fixture page showing
   <the candidate's quote>"), `manual-locate` with the fixture's real selectors, and keeps the
   existing knobs. New knobs: `FAKE_MANUAL_DESCRIBE_SKIP=F3,F5` (the first describe omits those
   ids; the second answers them), `FAKE_MANUAL_DESCRIBE_EXTRA=F1` (adds an answer for an id that
   was not issued), `FAKE_MANUAL_SAME_AS=F4:F1` (F4 says sameAs F1 — in the deck fixture F1 and
   F4 are different criteria), `FAKE_MANUAL_SELECTORS_WRONG=F1` (the describe gives F1 selectors
   that match nothing; the locate gives the right ones), `FAKE_MANUAL_CHECK_SKIP=F2` (the first
   check omits F2's verdict).

9. **The deck fixture carries the real report's shape.** `test/fixtures/manual/make-pdf.mjs`'s
   deck has at least: two criteria with several pages each (two of the same element — merge
   expected — and two of different elements), one page whose criterion the fixture site no
   longer has (already fixed), one "Verified fixed" page whose issue the site still has (came
   back), one page with two problems (extra), and the two open pages. The e2e walks the deck to
   Done and asserts the counts sentence, the already-fixed rows, the came-back item, the
   `seen` lines, and the decisions.

## How this fails silently

1. **(a) The assistant's list replaces the tool's.** Mutation: use the answers as the findings.
   Red: with `FAKE_MANUAL_DESCRIBE_SKIP` naming two ids and the second ask disabled by the
   mutation, `findings.json` has fewer findings than criterion pages; expected: one per
   criterion page (the fixture's count), the counts sentence matching.
2. **(b) Missing answers are not asked again.** Mutation: skip the second ask. Red: F3 and F5
   have `seen: null` and the decision "kept without a description"; expected: described, no
   such decision, and `agent-describe-2.log` exists with only F3 and F5 in its prompt.
3. **(c) An answer for an unissued id is kept.** Mutation: accept it. Red: with
   `FAKE_MANUAL_DESCRIBE_EXTRA`, `findings.json` has an id the candidates did not issue.
4. **(d) Merging ignores the criterion.** Mutation: honour every `sameAs`. Red: with
   `FAKE_MANUAL_SAME_AS=F4:F1` (different criteria), F4 is merged into F1; expected: both kept,
   decision "kept F4 separate from F1".
5. **(e) An unlocated finding is planned without a second look.** Mutation: skip the locate.
   Red: with `FAKE_MANUAL_SELECTORS_WRONG=F1`, F1's plan item carries the "could not find" line
   and `evidence/F1/before/summary.json` has `matched: 0`; expected: no line, a second capture
   with `matched > 0`, and `agent-locate-1.log` present.
6. **(f) A missing verdict falls back at once.** Mutation: no second check ask. Red: with
   `FAKE_MANUAL_CHECK_SKIP=F2`, F2's decision reads "no verdict from the assistant"; expected:
   a verdict from the agent and a second check call in Assistant calls.
7. **(g) "What the assistant saw" is hidden.** Mutation: remove it from the plan item. Red: the
   plan item and the already-fixed row have no `seen` text (`data-testid="seen"`).
8. **(h) Gemini runs on auto.** Unit: `agentEnvFor` for the gemini preset in manual context,
   `GEMINI_MODEL` unset → `gemini-2.5-pro`; set to `x` → `x`; for the loop → unset. Mutation:
   drop the default → red. The Log row shows the model: e2e with `FAKE_AGENT_STREAM_ONCE` (the
   fake's init event carries `"model":"fake-1"`) expects "(fake-1)" in the row.
9. **(i) The counts sentence lies.** Mutation: count candidates instead of merged findings. Red:
   the sentence's total differs from `findings.json`'s length on the deck fixture.
10. **(j) Statuses disagree across a merge.** Mutation: merge anyway. Red: a fixture where F2
    (fixed) says sameAs F1 (open) stays two findings with the decision logged.

## Non-goals

- No change to the parse, `report.md`, the plan/confirm/fix/replan prompts' content beyond the
  `seen` field carried through, or the dashboard's flow of states.
- No OCR of callouts by the tool; `seen` is the assistant's reading and is labelled as such.
- No new Advanced setting; the model default is an environment default that an explicit value
  overrides.
- The locate step runs once per finding, not in a loop.

## Where things live (for the builder)

`src/manual.mjs`: read stage 440-515 (`readOnce`, `said`, the retry), `checkFindings` 66-121
(becomes the candidate builder plus the answer checks — pages/quotes now come from the tool, so
the quote check is gone; the status/criterion checks remain for `extra`), check stage 545-600
(`capture` 395-415 returns `matched` per finding via `evidenceBrowser.capture`, src/evidence.mjs
59-96 and `MATCHES` 38), already-fixed and plan item builders 590-635 (add `seen`, `located`).
`src/agent.mjs`: `manualReadPrompt` 473-524 → `manualDescribePrompt`; new `manualLocatePrompt`;
`manualCheckPrompt` 526, `manualVerifyPrompt` 657, `manualConfirmPrompt` 586 (unchanged text,
called through `askForAll`); `agentEnvFor` ~230 (gemini: `GEMINI_CLI_TRUST_WORKSPACE` is set
there; add `GEMINI_MODEL` for manual calls — pass a `context: 'manual'` from `callAgent`'s
options). `ui/server/agent-calls.mjs` (model from the init line of the log's stdout).
UI: `ui/app/screens/manual-panel.ts` (items and rows: picture + `seen`), `ui/app/shared/
decisions-pane.ts`, `ui/app/core/manual.ts`. Tests: `test/fake-agent.mjs` 108-170 (manual
kinds and knobs), `test/fixtures/manual/make-pdf.mjs` (the deck), `ui/e2e/manual.spec.ts`
(helpers 29-75; the deck flow; guards), `test/manual-read.mjs` (node: candidate builder, merge
rules, status disagreement — pure functions), `ui/server/test/agent-calls.test.mjs`,
`test/event-schema.mjs`. Rebuild `ui/dist` with Node 22 before each spec run; `freshness` must
pass. Local gate: `npm --prefix ui run typecheck && npm --prefix ui test && npm test && npm
--prefix ui run e2e`.
