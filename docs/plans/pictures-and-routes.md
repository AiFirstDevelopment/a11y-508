# The assistant must open each page's picture, and a "Not Found" page is no evidence

slug: pictures-and-routes
branch: pictures-and-routes

## Intent

Joel's second full run on his real report (2026-10-17, build 67898b4) got the structure right —
11 findings, one per page, none dropped — and two things wrong:

1. **The assistant never opened the pictures.** Every "What the assistant saw on page N" line
   is invented from the criterion text: page 2 ("Textboxes have no accessible name", arrows at
   Name / G2G ID / TIN on the MRA Request form) became "the Workflow Type dropdown"; page 12
   (the bar chart) became "map pins"; page 13 (the map) became "a workflow stepper". The prompt
   says "look at it", and nothing checks whether it did. The call's stream says exactly which
   files the assistant opened, so the tool can know.
2. **Every deployed-site check landed on the app's own "Not Found" page.** The routes the
   assistant guessed (`/layout/form-panel`, `/layout/default`, `/layout/workflow-details`) do
   not exist; the known-routes list was empty because no crawl had run; the app's router
   rendered its 404 view with HTTP 200, which `evidence.mjs` counts as loaded (and an HTTP 404
   is excused on purpose at evidence.mjs:78). So all 11 screenshots show "Not Found", every item
   says "could not find this element", and the nine pages the tester had verified fixed came out
   as "Came back" — a page that is not there was taken as proof the problem is.

After this change the tool reads the stream to see which pictures were opened and asks again for
the pages whose picture was not, in small batches so the model actually looks; an answer given
without the picture is labelled as such on the screen. Routes are known before the assistant is
asked — from the crawl when one has run, and from the application's own router configuration
in the source folders otherwise — and the assistant must pick from them. A page that did not
really load (HTTP ≥ 400, or the app's own not-found view) is "could not be checked", never
"present": a tester-verified-fixed finding that could not be checked is reported as such, not
planned as a return.

## Acceptance criteria

1. **The stream says which files were opened.** `streamDecoder` (src/agent-stream.mjs) records
   every file a read tool opened — Gemini CLI's `read_file` / `read_many_files` (`file_path`,
   `absolute_path`, `paths[]`) and Claude Code's `Read` — as absolute paths, resolved against
   `cwd`, in `decoder.opened` (a Set), and `runAgent` returns it as `opened: string[]`. Path
   comparison uses one helper shared with the answer-file match from 67898b4 (case-insensitive
   and slash-agnostic on win32).

2. **Each picture must be opened, or the answer is asked again.** The describe stage sends
   candidates in batches of at most 4 per call (an env `A11Y_508_DESCRIBE_BATCH`, default 4,
   for tests). After each call the tool checks, per candidate in that batch, whether
   `opened` contains its page picture. A candidate whose picture was not opened is asked again
   — once, in a batch of its own kind — with the line "You answered for F3 without opening the
   picture of page 4 (<path>). Open it with your file-reading tool and look at it before
   answering; the callout's words and the arrows are only there." If the second call still did
   not open it, the answer is kept with `seenPicture: false` and a decision `read / tool / 'the
   assistant answered without opening the picture of page 4'`. The prompt itself says, at the
   top: "For each finding: first open its picture with your file-reading tool, then answer. An
   answer for a page whose picture you did not open is wrong and will be sent back."

3. **An unseen picture is said so on the screen.** Where "What the assistant saw on page N" is
   shown (plan items, already-fixed rows, Done rows, the decisions pane, decisions.md), a
   finding with `seenPicture: false` reads "The assistant did not open the picture of page 4;
   what it says below is a guess from the text: <seen>". The step's sentence after the read
   counts them: "11 findings read from the PDF: 9 the tester verified fixed, 2 open. The
   assistant did not open the pictures of 3 pages."

4. **Routes are known before the assistant is asked.** `knownRoutes(cwd)` (src/manual.mjs:213)
   becomes `knownRoutes(cwd, { startUrl, sourceDirs })` and returns full URLs from, in order:
   the crawl reports as today; then, for an Angular application, the routes read from the
   router configuration in the source folders — every `path: '...'` string inside a `Routes`
   array, `RouterModule.forRoot(...)` / `forChild(...)`, `provideRouter(...)` or `loadChildren`
   target, joined parent to child, with parameter segments (`:id`) and wildcards (`**`) left out
   — resolved against the start URL's path (so `/layout/` + `form-panel` → `…/layout/form-panel`
   only if the router says `form-panel` is a child of `layout`); then the start URL. The result
   is deduplicated and capped at 200. `src/routes.mjs` holds the scan (pure, node-tested on
   fixture router files: a flat `Routes`, nested `children`, `loadChildren` to another file, a
   `path: ''` default, a `**` wildcard, a `:id` parameter). The parsed list is written to
   `<run>/routes.json` and shown in the decisions pane as "Routes the tool knew: N (from the
   crawl / from the application's router)".

5. **The assistant picks a route from the list.** The describe and locate prompts show the
   known routes as the only choices and say "route: one of the known routes below, exactly as
   written; if none fits, give the closest and say so in decisions". A route the assistant gives
   that is not in the list and does not resolve to one (same path ignoring a trailing slash and
   the query) is replaced by the start URL with a decision `read / tool / 'took the start page
   instead of <route>' / 'it is not a route of the application'`; the locate step then offers
   the list again.

6. **A page that is not there is no evidence.** `evidenceBrowser.capture` (src/evidence.mjs)
   marks `loaded: false` with `error` "HTTP 404" for any status ≥ 400 (the 404 exemption goes),
   and `notFound: true` with error "the application shows its Not Found page" when the loaded
   document is the app's own not-found view: the `<title>`, the first `h1`/`h2`, or the `main`/
   `[role=main]` text's first 200 characters match `/\b(not found|page not found|404|no such
   page|does ?n.t exist)\b/i` and the main region has fewer than 60 words. The capture still
   writes the screenshot (so the person can see what the tool saw) and `summary.json` carries
   `notFound`, `title`, `heading` and `mainWords`.

7. **Could not be checked is its own outcome.** In the check stage, a finding whose capture did
   not load (`loaded: false`, including `notFound`) gets verdict `unreachable` from the tool
   without asking the assistant about it (the assistant is asked only about findings with
   evidence). Then: an unreachable finding with `status: fixed` is **not** planned and **not**
   "already fixed": it goes to a new list **Could not be checked (N)** on the screen and in the
   already-fixed report ("The tester verified this fixed on 28 Sep 2026; the tool could not open
   <route> (the application shows its Not Found page), so it could not confirm it."), and the
   Done sentence counts it ("… 2 could not be checked"). An unreachable finding with `status:
   open` or none is planned with the existing unreachable line. "Came back" requires a page that
   loaded and a `present` verdict from the assistant. The locate step (AC 4 of read-from-parse)
   runs for unreachable findings too, once, offering the known routes — a route change that
   then loads is captured and judged like any other.

8. **The fake agent and fixtures carry it.** `test/fake-agent.mjs`: `manual-describe` opens each
   candidate's picture (it reads the file, so a real stream/`opened` check can see it — the fake
   prints a Gemini-style `read_file` tool_use event for each when `FAKE_AGENT_STREAM_ONCE`/a new
   `FAKE_AGENT_STREAM=1` is set, and otherwise really calls `readFileSync` — the tool's check
   uses the stream, so the fake must emit the events); knob `FAKE_MANUAL_SKIP_PICTURE=F3,F5`
   (does not open those pictures on the first call; the second call opens them);
   `FAKE_MANUAL_SKIP_PICTURE_ALWAYS=F5`; `FAKE_MANUAL_BAD_ROUTE=F1` (gives a route not in the
   list); the manual fixture site (`test/manual-site.mjs`) gains an SPA-style not-found view
   (HTTP 200, title "Not Found", short main) at any unknown path and a real HTTP 404 at
   `/gone`. The fixture app under `test/fixtures/manual/app/` gains an Angular-style
   `app.routes.ts` naming its routes so AC 4 is exercised end to end.

## How this fails silently

1. **(a) Opened files are not read from the stream.** Mutation: `opened` always empty. Red:
   with the fake agent opening every picture, every finding is `seenPicture: false` and the
   sentence says "did not open the pictures of 10 pages"; expected: none.
2. **(b) An unopened picture is not asked again.** Mutation: skip the second ask. Red: with
   `FAKE_MANUAL_SKIP_PICTURE=F3,F5`, F3 and F5 end `seenPicture: false`; expected: true, with a
   second describe call whose prompt names only F3 and F5 and the "without opening the picture"
   line (`agent-describe-*.log`).
3. **(c) Batches are not small.** Mutation: one call for all. Red: with 10 candidates and the
   default batch, at least 3 describe calls exist; under the mutation, 1.
4. **(d) A guessed answer is shown as seen.** Mutation: drop the "did not open the picture"
   wording. Red: with `FAKE_MANUAL_SKIP_PICTURE_ALWAYS=F5`, F5's plan item lacks the words "did
   not open the picture of page" (`data-testid="seen-unseen"`).
5. **(e) Router routes are not found.** Node: the fixture router files yield the expected list
   (nested, lazy, default, no `**`, no `:id`). Mutation: return only the crawl's routes → red.
   E2e: with no crawl run, the describe prompt lists the fixture app's routes.
6. **(f) A made-up route is kept.** Mutation: accept any route. Red: with
   `FAKE_MANUAL_BAD_ROUTE=F1`, F1's url is the start URL and the decision "took the start page
   instead of" is logged; under the mutation, the capture lands on the not-found view.
7. **(g) Not Found counts as loaded.** Mutation: restore the 404 exemption / drop the
   not-found detection. Red: a finding routed to `/gone` (HTTP 404) and one routed to the SPA
   not-found view both get verdict `unreachable` with the "Not Found" reason; under the
   mutation they are `present`.
8. **(h) An unchecked verified-fixed finding is planned as a return.** Mutation: treat
   unreachable as present. Red: a tester-verified-fixed finding on an unreachable route appears
   under "Could not be checked (1)", not in the plan and not under Already fixed; the Done
   sentence says "1 could not be checked".
9. **(i) The assistant is asked about pages it cannot see.** Mutation: include unreachable
   findings in the check prompt. Red: the check call's machine-readable block lists only
   findings with `loaded: true`.
10. **(j) Routes are not shown.** Mutation: no "Routes the tool knew" line. Red: the decisions
    pane lacks it.

## Non-goals

- No change to the parse, the plan/confirm/fix/replan prompts, or the fix stage.
- No crawl is started by the manual flow; routes come from past crawls and the router config.
  Non-Angular applications get the crawl's routes and the start URL only (React Router etc.
  are a later plan).
- The tool does not judge what a picture shows; it only knows whether the picture was opened.

## Where things live (for the builder)

`src/agent-stream.mjs` (`TOOLS` 16-27, `tool()` ~52-62, Gemini event 84, Claude blocks 107;
add `opened`), `src/agent.mjs` (`runAgentOnce` ~283-354 returns `opened`; the path helper from
67898b4; `manualDescribePrompt` 518-570 — batches, the "open the picture first" rule, the
routes rule; `manualLocatePrompt` 576-610), `src/manual.mjs` (`knownRoutes` 213-224; the
describe stage 620-660 with `askForAll` 462 — batching and the picture check; check stage
~700-760 — unreachable by the tool, the new list; already-fixed report and Done counts
~590-640, 983+; `unreachableLine` 182), `src/evidence.mjs` (`capture` 59-125: status 72-79,
not-found detection after load, `summary.json`), new `src/routes.mjs`, `src/components.mjs`
(`isAngular`, `walk`), `ui/app/screens/manual-panel.ts` (seen lines; the new Could not be
checked section), `ui/app/shared/decisions-pane.ts`, `ui/app/core/manual.ts`,
`ui/server/app.mjs` (`/api/manual/:id/decisions` groups). Tests: `test/fake-agent.mjs`
(manual kinds 108-200), `test/manual-site.mjs`, `test/fixtures/manual/app/`,
`test/fixtures/routes/` (new router fixtures), `test/routes.mjs` (new, in `npm test`),
`test/manual-read.mjs`, `ui/e2e/manual.spec.ts`, `test/event-schema.mjs`. Rebuild `ui/dist`
with Node 22 before each spec run; `freshness` must pass. Local gate: `npm --prefix ui run
typecheck && npm --prefix ui test && npm test && npm --prefix ui run e2e`.
