# The fix loop, end to end on Windows with Gemini CLI

branch: loop-gemini-ci
slug: loop-gemini-ci

Written 2026-10-12. The fix loop (`a11y-508 loop`) is tested today with a
fake agent (`test/loop.mjs`), which proves the plumbing but never a real
assistant editing real markup. This round adds a CI job that proves the whole
product on Windows: crawl a small web app with planted Section 508
violations, let the loop repair them with Gemini CLI's free tier, and confirm
the repairs with the next crawl.

## Intent

A person who points the loop at their app should get commits that fix real
findings, gated by their own check, confined to their source folder, and
confirmed by a second crawl. A CI job on `windows-latest` runs exactly that
against `test/loop-app/` with Gemini CLI, and a script asserts the outcome
without pinning the model's exact behaviour. Rate limits on the free tier are
expected: the agent adapter retries on quota errors, and a run in which every
call was refused for quota is reported as skipped, not failed.

## The change

1. **`test/loop-app/`**: a static site under `site/` (four pages: home with
   images, a contact form, an opening-hours table, a gallery with a modal
   viewer, plus `site.css`) with about ten planted, deterministic
   violations, each marked by an HTML comment: missing alt, an unlabelled
   field, low-contrast CSS, a page without `lang`, the same link text for two
   destinations, a page with no skip link, main or heading, a fieldset with
   no legend, an icon-only button, `scope="column"`, and `aria-labeledby`.
   `server.mjs` serves it (Node only); `check.mjs` is the gate (every page
   still parses: doctype, one html/head/body, balanced container elements;
   and the server still serves every page), and logs each run with the files
   changed at that moment to `a11y-508-gate.log`; `setup.mjs <dir>` makes the
   throwaway git repository (the app at its root, the config, a
   `.gitignore`, one commit); `verify.mjs <dir>` holds the assertions. Not
   served by the fixture site, so the golden crawl does not change.
2. **Quota handling in `src/agent.mjs`**: when an agent call returns no
   result and its output names a quota or rate limit (HTTP 429,
   `RESOURCE_EXHAUSTED`, "quota", "rate limit", "too many requests"), it is
   run again after a backoff (30 s, then 90 s; two retries), and the call's
   outcome records `quota` and `quotaRetries`. The loop did not retry before.
3. **Agent logs in `src/loop.mjs`**: each agent call's output (a JSON header
   line with exit code, time-out, quota and retries, then the tail of stdout
   and stderr) is kept as `a11y-508-work/agent-r<round>-<task>.log`, beside
   the prompt and result files, and a fix attempt ended by quota carries that
   in its note.
4. **Gemini CLI's folder trust**: current Gemini CLI refuses to run headless
   in a directory it has not been told to trust. When the agent command runs
   `gemini`, the loop sets `GEMINI_CLI_TRUST_WORKSPACE=true` in the agent's
   environment unless it is already set.
5. **`.github/workflows/loop-gemini.yml`**: `windows-latest`, Node 22,
   `npm install -g @google/gemini-cli`, `setup.mjs`, the server in the
   background, `a11y-508 loop --max-rounds 2` with `TOKEN` unset,
   `GEMINI_API_KEY` from the repository secret and `GEMINI_MODEL=gemini-2.5-flash`,
   then `a11y-508 status`, `verify.mjs`, and the work directory uploaded as
   an artifact. Triggers: `pull_request` on changes to `src/loop.mjs`,
   `src/agent.mjs`, `src/ledger.mjs`, `test/loop-app/**` or the workflow, and
   `workflow_dispatch`. Not a required check.
6. **README**, under "The fix loop": what the job proves, the secret it
   needs, and how to run the same thing by hand with gemini or claude.

## Acceptance criteria

1. `setup.mjs` + `server.mjs` + a crawl of the app yields at least ten
   findings, among them each planted one.
2. `check.mjs` passes on the app as committed, fails when a page loses a
   closing tag or a page stops being served, and logs every run.
3. `verify.mjs` passes on a repository where the loop committed a verified
   fix through the gate, fails when a loop commit touches a file outside
   `site/`, fails when a commit has no gate run, and prints SKIPPED and exits
   0 when every agent call ended on quota.
4. An agent call that reports a 429 and then succeeds is retried and its
   result used (`quotaRetries: 1`); one that never succeeds stops after two
   retries with `quota: true`; one that fails for another reason is not
   retried.
5. The loop keeps one log per agent call, with the header, under
   `a11y-508-work/`.
6. A `gemini` agent command gets `GEMINI_CLI_TRUST_WORKSPACE=true`; others
   do not.
7. The job runs on Windows with Gemini CLI and either passes `verify.mjs` or
   reports SKIPPED for quota; the local smoke run with `claude` on macOS
   passes `verify.mjs`.

## How this fails silently, and what is written to catch it

1. *Mutation*: the quota retry removed. AC 4's retry case turns red.
2. *Mutation*: every failure retried as if it were quota. AC 4's
   non-quota case turns red.
3. *Mutation*: the agent logs not written. AC 5 turns red.
4. *Mutation*: the trust variable not set for gemini. AC 6 turns red.
5. *Mutation*: `verify.mjs` does not look at commit paths. AC 3's
   outside-`site/` case turns red.
6. *Mutation*: `verify.mjs` does not match commits to gate runs. AC 3's
   no-gate case turns red.
7. *Mutation*: `verify.mjs` treats an all-quota run as a failure. AC 3's
   skipped case turns red.
8. *Mutation*: `check.mjs` does not compare open and close counts. AC 2's
   broken-markup case turns red.

## Non-goals

- Asserting how many findings the model fixes, or which.
- Running the Gemini job on a schedule, or making it a required check.
- Pushing from the loop (`push: false`), or any deployment.
- Changing the loop's statuses, prompts or ledger format.
