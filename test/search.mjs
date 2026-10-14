// Search-form discovery: a search screen whose results appear only for a date range. The crawler
// fills the date fields (a type="date" pair, and MM/DD/YYYY text fields) with the last three
// months, submits the forms that look like searches, audits the result pages it reaches, and never
// submits a form whose button deletes. The search-*.html fixtures add date presets in a custom
// dropdown, in button and radio groups, and Material-style datepicker text fields.
//
// `node test/search.mjs --only combo` runs one group (search, combo, combo12, widest, buttons,
// material, presets) with its crawl only: the narrowed run for a guard's mutation.

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
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1] : null;
const GROUPS = ['search', 'combo', 'combo12', 'widest', 'buttons', 'material', 'presets'];
if (only && !GROUPS.includes(only)) throw new Error(`--only takes one of ${GROUPS.join(', ')}`);
const want = (group) => !only || only === group;
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
const crawl = async (name, extra = [], start = 'search.html') => {
  const site = await startFixtureSite({ dropForms: 0 });
  const out = join(tmp, name);
  const r = await cli([site.base + start, '--max-pages', '12', '--no-interact', '--no-zoom', '--no-screenshots', '--fail-on', 'none', '--out', out, ...extra]);
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
if (want('search')) {
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
}

// The search-*.html fixtures: what each searched form was filled with, from report.json.
const formsOn = (report, page) => {
  const p = report && report.pages.find((x) => path(x.url) === page);
  return (p && p.search && p.search.forms) || [];
};
const audited = (report) => (report ? report.pages.filter((p) => p.foundBy === 'form' && !p.error).map((p) => path(p.url)) : []);
const notes = (report) => (report ? report.summary.coverage.notes : []);

if (want('combo')) {
  const c = await crawl('combo', ['--quiet', '--json', '--max-pages', '5'], 'search-combo.html');
  check('combo (a): the result pages behind a custom dropdown preset are audited', () => {
    assert.ok(c.report, c.stderr);
    for (const p of ['/result-21.html', '/result-22.html']) assert.ok(audited(c.report).includes(p), `${p} in ${audited(c.report)}`);
  });
  check('combo (b): the narrowest preset of at least 3 months is chosen, "Last 6 months"', () => {
    assert.deepEqual(formsOn(c.report, '/search-combo.html').map((f) => f.preset), ['Last 6 months']);
    assert.deepEqual([...new Set(c.searches.filter((s) => s.form === 'combo').map((s) => s.preset))], ['Last 6 months']);
  });
  check('combo (e): no dropdown is left open at submit, and the Status dropdown keeps "All"', () => {
    const subs = c.searches.filter((s) => s.form === 'combo');
    assert.ok(subs.length, JSON.stringify(c.searches));
    assert.deepEqual(subs.map((s) => [s.open, s.status]), subs.map(() => [false, 'All']));
  });
  check('combo: the coverage notes say which preset the form used', () => {
    assert.ok(notes(c.report).includes("Search form on /search-combo.html: chose 'Last 6 months'."), JSON.stringify(notes(c.report)));
  });
}
if (want('combo12')) {
  const c = await crawl('combo12', ['--quiet', '--json', '--max-pages', '1', '--search-months', '12'], 'search-combo.html');
  check('combo, --search-months 12: "Last year" is chosen', () => {
    assert.ok(c.report, c.stderr);
    assert.deepEqual(formsOn(c.report, '/search-combo.html').map((f) => f.preset), ['Last year']);
  });
}
if (want('widest')) {
  const w = await crawl('widest', ['--quiet', '--json', '--max-pages', '3'], 'search-widest.html');
  check('widest (c): no preset reaches 3 months, so the widest, "Last 30 days", is chosen and its results audited', () => {
    assert.ok(w.report, w.stderr);
    assert.deepEqual(formsOn(w.report, '/search-widest.html').map((f) => [f.preset, f.presetDays, f.short]), [['Last 30 days', 30, true]]);
    assert.ok(audited(w.report).includes('/result-31.html'), audited(w.report).join());
  });
  check('widest (c): a coverage note says the widest preset was 30 days', () => {
    assert.ok(notes(w.report).some((n) => n.startsWith("Search form on /search-widest.html: chose 'Last 30 days', the widest preset (30 days), shorter than --search-months 3")), JSON.stringify(notes(w.report)));
  });
}
if (want('buttons')) {
  const b = await crawl('buttons', ['--quiet', '--json', '--max-pages', '4'], 'search-buttons.html');
  check('buttons: a button-group preset ("Last 90 days") and a role="radio" preset ("3 months") are chosen, and their results audited', () => {
    assert.ok(b.report, b.stderr);
    assert.deepEqual(formsOn(b.report, '/search-buttons.html').map((f) => f.preset).sort(), ['3 months', 'Last 90 days']);
    for (const p of ['/result-41.html', '/result-42.html']) assert.ok(audited(b.report).includes(p), `${p} in ${audited(b.report)}`);
  });
}
if (want('material')) {
  const m = await crawl('material', ['--quiet', '--json', '--max-pages', '4'], 'search-material.html');
  check('material (d): datepicker text fields (placeholder MM/DD/YYYY, or a calendar toggle) are filled in MM/DD/YYYY and their results audited', () => {
    assert.ok(m.report, m.stderr);
    for (const form of ['mat-placeholder', 'mat-toggle']) {
      const s = m.searches.find((x) => x.form === form);
      assert.ok(s && s.ok, `${form}: ${JSON.stringify(m.searches)}`);
      const back = daysFrom(s.from);
      assert.ok(back >= 88 && back <= 93 && Math.abs(daysFrom(s.to)) <= 1, `${form}: ${s.from} to ${s.to}`);
    }
    for (const p of ['/result-51.html', '/result-52.html']) assert.ok(audited(m.report).includes(p), `${p} in ${audited(m.report)}`);
  });
  check('material: the coverage notes say which dates each form was filled with', () => {
    const filled = notes(m.report).filter((n) => /^Search form on \/search-material\.html: filled \d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}\.$/.test(n));
    assert.equal(filled.length, 2, JSON.stringify(notes(m.report)));
  });
}
if (want('presets')) {
  // The preset reader itself, loaded from the in-page bundle file with a stand-in window.
  const w = { __a11y508: {} };
  new Function('window', readFileSync(join(root, 'src/checks/browser/92-search.js'), 'utf8'))(w);
  const pm = w.__a11y508.presetMonths;
  const now = new Date();
  const ytd = Math.max(1, Math.round((now - new Date(now.getFullYear(), 0, 1)) / 86400000)) / 30;
  check('presetMonths reads "N months", "90 days", "YTD", "this year", "all" and the "Last N" forms', () => {
    const got = Object.fromEntries(['Last 90 days', '90 days', '3 months', 'Last 6 months', 'Past year', 'Last quarter', 'Previous 2 weeks', '30 days overdue', 'YTD', 'Year to date', 'This year', 'All', 'All time', 'Open', 'Closed'].map((t) => [t, Math.round(pm(t) * 100) / 100]));
    const r = (x) => Math.round(x * 100) / 100;
    assert.deepEqual(got, { 'Last 90 days': 3, '90 days': 3, '3 months': 3, 'Last 6 months': 6, 'Past year': r(365 / 30), 'Last quarter': 3, 'Previous 2 weeks': r(14 / 30), '30 days overdue': 0, YTD: r(ytd), 'Year to date': r(ytd), 'This year': r(ytd), All: 1216.67, 'All time': 1216.67, Open: 0, Closed: 0 });
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
