# Screenshots in: paste or pick screenshots, say what is wrong in each, and the run goes on as from a PDF

slug: screenshots-in
branch: screenshots-in

## Intent

Joel, 2026-10-18: "someone gave me screenshots alone, can we somehow use those? … would it also be
able to capture a screenshot from the paste buffer — Windows and macOS allow you to capture a
region of a screen into a paste buffer." Today the manual flow starts from a PDF only. A person
with screenshots has to make a PDF first, and a picture-only PDF carries none of their words.

After this change the home screen takes screenshots directly: pasted from the clipboard (Win+Shift+S
or Cmd+Ctrl+Shift+4, then Ctrl+V / Cmd+V on the dashboard), picked as files, or dropped in; each
with a one-line note of what is wrong in it. The tool turns them into the same parsed report the
PDF flow produces — one page per screenshot, the note as the page's text — and from the read stage
on nothing changes: the tool lists one finding per screenshot, the assistant says what each shows
and where it is, the deployed site is checked, the plan is reviewed and approved, the fixes are
made and confirmed. Nothing in the later stages learns a new input; they see pages and pictures as
they do now, and the words "PDF page N" become "Screenshot N" where the input was screenshots.

## Acceptance criteria

1. **Screenshots on the home screen.** Beside **Choose a PDF** sits **Add screenshots** (a button
   that opens a file picker for several PNG/JPEG/WebP files) and a drop area that also says "or
   paste one: Ctrl+V / Cmd+V". A paste on the dashboard (`paste` event with an image item in
   `clipboardData`) adds the image; a drop adds the files; the picker adds the files. Each added
   screenshot is a row: a thumbnail, a text box "What is wrong here" (one line, optional, ≤ 300
   characters), **Remove**, and the order they were added (the first is Screenshot 1). The rows
   live in the page until **Fix these N screenshots** is pressed; a reload keeps nothing (plain
   browser state). A paste that is not an image, or a file that is not PNG/JPEG/WebP by its bytes,
   is refused with one sentence. Limits: 40 screenshots, 10 MB each, said in the sentence.

2. **The upload makes the run.** **Fix these N screenshots** sends `POST /api/manual/screenshots`
   (multipart: the images in order as `shot`, the notes as a JSON field `notes: ["…", …]`). The
   server checks each image's magic bytes and size, makes the run folder as the PDF upload does,
   writes `shots/NN.<ext>` and `notes.json`, writes the parsed report itself (AC 3) and starts the
   run of kind `manual` with `source: 'screenshots'` — no `source.pdf`, no parse stage. The run's
   record and `state.json` carry `source`. The existing PDF upload is unchanged.

3. **The parsed report from screenshots.** `src/screenshots.mjs` exports `parseScreenshots({ shots,
   notes, outDir })` and writes the same files `pdf-parse` does: `pages/page-NN.png` (the image,
   re-encoded to PNG at most 1600 px wide through the tool's Chrome, as the PDF parse renders
   pages), `manifest.json` (`pageCount`, pages with `n`, `lines: [note]` or `[]`, `images: []`,
   `picture`, `criteria: []`, `status: null`, `divider: false`; plus `source: 'screenshots'`,
   `shots: [{ file, note }]`), and `report.md` whose header says "N screenshots, with a note on
   M of them" and whose page blocks read:

   ```
   ## Screenshot 3 of 7
   Picture of the page: pages/page-03.png
   Note from the person who took it:
   > The three filter buttons have no accessible name.
   ```

   or `Note: none (a picture only)`. The manifest is what `routeSources`, the candidates and the
   UI already read, so a screenshot run lists one candidate per screenshot with `quote` = the
   note, `status: null`, `criterion: null`.

4. **The prompts know they are screenshots.** `manualDescribePrompt` says, for a screenshot run,
   "A person took these screenshots of the application and wrote a note on each; the note is the
   tester's words, the picture is what they saw" (in place of the PDF sentence), and the candidate
   block is headed `## F3 — screenshot 3 — (no criterion) — status unknown`. The locate, check,
   plan and verify prompts are unchanged (they carry `quote`, `seen`, pictures).

5. **"Screenshot N" everywhere "PDF page N" was.** In the plan items, the already-fixed rows,
   could-not-be-checked rows, Done rows, the decisions pane and `decisions.md`, a screenshot run's
   link reads **Screenshot 3** and opens the image (`/api/manual/:id/parsed/pages/page-03.png`).
   The parsed-report pane's title is "The screenshots"; **Show the parsed report** reads
   **Show the screenshots**. The home-screen sentence during the read says "Reading 7 screenshots;
   asking the assistant what each shows." The PDF wording stays for PDF runs.

6. **CLI.** `a11y-508 manual <folder>` accepts a folder of images (PNG/JPEG/WebP, in name order)
   with an optional `notes.txt` (`<file name>: <note>` per line) and runs the same way; the
   README's PDF subsection gains two sentences on screenshots (paste, pick, note).

## How this fails silently

1. **(a) A paste adds nothing.** E2e: a synthetic `paste` event carrying a PNG `File`
   (`DataTransfer.items.add`) on the home screen adds a row with a thumbnail and a note box.
   Mutation: ignore the paste event → red.
2. **(b) A note is lost.** Mutation: drop `notes` on upload. Red: `report.md` has no "Note from
   the person" block, `candidates.json`'s F2 has an empty quote, and the describe prompt does not
   contain the note's words.
3. **(c) A non-image gets in.** Mutation: skip the magic-byte check. Red: a `.png` whose bytes are
   text is accepted; expected: refused with the sentence, no run.
4. **(d) The run parses a PDF that is not there.** Mutation: run the parse stage regardless. Red:
   a screenshot run ends "The PDF could not be opened"; expected: no `parse` stage event, the
   read stage starts within 5 s of the upload.
5. **(e) "PDF page" wording leaks.** Mutation: keep `PDF page` for all runs. Red: a screenshot
   run's plan item link reads "Screenshot 2" and its `href` ends `pages/page-02.png`;
   `decisions.md` says "Screenshot 2", never "PDF page".
6. **(f) Limits are not held.** Server unit test: 41 images → refused naming 40; an 11 MB image →
   refused naming 10 MB.
7. **(g) The order is lost.** Mutation: sort the uploads by name. Red: with files added as b.png,
   a.png, Screenshot 1 is b.png (the thumbnail's `data-shot` and `report.md`'s first block).
8. **(h) The CLI folder.** Node: a folder with two images and a `notes.txt` gives a manifest with
   two pages whose `lines` are the notes; a folder with no images exits 2 with "no screenshots".

## Non-goals

- No change to the parse of PDFs, to candidates, the check/locate/plan/fix/verify stages or their
  prompts beyond AC 4.
- No OCR of the screenshots, no automatic guess at a criterion; a screenshot with no note is a
  finding whose words are only what the assistant sees.
- No persistence of a half-built screenshot list across reloads.
- No mixing of a PDF and screenshots in one run.

## Where things live (for the builder)

`ui/app/screens/home.ts` (the PDF button ~52-53, `choosePdf` in `core/driver.ts` ~230: add
`addScreenshots`, the paste/drop handlers, the rows and `Fix these N screenshots`), a new
`ui/app/shared/screenshots-in.ts` component, `ui/server/app.mjs` `manualApi` (~923: the PDF
upload is the model; add the multipart route — `readRaw` exists; parse multipart by hand or
with a tiny boundary splitter, no dependency), `src/screenshots.mjs` (new; the PNG re-encode
through `launchChrome` as `src/pdf-parse.mjs` renders pages — reuse its page server and
screenshot code), `src/manual.mjs` (the parse stage ~655-700: skip when `state.source ===
'screenshots'`; `candidates` from the manifest unchanged; wording helpers for "Screenshot N"),
`src/agent.mjs` `manualDescribePrompt` (~518-570), `src/cli.mjs` (`manual <pdf|folder>`),
`ui/app/screens/manual-panel.ts` and `ui/app/shared/decisions-pane.ts` (`pdfPage()` →
`pageLink()` by source), `ui/app/shared/parsed-report-pane.ts`, `ui/app/core/manual.ts`.
Tests: `ui/e2e/manual.spec.ts` (helpers 29-75; a new `screenshots` describe block), `test/
fake-agent.mjs` (the describe reads `lines` as the quote already), `ui/server/test/`
(limits, magic bytes), `test/screenshots.mjs` (node, in `npm test`), `test/event-schema.mjs`.
Wait for any running `playwright test` on the machine to finish before running e2e (`pgrep -f
"playwright test"`), the full gate runs on main meanwhile. Rebuild `ui/dist` with Node 22 before
each spec run; `freshness` must pass. Local gate: `npm --prefix ui run typecheck && npm --prefix
ui test && npm test && npm --prefix ui run e2e`.
