# a11y-508

A Section 508 crawler with **no dependencies**. It drives the Chrome, Chromium, or Edge already installed on the machine over the DevTools Protocol, crawls every same-origin page it can reach, runs the automatable [DHS Trusted Tester v5](https://section508coordinators.github.io/TrustedTester/) test conditions on each page, and writes a report that separates:

- **Violations**: determinate failures of a Trusted Tester test condition.
- **Review items**: escalations for a human. The tool found something it cannot judge (an alt text, a link name, a form's error handling) and says exactly what to check, with the element, its HTML, and a screenshot.
- **Manual checklist**: the test conditions that can only be performed by a person.

It exists for environments where nothing can be published to a package registry and nothing can be downloaded at install time. It is two directories of plain JavaScript. Nothing is fetched from the network except the site being audited.

```bash
TOKEN=eyJhbGciOi... npm run e2e:a11y-508 https://app.example.gov
```

## Requirements

- Node.js 18 or newer.
- Chrome, Chromium, or Microsoft Edge installed. Auto-detected on macOS, Linux, and Windows, or set `CHROME_PATH`.

That is all. There is no `npm install` step.

## Using it from another repository

Copy the tool into the consuming repository and add one script. `git subtree` keeps a record of where it came from so it can be updated later; a plain copy of the folder works too.

```bash
git subtree add --prefix tools/a11y-508 https://github.com/AiFirstDevelopment/a11y-508.git main --squash
```

In the consuming repository's `package.json`:

```json
{
  "scripts": {
    "e2e:a11y-508": "node tools/a11y-508/bin/a11y-508.mjs"
  }
}
```

Add `a11y-508-report/` to `.gitignore`. Then:

```bash
TOKEN=<token> npm run e2e:a11y-508 https://staging.example.gov
```

npm passes the URL through to the script. Options that start with `--` need the usual npm separator: `npm run e2e:a11y-508 https://site -- --max-pages 50`.

To update later:

```bash
git subtree pull --prefix tools/a11y-508 https://github.com/AiFirstDevelopment/a11y-508.git main --squash
```

If GitHub is not reachable from the environment, mirror this repository to the internal git host and use that URL instead.

### Prompt for an AI coding assistant

Paste this into Claude Code, Copilot, Cursor, or similar when working in the repository that should get the check:

> Add the a11y-508 Section 508 crawler to this repository so that `npm run e2e:a11y-508 <url>` works.
>
> 1. Vendor the tool with `git subtree add --prefix tools/a11y-508 https://github.com/AiFirstDevelopment/a11y-508.git main --squash`. If subtree or network access is unavailable, copy the `bin/` and `src/` directories plus `README.md` and `LICENSE` from that repository into `tools/a11y-508/`. Do not add it as an npm dependency and do not run `npm install` for it; it has no dependencies.
> 2. Add the script `"e2e:a11y-508": "node tools/a11y-508/bin/a11y-508.mjs"` to `package.json`. If this repository already has an `e2e:` script naming convention, keep this name anyway; it is what the team's CI expects.
> 3. Add `a11y-508-report/` to `.gitignore`.
> 4. The tool reads the environment variable `TOKEN` and sends it as `Authorization: Bearer <TOKEN>` on same-origin requests only. Do not hard-code a token anywhere. If this project's local dev server needs a different header name, use `--token-header <name>`.
> 5. Verify by running `npm run e2e:a11y-508 http://localhost:<port>` against the running dev server (set `TOKEN` if the server requires it) and confirm `a11y-508-report/report.html` is produced. The command exits 1 when critical or serious violations exist, which is expected on a first run; do not change `--fail-on` to make it pass.
> 6. Optionally add a CI job that runs the same command against the deployed preview/staging URL with `TOKEN` supplied from the CI secret store, and publishes `a11y-508-report/` as a build artifact.
>
> The tool needs Node 18+ and a Chrome, Chromium, or Edge binary on the machine (`CHROME_PATH` if it is not in a standard location). It does not download a browser.

## Command line

```
a11y-508 <url> [options]

  --max-pages <n>          Maximum pages to audit (default 200)
  --max-depth <n>          Maximum link depth from the start URL (default 10)
  --concurrency <n>        Parallel tabs (default 4)
  --include <regex>        Only audit URLs matching this pattern (repeatable)
  --exclude <regex>        Skip URLs matching this pattern (repeatable)
  --fail-on <list>         Impacts that fail the run: critical,serious,moderate,minor
                           or "none" (default critical,serious)
  --out <dir>              Report directory (default ./a11y-508-report)
  --viewport <WxH>         Viewport size (default 1280x800)
  --timeout <ms>           Page load timeout (default 30000)
  --settle <ms>            Extra wait after load for scripts to render (default 500)
  --header "Name: value"   Extra request header, sent to every request (repeatable)
  --token-header <name>    Header that carries TOKEN (default Authorization)
  --auth-origin <origin>   Additional origin that also receives TOKEN (repeatable)
  --no-interact            Skip the keyboard and disclosure-activation passes
  --no-zoom                Skip the 200% zoom pass
  --no-screenshots         Do not capture element screenshots
  --max-screenshots <n>    Screenshots per page (default 40)
  --max-tabs <n>           Maximum Tab presses per page (default 400)
  --max-activations <n>    Disclosure controls activated per page (default 12)
  --user-agent <ua>        Override the browser user agent
  --chrome <path>          Browser executable (default: auto-detect, or CHROME_PATH)
  --no-sandbox             Pass --no-sandbox to Chrome (containers running as root)
  --quiet                  Only print the summary
  --json                   Print the report summary as JSON on stdout
  --list-tests             Print the Trusted Tester test catalog and exit
```

Exit codes: `0` no violations at the `--fail-on` impacts, `1` violations found, `2` usage or crawl error, `3` the browser could not start.

### Authentication

`TOKEN` is sent as `Authorization: Bearer <TOKEN>`. If the value already starts with a scheme (`Bearer x`, `Basic x`, `Token x`) it is sent unchanged. The header goes only to the start URL's origin, plus any `--auth-origin`, so a token is never leaked to third-party assets. If the site turns the token into a session cookie on the first request, that cookie is kept for the rest of the crawl.

The crawl stays on the start URL's origin, ignores binary links (PDF, images, archives), closes any pop-up windows, and refuses downloads.

## What it checks

Every finding carries a Trusted Tester test ID and the WCAG success criterion. `--list-tests` prints the catalog.

| TT test | Condition | Automation |
|---|---|---|
| 1.A–1.E | Conforming alternate version | manual |
| 2.A | Audio control | autoplay with sound and no controls is a violation; embedded players are escalated |
| 2.B | Moving, blinking, scrolling | `marquee`/`blink` are violations; infinite CSS animations, autoplaying video, carousels are escalated |
| 2.C | Auto-updating | `meta refresh` reload is a violation |
| 2.D | Change notification (auto) | manual |
| 3.A | Flashing | fast infinite animations are escalated |
| 4.A | Keyboard access | widget roles and click handlers on non-focusable elements (found through DevTools event-listener inspection), `aria-hidden` focusables, custom controls that ignore Enter/Space |
| 4.B | Keystroke timing | manual |
| 4.C | Keyboard trap | a real Tab/Shift+Tab pass through every page |
| 4.D | Focus visible | computed-style comparison of every element before and after it receives keyboard focus, plus off-screen and overlapped focus |
| 4.E | On focus | navigation triggered by focus during the Tab pass |
| 4.F | Focus order | positive `tabindex`, focus order that differs from DOM order (escalated) |
| 4.G / 4.H | Focus into and out of revealed content | dialogs opened from disclosure buttons are checked for focus move and return |
| 5.A | Label provided | missing, placeholder-only, title-only, aria-label-only labels |
| 5.B | Label descriptive | empty/punctuation labels; label inventory escalated |
| 5.C | Programmatic associations | broken `for`/ARIA references, duplicate ids, visual-only required marks, missing widget states, unknown roles, unnamed dialogs, ungrouped radios |
| 5.D | On input | selects that submit on change (attribute or listener) |
| 5.E | Change notification (form) | manual |
| 5.F / 5.G | Error identification and suggestion | `aria-invalid` without a message; every form escalated with instructions |
| 5.H | Error prevention | legal/financial forms escalated |
| 6.A | Link and button purpose | no name, generic text with/without context, same text to different targets, URL-as-text |
| 6.B | Change notification (links) | manual |
| 7.A | Meaningful image name | missing alt, filename/generic alt, long alt; inventory of every alt text escalated with screenshots; unnamed SVG/icon fonts |
| 7.B | Decorative image | decorative images that still have a name; large decorative images escalated |
| 7.C | Background images | CSS background images with no text equivalent escalated |
| 7.D | CAPTCHA | detected CAPTCHAs escalated |
| 7.E | Images of text | manual, using the 7.A inventory |
| 8.A | Time limits | timed `meta refresh` redirect; session-timeout wording escalated |
| 9.A | Bypass blocks | no skip link, `main`, or headings; broken skip-link targets |
| 9.B | Consistent navigation | relative order of shared navigation links compared across every crawled page |
| 9.C | Consistent identification | same destination named differently across pages |
| 10.A | Heading purpose | outline escalated per page |
| 10.B | Visual vs programmatic headings | empty headings; large bold text that is not a heading |
| 10.C | Heading levels | skipped levels, multiple h1, headings smaller than body text |
| 10.D | Lists | invalid list structure; bullet/number text that is not a list |
| 11.A / 11.B | Language | missing or invalid `lang` |
| 12.A / 12.B | Page title | missing, generic, or duplicated across pages |
| 12.C / 12.D | Frame and iframe names | missing or generic titles |
| 13.A | Color alone | inline links distinguished from text only by color |
| 13.B | Sensory characteristics | instructions that refer to shape, color, or position |
| 13.C | Contrast | real computed contrast using the actual paint stack behind each text node, alpha and opacity included; text over images escalated |
| 14.A / 14.B / 14.C | Tables | data tables without headers, missing scope, complex tables without `headers`, broken `headers` ids, layout tables with header markup |
| 15.A | CSS generated content | text and images inserted via `::before`/`::after` |
| 15.B | CSS positioning | reversed flex, CSS `order`, content positioned far from its DOM position |
| 16.A / 16.B / 17.A–17.D | Media | audio without transcript, video without caption or description tracks, embedded players, player controls |
| 17.C / 17.E / 17.F | Live captions, control placement | manual |
| 18.A | Resize text | the page is re-laid out at 200% zoom and checked for clipped and overlapping text; viewport tags that block zoom |
| 19.A | Multiple ways | navigation, search, site map, breadcrumbs detected across the site |
| 20.A | Parsing | not tested, per Trusted Tester |

Each page is also re-checked after the tool opens every disclosure button, accordion, and menu it can find, so content that only appears after interaction is audited too. Findings from that pass are labelled with the control that revealed them.

## Reading the report

`a11y-508-report/` contains:

- `report.html`: everything, filterable by level, impact, page, and text. Each finding shows the test condition, the element's selector and HTML, a screenshot, and any supporting data. The manual checklist and the page table are at the bottom.
- `report.json`: the same data for tooling. Top-level `summary` has counts by test and by impact; `pages[].findings[]` and `site.findings[]` hold the items.
- `summary.md`: a short Markdown summary suitable for a pull-request comment.
- `screenshots/`: element screenshots referenced by the report.

Impact is `critical`, `serious`, `moderate`, or `minor`. By default the run fails on `critical` and `serious`.

## What this cannot do

No automated tool reaches full Section 508 conformance, and this one does not claim to. Several Trusted Tester conditions are judgment calls by definition: whether alt text actually describes the image, whether reading order makes sense, whether an error message tells the user how to fix the problem. The tool reports those as review items with the exact element, and the manual checklist lists what a human tester still has to do. Use the run as the gate in CI and the report as the worklist for the Trusted Tester review.

## Development

```bash
npm test
```

The test serves a fixture site that requires a bearer token on every request, runs the crawler against it, and asserts on about sixty expected findings, including that the token is never sent to another origin. Set `A11Y_508_DEBUG=1` to trace navigation and request interception.

Checks live in `src/checks/browser/`. Each file registers a function that runs inside the audited page and calls `A.add({ test, level, impact, el, message, details })`. The test catalog is `src/checks/catalog.mjs`. Interactive passes (keyboard, disclosure, zoom) are in `src/passes.mjs`; cross-page checks are in `src/site-checks.mjs`.

## License

MIT
