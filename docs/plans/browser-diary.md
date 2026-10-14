# The diagnostics diary: why a browser went away

slug: browser-diary

On a Windows laptop the dashboard's own Chrome window keeps disappearing during long fix loops
("Restore pages? Chrome didn't shut down correctly" when it is opened again: its process was
killed or crashed, not closed), and nobody can say why. The server starts that Chrome with its
output thrown away and, when it exits, prints only "the dashboard's window was closed". This change
records every exit of every browser a11y-508 depends on, with its cause, in an append-only diary;
shows it in the dashboard; makes a11y-508's own kill paths unable to reach the dashboard's browser;
and lets a crawl survive one death of its own browser.

## Acceptance criteria

1. When the dashboard's own browser exits, an entry is appended to `<state base>/diary.ndjson`
   (`~/.a11y-508/diary.ndjson`, `%APPDATA%\a11y-508\diary.ndjson` on Windows, `A11Y_508_HOME`
   in tests) with: exit code and signal, the time, the last ~50 lines Chrome wrote to stderr, what
   the dashboard was doing (the active run's kind, round, step in words, last event), and, when an
   a11y-508 kill happened in the 5 seconds before, which one (`stop`, `check-time-limit`,
   `crawl-close`, `detection-timeout`, `quit`). Kills made by the CLI (the check time limit, a
   crawl's browser close) are seen too: every kill path writes a `kill` entry when it fires.
2. The diary also records: a crawl's or sign-in's browser dying mid-run (exit code/signal and its
   stderr tail, or the lost connection for `--connect`); a run that ends with an error or is
   interrupted; the server starting, and stopping with its reason (`ctrl-c`, `sigterm`, `quit`,
   `idle`, `crash` — an uncaught exception or unhandled rejection is written before the process
   exits). Cookie, header and token values are never written (the same redaction as the run
   journal, plus `Bearer …`/`cookie:`/`authorization:` patterns).
3. The terminal prints one sentence for an own-browser exit: "The dashboard's browser window closed
   at 4:52 PM (Chrome was killed — exit code 1, signal none — during round 2, checking fix 3;
   a11y-508 had just run Stop)." The cause in words: killed (a signal, or exit code 1 on Windows),
   crashed (a Windows exception code), closed normally (code 0), or exited unexpectedly.
4. The dashboard shows a persistent notice at the top of the wizard with that sentence, a
   **Reopen the window** button (does what a second launch does: the server's `reopen()`), and a
   **Details** link to Diagnostics. The notice stays until dismissed; once the window is open
   again the Reopen button gives way to "The window is open again".
5. A **Diagnostics** screen at `/diagnostics`, linked from the header's small text and from the
   notice, lists the diary newest first in plain words (time, sentence, and the details: code,
   signal, stderr tail), with a **Copy diagnostics** button that copies the last 50 entries as text.
6. `killTree` (src/chrome.mjs) and `killTreeWindows` (ui/server/runs.mjs) refuse — return
   `{ refused: true }`, kill nothing, and write a "refused to kill …" diary entry — the calling
   process, its ancestors (the `ps` parent chain on POSIX; `process.ppid` on Windows), the
   dashboard's own browser, and any dashboard server and own browser recorded in
   `<state base>/server-<port>.json`. The second sweep of `killTreeWindows` never adds a protected pid.
7. The `--connect` code path never sends `Browser.close`. A crawl in `--connect` mode whose browser
   goes away ends with the error "the browser the crawl was using closed: …" (no stack trace), exit
   code 2, and the run's `done` event carries that reason, which the dashboard's notice shows.
8. When a crawl's own launched (headless) browser dies mid-crawl, the crawl launches it once more
   and continues from the next page; the page in flight is recorded with the error; the report's
   coverage notes say so, and the diary has the death. A second death ends the crawl with the
   recorded cause.
9. Windows-safe: stderr is piped and drained (never blocks), `windowsHide` on the crawl's browser,
   no PowerShell or wmic for the refusal (pids are compared directly; ancestry is `process.ppid`).

## How this fails silently

1. **The own browser's exit is not written.** Server test: the dashboard launched with a fake own
   browser (a Node script that prints to stderr and exits with code 3 when asked), an adopted loop
   run at round 2 checking fix 3, the fake told to exit: the diary entry has code 3, the stderr
   text and "round 2, checking fix 3". Mutation: drop the `writeDiary` in the own-browser exit handler.
2. **The last-kill record is lost.** Server test: Stop on the active run, then the fake browser
   exits within 5 s; the entry says `kill: 'stop'` and the sentence says "a11y-508 had just run
   Stop". Mutation: remove `recordKill('stop')` from Stop.
3. **The refusal is gone.** Test: `killTreeWindows(protectedPid)` and `killTree(protectedPid)`
   return refused and the process is alive; a child process's `killTree(process.pid)` returns
   refused and the child survives. Mutation: remove the refusal check.
4. **The notice is hidden.** Playwright: dashboard with the fake own browser, the fake told to
   exit; the page shows the sentence and **Reopen the window**; Reopen starts the browser again.
   Mutation: never render the notice.
5. **No relaunch.** Core test: a fixture crawl with `--concurrency 1` whose browser is killed after
   page 2 (`A11Y_508_TEST_KILL_BROWSER_AFTER=2`) audits pages 3+ without error and has the coverage
   note. Mutation: skip the relaunch (treat the first death as final).
6. **Diagnostics lists nothing.** Playwright: a seeded diary; `/diagnostics` shows its newest
   entry's sentence first, and Copy diagnostics puts that text on the clipboard. Mutation: render
   an empty list.
7. **Connect mode sends Browser.close / dies with a stack trace.** Core test: a `--connect` crawl
   against a Chrome the test started records every CDP method sent (none is `Browser.close`); the
   test kills that Chrome after the first page and the CLI exits 2 with "the browser the crawl was
   using closed:" and no stack. Mutation: send `Browser.close` from connect-mode `close()`.

## Non-goals

- Deciding the cause on the reporter's laptop: this change makes it visible; the fix follows the
  first diary that shows it.
- Relaunching the dashboard's own browser automatically (Reopen is a person's choice).
- Relaunching a `--connect` or `--login --stay` browser (it is a person's window).
- Rotating or uploading the diary anywhere; it stays on the machine (capped at ~1 MB, oldest lines
  dropped).
- Changing how Stop, Quit or the check time limit kill what they kill today.
