// The pieces of the end-to-end loop job (.github/workflows/loop-gemini.yml) that run without an AI
// assistant: the loop test app's planted findings (a real crawl), its gate (check.mjs), the job's
// assertions (verify.mjs) on repositories built to pass and to fail, the agent adapter's retry on
// quota errors, and the Gemini CLI trust variable. The job itself needs the GEMINI_API_KEY secret
// and runs only in CI.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { runAgent, agentEnvFor, agentLog } from '../src/agent.mjs';
import { workDir } from '../src/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const APP = join(here, 'loop-app');
const tmp = mkdtempSync(join(tmpdir(), 'a11y-508-loop-app-'));
// The tool's state base, for this file and verify.mjs (a child): inside the temp folder it removes.
process.env.A11Y_508_HOME = join(tmp, 'a11y-508-home');

// node test/loop-app.mjs --only "AC4" runs only the checks whose name contains that text.
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1] : null;
let failures = 0;
const check = async (name, fn) => {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String(e && e.message ? e.message : e).split('\n').join('\n       ')}`);
  }
};
const node = (args, cwd, env = {}) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
let n = 0;
const repo = () => {
  const dir = join(tmp, `repo-${++n}`);
  const r = node([join(APP, 'setup.mjs'), dir, '--agent', 'claude', '--port', '4399'], root);
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return dir;
};
const edit = (file, from, to) => {
  const s = readFileSync(file, 'utf8');
  assert.ok(s.includes(from), `${from} in ${file}`);
  writeFileSync(file, s.replace(from, to));
};

console.log('loop app:');

// AC1: a real crawl of the app finds the planted violations.
await check('AC1: a crawl of the loop app finds at least ten findings, every planted one among them', async () => {
  const dir = repo();
  const server = spawn(process.execPath, [join(dir, 'server.mjs'), '--port', '0'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const url = await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => {
        const m = /(http:\S+)/.exec(String(d));
        if (m) resolve(m[1]);
      });
      server.on('exit', () => reject(new Error('server exited')));
    });
    const out = join(dir, 'a11y-508-report');
    const r = spawnSync(process.execPath, [join(root, 'bin/a11y-508.mjs'), url, '--max-pages', '10', '--no-screenshots', '--out', out, '--quiet', '--fail-on', 'none'], { encoding: 'utf8', env: { ...process.env, TOKEN: '' }, timeout: 240000 });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    const all = [...report.pages.flatMap((p) => (p.findings || []).map((f) => ({ ...f, page: new URL(p.url).pathname }))), ...report.site.findings];
    assert.equal(report.summary.audited, 4, JSON.stringify(report.pages.map((p) => p.url)));
    assert.ok(new Set(all.map((f) => `${f.test}|${f.selector}|${f.message}`)).size >= 10, `${all.length} findings`);
    const planted = [
      ['/', '7.A', /^Image has no alt attribute/],
      ['/', '13.C', /^Text contrast 2\.32:1 is below 4\.5:1 \(15px, #aaaaaa on #ffffff\)/],
      ['/', '6.A', /^Generic link text "Read more"/],
      ['/form.html', '5.A', /^textbox has no label or accessible name/],
      ['/form.html', '5.C', /^aria-labeledby is not an ARIA attribute/],
      ['/form.html', '5.C', /^This fieldset has no <legend>/],
      ['/table.html', '11.A', /^The <html> element has no lang attribute/],
      ['/table.html', '14.B', /^scope="column" is not a valid value/],
      ['/gallery.html', '9.A', /^No mechanism to bypass repetitive content/],
      ['/gallery.html', '6.A', /^Button has no accessible name/],
    ];
    for (const [page, test, re] of planted) assert.ok(all.some((f) => f.page === page && f.test === test && re.test(f.message)), `planted ${test} ${re} on ${page}`);
  } finally {
    server.kill();
  }
});

// AC2: the gate.
await check('AC2: check.mjs passes on the app as committed, and logs the run', () => {
  const dir = repo();
  const r = node(['check.mjs'], dir);
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(join(dir, 'a11y-508-gate.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].ok, log[0].pages, log[0].changed], [true, 4, []]);
});
await check('AC2: check.mjs fails when a page loses a closing tag, naming it, and logs the changed file', () => {
  const dir = repo();
  edit(join(dir, 'site/form.html'), '</fieldset>', '');
  const r = node(['check.mjs'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /site\/form\.html: <fieldset> opened 1 time\(s\), closed 0/);
  const log = JSON.parse(readFileSync(join(dir, 'a11y-508-gate.log'), 'utf8').trim());
  assert.deepEqual([log.ok, log.changed], [false, ['site/form.html']]);
});
await check('AC2: check.mjs fails when a page is not served', () => {
  const dir = repo();
  // A page whose name the server cannot serve back (a "%" that does not decode).
  writeFileSync(join(dir, 'site/100%.html'), readFileSync(join(dir, 'site/index.html')));
  const r = node(['check.mjs'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /100%\.html: /);
});

// AC3: verify.mjs on repositories made to look like a loop run.
// A run: the gate passes on one fix and the loop commits it; round 2 verified it.
const fakeRun = (dir, { outside = false, skipGate = false, quotaAll = false, newDir = false } = {}) => {
  edit(join(dir, 'site/index.html'), '<img src="img/harbour.svg" width="160" height="100">', '<img src="img/harbour.svg" alt="The harbour at dawn" width="160" height="100">');
  if (newDir) {
    mkdirSync(join(dir, 'site/icons'));
    writeFileSync(join(dir, 'site/icons/a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  }
  if (outside) edit(join(dir, 'check.mjs'), '// The loop', '// Changed by the agent. The loop');
  if (!skipGate) assert.equal(node(['check.mjs'], dir).status, 0);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'a11y-508: 7.A meaningful image name: Image has no alt attribute');
  const commit = git(dir, 'rev-parse', '--short', 'HEAD');
  const work = workDir(dir);
  mkdirSync(work, { recursive: true });
  const findings = {};
  for (let i = 0; i < 12; i++) {
    const fp = `T.${i}|#x${i}|m${i}`;
    findings[fp] = { fingerprint: fp, test: 'T', status: i === 0 ? 'verified' : 'open', firstSeenRound: 1, attempts: i === 0 ? [{ round: 1, files: outside ? ['check.mjs', 'site/index.html'] : newDir ? ['site/icons/', 'site/index.html'] : ['site/index.html'], outcome: 'verified', commit }] : [] };
  }
  writeFileSync(join(work, 'ledger.json'), JSON.stringify({ version: 1, rounds: [{ round: 1 }, { round: 2 }], findings }));
  const head = (quota) => agentLog({ code: quota ? 1 : 0, quota, quotaRetries: quota ? 2 : 0, result: quota ? null : {}, stdout: '', stderr: quota ? '429 RESOURCE_EXHAUSTED' : '' });
  writeFileSync(join(work, 'agent-r1-fix-0.log'), head(quotaAll));
  writeFileSync(join(work, 'agent-r1-triage-0.log'), head(quotaAll));
};
const verify = (dir) => node([join(APP, 'verify.mjs'), dir], root);
await check('AC3: verify.mjs passes on a run with a verified fix that went through the gate', () => {
  const dir = repo();
  fakeRun(dir);
  const r = verify(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all checks passed/);
});
await check('AC3: verify.mjs matches a commit that adds a new folder to its gate run (fix round)', () => {
  const dir = repo();
  fakeRun(dir, { newDir: true });
  const r = verify(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const gate = JSON.parse(readFileSync(join(dir, 'a11y-508-gate.log'), 'utf8').trim());
  assert.deepEqual(gate.changed, ['site/icons/a.svg', 'site/index.html']);
});
await check('AC3: verify.mjs fails when a commit of the loop touches a file outside site/', () => {
  const dir = repo();
  fakeRun(dir, { outside: true });
  const r = verify(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL no commit of the loop touches anything outside site\/ \(\w+ check\.mjs\)/);
});
await check('AC3: verify.mjs fails when a commit had no gate run', () => {
  const dir = repo();
  fakeRun(dir, { skipGate: true });
  const r = verify(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL the gate ran once for every fix that changed files \(0 gate run\(s\), 1 fix\(es\) with changes\)/);
  assert.match(r.stdout, /FAIL every commit's files passed a gate run first/);
});
await check('AC3: verify.mjs reports SKIPPED and exits 0 when every agent call ended on quota', () => {
  const dir = repo();
  fakeRun(dir, { quotaAll: true });
  const r = verify(dir);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^SKIPPED: every one of the 2 agent call\(s\) ended on a quota or rate limit \(after 4 retries\)/m);
});

// AC4: the agent adapter's retry on quota errors, with a stand-in assistant.
const AGENT = join(tmp, 'quota-agent.mjs');
writeFileSync(AGENT, `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [, , counter, resultFile] = process.argv;
const calls = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
writeFileSync(counter, String(calls));
const failFor = Number(process.env.FAIL_FOR || 0);
if (calls <= failFor) {
  console.error(process.env.FAIL_KIND === 'other' ? 'Error: could not read the prompt' : process.env.FAIL_KIND === 'daily' ? 'TerminalQuotaError: You have exhausted your daily quota on this model. 429' : 'Error: [API Error: got status: 429 Too Many Requests. RESOURCE_EXHAUSTED: quota exceeded]');
  // HANG: backs off on its own past the call's time limit, as Gemini CLI does on 429s.
  if (process.env.HANG) setTimeout(() => process.exit(1), 4000);
  else process.exit(1);
} else {
  writeFileSync(resultFile, JSON.stringify({ fixed: false, note: 'call ' + calls }));
}
`);
const callAgent = async (label, env, timeout) => {
  const counter = join(tmp, `${label}.count`);
  const res = await runAgent({ command: `"${process.execPath}" "${AGENT}" "${counter}" {resultFile}`, promptFile: join(tmp, 'p.md'), resultFile: join(tmp, `${label}.json`), cwd: tmp, env: { ...process.env, ...env }, quotaDelays: [10, 10], ...(timeout ? { timeout } : {}) });
  return { res, calls: Number(readFileSync(counter, 'utf8')) };
};
await check('AC4: a call refused with 429 is retried, and the retry\'s result is used', async () => {
  const { res, calls } = await callAgent('retry', { FAIL_FOR: '1' });
  assert.equal(calls, 2);
  assert.deepEqual([res.quota, res.quotaRetries, res.result && res.result.note], [false, 1, 'call 2']);
});
await check('AC4: a call refused every time stops after two retries, marked quota', async () => {
  const { res, calls } = await callAgent('never', { FAIL_FOR: '99' });
  assert.equal(calls, 3);
  assert.deepEqual([res.quota, res.quotaRetries, res.result], [true, 2, null]);
  assert.match(agentLog(res).split('\n')[0], /"quota":true,"quotaRetries":2/);
});
await check('AC4: a call that fails for another reason is not retried', async () => {
  const { res, calls } = await callAgent('other', { FAIL_FOR: '99', FAIL_KIND: 'other' });
  assert.equal(calls, 1);
  assert.deepEqual([res.quota, res.quotaRetries, res.code], [false, 0, 1]);
});

await check('AC4: a daily quota is not retried in seconds', async () => {
  const { res, calls } = await callAgent('daily', { FAIL_FOR: '99', FAIL_KIND: 'daily' });
  assert.equal(calls, 1);
  assert.deepEqual([res.quota, res.quotaRetries], [true, 0]);
});
await check('AC4: a call that runs out its time while refused for quota is marked quota, and not run again (fix round)', async () => {
  const { res, calls } = await callAgent('hang', { FAIL_FOR: '99', HANG: '1' }, 1500);
  assert.equal(calls, 1);
  assert.deepEqual([res.timedOut, res.quota, res.quotaRetries], [true, true, 0]);
});

// AC6: Gemini CLI's folder trust.
await check('AC6: a gemini command gets GEMINI_CLI_TRUST_WORKSPACE=true; others, and a value already set, are left alone', () => {
  assert.equal(agentEnvFor('gemini --approval-mode auto_edit -p "x"', {}).GEMINI_CLI_TRUST_WORKSPACE, 'true');
  assert.equal(agentEnvFor('"C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd" -p "x"', {}).GEMINI_CLI_TRUST_WORKSPACE, 'true');
  assert.equal(agentEnvFor('claude -p "x"', {}).GEMINI_CLI_TRUST_WORKSPACE, undefined);
  assert.equal(agentEnvFor('node fake.mjs gemini', {}).GEMINI_CLI_TRUST_WORKSPACE, undefined);
  assert.equal(agentEnvFor('gemini -p x', { GEMINI_CLI_TRUST_WORKSPACE: 'false' }).GEMINI_CLI_TRUST_WORKSPACE, 'false');
});

// On Windows the shell's SIGKILL leaves the stub of the time-out case running for a few seconds
// in tmp, which keeps the folder busy; wait for it rather than fail the run on cleanup.
try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
} catch (e) {
  console.log(`  (could not remove ${tmp}: ${e.code})`);
}
console.log(failures ? `\n${failures} loop app assertion(s) failed` : '\nall loop app assertions passed');
process.exitCode = failures ? 1 : 0;
