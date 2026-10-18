// The tool lists the findings from the parse (docs/plans/read-from-parse.md): the candidate builder,
// the folding of the assistant's answers (merges, extras, pages that name no problem, pages it did
// not describe), the counts sentence, and the Gemini model for the manual flow's calls, as pure
// functions. Run: node test/manual-read.mjs  (or one test: node test/manual-read.mjs -g "<name>")

import assert from 'node:assert/strict';
import { agentEnvFor, MANUAL_GEMINI_MODEL, streamModel, agentLog } from '../src/agent.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAND_IN, buildCandidates, countsSentence, decisionsMarkdown, removedSection, removedWords, describedEnough, foldAnswers, onRouteList, readSentence, routeOnly, seenLine, seenLines, uncheckedLine, unseenPages } from '../src/manual.mjs';
import { notFoundView, pageDespite404 } from '../src/evidence.mjs';

const only = process.argv.includes('-g') ? process.argv[process.argv.indexOf('-g') + 1] : null;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const criterion = (id, name = 'name', wcag = '1.1.1') => ({ id, name, wcag, source: 'catalog' });
const status = (value, date = '2026-09-28', words = value === 'fixed' ? 'Verified fixed – 9/28/2026' : 'Still an issue – 9/28/26') => ({ value, words, date, source: 'text' });
const page = (n, { lines = [], criteria = [], st = null, divider = false, picture = `pages/page-${String(n).padStart(2, '0')}.png`, images = [] } = {}) => ({ n, lines, criteria, status: st, divider, picture, images: images.map((file) => ({ file })) });
// decide(), recording.
const log = () => {
  const all = [];
  const decide = (stage, finding, by, decision, reason = '') => all.push({ stage, finding, by, decision, reason });
  return { all, decide };
};
const answer = (id, more = {}) => ({ id, seen: `Page of ${id}.`, element: `the element of ${id}`, title: `Title ${id}`, route: '/', selectors: [`#${id.toLowerCase()}`], expected: 'x', ...more });

test('AC1: one candidate per page that names a criterion, in page order, with the page facts filled in exactly', () => {
  const m = { pageCount: 5, pages: [
    page(1, { lines: ['Resolved Issues'], divider: true, picture: null }),
    page(2, { lines: ['Intro words', '5.C The combination of the accessible name', 'determinable - 1.3.1', 'Verified fixed – 9/28/2026'], criteria: [criterion('5.C', '1.3.1-programmatic-label', '1.3.1 / 4.1.2'), criterion('13.A')], st: status('fixed'), images: ['pages/page-02-image-1.png'] }),
    page(3, { lines: ['Just a picture page'] }),
    page(4, { lines: ['13.A Color is not used', 'Still an issue – 9/28/26'], criteria: [criterion('13.A', '1.4.1-color-meaning', '1.4.1')], st: status('open') }),
    page(5, { lines: [], picture: 'pages/page-05.png' }),
  ] };
  const c = buildCandidates(m);
  assert.deepEqual(c.map((x) => [x.id, x.pages, x.page, x.status, x.statusDate, x.criterion, x.criterionName, x.wcag, x.quote, x.picture, x.images]), [
    ['F1', [2], 2, 'fixed', '2026-09-28', '5.C', '1.3.1-programmatic-label', '1.3.1 / 4.1.2', '5.C The combination of the accessible name', 'pages/page-02.png', ['pages/page-02-image-1.png']],
    ['F2', [4], 4, 'open', '2026-09-28', '13.A', '1.4.1-color-meaning', '1.4.1', '13.A Color is not used', 'pages/page-04.png', []],
  ]);
  // Deterministic: the same parse, the same list.
  assert.deepEqual(buildCandidates(m), c);
});

test('AC1: no page names a criterion: one candidate per page that is not a divider and has text or a picture; the quote is its first line', () => {
  const m = { pageCount: 4, pages: [
    page(1, { lines: ['Cover'], divider: true, picture: null }),
    page(2, { lines: ['The button has no name.', 'more'] }),
    page(3, { lines: [], picture: null }),
    page(4, { lines: [], picture: 'pages/page-04.png' }),
  ] };
  assert.deepEqual(buildCandidates(m).map((x) => [x.id, x.page, x.criterion, x.quote, x.status]), [['F1', 2, null, 'The button has no name.', null], ['F2', 4, null, '', null]]);
  assert.deepEqual(buildCandidates({ pages: [] }), []);
});

const four = () => buildCandidates({ pageCount: 5, pages: [
  page(1, { lines: ['5.C a'], criteria: [criterion('5.C')], st: status('fixed') }),
  page(2, { lines: ['5.C a'], criteria: [criterion('5.C')], st: status('fixed') }),
  page(3, { lines: ['13.C b'], criteria: [criterion('13.C')], st: status('fixed') }),
  page(4, { lines: ['5.C a'], criteria: [criterion('5.C')], st: status('open') }),
  page(5, { lines: ['5.C a'], criteria: [criterion('5.C')], st: status('fixed') }),
] });

test('AC2: a candidate the assistant did not describe is kept, undescribed, with the decision; nothing is lost', () => {
  const { all, decide } = log();
  const c = four();
  const f = foldAnswers(c, new Map([['F1', answer('F1')], ['F3', answer('F3')]]), decide);
  assert.deepEqual(f.map((x) => x.id), ['F1', 'F2', 'F3', 'F4', 'F5']);
  const f2 = f.find((x) => x.id === 'F2');
  assert.deepEqual([f2.seen, f2.element, f2.selectors, f2.status, f2.criterion, f2.page], [null, 'not described by the assistant', [], 'fixed', '5.C', 2]);
  assert.deepEqual(all.filter((d) => d.decision === 'kept without a description').map((d) => [d.stage, d.finding, d.by]), [['read', 'F2', 'tool'], ['read', 'F4', 'tool'], ['read', 'F5', 'tool']]);
  assert.equal(seenLine(f2), 'The assistant did not describe this page.');
  assert.equal(seenLine(f[0]), 'What the assistant saw on page 1: Page of F1.');
});

test('AC2: an answer counts only with seen and element; "none" only for a page that names no criterion', () => {
  const [withCriterion] = four();
  const plain = { id: 'F1', criterion: null };
  assert.equal(describedEnough({ seen: 'x', element: 'y' }, withCriterion), true);
  assert.equal(describedEnough({ seen: 'x' }, withCriterion), false);
  assert.equal(describedEnough({ element: 'y' }, withCriterion), false);
  assert.equal(describedEnough({ none: true, seen: 'a cover' }, withCriterion), false);
  assert.equal(describedEnough({ none: true, seen: 'a cover' }, plain), true);
});

test('AC3: sameAs merges pages with the same criterion and status; pages in order, the first page\'s facts', () => {
  const { all, decide } = log();
  const f = foldAnswers(four(), new Map([['F1', answer('F1')], ['F2', answer('F1', { id: 'F2', sameAs: 'F1' })], ['F3', answer('F3')], ['F4', answer('F4')], ['F5', answer('F1', { id: 'F5', sameAs: 'F2' })]]), decide);
  assert.deepEqual(f.map((x) => [x.id, x.pages, x.page, x.status]), [['F1', [1, 2, 5], 1, 'fixed'], ['F3', [3], 3, 'fixed'], ['F4', [4], 4, 'open']]);
  assert.deepEqual(f[0].merged, ['F2', 'F5']);
  // What it saw on the merged pages stays, a line per page.
  assert.deepEqual(seenLines(f[0]), ['What the assistant saw on page 1: Page of F1.', 'What the assistant saw on page 2: Page of F1.', 'What the assistant saw on page 5: Page of F1.']);
  assert.equal(all.filter((d) => /^merged /.test(d.decision)).length, 2);
});

test('AC3: the assistant\'s decisions for a merged page are logged under the finding it was merged into', () => {
  const { all, decide } = log();
  foldAnswers(four(), new Map([['F1', answer('F1')], ['F2', answer('F1', { id: 'F2', sameAs: 'F1', decisions: [{ decision: 'took the home page', reason: 'r' }] })]]), decide);
  assert.deepEqual(all.filter((d) => d.decision === 'took the home page').map((d) => [d.finding, d.by]), [['F1', 'agent']]);
});

test('guard d: sameAs across different criteria is ignored, with the decision', () => {
  const { all, decide } = log();
  const f = foldAnswers(four(), new Map(['F1', 'F2', 'F3', 'F4', 'F5'].map((id) => [id, answer(id, id === 'F3' ? { sameAs: 'F1', element: 'the element of F1', selectors: ['#f1'] } : {})])), decide);
  assert.deepEqual(f.map((x) => x.id), ['F1', 'F2', 'F3', 'F4', 'F5']);
  assert.deepEqual(all.filter((d) => /^kept /.test(d.decision)).map((d) => [d.finding, d.by, d.decision, d.reason]), [['F3', 'tool', 'kept F3 separate from F1', 'they are different criteria']]);
});

test('guard j: statuses disagree across a merge: F4 (open) sameAs F1 (fixed) stays two findings, logged', () => {
  const { all, decide } = log();
  const f = foldAnswers(four(), new Map(['F1', 'F2', 'F3', 'F4', 'F5'].map((id) => [id, answer(id, id === 'F4' ? { sameAs: 'F1', element: 'the element of F1', selectors: ['#f1'] } : {})])), decide);
  assert.deepEqual(f.map((x) => [x.id, x.status]), [['F1', 'fixed'], ['F2', 'fixed'], ['F3', 'fixed'], ['F4', 'open'], ['F5', 'fixed']]);
  assert.deepEqual(all.filter((d) => /^kept /.test(d.decision)).map((d) => [d.decision, d.reason]), [['kept F4 separate from F1', "the tester's statuses differ: fixed on page 1, open on page 4"]]);
});

test('AC3: a merge of two pages described differently, or of an id that is not earlier, is ignored', () => {
  const { all, decide } = log();
  const f = foldAnswers(four(), new Map([['F1', answer('F1')], ['F2', answer('F2', { sameAs: 'F1' })], ['F3', answer('F3')], ['F4', answer('F4')], ['F5', answer('F5', { sameAs: 'F9' })]]), decide);
  assert.equal(f.length, 5);
  assert.deepEqual(all.filter((d) => /^kept /.test(d.decision)).map((d) => d.reason), ['the assistant merged two pages whose pictures it described differently', 'F9 is not an earlier finding']);
});

test('AC3: extra makes <id>b with the page\'s facts and the assistant\'s fields; "none" drops a page with no criterion only', () => {
  const { all, decide } = log();
  const c = four();
  const f = foldAnswers(c, new Map([['F1', answer('F1', { extra: { title: 'Second', element: 'another element', selectors: ['#two'], route: '/x', seen: 'And a second.' } })], ['F2', answer('F2', { none: true })], ['F3', answer('F3')], ['F4', answer('F4')], ['F5', answer('F5')]]), decide);
  assert.deepEqual(f.map((x) => x.id), ['F1', 'F1b', 'F2', 'F3', 'F4', 'F5']);
  const b = f[1];
  assert.deepEqual([b.page, b.pages, b.status, b.criterion, b.quote, b.element, b.selectors, b.route, b.seen, b.extraOf], [1, [1], 'fixed', '5.C', '5.C a', 'another element', ['#two'], '/x', 'And a second.', 'F1']);
  // On a page with no criterion, "none" leaves the page out.
  const plain = buildCandidates({ pages: [page(1, { lines: ['Cover page'] }), page(2, { lines: ['The button has no name.'] })] });
  const g = foldAnswers(plain, new Map([['F1', { id: 'F1', none: true, seen: 'A cover page.' }], ['F2', answer('F2')]]), decide);
  assert.deepEqual(g.map((x) => x.id), ['F2']);
  assert.ok(all.some((d) => d.finding === 'F1' && d.by === 'agent' && d.decision === 'left out PDF page 1: it names no accessibility problem'));
});

test('guard i: the counts sentence counts the findings after merging', () => {
  const f = foldAnswers(four(), new Map([['F1', answer('F1')], ['F2', answer('F1', { id: 'F2', sameAs: 'F1' })], ['F3', answer('F3')], ['F4', answer('F4')], ['F5', answer('F5')]]), () => {});
  assert.equal(countsSentence(f), '4 findings read from the PDF: 3 the tester verified fixed, 1 open.');
  assert.equal(countsSentence([{ status: null }]), '1 finding read from the PDF.');
  assert.equal(countsSentence([{ status: 'open' }, { status: null }]), '2 findings read from the PDF: 1 open, 1 with no status.');
});

test('guard h: Gemini runs the manual flow on a model that reads pictures unless GEMINI_MODEL is set; the loop is unchanged', () => {
  const g = 'gemini --approval-mode auto_edit -p "x"';
  assert.equal(MANUAL_GEMINI_MODEL, 'gemini-2.5-pro');
  assert.equal(agentEnvFor(g, {}, { context: 'manual' }).GEMINI_MODEL, 'gemini-2.5-pro');
  assert.equal(agentEnvFor('"C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd" -p "x"', {}, { context: 'manual' }).GEMINI_MODEL, 'gemini-2.5-pro');
  assert.equal(agentEnvFor(g, { GEMINI_MODEL: 'x' }, { context: 'manual' }).GEMINI_MODEL, 'x');
  assert.equal(agentEnvFor(g, {}).GEMINI_MODEL, undefined);
  assert.equal(agentEnvFor(g, {}, { context: 'loop' }).GEMINI_MODEL, undefined);
  assert.equal(agentEnvFor('claude -p "x"', {}, { context: 'manual' }).GEMINI_MODEL, undefined);
  assert.equal(agentEnvFor(g, {}, { context: 'manual' }).GEMINI_CLI_TRUST_WORKSPACE, 'true');
});

test('AC7: the model a stream names in its init event goes in the call log\'s header', () => {
  assert.equal(streamModel('{"type":"init","session_id":"s","model":"gemini-2.5-pro"}\n{"type":"message"}'), 'gemini-2.5-pro');
  assert.equal(streamModel('{"type":"system","subtype":"init","model":"claude-x"}'), 'claude-x');
  assert.equal(streamModel('plain words\n{"type":"message","content":"init"}'), null);
  assert.equal(JSON.parse(agentLog({ code: 0, result: {}, stdout: '', model: 'gemini-2.5-pro' }).split('\n')[0]).model, 'gemini-2.5-pro');
  assert.equal(JSON.parse(agentLog({ code: 0, result: {}, stdout: '' }).split('\n')[0]).model, undefined);
});

test('pictures-and-routes AC2/3: a finding keeps whether its picture was opened; the read sentence counts the pages it was not; the seen line says it is a guess', () => {
  const cands = [1, 2, 3].map((n) => ({ id: `F${n}`, pages: [n + 1], page: n + 1, status: 'fixed', criterion: '5.C', quote: 'q', picture: `pages/page-0${n + 1}.png`, images: [], lines: [] }));
  const { decide } = log();
  const seen = new Map([['F1', true], ['F2', false], ['F3', false]]);
  const f = foldAnswers(cands, new Map(cands.map((c) => [c.id, answer(c.id, c.id === 'F3' ? { sameAs: 'F2', element: 'the element of F2', selectors: ['#f2'] } : {})])), decide, (x) => (seen.has(x) ? seen.get(x) : null));
  assert.deepEqual(f.map((x) => [x.id, x.seenPicture, (x.seenMore || []).map((m) => [m.page, m.seenPicture])]), [['F1', true, []], ['F2', false, [[4, false]]]]);
  assert.deepEqual(unseenPages(f), [3, 4]);
  assert.equal(readSentence(f), `${countsSentence(f)} The assistant did not open the pictures of 2 pages.`);
  assert.equal(readSentence([f[0]]), countsSentence([f[0]]));
  assert.equal(seenLine(f[1]), 'The assistant did not open the picture of page 3; what it says below is a guess from the text: Page of F2.');
  assert.equal(seenLine(f[0]), 'What the assistant saw on page 2: Page of F1.');
  // Without the check (the old call), no finding carries it.
  assert.equal('seenPicture' in foldAnswers(cands, new Map([['F1', answer('F1')]]), decide)[0], false);
  assert.equal(uncheckedLine({ statusDate: '2026-09-28' }, '/reports', 'the application shows its Not Found page'), 'The tester verified this fixed on 28 Sep 2026; the tool could not open /reports (the application shows its Not Found page), so it could not confirm it.');
});

test('pictures-and-routes AC5: a route is on the list when it is the same path, ignoring a trailing slash and the query', () => {
  const routes = ['http://h.test/app/', 'http://h.test/app/search', 'http://h.test/app/layout/default'];
  for (const r of ['/app/search', '/app/search/', 'http://h.test/app/search?q=1', 'layout/default', '', '/app']) assert.equal(onRouteList(r, routes, 'http://h.test/app/'), true, r);
  for (const r of ['/app/layout/form-panel', '/layout/default', 'http://other.test/app/search', 'http://[bad']) assert.equal(onRouteList(r, routes, 'http://h.test/app/'), false, r);
});

test('crawl-first fix: a route answered as the prompt\'s whole line (its URL, title, headings and "(and N more like it)") is that URL, in the describe\'s answers as in the locate\'s', () => {
  const line = 'http://h.test/app/items/1 — "Item": Item (and 2 more like it)';
  assert.equal(routeOnly(line), 'http://h.test/app/items/1');
  assert.equal(routeOnly(`- ${line}`), 'http://h.test/app/items/1');
  assert.equal(routeOnly(' /search '), '/search');
  assert.equal(routeOnly(''), '');
  assert.equal(routeOnly(null), '');
  const cands = [{ id: 'F1', pages: [2], page: 2, status: 'open', criterion: '5.C', quote: 'q', picture: 'pages/page-02.png', images: [], lines: [] }];
  const f = foldAnswers(cands, new Map([['F1', answer('F1', { route: line })]]), () => {});
  assert.equal(f[0].route, 'http://h.test/app/items/1');
  assert.equal(onRouteList(f[0].route, ['http://h.test/app/items/1', 'http://h.test/app/items/2'], 'http://h.test/app/'), true);
});

test('pictures-and-routes AC6: the app\'s own Not Found view is told from its title, first heading or main text, when the main region is short', () => {
  assert.equal(notFoundView({ title: 'Not Found', heading: '', main: 'Nothing here', mainWords: 2 }), true);
  assert.equal(notFoundView({ title: 'My app', heading: 'Page not found', main: 'Go home', mainWords: 2 }), true);
  // Either apostrophe.
  assert.equal(notFoundView({ title: 'My app', heading: 'Oops', main: 'This page doesn’t exist. Go home.', mainWords: 6 }), true);
  assert.equal(notFoundView({ title: 'My app', heading: 'Oops', main: "This page doesn't exist. Go home.", mainWords: 6 }), true);
  assert.equal(notFoundView({ title: 'My app', heading: 'Error 404', main: '', mainWords: 0 }), true);
  // A real page that mentions "not found" in a long main region is a page.
  assert.equal(notFoundView({ title: 'Search', heading: 'Results', main: 'No results found for "x". Not found? Try again.', mainWords: 80 }), false);
  assert.equal(notFoundView({ title: 'Welcome', heading: 'Welcome', main: 'Find what you need', mainWords: 4 }), false);
  assert.equal(notFoundView({}), false);
});

test('pictures-and-routes AC6, amended: a deep link the server answers with HTTP 404 is loaded when the app rendered a real page on it', () => {
  // The real page: not the Not Found view, and words in its main region.
  assert.equal(pageDespite404({ title: 'Cargo Traceability', heading: 'Search', main: 'Search verifiable credentials by type, status and date range; the results list every match.', mainWords: 48 }), true);
  // The app's Not Found view, a bare shell that rendered nothing, and no answer at all.
  assert.equal(pageDespite404({ title: 'Not Found', heading: '404', main: '', mainWords: 0 }), false);
  assert.equal(pageDespite404({ title: 'Search', heading: 'Search', main: 'Search', mainWords: 1 }), true);
  assert.equal(pageDespite404({ title: 'Cargo Traceability', heading: '', main: '', mainWords: 0 }), false);
  assert.equal(pageDespite404({}), false);
});

test('removed-element guard d: already-fixed.md and decisions.md carry the "Already fixed: removed" section with the reason and what shows it', () => {
  const rows = [
    { finding: 'F1', title: 'Refresh button', page: 1, quote: 'No keyboard access to Refresh button', seen: 'The Hot List.', removed: { by: 'plan', reason: 'hotlist.component.html has no refresh button', files: ['src/app/hotlist/hotlist.component.html'] }, url: 'http://x/hotlist' },
    { finding: 'F2', title: 'Old link', page: 2, quote: '', seen: null, removed: { by: 'locate', reason: 'the page has no such link', files: [] }, url: 'http://x/home' },
  ];
  // already-fixed.md's section (level 1), as the run writes it.
  const md = removedSection(rows, 'screenshots', 1).join('\n');
  assert.match(md, /^# Already fixed: removed \(2\)$/m);
  assert.match(md, /^## F1: Refresh button — \[Screenshot 1\]\(parsed\/pages\/page-01\.png\)$/m);
  assert.match(md, /^- The element has been removed: hotlist\.component\.html has no refresh button$/m);
  assert.match(md, /^- Shown by: src\/app\/hotlist\/hotlist\.component\.html$/m);
  assert.match(md, /^- Shown by: the deployed page, http:\/\/x\/home$/m);
  assert.deepEqual(removedSection([], 'pdf', 1), []);
  // decisions.md, from a run's own files.
  const dir = mkdtempSync(join(tmpdir(), 'a11y-508-removed-unit-'));
  try {
    writeFileSync(join(dir, 'findings.json'), JSON.stringify({ findings: [{ id: 'F1', title: 'Refresh button', page: 1, quote: 'No keyboard access to Refresh button', removed: rows[0].removed, url: 'http://x/hotlist' }, { id: 'F2', title: 'Other', page: 2, quote: 'q' }] }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ source: 'pdf', items: { F1: { status: 'removed' } } }));
    writeFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ at: 't', stage: 'plan', finding: 'F1', by: 'agent', decision: 'the element has been removed', reason: 'hotlist.component.html has no refresh button' }) + '\n');
    const dm = decisionsMarkdown(dir);
    assert.match(dm, /^## Already fixed: removed \(1\)$/m);
    assert.match(dm, /^### F1: Refresh button — \[PDF page 1\]\(source\.pdf#page=1\)$/m);
    assert.match(dm, /^- The element has been removed: hotlist\.component\.html has no refresh button$/m);
    assert.doesNotMatch(dm, /### F2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(removedWords(1), '1 element has been removed since the tester looked');
  assert.equal(removedWords(2), '2 elements have been removed since the tester looked');
});

test('removed-element AC1: a locate reason that offers another element in its place is a stand-in; a plain one is not', () => {
  for (const r of ['the Search button serves the same purpose', 'The Search button is the equivalent of refresh', 'it was replaced by the time-range buttons', 'use the menu instead of it', 'a substitute control']) assert.equal(STAND_IN.test(r), true, r);
  for (const r of ['the element is in the deployed page under these selectors', 'the button is in the search bar']) assert.equal(STAND_IN.test(r), false, r);
});

let failed = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${t.name}\n${e.stack}`);
  }
}
console.log(failed ? `${failed} failed` : 'manual-read: all passed');
process.exit(failed ? 1 : 0);
