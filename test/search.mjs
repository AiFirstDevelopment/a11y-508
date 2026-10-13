// Search-form discovery: a search screen whose results appear only for a date range. The crawler
// fills the date fields (a type="date" pair, and MM/DD/YYYY text fields) with the last three
// months, submits the forms that look like searches, audits the result pages it reaches, and never
// submits a form whose button deletes.

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { startFixtureSite, TOKEN } from './fixture-site.mjs';
import { parseEvents } from './event-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'a11y-508-search-')));
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
const cli = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'bin/a11y-508.mjs'), ...args], { env: { ...process.env, TOKEN, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
  child.on('exit', (status) => {
    clearTimeout(timer);
    resolve({ status, stdout, stderr });
  });
});
const crawl = async (name, extra = []) => {
  const site = await startFixtureSite({ dropForms: 0 });
  const out = join(tmp, name);
  const r = await cli([site.base + 'search.html', '--max-pages', '12', '--no-interact', '--no-zoom', '--no-screenshots', '--fail-on', 'none', '--out', out, ...extra]);
  site.close();
  const report = existsSync(join(out, 'report.json')) ? JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) : null;
  return { ...r, report, searches: site.searches, deleteHits: site.deleteHits };
};
const path = (u) => new URL(u).pathname;
const daysFrom = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) || null;
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : (([mm, dd, yy]) => new Date(+yy, +mm - 1, +dd))(s.split('/'));
  return Math.round((Date.now() - d.getTime()) / 86400000);
};

console.log('search forms:');
const main = await crawl('main', ['--events', '--quiet']);
const r = main.report;
const { events, problems } = parseEvents(main.stdout);
check('the crawl ran and its events fit the contract', () => {
  assert.ok(r, main.stderr);
  assert.deepEqual(problems, []);
});
check('the result pages are audited, found by the search (foundBy "form")', () => {
  const byForm = r.pages.filter((p) => p.foundBy === 'form').map((p) => path(p.url)).sort();
  for (const p of ['/result-1.html', '/result-2.html', '/result-3.html', '/result-5.html', '/result-6.html', '/search-results.html']) assert.ok(byForm.includes(p), `${p} in ${byForm}`);
  for (const p of r.pages.filter((x) => /result-\d/.test(x.url))) {
    assert.equal(p.error, null);
    assert.ok(p.findings.some((f) => f.test === '7.A'), `planted 7.A on ${p.url}`);
  }
});
check('both forms were filled with the last 3 months, in the format each expects', () => {
  const date = main.searches.find((s) => s.form === 'date');
  const text = main.searches.find((s) => s.form === 'text');
  assert.ok(date && text, JSON.stringify(main.searches));
  assert.match(date.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(text.from, /^\d{2}\/\d{2}\/\d{4}$/);
  for (const s of [date, text]) {
    const back = daysFrom(s.from);
    assert.ok(back >= 88 && back <= 93, `${s.form}: from ${s.from} is ${back} days back`);
    assert.ok(Math.abs(daysFrom(s.to)) <= 1, `${s.form}: to ${s.to} is today`);
  }
});
check('the form whose button deletes was never submitted', () => assert.deepEqual(main.deleteHits, []));
check('report: discovery.forms on the search page, and the result area re-checked "after searching the last 3 months"', () => {
  const page = r.pages.find((p) => path(p.url) === '/search.html');
  assert.deepEqual(page.discovery.forms, { filled: 2, submitted: 2, results: 6 });
  const revealed = page.findings.filter((f) => f.state === 'after searching the last 3 months');
  assert.ok(revealed.some((f) => f.test === '7.A' && /result-icon/.test(f.html)), JSON.stringify(revealed.map((f) => [f.test, f.html])));
  // The page's own audit is its state before the search: no result-area finding without the label.
  assert.ok(!page.findings.some((f) => /result-icon/.test(f.html) && f.state !== 'after searching the last 3 months'));
  assert.ok(page.search.skipped.some((s) => /Delete filtered records/.test(s.name)), JSON.stringify(page.search.skipped));
});
check('events: a "search" progress phase, and the page event counts searches and results', () => {
  const p = events.find((e) => e.type === 'progress' && e.phase === 'search');
  assert.deepEqual(p && p.detail, { months: 3, forms: 2 });
  const pe = events.find((e) => e.type === 'page' && path(e.url) === '/search.html');
  assert.deepEqual([pe.searched, pe.searchResults], [2, 6]);
});

const narrow = await crawl('narrow', ['--search-months', '1', '--quiet', '--json']);
check('--search-months 1: the searches return nothing, and a coverage note says so', () => {
  assert.ok(narrow.searches.every((s) => !s.ok && daysFrom(s.from) <= 31), JSON.stringify(narrow.searches));
  assert.ok(!narrow.report.pages.some((p) => /result-\d/.test(p.url)));
  assert.ok(narrow.report.summary.coverage.notes.some((n) => /returned nothing even for the last 1 month/.test(n)), JSON.stringify(narrow.report.summary.coverage.notes));
});
const off = await crawl('off', ['--no-forms', '--quiet', '--json']);
check('--no-forms: nothing is submitted, no result page is audited, and a note says discovery was off', () => {
  assert.deepEqual(off.searches, []);
  assert.ok(!off.report.pages.some((p) => p.foundBy === 'form'));
  assert.ok(off.report.summary.coverage.notes.some((n) => /--no-forms/.test(n)));
  assert.deepEqual(off.deleteHits, []);
});

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
