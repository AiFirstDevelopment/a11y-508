# The tool keeps its files outside the app's repository

slug: tool-files
branch: main

On a government laptop the fix loop runs Gemini CLI in the app's repository. The live pane showed Gemini
reading `a11y-508-work/ledger.json`, `agent-r1-fix-0.log`, and searching `a11y-508-work` for "failed-gate" and
"gateCommand": studying the tool's own bookkeeping instead of fixing the app, minutes per fix, and in a
position to game the check. The user also asked that the tool never litter the app's repository. Today the
loop's work folder (`a11y-508-work/`: ledger, prompts, results, agent logs, the `runs/` journal), the crawl
output (`a11y-508-report/`) and the dashboard's earlier crawls (`a11y-508-history/`) live inside the
repository, hidden from git through `.git/info/exclude`. They move to a per-repository folder under the
dashboard's state base, the prompts stop naming them, and the assistant is told to leave them alone.

## Acceptance criteria

1. One function in `src/` (`src/home.mjs`) maps a repository folder to its own folder under the state base
   (`~/.a11y-508`, `%APPDATA%\a11y-508` on Windows, `A11Y_508_HOME` for tests):
   `repos/<basename>-<6 hex of sha1(real absolute path)>/` holding `work/`, `report/` and `history/`. On
   Windows the path is hashed case-insensitively. The CLI (`loop`, `status`, a crawl's default `--out` when run
   inside a git repository) and the dashboard (Results, History, Fix, Needs a person, the run journal) use it.
   After a loop, a crawl from the dashboard, or a crawl from the CLI inside a repository, the repository holds
   no `a11y-508-work`, `a11y-508-report` or `a11y-508-history`, and `.git/info/exclude` gains nothing.
2. Existing folders are migrated once, on first use (CLI `loop`/`status`/default-out crawl, the dashboard on
   launch and on a folder switch): `a11y-508-work`, `a11y-508-report` and `a11y-508-history` found directly
   inside the folder (real directories, not links) are moved to the new place; if the destination already
   exists, the repository's copy is moved aside as `<work|report|history>-old` (then `-old-2`, …) next to it and
   reported. The `.git/info/exclude` lines the tool added are removed. After the move the ledger, the rounds,
   the history and the run journal work: `a11y-508 status` reports the migrated ledger; the dashboard's
   Results/History/Fix/Needs-a-person read from the new place; Start over, the folder carry (same URL, new
   folder) and resume keep working.
3. The prompts (`fixPrompt`, `triagePrompt`) name no path inside the repository for the tool's files. The
   prompt and result files live in `<work>/tasks/`, under the state base. The fix prompt says: "Everything you
   need is in this prompt. Do not read, search or edit anything outside the source folders listed above; in
   particular leave the tool's own folders alone." The protected list contains no repository path. The
   assistant's output lines that mention the state base are shown in the pane with the base shortened to
   `~/.a11y-508/…`.
4. `--out <dir>` given explicitly still writes there, anywhere. Outside a git repository the CLI's default
   stays `./a11y-508-report`. The README's runbook and "How it works" say where the tool keeps its files, per
   repository, and how to find them (`a11y-508 status` prints the folder).
5. While a loop runs, the Fix step's counts line reads "0 fixed · 20 remaining, in 8 fixes this round · 4 need
   a person" when the round's fix tasks (8) differ from the remaining findings (20) because findings are
   grouped; with no grouping, or no loop running, the clause is absent.

## How this fails silently

1. **The ledger is still written into the repository.** Mutation: `workDir` returns `join(cwd,
   'a11y-508-work')`. The core loop test asserting that the repository has no `a11y-508-work` after a loop and
   that the ledger exists under the state base goes red.
2. **The migration is skipped.** Mutation: `migrateRepo` returns without moving. The core test that seeds an
   old-style `a11y-508-work/ledger.json` with 3 attempts and asserts `a11y-508 status` reports them, and the
   repository no longer has the folder, goes red.
3. **The prompt still names repository paths.** Mutation: `WORK_DIR`/`a11y-508-report` put back into the
   protected list, or the sentence dropped. The core test reading the written prompt file and asserting no
   `a11y-508-work`/`a11y-508-report` and the "leave the tool's own folders alone" sentence goes red.
4. **The report folder is still in the repository.** Mutation: the dashboard's crawl does not pass `--out`
   (the CLI default) with the CLI default left at `./a11y-508-report`. The Playwright test crawling from the
   dashboard and asserting Results shows the report while the repository has no `a11y-508-report` goes red.
5. **The "in N fixes this round" clause is dropped.** Mutation: `fixCounts` ignores the task count. The
   Playwright counts test with grouped findings goes red.
6. **The migration reaches beyond its named folders.** Mutation: the migration moves a folder
   named otherwise, or a link. Server unit test: a symlinked `a11y-508-work` and an unrelated folder stay where
   they are; nothing outside the named folders is touched.
7. **The pane shows the state base in full.** Mutation: the shortening is removed. Core test: an agent that
   prints its result path; the `agent-output` event shows `~/.a11y-508/`, not the base.

## Non-goals

- The sign-in session (`a11y-508-state.json` for the CLI) and a team's committed `a11y-508.config.json` stay
  where they are; the dashboard already keeps its own copies under the state base.
- No change to the report format, the ledger format, or the explicit `--out`.
- No cleanup of a `.gitignore` the person wrote; only the `.git/info/exclude` lines the tool added are removed.
- No sandboxing of the assistant beyond the prompt and the presets' write access to the task folder.
