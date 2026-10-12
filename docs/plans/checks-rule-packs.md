# Checks, round 4a: the rule packs

branch: checks-rule-packs
slug: checks-rule-packs

Written 2026-10-12, from [docs/research/axe-and-ibm-comparison.md](../research/axe-and-ibm-comparison.md)
section 1 (the non-ARIA rows), sections 2.11–2.14, and items 9–11 and 14 of
section 4, plus three follow-ups the round-3 verifier deferred (PR #8).
Rounds 1–3 are merged (`checks-false-positives.md`, `checks-foundations.md`,
`checks-aria.md`). Round 4b (the beyond-508 profile: WCAG 2.1/2.2 rules,
axe's remaining best practices, IBM's stricter thresholds) and round 5
(shadow DOM and iframes) follow.

## Intent

With the foundations and the ARIA model in place, what remains of axe's and
IBM's Section 508-relevant rules is a set of small, independent checks:
images and objects, forms, frames, scrolling regions, tables, language
codes, and skip links. Each is a few dozen lines on top of what exists.
After this round, every rule in section 1 of the research that fits the
architecture is implemented, except the WCAG 2.1/2.2 ones, which are a
profile of their own in round 4b.

The techniques are informed by axe-core (MPL-2.0) and IBM Equal Access
(Apache-2.0); no code is copied, nothing vendored; the ISO 639-1 table is
built from the ISO/IANA list (facts), not from either package. MIT, zero
dependencies.

## The change

### Pack A: images, objects, the hidden page (`10-images.js`, `00-core.js`)

1. **The page is hidden from assistive technology** (critical, filed under
   4.A with a message that says every other test is silenced): `<body
   aria-hidden="true">`, or an element that is `aria-hidden="true"` (or
   `inert`) and contains most of the page's visible text (≥ 80% of the
   characters of visible text nodes) while no modal dialog is open; the
   message names the element and says a modal library probably left it
   behind.
2. **`img[ismap]`** (4.A violation): a server-side image map cannot be
   operated from the keyboard; suggest `usemap`.
3. **`<object data>` with no text alternative** (7.A violation) for every
   loaded `object`, not only image types: no text content, no
   `aria-label`/`aria-labelledby`, no `title`.
4. **Redundant alt** (7.A review): an image whose `alt` equals (after
   whitespace and case normalisation) the visible text of its enclosing
   link or button, so the name is read twice; suggest `alt=""`.
5. **Round-3 follow-up: unnamed `svg[role=img]` or `[role=img]` inside a
   named link or button** is a 7.A review item suggesting `aria-hidden`
   (the control already has a name), not a serious violation; outside a
   named control it stays a violation.

### Pack B: forms (`20-forms.js`)

6. **Multiple visible labels** (5.C review): a field with more than one
   visible `<label>` (explicit `for` plus a wrapping one, or two `for`s)
   and no `aria-labelledby` choosing one; the message lists the labels.
7. **Checkbox groups** (5.C review): two or more checkboxes with the same
   `name` (or adjacent in one container) with no group label (`fieldset`
   with `legend`, or `role=group` with a name); radios already have this.
8. **`fieldset` structure** (5.C violation): a `fieldset` with no
   `legend`, a `legend` that is not its first element child, or more than
   one `legend`; an empty `legend`.

### Pack C: frames (`50-lang-titles.js`, `87-aria-keyboard.js`)

9. **Duplicate frame titles** (12.D violation): two or more `iframe`s with
   the same normalised `title`.
10. **Focusable content behind `iframe[tabindex="-1"]`** (4.A violation,
    same-origin only): the frame's document has tabbable elements; frames
    smaller than 30×15 px and frames behind an open modal are skipped;
    cross-origin frames are skipped silently.

### Pack D: scrolling regions (`87-aria-keyboard.js`)

11. **Scrollable region with nothing focusable** (4.A review): an element
    with `overflow: auto|scroll` whose scroll size exceeds its client size
    on an axis, with content outside its box, and neither it nor a
    descendant tabbable. Review, because Chrome ≥ 130 makes such regions
    keyboard-focusable; the message says keyboard users on other browsers
    cannot reach the content.

### Pack E: tables (`70-tables.js`)

12. **Data or layout** (14.A): classify each table before escalating:
    *data* if it has a caption, `thead`, `tfoot`, `colgroup`, `summary`,
    any `th`, `scope`, `headers`, `abbr`, header roles, `role=grid|table`,
    or is `contenteditable`; *layout* if it nests another table, has fewer
    than two rows, its middle row is one cell, is wider than 95% of the
    viewport, or has fewer than ten cells; otherwise *data* if ≥ 5 columns,
    visible cell borders, alternating row backgrounds, or ≥ 20 rows, else
    *unsure*. Only *data* and *unsure* tables are escalated under 14.A;
    the message states the classification.
13. **Header relationships** (14.B): `scope` values other than `row`,
    `col`, `rowgroup`, `colgroup` (violation); a `th` that labels no data
    cell (review); a `td` in a data table of ≥ 3×3 with no row or column
    header by the cell grid, spans included (violation); a first row that
    is one full-width cell acting as a caption (review, suggest
    `<caption>`); `caption` text equal to `summary` (review).

### Pack F: language (`50-lang-titles.js`)

14. **Primary language subtag** (11.A violation on `html`, 11.B on inner
    elements): the primary subtag must be a two-letter ISO 639-1 code or a
    three-letter ISO 639-2/3 code that has no two-letter equivalent (a
    three-letter code with a two-letter equivalent is a review item naming
    it). `jp`, `cn`, `gr`, `ua`, `dk`, `us` are therefore reported, with
    the likely intended code in the message where it is obvious (`jp` →
    `ja`, `cn` → `zh`, `gr` → `el`, `ua` → `uk`, `dk` → `da`). The table
    lives in a new `src/checks/browser/06-lang-data.js` (ISO 639-1, ~185
    codes, plus the three-to-two map), built from the ISO/IANA list.
15. Inner `lang` attributes are checked only on elements that contain
    text; an empty element with a bad `lang` is not reported.

### Pack G: skip links (`40-structure.js`)

16. **Bypass that works** (9.A): a skip link counts only if it is visible
    to assistive technology and, when it is visually hidden, becomes
    visible on focus (the keyboard pass already records focus; the static
    check accepts a `:focus`/`:focus-within` style that un-hides it, or
    the Tab pass's observation); its target must exist and be visible to
    assistive technology. A `display: none` skip link, or a target inside
    a closed `details`/hidden panel, does not satisfy 9.A and is reported
    with the reason.

### Round-3 follow-ups (`88-aria-structure.js`, `ui/app/`)

17. **A link inside `<summary>`** is a 6.A review item, not a serious
    violation, because Chrome does not make `summary`'s children
    presentational the way it does a `button`'s; the model marks `summary`
    accordingly.
18. **The dashboard's fix-loop `remedy-command` regions** get unique
    accessible names (the remedy's id or index), so the landmark-
    uniqueness rule has nothing to report on the dashboard; `ui/dist`
    rebuilt.

### Fixtures, golden, README

One fixture page per pack under `test/fixtures/checks-pack-*.html`
(packs E and F may need two), linked from `about.html`, assertions in
`test/run.mjs`, built and mutation-tested with `--only`. A same-origin
`iframe` fixture page serves as the frame content. The golden is
regenerated once on the final tree and its diff annotated line by line in
the PR body. The README "What it checks" rows for 4.A, 5.C, 7.A, 9.A, 11.A,
11.B, 12.D, 14.A and 14.B are updated.

## What must not move

- Zero dependencies; Node 18; CLI flags, exit codes, `report.json` shape
  (new fields additive).
- Findings on existing fixture pages that this plan does not name stay as
  they are; the golden diff holds only explained lines. In particular the
  existing 14.A escalations on `tables.html` must be re-examined: a table
  that becomes *layout* under rule 12 and stops being escalated is an
  explained change, listed in the PR.
- No table copied from axe-core or IBM; `06-lang-data.js` cites its
  source.
- The dashboard suites and the self-audit stay green on every CI job.

## Acceptance criteria

1. `<body aria-hidden="true">` is a critical finding; a page whose main
   wrapper is `aria-hidden="true"` with no open modal is a critical
   finding naming the wrapper; the same wrapper while a modal dialog is
   open is not reported.
2. `<img ismap>` inside a link is a 4.A violation; `<object data="x.svg">`
   with no fallback text is a 7.A violation and one with text is not; an
   image whose alt repeats its link's text is a 7.A review item and one
   with `alt=""` there is not.
3. An unnamed `<svg role="img">` inside `<a href>Home</a>` is a 7.A review
   item; the same svg standing alone is a 7.A violation.
4. A field with two visible labels and no `aria-labelledby` is a 5.C
   review item listing both; with `aria-labelledby` choosing one it is
   not reported; a group of three same-name checkboxes with no group
   label is a 5.C review item, and inside a `fieldset` with a `legend` it
   is not; a `fieldset` without a `legend`, one with two, and one whose
   `legend` is not first are each a 5.C violation.
5. Two `iframe`s titled "Content" are a 12.D violation; an
   `iframe[tabindex="-1"]` whose same-origin document has a link is a 4.A
   violation; the same frame at 20×10 px, and a cross-origin frame, are
   not reported.
6. A 200 px tall `overflow: auto` div holding 600 px of plain text is a
   4.A review item; the same div with `tabindex="0"`, or holding a link,
   is not reported.
7. A header-less table that nests another table, and a header-less
   table wider than 95% of the viewport with fewer than ten cells, are
   classified *layout* and not escalated under 14.A; a bordered
   header-less table with five columns is classified *data* and is;
   a 3×3 table of `td`s with `th` present but one data cell with no
   header is a 14.B violation; `scope="column"` is a violation; a first
   row that is one `colspan` cell is a review item suggesting a caption.
8. `lang="jp"` on `html` is an 11.A violation whose message mentions
   `ja`; `lang="en-US"`, `lang="zh-Hant"` and `lang="haw"` are not
   reported; `<span lang="fra">` with text is an 11.B review item naming
   `fr`; `<span lang="xx"></span>` (empty) is not reported; `<span
   lang="xx">text</span>` is.
9. A `display: none` skip link to `#main` is reported under 9.A with the
   reason; a visually hidden skip link with a `:focus` style that reveals
   it satisfies 9.A; a skip link whose target is inside a closed
   `<details>` is reported.
10. `<summary><a href>…</a></summary>` is a 6.A review item, not a
    violation; `<button><a href>` stays a violation.
11. The dashboard self-audit shows no landmark-uniqueness item for the
    fix-loop screen's remedies (assert in the self-audit spec that no 9.A
    review names `remedy-command`).
12. The golden diff holds only explained lines; findings on existing
    fixture pages are unchanged except the 14.A reclassifications listed
    in the PR; all CI jobs green; local full suite passes on the final
    commit.

## How this fails silently, and what is written to catch it

1. *Mutation*: the hidden-page rule ignores `inert`/`aria-hidden` on
   wrappers and checks only `body`. AC 1's wrapper case turns red.
2. *Mutation*: the rule fires even when a modal is open. AC 1's modal
   case turns red.
3. *Mutation*: `object` check limited to image types again. AC 2 turns
   red.
4. *Mutation*: redundant-alt compares raw strings (no normalisation). AC
   2's review case turns red when the fixture's alt differs by case.
5. *Mutation*: svg-in-named-control still a violation. AC 3 turns red.
6. *Mutation*: multiple-labels ignores `aria-labelledby`. AC 4's second
   case turns red (false positive).
7. *Mutation*: checkbox-group rule ignores `fieldset`/`legend`. AC 4
   turns red.
8. *Mutation*: frame-title duplicates compared without normalisation.
   AC 5 turns red when titles differ by whitespace.
9. *Mutation*: the frame-content rule skips the size check. AC 5's 20×10
   case turns red.
10. *Mutation*: scrollable rule ignores tabbable descendants. AC 6's link
    case turns red.
11. *Mutation*: every table classified *data*. AC 7's layout case turns
    red.
12. *Mutation*: `td` header lookup ignores spans. AC 7's 14.B case turns
    red (a spanned header no longer covers the cell, or covers it
    wrongly; the fixture includes a `colspan` header).
13. *Mutation*: the ISO table check skipped (syntax regex only). AC 8
    turns red on `jp`.
14. *Mutation*: three-letter codes with two-letter equivalents accepted
    silently. AC 8's `fra` case turns red.
15. *Mutation*: inner `lang` checked on empty elements. AC 8's empty case
    turns red.
16. *Mutation*: skip-link visibility ignored. AC 9 turns red.
17. *Mutation*: `summary` treated like `button`. AC 10 turns red.
18. *Mutation*: remedy regions share a name again. AC 11 turns red.
19. *Mutation*: one unrelated golden line edited. AC 12 turns red.

## Order of work

1. Packs F and E (data tables and language need the most fixture care),
   then A, B, C, D, G, then the follow-ups 17–18.
2. Golden, README, the self-audit, full suites, PR; watch CI on all jobs.

## Non-goals

- The beyond-508 profile: WCAG 2.1/2.2 rules (`autocomplete`, target
  size, label-in-name, inline spacing, orientation lock, focus not
  obscured, reflow), axe's remaining best practices, IBM's CJK thresholds
  and opacity rule (round 4b).
- Shadow DOM and cross-document traversal beyond same-origin iframe
  contents for rule 10 (round 5).
