# Checks, follow-up round: what the verifiers of rounds 2–5 deferred

branch: checks-followups
slug: checks-followups

Written 2026-10-12. Rounds 1–5 are merged. Each of their verifiers left
named follow-ups in the PR bodies (#5 round 2, #9 round 4a, #10 round 4b,
#11 round 5), and the Windows post-merge run of round 5 (run 38297117016)
showed a browser launch that never answered. This round closes those ten
items, each with a fixture that proves both directions and a mutation-tested
guard.

## Intent

The checks should not lose findings to the order in which the crawler does
things (a load-time modal's own controls), to tables that are too small
(three-letter language codes), to elements they forget (`<embed>`), to CSS
they cannot read (nested rules, `@import`), to heuristics that need a
threshold where a stronger signal exists (a focused older-style modal), to
exemptions applied too widely (2.5.8's browser-control exception), to frame
prefixes that stop at the finding's own selector, or to closed shadow roots
that also have light-DOM children. Where our accessible-name computation and
Chrome's disagree, Chrome's accessibility tree is the tiebreaker: a "no name"
violation on an element Chrome names becomes a review item that quotes
Chrome's name. And a browser that does not answer on the first launch gets a
second chance before the run fails with exit 3.

No code from axe-core or IBM Equal Access; zero dependencies; Node 18.

## The change

1. **Load-time modal, keyboard.** When a modal dialog is open on load and
   `--no-interact` is not set, the Tab pass runs inside the modal before
   Escape is pressed (`modal` scope: no 4.C trap verdict, since a modal keeps
   focus by design and Escape is its exit), then on the page as today.
   `kbPrepare` blurs the focused element before it records the unfocused
   styles, so an autofocused control's baseline is its unfocused look.
   `passes.keyboardModal` records the modal pass.
2. **Language codes.** `06-lang-data.js` gains the three-letter primary
   language subtags of ISO 639-2 and ISO 639-3 (with the 639-5 collections and
   the `qaa`–`qtz` private-use range) as registered in the IANA Language
   Subtag Registry. A three-letter primary subtag in neither the table nor
   the three-to-two map is an 11.A (11.B inside the page) violation.
3. **`<embed>`** without `aria-label`, `aria-labelledby` or `title` is a
   serious 7.A violation, whatever it embeds, as `<object>` is.
4. **Skip links, CSS.** The `:focus` reveal lookup reads nested style rules
   (`&:focus`, and nested selectors without `&`, resolved against their
   parent) and same-origin `@import`ed sheets (recursively), as well as
   top-level and grouping rules.
5. **Older modal, focused.** A visible `role=dialog`/`alertdialog` that sits
   beside an `aria-hidden` sibling (of it or of an ancestor) is the open
   modal regardless of how much text is hidden when it has focus or contains
   the active element; otherwise the 50% rule stays.
6. **2.5.8.** The browser-control exemption applies only when the author did
   not size the control: no `width`, `height`, `padding` or `font-size`
   (longhands included) in an author style rule that matches it or in its
   `style` attribute.
7. **Frames, details.** Every selector inside a frame finding's `details`
   (`selector` keys at any depth, `near`, `descendant`, `labels[]`,
   `frames[]`) gets the frame prefix; the 13.C "text over images" aggregate
   from a frame merges into the page's (one item per page, each element
   named with its frame prefix and carrying `frame`). The Tab pass enters
   every audited same-origin frame, nested ones included.
8. **Closed roots with light-DOM children.** A defined custom element with a
   box, no open root and light-DOM content is checked over CDP
   (`DOM.describeNode`, piercing): a closed shadow root holding text of its
   own makes it a closed-root coverage note like the light-less ones.
9. **Chrome's accessibility tree as the tiebreaker.** After the static checks
   (top document, behind the modal, and frames), each "no accessible name"
   violation — 5.A "no label or accessible name", 6.A "has no accessible
   name" / image button / area, 7.A image without alt, object/embed without a
   text alternative, `role=img`/`svg` without a name, and an unnamed dialog —
   is looked up with `Accessibility.getPartialAXTree` on its node. When
   Chrome names it (after removing icon-font glyphs and other non-text
   characters, which are not a name), the finding becomes a moderate review
   item that quotes Chrome's name and keeps the original message; when Chrome
   agrees, it stays. One call per such finding; a page with more than 50 is
   not looked up, with a note in `passes.axNames`.
10. **Browser launch retry.** `launchChrome` retries once when the first
    browser does not answer within the wait (fresh profile directory, the
    first process killed and its profile removed). The report's `browser`
    field becomes `{ name, launchRetries }` only when a retry happened (it
    stays the plain string otherwise), and the human output says so in one
    line. A browser executable path ending `.js`/`.mjs` is run with Node, so
    a stub can stand in for Chrome in `test/chrome-launch.mjs` (wired into
    `npm test`); the wait is an option (`launchTimeout`).

## What must not move

- Zero dependencies; Node 18; CLI flags; `report.json` shape (additions:
  `passes.keyboardModal`, `passes.axNames`, `frame` on aggregate elements,
  the object `browser` only after a retry).
- The golden human output changes only by explained lines.
- Every CI job green (Linux 18/20/22, ui, macOS core/ui, Windows core/ui).

## Acceptance criteria

1. On `checks-modal-escape.html`, the dialog's OK button (no focus style) is
   a 4.D violation found by the Tab pass before Escape; the Accept button
   (with a focus style) is not reported; no 4.C on the dialog.
2. On a language fixture, `lang="xyz"` (an unassigned code) is an 11.B
   violation naming the code, and `haw`, `yue`, `abc` (Ambala Ayta, ISO
   639-3) and `qaa` (private use) are not reported; a page whose `<html
   lang="xyz">` is an 11.A violation.
3. An `<embed>` with no name is a serious 7.A violation; one with `title` is
   not.
4. A visually hidden skip link revealed only by a nested `&:focus` rule, and
   one revealed only by a rule in an `@import`ed sheet, get no 9.A review;
   one with no reveal rule still does.
5. A focused `role=dialog` drawer beside a small `aria-hidden` panel is the
   modal on load (`modalOnLoad.selector`); the same without focus is not;
   the round-4b legacy fixtures keep their results.
6. With `--wcag 2.2`, a text input sized to 16 px by author CSS and crowded by
   another target is a 2.5.8 violation; an unsized browser checkbox in the
   same situation is not.
7. A frame's 13.C "text over images" elements merge into the page's single
   item with the frame prefix and `frame`; a frame's 7.A image inventory
   lists selectors with the frame prefix; the Tab pass reports a 4.D on a
   control inside a frame nested two deep, with the full prefix.
8. A closed-root component with light-DOM children is named in the page's
   closed-root coverage note; a custom element with light-DOM children and
   no shadow root is not.
9. A button named only by a closed shadow root's text ("Save") becomes a 6.A
   review quoting Chrome's name; a button whose only content is an icon-font
   glyph stays a 6.A violation; `passes.axNames` counts both.
10. `test/chrome-launch.mjs`: a stub browser that ignores its first launch
    and answers the second gives a working connection with `launchRetries:
    1`, a fresh profile directory and the first process gone; a stub that
    never answers fails after two attempts with the timeout message; the
    report helper writes `browser.launchRetries`.
11. Golden diff holds only explained lines; full suite green; all CI jobs
    green.

## How this fails silently, and what is written to catch it

1. *Mutation*: the modal Tab pass is not run. AC 1's OK-button assertion
   turns red.
2. *Mutation*: `kbPrepare` records baselines before blurring. AC 1's Accept
   assertion turns red (the autofocused Accept button's baseline is its
   focused look).
3. *Mutation*: the three-letter table is not consulted. AC 2's `xyz` turns
   red.
4. *Mutation*: the table holds ISO 639-2 only. AC 2's `yue`/`abc` turn red.
5. *Mutation*: `<embed>` handled as before. AC 3 turns red.
6. *Mutation*: nested rules not visited. AC 4's nested case turns red.
7. *Mutation*: `@import` not followed. AC 4's import case turns red.
8. *Mutation*: the focus clause removed from the older-modal rule. AC 5's
   focused case turns red.
9. *Mutation*: the author-size test always false. AC 6 turns red.
10. *Mutation*: `inFrame` prefixes only `selector`. AC 7's inventory and
    merge assertions turn red.
11. *Mutation*: the Tab pass follows one frame level only. AC 7's nested
    4.D turns red.
12. *Mutation*: closed-root candidates with light DOM not checked. AC 8 turns
    red.
13. *Mutation*: Chrome's name not consulted. AC 9's review assertion turns
    red.
14. *Mutation*: glyphs not stripped from Chrome's name. AC 9's glyph
    assertion turns red.
15. *Mutation*: no retry. AC 10's retry case turns red.
16. *Mutation*: the retry reuses the first profile directory. AC 10's
    fresh-profile assertion turns red.

## Non-goals

- Validating the region, script and variant subtags of a language tag.
- Reading cross-origin style sheets (not readable from the page).
- Confirming findings other than "no accessible name" against Chrome's tree,
  or naming checks on content revealed by the disclosure pass.
- A Tab pass inside modals that open later (the disclosure pass's 4.G/4.H
  stay as they are).
- Retrying a browser that exits with an error (only one that does not
  answer).
