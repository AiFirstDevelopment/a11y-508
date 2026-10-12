# Checks, round 5: shadow DOM and same-origin frames

branch: checks-shadow-frames
slug: checks-shadow-frames

Written 2026-10-12, from [docs/research/axe-and-ibm-comparison.md](../research/axe-and-ibm-comparison.md)
section 3 ("Trade-offs we carry": no shadow DOM traversal, no same-origin
iframe descent). Rounds 1–4b are merged. This is the last round of the
series.

## Intent

Every check runs over `document.querySelectorAll`, so a web component's
shadow tree and a same-origin iframe's document are invisible: a
`<my-form>` with an unlabelled input inside its shadow root, or a payment
iframe from the same origin with a missing alt, passes silently. IBM's
checker walks shadow hosts and slots; axe descends into same-origin
frames. After this round the checks see the **composed tree**: open shadow
roots at any depth, slotted content where the browser renders it, and the
documents of same-origin frames, with findings that name the host or frame
path so a developer can find the element. Closed shadow roots and
cross-origin frames cannot be read; each is a coverage note, never
silence.

## The change

### The composed-tree walker (`00-core.js`)

1. `A.all(selector, root = document)` returns matches in document order
   across the root and every open shadow root beneath it (depth-first,
   through nested roots and through slotted hosts), and `A.walk(root,
   fn)` visits every element the same way. Every `document.querySelectorAll`
   and `querySelector` in `src/checks/browser/*.js` and in the pass
   helpers (`kbPrepare`, `disclosureCandidates`, `focusSelector`,
   `disclosureState`, `kbSample`) moves to these. `A.cs(el)` and rects
   are unchanged (they work across roots).
2. **Scoping that must respect roots:** id references (`for`,
   `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`,
   `headers`, `aria-activedescendant`, `usemap`) resolve in the
   referencing element's own root (`el.getRootNode()`), as the browser
   does; duplicate-id detection is per root; `elementsFromPoint` for
   contrast sampling uses the deepest root's `elementsFromPoint` so the
   paint stack sees inside hosts; the active element is followed through
   `shadowRoot.activeElement` in `kbSample`; `label.control` and
   `input.labels` work as the browser reports them.
3. **Slots:** name computation and text collection follow the flattened
   tree: a `<slot>`'s `assignedNodes({ flatten: true })` are visited in
   place of the slot, and light-DOM children that are not assigned to a
   slot are not rendered, so they are skipped.
4. **Selectors:** `A.selector(el)` for an element inside a shadow root is
   the host's selector, ` >>> `, the element's selector within its root,
   repeated per level (`my-form >>> form > input:nth-of-type(2)`). The
   report, the dashboard's detail panel and the fix-loop prompts show it
   as is; the HTML snippet is the element's own outer HTML.
5. **Closed shadow roots** cannot be entered: a custom element whose
   `shadowRoot` is `null` but which the CDP `DOM.describeNode` reports as
   having a closed root (or, simpler and dependency-free, which has
   rendered content with no light-DOM children and no open root) is
   listed once per page as a coverage note, "N components with a closed
   shadow root were not audited", naming the tag names.

### Same-origin frames (`src/audit.mjs`, `src/page.mjs`, `src/passes.mjs`)

6. After the top document's checks, every same-origin `iframe`/`frame`
   (readable `contentDocument`, not `about:blank` with nothing in it, not
   behind an open modal, and larger than 30×15 px) is audited **as part
   of the page**: the checks bundle is evaluated in the frame's document
   (through the frame's own execution context, found via CDP
   `Page.getFrameTree` and `Runtime` contexts, or by evaluating in the
   top context against `frame.contentDocument` where the bundle supports
   a `root` argument; the builder chooses and says which), and the
   frame's findings are merged into the page with `frame: <selector of
   the iframe>` and selectors prefixed `iframe#id >>> …`. Nested frames
   to depth 3. The frame's `lang`, `title`, headings, landmarks and
   duplicate ids are judged within the frame; 12.C/12.D (frame titles)
   stay on the parent's `iframe` element as today.
7. Interactive passes inside frames: the keyboard pass continues through
   a frame's tabbable elements as the browser does (the Tab pass already
   notes "focus entered a frame" as a review; it now samples inside
   same-origin frames instead), and the disclosure pass includes
   candidates inside same-origin frames; the zoom pass is page-level and
   unchanged.
8. **Cross-origin frames** are a coverage note per page: "N frames from
   other origins were not audited: <src hosts>", and the summary's
   coverage section counts them; the frame's own title checks still run.

### Fixtures, golden, README, dashboard

Fixture pages `test/fixtures/checks-shadow-*.html` (custom elements with
open roots, nested roots, slots, a closed root, an id reference inside a
root, contrast inside a host, a focusable control inside a host for the
Tab pass) and `checks-frames-*.html` (a same-origin frame with a missing
alt and an unlabelled input, a nested frame, a cross-origin `data:` frame,
a tiny frame), linked from `about.html`; the frame documents are served by
`test/fixture-site.mjs`. The golden is regenerated once and its diff
annotated. The README gains a "Shadow DOM and frames" subsection under
"What it checks" and the coverage notes are documented. The dashboard's
detail panel renders ` >>> ` selectors and the `frame` field (a small
`ui/app/` change, `ui/dist` rebuilt).

## What must not move

- Zero dependencies; Node 18; CLI flags; `report.json` shape (new fields
  additive: `frame` on findings, the coverage notes).
- Findings on existing fixture pages stay as they are; the golden diff
  holds only explained lines. The ordering of findings on a page is
  document order of the composed tree, which for pages without shadow
  roots or frames is the order today.
- The crawl's per-page time on pages without shadow roots or frames does
  not grow by more than 10% (measure on the fixture site before and
  after, and put the numbers in the PR).
- The dashboard suites and the self-audit stay green on every CI job.

## Acceptance criteria

1. `<my-card>` with an open shadow root holding `<img src>` without alt
   and `<input>` without a label: both are reported (7.A, 5.A) with
   selectors starting `my-card >>> `; the same component with alt and a
   label is not reported.
2. A nested root (`<outer-el>` whose root holds `<inner-el>` with its own
   root holding the failing image) is reported with a two-level selector.
3. A slotted light-DOM `<img>` without alt assigned to a slot is reported
   once, under the host's selector path; a light-DOM child not assigned
   to any slot is not reported (not rendered).
4. `<label for="x">` and `<input id="x">` inside the same root satisfy
   5.A; a `label for="x"` in the light DOM and an `input id="x"` inside a
   root do not (reported); two elements with `id="x"` in different roots
   are not a duplicate-id finding.
5. Text inside a host over the host's dark background at a failing ratio
   is a 13.C violation whose selector is inside the host.
6. A focusable button inside a host with no focus style is a 4.D finding
   during the Tab pass; the same with a `:focus-visible` style is not.
7. A component with a closed shadow root produces one coverage note on
   the page naming the tag, and no finding from inside it.
8. A same-origin iframe whose document has an image without alt and an
   unlabelled input: both findings appear on the parent page with
   `frame` set and selectors prefixed by the iframe's selector; the
   frame's own `lang` missing is an 11.A finding attributed to the frame;
   a nested same-origin frame (depth 2) is audited; a frame at depth 4
   is not, with a coverage note.
9. A cross-origin frame (`data:` URL) yields a coverage note naming it
   and no findings from inside; a 20×10 px same-origin frame is skipped
   silently; a frame behind an open modal is skipped.
10. The Tab pass on the frames fixture samples a focusable control inside
    the same-origin frame (its 4.D finding carries the frame prefix)
    instead of the old "focus entered a frame" review.
11. The dashboard's finding detail shows a ` >>> ` selector and the frame
    name for such findings (one Playwright assertion), and the fix-loop
    prompt for such a finding includes the full selector path (one
    assertion in `test/loop.mjs` or the agent prompt test).
12. Per-page time on the pre-existing fixture pages is within 10% of
    `main`'s (numbers in the PR); the golden diff holds only explained
    lines; all CI jobs green; local full suite passes on the final commit.

## How this fails silently, and what is written to catch it

1. *Mutation*: `A.all` does not descend into shadow roots. AC 1 turns red.
2. *Mutation*: nested roots not followed. AC 2 turns red.
3. *Mutation*: slots not flattened (light-DOM children visited directly).
   AC 3's unassigned-child case turns red (false positive).
4. *Mutation*: id references resolved against `document`. AC 4's
   cross-root case turns red (false negative) and the per-root duplicate
   case turns red (false positive).
5. *Mutation*: contrast uses `document.elementsFromPoint`. AC 5 turns red.
6. *Mutation*: `kbSample` stops at the host (`document.activeElement`).
   AC 6 turns red.
7. *Mutation*: closed roots produce no note. AC 7 turns red.
8. *Mutation*: frame descent disabled. AC 8 turns red.
9. *Mutation*: frame findings lose the `frame` field. AC 8's attribution
   assertion turns red.
10. *Mutation*: depth limit removed. AC 8's depth-4 case turns red.
11. *Mutation*: cross-origin frames produce no note. AC 9 turns red.
12. *Mutation*: the size check removed. AC 9's tiny-frame case turns red.
13. *Mutation*: the Tab pass stops at the frame. AC 10 turns red.
14. *Mutation*: selector builder drops the host prefix. AC 1's selector
    assertion and AC 11 turn red.
15. *Mutation*: one unrelated golden line edited. AC 12 turns red.

## Order of work

1. `A.all`/`A.walk`, selectors, id scoping, slots (AC 1–4), then contrast
   and the Tab pass across roots (AC 5–6), closed roots (AC 7).
2. Frames: audit descent, attribution, depth, cross-origin notes (AC
   8–9), then the Tab pass through frames (AC 10).
3. Dashboard and loop prompt (AC 11), timing measurement, golden, README,
   full suites, PR; watch CI on all jobs.

## Non-goals

- Closed shadow roots' contents and cross-origin frames' contents
  (impossible from the page; both are coverage notes).
- Crawling the frame's URL as a separate page (frames are part of the
  page they appear in; a frame's URL is not queued).
- Declarative shadow DOM edge cases beyond what `shadowRoot` exposes.
