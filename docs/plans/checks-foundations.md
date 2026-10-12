# Checks, round 2: contrast that measures, names that match the browser, modals that don't hide the page

branch: checks-foundations
slug: checks-foundations

Written 2026-10-12, from [docs/research/axe-and-ibm-comparison.md](../research/axe-and-ibm-comparison.md)
sections 2.3, 2.7, 2.8 and items 12 and 13 of section 4, plus the two
follow-ups the round-1 verifier deferred (PR #4). Second of the rounds that
bring the checks level with axe-core and IBM Equal Access and then past
them; round 1 (`docs/plans/checks-false-positives.md`) is merged.

## Intent

Round 1 stopped the checks from crying wolf on common patterns. This round
fixes the two foundations that most findings rest on, and one coverage hole
round 1 opened.

Contrast today samples one point 8 px inside the element, falls back to DOM
ancestors below the fold, gives up on any background image, ignores text
shadows, and never looks at typed text or placeholders. axe samples every
line of text and says "uncertain" rather than failing when it cannot know
the background; IBM searches gradient stops for the worst case. After this
round, ours samples each line box where it is painted, scrolls to reach it,
bounds an unknown background instead of refusing, treats a halo shadow as
what it is, and checks input values and placeholders, which neither of them
does.

Names: a label that wraps a control reads the control's value, as the
browser does; a label hidden with `display: none` is not a visible label.

Modals: since round 1, content outside an open modal dialog is hidden from
every check, which is right for assistive technology and wrong for a crawl
that audits a page once: a cookie banner opened as a modal on load makes the
whole page look clean. This round makes the crawler dismiss a modal opened
on load once, audit what is behind it, and say so; when it cannot, it says
that too, in the coverage section.

The techniques are informed by reading axe-core (MPL-2.0) and IBM Equal
Access (Apache-2.0). **No code is copied from either**, nothing is vendored;
MIT, zero dependencies.

## The change

### Contrast (`src/checks/browser/60-sensory-contrast.js`)

1. **Per line box.** For each text node, take its line boxes
   (`Range.getClientRects()`), merge boxes on the same line, and sample each
   at a point inside the glyph area. Each sample resolves its own paint
   stack through `elementsFromPoint`; elements with `pointer-events: none`
   are hit-tested by rect instead, so they are not skipped. When every
   sample gives the same ratio outcome, report it once with the worst
   ratio. When samples disagree (one line over white, one over dark), the
   finding is a review item that says which line fails and over what.
2. **Reach everything.** An element outside the viewport is scrolled into
   view with `scrollIntoView({ block: 'center', behavior: 'instant' })`
   before sampling, in document order to keep scrolling cheap, and the
   original scroll position is restored at the end of the check. The DOM
   ancestor fallback goes away.
3. **Unknown backgrounds are bounded, not refused.** When a background
   image (not a gradient) lies in the stack under the text with no opaque
   layer above it, compute the ratio against the background as if it were
   white and as if it were black. Both pass: no finding. Both fail: a
   violation whose message says the text fails over any background. Mixed:
   a review item with both ratios. A CSS gradient is handled by parsing its
   colour stops and taking the worst stop (and the worst pairwise midpoint),
   same three outcomes. The round-1 "wrapper with slight opacity over a body
   image" case is therefore measured.
4. **Text shadow.** A shadow with blur ≤ 0.1 em in the text colour's
   opposite direction is a stroke: take the best of text-over-background,
   text-over-shadow and shadow-over-background as the effective ratio
   (axe's reasoning). Any other shadow with a blur ≥ 0.2 em turns a failing
   result into a review item that names the shadow. A shadow never turns a
   passing result into a finding.
5. **Form text.** Check the value text of `input` (text-like types),
   `textarea` and `select` against the control's background, and
   `::placeholder` colour (`getComputedStyle(el, '::placeholder')`) against
   the same background, each as 13.C with its own message. Disabled
   controls are exempt as in round 1.
6. **Large-text and other thresholds are unchanged.**

### Link distinguishable by colour (13.A, same file)

7. Walk up to the nearest block-level ancestor; take its text outside
   links and widgets; require that text to be longer than the link's text.
   Report only when the link's colour contrast against that text is below
   3:1 **and** its background contrast against the block's background is
   below 3:1 **and** there is no non-colour cue (underline or text
   decoration, border-bottom, bold where the text is not, background
   change). The existing immediate-parent rule goes away.

### Names (`src/checks/browser/00-core.js`)

8. **Embedded controls.** During name traversal, an embedded `input`
   (text-like), `textarea`, `select` or `[role=combobox|textbox|listbox|
   slider|spinbutton]` contributes its value: the typed value, the selected
   option's text, or `aria-valuetext`/`aria-valuenow`. The 5.B label
   inventory shows the result.
9. **Hidden explicit labels.** A `label[for]` that is hidden for everyone
   (`display: none`, `visibility: hidden`, or an ancestor so) does not
   count as a visible label: the control is reported under 5.A as a review
   item saying the only label is hidden. A visually hidden (clipped/sr-only)
   label still counts.

### Modal dialogs on load (`src/audit.mjs`, `src/passes.mjs`, `src/report.mjs`)

10. After the page settles and before the static checks, if a modal dialog
    is open (`dialog:modal`, or an element with `role="dialog"`/
    `"alertdialog"` and `aria-modal="true"` that is visible), record it on
    the page result as `modalOnLoad: { selector, name }`, run the static
    checks (which, since round 1, see only the modal), then press Escape
    once and wait. If the modal closed, run the static checks again on the
    page and label those findings `state: 'after closing the modal shown on
    load'`, as the disclosure pass labels revealed content; if it did not
    close, record `dismissed: false`. The keyboard and disclosure passes
    run on whatever state the page is in afterwards.
11. The coverage section gains, per page where a modal could not be
    dismissed, the warning "A modal dialog (<name>) was open when the page
    loaded and did not close with Escape; the page behind it was not
    audited. Dismiss it with --cookie or a saved session, or audit the
    dialog's close control." The site-level summary counts such pages, and
    the dashboard's live page list shows the modal note from the `page`
    event (the server relays `modalOnLoad` as it relays other page fields).
12. The modal lookup is computed once per `A.run()` and cached for that run.

### Fixtures and the golden output

Each item gets a page under `test/fixtures/` holding the false-positive
case and the true-positive case side by side, linked from `about.html` as
round 1 did, with assertions in `test/run.mjs` on `report.json`. Where a
ratio is asserted, the fixture's HTML comment shows the hand computation.
The golden (`test/golden/human-output.txt`) is regenerated once on the
final tree; its diff against `main` is in the PR body, annotated line by
line. The README's "What it checks" rows for 13.A, 13.C, 5.A and the
coverage section are updated.

## What must not move

- Zero dependencies; Node 18; the CLI's flags, exit codes and
  `report.json` shape (new fields are additive: `modalOnLoad` on a page,
  the coverage warning text).
- Every finding on the existing fixture pages that this plan does not
  name stays exactly as it is; the golden diff contains only explained
  lines.
- Scroll position after a page's checks equals the position before.
- The dashboard's suites stay green on Linux, macOS and Windows CI; the
  self-audit stays green.
- No code from axe-core or IBM Equal Access; no vendored package.

## Acceptance criteria

1. Inline text whose first line sits on white and whose second line sits
   on a dark block, in a colour that passes on one and fails on the other,
   is a 13.C review item naming the failing line; text that fails on every
   line is a violation with the worst ratio; text that passes on every line
   has no finding.
2. A failing-contrast paragraph placed over an absolutely positioned dark
   overlay (not an ancestor) 3000 px below the top of the page is reported;
   after the crawl the page's `scrollY` recorded by the fixture's own
   script (written to a `data-` attribute on unload is not possible, so
   assert through the page's `passes.static.scrollRestored === true`, set
   by the check) is true.
3. Text over a background image: `#555` on an image is a review item with
   both bound ratios in its details; `#ccc` on an image is a violation
   saying it fails over any background; `#000` is not reported. Text over
   `linear-gradient(#fff, #f5f5f5)` in `#999` is a review item with the
   worst-stop ratio; in `#333` it has no finding.
4. White text with a `0 0 1px #000` stroke-like shadow on a light panel has
   no finding; white text with a `0 0 8px #000` halo on a light panel is a
   review item naming the shadow; white text with no shadow on the same
   panel is a violation.
5. An `<input value="hello">` with `#bbb` text on white is a 13.C
   violation; a `::placeholder` in `#bbb` on white is a 13.C violation
   with the placeholder message; the same control disabled has no finding;
   a `<select>` whose selected option is `#bbb` is reported.
6. `<p><span>Read the </span><a href>privacy policy</a><span> before
   applying.</span></p>` with the link in a colour within 3:1 of the text
   and no underline is a 13.A finding; the same link underlined, or with a
   border-bottom, or with a background, or in a colour ≥ 3:1 from the text,
   has no finding; a link whose block has less surrounding text than link
   text has no finding.
7. `<label>Show <select><option selected>10</option></select> rows</label>`
   produces a 5.B inventory entry whose name is `Show 10 rows`; a label
   wrapping a text input with a typed value includes the value.
8. A control whose only `<label for>` is `display: none` is a 5.A review
   item saying the label is hidden; a control whose only label is clipped
   (sr-only) has no 5.A finding; a control with a hidden label and an
   `aria-label` has no finding.
9. A page that opens a modal `<dialog>` on load with a close button and
   Escape handling: the page result has `modalOnLoad.dismissed === true`,
   findings behind the modal (a missing-alt image in the page body) are
   present with the state label, and no coverage warning is added. A page
   whose modal ignores Escape: `modalOnLoad.dismissed === false`, the
   body's missing-alt image is not reported, the coverage section carries
   the warning naming the dialog, and the run's summary line says coverage
   is incomplete.
10. The dashboard's live page list shows the modal note for the two pages
    (one Playwright assertion added to `ui/e2e/crawl.spec.ts` or a new
    small spec), and the server's `page` event carries `modalOnLoad`.
11. The golden diff against `main` contains only explained lines; the
    existing fixture pages' findings are identical to `main` except where
    this plan names a change (list each in the PR body).
12. All CI jobs green (Node 18/20/22, ui, macOS, Windows) and the local full
    suite passes on the final commit.

## How this fails silently, and what is written to catch it

1. *Mutation*: sample only the first line box. AC 1's review case turns
   red (reported as passing).
2. *Mutation*: skip elements outside the viewport (no scroll). AC 2 turns
   red.
3. *Mutation*: do not restore the scroll position. AC 2's `scrollRestored`
   assertion turns red.
4. *Mutation*: background image → "uncertain", as before. AC 3's violation
   case turns red (silent).
5. *Mutation*: gradient worst stop replaced by the first stop. AC 3's
   `#999` case turns red.
6. *Mutation*: ignore text shadows. AC 4's halo case turns red (violation
   instead of review).
7. *Mutation*: a shadow is applied to passing text too. AC 4's stroke case
   turns red.
8. *Mutation*: skip form controls. AC 5 turns red.
9. *Mutation*: placeholder colour read from the control. AC 5's placeholder
   case turns red.
10. *Mutation*: 13.A compares to the immediate parent again. AC 6's first
    case turns red (silent).
11. *Mutation*: 13.A ignores the underline cue. AC 6's underlined case
    turns red (false positive).
12. *Mutation*: embedded control values skipped. AC 7 turns red.
13. *Mutation*: hidden explicit labels count. AC 8's first case turns red.
14. *Mutation*: sr-only labels treated as hidden. AC 8's second case turns
    red.
15. *Mutation*: the modal is never dismissed. AC 9's first page turns red
    (findings behind it missing).
16. *Mutation*: no coverage warning when the modal stays. AC 9's second
    page turns red.
17. *Mutation*: `page` event drops `modalOnLoad`. AC 10 turns red.
18. *Mutation*: one unrelated golden line edited. AC 11 turns red.

## Order of work

1. Fixtures and red assertions for all items.
2. Modal on load (items 10–12) first, because it changes what the other
   checks see on two fixture pages.
3. Names (8, 9), then 13.A (7), then contrast (1–5) in that order: line
   boxes, scrolling, bounded backgrounds, shadows, form text.
4. Dashboard: relay `modalOnLoad`, the live-list note, the one e2e
   assertion, `ui/dist` rebuilt and committed.
5. Golden, README, full suites, PR; watch CI on all platforms.

## Non-goals

- The ARIA role/attribute tables and the rules built on them, landmarks,
  tables heuristics, language subtags, frames, nested interactive controls,
  the "beyond 508" profile (rounds 3 and 4).
- Shadow DOM and same-origin iframe traversal.
- CJK large-text thresholds (IBM's choice is stricter than WCAG; not
  adopted).
- Dismissing modals by clicking their close controls; Escape only.
