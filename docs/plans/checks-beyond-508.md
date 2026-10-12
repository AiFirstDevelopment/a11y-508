# Checks, round 4b: beyond Section 508

branch: checks-beyond-508
slug: checks-beyond-508

Written 2026-10-12, from [docs/research/axe-and-ibm-comparison.md](../research/axe-and-ibm-comparison.md)
(the WCAG 2.1/2.2 row of section 1, the best-practice rules it mentions,
and the IBM choices sections 2.4 and 2.7 note as stricter than WCAG).
Rounds 1–4a are merged. Round 5 (shadow DOM and iframes) follows.

## Intent

Section 508 incorporates WCAG 2.0 AA, and the Trusted Tester gate must stay
exactly that. But a team that wants to go further should not need a second
tool: axe ships WCAG 2.1 and 2.2 rules and a set of best practices, and IBM
applies a few thresholds stricter than WCAG. This round adds all of those
as a **profile**, `--wcag 2.2` (alias `--beyond-508`), off by default. With
it on, the extra rules run and their findings count like any other
(violations fail the run at `--fail-on` impacts, reviews go to the review
list), each tagged with its WCAG criterion and listed under their own
heading in every output. Without it, nothing changes: the golden human
output and `report.json` for a default run are byte-identical to today's.

The techniques are informed by axe-core (MPL-2.0) and IBM Equal Access
(Apache-2.0); no code copied, nothing vendored; MIT, zero dependencies.

## The change

### The profile (`src/cli.mjs`, `src/checks/catalog.mjs`, `src/report.mjs`, `src/page.mjs`)

1. `--wcag <version>` accepts `2.0` (the default; the Trusted Tester
   catalog only) and `2.1` or `2.2`; `--beyond-508` is `--wcag 2.2`. The
   value is passed to the in-page checks as `A.opts.wcag` and recorded in
   `report.options.wcag`.
2. The catalog gains entries keyed by WCAG success criterion for the new
   rules (`1.3.4`, `1.3.5`, `1.4.10`, `1.4.11`, `1.4.12`, `2.4.11`, `2.5.3`,
   `2.5.8`, and `BP` entries for best practices), each with `wcag`,
   `level` (`2.1`/`2.2`/`best-practice`), `name`, `automation`, and a
   `beyond508: true` flag. `--list-tests` prints them after the Trusted
   Tester tests under a "Beyond Section 508" heading, with the version.
3. The summary table, `summary.md`, `report.html` and the dashboard's
   Report screen show these findings under a "Beyond Section 508 (WCAG
   2.2)" heading when the profile is on, and the coverage line says the
   profile was on. Findings carry `beyond508: true`.
4. The dashboard's Run form gains a checkbox "Also check WCAG 2.2 (beyond
   Section 508)" under *Advanced*, mapped to `--wcag 2.2`; the command
   line shown includes it; the Report screen's test filter lists the new
   tests under their heading.

### The rules (new `src/checks/browser/95-beyond-508.js`, plus passes)

5. **2.5.3 Label in name** (violation): for links, buttons and form
   controls with visible text, the accessible name must contain the
   visible text (after whitespace/case/punctuation normalisation); the
   message shows both strings.
6. **1.3.5 Identify input purpose** (violation): an `autocomplete`
   attribute whose tokens are not valid per the HTML autofill spec (the
   token grammar: optional `section-*`, optional `shipping`/`billing`,
   optional contact-type prefix for the contact fields, then one field
   name from the HTML list), or a field name used with the wrong control
   type (`autocomplete="email"` on a checkbox).
7. **2.5.8 Target size (minimum)** (violation, 2.2): a clickable target
   (link, button, input, element with a click listener per the listener
   probe) whose bounding box is smaller than 24×24 CSS px, unless the
   spacing exception holds (a 24 px circle centred on it intersects no
   other target), or it is inline within a sentence, or it is the
   browser's native control, or an equivalent larger target exists on the
   page (same href or same accessible name).
8. **1.4.12 Text spacing** (violation): inline `style` or stylesheet
   rules with `!important` on `line-height`, `letter-spacing` or
   `word-spacing` that would stop user overrides; and a reflow test
   applying WCAG's spacing values (`line-height: 1.5`, paragraph spacing
   2×, letter spacing 0.12 em, word spacing 0.16 em) in a pass that checks
   for clipped or overlapping text, like the zoom pass.
9. **1.3.4 Orientation** (review): a stylesheet rule under an
   `orientation` media query that hides content or applies a rotating
   transform.
10. **2.4.11 Focus not obscured (minimum)** (violation, 2.2): in the Tab
    pass, a focused element whose rect is entirely covered by fixed or
    sticky content (the existing "under a sticky header" detection is
    promoted to this criterion when the profile is on; partially covered
    stays a 4.D review).
11. **1.4.10 Reflow** (violation, 2.1): a pass that sets the viewport to
    320 CSS px wide (via `Emulation.setDeviceMetricsOverride`), reloads
    layout, and reports content that requires horizontal scrolling
    (`scrollWidth > 320` on the document, or elements extending past the
    viewport) except for content that legitimately needs two dimensions
    (tables, images, maps, `pre`). Restores the viewport afterwards, like
    the zoom pass.
12. **1.4.11 Non-text contrast** (review): the border or background of
    text inputs, checkboxes and buttons against the surrounding
    background below 3:1, and a focus indicator (from the Tab pass
    snapshot) whose changed colour is within 3:1 of the unfocused state.
13. **Best practices** (review, `BP`): `region` (visible content outside
    any landmark); `page-has-heading-one`; `aria-allowed-role` (a role
    not permitted on that element per ARIA in HTML, e.g. `role=button`
    on `<li>` without an inner element); `table-duplicate-name` (caption
    equals summary; already in 4a if done, else here); `empty-table-
    header`; `landmark-complementary-is-top-level` and friends already
    done in round 3; `meta-viewport-large` (maximum-scale < 5); `select-
    name`, `label-title-only` already covered; `tabindex` positive
    already covered; `accesskeys` duplicate already covered; `frame-
    tested` not applicable.
14. **IBM's stricter choices**, inside the profile: CJK large-text
    thresholds for 13.C (text whose characters are mostly CJK counts as
    large only at ≥ 29.3 px, or ≥ 24 px bold), reported as 13.C with a
    note; `opacity < 0.1` treated as visually hidden for focus visibility
    and name checks (round 2's visibility helper gains the rule under the
    profile).

### Round-4a follow-up (`10-images.js`, `00-core.js`)

15. **Older modals without `aria-modal`.** The hidden-page rule (round 4a,
    rule 1) treats "a modal is open" as `dialog:modal` or a visible
    `aria-modal="true"` dialog. Libraries that predate `aria-modal`
    (react-modal, older Bootstrap, jQuery UI) instead set
    `aria-hidden="true"` on the app root while a visible
    `role="dialog"`/`"alertdialog"` element sits beside it. That must
    count as an open modal too, for the hidden-page rule and for
    round 2's modal-on-load handling: a visible dialog-role element
    outside the hidden wrapper, or a visible element with `role=dialog`
    whose siblings are `aria-hidden`, is the open modal. The same holds
    for an off-canvas panel marked `aria-hidden` while a visible
    `role=dialog` drawer is open. This runs with and without the profile.

### Fixtures, golden, README

Fixture pages `test/fixtures/checks-beyond-*.html`, linked from
`about.html`; `test/run.mjs` gains a **second crawl** of the beyond fixture
pages with `--wcag 2.2` (narrowable with `--only`, which passes the flag
through when the page name starts with `checks-beyond-`), and asserts that
the default crawl reports none of the new tests. The golden is unchanged
except the coverage-warning link count. The README gains a "Beyond Section
508" section describing the profile and its rules, and the "What it
checks" table gains the rows.

## What must not move

- With the profile off: every finding, the golden human output (except
  the link count), `report.json` and exit codes are identical to today.
- Zero dependencies; Node 18; existing flags.
- The dashboard suites and the self-audit stay green on every CI job (the
  self-audit runs with the profile **on**, and the dashboard must pass its
  own WCAG 2.2 checks; fix the dashboard where it fails, say so in the PR).

## Acceptance criteria

1. `--list-tests` without the flag prints the Trusted Tester catalog only;
   with `--wcag 2.2` it adds the "Beyond Section 508" section; `--wcag
   2.1` lists the 2.1 rules only (not 2.5.8, 2.4.11); `--wcag 3` exits 2
   with a message.
2. A default crawl of the beyond fixture pages reports no `beyond508`
   finding; the same crawl with `--wcag 2.2` reports each rule's failing
   case and none of its passing cases (assert per rule, AC 3–12).
3. `<a href>Read more</a>` with `aria-label="Learn about pricing"` is a
   2.5.3 violation; `aria-label="Read more about pricing"` is not.
4. `<input autocomplete="e-mail">` is a 1.3.5 violation; `autocomplete=
   "shipping email"` and `"section-blue billing tel"` are not; `<input
   type="checkbox" autocomplete="email">` is.
5. A 16×16 icon button beside another is a 2.5.8 violation; the same
   button alone with 24 px of clear space around it is not; an inline
   link in a sentence is not.
6. `<p style="letter-spacing:0 !important">` is a 1.4.12 violation; a
   container that clips text under the spacing pass is reported with the
   clipped element; a page whose text reflows is not.
7. A stylesheet with `@media (orientation: portrait) { .app { transform:
   rotate(90deg) } }` is a 1.3.4 review item.
8. A page whose focused element lands fully under a fixed header during
   the Tab pass is a 2.4.11 violation with the profile on and a 4.D review
   without it.
9. A page with a 600 px wide fixed-width block is a 1.4.10 violation at
   320 px; a page with a wide `<table>` or `<pre>` is not; the viewport is
   restored (assert through the page's `passes.reflow.restored`).
10. A text input with a `#ddd` border on white is a 1.4.11 review item;
    one with a `#767676` border is not.
11. Visible text outside any landmark is a `BP` review item; a page with
    no `h1` is a `BP` review item; `<li role="button">` is a `BP` review
    item; a page with `maximum-scale=2` is a `BP` review item.
12. 20 px CJK text at 4:1 contrast is a 13.C violation with the profile
    on (not large) and not reported without it (large text at ≥ 18.66 px
    bold rule), with the fixture's hand computation; an element at
    `opacity: 0.05` receiving focus is a 4.D violation with the profile on.
13. The dashboard: the Advanced checkbox adds `--wcag 2.2` to the shown
    command and to the run; the Report screen groups the findings under
    the heading; the self-audit with the profile on passes.
14. The default golden diff holds only the link-count line; all CI jobs
    green; local full suite passes on the final commit.
15. A page whose app root is `aria-hidden="true"` beside a visible
    `<div role="dialog">` (no `aria-modal`) gets no hidden-page finding,
    and its `modalOnLoad` names that dialog; the same page with the
    dialog removed (root still hidden) is a critical hidden-page finding.

## How this fails silently, and what is written to catch it

1. *Mutation*: the profile is on by default. AC 2's default-crawl
   assertion turns red.
2. *Mutation*: 2.5.3 compares names case-sensitively. AC 3's passing case
   turns red (false positive).
3. *Mutation*: `autocomplete` validation accepts any token. AC 4 turns red.
4. *Mutation*: target size ignores the spacing exception. AC 5's spaced
   case turns red.
5. *Mutation*: target size ignores inline links. AC 5's sentence case turns
   red.
6. *Mutation*: the spacing pass does not apply letter spacing. AC 6's
   clipped case turns red.
7. *Mutation*: 2.4.11 reports partially covered focus. AC 8 turns red
   (the fixture's partially covered control).
8. *Mutation*: the reflow pass does not restore the viewport. AC 9 turns
   red on `restored`.
9. *Mutation*: reflow reports tables. AC 9's table case turns red.
10. *Mutation*: non-text contrast threshold 4.5. AC 10's `#767676` case
    turns red.
11. *Mutation*: the `region` rule counts text inside `header`/`footer` as
    outside landmarks. AC 11 turns red (false positive).
12. *Mutation*: CJK detection off. AC 12 turns red.
13. *Mutation*: the dashboard checkbox maps to no flag. AC 13 turns red.
14. *Mutation*: one unrelated golden line edited. AC 14 turns red.
15. *Mutation*: the open-modal test accepts only `dialog:modal` and
    `aria-modal="true"`. AC 15's first case turns red (false critical).

## Order of work

1. The flag, catalog, outputs (AC 1–2), with the `--only` pass-through.
2. Rules 5–7, 13 (static), then 8, 10, 11 (passes), then 12, 14.
3. Dashboard checkbox and heading, `ui/dist` rebuilt; self-audit with the
   profile on.
4. README, golden, full suites, PR; watch CI on all jobs.

## Non-goals

- Making any beyond-508 rule part of the default gate.
- Shadow DOM and iframes (round 5).
- WCAG 2.2's 3.2.6, 3.3.7, 3.3.8, 3.3.9 (consistent help, redundant entry,
  accessible authentication): judgement calls with no automatable rule in
  either tool.
