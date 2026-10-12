---
name: local-gate
description: Prove a change locally in fast-fail order, push, and report without waiting on CI. Use before pushing any branch, and to decide whether a PR may merge on the local run or must wait for the check.
---

# The local gate

The local run is the evidence; CI is the witness. This skill is the order to
run the suite in so a failure costs seconds rather than minutes, and the rule
for what happens after the push.

This repository has two halves with different rules:

- **The core** (`bin/`, `src/`, `test/`): zero dependencies, Node 18+, plain
  JavaScript. Its suite is `npm test` at the root (`test/run.mjs` against the
  fixture site, then `test/loop.mjs` with the fake agent). It needs Chrome,
  Chromium or Edge (`CHROME_PATH` if not auto-detected).
- **The UI** (`ui/`), once it exists: Angular, its own `package.json` and
  lockfile, Playwright e2e under `ui/e2e/`. It may have dependencies; the core
  may never import from it.

| layer | command | what it catches |
|---|---|---|
| one fixture page | `node test/run.mjs --only /checks-focus.html` | a check against one page in seconds: the narrowed run for writing and mutation-testing a core check |
| UI typecheck | `npm --prefix ui run typecheck` | a component or spec that does not compile |
| UI unit | `npm --prefix ui test` | services, pipes, the event-stream parser |
| one Playwright spec | `npx --prefix ui playwright test ui/e2e/<area>.spec.ts` | the area you touched, and your new guard |
| core suite | `npm test` | the CLI, the crawl, the report, the loop |
| **the full suite** | `npm test && npm --prefix ui run e2e` | everything |

Kill anything listening on the UI's test ports before a Playwright run.

## Before the push: fast-fail order

Run the cheapest layer that can see your change first. Do not start with the
full suite.

1. **Typecheck the UI** if anything under `ui/` changed.
2. **The core suite** if anything under `bin/` or `src/` changed. The core
   still has no dependencies afterwards: the root `package.json` has no
   `dependencies` and `node bin/a11y-508.mjs --help` runs from a clean clone
   with no `npm install`.
3. **The one spec for the area, then your guard's mutation.** Break what the
   guard guards, run the spec narrowed with `-g "<test name>"`, read the
   file:line it fails on, restore. Red on the new assertion is evidence; red
   anywhere else is not. Never a whole spec file for a mutation.
   Repeat 1–3 as often as the work needs.
4. **The full suite once, on the final tree, with `git status` clean**: once
   per PR, after every fix is in, never mid-build. **Nothing else heavy runs
   alongside it**: two Chrome-driving suites on one machine time out tests
   that pass alone, and a flaky red is a whole rerun.
5. **Confirm the branch is not behind `main`**:
   `git fetch origin && git rev-list --count HEAD..origin/main` must print 0.

## After the push: report, do not wait

Push, open the PR, and report, with the mutation evidence and the full-suite
result from step 4. **Do not wait for CI before reporting.**

## Merging: the local run is the evidence, with four conditions

A PR may merge on the local run when **all** of these hold:

- The full suite passed on the exact commit being merged, tree clean (step 4).
- The branch is 0 commits behind `origin/main` (step 5).
- The change touches **none of** `ui/package-lock.json`, `.github/workflows/`,
  or the root `package.json`'s `engines`, `files` or `bin`. CI runs Node 18,
  20 and 22 on Linux; those are where a macOS run can disagree with it.
- The PR body says it was merged on the local run.

A PR touching any of them waits for the check.

## After the merge: read the check anyway

CI still runs on the merged commit. **Open it.** A red check on a merged PR is
a regression to be reverted or fixed forward that hour, never "it was green
locally."

Nothing here deploys or publishes.
