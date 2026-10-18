# The PDF run crawls the site first, so the pages it offers are real pages with real ids

slug: manual-crawl-first
branch: manual-crawl-first

## Intent

Joel's run of 2026-10-18 (build ec6192e): the assistant read every page of the tester's PDF
correctly, but the tool knew only six routes — read from the application's router, with every
`:id` segment left out — and none of them was the screen the tester had photographed. The company
form (pages 2–6) is a detail page of one MRA request; the status badges (7–8) are on a request's
detail page; the tables (9–10) are the results lists; the charts and the map (12–13) are a
program's dashboard. The assistant guessed `/layout/search` and `/layout/default` from the list
it had, the tool looked there, found nothing, and (until e03207c) the assistant called the nine
tester-verified findings "already fixed" because the fields "do not exist on the page". e03207c
makes an element that was not found count as could-not-be-checked. This plan makes the pages
findable in the first place: before the assistant is asked, the PDF run crawls the deployed site
with the tool's own crawler — the same one the loop uses, signed in with the saved session — so
the known routes are the real URLs the application links to, ids included, and each one comes
with its title and headings so the assistant can match a screenshot to a page by what is on it.

## Acceptance criteria

1. **A crawl before the read, when the tool has none.** After the parse and before the describe
   stage, when `routeSources(cwd)` has no route from a crawl report (only the router's and the
   start URL), the PDF run crawls: `src/manual.mjs` spawns the crawler as `crawlOnce` does
   (src/loop.mjs:276-281: `BIN`, `cfg.url`, `cfg.args`, the passthrough, the session args,
   `--out <run>/crawl`, `--json`, `--quiet`, `--events` when the run has events) with
   `--max-pages 60` unless `cfg.manualCrawlPages` says otherwise (0 = skip the crawl). The
   sentence meanwhile: "Looking over the deployed site so the tool knows its pages (14 found so
   far)." — the count from the crawl's page events. A crawl that needs a sign-in opens the
   sign-in tab as the check stage does (the `sign-in` stage, src/manual.mjs ~596-600) and runs
   again once. A crawl that fails (exit ≠ 0, no `report.json`) is logged as a decision
   (`read / tool / 'the site could not be looked over' / <reason>`) and the run goes on with the
   routes it has. A second run of the same PDF (or a restart) reuses `<run>/crawl/report.json`
   and does not crawl again; a run whose work folder already has crawl reports from the loop
   (`round-*/report.json`) does not crawl either.

2. **The crawled pages are the routes, with what is on them.** `routeSources` gains the pages
   of `<run>/crawl/report.json` first (source `'crawl'`), then the loop's rounds, then the
   router's, then the start URL — deduplicated by URL without its query and trailing slash,
   capped at 200. Each route carries `title` and `headings` (the page's `<title>` and its
   `h1`/`h2` texts, which the crawler's `report.json` already records per page — confirm the
   field names in `src/report.mjs` / `src/audit.mjs`, and add `headings` to the page record if
   the report has only the title). The describe and locate prompts list each route as
   `- <url> — "<title>": <h1>, <h2 …>` (headings joined, ≤ 120 chars) and say "pick the route
   whose title and headings match what the picture shows". `routes.json` and the "Routes the
   tool knew" decision say where they came from: "Routes the tool knew: 38 (from looking over
   the site; 6 from the application's router)".

3. **Detail pages with ids are offered as they were found.** A crawled URL keeps its id
   (`/layout/mra-request/BR-1234g`); the router scan still drops `:id` routes. When several
   crawled URLs differ only in their last segment and share a title (five request detail
   pages), they are one entry in the prompt — the first URL, with "(and 4 more like it)" — so
   the list stays short; `routes.json` keeps them all, and the locate step may be offered the
   full set for that entry when its first URL matched nothing.

4. **The dashboard says it, and the Log keeps it.** The home screen words the `crawl` stage
   (home.ts `manualNow()`); the decisions pane and `decisions.md` carry the routes line; the
   crawl's own `report.html`/`report.json` are linked from the decisions pane ("the site as the
   tool saw it") through `GET /api/manual/:id/crawl/<file>` (path validated like `parsed/`).

5. **The fake and the fixtures.** The e2e fixture site (`test/manual-site.mjs`) gains a detail
   page `/items/:id` linked from `/search` (three ids, same title "Item"), and the fixture app's
   router names `items/:id`. `test/fake-agent.mjs`'s describe picks, for a candidate whose
   quote names "Item", the first `/items/` route in the list (so the e2e proves a crawled id
   page is chosen and found). Knob `FAKE_MANUAL_NO_CRAWL=1` is not needed: the e2e controls the
   crawl through `cfg.manualCrawlPages`.

## How this fails silently

1. **(a) No crawl.** Mutation: skip the crawl stage. Red: with the fixture site, `<run>/crawl/
   report.json` is missing, the prompt lists no `/items/` route, and the "Item" finding is not
   located.
2. **(b) Crawled routes do not reach the prompt.** Mutation: `routeSources` ignores the crawl
   report. Red: the describe prompt has no `/items/1` line and the routes decision says "0 from
   looking over the site".
3. **(c) Titles and headings are missing.** Mutation: list bare URLs. Red: the prompt's route
   line for `/search` lacks `"Search"`.
4. **(d) A crawl runs twice.** Mutation: crawl on every run. Red: after a dashboard restart during
   the read, there is one `crawl/report.json` and one crawl call in the run's journal; with
   `round-1/report.json` present from a loop, no `crawl/` folder at all.
5. **(e) A failed crawl stops the run.** Mutation: throw on exit ≠ 0. Red: with
   `cfg.url` pointing at a closed port for the crawl only (the fixture lets the crawl fail:
   `app.site.setCrawlFails(true)` answers 500 to the crawler's user agent), the run still
   reaches the plan and the decision "the site could not be looked over" is logged.
6. **(f) Ids collapse wrongly.** Node: `groupRoutes()` groups `/items/1`, `/items/2` ("Item")
   into one entry "(and 1 more like it)" and keeps `/items/1` and `/orders/1` apart; a group's
   members are all in `routes.json`.
7. **(g) The crawl files are open.** Server unit test: `GET /api/manual/<id>/crawl/../source.pdf`
   is 404; `crawl/report.json` is 200.

## Non-goals

- The crawl does not fix anything and writes nothing to the ledger; it is the loop's crawler run
  once for its page list.
- No change to the loop, the parse, or the plan/confirm/fix/verify prompts.
- No change to how routes are matched (AC 5 of pictures-and-routes stays).

## Where things live (for the builder)

`src/manual.mjs` (stages 655-890: add `crawl` between `parsed` and `read`; `routeSources` /
`knownRoutes` 213-290; `browserArgs`/`sessionArgs`/`signIn` 590-600; `routesLine` 288),
`src/loop.mjs` (`crawlOnce` 276-330 — extract the spawn-and-read into a shared helper rather
than copying it; `BIN`), `src/routes.mjs` (router scan; `groupRoutes` new), `src/agent.mjs`
(`manualDescribePrompt` ~518-570 and `manualLocatePrompt` ~576-610: the routes block),
`src/report.mjs` / `src/audit.mjs` (per-page title/headings in `report.json`), `ui/server/
app.mjs` (`manualApi` ~923: the `crawl/` files), `ui/app/screens/home.ts` (`manualNow()` ~540),
`ui/app/shared/decisions-pane.ts`, `ui/app/core/manual.ts`. Tests: `test/manual-site.mjs`
(detail pages, `setCrawlFails`), `test/fixtures/manual/app/` (router), `test/fake-agent.mjs`
(describe route choice ~195-210), `test/routes.mjs` (`groupRoutes`), `ui/e2e/manual.spec.ts`,
`ui/server/test/parsed.test.mjs` (model for the path test), `test/event-schema.mjs` (the `crawl`
stage). Rebuild `ui/dist` with Node 22 before each spec run; `freshness` must pass. Local gate:
`npm --prefix ui run typecheck && npm --prefix ui test && npm test && npm --prefix ui run e2e`.
