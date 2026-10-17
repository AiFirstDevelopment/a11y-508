// The tool lists the findings from the parse (docs/plans/read-from-parse.md): the candidate builder,
// the folding of the assistant's answers (merges, extras, pages that name no problem, pages it did
// not describe), the counts sentence, and the Gemini model for the manual flow's calls, as pure
// functions. Run: node test/manual-read.mjs  (or one test: node test/manual-read.mjs -g "<name>")

import assert from 'node:assert/strict';
import { agentEnvFor, MANUAL_GEMINI_MODEL, streamModel, agentLog } from '../src/agent.mjs';
import { buildCandidates, countsSentence, describedEnough, foldAnswers, seenLine, seenLines } from '../src/manual.mjs';

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
