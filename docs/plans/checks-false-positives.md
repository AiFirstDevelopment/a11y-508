# Checks, round 1: stop crying wolf, and catch the unnamed icon

branch: checks-false-positives
slug: checks-false-positives

Written 2026-10-12, from [docs/research/axe-and-ibm-comparison.md](../research/axe-and-ibm-comparison.md)
(items 1–8 of its section 4, and sections 2.1, 2.2, 2.4–2.7, 2.9, 2.10,
2.14). First of three rounds that bring the checks level with axe-core and
IBM Equal Access and then past them. Rounds 2 and 3 (contrast sampling, the
ARIA tables, the rule packs, the beyond-508 profile) are planned after this
one merges, on top of these fixes.

## Intent

A Section 508 gate that reports failures that are not failures gets turned
off. Reading axe-core and IBM's checker showed six places where ours does
that on patterns every government site uses: custom checkboxes, translucent
cards, labels of disabled fields, inert off-canvas menus, multi-token roles,
and lists with ARIA roles. It also showed two places where ours is silent on
real failures that are everywhere: icon-only links whose icon-font glyph
counts as a name, and widgets that take their own content as their name so
the "no name" checks can never fire. This round fixes those eight things,
each with a fixture page that proves the case both ways: the false positive
is gone, and the true positive next to it is still reported.

The techniques are informed by reading axe-core (MPL-2.0) and IBM Equal
Access (Apache-2.0). **No code is copied from either**, and nothing is
vendored; this repository stays MIT with zero dependencies. The research
file is committed with this plan.

## The change

All in `src/checks/browser/` and `src/passes.mjs`, in-page JavaScript with
no dependencies, findings carrying an element and a message as today.

1. **Focus on custom checkboxes, radios and switches** (`90-interactive.js`
   `kbPrepare`/`kbSample`, `passes.mjs` 4.D). For an input that is visually
   hidden (clip, `sr-only`, opacity 0, off-screen) with a label, snapshot
   and diff its `labels`, its next element sibling, and their `::before`/
   `::after` as well as the input itself. A change on any of them is a
   visible indicator; the finding, when there is none, names the label as
   the element so the developer sees what to style.
2. **Contrast opacity** (`60-sensory-contrast.js`). Blend per opacity group:
   composite the text over its group's background at full alpha first, then
   the group as one layer at its opacity over what lies below. Opacity is
   applied once.
3. **Contrast exemptions** (`60-sensory-contrast.js`). Skip the text of
   `label[for]` of a disabled control, labels that wrap one, and the targets
   of a disabled control's `aria-labelledby`. Report as review, not
   violation: a 1:1 ratio, a single-character text node, and text whose
   element has an absolutely positioned `::before`/`::after` with a
   background covering 25% or more of it.
4. **Hidden from assistive technology, and focusability** (`00-core.js`,
   used by `30-links.js`, `87-aria-keyboard.js`, and `60-sensory-contrast.js`).
   `A.isHiddenFromAT(el)`: `aria-hidden` matched case-insensitively, or an
   `inert` ancestor (attribute), or outside an open modal dialog
   (`dialog:modal`). `A.isTabbable`/`isFocusable`: false inside `inert`,
   inside a `fieldset[disabled]` (outside its first `legend`), and outside
   a modal. `isVisuallyHidden` uses document coordinates (rect plus
   `scrollX`/`scrollY`), so a scrolled page does not hide what is above the
   fold. `role="scrollbar"` leaves the must-be-focusable set.
5. **Role parsing** (`00-core.js` `A.role`, `87-aria-keyboard.js`). The
   role is the first *valid* token; a role attribute is reported only when
   every token is invalid; `image` is accepted as `img`; an abstract role
   (`widget`, `composite`, `landmark`, `roletype`, `section`,
   `sectionhead`, `structure`, `window`, `command`, `input`, `range`,
   `select`) gets its own message.
6. **Lists and short audio** (`40-structure.js`, `85-media-dynamic.js`).
   10.D skips `ul`/`ol` with an explicit role and ignores hidden children.
   2.A: autoplaying unmuted audio with no controls whose playable duration
   is 3 s or less (from `duration` once metadata is loaded, or a `#t=`
   fragment) is a review item; `loop` without controls stays a violation;
   unknown duration stays as today.
7. **Icon-only controls** (`00-core.js` `pseudoText`/name checks;
   `30-links.js`, `10-images.js`, `20-forms.js`). Before any "has a name"
   decision, strip private-use characters (U+E000–F8FF, planes 15 and 16),
   variation selectors and zero-width characters; a name that is empty after
   that is no name. Keep the raw string for messages, so the finding shows
   the glyph.
8. **Role-aware name from content** (`00-core.js` `A.accName`). Content is
   used as a name only for roles that allow it (button, cell, checkbox,
   columnheader, gridcell, heading, link, menuitem, menuitemcheckbox,
   menuitemradio, option, radio, row, rowheader, switch, tab, tooltip,
   treeitem, and the native `summary`, `legend`, `caption`) or during a
   recursive traversal; otherwise `aria-label`, `aria-labelledby`, native
   labelling, and `title` only. `pageInfo`'s navigation names, used by the
   site-wide checks, keep working: a `nav` is named from `aria-label`/
   `aria-labelledby` first and falls back to its heading or first link text
   for the cross-page comparison, explicitly, not through `accName`.

### Fixtures and the golden output

Each item gets a page under `test/fixtures/` that holds the false-positive
case and, beside it, the true-positive case, and `test/run.mjs` asserts on
both. The fixture site's `index.html` links the new pages. The human output
golden (`test/golden/human-output.txt`, guarded by `test/human-golden.mjs`)
changes because the fixture gains pages and findings; it is regenerated once
on the final tree and its diff is in the PR body, so a reviewer can see
exactly which findings appeared and disappeared. The README's "What it
checks" table is updated where a row's behaviour changed.

## What must not move

- Zero dependencies; Node 18; the CLI's flags, exit codes and `report.json`
  shape; the human output's format (only its findings change).
- Every finding on the existing fixture pages that this plan does not name
  stays exactly as it is: same test, level, impact, selector and message.
  The golden diff must contain only the lines this plan explains.
- The dashboard's suites (`ui/server/test`, `ui/e2e`) stay green on Linux,
  macOS and Windows CI; the self-audit (previous plans' AC) stays green.
- No code from axe-core or IBM Equal Access, no vendored package, no table
  copied from `lib/standards/*` or `lang.ts`.

## Acceptance criteria

1. A visually hidden `<input type="checkbox">` whose label (or next sibling
   box) shows an outline on `:focus-visible` gets no 4.D finding; the same
   markup with no focus style anywhere is reported as 4.D naming the label
   as the element. The same holds for a radio and a `role="switch"` input.
2. `<div style="opacity:.9;background:#222"><p style="color:#aaa">` on white
   gets no 13.C violation and the ratio in the finding details, if any, is
   5.55 ± 0.05; the same card with `#777` text is reported, with its ratio
   within ± 0.05 of the hand-computed value given in the fixture's comment.
3. A grey `label[for]` of a disabled input, a grey wrapping label of one,
   and the grey target of a disabled control's `aria-labelledby` get no 13.C
   finding; the same grey label of an *enabled* input is reported. Text
   with a 1:1 ratio, a single-character text node, and text over an
   absolutely positioned `::before` background of 25% or more are review
   items, not violations.
4. Focusable links inside an off-canvas `<nav inert aria-hidden="true">`
   get no 4.A finding; the same nav with `aria-hidden` and no `inert` is
   still reported. An input in `<fieldset disabled aria-hidden="true">` is
   not reported. `aria-hidden="TRUE"` is treated as hidden. A non-focusable
   `<div role="scrollbar">` gets no 4.A. On a page taller than the viewport,
   a disclosure at the bottom that reveals absolutely positioned text at
   the top of the document (above the fold after the scroll) has that
   text's contrast failure reported, labelled as revealed by the control.
5. `role="toggle button"` and `role="image"` get no 5.C finding;
   `role="foo bar"` is reported as invalid; `role="widget"` is reported
   with the abstract-role message.
6. `<ul role="tablist">` with `div` children and a `<ul>` with a hidden
   `div` child get no 10.D; a plain `<ul>` with a `div` child is still
   reported. A 1-second autoplaying unmuted audio with no controls is a 2.A
   review item; the same with `loop` is a violation; a 10-second one is a
   violation.
7. `<a href="/"><i class="icon"></i></a>` where `.icon::before` is a
   private-use glyph is a 6.A violation whose message shows the glyph; an
   icon-only `<button>` likewise under 5.A/6.A as today's naming goes; the
   same link with visible text beside the icon, and the same with
   `aria-label`, are not reported.
8. `<div role="dialog">` with an `<h2>` and no `aria-labelledby` is
   reported as an unnamed dialog; a `<fieldset>` of radios with no
   `<legend>` is reported as an unlabelled radio group; a
   `<div role="listbox" tabindex="0">` with options and no label is reported
   under 5.A; a `<button>Save</button>` is still named; the site-wide 9.B
   and 9.C results on the existing fixture pages are unchanged.
9. The golden human output is regenerated on the final tree, and its diff
   against `main` contains only lines for the new fixture pages and the
   findings this plan names, listed in the PR body.
10. All three CI jobs' suites (core on Node 18/20/22, ui on Linux, macOS,
    Windows) are green, and the local full suite passes on the final commit.

## How this fails silently, and what is written to catch it

1. *Mutation*: `kbSample` diffs only the input again. AC 1's first case
   turns red (the false 4.D returns).
2. *Mutation*: the fix exempts every visually hidden input. AC 1's second
   case turns red (no 4.D where there should be one).
3. *Mutation*: apply the ancestor opacity to the text alpha again. AC 2's
   ratio assertion turns red (4.40 instead of 5.55).
4. *Mutation*: skip contrast for every label. AC 3's enabled-input case
   turns red.
5. *Mutation*: `isHiddenFromAT` ignores `inert`. AC 4's first case turns
   red.
6. *Mutation*: `isTabbable` ignores `inert`. AC 4's first case turns red
   on the 4.A finding.
7. *Mutation*: `isVisuallyHidden` goes back to viewport coordinates. AC 4's
   revealed-text case turns red.
8. *Mutation*: `A.role` takes the first token. AC 5 turns red on
   `toggle button`.
9. *Mutation*: report the role when any token is invalid. AC 5 turns red.
10. *Mutation*: 10.D checks lists with a role again. AC 6 turns red.
11. *Mutation*: 2.A ignores duration. AC 6's 1-second case turns red.
12. *Mutation*: `pseudoText` keeps private-use characters. AC 7's first
    case turns red (the link is silently named).
13. *Mutation*: strip all pseudo text, not just glyphs. AC 7's visible-text
    case stays green, but the existing fixture's 15.A generated-content
    assertions in `test/run.mjs` turn red; cite the line.
14. *Mutation*: `accName` falls back to content for every element. AC 8's
    dialog case turns red.
15. *Mutation*: `nav` names come from `accName` only. AC 8's 9.B/9.C
    assertion turns red on the existing fixture.
16. *Mutation*: hand-edit one unrelated line in the golden. AC 9 turns red
    (`test/human-golden.mjs`).

## Order of work

1. Fixture pages for all eight items, with `test/run.mjs` assertions written
   first and red.
2. Items 4, 5, 7, 8 (`00-core.js`), then 3, 2 (`60-sensory-contrast.js`),
   then 6, then 1 (`90-interactive.js`, `passes.mjs`).
3. Golden regeneration, README table, the full suites, the PR.

## Non-goals

- Contrast sampling per line box, gradients, text shadows, input and
  placeholder contrast, the 13.A block walk (round 2).
- ARIA role/attribute tables and the rules built on them, landmarks,
  tables heuristics, language subtags, frames, nested interactive controls,
  the WCAG 2.1/2.2 "beyond 508" profile (round 3).
- Shadow DOM and same-origin iframe traversal.
- Any change to the dashboard (`ui/`) beyond what a changed finding
  requires in its tests.
