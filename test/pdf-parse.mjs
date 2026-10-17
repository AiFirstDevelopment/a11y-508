// The PDF parse (docs/plans/pdf-parse.md): reading order and the recognisers as pure functions, then
// the parse itself in the Chrome on the machine, on the fixtures from test/fixtures/manual/make-pdf.mjs.
// Run: node test/pdf-parse.mjs  (or one test: node test/pdf-parse.mjs -g "<name>")

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFJS_DIR, parsePdf, readingOrder, recognise, recogniseStatus, findDate, normalizeText, reportMarkdown } from '../src/pdf-parse.mjs';
import { CALLOUT, RED, SHOT, SLIDE } from './fixtures/manual/make-pdf.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = join(ROOT, 'test', 'fixtures', 'manual');
const only = process.argv.includes('-g') ? process.argv[process.argv.indexOf('-g') + 1] : null;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Folders this file creates, and only those, are removed at the end.
const made = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'a11y-508-pdf-parse-'));
  made.push(d);
  return d;
};

// A PNG's pixels (8-bit RGB or RGBA, non-interlaced: what Chrome writes), for sampling.
function png(file) {
  const b = readFileSync(file);
  let i = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const t = b.toString('latin1', i + 4, i + 8);
    const d = b.subarray(i + 8, i + 8 + len);
    if (t === 'IHDR') [w, h, type] = [d.readUInt32BE(0), d.readUInt32BE(4), d[9]];
    if (t === 'IDAT') idat.push(d);
    i += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const c = y && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + up - c;
      const pr = Math.abs(p - a) <= Math.abs(p - up) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - up) <= Math.abs(p - c) ? up : c;
      px[y * stride + x] = (v + [0, a, up, (a + up) >> 1, pr][f]) & 255;
    }
  }
  return { w, h, at: (x, y) => [...px.subarray((Math.round(y) * w + Math.round(x)) * bpp, (Math.round(y) * w + Math.round(x)) * bpp + 3)] };
}

// ---- Pure functions.

test('reading order: two columns read left then right, the title first, rotated text last', () => {
  const it = (text, x, y, size = 14, angle = 0) => ({ text, x, y, w: text.length * size * 0.5, size, angle });
  const r = readingOrder([
    it('Right one', 520, 100), it('Left one', 40, 100), it('Right two', 520, 118), it('Left two', 40, 118),
    it('Title of the slide', 40, 40, 20), it('Verified fixed – 9/28/2026', 40, 500), it('Side label', 20, 300, 12, -90),
  ], { width: 960 });
  assert.deepEqual(r.lines, ['Title of the slide', 'Left one', 'Left two', 'Right one', 'Right two', 'Verified fixed – 9/28/2026', 'Side label (rotated)']);
});

test('reading order: a line-end hyphen is joined, ligatures and non-breaking spaces are normalised, dashes kept', () => {
  const it = (text, y) => ({ text, x: 40, y, w: 300, size: 12, angle: 0 });
  const r = readingOrder([it('in each acces-', 100), it('sible table ﬁeld one — two', 114)], { width: 960 });
  assert.deepEqual(r.lines, ['in each accessible', 'table field one — two']);
  assert.equal(normalizeText('a  bﬂ'), 'a bfl');
});

test('status: verdict lines, dates, the 8-word rule, and the section', () => {
  assert.deepEqual(recogniseStatus(['Still an issue – 9/28/26']), { value: 'open', words: 'Still an issue – 9/28/26', date: '2026-09-28', source: 'text' });
  assert.deepEqual(recogniseStatus(['Verified fixed – 9/28/2026']), { value: 'fixed', words: 'Verified fixed – 9/28/2026', date: '2026-09-28', source: 'text' });
  assert.equal(recogniseStatus(['Not fixed']).value, 'open');
  assert.equal(recogniseStatus(['No longer an issue (2026-10-02)']).date, '2026-10-02');
  assert.equal(findDate('Fixed September 3, 2026').iso, '2026-09-03');
  // A description with a verdict's words is not a status line (more than 8 words).
  assert.equal(recogniseStatus(['13.C Text and images of text, where color alone would fail, have sufficient contrast']), null);
  const pages = [
    { n: 1, blocks: [{ rotated: false, lines: [{ text: 'Resolved Issues' }] }], lines: ['Resolved Issues'], images: [] },
    { n: 2, blocks: [], lines: ['14.B Data cells are associated with headers'], images: [{}] },
  ];
  assert.deepEqual(recognise(pages), [1]);
  assert.deepEqual(pages[1].status, { value: 'fixed', words: 'Resolved Issues', date: null, source: 'section' });
  assert.equal(pages[1].criteria[0].id, '14.B');
  assert.equal(pages[0].divider, true);
});

test('the report: a line is left out when there is nothing for it', () => {
  const md = reportMarkdown({ file: 'x.pdf', pageCount: 1, dividers: [], notes: [], pages: [{ n: 1, section: null, divider: false, status: null, criteria: [], images: [], imagesSkipped: 0, picture: 'pages/page-01.png', lines: [] }] });
  assert.match(md, /## Page 1 of 1\nPicture of the page: pages\/page-01\.png\n\nText: none \(a picture only\)/);
  assert.doesNotMatch(md, /Section:|Status:|Criterion:/);
});

// ---- The parse, in Chrome.

const parseDeck = async (env = {}) => {
  const out = temp();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return { out, m: await parsePdf({ file: join(FIX, 'deck.pdf'), outDir: out }) };
  } finally {
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

let deck = null;
const theDeck = async () => (deck ||= await parseDeck());

test('AC1/3/4: the deck: pages, sections, statuses, criteria, pictures, as the report states them', async () => {
  const { out, m } = await theDeck();
  assert.equal(m.pageCount, 13);
  assert.deepEqual(m.dividers, [1, 11]);
  const md = readFileSync(join(out, 'report.md'), 'utf8');
  assert.match(md, /^# The tester's PDF, parsed: deck\.pdf\n13 pages: 13 with text, 11 with pictures\.\nSection dividers: pages 1 and 11\.\n/);
  const p12 = md.split('\n## Page 12 of 13\n')[1].split('\n## ')[0];
  assert.equal(p12.split('\n\nText, in reading order:')[0], [
    'Section: Outstanding Issues',
    'Status: open — "Still an issue – 9/28/26" (2026-09-28)',
    'Criterion: 13.A 1.4.1-color-meaning (WCAG 1.4.1)',
    'Picture of the page: pages/page-12.png',
    'Pictures on the page: pages/page-12-image-1.png (160×96, at 4–54% across, 26–80% down)',
  ].join('\n'));
  assert.deepEqual(m.pages[1].criteria, [{ id: '5.C', name: '1.3.1-programmatic-label', wcag: '1.3.1 / 4.1.2', source: 'catalog' }]);
  assert.deepEqual(m.pages[11].wcag, ['1.4.1']);
  assert.equal(m.pages[1].text[0].bold, true);
  assert.equal(m.pages[1].text.at(-1).bold, false);
  for (const p of m.pages) assert.ok(existsSync(join(out, p.picture)), p.picture);
  assert.equal(png(join(out, 'pages', 'page-02.png')).w, 1600);
  assert.equal(png(join(out, 'pages', 'page-02.png')).h, 900);
  assert.deepEqual([m.pages[1].images[0].width, m.pages[1].images[0].height], [160, 96]);
});

test('guard a: reading order on the deck: the title is line 1, the verdict last, the two columns one after the other', async () => {
  const { m } = await theDeck();
  const two = m.pages[8].lines;
  assert.deepEqual(two.slice(2, 8), ['Left column, line one', 'Left column, line two', 'Left column, line three', 'Right column, line one', 'Right column, line two', 'Right column, line three']);
  for (const p of m.pages.filter((x) => !x.divider)) {
    assert.match(p.lines[0], /^\d{1,2}\.[A-Z] /, `page ${p.n} line 1`);
    if (p.status && p.status.source === 'text') assert.match(p.lines.at(-1), /^(Verified fixed|Still an issue) – /, `page ${p.n} last line`);
  }
  assert.equal(m.pages[9].lines.at(-1), 'Screenshot from the staging site (rotated)');
  assert.equal(m.pages[8].lines[0], '14.B Data cells are programmatically associated with their header cells in each accessible');
});

test('guard b: the page picture has the shapes drawn over the screenshot; the embedded picture has none; the callout is not text', async () => {
  const { out, m } = await theDeck();
  const page = png(join(out, 'pages', 'page-02.png'));
  const image = png(join(out, 'pages', 'page-02-image-1.png'));
  const s = page.w / SLIDE.width;
  // The red rectangle's left edge, half way up.
  const [rx, ry] = [RED.x, RED.y + RED.h / 2];
  const red = page.at(rx * s, (SLIDE.height - ry) * s);
  assert.ok(red[0] > 200 && red[1] < 80 && red[2] < 80, `page-02.png at the red rectangle: ${red}`);
  const under = image.at(((rx - SHOT.x) / SHOT.w) * image.w, ((SHOT.y + SHOT.h - ry) / SHOT.h) * image.h);
  assert.ok(under[2] > 150 && under[0] < 80, `page-02-image-1.png at the same spot is the screenshot's blue: ${under}`);
  // The callout box: its fill colour in the page picture; its words in no line of the page.
  const fill = page.at((CALLOUT.x + 6) * s, (SLIDE.height - CALLOUT.y - 4) * s);
  assert.ok(fill[0] > 230 && fill[1] > 200 && fill[2] < 90, `page-02.png at the callout: ${fill}`);
  assert.ok(!m.pages[1].lines.some((l) => /callout|no accessible name or title/i.test(l)));
});

test('guard d: verdicts recognised on the deck, a description is not one, and a slide without one takes its section', async () => {
  const { m } = await theDeck();
  assert.deepEqual([m.pages[11].status.value, m.pages[11].status.date], ['open', '2026-09-28']);
  assert.deepEqual([m.pages[1].status.value, m.pages[1].status.date], ['fixed', '2026-09-28']);
  assert.deepEqual(m.pages[6].status, { value: 'fixed', words: 'Verified fixed – 9/28/2026', date: '2026-09-28', source: 'text' });
  assert.match(m.pages[6].lines[0], /have sufficient contrast$/);
  assert.deepEqual(m.pages[9].status, { value: 'fixed', words: 'Resolved Issues', date: null, source: 'section' });
});

test('guard i: the parse is deterministic', async () => {
  const a = await theDeck();
  const b = await parseDeck();
  assert.equal(readFileSync(join(a.out, 'report.md'), 'utf8'), readFileSync(join(b.out, 'report.md'), 'utf8'));
  const strip = (dir) => {
    const j = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    delete j.parsedAt;
    return j;
  };
  assert.deepEqual(strip(a.out), strip(b.out));
  assert.deepEqual(readdirSync(join(a.out, 'pages')).sort(), readdirSync(join(b.out, 'pages')).sort());
  for (const f of readdirSync(join(a.out, 'pages'))) {
    const [x, y] = [png(join(a.out, 'pages', f)), png(join(b.out, 'pages', f))];
    assert.deepEqual([x.w, x.h], [y.w, y.h], f);
  }
});

test('guard j: A11Y_508_PDF_MAX_PAGES caps the pages parsed and the header says so', async () => {
  const { out, m } = await parseDeck({ A11Y_508_PDF_MAX_PAGES: '3' });
  assert.deepEqual(readdirSync(join(out, 'pages')).filter((f) => /^page-\d+\.png$/.test(f)).sort(), ['page-01.png', 'page-02.png', 'page-03.png']);
  assert.equal(m.pages.length, 3);
  assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /^# .*\n.*\n.*\n.*\nStopped after 3 pages; the PDF has 13\.\n/);
});

test('AC8: a PDF with no text: every page a picture only, said in the header', async () => {
  const out = temp();
  const m = await parsePdf({ file: join(FIX, 'pictures-only.pdf'), outDir: out });
  const md = readFileSync(join(out, 'report.md'), 'utf8');
  assert.match(md, /\nThe PDF has no text: every page is a picture only\.\n/);
  assert.equal((md.match(/Text: none \(a picture only\)/g) || []).length, 2);
  assert.equal(m.pages.length, 2);
});

test('AC8: an encrypted and a truncated PDF cannot be opened, in plain words', async () => {
  for (const [f, why] of [['encrypted.pdf', 'it is protected by a password'], ['truncated.pdf', 'it is damaged or incomplete']]) {
    const out = temp();
    await assert.rejects(parsePdf({ file: join(FIX, f), outDir: out }), (e) => e.unreadable === true && e.message === `The PDF could not be opened: ${why}.`);
    assert.equal(existsSync(join(out, 'report.md')), false);
  }
});

test('guard l: the vendored pdf.js is pinned and licensed', async () => {
  const { m } = await theDeck();
  const pinned = readFileSync(join(PDFJS_DIR, 'VERSION'), 'utf8').trim();
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
  assert.equal(m.pdfjs, pinned);
  assert.match(readFileSync(join(PDFJS_DIR, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
  for (const f of ['pdf.mjs', 'pdf.worker.mjs', 'cmaps', 'standard_fonts']) assert.ok(existsSync(join(PDFJS_DIR, f)), f);
});

test('AC10: a11y-508 pdf <file> parses with no repository and no config, and prints the header and a line per page', async () => {
  const { spawnSync } = await import('node:child_process');
  const cwd = temp();
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'a11y-508.mjs'), 'pdf', join(FIX, 'deck.pdf')], { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const out = join(cwd, 'deck.parsed');
  assert.ok(existsSync(join(out, 'report.md')) && existsSync(join(out, 'manifest.json')));
  const lines = r.stdout.split('\n');
  assert.deepEqual(lines.slice(0, 3), ["# The tester's PDF, parsed: deck.pdf", '13 pages: 13 with text, 11 with pictures.', 'Section dividers: pages 1 and 11.']);
  assert.ok(lines.includes('page 12: open, 13.A, 1 picture, 4 lines'), r.stdout);
  assert.ok(lines.includes('page 1: divider "Resolved Issues", 0 pictures, 1 line'), r.stdout);
  const other = join(cwd, 'elsewhere');
  const e = spawnSync(process.execPath, [join(ROOT, 'bin', 'a11y-508.mjs'), 'pdf', join(FIX, 'encrypted.pdf'), '--out', other], { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(e.status, 2);
  assert.match(e.stderr, /The PDF could not be opened: it is protected by a password\./);
});

test('AC1: the core installs nothing: no dependencies, and pdf.js ships under src/', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.files.includes('src'));
  assert.ok(PDFJS_DIR.startsWith(join(ROOT, 'src')));
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
console.log(failed ? `${failed} failed` : 'pdf-parse: all passed');
process.exit(failed ? 1 : 0);
