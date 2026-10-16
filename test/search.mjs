// Search-form discovery: a search screen whose results appear only for a date range. The crawler
// fills the date fields (a type="date" pair, and MM/DD/YYYY text fields) with the last three
// months, submits the forms that look like searches, audits the result pages it reaches, and never
// submits a form whose button deletes. The search-*.html fixtures add date presets in a custom
// dropdown, in button and radio groups, and Material-style datepicker text fields.
//
// The search-quick and search-reset fixtures: the date range is set on every load and set again
// before any pass presses a search control, so no search runs with the app's default range.
//
// `node test/search.mjs --only combo` runs one group (search, combo, combo12, widest, buttons,
// material, presets, quick, quickload, quickoff, reset) with its crawl only: the narrowed run for a
// guard's mutation.

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
const GROUPS = ['search', 'combo', 'combo12', 'widest', 'buttons', 'material', 'presets', 'quick', 'quickload', 'quickoff', 'reset', 'slow', 'reveal', 'disabled', 'nameless'];
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
    const at = /search\.mjs:(\d+)/.exec(e.stack || '');
    console.log(`  FAIL ${name}${at ? ` (test/search.mjs:${at[1]})` : ''}\n       ${e.message.split('\n').join('\n       ')}`);
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
const crawl = async (name, extra = [], start = 'search.html', { interact = false } = {}) => {
  const site = await startFixtureSite({ dropForms: 0 });
  const out = join(tmp, name);
  const r = await cli([site.base + start, '--max-pages', '12', ...(interact ? [] : ['--no-interact']), '--no-zoom', '--no-screenshots', '--fail-on', 'none', '--out', out, ...extra]);
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
    assert.ok(notes(c.report).some((n) => n.startsWith("Search form on /search-combo.html: chose 'Last 6 months'.")), JSON.stringify(notes(c.report)));
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
    const filled = notes(m.report).filter((n) => /^Search form on \/search-material\.html: filled \d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}\.( Pressed .*)?$/.test(n));
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

// The date range on every load (docs/plans/date-range-always.md).
const QUICK_NOTE = 'Search form on /search-quick.html: date range set to the last 3 months (Last 6 months preset) before every search';
const rangeNotes = (report, page) => notes(report).filter((n) => n.startsWith(`Search form on ${page}: date range set`));
const pageOf = (report, p) => report && report.pages.find((x) => path(x.url) === p);
const revealedBy = (report, p, cls, name) => {
  const pg = pageOf(report, p);
  return pg ? pg.findings.filter((f) => f.test === '7.A' && f.html.includes(cls) && String(f.state || '').startsWith(`after activating "${name}"`)) : [];
};
if (want('quick')) {
  const q = await crawl('quick', ['--quiet', '--json', '--max-pages', '4'], 'search-quick.html', { interact: true });
  const by = (form) => q.searches.filter((s) => s.form === form);
  check('quick (a): click discovery\'s search runs with "Last 6 months", not the default "Last 24 hours", and its results are audited', () => {
    assert.ok(q.report, q.stderr);
    assert.ok(by('quick-click').length, JSON.stringify(q.searches));
    assert.deepEqual([...new Set(by('quick-click').map((s) => s.preset))], ['Last 6 months']);
    const audit = q.report.pages.filter((p) => !p.error).map((p) => path(p.url));
    for (const p of ['/search-quick-results.html', '/result-61.html']) assert.ok(audit.includes(p), `${p} in ${audit}`);
    assert.ok(pageOf(q.report, '/result-61.html').findings.some((f) => f.test === '7.A'), 'planted 7.A on /result-61.html');
  });
  check('quick (c): the disclosure pass\'s search ("Show results") runs with "Last 6 months", and its results are re-checked', () => {
    assert.ok(by('quick-kb').length, JSON.stringify(q.searches));
    assert.deepEqual([...new Set(by('quick-kb').map((s) => s.preset))], ['Last 6 months']);
    assert.ok(revealedBy(q.report, '/search-quick.html', 'quick-kb-icon', 'Show results').length, JSON.stringify(pageOf(q.report, '/search-quick.html').findings.map((f) => [f.test, f.state])));
  });
  check('quick (d): the coverage notes say once for the form that its range was set before every search', () => {
    assert.deepEqual(rangeNotes(q.report, '/search-quick.html'), [QUICK_NOTE], JSON.stringify(notes(q.report)));
  });
  check('quick: the search pass submits the form by its Search button (the Clear button beside it is no reason to leave it alone) and says what it chose', () => {
    const pg = pageOf(q.report, '/search-quick.html');
    assert.ok(pg.search && !pg.search.skipped.length, JSON.stringify(pg.search));
    assert.deepEqual(pg.search.forms.map((f) => [f.name, f.preset, f.navigated]), [['Search', 'Last 6 months', true]], JSON.stringify(pg.search.forms));
    assert.ok(notes(q.report).some((n) => n.startsWith("Search form on /search-quick.html: chose 'Last 6 months'.")), JSON.stringify(notes(q.report)));
  });
}
if (want('quickload')) {
  const q = await crawl('quickload', ['--quiet', '--json', '--max-pages', '1', '--no-follow-clicks'], 'search-quick.html');
  check('quickload: setting the range on load submits nothing by itself (the one search is the search pass\'s own, with the range already set), and the note is still written once', () => {
    assert.ok(q.report, q.stderr);
    assert.deepEqual(q.searches.map((s) => [s.form, s.preset]), [['quick-click', 'Last 6 months']], JSON.stringify(q.searches));
    assert.deepEqual(rangeNotes(q.report, '/search-quick.html'), [QUICK_NOTE], JSON.stringify(notes(q.report)));
    assert.deepEqual(pageOf(q.report, '/search-quick.html').ranges.forms.map((f) => [f.selector, f.preset]), [['#quick-filters', 'Last 6 months']]);
  });
}
if (want('quickoff')) {
  const q = await crawl('quickoff', ['--quiet', '--json', '--max-pages', '3', '--no-forms'], 'search-quick.html', { interact: true });
  check('quickoff (e): --no-forms leaves the range alone: every search runs with "Last 24 hours", and no note', () => {
    assert.ok(q.report, q.stderr);
    const subs = q.searches.filter((s) => s.form === 'quick-click' || s.form === 'quick-kb');
    assert.ok(subs.some((s) => s.form === 'quick-click'), JSON.stringify(q.searches));
    assert.deepEqual([...new Set(subs.map((s) => s.preset))], ['Last 24 hours']);
    assert.deepEqual(rangeNotes(q.report, '/search-quick.html'), []);
    assert.ok(!pageOf(q.report, '/search-quick.html').ranges);
  });
}
if (want('reset')) {
  const r = await crawl('reset', ['--quiet', '--json', '--max-pages', '1', '--no-follow-clicks'], 'search-reset.html', { interact: true });
  check('reset (b): fields that reset to today on focus are set again before the disclosure pass searches; every search spans three months', () => {
    assert.ok(r.report, r.stderr);
    const subs = r.searches.filter((s) => s.form === 'reset');
    assert.ok(subs.length >= 2, JSON.stringify(r.searches));
    for (const s of subs) {
      const back = daysFrom(s.from);
      assert.ok(s.ok && back >= 88 && back <= 93 && Math.abs(daysFrom(s.to)) <= 1, `a search ran with ${s.from} to ${s.to}`);
    }
    assert.ok(revealedBy(r.report, '/search-reset.html', 'reset-icon', 'Search').length, JSON.stringify(pageOf(r.report, '/search-reset.html').findings.map((f) => [f.test, f.state])));
    assert.ok(pageOf(r.report, '/search-reset.html').ranges.reapplied >= 1, JSON.stringify([r.searches, pageOf(r.report, '/search-reset.html').ranges, pageOf(r.report, '/search-reset.html').passes]));
  });
  check('reset: the note gives the dates the range was set to', () => {
    assert.equal(rangeNotes(r.report, '/search-reset.html').length, 1, JSON.stringify(notes(r.report)));
    assert.match(rangeNotes(r.report, '/search-reset.html')[0], /^Search form on \/search-reset\.html: date range set to the last 3 months \(dates \d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}\) before every search$/);
  });
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;

// A slow API: the results arrive two seconds after a progress bar; the crawler waits for them.
if (want('slow')) {
  const sl = await crawl('slow', ['--quiet', '--json', '--max-pages', '3'], 'search-slow.html');
  check('slow: Search is pressed (never Clear or Export), the crawler waits for the rows behind the progress bar, and the result page is audited', () => {
    assert.ok(sl.report, sl.stderr);
    const pg = pageOf(sl.report, '/search-slow.html');
    assert.deepEqual(pg.search.skipped, []);
    assert.deepEqual(pg.discovery.forms, { filled: 1, submitted: 1, results: 1 }, JSON.stringify(pg.search));
    const res = pageOf(sl.report, '/result-64.html');
    assert.ok(res && !res.error && res.foundBy === 'form', JSON.stringify(sl.report.pages.map((p) => [path(p.url), p.foundBy, p.error])));
    assert.ok(pg.findings.some((f) => f.test === '7.A' && /slow-icon/.test(f.html) && f.state === 'after searching the last 3 months'), JSON.stringify(pg.findings.map((f) => [f.test, f.state])));
  });
}

// Links a click or a disclosure brings into the page (a menu rendered on demand) are pages found.
if (want('reveal')) {
  const rv = await crawl('reveal', ['--quiet', '--json', '--max-pages', '6'], 'menu-reveal.html', { interact: true });
  check('reveal: the pages behind a menu rendered on click and a disclosure are found by clicking, audited, and counted', () => {
    assert.ok(rv.report, rv.stderr);
    const audited = rv.report.pages.filter((p) => !p.error && !p.skipped);
    for (const n of [1, 2, 3]) {
      const pg = audited.find((p) => path(p.url) === `/menu-page-${n}.html`);
      assert.ok(pg, `/menu-page-${n}.html in ${audited.map((p) => path(p.url))}`);
      assert.equal(pg.foundBy, 'click', JSON.stringify([pg.url, pg.foundBy]));
      assert.ok(pg.findings.some((f) => f.test === '7.A'), `planted 7.A on ${pg.url}`);
    }
    const start = pageOf(rv.report, '/menu-reveal.html');
    assert.equal(start.discovery.revealed, 3, JSON.stringify(start.discovery));
    assert.ok(notes(rv.report).some((n) => /^3 link\(s\) appeared only after a control was clicked or opened/.test(n)), JSON.stringify(notes(rv.report)));
  });
}

// A Search button disabled until the form is valid: pressed once the fill has enabled it.
if (want('disabled')) {
  const d = await crawl('disabled', ['--quiet', '--json', '--max-pages', '3'], 'search-disabled.html');
  check('disabled: the Search button, disabled until the dates are filled, is pressed once the fill enables it, and the result page is audited', () => {
    assert.ok(d.report, d.stderr);
    const pg = pageOf(d.report, '/search-disabled.html');
    assert.deepEqual(pg.search.skipped, [], JSON.stringify(pg.search));
    assert.deepEqual(pg.discovery.forms, { filled: 1, submitted: 1, results: 1 }, JSON.stringify(pg.search));
    assert.equal(pg.search.forms[0].pressed, 'Search', JSON.stringify(pg.search.forms));
    const res = pageOf(d.report, '/result-65.html');
    assert.ok(res && !res.error && res.foundBy === 'form', JSON.stringify(d.report.pages.map((p) => [path(p.url), p.foundBy, p.error])));
    assert.ok(notes(d.report).some((n) => /^Search form on \/search-disabled\.html: filled \d{2}\/\d{2}\/\d{4} to \d{2}\/\d{2}\/\d{4}\. Pressed "Search": 1 result\.$/.test(n)), JSON.stringify(notes(d.report)));
  });
}
// A search button with no accessible name: the form cannot be searched, and the notes say which buttons it has.
if (want('nameless')) {
  const nl = await crawl('nameless', ['--quiet', '--json', '--max-pages', '2'], 'search-nameless.html');
  check('nameless: a search-like form whose button has no name is reported with the buttons it has', () => {
    assert.ok(nl.report, nl.stderr);
    const pg = pageOf(nl.report, '/search-nameless.html');
    assert.deepEqual(pg.search.skipped.map((s) => s.reason), ['no control named like a search'], JSON.stringify(pg.search));
    assert.ok(notes(nl.report).includes('Search-like form on /search-nameless.html was not searched: no control named like a search (buttons: (no name), Export). Name its search button, or the crawler cannot find the pages behind it.'), JSON.stringify(notes(nl.report)));
  });
}
