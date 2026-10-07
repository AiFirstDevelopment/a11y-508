// End-to-end test of the fix loop: a throwaway git repository holding a copy
// of the fixture site, a server that serves it (so "deploy" is instant), and a
// fake agent that fixes two findings, declines the rest, and breaks the build
// on one so the gate has to revert it.

import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { applyReport, loadLedger } from '../src/ledger.mjs';
import { agentEnv, fixPrompt, triagePrompt } from '../src/agent.mjs';
import { normalizeConfig } from '../src/loop.mjs';
import { splitLoopArgs } from '../src/cli.mjs';

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
  check('ledger: gives up after maxAttempts fixes that did not hold', () => assert.equal(e.status, 'needs-human'));
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
  const t = triagePrompt({ items: [{ id: 'r1-0', test: '6.A', name: 'n', wcag: 'w', condition: 'c', message: 'm', selector: 'a', html: '<a>', pages: ['/a'] }], resultFile: '/t.json' });
  assert.ok(t.includes('r1-0') && t.includes('/t.json'));
});
check('config validation catches the common mistakes', () => {
  assert.ok(normalizeConfig({}).errors.some((e) => /no start URL/.test(e)));
  assert.ok(normalizeConfig({ url: 'http://x' }).errors.some((e) => /no agent/.test(e)));
  assert.ok(normalizeConfig({ url: 'http://x', agent: 'claude', deployed: 'command' }).errors.some((e) => /no "deploy"/.test(e)));
  const { cfg, errors } = normalizeConfig({ url: 'http://x', agent: 'gemini', deploy: 'npm run deploy' });
  assert.deepEqual(errors, []);
  assert.equal(cfg.deployed, 'command');
});
check('loop flags are split from crawl options', () => {
  const s = splitLoopArgs(['loop', 'http://x', '--max-rounds', '3', '--max-pages', '10', '--agent=gemini', '--dry-run']);
  assert.equal(s.loop.maxRounds, 3);
  assert.equal(s.loop.agent, 'gemini');
  assert.equal(s.loop.dryRun, true);
  assert.deepEqual(s.remaining, ['http://x', '--max-pages', '10']);
  assert.equal(splitLoopArgs(['http://x']), null);
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
writeFileSync(join(repo, '.gitignore'), 'a11y-508-work/\na11y-508-report/\n');
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

const ledger = loadLedger(join(repo, 'a11y-508-work', 'ledger.json'));
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
  assert.ok(sensory && sensory.triage.decision === 'inadequate' && ['open', 'needs-human'].includes(sensory.status), JSON.stringify(sensory));
});
check('the token never reached the agent', () => {
  const results = entries.flatMap((e) => e.attempts);
  assert.ok(results.length > 0);
  const resultFiles = readFileSync(join(repo, 'a11y-508-work', 'result-r1-fix-0.json'), 'utf8');
  assert.ok(!/"leaked": true/.test(resultFiles), resultFiles);
});
check('status prints the ledger', () => {
  const r = spawnSync(process.execPath, [join(root, 'bin/a11y-508.mjs'), 'status'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(/2 round\(s\)/.test(r.stdout) && /verified fixed/.test(r.stdout), r.stdout);
});

rmSync(repo, { recursive: true, force: true });
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
