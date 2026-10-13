// The Needs a person screen's server side (docs/plans/needs-a-person.md): GET /api/review and
// POST /api/ledger/decision, against a ledger, a report with a screenshot and a source folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const IMG = { test: '7.A', name: 'Images', wcag: '1.1.1', level: 'violation', impact: 'critical', selector: '#hero-banner', message: 'Image has no alt attribute', html: '<img id="hero-banner" src="img/harbour-dawn.png">', screenshot: 'screenshots/f1.png' };
const TITLES = { test: '12.B', name: 'Page titles', wcag: '2.4.2', level: 'review', impact: 'moderate', selector: '', message: 'Several pages share a title', html: '', pages: ['http://127.0.0.1:9/a?x=1', 'http://127.0.0.1:9/b'] };
const OPEN = { test: '13.C', name: 'Contrast', wcag: '1.4.3', level: 'violation', impact: 'serious', selector: 'p.lead-note', message: 'Low contrast', html: '<p class="lead-note">x</p>' };
const fp = (f) => `${f.test}|${f.selector}|${f.message}`;

function seed(cwd) {
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'app.html'), '<main>\n  <h1>Harbour</h1>\n  <img id="hero-banner" src="img/harbour-dawn.png">\n</main>\n');
  const rep = join(cwd, 'a11y-508-report');
  mkdirSync(join(rep, 'screenshots'), { recursive: true });
  writeFileSync(join(rep, 'screenshots', 'f1.png'), PNG);
  writeFileSync(join(rep, 'report.json'), JSON.stringify({
    baseUrl: 'http://127.0.0.1:9/', finishedAt: '2026-10-13T10:00:00.000Z', passed: false,
    summary: { pages: 1, audited: 1, violations: 2, reviews: 1, byImpact: {} },
    pages: [{ url: 'http://127.0.0.1:9/', finalUrl: 'http://127.0.0.1:9/', findings: [IMG, OPEN] }],
    site: { findings: [TITLES] },
  }));
  const entry = (f, status, pages) => ({ fingerprint: fp(f), test: f.test, name: f.name, wcag: f.wcag, level: f.level, impact: f.impact, message: f.message, selector: f.selector, html: f.html, pages, status, firstSeenRound: 1, lastSeenRound: status === 'needs-human' && f === TITLES ? 1 : 2, attempts: [{ round: 1, outcome: 'no-change' }], reason: 'gave up' });
  mkdirSync(join(cwd, 'a11y-508-work'), { recursive: true });
  writeFileSync(join(cwd, 'a11y-508-work', 'ledger.json'), JSON.stringify({
    version: 1,
    rounds: [{ round: 1, at: '2026-10-13T09:00:00.000Z', violations: 2, diff: {} }, { round: 2, at: '2026-10-13T10:00:00.000Z', violations: 2, diff: {} }],
    findings: { [fp(IMG)]: entry(IMG, 'needs-human', ['http://127.0.0.1:9/']), [fp(TITLES)]: entry(TITLES, 'needs-human', ['site']), [fp(OPEN)]: entry(OPEN, 'open', ['http://127.0.0.1:9/']) },
  }));
}

test('needs a person: the list, where to look, the screenshot from the report folder, and decisions written to the ledger', async () => {
  const s = await startServer();
  try {
    seed(s.cwd);
    const r = (await s.call('GET', '/api/review')).json;
    assert.equal(r.exists, true);
    // Only needs-human, newest round first.
    assert.deepEqual(r.items.map((i) => i.test), ['7.A', '12.B']);
    const img = r.items[0];
    assert.equal(img.wholePage, false);
    assert.deepEqual(img.sources.map((x) => `${x.file}:${x.line}`), ['src/app.html:3']);
    assert.equal(img.screenshot, '/api/reports/latest/screenshots/f1.png');
    assert.match(img.condition, /\S/);
    const shot = await s.call('GET', img.screenshot);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers['content-type'], 'image/png');
    // A site-wide finding: the whole page, its pages from the report.
    const titles = r.items[1];
    assert.equal(titles.wholePage, true);
    assert.deepEqual(titles.pages, TITLES.pages);

    // The decision: validated, then written.
    assert.equal((await s.call('POST', '/api/ledger/decision', { body: { fingerprint: fp(IMG), status: 'verified' } })).status, 400);
    const noNote = await s.call('POST', '/api/ledger/decision', { body: { fingerprint: fp(IMG), status: 'wont-fix', note: '  ' } });
    assert.equal(noNote.status, 400);
    assert.match(noNote.json.error, /why/);
    assert.equal((await s.call('POST', '/api/ledger/decision', { body: { fingerprint: 'nope', status: 'adequate' } })).status, 404);
    assert.equal((await s.call('POST', '/api/ledger/decision', { body: { fingerprint: fp(OPEN), status: 'adequate' } })).status, 409);
    const ok = await s.call('POST', '/api/ledger/decision', { body: { fingerprint: fp(IMG), status: 'adequate' } });
    assert.equal(ok.status, 200, ok.text);
    const ledger = JSON.parse(readFileSync(join(s.cwd, 'a11y-508-work', 'ledger.json'), 'utf8'));
    const e = ledger.findings[fp(IMG)];
    assert.equal(e.status, 'adequate');
    assert.deepEqual({ ...e.decision, at: typeof e.decision.at }, { by: 'person', status: 'adequate', note: '', at: 'string', round: 2 });
    const again = (await s.call('GET', '/api/review')).json;
    assert.deepEqual(again.items.map((i) => i.test), ['12.B']);
    assert.deepEqual(again.decided.map((i) => [i.test, i.decision.status]), [['7.A', 'adequate']]);
    // History counts it as decided, not remaining.
    const t = (await s.call('GET', '/api/loop/timeline')).json;
    assert.deepEqual([t.total.decided, t.total.remaining, t.total.needsHuman], [1, 1, 1]);

    // Sent back to the assistant: open, with the note, its attempts reset.
    const back = await s.call('POST', '/api/ledger/decision', { body: { fingerprint: fp(TITLES), status: 'open', note: 'Give each page its own title.' } });
    assert.equal(back.status, 200, back.text);
    const l2 = JSON.parse(readFileSync(join(s.cwd, 'a11y-508-work', 'ledger.json'), 'utf8')).findings[fp(TITLES)];
    assert.deepEqual([l2.status, l2.attempts.length, l2.earlierAttempts.length, l2.decision.note], ['open', 0, 1, 'Give each page its own title.']);

    // A screenshot whose file is gone: none, and said so -- not an older report's image of it.
    const older = join(s.cwd, 'a11y-508-history', '2026-10-12');
    mkdirSync(join(older, 'screenshots'), { recursive: true });
    writeFileSync(join(older, 'screenshots', 'f1.png'), PNG);
    writeFileSync(join(older, 'report.json'), readFileSync(join(s.cwd, 'a11y-508-report', 'report.json'), 'utf8').replace('2026-10-13T10:00:00.000Z', '2026-10-12T10:00:00.000Z'));
    rmSync(join(s.cwd, 'a11y-508-report', 'screenshots', 'f1.png'));
    const gone = (await s.call('GET', '/api/review')).json.decided.find((i) => i.test === '7.A');
    assert.deepEqual([gone.screenshot, gone.screenshotMissing], [null, true]);

    // Not on a fix waiting for verification; a prototype name is no finding.
    const l3 = JSON.parse(readFileSync(join(s.cwd, 'a11y-508-work', 'ledger.json'), 'utf8'));
    l3.findings[fp(TITLES)].status = 'pending';
    writeFileSync(join(s.cwd, 'a11y-508-work', 'ledger.json'), JSON.stringify(l3));
    assert.equal((await s.call('POST', '/api/ledger/decision', { body: { fingerprint: fp(TITLES), status: 'adequate' } })).status, 409);
    assert.equal((await s.call('POST', '/api/ledger/decision', { body: { fingerprint: '__proto__', status: 'adequate' } })).status, 404);
  } finally {
    await s.stop();
  }
});

test('needs a person: no decision while the fix loop runs (it holds the ledger)', async () => {
  const hang = createServer(() => {});
  await new Promise((ok) => hang.listen(0, '127.0.0.1', ok));
  const s = await startServer();
  try {
    seed(s.cwd);
    const url = `http://127.0.0.1:${hang.address().port}/`;
    const run = await s.call('POST', '/api/runs', { body: { kind: 'dry-run', url, options: { timeout: '60000' }, auth: { mode: 'none' } } });
    assert.equal(run.status, 202, run.text);
    const r = await s.call('POST', '/api/ledger/decision', { body: { fingerprint: fp(IMG), status: 'adequate' } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /fix loop is running/);
    await s.call('POST', '/api/runs/current/stop');
    await s.waitDone(20000);
  } finally {
    await s.stop();
    hang.closeAllConnections?.();
    hang.close();
  }
});
