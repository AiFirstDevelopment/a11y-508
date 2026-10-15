// End-to-end test of the fix loop: a throwaway git repository holding a copy
// of the fixture site, a server that serves it (so "deploy" is instant), and a
// fake agent that fixes two findings, declines the rest, and breaks the build
// on one so the gate has to revert it.

import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { applyReport, loadLedger } from '../src/ledger.mjs';
import { agentEnv, fixPrompt, triagePrompt } from '../src/agent.mjs';
import { normalizeConfig, sessionArgs, splitCheck } from '../src/loop.mjs';
import { bundleSignature, sameBuild } from '../src/deploy-check.mjs';
import { splitLoopArgs } from '../src/cli.mjs';
import { statusCounts } from '../src/ledger.mjs';
import { reportDir, workDir } from '../src/home.mjs';
import { parseEvents } from './event-schema.mjs';
import { mkdtempSync as mkdtempHome, realpathSync as realHome } from 'node:fs';
import { tmpdir as tmpHome } from 'node:os';

// The tool keeps its files under the state base (src/home.mjs); every loop and crawl here uses a
// temporary one, created by this file under the OS temp directory and removed at the end.
const HOME = realHome(mkdtempHome(join(tmpHome(), 'a11y-508-home-')));
process.env.A11Y_508_HOME = HOME;
// The task folder: the prompts and the result files.
const tasksOf = (repo) => join(workDir(repo), 'tasks');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const TOKEN = 'fixture-token-123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};

// ---- unit: ledger diff across rounds
{
  const page = (url, findings) => ({ url, finalUrl: url, findings, error: null, skipped: null });
  const f = (test, selector, message, level = 'violation') => ({ test, selector, message, level, impact: 'serious', name: 'n', wcag: 'w', html: '<x>' });
  const report = (pages, finished = 't') => ({ pages, site: { findings: [] }, summary: { pages: pages.length, audited: pages.filter((p) => !p.error && !p.skipped).length, violations: 0, reviews: 0 }, finishedAt: finished });
  const ledger = { version: 1, rounds: [], findings: {} };
  const d1 = applyReport(ledger, report([page('/a', [f('7.A', 'img', 'no alt'), f('13.C', 'p', 'contrast'), f('6.A', 'a', 'generic', 'review')])]), 1);
  check('ledger: first round records everything as new', () => {
    assert.equal(d1.new.length, 3);
    assert.equal(ledger.findings['6.A|a|generic'].status, 'review');
    assert.equal(ledger.findings['7.A|img|no alt'].status, 'open');
  });
  ledger.findings['7.A|img|no alt'].status = 'pending';
  ledger.findings['7.A|img|no alt'].attempts.push({ round: 1, outcome: 'pending' });
  ledger.findings['13.C|p|contrast'].status = 'pending';
  ledger.findings['13.C|p|contrast'].attempts.push({ round: 1, outcome: 'pending' });
  const d2 = applyReport(ledger, report([page('/a', [f('13.C', 'p', 'contrast'), f('6.A', 'a', 'generic', 'review'), f('5.A', 'input', 'unlabelled')])]), 2);
  check('ledger: pending findings become verified when gone and open again when still present', () => {
    assert.equal(d2.verified.length, 1);
    assert.equal(ledger.findings['7.A|img|no alt'].status, 'verified');
    assert.equal(d2.failed.length, 1);
    assert.equal(ledger.findings['13.C|p|contrast'].status, 'open');
    assert.equal(ledger.findings['13.C|p|contrast'].attempts[0].outcome, 'still-present');
    assert.equal(d2.new.length, 1);
  });
  const d3 = applyReport(ledger, report([page('/b', [])]), 3);
  check('ledger: findings on pages not audited this round are left alone', () => {
    assert.equal(d3.unchecked.length, 4);
    assert.equal(ledger.findings['13.C|p|contrast'].status, 'open');
  });
  const l2 = { version: 1, rounds: [], findings: {} };
  applyReport(l2, report([page('/a', [f('7.A', 'img', 'no alt')])]), 1);
  const e = l2.findings['7.A|img|no alt'];
  for (let r = 1; r <= 3; r++) {
    e.status = 'pending';
    e.attempts.push({ round: r, outcome: 'pending' });
    applyReport(l2, report([page('/a', [f('7.A', 'img', 'no alt')])]), r + 1, { maxAttempts: 3 });
  }
  check('ledger: gives up after maxAttempts fixes that did not hold', () => assert.equal(e.status, 'skipped'));
}

// ---- unit: prompts never carry secrets, env strips the token
check('agent env strips TOKEN but keeps provider keys', () => {
  const env = agentEnv({ TOKEN: 'x', MY_SECRET: 'y', PATH: '/bin', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'PATH']);
});
check('prompts contain the finding and the result path, and no token', () => {
  const finding = { test: '7.A', name: 'n', wcag: '1.1.1', impact: 'serious', message: 'no alt', selector: 'img', html: '<img>', pages: ['/a'], attempts: [{ round: 1, outcome: 'still-present', note: 'tried alt=""', files: ['x'] }] };
  const p = fixPrompt({ finding, sourceDirs: ['src'], protectedDirs: ['tools/a11y-508'], resultFile: '/r.json', condition: 'c' });
  assert.ok(p.includes('/r.json') && p.includes('tools/a11y-508') && p.includes('Earlier attempts') && p.includes('tried alt=""'));
  assert.ok(p.includes('Do not search or read node_modules'), 'the fix prompt keeps the assistant out of installed packages');
  const t = triagePrompt({ items: [{ id: 'r1-0', test: '6.A', name: 'n', wcag: 'w', condition: 'c', message: 'm', selector: 'a', html: '<a>', pages: ['/a'] }], resultFile: '/t.json' });
  assert.ok(t.includes('r1-0') && t.includes('/t.json'));
});
// docs/plans/checks-shadow-frames.md AC 11: a finding inside a web component in a same-origin frame
// reaches the fixing assistant with its whole selector path and the frame it is in.
check('the fix prompt shows a " >>> " selector path whole, and the frame', () => {
  const finding = { test: '7.A', name: 'n', wcag: '1.1.1', impact: 'critical', message: 'no alt', selector: '#fr-same >>> #ff-badge >>> img', frame: '#fr-same', html: '<img src="/img/badge.png">', pages: ['/checks-frames.html'], attempts: [] };
  const p = fixPrompt({ finding, sourceDirs: ['src'], protectedDirs: ['tools/a11y-508'], resultFile: '/r.json', condition: 'c' });
  assert.ok(p.includes('Element selector: #fr-same >>> #ff-badge >>> img\nInside the same-origin frame: #fr-same\n'), p);
  assert.ok(p.includes('"selector": "#fr-same >>> #ff-badge >>> img",\n    "frame": "#fr-same"'), p);
});
check('config validation catches the common mistakes', () => {
  assert.ok(normalizeConfig({}).errors.some((e) => /no start URL/.test(e)));
  assert.ok(normalizeConfig({ url: 'http://x' }).errors.some((e) => /no agent/.test(e)));
  assert.ok(normalizeConfig({ url: 'http://x', agent: 'claude', deployed: 'command' }).errors.some((e) => /no "deploy"/.test(e)));
  const { cfg, errors } = normalizeConfig({ url: 'http://x', agent: 'gemini', deploy: 'npm run deploy' });
  assert.deepEqual(errors, []);
  assert.equal(cfg.deployed, 'command');
});
check('a saved session is used for each round\'s crawl unless the options name a way in', () => {
  const dir = join(here, '.loop-session');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  assert.deepEqual(sessionArgs({ args: [] }, [], dir), [], 'no session file');
  writeFileSync(join(dir, 'a11y-508-state.json'), '{}');
  assert.deepEqual(sessionArgs({ args: [] }, [], dir), ['--state', 'a11y-508-state.json']);
  assert.deepEqual(sessionArgs({ args: ['--cookie', 'a=b'] }, [], dir), []);
  assert.deepEqual(sessionArgs({ args: [] }, ['--state', 'other.json'], dir), []);
  assert.deepEqual(sessionArgs({ args: ['--login'] }, [], dir), []);
  writeFileSync(join(dir, 'mine.json'), '{}');
  assert.deepEqual(sessionArgs({ args: [], state: 'mine.json' }, [], dir), ['--state', 'mine.json']);
  rmSync(dir, { recursive: true, force: true });
});
check('loop-resilience AC20: only a plain "<build> && <test>" check is split; one whose first part sets up the second runs whole', () => {
  assert.deepEqual(splitCheck('npm run build && npm test -- --watch=false'), { build: 'npm run build', test: 'npm test -- --watch=false' });
  assert.deepEqual(splitCheck('"/opt/my node/node" build.mjs && "/opt/my node/node" test.mjs'), { build: '"/opt/my node/node" build.mjs', test: '"/opt/my node/node" test.mjs' });
  for (const whole of ['cd app && node t.mjs', 'export CI=1 && npm test', 'nvm use && npm test', 'node -e "a && b"', 'npm run lint && npm run build && npm test', 'npm test']) assert.deepEqual(splitCheck(whole), { build: whole, test: null }, whole);
});
check('deploy-wait: --from-report takes a file, or alone means from the ledger; --verify, --verify-anyway and --wait are loop flags', () => {
  assert.equal(splitLoopArgs(['loop', '--from-report', 'out/report']).loop.fromReport, 'out/report');
  assert.equal(splitLoopArgs(['loop', '--from-report', 'a/report.json']).loop.fromReport, 'a/report.json');
  assert.equal(splitLoopArgs(['loop', '--from-report']).loop.fromReport, true);
  assert.equal(splitLoopArgs(['loop', '--from-report', '--max-rounds', '1']).loop.fromReport, true);
  const u = splitLoopArgs(['loop', '--from-report', 'http://x/']);
  assert.deepEqual([u.loop.fromReport, u.remaining], [true, ['http://x/']]);
  const v = splitLoopArgs(['loop', '--verify', '--verify-anyway', '--wait', '--max-pages', '2']);
  assert.deepEqual([v.loop.verify, v.loop.verifyAnyway, v.loop.wait, v.remaining], [true, true, true, ['--max-pages', '2']]);
});
check('loop flags are split from crawl options', () => {
  const s = splitLoopArgs(['loop', 'http://x', '--max-rounds', '3', '--max-pages', '10', '--agent=gemini', '--dry-run']);
  assert.equal(s.loop.maxRounds, 3);
  assert.equal(s.loop.agent, 'gemini');
  assert.equal(s.loop.dryRun, true);
  assert.deepEqual(s.remaining, ['http://x', '--max-pages', '10']);
  assert.equal(splitLoopArgs(['http://x']), null);
  // --sign-in-first is the loop's own flag, not a crawl option.
  const f = splitLoopArgs(['loop', '--sign-in-first', '--max-pages', '2']);
  assert.equal(f.loop.signInFirst, true);
  assert.deepEqual(f.remaining, ['--max-pages', '2']);
});

// ---- e2e: a throwaway repository with the fixture site, served from disk
const repo = join(here, '.loop-repo');
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, 'site'), { recursive: true });
for (const f of ['index.html', 'about.html', 'forms.html', 'tables.html', 'media.html', 'app.html', 'bounce.html', 'landed.html', 'reports.html', 'dashboard.html']) cpSync(join(here, 'fixtures', f), join(repo, 'site', f));
const site = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401);
    return res.end();
  }
  let path = new URL(req.url, 'http://x').pathname;
  if (path === '/') path = '/index.html';
  if (path.startsWith('/img/') || path === '/pixel.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG);
  }
  const file = join(repo, 'site', path);
  if (extname(path) !== '.html' || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}/`;

const g = (...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
g('init', '-q', '-b', 'main');
g('config', 'user.email', 'loop-test@example.test');
g('config', 'user.name', 'loop test');
g('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, '.gitignore'), '');
const checkScript = join(repo, 'check.mjs');
writeFileSync(checkScript, "import { readFileSync } from 'node:fs'; process.exit(readFileSync('site/index.html', 'utf8').includes('BREAK-THE-BUILD') ? 1 : 0);\n");
writeFileSync(join(repo, 'a11y-508.config.json'), JSON.stringify({
  url: base,
  args: ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'],
  agent: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, 'fake-agent.mjs'))} {promptFile} {resultFile}`,
  source: ['site'],
  check: `${JSON.stringify(process.execPath)} check.mjs`,
  deploy: `${JSON.stringify(process.execPath)} -e 0`,
  push: false,
  maxAttempts: 3,
}, null, 2));
g('add', '-A');
g('commit', '-q', '-m', 'fixture site');
const headBefore = g('rev-parse', 'HEAD');

console.log(`loop fixture repo at ${repo}, site at ${base}`);
const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'bin/a11y-508.mjs'), 'loop', '--max-rounds', '2'], { cwd: repo, env: { ...process.env, TOKEN, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ status: code, out });
  });
});
site.close();
console.log(`loop finished in ${((Date.now() - t0) / 1000).toFixed(1)}s with exit code ${run.status}`);
if (process.env.SHOW_LOOP) console.log(run.out);
if (run.status === null) throw new Error('loop was killed after 300s');

const ledger = loadLedger(join(workDir(repo), 'ledger.json'));
const entries = Object.values(ledger.findings);
const commits = g('log', '--format=%s', `${headBefore}..HEAD`).split('\n').filter(Boolean);
const byTest = (t) => entries.filter((e) => e.test === t);

console.log('assertions:');
check('two rounds ran and the loop stopped with findings still open (exit 1)', () => {
  assert.equal(ledger.rounds.length, 2, run.out);
  assert.equal(run.status, 1, run.out);
});
check('the fixes the fake agent made were committed, one commit each', () => {
  assert.ok(commits.some((c) => /^a11y-508: 7\.A /.test(c)), commits.join('\n'));
  assert.ok(commits.some((c) => /^a11y-508: 13\.C /.test(c)), commits.join('\n'));
});
check('round 2 verified those fixes against the redeployed site', () => {
  const alt = byTest('7.A').find((e) => /no alt attribute/.test(e.message) && /photo/.test(e.html));
  assert.ok(alt && alt.status === 'verified', JSON.stringify(alt));
  const contrast = byTest('13.C')[0];
  assert.ok(contrast && contrast.status === 'verified', JSON.stringify(contrast));
  assert.ok(ledger.rounds[1].diff.verified >= 2, JSON.stringify(ledger.rounds[1]));
});
check('a fix that broke the build was reverted, not committed', () => {
  assert.ok(!commits.some((c) => /^a11y-508: 10\.D /.test(c)), commits.join('\n'));
  assert.ok(!readFileSync(join(repo, 'site/index.html'), 'utf8').includes('BREAK-THE-BUILD'));
  const list = byTest('10.D').find((e) => /direct child/.test(e.message));
  assert.ok(list && list.attempts.some((a) => a.outcome === 'failed-gate'), JSON.stringify(list));
  assert.equal(g('status', '--porcelain', '--', 'site'), '');
});
check('findings the agent declined stay open with a no-change attempt', () => {
  const declined = entries.filter((e) => e.attempts.some((a) => /does not handle/.test(a.note)));
  assert.ok(declined.length > 0);
  assert.ok(declined.every((e) => e.status === 'open' && e.attempts.every((a) => a.outcome === 'no-change' && a.files.length === 0)), JSON.stringify(declined.map((e) => [e.status, e.attempts])));
  const gated = byTest('10.D').find((e) => /direct child/.test(e.message));
  assert.deepEqual(gated.attempts.map((a) => a.files), [['site/index.html'], ['site/index.html']]);
});
check('triage closed review items as adequate and reopened the inadequate one', () => {
  assert.ok(entries.some((e) => e.status === 'adequate' && e.triage && e.triage.round === 1));
  const sensory = byTest('13.B')[0];
  assert.ok(sensory && sensory.triage.decision === 'inadequate' && ['open', 'skipped'].includes(sensory.status), JSON.stringify(sensory));
});
check('the token never reached the agent', () => {
  const results = entries.flatMap((e) => e.attempts);
  assert.ok(results.length > 0);
  const resultFiles = readFileSync(join(tasksOf(repo), 'result-r1-fix-0.json'), 'utf8');
  assert.ok(!/"leaked": true/.test(resultFiles), resultFiles);
});
check('loop-gemini-ci AC5: each agent call leaves a log in the work folder, with its header line', () => {
  const work = workDir(repo);
  const logs = readdirSync(work).filter((f) => /^agent-r\d+-(fix|triage)-\d+\.log$/.test(f));
  const prompts = readdirSync(tasksOf(repo)).filter((f) => /^prompt-r\d+-(fix|triage)-\d+\.md$/.test(f));
  assert.equal(logs.length, prompts.length, `${logs.join(', ')} for ${prompts.join(', ')}`);
  assert.ok(logs.includes('agent-r1-fix-0.log') && logs.includes('agent-r1-triage-0.log'), logs.join(', '));
  const head = JSON.parse(readFileSync(join(work, 'agent-r1-fix-0.log'), 'utf8').split('\n')[0]);
  assert.deepEqual([head.code, head.timedOut, head.quota, head.quotaRetries, head.result], [0, false, false, 0, true]);
  // And one start line and one end line per call, in order, in agent-calls.log.
  const calls = readFileSync(join(work, 'agent-calls.log'), 'utf8').split('\n').filter((l) => /^\S+ (start|end  ) /.test(l));
  assert.equal(calls.length, logs.length * 2, calls.join('\n'));
  assert.match(calls[0], /^\S+ start r1-triage-0$/);
  assert.match(calls[1], /^\S+ end   r1-triage-0 exit 0 result yes \d+s$/);
});
check('tool-files AC1/guard 1: after a loop the repository holds nothing of the tool\'s; the ledger is under the state base', () => {
  for (const d of ['a11y-508-work', 'a11y-508-report', 'a11y-508-history']) assert.ok(!existsSync(join(repo, d)), `${d} in the repository`);
  const file = join(workDir(repo), 'ledger.json');
  assert.ok(file.startsWith(join(HOME, 'repos') + sep), file);
  assert.ok(existsSync(file), file);
  assert.equal(g('status', '--porcelain', '--ignored'), '', 'the repository is clean, with nothing ignored either');
  let exclude = '';
  try {
    exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  } catch {}
  assert.ok(!/a11y-508/.test(exclude), exclude);
});
check('tool-files AC3/guard 3: the prompt names no repository path for the tool\'s files and tells the assistant to leave them alone', () => {
  const prompt = readFileSync(join(tasksOf(repo), 'prompt-r1-fix-0.md'), 'utf8');
  assert.ok(!/a11y-508-work|a11y-508-report|a11y-508-history/.test(prompt), prompt);
  assert.ok(prompt.includes("Everything you need is in this prompt. Do not read, search or edit anything outside the source folders listed above; in particular leave the tool's own folders alone."), prompt);
  // The result file it is to write is under the state base, outside the repository.
  const block = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1])).find((o) => o.kind === 'fix');
  assert.ok(block.resultFile.startsWith(join(HOME, 'repos') + sep), block.resultFile);
  assert.ok(!block.resultFile.startsWith(repo + sep), block.resultFile);
  const triage = readFileSync(join(tasksOf(repo), 'prompt-r1-triage-0.md'), 'utf8');
  assert.ok(!/a11y-508-work|a11y-508-report/.test(triage), triage);
  assert.match(triage, /leave the tool's own folders alone/);
});
check('status prints the ledger', () => {
  const r = spawnSync(process.execPath, [join(root, 'bin/a11y-508.mjs'), 'status'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(/2 round\(s\)/.test(r.stdout) && /verified fixed/.test(r.stdout), r.stdout);
});

rmSync(repo, { recursive: true, force: true });

// ---- e2e: folders an earlier version left in the repository move to the tool's own folder, once
{
  const { mkdtempSync, symlinkSync } = await import('node:fs');
  const made = [];
  const mk = (prefix) => {
    const d = realHome(mkdtempSync(join(tmpHome(), prefix)));
    made.push(d);
    return d;
  };
  const old = mk('a11y-508-migrate-');
  const outside = mk('a11y-508-migrate-outside-');
  const gm = (...args) => spawnSync('git', args, { cwd: old, encoding: 'utf8' });
  gm('init', '-q', '-b', 'main');
  // The ledger as an earlier loop left it: one finding still open after 3 attempts.
  const seeded = { version: 1, rounds: [{ round: 1, at: '2026-10-01T00:00:00.000Z', pages: 1, audited: 1, violations: 1, reviews: 0, diff: { new: 1, verified: 0, failed: 0 } }], findings: {
    '7.A|img|no alt': { fingerprint: '7.A|img|no alt', test: '7.A', name: 'Images', wcag: '1.1.1', impact: 'critical', level: 'violation', message: 'Image has no alt attribute', selector: 'img', html: '<img>', pages: ['http://x/'], status: 'open', firstSeenRound: 1, lastSeenRound: 1,
      attempts: [1, 2, 3].map((round) => ({ round, files: ['site/index.html'], note: 'tried', outcome: 'still-present' })) },
  } };
  mkdirSync(join(old, 'a11y-508-work', 'round-1'), { recursive: true });
  writeFileSync(join(old, 'a11y-508-work', 'ledger.json'), JSON.stringify(seeded));
  writeFileSync(join(old, 'a11y-508-work', 'round-1', 'report.json'), '{}');
  mkdirSync(join(old, 'a11y-508-history', '2026-10-01'), { recursive: true });
  writeFileSync(join(old, 'a11y-508-history', '2026-10-01', 'report.json'), '{}');
  // Not the tool's: a link named like its report folder, and a folder with another name.
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  symlinkSync(outside, join(old, 'a11y-508-report'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(old, 'a11y-508-work-mine'));
  writeFileSync(join(old, 'a11y-508-work-mine', 'x.txt'), 'x');
  writeFileSync(join(old, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n/a11y-508-history\n# a11y-508 dashboard outputs\na11y-508-report/\na11y-508-history/\na11y-508-work/\n');
  const status = spawnSync(process.execPath, [join(root, 'bin/a11y-508.mjs'), 'status'], { cwd: old, encoding: 'utf8' });
  check('tool-files AC2/guard 2: status after the move reports the migrated ledger from the tool\'s own folder', () => {
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /1 round\(s\)/);
    assert.match(status.stdout, /Image has no alt attribute.*\[1 page\(s\), 3 attempt\(s\)\]/);
    assert.ok(!existsSync(join(old, 'a11y-508-work')) && !existsSync(join(old, 'a11y-508-history')), 'the old folders are gone from the repository');
    assert.ok(existsSync(join(workDir(old), 'ledger.json')) && existsSync(join(workDir(old), 'round-1', 'report.json')));
    assert.ok(existsSync(join(workDir(old), '..', 'history', '2026-10-01', 'report.json')));
    assert.match(status.stdout, /moved .*a11y-508-work to /);
    assert.ok(status.stdout.includes(dirname(workDir(old))), status.stdout);
  });
  check('tool-files AC2: the .git/info/exclude lines the tool added are removed, the person\'s stay', () => {
    const ex = readFileSync(join(old, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(!/a11y-508 dashboard outputs|^a11y-508-(report|history|work)\/$/m.test(ex), ex);
    assert.match(ex, /^\*\.log$/m);
    assert.match(ex, /^\/a11y-508-history$/m, 'a line the person wrote stays');
  });
  check('tool-files guard 6: the move touches only the named folders, never a link or a folder by another name', () => {
    assert.ok(existsSync(join(old, 'a11y-508-report', 'keep.txt')), 'the link stays');
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
    assert.ok(!existsSync(join(workDir(old), '..', 'report')), 'a linked folder was moved');
    assert.equal(readFileSync(join(old, 'a11y-508-work-mine', 'x.txt'), 'utf8'), 'x');
  });
  // The move happens once: a folder of that name made afterwards (say with --out) stays the person's.
  mkdirSync(join(old, 'a11y-508-work'), { recursive: true });
  writeFileSync(join(old, 'a11y-508-work', 'ledger.json'), JSON.stringify({ version: 1, rounds: [], findings: {} }));
  const later = spawnSync(process.execPath, [join(root, 'bin/a11y-508.mjs'), 'status'], { cwd: old, encoding: 'utf8' });
  check('tool-files AC2: the move happens once; a folder made there later is left alone', () => {
    assert.ok(existsSync(join(old, 'a11y-508-work', 'ledger.json')), later.stdout);
    assert.doesNotMatch(later.stdout, /moved /);
  });
  // A first use when the tool's folder already has one (another copy of the tool got there first):
  // the repository's copy is set aside next to it, and said so.
  rmSync(join(workDir(old), '..', 'migrated.json'));
  const again = spawnSync(process.execPath, [join(root, 'bin/a11y-508.mjs'), 'status'], { cwd: old, encoding: 'utf8' });
  check('tool-files AC2: an old folder whose destination exists is moved aside as work-old and reported; the ledger there stays', () => {
    assert.ok(!existsSync(join(old, 'a11y-508-work')));
    assert.ok(existsSync(join(workDir(old) + '-old', 'ledger.json')));
    assert.match(again.stdout, /aside to .*work-old/);
    assert.match(again.stdout, /3 attempt\(s\)/);
  });
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10 });
}

// ---- e2e: the same loop with --events and "deployed": "enter", answered on stdin
check('"deployed": "enter" is accepted when someone can answer it (a terminal, or the dashboard)', () => {
  const c = { url: 'http://x', agent: 'claude', deployed: 'enter' };
  assert.deepEqual(normalizeConfig(c, {}, { interactive: true }).errors, []);
  assert.ok(normalizeConfig(c, {}, { interactive: false }).errors.some((e) => /no interactive terminal/.test(e)));
  // Run by the dashboard, a config that says nothing about the deployment waits for the build to change
  // (turnkey: nobody is there to press Enter); the same config in a terminal still asks for Enter.
  assert.equal(normalizeConfig({ url: 'http://x', agent: 'claude' }, {}, { interactive: true, events: true }).cfg.deployed, 'bundle-change');
  assert.equal(normalizeConfig({ url: 'http://x', agent: 'claude' }, {}, { interactive: true }).cfg.deployed, 'enter');
  assert.equal(normalizeConfig({ url: 'http://x', agent: 'claude', deployed: 'enter' }, {}, { interactive: true, events: true }).cfg.deployed, 'enter');
});
const repo2 = join(here, '.loop-repo-events');
rmSync(repo2, { recursive: true, force: true });
mkdirSync(join(repo2, 'site'), { recursive: true });
for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(here, 'fixtures', f), join(repo2, 'site', f));
const site2 = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401);
    return res.end();
  }
  let path = new URL(req.url, 'http://x').pathname;
  if (path === '/') path = '/index.html';
  if (path.startsWith('/img/') || path === '/pixel.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG);
  }
  const file = join(repo2, 'site', path);
  if (extname(path) !== '.html' || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN));
});
await new Promise((r) => site2.listen(0, '127.0.0.1', r));
const g2 = (...args) => {
  const r = spawnSync('git', args, { cwd: repo2, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
g2('init', '-q', '-b', 'main');
g2('config', 'user.email', 'loop-test@example.test');
g2('config', 'user.name', 'loop test');
g2('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo2, '.gitignore'), '');
writeFileSync(join(repo2, 'a11y-508.config.json'), JSON.stringify({
  url: `http://127.0.0.1:${site2.address().port}/`,
  args: ['--max-pages', '2', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'],
  agent: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, 'fake-agent.mjs'))} {promptFile} {resultFile}`,
  source: ['site'],
  push: false,
  deployed: 'enter',
  triageBatch: 50,
}, null, 2));
g2('add', '-A');
g2('commit', '-q', '-m', 'fixture site');
// A saved session in the working directory (ignored by git, as the README says): every round's crawl uses it.
writeFileSync(join(repo2, '.gitignore'), 'a11y-508-state.json\n');
g2('commit', '-qam', 'ignore the session file');
writeFileSync(join(repo2, 'a11y-508-state.json'), JSON.stringify({ version: 1, origins: [], cookies: [], storage: {} }));
const evLoop = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'bin/a11y-508.mjs'), 'loop', '--max-rounds', '2', '--events'], { cwd: repo2, env: { ...process.env, TOKEN, NO_COLOR: '1', FAKE_AGENT_SAY_FILES: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let presses = 0;
  child.stdout.on('data', (d) => {
    out += d;
    const waiting = (out.match(/"type":"await-deploy"/g) || []).length;
    while (presses < waiting) {
      presses++;
      child.stdin.write('\n');
    }
  });
  child.stderr.on('data', (d) => (err += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ status: code, out, err, presses });
  });
});
site2.close();
{
  const { events, problems } = parseEvents(evLoop.out);
  const ledger2 = loadLedger(join(workDir(repo2), 'ledger.json'));
  const ofType = (t) => events.filter((e) => e.type === t);
  check('loop --events: every line on stdout is an event that fits the schema', () => {
    assert.ok(events.length > 0, evLoop.out + evLoop.err);
    assert.deepEqual(problems, []);
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].kind, 'loop');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).code, evLoop.status);
  });
  check('loop --events: a round event per round, and each round\'s crawl relays its page events tagged with the round', () => {
    assert.deepEqual(ofType('round').map((e) => e.round), [1, 2]);
    for (const r of [1, 2]) {
      const rep = JSON.parse(readFileSync(join(workDir(repo2), `round-${r}`, 'report.json'), 'utf8'));
      const pages = ofType('page').filter((e) => e.round === r);
      assert.equal(pages.length, rep.pages.length, `round ${r} page events`);
      assert.deepEqual(ofType('summary').find((e) => e.round === r).summary, rep.summary);
    }
  });
  check('loop --events: fix n of m, with the outcome of each task', () => {
    const fix = ofType('step').find((e) => e.step === 'fix' && e.round === 1);
    const tasks = ofType('task').filter((e) => e.round === 1 && e.state === 'start');
    assert.ok(fix && fix.count > 0);
    assert.deepEqual(tasks.map((t) => t.n), Array.from({ length: fix.count }, (_, i) => i + 1));
    assert.ok(tasks.every((t) => t.m === fix.count));
    assert.ok(ofType('task').some((t) => t.state === 'done' && t.outcome === 'committed'));
  });
  check('loop --events: await-deploy is emitted and a newline on stdin starts the next round', () => {
    const waits = ofType('await-deploy');
    assert.ok(waits.length >= 1 && waits[0].round === 1 && waits[0].nextRound === 2, JSON.stringify(waits));
    const iWait = events.indexOf(waits[0]);
    const iRound2 = events.findIndex((e) => e.type === 'round' && e.round === 2);
    assert.ok(iRound2 > iWait, 'round 2 started after the prompt');
    assert.ok(!/press Enter/.test(evLoop.out), 'the human prompt is not on stdout');
  });
  check('loop --events: with a saved session in the directory, each round crawls with --state and says so once', () => {
    const said = events.filter((e) => e.type === 'info' && /crawling with the saved session a11y-508-state\.json/.test(e.message));
    assert.equal(said.length, 1, JSON.stringify(events.filter((e) => e.type === 'info').map((e) => e.message)));
    for (const r of [1, 2]) {
      const rep = JSON.parse(readFileSync(join(workDir(repo2), `round-${r}`, 'report.json'), 'utf8'));
      assert.ok(rep.options.session, `round ${r} crawled with the session`);
    }
  });
  check('loop --events: the assistant\'s output streams as agent-output events, per task', () => {
    const out = ofType('agent-output');
    assert.ok(out.length > 0, 'agent-output events');
    const fix1 = out.filter((e) => e.round === 1 && e.kind === 'fix' && e.task === 1);
    assert.match(fix1.map((e) => e.text).join(''), /fake agent: reading the prompt\n.*fake agent: looking at the finding/s);
    // The output of a task arrives between its start and done events.
    const start = events.findIndex((e) => e.type === 'task' && e.round === 1 && e.n === 1 && e.state === 'start');
    const done = events.findIndex((e) => e.type === 'task' && e.round === 1 && e.n === 1 && e.state === 'done');
    const at = events.indexOf(fix1[0]);
    assert.ok(start < at && at < done, `${start} < ${at} < ${done}`);
  });
  check('tool-files guard 7: the assistant\'s output shows the state base as ~/.a11y-508/…, never in full', () => {
    const text = ofType('agent-output').map((e) => e.text).join('');
    assert.match(text, /fake agent: prompt at ~\/\.a11y-508\/repos\/[^/]+\/work\/tasks\/prompt-r1-/);
    assert.ok(!text.includes(HOME), `the pane shows ${HOME}`);
  });
  check('loop --events: the last ledger event equals the ledger on disk', () => {
    const last = ofType('ledger').at(-1);
    assert.equal(last.rounds, ledger2.rounds.length);
    assert.deepEqual(last.counts, statusCounts(ledger2));
  });
}
rmSync(repo2, { recursive: true, force: true });

// ---- e2e: --from-report: round 1 starts from the report a crawl just produced, without crawling
{
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const repo3 = realpathSync(mkdtempSync(join(tmpdir(), 'a11y-508-fromreport-')));
  mkdirSync(join(repo3, 'site'), { recursive: true });
  for (const f of ['index.html', 'about.html', 'forms.html']) cpSync(join(here, 'fixtures', f), join(repo3, 'site', f));
  const site3 = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      return res.end();
    }
    let path = new URL(req.url, 'http://x').pathname;
    if (path === '/') path = '/index.html';
    if (path.startsWith('/img/') || path === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    const file = join(repo3, 'site', path);
    if (extname(path) !== '.html' || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN));
  });
  await new Promise((r) => site3.listen(0, '127.0.0.1', r));
  const base3 = `http://127.0.0.1:${site3.address().port}/`;
  const g3 = (...args) => {
    const r = spawnSync('git', args, { cwd: repo3, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g3('init', '-q', '-b', 'main');
  g3('config', 'user.email', 'loop-test@example.test');
  g3('config', 'user.name', 'loop test');
  g3('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo3, '.gitignore'), '');
  const crawlArgs = ['--max-pages', '3', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'];
  writeFileSync(join(repo3, 'a11y-508.config.json'), JSON.stringify({
    url: base3, args: crawlArgs,
    agent: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, 'fake-agent.mjs'))} {promptFile} {resultFile}`,
    source: ['site'], deploy: `${JSON.stringify(process.execPath)} -e 0`, push: false, maxAttempts: 3,
  }, null, 2));
  g3('add', '-A');
  g3('commit', '-q', '-m', 'fixture site');
  const bin = join(root, 'bin/a11y-508.mjs');
  const env = { ...process.env, TOKEN, NO_COLOR: '1' };
  // The crawl the person just ran (the wizard's).
  const runIn = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: repo3, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d) => ((out += d), (stdout += d)));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, out, stdout });
    });
  });
  // No --out: inside a repository the report goes to the tool's own folder for it.
  const crawl = await runIn([base3, ...crawlArgs, '--quiet', '--fail-on', 'none']);
  const reportFile = join(reportDir(repo3), 'report.json');
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  check('tool-files AC1: a crawl inside a repository writes its report to the tool\'s own folder, not the repository', () => {
    assert.equal(crawl.status, 0, crawl.out);
    assert.ok(existsSync(reportFile), crawl.out);
    assert.ok(!existsSync(join(repo3, 'a11y-508-report')), 'a11y-508-report in the repository');
  });
  const loop1 = await runIn(['loop', '--max-rounds', '1', '--from-report', reportFile, '--events']);
  const ledger3 = loadLedger(join(workDir(repo3), 'ledger.json'));
  const { events: ev3 } = parseEvents(loop1.stdout);
  check('--from-report: round 1 folds the report into the ledger without crawling', () => {
    assert.equal(crawl.status, 0, crawl.out);
    assert.equal(ledger3.rounds.length, 1, loop1.out);
    assert.equal(ledger3.rounds[0].source, 'report', JSON.stringify(ledger3.rounds[0]));
    assert.equal(ledger3.rounds[0].reportFinishedAt, report.finishedAt);
    assert.equal(ledger3.rounds[0].violations, report.summary.violations);
    // The round's folder holds the report it started from (History lists it), and no crawl log.
    assert.ok(!existsSync(join(workDir(repo3), 'round-1', 'crawl.log')), 'round 1 crawled');
    assert.equal(JSON.parse(readFileSync(join(workDir(repo3), 'round-1', 'report.json'), 'utf8')).finishedAt, report.finishedAt);
    assert.ok(!ev3.some((e) => e.type === 'page'), 'page events in round 1');
    assert.ok(ev3.some((e) => e.type === 'step' && e.step === 'report' && e.round === 1));
    assert.ok(!ev3.some((e) => e.type === 'step' && e.step === 'crawl'));
  });
  check('--from-report: the assistant was called for the report\'s findings, and a fix was committed', () => {
    const msgs = new Set([...report.pages.flatMap((p) => p.findings || []), ...report.site.findings].map((f) => f.message));
    const fixes = ev3.filter((e) => e.type === 'task' && e.state === 'start');
    assert.ok(fixes.length > 0, loop1.out);
    for (const t of fixes) assert.ok(msgs.has(t.message), t.message);
    assert.ok(existsSync(join(tasksOf(repo3), 'prompt-r1-fix-0.md')));
    assert.match(g3('log', '--format=%s'), /^a11y-508: /m);
  });
  // The same report again: older than the loop's commit, so the loop says so and crawls.
  const loop2 = await runIn(['loop', '--max-rounds', '1', '--from-report', reportFile]);
  check('--from-report: a report older than the loop\'s last commit is refused with the reason, and the round crawls', () => {
    assert.match(loop2.out, /not starting from .*report\.json: it is older than the loop's last commit/);
    assert.ok(existsSync(join(workDir(repo3), 'round-2')), loop2.out);
    assert.equal(loadLedger(join(workDir(repo3), 'ledger.json')).rounds[1].source, undefined);
  });
  // A report for another URL: refused, and the round crawls.
  const other = { ...report, baseUrl: 'http://127.0.0.1:9/elsewhere/', finishedAt: new Date(Date.now() + 60000).toISOString() };
  writeFileSync(join(workDir(repo3), 'other.json'), JSON.stringify(other));
  const loop3 = await runIn(['loop', '--max-rounds', '1', '--from-report', join(workDir(repo3), 'other.json')]);
  check('--from-report: a report for another URL is refused with the reason, and the round crawls', () => {
    assert.match(loop3.out, /it is for http:\/\/127\.0\.0\.1:9\/elsewhere\/, not /);
    assert.ok(existsSync(join(workDir(repo3), 'round-3')), loop3.out);
  });
  site3.close();
  rmSync(repo3, { recursive: true, force: true });
}

// ---- e2e: the loop gets itself onto a usable branch, and set-up errors say what to do
// (docs/plans/loop-resilience.md). Every repository here is a directory this file created under the
// OS temp directory; removeOwn removes nothing else.
{
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { relative, isAbsolute } = await import('node:path');
  const ours = new Set();
  const mkTemp = (prefix) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    ours.add(d);
    return d;
  };
  const removeOwn = (d) => {
    const rel = relative(realpathSync(tmpdir()), d);
    if (!ours.has(d) || !rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing to remove ${d}: not a directory this test created under the temp directory`);
    rmSync(d, { recursive: true, force: true, maxRetries: 10 });
    ours.delete(d);
  };
  const bin = join(root, 'bin/a11y-508.mjs');
  const fake = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, 'fake-agent.mjs'))} {promptFile} {resultFile}`;
  const quick = ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'];
  // A repository holding the fixture's start page under site/, with a config; { git: false } leaves it a plain folder.
  const appRepo = (prefix, config, { git = true } = {}) => {
    const dir = mkTemp(prefix);
    mkdirSync(join(dir, 'site'), { recursive: true });
    cpSync(join(here, 'fixtures', 'index.html'), join(dir, 'site', 'index.html'));
    writeFileSync(join(dir, '.gitignore'), 'check-logs/\n');
    mkdirSync(join(dir, 'check-logs'));
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, deployed: 'none', maxAttempts: 3, ...config }, null, 2));
    const g = (...args) => {
      const env = args[0] && typeof args[0] === 'object' ? args.shift() : {};
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    if (git) {
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 'loop-test@example.test');
      g('config', 'user.name', 'loop test');
      g('config', 'commit.gpgsign', 'false');
      g('add', '-A');
      g('commit', '-q', '-m', 'fixture site');
    }
    return { dir, g };
  };
  const loopIn = (dir, args, env = {}) => cli(dir, ['loop', ...args], env);
  const cli = (dir, args, env = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: dir, env: { ...process.env, TOKEN, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let out = '';
    child.stdout.on('data', (d) => ((stdout += d), (out += d)));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, out });
    });
  });
  const serve = (dir) => {
    const srv = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401);
        return res.end();
      }
      let path = new URL(req.url, 'http://x').pathname;
      if (path === '/') path = '/index.html';
      if (path.startsWith('/img/') || path === '/pixel.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      const file = join(dir, 'site', path);
      if (extname(path) !== '.html' || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN));
    });
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
  };
  const infos = (events) => events.filter((e) => e.type === 'info').map((e) => e.message);
  // Nothing listens on the discard port: the round's crawl fails at once, after the branch is settled.
  const DEAD = 'http://127.0.0.1:9/';

  // AC 1, guard 1: a11y-508/fixes exists (an earlier run's), the loop's branch is a11y-508.
  {
    const { dir, g } = appRepo('a11y-508-nested-', { branch: 'a11y-508' });
    const site = await serve(dir);
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'a11y-508.config.json'), 'utf8')), url: `http://127.0.0.1:${site.address().port}/` }, null, 2));
    g('commit', '-qam', 'the config names the site');
    g('branch', 'a11y-508/fixes');
    const r = await loopIn(dir, ['--max-rounds', '1', '--events']);
    site.close();
    const { events, problems } = parseEvents(r.stdout);
    check('loop-resilience AC1: with a11y-508/fixes in the repository, the loop for a11y-508 commits its round on a11y-508/fixes, says why once, and exits as a normal round', () => {
      assert.deepEqual(problems, []);
      assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'a11y-508/fixes', r.out);
      assert.match(g('log', '--format=%s', 'main..a11y-508/fixes'), /^a11y-508: /m);
      assert.equal(g('log', '--format=%s', 'main', '--grep=^a11y-508: '), '');
      const why = infos(events).filter((m) => /^on branch /.test(m));
      assert.deepEqual(why, ['on branch a11y-508/fixes: a branch a11y-508 cannot be created while a11y-508/fixes exists (git keeps branches as paths); continuing on a11y-508/fixes']);
      assert.ok(!events.some((e) => e.type === 'error' || e.type === 'precondition'), JSON.stringify(events.filter((e) => e.type === 'error' || e.type === 'precondition')));
      assert.equal(r.status, 1, r.out);
      assert.equal(events.at(-1).code, 1);
    });
    removeOwn(dir);
  }

  // Guard 2: of two nested branches, the most recently committed one.
  {
    const { dir, g } = appRepo('a11y-508-nested2-', { branch: 'a11y-508', url: DEAD });
    const at = (iso) => ({ GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso });
    g('checkout', '-q', '-b', 'a11y-508/new');
    writeFileSync(join(dir, 'new.txt'), 'new\n');
    g('add', 'new.txt');
    g(at('2026-09-01T12:00:00Z'), 'commit', '-q', '-m', 'newer');
    g('checkout', '-q', 'main');
    g('checkout', '-q', '-b', 'a11y-508/old');
    writeFileSync(join(dir, 'old.txt'), 'old\n');
    g('add', 'old.txt');
    g(at('2020-01-01T12:00:00Z'), 'commit', '-q', '-m', 'older');
    g('checkout', '-q', 'main');
    const r = await loopIn(dir, ['--max-rounds', '1', '--events']);
    const { events } = parseEvents(r.stdout);
    check('loop-resilience guard 2: with a11y-508/old and a11y-508/new, the loop continues on the most recently committed, a11y-508/new', () => {
      assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'a11y-508/new', r.out);
      assert.ok(infos(events).some((m) => /^on branch a11y-508\/new: .*the most recently committed of 2 a11y-508\/\* branches$/.test(m)), infos(events).join('\n'));
      assert.ok(!events.some((e) => e.type === 'precondition'));
    });
    removeOwn(dir);
  }

  // AC 2: the reverse -- a11y-508 exists, the loop's branch is a11y-508/fixes.
  {
    const { dir, g } = appRepo('a11y-508-parent-', { branch: 'a11y-508/fixes', url: DEAD });
    g('branch', 'a11y-508');
    const r = await loopIn(dir, ['--max-rounds', '1', '--events']);
    const { events } = parseEvents(r.stdout);
    check('loop-resilience AC2: with a11y-508 in the repository, the loop for a11y-508/fixes continues on a11y-508 and says why', () => {
      assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'a11y-508', r.out);
      assert.deepEqual(infos(events).filter((m) => /^on branch /.test(m)), ['on branch a11y-508: a branch a11y-508/fixes cannot be created while a11y-508 exists (git keeps branches as paths); continuing on a11y-508']);
      assert.ok(!events.some((e) => e.type === 'precondition'));
      // It went on to the round (whose crawl had nothing to reach).
      assert.ok(events.some((e) => e.type === 'round' && e.round === 1), r.out);
    });
    removeOwn(dir);
  }

  // AC 1 on a fresh clone: the earlier run's branch is only on origin. The loop takes origin's, tracking it.
  for (const [onOrigin, wanted] of [['a11y-508/fixes', 'a11y-508'], ['a11y-508', 'a11y-508']]) {
    const { dir: upstream, g: gu } = appRepo('a11y-508-origin-', { branch: wanted, url: DEAD });
    gu('checkout', '-q', '-b', onOrigin);
    writeFileSync(join(upstream, 'earlier.txt'), 'an earlier fix\n');
    gu('add', 'earlier.txt');
    gu('commit', '-q', '-m', 'a11y-508: earlier fix');
    gu('checkout', '-q', 'main');
    const clone = mkTemp('a11y-508-clone-');
    const c = spawnSync('git', ['clone', '-q', upstream, clone], { encoding: 'utf8' });
    const gc = (...a) => spawnSync('git', a, { cwd: clone, encoding: 'utf8' }).stdout.trim();
    const r = await loopIn(clone, ['--max-rounds', '1', '--events']);
    check(`loop-resilience AC1: in a fresh clone whose origin has ${onOrigin}, the loop for ${wanted} continues on ${onOrigin}, tracking origin`, () => {
      assert.equal(c.status, 0, c.stderr);
      assert.equal(gc('rev-parse', '--abbrev-ref', 'HEAD'), onOrigin, r.out);
      assert.equal(gc('rev-parse', '--abbrev-ref', '@{upstream}'), `origin/${onOrigin}`);
      assert.match(gc('log', '--format=%s', '-1'), /^a11y-508: earlier fix$/);
      assert.ok(!parseEvents(r.stdout).events.some((e) => e.type === 'precondition'), r.out);
    });
    removeOwn(clone);
    removeOwn(upstream);
  }

  // AC 4, guard 4: every set-up error before the first round is one precondition event with a remedy.
  {
    const cases = [];
    {
      const { dir } = appRepo('a11y-508-norepo-', { url: DEAD }, { git: false });
      cases.push({ code: 'not-a-repo', dir, message: new RegExp(`^${dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} is not a git repository`), remedy: /git init/ });
    }
    {
      const { dir } = appRepo('a11y-508-dirty-', { url: DEAD });
      writeFileSync(join(dir, 'site', 'index.html'), readFileSync(join(dir, 'site', 'index.html'), 'utf8') + '\n<!-- edited -->\n');
      writeFileSync(join(dir, 'site', 'new.html'), '<!doctype html>');
      cases.push({ code: 'dirty-tree', dir, message: /^uncommitted changes under site: .*site\/index\.html/, remedy: /^Commit or stash them .*site\/index\.html, site\/new\.html$/ });
    }
    {
      const { dir } = appRepo('a11y-508-badbranch-', { url: DEAD, branch: 'bad..name' });
      cases.push({ code: 'branch', dir, message: /^cannot switch to branch bad\.\.name: /, remedy: /git check-ref-format --branch "bad\.\.name"/ });
    }
    for (const c of cases) {
      const r = await loopIn(c.dir, ['--max-rounds', '1', '--events']);
      const { events, problems } = parseEvents(r.stdout);
      check(`loop-resilience AC4: ${c.code} is one precondition event with its remedy, before any round, exit 2`, () => {
        assert.deepEqual(problems, []);
        const pre = events.filter((e) => e.type === 'precondition');
        assert.equal(pre.length, 1, r.out);
        assert.equal(pre[0].code, c.code);
        assert.match(pre[0].message, c.message);
        assert.match(pre[0].remedy, c.remedy);
        assert.ok(!events.some((e) => e.type === 'round'), 'a round started');
        assert.equal(r.status, 2);
        assert.equal(events.at(-1).type, 'done');
        assert.equal(events.at(-1).code, 2);
      });
      const plain = await loopIn(c.dir, ['--max-rounds', '1']);
      check(`loop-resilience AC4: ${c.code} without --events prints the message and the remedy, exit 2`, () => {
        assert.equal(plain.status, 2, plain.out);
        const lines = plain.out.split('\n');
        assert.ok(lines.some((l) => l.startsWith('error ') && c.message.test(l.slice(6))), plain.out);
        assert.ok(lines.some((l) => l.startsWith('to fix: ') && c.remedy.test(l.slice(8))), plain.out);
      });
      removeOwn(c.dir);
    }
  }

  // AC 7, guard 7: Try again after a set-up error continues from the ledger -- what an earlier run
  // fixed (or gave up on) is not taken up again. The dashboard's Try again runs exactly this command.
  {
    const { dir, g } = appRepo('a11y-508-retry-', { maxAttempts: 1 });
    const site = await serve(dir);
    const url = `http://127.0.0.1:${site.address().port}/`;
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'a11y-508.config.json'), 'utf8')), url }, null, 2));
    g('commit', '-qam', 'the config names the site');
    const crawl = await cli(dir, [url, ...quick, '--quiet', '--fail-on', 'none']);
    const fromReport = ['--max-rounds', '1', '--from-report', join(reportDir(dir), 'report.json'), '--events'];
    const first = await loopIn(dir, fromReport);
    const ledgerFile = join(workDir(dir), 'ledger.json');
    const afterFirst = loadLedger(ledgerFile);
    const fixedFirst = Object.values(afterFirst.findings).filter((e) => e.status === 'pending').map((e) => e.message);
    // Someone edits the source: the next run stops before its first round.
    writeFileSync(join(dir, 'site', 'index.html'), readFileSync(join(dir, 'site', 'index.html'), 'utf8') + '\n<!-- edited -->\n');
    const blocked = await loopIn(dir, fromReport);
    g('checkout', '--', 'site');
    const retry = await loopIn(dir, fromReport);
    site.close();
    const ev1 = parseEvents(blocked.stdout).events;
    const { events, problems } = parseEvents(retry.stdout);
    check('loop-resilience AC7: Try again after a set-up error continues from the ledger; nothing already fixed is fixed again', () => {
      assert.equal(crawl.status, 0, crawl.out);
      assert.ok(fixedFirst.length >= 2, first.out);
      assert.equal(ev1.filter((e) => e.type === 'precondition').map((e) => e.code).join(), 'dirty-tree', blocked.out);
      assert.deepEqual(problems, []);
      // The retry is the ledger's next round, and every fix of the first run is verified by it.
      assert.deepEqual(events.filter((e) => e.type === 'round').map((e) => e.round), [2], retry.out);
      const ledger = loadLedger(ledgerFile);
      // The fixes that held are verified by it (a group's commit may not have fixed every element: those are not verified).
      const statuses = fixedFirst.map((m) => Object.values(ledger.findings).find((e) => e.message === m).status);
      assert.ok(statuses.filter((x) => x === 'verified').length >= 2, statuses.join(', '));
      // The retried round's fix count: nothing was open, so no assistant call and no new commit.
      const tasks = events.filter((e) => e.type === 'task' && e.state === 'start');
      assert.equal(tasks.length, 0, tasks.map((t) => t.message).join('\n'));
      assert.equal(g('log', '--format=%s', '--grep=^a11y-508: ').split('\n').filter(Boolean).length, fixedFirst.length);
      assert.equal(retry.status, 0, retry.out);
    });
    removeOwn(dir);
  }

  // AC 14, 15 (and guard 14/15): between assistant calls the gate and the commit are events, the gate's
  // output streams, and the counts move after every commit.
  {
    const { dir, g } = appRepo('a11y-508-gate-', {});
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\nconsole.log('building the site');\nawait new Promise((r) => setTimeout(r, 400));\nif (readFileSync('site/index.html', 'utf8').includes('BREAK-THE-BUILD')) { console.error('error: the build is broken'); process.exit(1); }\nconsole.log('tests passed');\n");
    const site = await serve(dir);
    const url = `http://127.0.0.1:${site.address().port}/`;
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, deployed: 'none', maxAttempts: 3, url, check: `${JSON.stringify(process.execPath)} check.mjs` }, null, 2));
    g('add', '-A');
    g('commit', '-qm', 'the gate');
    const r = await loopIn(dir, ['--max-rounds', '1', '--events']);
    site.close();
    const { events, problems } = parseEvents(r.stdout);
    const at = (pred) => events.findIndex(pred);
    check('loop-resilience AC14: each fix is gated with gate start/done events, the gate output streams, and a commit event names the commit and files', () => {
      assert.deepEqual(problems, []);
      const starts = events.filter((e) => e.type === 'gate' && e.state === 'start');
      const dones = events.filter((e) => e.type === 'gate' && e.state === 'done');
      assert.ok(starts.length >= 3 && starts.length === dones.length, r.out);
      assert.ok(dones.some((d) => d.ok === true && d.durationMs >= 400 && /tests passed/.test(d.tail)));
      const failed = dones.find((d) => d.ok === false);
      assert.ok(failed && /error: the build is broken/.test(failed.tail), JSON.stringify(dones));
      assert.match(events.filter((e) => e.type === 'gate-output').map((e) => e.text).join(''), /building the site/);
      const commits = events.filter((e) => e.type === 'commit');
      assert.ok(commits.length >= 2);
      for (const c of commits) {
        assert.match(c.commit, /^[0-9a-f]{7,}$/);
        assert.deepEqual(c.files, ['site/index.html']);
        assert.ok(at((e) => e === c) > at((e) => e.type === 'gate' && e.state === 'done' && e.n === c.n && e.ok));
      }
    });
    check('loop-resilience AC17/18: an attempt event per fix with the working tree\'s files, its outcome, and the assistant\'s and the check\'s times; the ledger records them', () => {
      const attempts = events.filter((e) => e.type === 'attempt');
      const done = events.filter((e) => e.type === 'task' && e.state === 'done');
      assert.equal(attempts.length, done.length);
      const ok = attempts.filter((a) => a.outcome === 'committed');
      assert.ok(ok.length >= 2);
      for (const a of ok) {
        assert.deepEqual(a.files, ['site/index.html']);
        assert.match(a.commit, /^[0-9a-f]{7,}$/);
        assert.ok(a.agentMs >= 0 && a.gateMs >= 400 && a.gateCode === 0, JSON.stringify(a));
      }
      const bad = attempts.find((a) => a.outcome === 'failed-gate');
      assert.ok(bad && bad.gateCode === 1 && /error: the build is broken/.test(bad.gateTail), JSON.stringify(bad));
      assert.ok(events.some((e) => e.type === 'changes' && e.files.includes('site/index.html')));
      const ledger = loadLedger(join(workDir(dir), 'ledger.json'));
      const gated = Object.values(ledger.findings).flatMap((e) => e.attempts).filter((x) => x.outcome === 'failed-gate' || x.commit);
      assert.ok(gated.length >= 3 && gated.every((x) => typeof x.gateMs === 'number' && typeof x.gateCode === 'number' && typeof x.agentMs === 'number'), JSON.stringify(gated));
    });
    check('loop-resilience AC15: the counts move after the first commit, before the next fix starts', () => {
      const firstCommit = at((e) => e.type === 'commit');
      const nextTask = at((e, i) => i > firstCommit && e.type === 'task' && e.state === 'start');
      assert.ok(firstCommit >= 0 && nextTask > firstCommit, r.out);
      const between = events.slice(firstCommit, nextTask).filter((e) => e.type === 'ledger');
      assert.ok(between.some((e) => (e.counts.pending || 0) >= 1), JSON.stringify(between));
      assert.match(between.at(-1).line, /\d+ fixed, awaiting verification/);
    });
    removeOwn(dir);
  }

  // AC 19: the check has a time limit; past it the check's process tree is ended and the fix reverted.
  {
    const { dir, g } = appRepo('a11y-508-slowcheck-', {});
    const site = await serve(dir);
    const url = `http://127.0.0.1:${site.address().port}/`;
    // The check starts a process of its own that never ends either: the whole tree must go.
    writeFileSync(join(dir, 'slow-check.mjs'), "import { spawn } from 'node:child_process';\nimport { appendFileSync } from 'node:fs';\nconst c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });\nappendFileSync('check-logs/check-pids.log', `${process.pid} ${c.pid}\\n`);\nsetTimeout(() => {}, 120000);\n");
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, deployed: 'none', url, checkTimeout: 2000, check: `${JSON.stringify(process.execPath)} slow-check.mjs && ${JSON.stringify(process.execPath)} -e 0` }, null, 2));
    g('add', '-A');
    g('commit', '-qm', 'a check that never ends');
    const t0 = Date.now();
    const r = await loopIn(dir, ['--max-rounds', '1', '--events']);
    site.close();
    const { events } = parseEvents(r.stdout);
    check('loop-resilience AC19: a check past checkTimeout is ended and the fix reverted, with the reason', () => {
      assert.ok(Date.now() - t0 < 90000, `took ${Date.now() - t0} ms`);
      const failed = events.filter((e) => e.type === 'attempt' && e.outcome === 'failed-gate');
      assert.ok(failed.length >= 2, r.out);
      for (const a of failed) assert.equal(a.reason, 'the check did not finish within 2 s');
      assert.equal(events.filter((e) => e.type === 'commit').length, 0);
      assert.equal(g('status', '--porcelain', '--', 'site'), '');
      // Every process the check started is gone.
      const pids = readFileSync(join(dir, 'check-logs', 'check-pids.log'), 'utf8').split(/\s+/).filter(Boolean).map(Number);
      assert.ok(pids.length >= 4, pids.join(' '));
      const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      assert.deepEqual(alive, []);
    });
    removeOwn(dir);
  }

  // AC 20: each fix is built; the tests run once for the round; a fix that breaks them is found and reverted.
  for (const breaking of [false, true]) {
    const { dir, g } = appRepo(breaking ? 'a11y-508-bisect-' : 'a11y-508-testsonce-', {});
    writeFileSync(join(dir, 'build.mjs'), "import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync('check-logs/build-runs.log', 'build\\n');\nif (readFileSync('site/index.html', 'utf8').includes('BREAK-THE-BUILD')) { console.error('error: the build is broken'); process.exit(1); }\n");
    // The tests fail on the iframe fix only where tests-break exists (the bisect case).
    writeFileSync(join(dir, 'test.mjs'), "import { appendFileSync, existsSync, readFileSync } from 'node:fs';\nappendFileSync('check-logs/test-runs.log', 'test\\n');\nif (existsSync('tests-break') && readFileSync('site/index.html', 'utf8').includes('title=\"About us\"')) { console.error('FAIL the iframe test'); process.exit(1); }\nconsole.log('tests passed');\n");
    if (breaking) writeFileSync(join(dir, 'tests-break'), 'yes\n');
    const site = await serve(dir);
    const url = `http://127.0.0.1:${site.address().port}/`;
    const node = JSON.stringify(process.execPath);
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, deployed: 'none', url, check: `${node} build.mjs && ${node} test.mjs` }, null, 2));
    g('add', '-A');
    g('commit', '-qm', 'build and tests');
    const r = await loopIn(dir, ['--max-rounds', '1', '--events'], { FAKE_AGENT_FIX_IFRAME: '1' });
    site.close();
    const { events, problems } = parseEvents(r.stdout);
    const runs = (f) => (existsSync(join(dir, 'check-logs', f)) ? readFileSync(join(dir, 'check-logs', f), 'utf8').split('\n').filter(Boolean).length : 0);
    // Each fix's last word (a later event for the same fix replaces an earlier one), for the fixes that changed files.
    const byN = new Map();
    for (const e of events) if (e.type === 'attempt' && e.files.length) byN.set(e.n, e);
    const final = (test) => [...byN.values()].find((e) => e.test === test);
    const subjects = g('log', '--format=%s', '--grep=^a11y-508: ').split('\n').filter(Boolean);
    if (!breaking) {
      check('loop-resilience AC20: the build runs on every changed fix and the tests once for the round', () => {
        assert.deepEqual(problems, []);
        const built = events.filter((e) => e.type === 'gate' && e.state === 'start' && e.part === 'build').length;
        assert.ok(built >= 4, r.out);
        assert.equal(runs('build-runs.log'), built);
        assert.equal(runs('test-runs.log'), 1);
        assert.equal(events.filter((e) => e.type === 'gate' && e.state === 'start' && e.part === 'test').length, 1);
        assert.equal(subjects.length, 3, subjects.join('\n'));
      });
    } else {
      check('loop-resilience AC20: when the round\'s tests fail, the fix that breaks them is found and reverted; the others stay committed', () => {
        assert.deepEqual(problems, []);
        assert.equal(final('7.A').outcome, 'committed', r.out);
        assert.equal(final('13.C').outcome, 'committed');
        assert.equal(final('12.D').outcome, 'failed-gate');
        assert.match(final('12.D').gateTail, /FAIL the iframe test/);
        const found = events.find((e) => e.type === 'bisect' && e.state === 'found');
        assert.ok(found && found.test === '12.D', JSON.stringify(found));
        assert.ok(subjects.some((x) => /^a11y-508: 7\.A /.test(x)) && subjects.some((x) => /^a11y-508: 13\.C /.test(x)), subjects.join('\n'));
        assert.ok(!subjects.some((x) => /^a11y-508: 12\.D /.test(x)), subjects.join('\n'));
        assert.ok(!readFileSync(join(dir, 'site', 'index.html'), 'utf8').includes('title="About us"'));
        assert.equal(g('status', '--porcelain', '--', 'site'), '');
        const ledger = loadLedger(join(workDir(dir), 'ledger.json'));
        const iframe = Object.values(ledger.findings).find((e) => e.test === '12.D' && e.attempts.length);
        assert.equal(iframe.status, 'open');
        assert.equal(iframe.attempts.at(-1).outcome, 'failed-gate');
      });
    }
    removeOwn(dir);
  }

  // AC 20 with Stop: a stop while the round's tests run blames no fix and loses no commit, even when the
  // process is killed 3 s later (as the dashboard's Stop does).
  if (process.platform !== 'win32') {
    const { dir, g } = appRepo('a11y-508-stoptests-', {});
    writeFileSync(join(dir, 'build.mjs'), "process.exit(0);\n");
    writeFileSync(join(dir, 'test.mjs'), "console.log('testing');\nawait new Promise((r) => setTimeout(r, 8000));\nconsole.log('tests passed');\n");
    const site = await serve(dir);
    const url = `http://127.0.0.1:${site.address().port}/`;
    const node = JSON.stringify(process.execPath);
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, deployed: 'none', url, check: `${node} build.mjs && ${node} test.mjs` }, null, 2));
    g('add', '-A');
    g('commit', '-qm', 'slow tests');
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, 'loop', '--max-rounds', '1', '--events'], { cwd: dir, env: { ...process.env, TOKEN, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let stdout = '';
      let signalled = false;
      child.stdout.on('data', (d) => {
        stdout += d;
        if (!signalled && /"part":"test"/.test(stdout)) {
          signalled = true;
          setTimeout(() => {
            try { process.kill(-child.pid, 'SIGINT'); } catch {}
            setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
          }, 500);
        }
      });
      child.stderr.on('data', () => {});
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 240000);
      child.on('exit', () => { clearTimeout(timer); resolve(stdout); });
    });
    site.close();
    const { events } = parseEvents(out);
    check('loop-resilience AC20: Stop during the round\'s tests keeps every commit and blames no fix', () => {
      const committedFixes = events.filter((e) => e.type === 'commit').length;
      assert.ok(committedFixes >= 2, out);
      assert.equal(g('log', '--format=%s', '--grep=^a11y-508: ').split('\n').filter(Boolean).length, committedFixes);
      assert.ok(!events.some((e) => e.type === 'bisect'), 'a bisect ran');
      assert.ok(!events.some((e) => e.type === 'attempt' && e.outcome === 'failed-gate' && /broke the tests|round's tests failed/.test(e.gateTail || '')), 'a fix was blamed');
    });
    removeOwn(dir);
  }

  // AC 21: the same problem on four elements is one fix task: one assistant call, one check, one commit, four attempts.
  {
    const { dir, g } = appRepo('a11y-508-group-', {});
    writeFileSync(join(dir, 'site', 'index.html'), "<!doctype html><html lang=\"en\"><head><title>Four images</title></head><body><main><h1>Four images</h1><img src=\"/img/a.png\"><img src=\"/img/b.png\"><img src=\"/img/c.png\"><img src=\"/img/d.png\"></main></body></html>\n");
    const site = await serve(dir);
    const url = `http://127.0.0.1:${site.address().port}/`;
    writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, deployed: 'none', url, check: `${JSON.stringify(process.execPath)} -e 0` }, null, 2));
    g('commit', '-qam', 'four images without alt');
    const r = await loopIn(dir, ['--max-rounds', '1', '--events']);
    site.close();
    const { events, problems } = parseEvents(r.stdout);
    check('loop-resilience AC21: four same-test, same-message findings are one task: one call, one check, one commit, four attempts', () => {
      assert.deepEqual(problems, []);
      const starts = events.filter((e) => e.type === 'task' && e.state === 'start' && e.test === '7.A' && /no alt attribute/.test(e.message));
      assert.equal(starts.length, 1, r.out);
      assert.equal(starts[0].elements, 4);
      const prompt = readFileSync(join(tasksOf(dir), `prompt-r1-fix-${starts[0].n - 1}.md`), 'utf8');
      assert.match(prompt, /These 4 findings are the same problem on different elements; fix the cause once if there is one, otherwise fix each\./);
      assert.equal(events.filter((e) => e.type === 'gate' && e.state === 'start' && e.n === starts[0].n).length, 1);
      const attempts = events.filter((e) => e.type === 'attempt' && e.n === starts[0].n);
      assert.equal(attempts.length, 1);
      assert.deepEqual([attempts[0].outcome, attempts[0].elements], ['committed', 4]);
      const ledger = loadLedger(join(workDir(dir), 'ledger.json'));
      const imgs = Object.values(ledger.findings).filter((e) => e.test === '7.A' && /no alt attribute/.test(e.message));
      assert.equal(imgs.length, 4);
      assert.deepEqual(new Set(imgs.map((e) => e.attempts.at(-1).commit)), new Set([attempts[0].commit]));
      assert.ok(imgs.every((e) => e.status === 'pending'));
      assert.equal(g('log', '--format=%s', '--grep=^a11y-508: 7.A').split('\n').filter(Boolean).length, 1);
    });
    removeOwn(dir);
  }

  // AC 6 and 11: an assistant that never runs is an error, not a quiet finish; a quota refusal is a
  // wait the dashboard can count down; a call given up is said in plain words.
  {
    const { dir, g } = appRepo('a11y-508-assistant-', {});
    const site = await serve(dir);
    const url = `http://127.0.0.1:${site.address().port}/`;
    const setConfig = (more) => writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, deployed: 'none', maxAttempts: 3, url, ...more }, null, 2));
    setConfig({ agent: 'a11y-508-no-such-assistant {promptFile}' });
    const missing = await loopIn(dir, ['--max-rounds', '1', '--events']);
    const m = parseEvents(missing.stdout);
    check('loop-resilience AC6: an assistant that never runs ends the loop with an error that says so', () => {
      assert.deepEqual(m.problems, []);
      const errors = m.events.filter((e) => e.type === 'error').map((e) => e.message);
      assert.equal(errors.length, 1, missing.out);
      assert.match(errors[0], /^The assistant did not run: all \d+ calls this round ended without an answer \(last exit code \d+\)\. Check that it is installed and signed in/);
      assert.equal(missing.status, 1);
    });
    const refusedOnce = join(mkTemp('a11y-508-429-'), 'refused');
    setConfig({ quotaDelays: [300] });
    const quota = await loopIn(dir, ['--max-rounds', '1', '--events'], { FAKE_AGENT_429_ONCE: refusedOnce });
    const q = parseEvents(quota.stdout);
    check('loop-resilience AC11b: a call refused for rate limit emits agent-wait before its retry, and the retry answers', () => {
      assert.deepEqual(q.problems, []);
      const waits = q.events.filter((e) => e.type === 'agent-wait');
      assert.equal(waits.length, 1, quota.out);
      assert.deepEqual([waits[0].reason, waits[0].delayMs, waits[0].attempt, waits[0].attempts, waits[0].round], ['quota', 300, 1, 1, 2]);
      const first = q.events.find((e) => e.type === 'agent-result');
      assert.deepEqual([first.ok, first.quota, first.task, first.kind], [true, false, waits[0].task, waits[0].kind]);
      assert.ok(q.events.indexOf(waits[0]) < q.events.indexOf(first));
    });
    const slow = join(mkTemp('a11y-508-slow-'), 'slow');
    setConfig({ agentTimeout: 2000 });
    const timedOut = await loopIn(dir, ['--max-rounds', '1', '--events'], { FAKE_AGENT_SLOW_ONCE: slow });
    site.close();
    const t = parseEvents(timedOut.stdout);
    check('loop-resilience AC11c: a call given up for time is an agent-result whose message says so in plain words', () => {
      assert.deepEqual(t.problems, []);
      const given = t.events.filter((e) => e.type === 'agent-result' && !e.ok);
      assert.equal(given.length, 1, timedOut.out);
      assert.equal(given[0].timedOut, true);
      assert.match(given[0].message, /^The assistant did not answer within 2 s; the loop goes on$/);
    });
    removeOwn(dirname(refusedOnce));
    removeOwn(dirname(slow));
    removeOwn(dir);
    void g;
  }

  // ---- the build check sees a deployment that keeps its file names: each script and stylesheet is
  // hashed, and two signatures compare by content (by name where a hash is unknown, as in a ledger an
  // earlier version wrote).
  {
    let body = 'console.log(1)';
    const srv = createServer((req, res) => {
      const path = new URL(req.url, 'http://x').pathname;
      if (path === '/app.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
      if (path === '/app.css') return res.writeHead(200, { 'content-type': 'text/css' }).end('b{}');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/app.css"><script src="/app.js"></script></head><body><p>app</p></body></html>');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const s1 = (await bundleSignature(url)).signature;
    body = 'console.log(2)';
    const s2 = (await bundleSignature(url)).signature;
    srv.close();
    // A start page the server answers 404 for while the app renders anyway (a deep link): read in the browser.
    const soft = createServer((req, res) => {
      const path = new URL(req.url, 'http://x').pathname;
      if (path === '/app.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('console.log(3)');
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><script src="/app.js"></script></head><body><p>app</p></body></html>');
    });
    await new Promise((r) => soft.listen(0, '127.0.0.1', r));
    const s3 = await bundleSignature(`http://127.0.0.1:${soft.address().port}/deep/link`);
    soft.close();
    check('deploy check: a start page served with 404 that loads the app all the same is read in the browser', () => {
      assert.equal(s3.via, 'browser', JSON.stringify(s3));
      assert.match(s3.signature, /^\/app\.js [0-9a-f]{64}$/, s3.signature);
    });
    check('deploy check: the signature hashes each script and stylesheet, so a new build with the same file names is seen', () => {
      assert.match(s1, /^\/app\.css [0-9a-f]{64}\n\/app\.js [0-9a-f]{64}\n\/favicon\.ico \?$/, s1);
      assert.ok(sameBuild(s1, s1));
      assert.ok(!sameBuild(s1, s2), `${s1}\n--\n${s2}`);
      assert.ok(s2.includes('/app.js ') && !s2.includes(s1.split('\n')[1]));
      // A names-only signature (an earlier version's ledger) compares by names.
      assert.ok(sameBuild('/app.css\n/app.js\n/favicon.ico', s1));
      assert.ok(!sameBuild('/app.css\n/app.2.js\n/favicon.ico', s1));
      assert.ok(!sameBuild(s1, null) && sameBuild(null, null));
    });
  }

  // ---- fixes waiting for a deployment someone else runs (docs/plans/deploy-wait.md): the site's
  // start page carries a script bundle whose name this test changes to stand for a new build.
  {
    const { dir } = appRepo('a11y-508-deploy-wait-', { deployed: 'bundle-change', deployTimeout: 2500, deployPoll: 400 });
    let build = 1;
    const srv = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401);
        return res.end();
      }
      let path = new URL(req.url, 'http://x').pathname;
      if (path === '/') path = '/index.html';
      if (/^\/bundle\.\d+\.js$/.test(path)) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end('');
      }
      if (path.startsWith('/img/') || path === '/pixel.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      const file = join(dir, 'site', path);
      if (extname(path) !== '.html' || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN).replace('</head>', `<script src="/bundle.${build}.js"></script></head>`));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const ledgerFile = join(workDir(dir), 'ledger.json');
    const first = await loopIn(dir, [url, '--max-rounds', '3']);
    const l1 = loadLedger(ledgerFile);
    const pending1 = Object.values(l1.findings).filter((e) => e.status === 'pending').length;
    check('deploy-wait AC2/AC3: the wait running out ends with exit 4 (not an error), the explanation and the three commands', () => {
      assert.equal(first.status, 4, first.out);
      assert.ok(pending1 > 0, first.out);
      assert.match(first.out, /Your deployment has not arrived yet/);
      assert.ok(first.out.includes(`${pending1} fix${pending1 === 1 ? ' is' : 'es are'} committed on branch main. The site at 127.0.0.1:${srv.address().port} still serves the build from before them, so they cannot be verified yet. Deploy that branch — or merge it into the branch your pipeline builds`), first.out);
      for (const c of ['a11y-508 loop --verify ', 'a11y-508 loop --from-report ', 'a11y-508 loop --wait ']) assert.ok(first.out.includes(c), `${c}\n${first.out}`);
      assert.doesNotMatch(first.out, /^error /m);
      assert.ok(l1.deploy && l1.deploy.signature.includes('/bundle.1.js'), JSON.stringify(l1.deploy));
    });
    const verify = await loopIn(dir, [url, '--verify', '--events']);
    const vEvents = parseEvents(verify.stdout);
    const l2 = loadLedger(ledgerFile);
    check('deploy-wait AC2/AC5: --verify with the old build still live ends at once, crawls nothing, and changes nothing', () => {
      assert.deepEqual(vEvents.problems, []);
      assert.equal(verify.status, 4, verify.out);
      const dep = vEvents.events.find((e) => e.type === 'deployment');
      assert.equal(dep && dep.state, 'still-old', verify.stdout);
      assert.ok(vEvents.events.some((e) => e.type === 'warn' && e.message === 'The site still serves the old build (checked just now); nothing was changed.'), verify.stdout);
      assert.ok(!vEvents.events.some((e) => e.type === 'step' || e.type === 'page' || e.type === 'round'), verify.stdout);
      assert.equal(l2.rounds.length, l1.rounds.length);
      assert.equal(Object.values(l2.findings).filter((e) => e.status === 'pending').length, pending1);
      assert.equal(vEvents.events[vEvents.events.length - 1].code, 4);
    });
    const remaining = await loopIn(dir, [url, '--from-report', '--events', '--max-rounds', '1']);
    const rEvents = parseEvents(remaining.stdout);
    const l3 = loadLedger(ledgerFile);
    check('deploy-wait AC2: --from-report with no file fixes from the ledger with no crawl; the waiting fixes stay pending', () => {
      assert.deepEqual(rEvents.problems, []);
      assert.ok(!rEvents.events.some((e) => (e.type === 'step' && e.step === 'crawl') || e.type === 'page'), remaining.stdout);
      assert.ok(rEvents.events.some((e) => e.type === 'step' && e.step === 'ledger'), remaining.stdout);
      assert.equal(l3.rounds[l3.rounds.length - 1].source, 'ledger');
      assert.ok(Object.values(l3.findings).filter((e) => e.status === 'pending').length >= pending1);
      // It then waits again for the same old build, and runs out.
      assert.equal(remaining.status, 4, remaining.out);
      assert.ok(l3.deploy.signature.includes('/bundle.1.js'));
    });
    build = 2;
    const arrived = await loopIn(dir, [url, '--verify', '--max-rounds', '1']);
    const l4 = loadLedger(ledgerFile);
    check('deploy-wait AC5: once the bundles changed, a loop start verifies the waiting fixes', () => {
      assert.match(arrived.out, /Your deployment arrived: verifying \d+ fixes/);
      assert.ok(Object.values(l4.findings).some((e) => e.status === 'verified'), arrived.out);
      assert.equal(l4.rounds.length, l3.rounds.length + 1, arrived.out);
    });
    srv.close();
    removeOwn(dir);
  }

  // ---- the start page behind a sign-in portal: an anonymous request is sent to a sign-in page on
  // another host, and only a request carrying the session cookie gets the app. The build is read
  // through the crawler's browser with the saved session; when the session has expired a visible
  // window signs in (the portal signs a visible Chrome in by itself, never a headless one); when the
  // page cannot be read at all, --verify takes the person's word.
  const ssoSite = async (dir) => {
    const site = { build: 1, session: 'ok', blockPlain: false, blockBrowserDocs: 0 };
    const srv = createServer((req, res) => {
      const port = srv.address().port;
      const ua = req.headers['user-agent'] || '';
      let path = new URL(req.url, 'http://x').pathname;
      if (path === '/signin') {
        const visible = /Chrome/.test(ua) && !/Headless/.test(ua);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html lang="en"><title>Sign in</title><h1>Sign in</h1>${visible ? `<script>setTimeout(() => location.replace('http://127.0.0.1:${port}/auth'), 500)</script>` : ''}</html>`);
      }
      if (path === '/auth') {
        res.writeHead(302, { location: '/', 'set-cookie': `sid=${site.session}; Path=/` });
        return res.end();
      }
      const plain = !/Chrome/.test(ua);
      // Neither way can read the page: it answers with an error.
      let down = plain && site.blockPlain;
      if (!plain && path === '/' && site.blockBrowserDocs > 0) {
        site.blockBrowserDocs--;
        down = true;
      }
      if (down) {
        res.writeHead(503, { 'content-type': 'text/html' });
        return res.end('<!doctype html><html lang="en"><title>Unavailable</title><h1>Unavailable</h1></html>');
      }
      if (!new RegExp(`(?:^|;\\s*)sid=${site.session}(?:;|$)`).test(req.headers.cookie || '')) {
        res.writeHead(302, { location: `http://localhost:${port}/signin` });
        return res.end();
      }
      if (path === '/') path = '/index.html';
      if (/^\/bundle\.\d+\.js$/.test(path)) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end('');
      }
      if (path.startsWith('/img/') || path === '/pixel.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
      }
      const file = join(dir, 'site', path);
      if (extname(path) !== '.html' || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(file, 'utf8').replace('EXTERNAL_IMAGE', '/pixel.png').replace('FIXTURE_TOKEN', TOKEN).replace('</head>', `<script src="/bundle.${site.build}.js"></script></head>`));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    site.srv = srv;
    site.url = `http://127.0.0.1:${srv.address().port}/`;
    return site;
  };
  // A repository whose crawl and build check use a saved session (what --login writes) with sid=ok.
  const ssoRepo = async (prefix, config) => {
    const { dir, g } = appRepo(prefix, config);
    const site = await ssoSite(dir);
    writeFileSync(join(dir, 'a11y-508-state.json'), JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), origins: [site.url.slice(0, -1)], cookies: [{ name: 'sid', value: 'ok', domain: '127.0.0.1', path: '/' }], storage: {} }));
    writeFileSync(join(dir, '.gitignore'), 'check-logs/\na11y-508-state.json\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'the session file stays out of git');
    const setConfig = (more) => writeFileSync(join(dir, 'a11y-508.config.json'), JSON.stringify({ args: quick, agent: fake, source: ['site'], push: false, maxAttempts: 3, ...config, ...more }, null, 2));
    return { dir, site, setConfig, ledgerFile: join(workDir(dir), 'ledger.json') };
  };
  {
    const { dir, site, setConfig, ledgerFile } = await ssoRepo('a11y-508-deploy-sso-', { deployed: 'bundle-change', deployTimeout: 120000, deployPoll: 400 });
    // Once the fixes are committed and the loop waits, a new build goes live.
    const watcher = setInterval(() => {
      try {
        if (loadLedger(ledgerFile).deploy) {
          site.build = 2;
          clearInterval(watcher);
        }
      } catch {}
    }, 200);
    const live = await loopIn(dir, [site.url, '--max-rounds', '1']);
    clearInterval(watcher);
    const l1 = loadLedger(ledgerFile);
    check('deploy check behind a sign-in: the build is read through the browser with the saved session, and a changed bundle is seen as live', () => {
      assert.match(live.out, /read the start page's build through the browser with the saved session/, live.out);
      assert.ok(l1.deploy && typeof l1.deploy.signature === 'string' && l1.deploy.signature.includes('/bundle.1.js'), JSON.stringify(l1.deploy));
      // Read in the page: the bundle's contents are hashed there too.
      assert.match(l1.deploy.signature, /\/bundle\.1\.js [0-9a-f]{64}/, l1.deploy.signature);
      assert.match(live.out, /new build is live/, live.out);
      assert.doesNotMatch(live.out, /could not reach the start page|opening a window to sign in/);
      assert.ok(Object.values(l1.findings).some((e) => e.status === 'pending'), live.out);
    });
    // Neither a plain request nor the browser can read the page for the check: --verify takes the person's word.
    site.blockPlain = true;
    site.blockBrowserDocs = 1;
    setConfig({ deployTimeout: 3000 });
    const verify = await loopIn(dir, [site.url, '--verify', '--events', '--max-rounds', '1']);
    const vEvents = parseEvents(verify.stdout);
    const l2 = loadLedger(ledgerFile);
    check('deploy check: --verify with a start page that cannot be checked takes the person\'s word and verifies', () => {
      assert.deepEqual(vEvents.problems, []);
      assert.equal(site.blockBrowserDocs, 0, 'the browser was tried');
      const dep = vEvents.events.find((e) => e.type === 'deployment');
      assert.deepEqual(dep && [dep.state, dep.reason], ['verify-anyway', 'unreachable'], verify.stdout);
      assert.ok(vEvents.events.some((e) => e.type === 'info' && e.message === 'could not read the start page to check its build; going by your word that the site is updated'), verify.stdout);
      assert.ok(!vEvents.events.some((e) => e.type === 'login-waiting'), verify.stdout);
      assert.ok(vEvents.events.some((e) => e.type === 'step' && e.step === 'crawl'), verify.stdout);
      assert.equal(l2.rounds.length, l1.rounds.length + 1, verify.out);
      assert.ok(Object.values(l2.findings).some((e) => e.status === 'verified'), verify.out);
    });
    site.srv.close();
    removeOwn(dir);
  }
  {
    const { dir, site, ledgerFile } = await ssoRepo('a11y-508-deploy-relogin-', { deployed: 'bundle-change', deployTimeout: 3000, deployPoll: 400 });
    const first = await loopIn(dir, [site.url, '--max-rounds', '1']);
    const l1 = loadLedger(ledgerFile);
    // The saved session expires, and a new build goes live.
    site.session = 'renewed';
    site.build = 2;
    const verify = await loopIn(dir, [site.url, '--verify', '--events', '--max-rounds', '1']);
    const vEvents = parseEvents(verify.stdout);
    const l2 = loadLedger(ledgerFile);
    check('deploy check: when the saved session has expired, --verify opens a window to sign in, saves the session, reads the build and verifies', () => {
      assert.equal(first.status, 4, first.out);
      assert.ok(l1.deploy && l1.deploy.signature.includes('/bundle.1.js'), JSON.stringify(l1.deploy));
      assert.deepEqual(vEvents.problems, []);
      assert.ok(vEvents.events.some((e) => e.type === 'info' && e.message === 'the start page sends the browser to its sign-in: opening a window to sign in'), verify.stdout);
      assert.ok(vEvents.events.some((e) => e.type === 'login-waiting'), verify.stdout);
      assert.ok(vEvents.events.some((e) => e.type === 'session-saved'), verify.stdout);
      assert.ok(readFileSync(join(dir, 'a11y-508-state.json'), 'utf8').includes('renewed'));
      const dep = vEvents.events.find((e) => e.type === 'deployment');
      assert.equal(dep && dep.state, 'arrived', verify.stdout);
      assert.ok(Object.values(l2.findings).some((e) => e.status === 'verified'), verify.out);
    });
    site.srv.close();
    removeOwn(dir);
  }
  {
    // The dashboard's own browser (--connect): the expired session's sign-in is a tab in that window,
    // not a window of its own, and the browser stays up after it.
    const { findChrome } = await import('../src/chrome.mjs');
    const { dir, site, ledgerFile } = await ssoRepo('a11y-508-deploy-relogin-tab-', { deployed: 'bundle-change', deployTimeout: 3000, deployPoll: 400 });
    await loopIn(dir, [site.url, '--max-rounds', '1']);
    site.session = 'renewed-in-tab';
    site.build = 2;
    const profile = mkdtempHome(join(tmpHome(), 'a11y-508-tab-profile-'));
    // Visible (the fake portal signs in only a visible Chrome), like the dashboard's window.
    const proc = spawn(findChrome(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 300 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    let port = '';
    for (let i = 0; i < 50 && !port; i++) {
      port = existsSync(portFile) ? (readFileSync(portFile, 'utf8').split('\n')[0] || '').trim() : '';
      if (!port) await new Promise((r) => setTimeout(r, 100));
    }
    // As the dashboard starts it: --sign-in-first too.
    const verify = await loopIn(dir, [site.url, '--verify', '--sign-in-first', '--events', '--max-rounds', '1', '--connect', port]);
    const vEvents = parseEvents(verify.stdout);
    const alive = await fetch(`http://127.0.0.1:${port}/json/version`).then((x) => x.ok, () => false);
    const l2 = loadLedger(ledgerFile);
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
    check('deploy check: with the dashboard\'s browser, the expired session\'s sign-in is a tab in that window, which stays up, and the crawl does not sign in again', () => {
      assert.ok(port, 'the test browser has a DevTools port');
      assert.ok(vEvents.events.some((e) => e.type === 'info' && e.message === "the start page sends the browser to its sign-in: opening a tab in the dashboard's window to sign in"), verify.stdout);
      assert.ok(vEvents.events.some((e) => e.type === 'session-saved'), verify.stdout);
      assert.ok(readFileSync(join(dir, 'a11y-508-state.json'), 'utf8').includes('renewed-in-tab'));
      assert.ok(alive, 'the dashboard\'s browser is still up');
      assert.equal(vEvents.events.filter((e) => e.type === 'login-waiting').length, 1, 'one sign-in, not a second one for the crawl');
      assert.ok(Object.values(l2.findings).some((e) => e.status === 'verified'), verify.out);
    });
    site.srv.close();
    removeOwn(dir);
  }
  {
    // No build from before the fixes on record (an older run could not read the page): --verify says
    // nothing about a check, verifies, and the round records this build so the next wait can compare.
    const { dir, site, ledgerFile } = await ssoRepo('a11y-508-deploy-nobase-', { deployed: 'bundle-change', deployTimeout: 3000, deployPoll: 400 });
    await loopIn(dir, [site.url, '--max-rounds', '1']);
    const l = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    l.deploy.signature = null;
    writeFileSync(ledgerFile, JSON.stringify(l));
    site.build = 2;
    const verify = await loopIn(dir, [site.url, '--verify', '--events', '--max-rounds', '1']);
    const vEvents = parseEvents(verify.stdout);
    const l2 = loadLedger(ledgerFile);
    check('deploy check: with no build from before the fixes on record, --verify says nothing about the check and verifies', () => {
      assert.deepEqual(vEvents.problems, []);
      const dep = vEvents.events.find((e) => e.type === 'deployment');
      assert.deepEqual(dep && [dep.state, dep.reason], ['verify-anyway', 'no-baseline'], verify.stdout);
      assert.ok(!vEvents.events.some((e) => (e.type === 'info' || e.type === 'warn') && /could not (check|read)|your word/i.test(e.message || '')), verify.stdout);
      assert.ok(vEvents.events.some((e) => e.type === 'step' && e.step === 'crawl'), verify.stdout);
      assert.ok(Object.values(l2.findings).some((e) => e.status === 'verified'), verify.out);
    });
    site.srv.close();
    removeOwn(dir);
  }
}
rmSync(HOME, { recursive: true, force: true, maxRetries: 10 });
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
