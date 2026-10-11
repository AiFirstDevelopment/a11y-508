---
name: implement
description: Build the plan at docs/plans/implement.md -- or, given a code such as MD, docs/plans/implement.MD.md -- in this session, with an e2e test for every acceptance criterion and every guard, verify the build in a fresh subagent, apply one bounded fix round, and open a PR without waiting on CI. Use when a plan is written and ready to build.
---

# implement

One builder, one verifier, one PR. Quorum without the six lenses, the scribe,
the verdict file and the guard step. The part kept is the part that paid for
itself every time in September 2026: **verification in a fresh context that did
not build the thing.** The session builds; a subagent verifies.

## The plan it reads

`docs/plans/implement.md`, or with an argument -- `/implement MD` --
`docs/plans/implement.MD.md`, so several plans can wait their turn under their
own names. Whichever file it is, step 4 renames it to `docs/plans/<slug>.md` in the branch. Stop and say
what is missing if it lacks:

- A **title** and a paragraph of intent.
- **Acceptance criteria**, numbered. Each is a sentence about observable
  behaviour, never a restatement of an implementation.
- **How this fails silently**, numbered — the guards. Each names a failure and
  the mutation that proves a test can see it. If the plan has none, derive one
  guard per acceptance criterion and say so in the PR body.
- **Non-goals.**
- Optionally `branch:` and `slug:` on their own lines near the top. Without
  them, both derive from the title.

"100% e2e coverage" means **every acceptance criterion and every guard has a
Playwright test through the outermost surface, mutation-tested, with isolation
recorded.** It is coverage of the plan, not of lines. The deliverable is the
table in the PR body; a row missing is the work not done.

## Steps

1. **Preconditions.** Plan parses. `git status` clean. `git fetch origin`, then
   branch off `origin/main`. Read `README.md`'s Development section and the
   `local-gate` skill; both apply throughout.
2. **Build**, section by section. **A defect found in your own change is fixed,
   not flagged.** Report only decisions you could not make alone. Declare every
   deviation from the plan as it happens, and if the plan is wrong about the
   code, say so rather than working around it. **While building, run only the
   specs in scope** — the ones for the area, the UI typecheck, and the
   core suite if anything under `src/` or `bin/` changed. Never the full suite mid-build.
   - **Before changing a shared rule** (a CLI flag or its output, the
     `report.json` shape, a helper every spec calls, a component on every
     screen), grep `test/` and `ui/e2e/` for what depends on it — and fix those specs in the same pass. That is how the
     breakage is found in seconds; the full suite finds it minutes later,
     once per round.
3. **Cover.** One e2e test per acceptance criterion and per guard, asserting
   the observable effect, not a proxy. For each guard: break the thing, run
   **that guard's test only** (`-g`), read the file:line it fails on, restore.
   Red on the guard's own assertion is the evidence; red anywhere else is not.
   Never run a mutation against a whole spec file or the suite: it
   costs minutes and proves nothing the narrowed run does not. Re-measure every line number on the final tree.
4. **Commit locally.** Explicit paths, never `git add -A`. No `Fixes #` /
   `Closes #` / `Resolves #`. Attribution per the session's current rule. Rename
   the plan to `docs/plans/<slug>.md` in the same branch, so `implement.md` is
   free for the next one and the design is kept under its subject.
5. **Verify.** Spawn one subagent with the prompt below, in its own worktree
   (`isolation: "worktree"`), so its temporary mutations cannot touch this
   checkout. Read-only. Its report comes back to this session and nowhere else.
   While it runs, touch nothing and run nothing heavy.
6. **One fix round, bounded.** A finding specified to the line is applied here
   directly; touch only what it names; re-run the affected spec and its
   mutation, narrowed; commit. A finding that needs a design decision is not
   fixed — it goes in the PR body as a named follow-up with the verifier's
   scenario. There is no second round.
7. **The full suite, once.** `local-gate` steps 4–5: the full suite on the final
   commit, tree clean, branch 0 behind `origin/main`, **with nothing
   else running on the machine** — a verifier's or another session's suite
   alongside it times out tests that pass alone, and a flaky red costs a whole
   rerun. This is the one full run a PR gets, and it is the merge evidence.
   Removing the verifier's worktree comes first (`git worktree remove`), so the
   tree is clean.
8. **Push and open the PR** with the body template below.
9. **Report and stop.** PR URL, the coverage table, the verifier's verdict,
    every deviation, and merge eligibility per `local-gate`'s four conditions —
    stated, not acted on. **Do not wait for CI. Do not merge. Do not deploy.**

## The verifier prompt

Fill the brackets; send the rest as written.

> You are verifying an implementation against its plan in [repo path]. **You
> review and report. You fix nothing and change nothing.** You may apply a
> mutation temporarily to test a guard; restore it and confirm the tree is
> clean before finishing.
>
> Plan: `docs/plans/[slug].md`. Implementation: branch `[branch]`, local
> commits — `git fetch origin && git diff origin/main...[branch]`. Read
> `README.md` and `.claude/skills/local-gate/SKILL.md` first.
>
> Report four things, most severe first, each with file:line and a concrete
> failure scenario. **Scope is what this change did and anything it broke; do
> not look for adjacent improvements.**
>
> 1. **Faithfulness.** Walk every numbered acceptance criterion and every
>    non-goal. Quote the code. Where it differs, say whether the difference is
>    an improvement, a defect, or an undeclared deviation. The builder declared
>    these deviations: [list]. Assess each on its merits.
> 2. **The guards.** For every entry in "How this fails silently", find the
>    test, confirm it asserts the observable effect at the outermost surface,
>    then **re-run two or three mutations yourself**, choosing the guards you
>    trust least — apply, run that guard's test only (`-g`), confirm red on its
>    own assertion at the file:line you expect, restore. Never a whole spec file.
> 3. **Constraints, driven not read.** [The plan's "what must not move" list,
>    or the invariants a reader would assume.] Exercise each against the real
>    CLI or the real UI. Where the builder claims CLI behaviour is unchanged,
>    diff its output and `report.json` against `origin/main` on the fixture site.
> 4. **General mistakes** in what changed: correctness, silent failure,
>    interactions the plan did not anticipate.
>
> Mechanically: the root `package.json` gains no dependency (the core has none
> and keeps none); no `ui/package-lock.json` change unless the plan says so; no
> existing test weakened or deleted (`--numstat` under `test/` and `ui/e2e/`).
> **Do not run the full suite** — the builder runs it once, on the commit
> that merges, after your findings are applied; a run here is on a commit that
> will not merge. Run specs, narrowed, only where a claim needs driving. Aim to
> report within about ten minutes.
>
> **If it is clean, say so plainly and without hedging.** Your report is the
> only thing the person who spawned you will see.

## The PR body

```
Implements docs/plans/<slug>.md. [One sentence of intent.]

## Coverage
| # | acceptance criterion / guard | test | file:line | mutation | red at |
|---|---|---|---|---|---|

## Verification
[Verdict, one line. Findings applied in the fix round, each with its
file:line. Findings deferred, each with the verifier's scenario.]

## Deviations from the plan
[Each, with why. "None" if none.]

## Merge eligibility
Full suite on <sha>, clean tree, 0 behind main: [yes/no]. Touches
root package.json dependencies / ui/package-lock.json / .github/workflows: [none / which].
[Merges on the local run / must wait for the check.]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## What this does not do

- No `docs/work/<slug>/`, no review files, no verdict file. The verifier's
  report is in the PR body.
- No merge and no deploy. Both stay deliberate; the merge conditions are
  `local-gate`'s.
- No second fix round. If one does not clear it, the PR says so and a person
  decides.
- No waiting on CI, ever. The check runs and is read after the merge, per
  `local-gate`.
