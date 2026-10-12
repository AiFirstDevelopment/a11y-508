# Checks, round 3: the ARIA pack

branch: checks-aria
slug: checks-aria

Written 2026-10-12, from [docs/research/axe-and-ibm-comparison.md](../research/axe-and-ibm-comparison.md)
section 1 (the ARIA rows: required children and parents, attribute
validity, presentation conflicts, widget names, landmarks, nested
interactive controls, `aria-activedescendant`), section 2.5 and 2.15, and
item 15 of section 4, plus three corrections the round-2 verifier deferred
(PR #5). Rounds 1 (`checks-false-positives.md`) and 2
(`checks-foundations.md`) are merged. Round 4 (the remaining rule packs and
the beyond-508 profile) and round 5 (shadow DOM and iframes, IBM's extras)
follow.

## Intent

Everything ARIA in the checks today rests on hand-written lists: valid role
names, a few interactive roles, and a handful of attribute checks. axe and
IBM carry the whole ARIA model as data (roles with their required and
allowed attributes, required children and parents, which roles take a name
from content, which make their children presentational; attributes with
their types and allowed values) and derive a dozen rules from it. This
round builds that model from the WAI-ARIA 1.2 and HTML-AAM specifications,
as data in one file, tests it against the spec's own facts, and derives the
rules from it. After this round a misspelled `aria-labeledby`, an
`aria-expanded="yes"`, a `tab` outside a `tablist`, an unnamed custom
textbox, a `<button>` wrapping a link, two `main` landmarks, or an
`aria-activedescendant` pointing nowhere useful are each reported with a
message that says what to fix.

The model is built from the specifications (facts, which are not
copyrightable), never from axe-core's `lib/standards/*` or IBM's tables.
No code is copied from either; MIT, zero dependencies.

## The change

### The ARIA model: `src/checks/browser/05-aria-data.js`

Loaded before the other check files (the bundle concatenates
`src/checks/browser/*.js` in name order; confirm in `src/page.mjs`
`checksBundle()`), exposing `A.aria` with:

- `roles[name]`: `{ abstract, deprecated, superclass: [...], requiredAttrs,
  supportedAttrs (role-specific; global attrs are implied), prohibitedAttrs
  (the naming-prohibited roles: `aria-label`/`aria-labelledby` on
  `generic`, `paragraph`, `caption`, `code`, `deletion`, `emphasis`,
  `insertion`, `strong`, `subscript`, `superscript`, `presentation`,
  `none`), requiredOwned (with the alternatives, e.g. `list` owns
  `listitem`; `table` owns `row` or `rowgroup`), requiredContext,
  nameFromContent, childrenPresentational }` for every role in WAI-ARIA
  1.2, abstract ones included (flagged), plus the 1.3 alias `image`.
- `attrs[name]`: `{ type: 'boolean' | 'tristate' | 'token' | 'tokenlist' |
  'idref' | 'idrefs' | 'integer' | 'number' | 'string', values?, global?,
  deprecated? }` for every `aria-*` attribute in 1.2.
- `implicitRole(el)`: the HTML-AAM mapping for the common elements
  (`a[href]`, `button`, `input` by type, `select`, `textarea`, `img`,
  `nav`, `main`, `header`/`footer` when not inside sectioning content,
  `aside`, `section[aria-label]`, `form[aria-label]`, `h1`–`h6`, `ul`,
  `ol`, `li`, `table`, `tr`, `th`, `td`, `dialog`, `details`, `summary`,
  `hr`, `progress`, `meter`, `output`, `fieldset`, `legend`…), consistent
  with what `A.role` already returns; `A.role` is refactored to use it, and
  the round-1 valid-role set and abstract-role list are replaced by the
  model.
- `test/aria-data.mjs`, run by the root `npm test`, checks the model
  against facts stated in the plan's fixture comment and the spec: every
  role's superclass chain ends at `roletype`; every attribute a role names
  exists in `attrs`; the counts (number of roles and attributes) match the
  1.2 spec's; and twenty spot facts (e.g. `checkbox` requires
  `aria-checked`; `tab` requires context `tablist`; `option` requires
  context `listbox` or `group`; `button` is `childrenPresentational`;
  `generic` prohibits naming; `aria-expanded` is tristate-less boolean
  with `undefined`; `aria-level` is integer; `aria-current` tokens).

### The rules (`src/checks/browser/87-aria-keyboard.js` and a new `88-aria-structure.js`)

1. **Unknown `aria-*` attribute** (5.C violation): any attribute starting
   `aria-` that is not in `attrs`, with a "did you mean" built from edit
   distance ≤ 2 to a known name (`aria-labeledby` → `aria-labelledby`).
2. **Invalid attribute value** (5.C violation): by type: booleans only
   `true`/`false`; tristate adds `mixed`; tokens from `values`; token lists
   each from `values`; `idref`/`idrefs` must resolve (the existing broken
   reference check moves here and gains `aria-activedescendant`,
   `aria-details`, `aria-errormessage`, `aria-flowto`, `aria-owns`);
   integers and numbers parse; empty values on required attributes count
   as missing.
3. **Attribute not allowed on the role** (5.C violation): an attribute
   that is neither global nor in the role's supported set (`aria-checked`
   on `link`; `aria-expanded` on `textbox`). **Naming prohibited** (5.C
   violation, own message): `aria-label`/`aria-labelledby` on an element
   whose role prohibits naming, including a `div`/`span` with no role.
4. **Required attribute missing** (5.C violation): `role=checkbox` without
   `aria-checked`, `combobox` without `aria-expanded`, `heading` without
   `aria-level`, `slider`/`scrollbar`/`spinbutton` without `aria-valuenow`
   (unless the spec's exception applies), `option` without `aria-selected`
   is *not* required in 1.2, so not reported; the model decides.
5. **Required children and parents** (5.C violation): a role with
   `requiredOwned` whose accessible children (DOM children plus
   `aria-owns`, skipping `presentation`/`none`/`generic`/`group` wrappers
   as 1.2 allows, and hidden ones) include none of them; a role with
   `requiredContext` whose accessible ancestors (DOM ancestors plus the
   `aria-owns` owner) include none. `aria-busy="true"` on the container
   exempts the owned check.
6. **Presentation conflict** (7.B review on `img[alt=""]`, 5.C review
   otherwise): `role=presentation|none`, or `alt=""`, on an element that is
   focusable or carries a global ARIA attribute; the browser ignores the
   role, so the author's intent is lost.
7. **Nested interactive controls** (6.A): a focusable descendant inside a
   role whose children are presentational (`button`, `checkbox`, `img`,
   `menuitemcheckbox`, `menuitemradio`, `option`, `progressbar`, `radio`,
   `scrollbar`, `separator`, `slider`, `switch`, `tab`, `math`, `meter`):
   violation when the descendant is tabbable, review when it has
   `tabindex="-1"`.
8. **Widget names** (5.A violation for form-like roles; 5.C for the rest):
   `textbox`, `searchbox`, `combobox`, `listbox`, `spinbutton`, `slider`,
   `checkbox`, `radio`, `switch`, `menuitemcheckbox`, `menuitemradio`,
   `progressbar`, `meter`, `tooltip`, `img`, and `svg[role=img]`, named
   only from `aria-label`, `aria-labelledby`, a native label, `title`, or
   (for `img`/`svg`) a child `<title>`; content never counts for these.
   The round-1 role-aware `accName` already refuses content for them; this
   adds the findings. The silent branch at `10-images.js` for
   `[role=img]` with no name is replaced.
9. **`aria-activedescendant`** (4.A violation): the host must be focusable
   (natively or `tabindex`), and the target must exist, be a descendant or
   `aria-owns`-owned element, and have a role that takes focus (option,
   treeitem, row, gridcell, menuitem*, tab, radio, switch…, from the
   model's widget subclasses).
10. **Landmarks** (9.A review, since Trusted Tester credits landmarks as a
    bypass): more than one `main`; `banner` or `contentinfo` more than
    once or nested inside `article`, `aside`, `main`, `nav` or `section`;
    `main` inside another landmark; two or more landmarks of the same role
    with the same (or no) accessible name, so a user cannot tell them
    apart ("two navigation landmarks with no label").
11. **Deprecated roles and attributes** (5.C review): `directory`,
    `aria-grabbed`, `aria-dropeffect`, and the other deprecations in 1.2,
    with the replacement in the message.

### Corrections from round 2

12. **Embedded controls, as Chrome does it** (`00-core.js`): an embedded
    control's value is included in a name only when the control is not the
    element being named. `<label>Show <select>…10…</select> rows</label>`
    names the select `Show rows`; a `<button aria-labelledby="that-label">`
    is named `Show 10 rows`. The round-2 fixture `checks-label-names.html`
    and its assertions change accordingly.
13. **One review item per page for text over images with mixed bounds**
    (`60-sensory-contrast.js`): the per-element review items for the
    between-bounds case are grouped into one review item per page listing
    the elements (up to 20, then "and N more"), as the pre-round-2
    aggregate did; per-element violations for "fails over any background"
    stay.
14. **A load-time modal is dismissed again after a reload**
    (`src/passes.mjs`, `src/audit.mjs`): the `reload()` used by the
    disclosure and route-discovery passes re-runs the modal dismissal
    (Escape once) when the page records `modalOnLoad.dismissed`, so those
    passes see the page, not the modal.

### Fixtures, golden, README

One fixture page per rule under `test/fixtures/checks-aria-*.html`, each
holding the failing case and the passing case side by side, linked from
`about.html`; assertions in `test/run.mjs`, written and run with
`node test/run.mjs --only /checks-aria-<x>.html` while building. The golden
is regenerated once on the final tree; its diff is annotated in the PR
body. The README "What it checks" table gains rows for 5.C (ARIA validity,
required children/parents, naming), 6.A (nested controls), 4.A
(`aria-activedescendant`), 9.A (landmarks), 7.B (presentation conflict).

## What must not move

- Zero dependencies; Node 18; CLI flags, exit codes, `report.json` shape.
- Findings on the existing fixture pages that this plan does not name stay
  as they are; the golden diff holds only explained lines. Round 1's role
  fixtures (`checks-roles.html`) keep passing with the model in place of
  the hand lists.
- No table copied from axe-core or IBM; the model cites the spec sections
  it encodes in its header comment.
- The dashboard's suites stay green on every CI job; the self-audit stays
  green (the dashboard's own ARIA must survive the new rules, and if it
  does not, the dashboard is fixed, not the rule).

## Acceptance criteria

1. `test/aria-data.mjs` passes: superclass chains, attribute references,
   the 1.2 role and attribute counts, and the twenty spot facts.
2. `aria-labeledby` is a 5.C violation whose message suggests
   `aria-labelledby`; `aria-expanded="yes"` is a violation naming the
   allowed values; `aria-level="x"` is a violation; `aria-controls` to a
   missing id is a violation; `aria-expanded="true"` and `aria-level="2"`
   are not reported.
3. `aria-checked` on `<a href>` is a violation; `aria-label` on a `<span>`
   with no role is a violation with the naming-prohibited message;
   `aria-label` on `<span role="button">` is not reported; a global
   attribute (`aria-hidden`, `aria-describedby`) on any element is not
   reported.
4. `<div role="checkbox">` without `aria-checked` is a violation;
   `<div role="heading">` without `aria-level` is a violation; with the
   attributes present, no finding.
5. `<div role="tablist">` with no `tab` child is a violation; a `tab`
   outside a `tablist` is a violation; a `tablist` whose tabs are inside a
   `div` wrapper, and one whose tabs are `aria-owns`-owned, are not
   reported; a `listbox` with `aria-busy="true"` and no options is not
   reported.
6. `<img alt="" tabindex="0">` is a 7.B review item; `<div
   role="presentation" aria-label="x">` is a 5.C review item; `<img
   alt="">` alone is not reported for this.
7. `<button><a href>…</a></button>` is a 6.A violation; `<div
   role="button"><span tabindex="-1">` is a 6.A review item; a button with
   plain text is not reported.
8. Unnamed `role=textbox`, `role=combobox`, `role=switch`,
   `role=progressbar`, `role=tooltip`, `[role=img]` and `svg[role=img]`
   are each reported (5.A or 5.C as the plan says); the same elements with
   `aria-label`, or the svg with a child `<title>`, are not; a
   `role=textbox` whose only "name" is its content is reported.
9. `aria-activedescendant` on a non-focusable host, to a missing id, to a
   non-descendant, and to a descendant with no widget role are each a 4.A
   violation; a focusable `role=listbox` host pointing at its own
   `role=option` child is not reported.
10. Two `<main>` elements, a `<header>` inside `<article>`, `<main>`
    inside `<nav>`, and two unlabelled `<nav>` elements are each a 9.A
    review item; one `main`, a top-level `header`, and two `nav`s with
    different `aria-label`s are not reported.
11. `role="directory"` and `aria-grabbed` are 5.C review items naming the
    replacement.
12. In `checks-label-names.html`, the select is named `Show rows` and the
    button that references the label is named `Show 10 rows` (through the
    5.B inventory or an explicit details field); the round-2 assertions
    are updated, not deleted.
13. On `checks-contrast-images.html`, the between-bounds elements produce
    exactly one 13.C review item for the page listing them; the
    fails-over-any-background violation is still per element.
14. On `checks-modal-escape.html`, the disclosure pass's findings carry no
    modal-related 4.G/4.H noise and the route-discovery pass records
    `passes.discovery` with the modal dismissed again (assert through the
    page's `modalOnLoad.redismissed >= 1`).
15. `checks-roles.html` (round 1) assertions pass unchanged with the model
    replacing the hand lists; the golden diff holds only explained lines;
    all CI jobs green; local full suite passes on the final commit.

## How this fails silently, and what is written to catch it

1. *Mutation*: delete one role's superclass. AC 1 turns red.
2. *Mutation*: the unknown-attribute rule ignores attributes with an edit
   distance ≤ 2 (treats near-misses as valid). AC 2 turns red.
3. *Mutation*: boolean values accept any string. AC 2 turns red on `yes`.
4. *Mutation*: global attributes treated as role-specific. AC 3's
   `aria-hidden` case turns red (false positive).
5. *Mutation*: naming-prohibited set emptied. AC 3's span case turns red.
6. *Mutation*: required attributes never checked. AC 4 turns red.
7. *Mutation*: the owned-children walk stops at the first DOM level
   (ignores wrappers and `aria-owns`). AC 5's wrapper case turns red
   (false positive).
8. *Mutation*: `aria-busy` ignored. AC 5's busy case turns red.
9. *Mutation*: presentation conflict ignores focusability. AC 6 turns red.
10. *Mutation*: nested-interactive treats `tabindex=-1` descendants as
    violations. AC 7's review case turns red.
11. *Mutation*: widget names accept content. AC 8's content-named textbox
    turns red.
12. *Mutation*: `aria-activedescendant` only checks the id exists. AC 9's
    non-descendant case turns red.
13. *Mutation*: landmark uniqueness compares role only, not name. AC 10's
    two-labelled-navs case turns red (false positive).
14. *Mutation*: the embedded control's own value is included when naming
    itself. AC 12 turns red (`Show 10 rows` for the select).
15. *Mutation*: aggregation removed. AC 13 turns red (more than one item).
16. *Mutation*: `reload()` skips the re-dismissal. AC 14 turns red.
17. *Mutation*: one unrelated golden line edited. AC 15 turns red.

## Order of work

1. The model and `test/aria-data.mjs` (AC 1), then refactor `A.role` onto
   it and confirm `checks-roles.html` still passes.
2. Rules 1–5 (attribute and structure validity), then 6–9, then 10–11.
3. Corrections 12–14.
4. Golden, README, the self-audit (fix the dashboard if a new rule catches
   it), full suites, PR; watch CI on all jobs.

## Non-goals

- The beyond-508 profile (WCAG 2.1/2.2 rules, axe best practices beyond
  landmarks), language subtags, table heuristics, frame rules, image rules
  other than `role=img`, skip-link visibility, checkbox groups, multiple
  and hidden labels (round 4).
- Shadow DOM and same-origin iframe traversal; IBM's CJK thresholds and
  the opacity < 0.1 hidden rule (round 5).
- The keyboard pass inside a dismissed load-time modal.
