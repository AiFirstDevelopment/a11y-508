# What our checks can learn from axe-core and IBM Equal Access

Sources read (October 2026, shallow clones, read only, nothing executed):

- **axe-core** 4.14.0, commit `44f5b6c` (MPL-2.0). Paths below are relative to the clone root (`lib/...`).
- **IBM Equal Access** `accessibility-checker-engine`, commit `1ea7a8a` (Apache-2.0). Paths are relative to `accessibility-checker-engine/src/`.
- Ours: `src/checks/browser/*.js`, `src/checks/catalog.mjs`, `src/passes.mjs`, `src/site-checks.mjs`, `README.md`.

How each tool maps to Section 508:

- axe tags 38 rules `TTv5` with a Trusted Tester test id (`TT5.c`, `TT6.a`, ...). Those tags line up with our catalog directly. The older `section508.22.*` tags (22 rules) refer to the pre-2017 1194.22 standard.
- IBM has no 508 rule set. `v4/rulesets.ts` describes its `WCAG_2_0` set as "referenced by US Section 508". Each rule's `rulesets[].num` gives its WCAG criterion.

Every claim here comes from reading code. No tool or page was run. Where a claim depends on how Chrome behaves, it says so.

---

## 1. Rules they have that we lack

"Fits" means the rule can run as plain in-page JS with no dependencies, and each finding carries an element and a message.

| Rule (axe / IBM) | Detects | WCAG | TT test | Technique (clone path) | Fits |
|---|---|---|---|---|---|
| `aria-hidden-body` (axe) | `<body aria-hidden="true">`. Everything is hidden from AT. | 4.1.2 | none, but it silences every TT test: our checks skip aria-hidden content, so the page looks clean | Reads `aria-hidden` on `body` (`lib/checks/aria/aria-hidden-body-evaluate.js`). Extend it to "an ancestor of most visible content is aria-hidden and no modal is open", which catches the stale `aria-hidden` that modal libraries leave on `#root`. | yes |
| `role-img-alt`, `svg-img-alt` (axe); `aria_img_labelled`, `svg_graphics_labelled` (IBM) | `role="img"` or `<svg role="img">` with no name | 1.1.1 | 7.A | Selector `[role=img]`, `svg[role=img]`; name from `aria-label`, `aria-labelledby`, `title`, or a child `<title>` (`lib/rules/svg-img-alt.json`, `v4/rules/svg_graphics_labelled.ts`) | yes |
| `nested-interactive` (axe, tagged TT6.a) | A focusable widget inside a control whose children are presentational (`<button><a href>`, `<a><button>`) | 4.1.2 | 6.A | For roles with `childrenPresentational`, walk the descendants. Fail on any widget-role descendant that is focusable. The message differs when the descendant uses `tabindex=-1` (`lib/checks/keyboard/no-focusable-content-evaluate.js`). | yes |
| `frame-focusable-content` (axe TT4.a); `iframe_interactive_tabbable` (IBM) | `<iframe tabindex="-1">` whose document has tabbable content | 2.1.1 | 4.A | IBM skips frames smaller than 30×15 and frames behind a `:modal` dialog, then counts tabbable children in `contentDocument` (`v4/rules/iframe_interactive_tabbable.ts`) | same-origin only |
| `scrollable-region-focusable` (axe TT4.a); `element_scrollable_tabbable` (IBM) | A scrolling container with clipped content and nothing focusable in it | 2.1.1 | 4.A | The element scrolls (scroll size > client size with overflow auto/scroll) and some descendant's rect falls outside its box. Pass if the element or a descendant is tabbable (`lib/rules/scrollable-region-focusable-matches.js`). Chrome 130+ makes such scrollers focusable by default, so in Chrome this is a review item. | yes (review) |
| `form-field-multiple-labels` (axe TT5.c) | More than one visible `<label>` for one field | 3.3.2 | 5.C | `label[for=id]` plus ancestor labels, filtered to labels AT can see. Incomplete unless `aria-labelledby` picks one (`lib/checks/label/multiple-label-evaluate.js`). | yes |
| `label` / `hidden-explicit-label` (axe); `input_label_visible` (IBM) | A field whose only label is hidden (`display:none` label) | 3.3.2 | 5.A | Find `label[for]`. If it is not visible to AT, recompute the name without it (`lib/checks/label/hidden-explicit-label-evaluate.js`). | yes |
| `frame-title-unique` (axe TT12.d) | Two frames with the same title | 4.1.2 | 12.D | Group `iframe[title]` by normalized title (`lib/rules/frame-title-unique.json`) | yes |
| `server-side-image-map` (axe TT4.a); `img_ismap_misuse` (IBM) | `img[ismap]` | 2.1.1 | 4.A | Selector only | yes |
| `object-alt` (axe 508 22.a) | `<object data>` with no text alternative, whatever its type | 1.1.1 | 7.A | We check only image-type objects (`10-images.js:110-117`). axe checks every loaded `object[data]`. | yes |
| `th-has-data-cells`, `td-has-header`, `table-fake-caption` (axe TT14.b / 22.g); `table_headers_related`, `table_scope_valid` (IBM) | Headers that label no cells; data cells in large tables with no header; a first row that is one full-width cell acting as a caption; `scope="column"` and other invalid values | 1.3.1 | 14.A / 14.B | Builds a cell grid with spans (`lib/commons/table/to-grid.js`, `get-headers.js`) and walks row and column headers per cell | yes |
| `aria-required-children`, `aria-required-parent` (axe); `aria_child_valid`, `aria_parent_required` (IBM) | `role=tablist` with no `tab`, `tab` outside a `tablist`, `menu` with no `menuitem`, `option` outside a `listbox` | 1.3.1 | 5.C, under our convention of filing ARIA integrity by affected test | Uses `requiredOwned` / `requiredContext` tables (`lib/standards/aria-roles.js`, `lib/commons/aria/required-owned.js`) and follows `aria-owns` | yes; the table is about 40 roles |
| `aria-valid-attr`, `aria-valid-attr-value`, `aria-allowed-attr`, `aria-prohibited-attr`, `aria-required-attr` (axe); `aria_attribute_allowed`, `aria_attribute_value_valid`, `aria_attribute_required` (IBM) | Misspelled `aria-labeledby`; `aria-expanded="yes"`; `aria-checked` on a `link`; `aria-label` on a generic `div`/`span`; `role=heading` without `aria-level` | 4.1.2 | 5.C | Typed attribute table (`lib/standards/aria-attrs.js`: boolean, tristate, idref, idrefs, nmtoken + values) and per-role `allowedAttrs` / `prohibitedAttrs` / `requiredAttrs` (`lib/standards/aria-roles.js`) | yes; mostly data |
| `presentation-role-conflict` (axe) | `role=none`/`presentation` or `alt=""` on an element that is focusable or has a global ARIA attribute. The browser ignores the role. | 1.3.1 | 7.B | `lib/checks/aria/has-global-aria-attribute-evaluate.js` and `is-element-focusable` | yes |
| `aria-input-field-name`, `aria-toggle-field-name`, `aria-progressbar-name`, `aria-meter-name`, `aria-tooltip-name` (axe TT5.c for the first two) | Custom widgets with no name | 4.1.2 / 1.1.1 | 5.A / 5.C | Name via `aria-label`, `aria-labelledby`, or `title` only. Content counts only for roles named from content. | yes |
| `landmark-one-main`, `landmark-no-duplicate-main/banner/contentinfo`, `landmark-*-is-top-level`, `landmark-unique` (axe best practice); `aria_landmark_name_unique`, `aria_banner_single`, `aria_contentinfo_single` (IBM) | Broken landmark structure: `main` nested in `main`, a `banner` inside `article`, two `nav` with no distinguishing label | 1.3.1 | supports 9.A, where we credit landmarks as a bypass | `lib/checks/keyboard/landmark-is-top-level-evaluate.js` walks ancestors' explicit or implicit roles. `landmark-unique` groups by role plus lowercased name. | yes |
| `image-redundant-alt` (axe); `img_alt_redundant` (IBM) | `alt` repeats the adjacent link or button text, so it is read twice | 1.1.1 | 7.A (review) | Compare alt to the parent control's visible text (`lib/checks/label/duplicate-img-label-evaluate.js`) | yes |
| `input_checkboxes_grouped`, `fieldset_legend_valid` (IBM) | Related checkboxes with no group label; a `fieldset` with no `legend` or more than one | 1.3.1 | 5.C | `v4/rules/input_checkboxes_grouped.ts`. We do radios only (`20-forms.js:92-106`). | yes |
| `aria_activedescendant_valid` (IBM) | `aria-activedescendant` points at something that is not an owned, focusable-role descendant | 4.1.2 | 4.A | `v4/rules/aria_activedescendant_valid.ts`. We only check that the id exists (`87-aria-keyboard.js:19-23`). | yes |
| WCAG 2.1/2.2-only rules: `label-content-name-mismatch` (2.5.3), `autocomplete-valid` (1.3.5), `target-size` (2.5.8), `avoid-inline-spacing` (1.4.12), `css-orientation-lock` (1.3.4); IBM `element_tabbable_unobscured` (2.4.11) | various | 2.1 / 2.2 | none: beyond TT. Section 508 incorporates WCAG 2.0. | Optional "beyond 508" profile. Keep them out of the TT gate. | yes |

Left out: rules for frameworks or their own reporting (`frame-tested`, IBM `debug_paths`, `detector_tabbable`), deprecated rules (`duplicate-id`, `duplicate-id-active`, `audio-caption`), and rules we already cover in an equal or stronger form (`bypass`, `meta-refresh`, `meta-viewport`, `marquee`, `blink`, `accesskeys`, `duplicate-id-aria`, `p-as-heading`, `empty-heading`, `tabindex`, IBM `text_block_heading`, `list_markup_review`, `text_sensory_misuse`).

---

## 2. Where their technique is more robust than ours

### 2.1 Accessible name: every element is named from its content

- **Ours:** `A.accName` falls back to `nameFromContent` for any element without a native rule (`00-core.js:356-357`).
- **Theirs:** axe uses subtree text only when the role allows name-from-content, or during a recursive traversal (`lib/commons/aria/named-from-contents.js`, which uses the `nameFromContent` flag in `lib/standards/aria-roles.js`; `lib/commons/text/subtree-text.js`). IBM does the same in `v4/util/AccNameUtil.ts` (`computeAccessibleName`, step 4).
- **Where ours goes silent:**
  - `<div role="dialog"><h2>Settings</h2>…</div>` with no `aria-labelledby` gets its whole text as a name. The "Dialog has no accessible name" check (`30-links.js:73-76`) can never fire.
  - `<fieldset>` without a `<legend>` around radios gets the radios' label text as its name. "Radio group has no group label" (`20-forms.js:104`) stays silent.
  - `<div role="listbox" tabindex="0"><div role="option">Red</div>…` and a `contenteditable` `role="textbox"` take their options or typed value as a label. 5.A (`20-forms.js:32`) stays silent.
  - The same leak will affect any future landmark-uniqueness check.
- **Effort:** 3 h. Add a set of name-from-content roles: button, cell, checkbox, columnheader, gridcell, heading, link, menuitem*, option, radio, row, rowheader, switch, tab, tooltip, treeitem, plus summary, legend and caption. Use content only for those roles or inside a traversal.

### 2.2 Accessible name: icon-font glyphs count as a name

- **Ours:** `pseudoText` (`00-core.js:236-245`) adds any quoted `::before`/`::after` content, including private-use glyphs.
- **Where ours goes silent:** `<a href="/"><i class="fa fa-home"></i></a>` gets the name `""`, which is truthy.
  - 6.A "Link has no accessible name" (`30-links.js:27`) does not fire.
  - The icon check (`10-images.js:104-105`) also skips it, because the parent link "has a name".
  - So the most common unnamed control on real sites passes silently.
- **Theirs:** axe's name computation does not include CSS generated content. Its `is-human-interpretable.js` and `unicode.js` (private use `-`, symbols, emoji) treat symbol-only text as no text. IBM includes pseudo content (`AccNameUtil.computeAccessibleNameForCSSPseudoElement`), as Chrome does. So "Chrome would expose a glyph" and "the user hears something meaningful" are different questions.
- **Effort:** 1 h. Strip PUA characters (planes 15–16 included) before every "has a name" decision. Keep the raw string for messages.

### 2.3 Accessible name: smaller gaps

- **Embedded controls** inside a label or link are skipped (`00-core.js:248-291`). axe's `lib/commons/text/form-control-value.js` uses the selected option, textbox value, or `aria-valuenow`.
  - Case: `<label>Show <select>…10…</select> rows</label>`. Ours: "Show rows". AT: "Show 10 rows".
- **Hidden explicit labels** count as labels: `nameFromContent(l, true)` (`00-core.js:319`) passes `includeHidden`. A `display:none` `<label for>` therefore satisfies 5.A, although no sighted user sees it. See the Section 1 row.
- **First-token roles.** `A.role` (`00-core.js:195`) reads only the first token of `role`. With `role="toggle button"` we get `toggle`. axe picks the first *valid* token (`lib/commons/aria/get-explicit-role.js`).

### 2.4 Visibility and "hidden from AT"

**Ours:**

- `isVisible` (`00-core.js:42-54`)
- `isVisuallyHidden` (`00-core.js:57-69`)
- `isAriaHidden`, which is `closest('[aria-hidden="true"]')` (`00-core.js:71`)

`inert`, modal `<dialog>` (`showModal`), `content-visibility`, and shadow roots are not handled anywhere. A grep of `src/` finds no `inert`, `:modal`, or `content-visibility`.

**Theirs:**

- axe `lib/commons/dom/is-visible-to-screenreader.js` = aria-hidden + `is-inert.js`, which also treats everything outside an open modal dialog as inert via `get-modal-dialog.js`, + `is-hidden-for-everyone.js`.
- `lib/commons/dom/visibility-methods.js`: `visibilityHidden` applies only to the element itself, not its ancestors, because `visibility` can be overridden. Also `contentVisibiltyHidden`, `detailsHidden` (content of a closed `<details>`), `clipHidden` (`clip: rect` collapsed, `clip-path: inset(>=50%)`, `circle(0)`), and `overflowHidden` (rect outside every `overflow:hidden` ancestor, with the absolute/static exception).
- IBM `v4/util/VisUtil.ts`: `isNodeHiddenFromAT`, `isContentHidden` (content-visibility), and `isNodeVisuallyHidden`, which treats opacity < 0.1 as hidden.

**Where ours goes wrong:**

- **Off-canvas menus with both `inert` and `aria-hidden="true"`.** This is a common modern pattern. They still trigger "Focusable control is inside aria-hidden" (4.A, `30-links.js:19-20`, `87-aria-keyboard.js:25-27`), because `A.isTabbable` ignores `inert`. That is a false positive.
- **Viewport coordinates.** `isVisuallyHidden` treats `r.right < 0 || r.bottom < 0` as hidden (`00-core.js:65`), using viewport coordinates. After `focusSelector` scrolls the page (the disclosure pass re-runs `A.run()`, `passes.mjs:197`), every element above the fold counts as "visually hidden", and contrast skips it (`60-sensory-contrast.js:58`). axe's `is-offscreen.js` uses document coordinates.
- **Case sensitivity.** `aria-hidden="TRUE"` is ignored by `isAriaHidden`. Chrome, to our knowledge, parses the token case-insensitively (not verified).
- **Effort:** 2 h. Add `A.isHiddenFromAT(el)` = aria-hidden (case-insensitive) OR `closest('[inert]')` OR outside `document.querySelector('dialog:modal')`. Use document coordinates for off-screen. Use it wherever `isAriaHidden` is used today.

### 2.5 Focusability

- **Ours:** `isNativeFocusable` / `isTabbable` (`00-core.js:163-187`) check `el.disabled` only.
- **Theirs:** axe `lib/commons/dom/focus-disabled.js` adds ancestor `fieldset[disabled]` (outside its `legend`), `inert`, and hidden-for-everyone. `is-natively-focusable.js` adds `details` without a `summary`. IBM `CommonUtil.isTabbable`.
- **Where ours goes wrong:**
  - `<fieldset disabled aria-hidden="true"><input></fieldset>` gives a false 4.A.
  - `role="scrollbar"` is in `INTERACTIVE_ROLES` (`00-core.js:11-15`), so a non-focusable custom scrollbar is reported as "not keyboard focusable" (`87-aria-keyboard.js:33-41`). ARIA does not require scrollbars to be focusable.
- **Effort:** 1 h.

### 2.6 Focus visible on custom checkboxes and radios (Tab pass)

- **Ours:** `kbSample` sets `visible = isVisible && !isVisuallyHidden` (`90-interactive.js:116`). A focused element that is not visible becomes a 4.D **violation** (`passes.mjs:126-127`). The snapshot watches only the element, its first child, and its parent (`90-interactive.js:65-90`).
- **Theirs:** IBM `v4/rules/element_tabbable_visible.ts` passes a clip-hidden `checkbox`/`radio` when it has a non-empty label and the author defined `:focus`, `:focus-visible`, `:focus-within`, or `:checked` styles. The visual indicator lives on the label or the sibling box.
- **Where ours goes wrong:** `<label><input type=checkbox class="sr-only"><span class="box"></span> Agree</label>` with `input:focus-visible + .box { outline: 2px solid }` is the Bootstrap, Material, and USWDS pattern. It yields "Keyboard focus landed on an element that is not visible" on every custom checkbox, radio, and switch. This is likely our largest single false-positive source on government sites, which commonly use USWDS.
- **Effort:** 3 h.
  - In `kbPrepare`, for visually hidden checkbox, radio, or `role=switch` inputs, also snapshot `el.labels`, `nextElementSibling`, and the label's `::before`/`::after`.
  - In `kbSample`, treat a diff on any of them as a visible indicator and report the label as the element.

### 2.7 Contrast

**Ours:** `60-sensory-contrast.js:7-99`. Theirs: axe `lib/checks/color/color-contrast-evaluate.js`, `lib/commons/color/*`, `lib/rules/color-contrast-matches.js`; IBM `v4/rules/text_contrast_sufficient.ts`, `v4/util/ColorUtil.ts`.

| Sub-problem | Ours | Theirs | Concrete failure of ours | Effort |
|---|---|---|---|---|
| **Opacity applied twice** | Background alpha is multiplied by each node's own opacity (`:34-35`). The text alpha is multiplied by *all* ancestors' opacity (`:67-74`) and then blended over the already-faded background. | axe flattens per stacking context (`stacking-context.js`, `get-foreground-color.js` `calculateBlendedForegroundColor`). IBM groups by opacity layer (`ColorUtil.ColorCombo`, `thisStackOpacity`). | `<div style="opacity:.9;background:#222"><p style="color:#aaa">` on white. Chrome paints 5.55:1. We compute 4.40:1, a **false 13.C violation**. At opacity .8 with `#b4b4b4`, real 4.71 becomes our 3.16. | 1 h |
| **Labels of disabled controls** | Skip only if the text node's own element or an ancestor is disabled (`:59`) | axe excludes `label[for]` of a disabled control, labels that wrap one, and text referenced by `aria-labelledby` from disabled controls (`color-contrast-matches.js`). IBM: `CommonUtil.getControlOfLabel`, `isDisabledByReferringElement`. | `<label for="x">Email</label><input id="x" disabled>`: a grey label is a **false violation**. WCAG exempts inactive components. | 1 h |
| **Pseudo-element backgrounds** | Not considered | axe: if `::before`/`::after` is absolute, has a background, and covers ≥25% of the element, the result is *incomplete* (`findPseudoElement`) | Pill button where `::before` paints the blue fill behind white text. We see white on white, 1:1, a **false violation**. | 1.5 h |
| **1:1 and single-character text** | Reported as a violation | axe returns incomplete for `equalRatio` (1:1 is almost always a detection error or hidden text) and `shortTextContent` (one character, often an icon) | Visually hidden text using `color: transparent` is caught. Same-color text used as a CSS trick is reported as critical. | 0.5 h |
| **Text shadow** | Ignored | axe treats thin shadows as a stroke, and a shadow ≥0.2em blur as part of the background (`get-text-shadow-colors.js`, `flatten-shadow-colors.js`). It takes the max of fg/bg, fg/shadow, and shadow/bg. IBM reports `potential_text_shadow` (review). | White text with a `0 0 2px #000` halo on a light panel: **false violation**. | 2 h for review-only; 6 h for axe-style math |
| **Gradients** | Any `background-image` in the chain means "uncertain", and the element goes to the review list (`:32`) | IBM `guessGradColor` (`ColorUtil.ts`) searches each pair of gradient stops for the worst-contrast mix and reports that ratio as *potential*. axe: incomplete. | A `linear-gradient(#fff,#f5f5f5)` card is never checked. Failures on it are silent. | 2 h |
| **Sample point and off-viewport** | One point 8 px inside the element's box (`:11-12`) via `elementsFromPoint`. Outside the viewport, it falls back to DOM ancestors (`:22-27`). | axe takes every text line box (`Range.getClientRects`, `get-visible-child-text-rects.js`), builds a stack per box from its own page grid (`create-grid.js`, `get-rect-stack.js`), and returns incomplete if the stacks differ or a background only partly covers the text (`bgOverlap`, `elmPartiallyObscured`). | Below the fold, positioned overlays and `z-index` are invisible to us. An element with `pointer-events:none` is skipped by `elementsFromPoint` (Chrome hit-testing; reasoning, not tested), so the chain is wrong. Multi-line inline text over two backgrounds uses the first point only. | 4 h: scroll each element into view with `behavior:'instant'`, sample each text rect, and send disagreeing samples to review |
| **Clipped and form text** | Text nodes only. Input values are never checked. | axe checks `input`, `select`, `textarea` values. It skips text clipped by `overflow:hidden` ancestors, `inert` content, and icon ligatures. | Light-grey typed text in inputs: silent. | 1.5 h |
| **Large-text threshold** | ≥24 px, or ≥18.66 px and ≥700 weight (`:85`) | axe is the same (`ceil(px*72)/96` pt vs 18 / 14). IBM uses ≥18.6 px bold, and raises the thresholds for CJK text (29.3 px / 24 px bold). | No gap with axe. IBM's CJK choice is stricter than WCAG; do not copy it. | — |

Placeholder contrast: none of the three tools checks `::placeholder` color. WCAG 1.4.3 applies to it, and `getComputedStyle(el, '::placeholder').color` makes the check easy. This would put us ahead.

### 2.8 Link distinguishable by color (13.A)

- **Ours:** compares the link only to its immediate parent, and requires ≥15 characters of the parent's *own* text nodes (`60-sensory-contrast.js:106-111`).
- **Theirs:** axe walks up to the nearest block-level parent and requires the block's non-widget text to be longer than the widget text (`lib/commons/dom/is-in-text-block.js`). It passes on either text contrast ≥3:1 or background contrast ≥3:1 (`lib/checks/color/link-in-text-block-evaluate.js`).
- **Where ours goes silent:** `<p><span>Read the </span><a>privacy policy</a><span> before applying.</span></p>`. The parent `<p>` has no direct text nodes.
- **Effort:** 2 h.

### 2.9 ARIA role validity

- **Ours:** `87-aria-keyboard.js:15-17` flags the role if the *first* token is not in `VALID_ROLES` (`00-core.js:18-30`).
- **Theirs:** axe flags only if *every* token is invalid (`lib/checks/aria/invalidrole-evaluate.js`), and reports abstract roles (`abstractrole`), deprecated roles (`deprecatedrole`), and unsupported roles separately. It accepts the ARIA 1.3 `image` alias (`lib/standards/aria-roles.js`).
- **Where ours goes wrong:**
  - `role="toggle button"` gets a false 5.C, although Chrome uses `button`.
  - `role="image"` gets a false 5.C.
  - `role="widget"` (abstract) gets the misleading message "not a valid role".
- **Effort:** 0.5 h.

### 2.10 Lists (10.D)

- **Ours:** checks every `ul`/`ol` whatever its role, allowing only `li`/`script`/`template` children (`40-structure.js:74-77`).
- **Theirs:** axe `list` matches only `ul, ol` with no role (`no-role-matches`), and `only-listitems` ignores hidden children.
- **Where ours goes wrong:** `<ul role="tablist">` or `<ul role="none">` with `<div>` children is a false violation. So is a hidden `<div>` inside a list.
- **Effort:** 0.5 h.

### 2.11 Tables (14.A)

- **Ours:** escalates every header-less table that is at least 2×2 (`70-tables.js:36-38`). On legacy and email-style government pages this floods the review list.
- **Theirs:** axe's `lib/commons/table/is-data-table.js` heuristic:
  - Data if it has caption/thead/tfoot/colgroup/summary, `th`, `scope`/`headers`/`abbr`, header roles, a role of grid/table, or is contenteditable.
  - Layout if it contains a nested table, has fewer than 2 rows, or the middle row is one cell.
  - Then data if ≥5 columns, cell borders, alternating row backgrounds, or ≥20 rows.
  - Layout if wider than 95% of the viewport or fewer than 10 cells.
- **Effort:** 2 h. Escalate only tables classified as data or unsure.

### 2.12 Language codes (11.A / 11.B)

- **Ours:** syntax regex only, `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$` (`50-lang-titles.js:3`).
- **Theirs:** axe checks the primary subtag against the IANA registry (`lib/core/utils/valid-langs.js`, a compressed trie; deprecated subtags removed). IBM keeps a primary-language table plus a full BCP 47 regex (`v2/checker/accessibility/util/lang.ts`).
- **Where ours goes silent:** `lang="jp"` (should be `ja`), `cn` (`zh`), `gr` (`el`), `ua` (`uk`), `dk` (`da`), `us`. All pass our regex and are real, common errors.
- **Also:** axe reports an invalid `lang` on an inner element only if the element contains text (`valid-lang-evaluate.js`, `hasLangText`). We report empty elements too (`50-lang-titles.js:16-20`).
- **Effort:** 1.5 h. Embed the 2-letter ISO 639-1 list (about 185 codes, roughly 600 bytes). Treat 3-letter codes that have a 2-letter equivalent as review.

### 2.13 Skip links (9.A)

- **Ours:** any `a[href^="#"]` whose name looks like "skip" counts as a working bypass if its target id exists (`40-structure.js:132-143`). Neither the link nor the target is checked for visibility.
- **Theirs:** axe `skip-link-evaluate.js` requires the target to be visible to screen readers.
- **Where ours goes silent:** a `display:none` skip link that never appears on focus, or a target inside a closed panel, satisfies 9.A.
- **Effort:** 0.5 h.

### 2.14 Autoplaying audio (2.A)

- **Ours:** autoplay, unmuted, no controls is always a critical violation (`85-media-dynamic.js:17-19`).
- **Theirs:** axe reads `element.duration`, `currentTime`, and `#t=` media fragments. Up to 3 s of playable audio passes; `loop` without controls fails (`lib/checks/media/no-autoplay-audio-evaluate.js`).
- **Where ours goes wrong:** a 1-second notification chime is a false critical.
- **Effort:** 1 h. Use `m.duration` when metadata has loaded; stay at review when it is NaN.

### 2.15 Duplicate ids

We already report only ids that are referenced (`87-aria-keyboard.js:69-84`). That matches axe's non-deprecated `duplicate-id-aria`, and is better than IBM's `element_id_unique`. The one gap: `aria-activedescendant` and `aria-details` references are not in the reference set.

---

## 3. Where we are ahead

- **A real Tab pass** (`passes.mjs:51-144`). We detect keyboard traps, focus that changes context, focus landing off-screen or under a sticky header, and focus order against DOM order. Both tools infer focus visibility from static styles; IBM's `style_focus_visible` and `element_tabbable_visible` mostly report "potential".
- **Focus indicator by before/after diff** of computed styles, including pseudo-elements, the first child, and the parent (`90-interactive.js:65-90`).
- **Disclosure activation** with Enter/Space and an `aria-expanded` check, dialog focus-in (4.G) and focus-return (4.H) after Escape, and a re-audit of revealed content (`passes.mjs:146-210`). Neither tool interacts with the page.
- **Real click listeners** found through the CDP event-listener probe (`passes.mjs:9-49`). axe and IBM see only `onclick` attributes, so `addEventListener` handlers on `div`s are invisible to them.
- **200% zoom reflow:** clipping, overlap, and lost text (`passes.mjs:267-294`).
- **Cross-page checks:** 9.B consistent navigation, 9.C consistent identification, 12.B duplicate titles, 19.A multiple ways (`site-checks.mjs`).
- **Click-discovered routes** for SPA navigation without `href` (`passes.mjs:216-265`).
- **Element screenshots** on findings, a TT-numbered manual checklist, and per-page review inventories (alt text, labels, heading outline).

**Trade-offs we carry:**

- No shadow DOM traversal. Every check uses `document.querySelectorAll`; IBM handles shadow hosts and slots (`AccNameUtil.computeAccessibleNameForShadowHost`). Web-component sites are under-tested.
- No same-origin iframe descent.
- Hand-written ARIA tables, not spec-derived ones.

---

## 4. Prioritized improvements

Ordered by value per hour. False-positive fixes come first. Hours include a fixture in `test/fixtures/` and a golden update.

1. **Custom checkbox, radio, and switch focus (FP).** In `90-interactive.js` `kbPrepare`/`kbSample` (65-90, 110-160) and `passes.mjs:126-132`: for visually hidden inputs, diff `el.labels`, `nextElementSibling`, and the label's pseudo-elements, and report against the label. **4.D / 2.4.7.** Removes a 4.D violation on every USWDS- or Bootstrap-style checkbox and radio. **3 h.**
2. **Contrast opacity (FP).** In `60-sensory-contrast.js:29-41, 67-81`: blend per opacity group. Within a group, composite text over the group's background first; then composite both as one layer at the group's opacity over what lies below. **13.C / 1.4.3.** Removes false failures inside translucent cards and overlays (5.55 vs 4.40 in the example above). **1 h.**
3. **Contrast exemptions (FP).**
   - Skip labels of disabled controls (`label[for]`, wrapping labels, `aria-labelledby` targets of disabled controls).
   - Treat 1:1 and single-character text as review.
   - Treat large absolute `::before`/`::after` backgrounds as review.

   All in `60-sensory-contrast.js:54-95`. **13.C.** **2.5 h.**
4. **Hidden-from-AT and focusability (FP).** In `00-core.js`: add `inert` (attribute and `dialog:modal`), disabled-fieldset ancestors, and case-insensitive `aria-hidden` to `isAriaHidden`/`isFocusable`. Use document coordinates in `isVisuallyHidden`. Affects `30-links.js:19-20` and `87-aria-keyboard.js:25-27`. **4.A / 4.1.2, 2.1.1.** Removes false "focusable inside aria-hidden" on inert off-canvas menus. **2 h.**
5. **Role parsing (FP).** In `00-core.js:18-30, 194-196` and `87-aria-keyboard.js:15-17`: use the first valid token, report only when all tokens are invalid, accept `image`, report abstract roles with their own message, and drop `scrollbar` from the must-be-focusable set. **5.C / 4.1.2; 4.A.** **1 h.**
6. **Lists honor role overrides; short audio exemption (FP).**
   - `40-structure.js:74-89`: skip `ul`/`ol` with an explicit role and ignore hidden children.
   - `85-media-dynamic.js:17-19`: exempt playable duration ≤3 s.

   **10.D / 1.3.1; 2.A / 1.4.2.** **1.5 h.**
7. **Icon-only links and buttons (FN, high volume).** In `00-core.js:236-245` and the name checks in `30-links.js`, `10-images.js:96-108`, `20-forms.js:42`: strip private-use and symbol-only characters before "has a name" decisions. **6.A / 2.4.4, 4.1.2.** Catches the most common unnamed control. **1 h.**
8. **Role-aware name-from-content (FN).** In `00-core.js:356-357`: content only for roles named from content. This makes the dialog-name check (`30-links.js:73-76`), radio-group label (`20-forms.js:104`), and custom listbox or textbox labels (5.A) work. **5.A, 5.C / 3.3.2, 1.3.1, 4.1.2.** Expect new true positives. Check `pageInfo` nav names, which still need content. **3 h.**
9. **Cheap rule pack A (FN).** In `10-images.js`:
   - `svg[role=img]` or `[role=img]` with no name: 7.A violation. This fixes the silent branch at `10-images.js:88-93`.
   - `body`/app-root `aria-hidden="true"` with no modal open: critical.
   - `img[ismap]`: 4.A.
   - `object` with no fallback text: 7.A.

   **7.A, 4.A.** **2 h.**
10. **Cheap rule pack B, forms and frames (FN).**
    - In `20-forms.js`: multiple visible labels (5.C); a hidden `<label for>` as the only label (5.A, review); unnamed checkbox groups (5.C, review).
    - In `50-lang-titles.js`: duplicate iframe titles (12.D).
    - In `87-aria-keyboard.js`: `iframe[tabindex="-1"]` with tabbable same-origin content (4.A); nested interactive controls (6.A).

    **3 h.**
11. **Language subtag list (FN).** In `50-lang-titles.js:3-20`: validate the primary subtag against ISO 639-1, and report inner `lang` only on elements with text. **11.A, 11.B / 3.1.1, 3.1.2.** Catches `jp`, `cn`, `gr`, `ua`, `dk`. **1.5 h.**
12. **Contrast sampling (FP and FN).** In `60-sensory-contrast.js:7-44`:
    - Sample each text line rect (`Range.getClientRects`).
    - Scroll off-viewport elements into view (`scrollTo({behavior:'instant'})`) and restore afterwards.
    - When samples disagree or the background only partly covers the text, report review rather than a violation.
    - Handle gradients with a worst-stop search (IBM's idea) as review.
    - Add input value and `::placeholder` contrast.

    **13.C.** **6 h.**
13. **13.A block-parent walk (FN).** In `60-sensory-contrast.js:102-129`: find the nearest block ancestor, compare the link to the block's text color and background, and compare text lengths as axe does. **13.A / 1.4.1.** **2 h.**
14. **Data-table heuristic (review noise).** In `70-tables.js:19-39`: classify tables as data, layout, or unsure before escalating 14.A, and add `scope` value validation and `th` with no data cells (14.B). **14.A, 14.B / 1.3.1.** **3 h.**
15. **ARIA tables (FN; foundation for later rules).** A new `src/checks/browser/05-aria-data.js` holding:
    - roles: required attrs, allowed attrs, prohibited attrs, required owned and required context, name-from-content
    - attributes: types and allowed values

    Use it for misspelled `aria-*` (a better message than today's "no label" when someone writes `aria-labeledby`), invalid values, required children/parent, and `presentation` conflicts. **5.C / 4.1.2, 1.3.1.** **8 h.**

Worth prototyping after the list: confirm critical "no accessible name" findings against Chrome's own computed name over CDP (`Accessibility.getPartialAXTree` on the node). Neither axe nor IBM can do this from inside the page. It removes name-computation drift, but icon glyphs still need the item 7 filter. About 4–6 h in `page.mjs`/`audit.mjs`; not verified.

---

## 5. Licensing

- axe-core is **MPL-2.0**: file-level copyleft, so copied code stays MPL.
- IBM Equal Access is **Apache-2.0**: requires attribution, a NOTICE file, and a license copy with redistribution.
- This repository is **MIT with zero dependencies**.

Rules for this work:

- Re-implement techniques from understanding. Use the descriptions in this document, the ARIA, HTML-AAM, and accname specs, and WCAG.
- **Never copy code** from either clone. That includes regexes, tables encoded as code, and the compressed language trie.
- **Do not vendor or depend on either package.**
- Facts are not copyrightable: the list of ARIA roles and attributes from the W3C spec, and ISO 639 codes from IANA. Build those tables from the primary sources, not from `lib/standards/*.js` or `lang.ts`.
- Cite the clones in commit messages only as "technique informed by".
