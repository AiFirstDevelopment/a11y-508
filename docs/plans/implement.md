# Parse the tester's PDF first: exact pages, text and pictures the assistant reads instead of the PDF

slug: pdf-parse
branch: pdf-parse

## Intent

Joel, 2026-10-17: "create a deterministic pdf parser that would strip out narrative and images and
organize them in a way that would be easy for an ai to work with ... applied to any pdf that was
selected and the parsed files would be pointed to in the prompt that is passed to the ai ...
i am thinking of pdfs exported from powerpoint etc where there may be embedded screenshots ...
make it as robust as possible and easy to express in the prompt."

Today the manual flow (docs/plans/manual-findings.md) hands the assistant the PDF itself. On
Joel's first real run Gemini CLI "ended without an answer (exit code 0)": whether or not that
assistant can open a PDF at all, everything about the reading is a guess the tool cannot check —
the page numbers, the quotes, the status. The real report he then shared (13 slides exported from
PowerPoint: a "Resolved Issues" divider, five slides of 5.C, two of 13.C, two of 14.B, an
"Outstanding Issues" divider, two of 13.A) shows what a parse can and cannot know:

- The text layer of each slide holds the criterion line ("5.C The combination of the accessible
  name ... - 1.3.1-programmatic-label") and the verdict ("Verified fixed – 9/28/2026", "Still an
  issue – 9/28/26"). Those are exact, and the divider slides sort every page into a section.
- The callouts ("Textboxes have no accessible name or title"), the ANDI output, the hex colours
  and the red arrows are inside the screenshots, or are shapes drawn over them. No parser reads
  those; a vision model does, from a picture of the slide that still shows the arrows.

So the tool parses first, deterministically, in the Chrome it already drives (pdf.js vendored,
no npm dependency), and writes one plain report the assistant reads instead of the PDF: per page,
the text in reading order, the recognised facts (criterion, WCAG, status, date, section), a
picture of the whole page, and each embedded picture on its own. The assistant's job shrinks to
what only it can do — say which element the tester means and what is wrong with it — and the tool
checks its answer against the parse (the page exists, the quote is on it) and logs every
correction. Nothing about the parse depends on the tester's template: the recognisers add fields
when a pattern is there and add nothing when it is not. The flow after the read is unchanged,
except that a finding the tester marked fixed and the deployed site still has is a regression
and is planned as one.

## The parsed report (the contract)

`<work>/manual/<id>/parsed/` holds:

```
manifest.json                 everything below, as data (the UI and the tests read this)
report.md                     the one file the prompt points at
pages/page-02.png             each page rendered, 1600 px wide (aspect kept), shapes and arrows included
pages/page-02-image-1.png     each embedded picture on its own, as embedded (no overlays)
```

`report.md`, for the slide at page 12 of Joel's report, is exactly:

```
## Page 12 of 13
Section: Outstanding Issues
Status: open — "Still an issue – 9/28/26" (2026-09-28)
Criterion: 13.A 1.4.1-color-meaning (WCAG 1.4.1)
Picture of the page: pages/page-12.png
Pictures on the page: pages/page-12-image-1.png (1402×616, at 2–99% across, 14–89% down)

Text, in reading order:
> 13.A Color is not used as the only visual means of conveying information, indicating an
> action, prompting a response, or distinguishing a visual element. - 1.4.1-color-meaning
> Still an issue – 9/28/26
```

The header of `report.md` says what the file is in four lines (the PDF's name, the page count,
how many pages have text and pictures, and that pages 1 and 11 are section dividers), then one
`## Page N of M` block per page. A line is left out when there is nothing to put in it (no
`Section:` before the first divider, no `Status:` when no verdict was recognised, no `Criterion:`
when none was). The text block is every text line of the page, in reading order, quoted with
`> `, hyphenation at line ends joined, runs of whitespace collapsed, nothing else changed — so a
quote the assistant gives can be matched against it. A page with no text says `Text: none (a
picture only)`.

`manifest.json`: `{ file, pages: M, parsedAt, pdfjs: '<version>', dividers: [1, 11], pages: [{
n, width, height, section, status: { value: 'fixed'|'open', words, date }|null, criteria: [{ id,
name, wcag, source: 'catalog'|'text' }], wcag: ['1.4.1'], text: [{ text, x, y, w, h, size, bold
}], lines: ['...'], images: [{ file, width, height, x, y, w, h }], picture: 'pages/page-12.png',
truncated: false }], notes: [] }`. Positions are fractions of the page (0–1). `notes` holds the
sentences the parse wants shown ("Stopped after 300 pages; the PDF has 412.").

## Acceptance criteria

1. **The parse, in the tool's own Chrome, with no npm dependency.** `src/pdf-parse.mjs` exports
   `parsePdf({ file, outDir, chromePath?, log })`. It launches a headless Chrome (`launchChrome`,
   src/chrome.mjs:125), serves pdf.js and the PDF from a one-shot `http.Server` on 127.0.0.1
   (random port, closed when done; no `file://`, no network beyond localhost), opens one page,
   and runs the parse in the page with the vendored build at `src/vendor/pdfjs/` (`pdf.mjs`,
   `pdf.worker.mjs`, `cmaps/`, `standard_fonts/`, `LICENSE` Apache-2.0, `VERSION` with the pinned
   version). Results come back over CDP: the text and manifest as JSON, each PNG as base64. The
   README's "no dependencies" stays true and says so in one clause ("pdf.js is vendored under
   `src/vendor/`, so nothing is installed"). `package.json` "files" already ships `src`. The parse
   is deterministic: the same PDF gives byte-identical `manifest.json` (minus `parsedAt`) and
   `report.md` on two runs, and the PNGs have the same dimensions.

2. **Text in reading order.** Text items are grouped into lines (same baseline within half the
   font size), lines into blocks (vertical gap under 1.5× the size, left edges within 2% of the
   width), blocks ordered top-to-bottom and, when two blocks overlap vertically, left-to-right —
   so a two-column slide reads column by column, a title before its body, and a caption after its
   picture. Bold is read from the font name (`Bold`, `Black`, `Semibold`, weight ≥ 600). A word
   split by a line-end hyphen is joined; `fi`/`fl` ligatures and non-breaking spaces are
   normalised; en and em dashes are kept. Rotated text (±90°) is kept in its own block at the end
   of the page with `(rotated)`.

3. **Pictures.** The page picture is the page rendered by pdf.js at 1600 px wide (`pages/
   page-NN.png`), so shapes, arrows and callout boxes drawn over a screenshot are in it. Each
   embedded image (an image XObject painted on the page, including inline images) is decoded and
   written as it is embedded (`pages/page-NN-image-K.png`, K in paint order), with its painted
   box as fractions of the page; images smaller than 32×32 px, images painted more than once
   (bullets, logos repeated on every page: the same XObject on 3 or more pages) and images past
   the 20th on a page are skipped and counted in the page's `images.skipped`. An image that
   cannot be decoded (an unsupported filter) is skipped with its reason in `notes`; the page
   picture still shows it.

4. **Recognisers — optional, template-free, never required.** On each page's lines:
   - **Criterion:** a line that starts with a Trusted Tester id (`^\d{1,2}\.[A-Z]\b`) gives
     `criteria[]` with `id`, `name` and `wcag` from `src/checks/catalog.mjs` when the id is known
     (`source: 'catalog'`), else the rest of the line as `name` (`source: 'text'`). Any
     `\b[1-4]\.\d{1,2}\.\d{1,2}\b` elsewhere on the page goes into `wcag[]`.
   - **Status:** the first line that matches, case-insensitively, `verified fixed|fixed|resolved|
     closed|passed|pass|remediated|no longer an issue` → `fixed`, or `still an issue|not fixed|
     open|outstanding|fails|failed|fail|remains|unresolved|regressed` → `open`; a date on the same
     line (`m/d/yy`, `m/d/yyyy`, `yyyy-mm-dd`, `Month d, yyyy`) is normalised to ISO. The matched
     words are kept verbatim (`words`). A line that is itself the criterion's description (e.g.
     "...have sufficient contrast") never counts: the status line must be short (≤ 8 words besides
     the date).
   - **Section dividers:** a page whose text is one block of at most 6 words, with no picture and
     no criterion, is a divider; its words are the `section` of every following page until the
     next divider, and the divider page itself has `section` equal to its words with `divider:
     true`. A page in a section whose words match the status patterns (Resolved → fixed,
     Outstanding / Open → open) and that has no status line of its own takes the section's status
     with `source: 'section'`.
   None of this changes the text block; it only adds lines above it.

5. **The prompt reads the report, not the PDF.** `manualReadPrompt` points at `report.md` first
   and describes it in five lines: one block per page; `Status:` and `Criterion:` are facts the
   tool read, copy them; `Picture of the page:` is what the tester saw, look at it whenever the
   text does not name the element (callouts, ANDI output, colours and arrows live there);
   `Pictures on the page:` are the raw screenshots; the quoted text is what quotes must come from,
   verbatim. The PDF itself is named last, as "the original, only if the report is not enough".
   Each finding gains `pages: [12]` (every page about it, in order; `page` stays as the first),
   `status: 'fixed'|'open'|null` (copied from the report when given) and `criterion: '13.A'|null`.
   The prompt says: one finding per distinct problem, and a problem shown on several pages (five
   slides of unlabelled fields on one form) is one finding with all its pages — unless the pages
   name different elements, when each gets its own. The fake agent (`test/fake-agent.mjs`) stops
   reading the PDF's bytes and reads `report.md`: its findings come from the report's text lines
   (the `FINDING ...` convention in the fixture moves into the slide text), its `pages` from the
   `## Page` headings, its `status` from the `Status:` lines. A read that fails is unchanged
   (asked again, then the explained ending).

6. **The tool checks the answer against the parse and says what it changed.** For each finding:
   every page in `pages` must be `1..M` (others dropped; none left → the finding is dropped with
   a `read / tool / dropped` decision); the quote must occur, whitespace-insensitively and
   case-insensitively, in the text of one of its pages — when it is on another page instead,
   `pages` is corrected to that page (decision `read / tool / moved to page 7`, reason: "the quote
   is on page 7, not page 6"); when it is on no page the finding keeps its pages and gets
   `quoteVerified: false` (decision logged, the finding stays). `status` and `criterion` that
   disagree with the report's recognised values are replaced by the report's (decision logged
   with both). When the report has a status for a page and the assistant gave none, the report's
   is used silently. `findings.json` holds the corrected findings and, per finding, `verified: {
   pages, quote }`.

7. **A finding the tester marked fixed is checked, and a return is planned.** The deployed check
   (manual-findings AC3) runs on every finding regardless of its status. Then: `status: fixed` +
   `gone` → the already-fixed report, its row saying "The tester verified this fixed on 28 Sep
   2026; the deployed site agrees." `status: fixed` + `present` → the plan, the item headed "Came
   back: the tester verified this fixed on 28 Sep 2026, but the deployed site has it again" (also
   in the finding's decisions and in `decisions.md`). `status: open` or none → as today. The
   already-fixed report and the Done summary count the three cases separately ("4 were already
   fixed (3 of them the tester had verified); 1 had come back").

8. **A PDF with no text still works; a PDF that cannot be opened stops with a sentence.** When no
   page has a text layer (a scan), `report.md` says so in its header and every page is `Text:
   none (a picture only)`; the read goes ahead on the page pictures, the step saying "The PDF has
   no text; the assistant is working from the pictures of its 13 pages." When pdf.js cannot open
   the file (encrypted with a password, truncated, not a PDF inside), the run ends before any
   assistant call: "The PDF could not be opened: <pdf.js's reason, in plain words>. Choose another
   PDF." with **Choose another PDF**, and the decision log records it. Limits: pages beyond
   `A11Y_508_PDF_MAX_PAGES` (default 300) are not parsed and the header says "Stopped after 300
   pages; the PDF has 412."; the parse as a whole has a time limit of 5 minutes, after which what
   is parsed is used and the header says which pages are missing.

9. **The dashboard shows the parse.** While parsing, the sentence is "Reading the PDF: 13 pages
   (11 with pictures)." (the count from the first pass, before rendering). When read, **Show the
   parsed report** (a link beside **Show decisions**) opens a pane with `report.md` rendered —
   each page's picture shown inline below its text, each embedded picture as a thumbnail — served
   from `GET /api/manual/:id/parsed/<path>` (path validated: `report.md`, `manifest.json`,
   `pages/<name>.png` only). Each plan item, already-fixed row and Done row shows the page picture
   as a thumbnail beside the before screenshot (click: full size), and the **PDF page N** link
   stays. The decision log's read corrections appear under "Decisions so far" as today.

10. **A CLI and a standalone check.** `a11y-508 pdf <file> [--out <dir>] [--chrome <path>]`
    parses one PDF into `<dir>` (default `./<file-name>.parsed/`) and prints the header of
    `report.md` plus one line per page (`page 12: open, 13.A, 1 picture, 2 lines`). It needs no
    repository and no config. The README's PDF subsection gets two sentences on it and on the
    parsed report.

11. **Fixtures that look like the real thing, without the real thing.** `test/fixtures/manual/
    make-pdf.mjs` gains a generator for a PowerPoint-style deck: landscape pages; divider pages
    ("Resolved Issues", "Outstanding Issues"); per slide a bold criterion line with a Trusted
    Tester id, an embedded JPEG (DCT, a small generated screenshot with distinct colour patches so
    the tests can tell it apart), a red stroked rectangle and a filled callout box with text drawn
    over the image, a verdict line with an en dash and a `m/d/yy` date, and one two-column slide;
    one slide with a rotated label; one page-only-picture deck (no text, 2 pages); one encrypted
    PDF (RC4 with a user password; a few hundred bytes); one PDF truncated mid-xref. The real
    report is not committed (it shows a government application); the builder runs the CLI on it
    by hand if a copy is on the machine and notes the result in the PR.

## How this fails silently

1. **(a) Reading order breaks.** Mutation: sort text items by x then y. Red: the two-column
   fixture's `lines` must read left column top-to-bottom, then right; the title must be line 1 on
   every slide; the verdict must be the last line.
2. **(b) The page picture loses the drawn shapes.** Mutation: use the first embedded image as the
   page picture. Red: at the fixture's red rectangle a sampled pixel of `page-02.png` is red
   (r > 200, g < 80, b < 80) and the same spot of `page-02-image-1.png` is the screenshot's
   colour; the callout's words are in no `lines[]` of the page (they are drawn, not text) but
   the picture's pixels at the callout box are the box's fill colour.
3. **(c) The answer is not checked.** Mutation: skip AC6. Red: with `FAKE_MANUAL_WRONG_PAGE=1`
   (the fake agent gives page 6 for a quote that is on page 7, and `pages: [99]` for another),
   `findings.json` has the first on page 7 and the second dropped, and `decisions.ndjson` has
   `moved to page 7` and `dropped`.
4. **(d) A verdict is not recognised, or a description is.** Mutation: ASCII hyphen only in the
   date pattern / drop the ≤ 8-word rule. Red: "Still an issue – 9/28/26" → `open`, `2026-09-28`;
   "Verified fixed – 9/28/2026" → `fixed`; the 13.C slide whose title ends "have sufficient
   contrast" has no status from its title (its status comes from the verdict line); a slide with
   no verdict line under "Resolved Issues" has `fixed` with `source: 'section'`.
5. **(e) The prompt stops pointing at the report.** Mutation: name only the PDF. Red: the fake
   agent asserts `report.md` and `pages/page-02.png` are in the prompt and reads the report; the
   prompt file's text contains `parsed/report.md` before `source.pdf`.
6. **(f) A regression is filed as already fixed.** Mutation: `status: fixed` → already-fixed
   regardless. Red: the fixture deck's "Verified fixed" finding whose issue the fixture site still
   has appears in the plan headed "Came back", not in Already fixed; the Done sentence counts it
   as "had come back".
7. **(g) A scan stops the run.** Mutation: end the run when no text is found. Red: the
   picture-only deck reaches the plan (the fake agent reads the `## Page` headings and the picture
   lines) and the step said "The PDF has no text".
8. **(h) A broken PDF reaches the assistant.** Mutation: call the assistant anyway. Red: with the
   encrypted and the truncated fixtures, no `agent-read-*.log` exists, the sentence starts "The
   PDF could not be opened", the button reads **Choose another PDF**.
9. **(i) The parse is not deterministic.** Mutation: include `Date.now()` in an image name. Red:
   parse the deck twice into two folders; `report.md` identical, `manifest.json` identical with
   `parsedAt` removed.
10. **(j) The caps are ignored.** Mutation: ignore `A11Y_508_PDF_MAX_PAGES`. Red: with it set to
    3 on the 13-page deck, 3 page pictures exist and the header says "Stopped after 3 pages; the
    PDF has 13."
11. **(k) The served paths are open.** Mutation: no path validation. Red: `GET /api/manual/<id>/
    parsed/../source.pdf` and `.../parsed/%2e%2e/decisions.ndjson` are 404; `parsed/report.md`
    is 200 (server unit test).
12. **(l) The vendored build is gone or unpinned.** Red: a unit test asserts `src/vendor/pdfjs/
    VERSION` matches the version string pdf.js reports, and `LICENSE` exists.

## Non-goals

- No OCR, no reading of what is inside a screenshot by the tool, no template-specific parser
  (the recognisers are the only pattern knowledge, and each is optional).
- No .pptx, .docx or image input; the PDF only.
- No change to the check, plan, confirm, fix, verify or replan prompts beyond carrying `pages`,
  `status` and `criterion` through and the "Came back" wording.
- No network: pdf.js is vendored, never fetched. No native module, no `npm install` for the core.
- The parsed folder lives in the tool's work folder; nothing from it is committed to the app.

## Where things live (for the builder)

Core: new `src/pdf-parse.mjs` (the parse, the one-shot server, the recognisers, `report.md` and
`manifest.json` writers — the recognisers and the reading-order grouping as pure functions so
the node tests cover them without Chrome), `src/vendor/pdfjs/` (download the pinned release's
`build/pdf.mjs`, `build/pdf.worker.mjs`, `web/cmaps/`, `web/standard_fonts/`; record the version
and the LICENSE), `src/chrome.mjs` `launchChrome` 125 / `findChrome` 42, `src/cdp.mjs`,
`src/checks/catalog.mjs` (ids → name, wcag), `src/manual.mjs` (read stage 348-395: parse before
`readOnce`, the checks of AC6 after it; check/plan/already-fixed for AC7 — `check.json`,
`already-fixed.md`, the `done` event 798-803; stage names `parse`, `parse-failed`), `src/agent.mjs`
`manualReadPrompt` 466-500 (and the `pages`/`status`/`criterion` fields through the later
prompts), `src/cli.mjs` (`pdf` command beside `manual`). Server: `ui/server/app.mjs` `manualApi`
923 (`/api/manual/:id/parsed/<path>`), the manual `startRun`. UI: `ui/app/screens/home.ts`
(sentence for `parse`, the link beside Show decisions 57-58, `readFailed`/`parseFailed` ending),
`ui/app/screens/manual-panel.ts` (thumbnails in the item/row templates 31, 52, 69, 108; `page()`
294), `ui/app/core/manual.ts` (`applyManual` for the new stages and fields), a new
`ui/app/shared/parsed-report-pane.ts` like `decisions-pane.ts`. Tests: `test/pdf-parse.mjs`
(node: recognisers, grouping, determinism, caps, the broken PDFs; added to `npm test`),
`ui/e2e/manual.spec.ts` (the flow with the deck fixture; helpers 29-75), `ui/e2e/harness.ts`,
`test/fake-agent.mjs` `manual-read` 122-145 (reads `report.md`; `FAKE_MANUAL_WRONG_PAGE`),
`test/fixtures/manual/make-pdf.mjs` (the deck generator: JPEG via a tiny baseline encoder or a
checked-in 64×64 JPEG embedded as DCTDecode; RC4 encryption per PDF 1.4 §3.5), `ui/server/test/`
(path validation), `test/event-schema.mjs` (new stages). Branch off main after
`assistant-calls` (PR in flight) is merged; if it is not, merge main into the branch before the
PR. Rebuild `ui/dist` with Node 22 before each spec run; `freshness` must pass. Local gate:
`npm --prefix ui run typecheck && npm --prefix ui test && npm test && npm --prefix ui run e2e`.
