# a11y-508

A Section 508 crawler with **no dependencies**. It drives the Chrome, Chromium, or Edge already installed on the machine over the DevTools Protocol, crawls every same-origin page it can reach, runs the automatable [DHS Trusted Tester v5](https://section508coordinators.github.io/TrustedTester/) test conditions on each page, and writes a report that separates:

- **Violations**: determinate failures of a Trusted Tester test condition.
- **Review items**: escalations for a human. The tool found something it cannot judge (an alt text, a link name, a form's error handling) and says exactly what to check, with the element, its HTML, and a screenshot.
- **Manual checklist**: the test conditions that can only be performed by a person.

It exists for environments where nothing can be published to a package registry and nothing can be downloaded at install time. It is two directories of plain JavaScript. Nothing is fetched from the network except the site being audited.

**AI coding assistants:** if you were told to read this file and get the crawl working, follow the [runbook](#runbook-for-ai-coding-assistants) below. It tells you which command to run next for every outcome.

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

## The fix loop

`a11y-508 loop` turns the crawl into an unattended fix cycle driven by an AI coding assistant of your choice. Each round it crawls, diffs the findings against the last round, has the assistant judge the review items and fix the open violations one at a time, gates every fix with your own build or test command, commits and pushes what survives, waits for the deployment, and crawls again. It keeps going until nothing is open or you press Ctrl+C, and a stopped loop resumes where it was because all state is in `a11y-508-work/ledger.json`.

Nobody reviews the assistant's changes before they are committed; the gate command stands in for the reviewer, and each fix is its own commit so a bad one can be reverted by hand later.

Put `a11y-508.config.json` in the repository that vendors the tool:

```json
{
  "url": "https://app-dev.example.gov/layout",
  "args": ["--max-pages", "50"],
  "agent": "claude",
  "source": ["src"],
  "check": "npm run build && npm test",
  "branch": "a11y-508/fixes",
  "deployed": "bundle-change"
}
```

| Key | Meaning |
|---|---|
| `url` | Start URL. The command line overrides it. |
| `args` | Crawl options used in every round, same as the basic run. Options on the `loop` command line are added. |
| `agent` | `claude`, `gemini`, `codex`, or any command. The presets run the assistant in non-interactive mode with file edits allowed. A custom command gets the prompt's path as `{promptFile}` and may also use `{resultFile}`. |
| `source` | Folders the assistant may edit (default `["src"]`). Changes anywhere else are reverted. |
| `check` | Build and test command run after each fix. A non-zero exit reverts the fix. `"checkEvery": "round"` runs it once per round instead and rolls back the whole round on failure. No `check` means no gate, with a warning. |
| `branch` | Branch to commit on (created if missing). Default: the current branch. `"push": false` keeps commits local. |
| `deployed` | How the loop knows the new build is live: `"command"` runs `deploy` and continues when it exits; `"bundle-change"` polls the start page every 15 seconds until its script and stylesheet URLs change (the default `deployTimeout` is 30 minutes); `"enter"` prints a prompt and waits for Enter; `"none"` continues at once (only for sites served straight from the working tree). Default: `"command"` if `deploy` is set, else `"enter"`. |
| `maxAttempts` | Fix attempts per finding before it is marked needs-human (default 3). |

Then:

```sh
TOKEN=... a11y-508 loop                 # or: npm run e2e:a11y-508 loop
a11y-508 loop --dry-run                  # crawl and update the ledger, nothing else
a11y-508 loop --max-rounds 1 --agent gemini
a11y-508 status                          # what is open, pending, verified, needs a person
```

What the assistant gets: one prompt per task, written to a file under `a11y-508-work/`, with the finding's test condition, message, pages, selector and rendered HTML, the folders it may edit, the folders it must not touch, and the path of the JSON result file it has to write. It never sees the token, the session file, or the report as a whole, and the token is stripped from its environment. A finding that is still present after `maxAttempts` fixes, or whose fix fails the gate that many times, is marked needs-human and dropped from the loop so one stubborn issue cannot keep it running. Review items the assistant calls "unsure" go to needs-human as well.

The loop refuses to start on a repository with uncommitted changes under `source`, so its commits only ever contain its own work. Each round's crawl output is kept in `a11y-508-work/round-N/`; add `a11y-508-work/` to `.gitignore`.

## Runbook for AI coding assistants

Follow this when a person asks you to run, fix, or update this tool in a repository that vendors it. Do each step in order and do not improvise around a step that fails; report it instead.

**Where the tool is.** Open `package.json` and find the script `e2e:a11y-508`. It points at `<TOOL>/bin/a11y-508.mjs`; `<TOOL>` (normally `tools/a11y-508`) is the tool folder. Never edit anything inside it.

**Update it** (when asked, or when a flag mentioned here is "Unknown option"):

```sh
git subtree pull --prefix <TOOL> https://github.com/AiFirstDevelopment/a11y-508.git main --squash -m "Update a11y-508"
```

`-m` matters: without it git opens an editor and your shell hangs. If git complains about local modifications, run `git stash`, pull again, then `git stash pop`. If subtree fails because the folder was copied rather than added as a subtree, clone the repository to a temporary folder and copy its `bin/`, `src/`, `README.md` and `LICENSE` over `<TOOL>/`. The update worked when `<TOOL>/src/troubleshoot.mjs` exists.

**Run the crawl.** Options after the URL need npm's `--` separator. On Windows PowerShell set the token with `$env:TOKEN='...'` on its own line first; never put a token in a file or a commit.

```sh
npm run e2e:a11y-508 <url> -- --max-pages 25
```

Start with `--max-pages 25` so a first run finishes in a few minutes; drop it once the run works. If your shell tool has a time limit, run long commands in a separate window with output redirected to a file (PowerShell: `Start-Process powershell -ArgumentList '-NoExit','-Command','npm run e2e:a11y-508 <url> -- --max-pages 25 *> a11y-508.log'`) and read the file when it stops growing.

**Read the result and pick the next step.** Look at the `pages:` line and the last line.

| The output says | What it means | Do this |
|---|---|---|
| `pages: N crawled, M audited` with M > 0 and a `report:` path | The crawl worked. Exit code 1 means violations were found; that is a finding, not a failure of the tool. | Report the `pages:` line, the violations line and the report path. Do not change `--fail-on` to make it pass. |
| `redirected off-origin to ...`, `FAIL (no page could be audited)`, `the start page could not be audited`, `HTTP 401`, `HTTP 403`, or `net::ERR_...` | The crawler could not get into the app. | Run the same command with `--troubleshoot` added (same `TOKEN`, same options). Paste its whole output in your reply, then follow its `next` line exactly, as below. |
| `Unknown option --troubleshoot` (or any flag from this file) | The vendored copy is old. | Update the tool as above, then retry. |
| `No Chrome, Chromium, or Edge found` | No browser on the machine. | Ask the person for the browser path and pass `--chrome <path>` or set `CHROME_PATH`. |
| `coverage warning ...` or `COVERAGE IS INCOMPLETE` | Some pages were not reached. | Report the coverage warnings verbatim with the result. If it says only the start page was audited, run `--troubleshoot` and report its link count. If it says `--max-pages`, rerun without the limit. Never describe such a run as a full pass. |
| `could not remove the temporary browser profile` | Windows kept files open for a moment. Harmless. | Ignore it. |

**Following the troubleshoot `next` line.**

- It names `--token-storage <key>`: rerun the crawl with that flag added (keep `TOKEN` set). Repeat troubleshoot if it still fails.
- It says `--login-only`: the app needs a real signed-in session, which only a person can create. Run `npm run e2e:a11y-508 <url> -- --login-only`, tell the person "A Chrome window is open, please sign in there and stay on the app page", and wait; do not press keys, close the window, or kill the command. It finishes by itself once the app has loaded and stayed put for six seconds, printing `session: saved ...`. Then run the crawl with `-- --state a11y-508-state.json` (plus the other options). If a later run says `redirected off-origin` again, the session expired: repeat `--login-only` once.
- It talks about a network error (VPN, proxy, DNS): stop and report; this is not something to fix in code.
- It says `Authentication is working` but the crawl still failed: paste both outputs and ask the person.

**Never**: edit files under `<TOOL>`; commit `a11y-508-state.json` or `a11y-508-report/` (add both to `.gitignore` if missing); write a token into any file; change `--fail-on`; retry blindly with guessed flags.

**When you report back**, include the exact commands you ran, the `pages:` line, any `coverage warning` lines, the exit code, the report path, and the troubleshoot output if you ran it.

**If asked to set up or run the fix loop:** create `a11y-508.config.json` as shown under "The fix loop" with the project's real build/test command in `check`, the folder that holds the app's source in `source`, and `agent` set to the assistant the person names. Ask which branch to commit on and how deployments happen (a command, a push that triggers a pipeline, or by hand) and set `branch` and `deployed` accordingly; do not guess. Run `a11y-508 loop --dry-run` first and report the ledger summary, then `a11y-508 loop` only when the person says to. Never edit `a11y-508-work/ledger.json` by hand.

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
  --token-storage <key>    Also seed TOKEN into web storage under <key> (repeatable)
  --no-token-storage       Do not seed TOKEN into localStorage/sessionStorage
  --cookie "name=value"    Cookie set on the start origin before the crawl (repeatable)
  --login                  Open a visible browser to sign in once (works with external
                           SSO portals), save the session to --state, then crawl with it
  --state <file>           Session file to crawl with, or to write when used with --login
                           (default with --login: a11y-508-state.json)
  --login-only             Sign in and save the session file, then exit without crawling
  --troubleshoot           Load only the start URL with the configured auth and explain
                           what happened (redirects, storage keys the app read, cookies,
                           whether the header went out) with the next step to take
  --no-interact            Skip the keyboard and disclosure-activation passes
  --no-zoom                Skip the 200% zoom pass
  --no-screenshots         Do not capture element screenshots
  --max-screenshots <n>    Screenshots per page (default 40)
  --max-tabs <n>           Maximum Tab presses per page (default 400)
  --max-activations <n>    Disclosure controls activated per page (default 12)
  --max-clicks <n>         Link-less navigation controls clicked per page to find pages
                           reachable only through click handlers (default 30)
  --no-follow-clicks       Do not click controls to discover pages; follow href links only
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

Most single-page apps never look at the request header: their auth guard reads the token from `localStorage` or `sessionStorage` and redirects to the login page when it is missing. So when `TOKEN` is set the crawler also writes the raw token (scheme stripped) into both storages before any page script runs, on the same origins, under the keys apps most often use: `token`, `access_token`, `accessToken`, `id_token`, `idToken`, `jwt`, `auth_token`, `authToken`. Add the key your app reads with `--token-storage <key>` (repeatable) if it is not in that list; `--no-token-storage` turns the seeding off. A value the app writes itself, such as a refreshed token, is never overwritten.

If the app relies on a session cookie instead, set it with `--cookie "name=value"` (repeatable), for example `--cookie "session=$SESSION"`. Cookies are set on the start origin and any `--auth-origin` before the first navigation. Note that browsers scope cookies by host, not port, so on `localhost` a cookie is visible to every port.

### Sign-in portals and single sign-on

When the app sends the browser to a login page on another domain (an SSO portal, an OpenID Connect provider, a company identity service), no token or cookie you can guess will get past it, and the crawl stops with `redirected off-origin to ...` on the start page. Sign in once interactively instead:

```sh
a11y-508 https://app.example.gov --login
```

A browser window opens on the start URL. Sign in there. Once the app itself has loaded and stayed put for six seconds the crawler carries on by itself (in an interactive terminal you can also press Enter): it captures the cookies and web storage the sign-in left behind, writes them to `a11y-508-state.json`, closes that window, and runs the normal headless crawl with that session. Cookies are kept for the app's origins and for the portal hosts the sign-in bounced through, because apps that re-check the SSO session on every page load need both. Reuse the file on later runs until the session expires:

```sh
a11y-508 https://app.example.gov --state a11y-508-state.json
```

`--login-only` signs in, saves the file, and exits without crawling, which keeps the interactive step short when a coding agent or a script drives the tool.

The file holds live credentials, including the portal's session cookie. It is written with owner-only permissions and `a11y-508-state.json` is in this repository's `.gitignore`; keep it out of version control. `--login --state <file>` chooses where to write it. For CI, sign in on a workstation and provide the file from the secret store.

During the crawl, a page that bounces through the portal and back (or any script-driven redirect) is followed until the document stops changing, and the page that finally lands is the one audited. A run in which no page could be audited is reported as FAIL, never PASS.

### When the crawl cannot get in

`--troubleshoot` loads only the start URL, with whatever auth is configured (`TOKEN`, `--cookie`, `--state`), and explains what happened instead of auditing:

```sh
TOKEN=... a11y-508 https://app.example.gov/layout --troubleshoot
```

It prints the navigation chain hop by hop (HTTP redirects and script-driven navigations, with status codes), whether the auth header actually went out on the page request, which web storage keys and cookies the app's own scripts read or wrote before it left (keys only, never values), what is in storage and the cookie jar afterwards, and a verdict with the next step: add `--token-storage <key>` when the app reads a key the tool did not seed, or `--login-only` when the server or the app insists on a real session. Exit code 0 means the page landed on the app and the crawl should work. `--json` prints the same as JSON.

### Flaky networks and Windows

Navigation errors that are usually momentary (`net::ERR_SOCKET_NOT_CONNECTED`, `ERR_CONNECTION_RESET`, `ERR_EMPTY_RESPONSE`, `ERR_NETWORK_CHANGED`, and similar) are retried up to three times with backoff before a page is recorded as failed; pages that needed a retry carry `navRetries` in the report. On Windows, Chrome can keep its temporary profile open for a moment after it closes; the crawler waits for the browser to exit, retries the cleanup, and prints the directory to delete by hand if it still cannot remove it, without failing the run.

The crawl stays on the start URL's origin, ignores binary links (PDF, images, archives), closes any pop-up windows, and refuses downloads.

### Coverage: pages without links

The crawler finds pages by following `href` links. Many single-page apps navigate from buttons, menu items or `routerLink` elements that have no `href`, and a crawler that only reads links would audit the first page and stop, which looks like a complete run. To avoid that, after auditing a page the crawler clicks up to `--max-clicks` controls that look like navigation but have no link: elements with a router or `data-href` attribute, `role="link"`, `menuitem`, `tab` or `treeitem`, and pointer-cursor items or buttons inside navigation, menus, headers and sidebars. Any same-origin URL a click leads to, including `pushState` routes and `#/` hash routes, is queued and audited, and is marked `foundBy: "click"` in the report. Controls whose name looks like an action (Save, Delete, Submit, Sign out, Approve, Export and similar) and anything inside a form or dialog are never clicked. `--no-follow-clicks` turns this off.

Every report has a coverage section. It warns when only the start page could be audited, when controls were skipped because they look like actions, when `--max-clicks` or `--max-pages` cut the crawl short, and notes pages that were reachable only by clicking (keyboard and screen reader users cannot discover those as links). A run that passes on violations but has coverage warnings prints `PASS on the N page(s) audited, but COVERAGE IS INCOMPLETE` rather than a plain PASS.

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
