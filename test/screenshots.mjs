// Screenshots in (docs/plans/screenshots-in.md): the checks and the report as pure functions, the parse
// of screenshots in the Chrome on the machine, and `a11y-508 manual <folder>` from the command line.
// Run: node test/screenshots.mjs  (or one test: node test/screenshots.mjs -g "<name>")

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SHOT_BYTES, NOT_A_SHOT, NO_SHOTS, SHOT_TOO_BIG, TOO_MANY_SHOTS, imageType, parseScreenshots, readShotFolder, screenshotsReport, shotsProblem } from '../src/screenshots.mjs';
import { buildCandidates } from '../src/manual.mjs';
import { pngOf, pngSize } from './fixtures/manual/png.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin', 'a11y-508.mjs');
const JPEG = join(ROOT, 'test', 'fixtures', 'manual', 'screens', 'screen-1.jpg');
const only = process.argv.includes('-g') ? process.argv[process.argv.indexOf('-g') + 1] : null;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Folders this file creates, and only those, are removed at the end.
const made = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'a11y-508-screenshots-'));
  made.push(d);
  return d;
};

test('magic bytes: PNG, JPEG and WebP are pictures; text named .png is not', () => {
  assert.equal(imageType(pngOf(4, 4)), 'png');
  assert.equal(imageType(readFileSync(JPEG)), 'jpeg');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(imageType(Buffer.from('These are my notes, not a picture.')), null);
  assert.equal(shotsProblem([{ bytes: Buffer.from('These are my notes, not a picture.') }]), NOT_A_SHOT);
  assert.equal(shotsProblem([]), NO_SHOTS);
});

// Guard f: the limits, each refusal one sentence naming them.
test('guard f: 41 screenshots are refused naming 40; an 11 MB one naming 10 MB', () => {
  const small = { bytes: pngOf(4, 4) };
  assert.equal(shotsProblem(Array(40).fill(small)), null);
  assert.equal(shotsProblem(Array(41).fill(small)), TOO_MANY_SHOTS);
  assert.match(TOO_MANY_SHOTS, /\b40\b/);
  const big = Buffer.concat([pngOf(4, 4), Buffer.alloc(11 * 1024 * 1024)]);
  assert.ok(big.length > MAX_SHOT_BYTES);
  assert.equal(shotsProblem([small, { bytes: big }]), SHOT_TOO_BIG);
  assert.match(SHOT_TOO_BIG, /10 MB/);
});

test('AC3: report.md says how many screenshots and notes, and reads one block per screenshot', () => {
  const md = screenshotsReport({ pageCount: 2, pages: [{ n: 1, picture: 'pages/page-01.png', lines: ['The three filter buttons have no accessible name.'] }, { n: 2, picture: 'pages/page-02.png', lines: [] }] });
  assert.match(md, /2 screenshots, with a note on 1 of them\./);
  assert.match(md, /## Screenshot 1 of 2\nPicture of the page: pages\/page-01\.png\nNote from the person who took it:\n> The three filter buttons have no accessible name\.\n/);
  assert.match(md, /## Screenshot 2 of 2\nPicture of the page: pages\/page-02\.png\nNote: none \(a picture only\)\n/);
});

test('AC3: the parse writes page pictures (PNG, at most 1600 px wide), the manifest and report.md; one candidate per screenshot', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'wide.png'), pngOf(2400, 300));
  const out = join(dir, 'parsed');
  const m = await parseScreenshots({ shots: [join(dir, 'wide.png'), JPEG], notes: ['The three filter buttons have no accessible name.', ''], outDir: out });
  assert.equal(m.source, 'screenshots');
  assert.equal(m.pageCount, 2);
  assert.deepEqual(m.pages.map((p) => [p.n, p.lines, p.images, p.picture, p.criteria, p.status, p.divider]), [
    [1, ['The three filter buttons have no accessible name.'], [], 'pages/page-01.png', [], null, false],
    [2, [], [], 'pages/page-02.png', [], null, false],
  ]);
  assert.deepEqual(m.shots.map((s) => s.note), ['The three filter buttons have no accessible name.', '']);
  const wide = readFileSync(join(out, 'pages', 'page-01.png'));
  assert.equal(imageType(wide), 'png');
  assert.deepEqual(pngSize(wide), { width: 1600, height: 200 });
  assert.equal(imageType(readFileSync(join(out, 'pages', 'page-02.png'))), 'png');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).pages.length, 2);
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /## Screenshot 2 of 2\nPicture of the page: pages\/page-02\.png\nNote: none/);
  const c = buildCandidates(m);
  assert.deepEqual(c.map((x) => [x.id, x.page, x.quote, x.status, x.criterion]), [['F1', 1, 'The three filter buttons have no accessible name.', null, null], ['F2', 2, '', null, null]]);
});

// Guard h: the command line takes a folder (name order, notes.txt); a folder with no pictures exits 2.
test('guard h: manual <folder> parses its screenshots with the notes of notes.txt; a folder with none exits 2 with "no screenshots"', () => {
  const cwd = temp();
  const home = temp();
  const g = (...a) => assert.equal(spawnSync('git', a, { cwd, encoding: 'utf8' }).status, 0, a.join(' '));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.html'), '<!doctype html><title>x</title>');
  // An assistant that answers nothing: the run ends at the read, after the parse.
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: 'http://127.0.0.1:9/', agent: `${JSON.stringify(process.execPath)} -e "process.exit(3)" {promptFile} {resultFile}`, source: ['src'], manualCrawlPages: 0, agentTimeout: 20000, deployed: 'bundle-change', deployTimeout: 0 }));
  g('add', '-A');
  g('commit', '-q', '-m', 'app');
  const shots = temp();
  writeFileSync(join(shots, 'b-second.png'), pngOf(64, 48, [200, 40, 40]));
  writeFileSync(join(shots, 'a-first.jpg'), readFileSync(JPEG));
  writeFileSync(join(shots, 'notes.txt'), 'a-first.jpg: The search button has no name.\nb-second.png: The logo has no alt text.\n');
  const env = { ...process.env, A11Y_508_HOME: home, TOKEN: '' };
  const r = spawnSync(process.execPath, [BIN, 'manual', shots], { cwd, env, encoding: 'utf8', timeout: 180000 });
  const repos = join(home, 'repos');
  assert.ok(existsSync(repos), r.stdout + r.stderr);
  const work = join(repos, readdirSync(repos)[0], 'work', 'manual');
  const id = readdirSync(work)[0];
  const m = JSON.parse(readFileSync(join(work, id, 'parsed', 'manifest.json'), 'utf8'));
  assert.equal(m.pageCount, 2, r.stdout + r.stderr);
  assert.deepEqual(m.pages.map((p) => p.lines), [['The search button has no name.'], ['The logo has no alt text.']]);
  assert.deepEqual(m.shots.map((s) => s.name), ['a-first.jpg', 'b-second.png']);
  assert.equal(JSON.parse(readFileSync(join(work, id, 'state.json'), 'utf8')).source, 'screenshots');
  assert.ok(!existsSync(join(work, id, 'source.pdf')));
  assert.deepEqual(readShotFolder(shots).map((s) => s.name), ['a-first.jpg', 'b-second.png']);
  // No pictures in it: exit 2, and the sentence says so.
  const empty = temp();
  writeFileSync(join(empty, 'notes.txt'), 'nothing.png: nothing\n');
  const e = spawnSync(process.execPath, [BIN, 'manual', empty], { cwd, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(e.status, 2, e.stdout + e.stderr);
  assert.match(e.stdout + e.stderr, /no screenshots/);
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
for (const d of made) rmSync(d, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'screenshots: all passed');
process.exit(failed ? 1 : 0);
