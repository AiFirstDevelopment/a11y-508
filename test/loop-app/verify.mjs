// The assertions of the end-to-end loop run (.github/workflows/loop-gemini.yml), on the throwaway
// repository setup.mjs made and the loop worked in:
//
//   node test/loop-app/verify.mjs <repository> [--rounds 2]
//
// 1. the ledger holds at least 10 findings from round 1 (the app plants about ten);
// 2. after the last round at least one finding is verified (fixed, and gone in the next crawl);
// 3. the loop made at least one commit;
// 4. no commit of the loop touches anything outside site/;
// 5. the gate (check.mjs) ran for every fix: each fix attempt that changed files has a gate run,
//    and each commit's files are the files changed at one of those runs.
//
// The model is nondeterministic and the free tier is rate-limited, so no exact number of fixes is
// asserted. A run in which every agent call ended on a quota or rate limit (the loop's agent logs
// say so) is reported as SKIPPED and exits 0: it says nothing about the loop.
// Exit 0 when all hold (or skipped), 1 otherwise. Prints a summary either way.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = resolve(process.argv[2] || '.');
const at = process.argv.indexOf('--rounds');
const rounds = at > 0 ? Number(process.argv[at + 1]) : 2;
const work = join(dir, 'a11y-508-work');
const ledgerFile = join(work, 'ledger.json');
const git = (...args) => (spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout || '').trim();

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

if (!existsSync(ledgerFile)) {
  console.error(`FAIL no ledger at ${ledgerFile}: the loop did not get as far as its first crawl`);
  process.exit(1);
}
const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
const entries = Object.values(ledger.findings);
const count = (status) => entries.filter((e) => e.status === status).length;
const attempts = entries.flatMap((e) => e.attempts.map((a) => ({ ...a, entry: e })));

// Agent calls, from the logs the loop keeps of each (agent-*.log, a JSON header line first).
const logs = readdirSync(work).filter((f) => /^agent-r\d+-.*\.log$/.test(f)).map((f) => {
  const first = readFileSync(join(work, f), 'utf8').split('\n')[0];
  try {
    return { file: f, ...JSON.parse(first) };
  } catch {
    return { file: f };
  }
});
const quotaCalls = logs.filter((l) => l.quota).length;
const quotaRetries = logs.reduce((n, l) => n + (l.quotaRetries || 0), 0);

const summary = {
  rounds: ledger.rounds.length,
  findings: entries.length,
  firstRound: entries.filter((e) => e.firstSeenRound === 1).length,
  byStatus: Object.fromEntries(['open', 'review', 'pending', 'verified', 'needs-human', 'adequate', 'gone'].map((s) => [s, count(s)])),
  fixAttempts: attempts.length,
  committed: attempts.filter((a) => a.commit).length,
  agentCalls: logs.length,
  quotaCalls,
  quotaRetries,
};
console.log(`loop run summary: ${JSON.stringify(summary)}`);

if (logs.length && quotaCalls === logs.length) {
  console.log(`SKIPPED: every one of the ${logs.length} agent call(s) ended on a quota or rate limit (after ${quotaRetries} retries), so this run says nothing about the loop. Run it again later, or with a key that has quota.`);
  process.exit(0);
}

check('the ledger has at least 10 findings from round 1', summary.firstRound >= 10, `${summary.firstRound}`);
check(`the loop ran ${rounds} round(s)`, ledger.rounds.length >= rounds, `${ledger.rounds.length}`);
check('at least one finding is verified (fixed, and gone in the next crawl)', summary.byStatus.verified >= 1, `${summary.byStatus.verified}`);

const commits = git('log', '--format=%H %s', 'main').split('\n').filter((l) => / a11y-508: /.test(l)).map((l) => l.split(' ')[0]);
check('the loop made at least one commit', commits.length >= 1, `${commits.length}`);
const outside = [];
const commitFiles = new Map();
for (const c of commits) {
  const files = git('show', '--name-only', '--format=', c).split('\n').filter(Boolean).sort();
  commitFiles.set(c, files);
  for (const f of files) if (!f.startsWith('site/')) outside.push(`${c.slice(0, 7)} ${f}`);
}
check('no commit of the loop touches anything outside site/', !outside.length, outside.join(', '));

const gateLog = join(dir, 'a11y-508-gate.log');
const gates = existsSync(gateLog) ? readFileSync(gateLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const changing = attempts.filter((a) => a.files && a.files.length);
check('the gate ran once for every fix that changed files', gates.length === changing.length, `${gates.length} gate run(s), ${changing.length} fix(es) with changes`);
// Every file of the commit was among the files changed when a passing gate ran.
const unmatched = [...commitFiles].filter(([, files]) => !gates.some((g) => g.ok && files.every((f) => (g.changed || []).includes(f)))).map(([c]) => c.slice(0, 7));
check("every commit's files passed a gate run first", !unmatched.length, unmatched.join(', '));

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
