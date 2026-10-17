// Writes the manual flow's test PDFs (docs/plans/manual-findings.md, docs/plans/pdf-parse.md):
// tiny and uncompressed, so they can be read and diffed. The fake assistant (test/fake-agent.mjs)
// reads the tool's parse of them (report.md), never the PDF.
// Run: node test/fixtures/manual/make-pdf.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

// A PDF from objects: each body a string (latin1) or { dict, stream } (a Buffer or latin1 string).
// encrypt: (objNum, bytes) => bytes, for an encrypted file's strings and streams; trailer: extra keys.
function build(objs, root, { trailer = '', version = '1.4' } = {}) {
  const parts = [Buffer.from(`%PDF-${version}\n`, 'latin1')];
  let size = parts[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(size);
    const chunk = typeof body === 'string'
      ? Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${body.dict.replace('%LEN%', String(Buffer.from(body.stream, 'latin1').length))}\nstream\n`, 'latin1'), Buffer.from(body.stream, 'latin1'), Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(chunk);
    size += chunk.length;
  });
  const xref = size;
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${root} 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

export function pdf(pages) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    // 6 pt, so the longest FINDING line fits the page (pdf.js reads no text past the page's edge).
    const text = `BT /F1 6 Tf 40 780 Td 9 TL\n${lines.map((l) => `(${esc(l)}) Tj T*`).join('\n')}\nET`;
    const content = add(`<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  return build(objs, catalog);
}

// ---- A PowerPoint-style deck (docs/plans/pdf-parse.md AC 11): 960×540 pt slides, Helvetica and
// Helvetica-Bold in WinAnsi (so an en dash is one byte, 0x96), an embedded 160×96 JPEG
// (screens/: a grey bar, a blue and a green patch, a white field) drawn as a "screenshot",
// a red stroked rectangle and a yellow callout box drawn over it (shapes, not text).
// screens/screen-K.jpg, K = 1..12: one per slide, each different (an image painted on 3 or more
// pages is a logo to the parse, not a screenshot). Made from screenPpm(K) with cjpeg -baseline
// (node test/fixtures/manual/make-pdf.mjs --jpeg rewrites them when cjpeg is installed).
export function screenPpm(k) {
  const W = 160;
  const H = 96;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = y < 16 ? [128, 128, 128] : x < 80 ? [32, 80, 192] : [40, 160, 60];
      const fx = 84 + ((k * 7) % 28);
      if (y >= 60 && y < 60 + 4 + (k % 5) * 6 && x >= fx && x < fx + 40) c = [250, 250, 250];
      if (y < 16 && x >= 4 + k * 10 && x < 10 + k * 10) c = [240, 240, 240];
      px.set(c, (y * W + x) * 3);
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), px]);
}
const screen = (k) => readFileSync(join(here, 'screens', `screen-${k}.jpg`));
export const SLIDE = { width: 960, height: 540 };
// Where the screenshot, the red rectangle and the callout are painted, in PDF points (y up).
export const SHOT = { x: 40, y: 110, w: 480, h: 288 };
export const RED = { x: 100, y: 200, w: 120, h: 60, line: 4 };
export const CALLOUT = { x: 300, y: 140, w: 200, h: 50 };
const win = (s) => s.replace(/–/g, '\x96').replace(/—/g, '\x97');

// A slide: { title: [lines], picture, body: [{ x, y, size, text }], verdict, rotated, divider }.
function slideContent(s) {
  const out = [];
  const text = (font, size, x, y, t) => out.push(`BT /${font} ${size} Tf ${x} ${y} Td (${esc(win(t))}) Tj ET`);
  if (s.divider) {
    text('F2', 40, 300, 260, s.divider);
    return out.join('\n');
  }
  (s.title || []).forEach((t, i) => text('F2', 20, 40, 500 - i * 24, t));
  if (s.picture) {
    out.push(`q ${SHOT.w} 0 0 ${SHOT.h} ${SHOT.x} ${SHOT.y} cm /Im1 Do Q`);
    out.push(`q 1 0 0 RG ${RED.line} w ${RED.x} ${RED.y} ${RED.w} ${RED.h} re S Q`);
    out.push(`q 1 0.9 0.2 rg ${CALLOUT.x} ${CALLOUT.y} ${CALLOUT.w} ${CALLOUT.h} re f 0.1 0.1 0.1 RG 2 w ${[0, 1, 2].map((k) => `${CALLOUT.x + 14} ${CALLOUT.y + 38 - k * 12} m ${CALLOUT.x + 150 - k * 30} ${CALLOUT.y + 38 - k * 12} l S`).join(' ')} Q`);
  }
  for (const b of s.body || []) text(b.bold ? 'F2' : 'F1', b.size || 11, b.x, b.y, b.text);
  if (s.verdict) text('F1', 14, 40, 40, s.verdict);
  if (s.rotated) out.push(`BT /F1 12 Tf 0 1 -1 0 ${SHOT.x + SHOT.w + 24} ${SHOT.y} Tm (${esc(s.rotated)}) Tj ET`);
  return out.join('\n');
}

export function deck(slides) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
  let shots = 0;
  for (const s of slides) {
    const im = s.picture ? add({ dict: '<< /Type /XObject /Subtype /Image /Width 160 /Height 96 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %LEN% >>', stream: screen(++shots).toString('latin1') }) : 0;
    const content = add({ dict: '<< /Length %LEN% >>', stream: slideContent(s) });
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${SLIDE.width} ${SLIDE.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${im ? ` /XObject << /Im1 ${im} 0 R >>` : ''} >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  return build(objs, catalog);
}

// FINDING lines (the fake assistant's convention): tag | title | route | selectors (;) | element | the
// tester's words. The tag is the id of the finding the page belongs to: the candidate's own id, or an
// earlier one when the page shows the same element again (the fake says sameAs).
const F1 = 'FINDING F1 | Search button has no accessible name | /search | #search-btn | the magnifier button in the search bar | The magnifier button in the search bar is announced only as button.';
const F2 = 'FINDING F2 | Company logo has no text alternative | / | footer img | the logo in the footer | The footer logo image has no alt text.';
const F3 = 'FINDING F3 | Menu button has no accessible name | / | #menu-btn | the menu button in the header | The hamburger menu button in the header has no name.';
const T5C = ['5.C The combination of the accessible name and visible label is programmatically', 'determinable - 1.3.1-programmatic-label'];
const T13C = ['13.C Text and images of text, where color alone would fail, have sufficient contrast'];
const T14B = ['14.B Data cells are programmatically associated with their header cells in each acces-', 'sible data table - 1.3.1-cell-header-association'];
const T13A = ['13.A Color is not used as the only visual means of conveying information, indicating an', 'action, prompting a response, or distinguishing a visual element. - 1.4.1-color-meaning'];
const FIXED = 'Verified fixed – 9/28/2026';
const OPEN = 'Still an issue – 9/28/26';
const caption = (...t) => t.map((text, i) => ({ x: 40, y: 88 - i * 12, size: 10, text }));
// The deck (docs/plans/read-from-parse.md AC 9), the shape of the tester's real report: 13 slides, a
// divider before the nine resolved ones and one before the two outstanding. The tool lists 11
// findings (F1..F11, one per slide with a criterion); the fake merges F2 into F1 and F7 into F4 (the
// same element again), and F6 has a second problem (F6b): 10 findings, 8 verified fixed, 2 open.
// The fixture site: F1's search button still has no name (came back); F3..F9 and F6b are fixed
// (already fixed); F10's chart and F11's map, on the home page, have no text alternative (open).
const D = {
  search: 'FINDING F1 | Search button has no accessible name | /search | #search-btn | the magnifier button in the search bar | The magnifier button is announced only as button.',
  input: 'FINDING F3 | Search field label does not match | /search | #q | the search field | The search field is announced as Search terms.',
  logo: (tag) => `FINDING ${tag} | Footer logo text has too little contrast | / | footer img | the logo in the footer | The logo text is pale grey on white.`,
  home: 'FINDING F5 | Home link text has too little contrast | / | header a[href="/"] | the home link in the header | The home link is light grey.',
  footer: 'FINDING F6 | Footer text has too little contrast | / | footer p | the company name in the footer | The footer text is pale.',
  searchLink: 'FINDING F6 | Search link text has too little contrast | / | header a[href="/search"] | the search link in the header | The search link is pale too.',
  heading: 'FINDING F8 | Welcome heading is not marked up | / | main p | the welcome text on the home page | The welcome text is not in a table cell with a header.',
  results: 'FINDING F9 | Results heading is not associated | /search | main h1 | the heading of the search page | The search heading is not a table header.',
  chart: 'FINDING F10 | Chart series differ only by colour | / | #chart | the bar chart on the home page | The two series differ only by colour.',
  map: 'FINDING F11 | Map pins differ only by colour | / | #map | the map on the home page | The pin rings differ only by colour.',
};
export const DECK = [
  { divider: 'Resolved Issues' },
  { title: T5C, picture: true, body: caption(D.search), verdict: FIXED },
  { title: T5C, picture: true, body: caption(D.search), verdict: FIXED },
  { title: T5C, picture: true, body: caption(D.input), verdict: FIXED },
  { title: T13C, picture: true, body: caption(D.logo('F4')), verdict: FIXED },
  { title: T13C, picture: true, body: caption(D.home), verdict: FIXED },
  // Two problems on one slide.
  { title: T13C, picture: true, body: caption(D.footer, D.searchLink), verdict: FIXED },
  { title: T13C, picture: true, body: caption(D.logo('F4')), verdict: FIXED },
  // The two-column slide: the column on the left reads before the one on the right.
  { title: T14B, picture: true, body: [
    { x: 40, y: 440, size: 14, text: 'Left column, line one' }, { x: 40, y: 422, size: 14, text: 'Left column, line two' }, { x: 40, y: 404, size: 14, text: 'Left column, line three' },
    { x: 520, y: 440, size: 14, text: 'Right column, line one' }, { x: 520, y: 422, size: 14, text: 'Right column, line two' }, { x: 520, y: 404, size: 14, text: 'Right column, line three' },
    ...caption(D.heading),
  ], verdict: FIXED },
  // No verdict line: its status comes from the section ("Resolved Issues").
  { title: T14B, picture: true, body: caption(D.results), rotated: 'Screenshot from the staging site' },
  { divider: 'Outstanding Issues' },
  { title: T13A, picture: true, body: caption(D.chart), verdict: OPEN },
  { title: T13A, picture: true, body: caption(D.map), verdict: OPEN },
];

// The picture-only deck: two pages, each one screenshot and nothing else (a scan).
export const PICTURES_ONLY = [{ picture: true }, { picture: true }];

// ---- An encrypted PDF (RC4, 40-bit, revision 2, PDF 1.4 §3.5) with a user password.
const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...b) => createHash('md5').update(Buffer.concat(b)).digest();
function rc4(key, data) {
  const s = [...Array(256).keys()];
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const padded = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
export function encrypted(userPassword = 'tester', ownerPassword = 'owner') {
  const id = md5(Buffer.from('a11y-508 encrypted fixture'));
  const O = rc4(md5(padded(ownerPassword)).subarray(0, 5), padded(userPassword));
  const P = Buffer.alloc(4);
  P.writeInt32LE(-44);
  const key = md5(padded(userPassword), O, P, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (n) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
  const text = 'BT /F1 24 Tf 72 700 Td (Secret report) Tj ET';
  const content = rc4(objKey(4), Buffer.from(text, 'latin1')).toString('latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    { dict: '<< /Length %LEN% >>', stream: content },
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P -44 >>`,
  ];
  return build(objs, 1, { trailer: ` /Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>]` });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.argv.includes('--jpeg')) {
    const { spawnSync } = await import('node:child_process');
    mkdirSync(join(here, 'screens'), { recursive: true });
    for (let k = 1; k <= 12; k++) writeFileSync(join(here, 'screens', `screen-${k}.jpg`), spawnSync('cjpeg', ['-baseline', '-quality', '95', '-optimize'], { input: screenPpm(k) }).stdout);
  }
  // No criterion on any page: one finding per page, its first line the tester's words.
  const words = (f) => f.split(' | ').pop();
  writeFileSync(join(here, 'manual-findings.pdf'), pdf([[words(F1), F1], [words(F2), F2], [words(F3), F3]]));
  writeFileSync(join(here, 'no-findings.pdf'), pdf([['Manual accessibility test report - Example app', 'No accessibility problems were found.']]));
  writeFileSync(join(here, 'deck.pdf'), deck(DECK));
  writeFileSync(join(here, 'pictures-only.pdf'), deck(PICTURES_ONLY));
  writeFileSync(join(here, 'encrypted.pdf'), encrypted());
  // A download cut short: a linearized file's first-page cross-reference table comes before its
  // objects, and the file ends in the middle of it.
  writeFileSync(join(here, 'truncated.pdf'), Buffer.from('%PDF-1.4\n1 0 obj\n<< /Linearized 1 /L 23044 /H [ 620 140 ] /O 4 /E 9000 /N 13 /T 22800 >>\nendobj\nxref\n1 24\n0000000009 00000 n \n0000000110 00000 n \n00000', 'latin1'));
}
