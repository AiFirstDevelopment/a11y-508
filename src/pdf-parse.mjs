// The tester's PDF, parsed first (docs/plans/pdf-parse.md): exact pages, text in reading order, the
// facts a pattern can recognise (criterion, WCAG, status, date, section), a picture of every page and
// each embedded picture on its own, written as one plain report.md the assistant reads instead of
// the PDF, and manifest.json, the same as data.
//
// The parse runs in the Chrome the tool already drives, with pdf.js vendored under src/vendor/pdfjs
// (nothing is installed, nothing is fetched): a one-shot HTTP server on 127.0.0.1 serves pdf.js and
// the PDF to one headless page, and the results come back over the DevTools Protocol. The code from
// src/vendor/ only ever runs inside that page. Reading order, the recognisers and the writers are
// pure functions below, so the node tests cover them without a browser.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';
import { CATALOG } from './checks/catalog.mjs';

export const PDFJS_DIR = resolve(fileURLToPath(new URL('./vendor/pdfjs', import.meta.url)));
export const pdfjsVersion = () => readFileSync(join(PDFJS_DIR, 'VERSION'), 'utf8').trim();
export const PAGE_WIDTH_PX = 1600;
export const MAX_PAGES = 300;
export const TIME_LIMIT = 5 * 60 * 1000;
export const MIN_IMAGE = 32;
export const MAX_IMAGES = 20;
export const REPEATED_ON = 3;

const r4 = (v) => Math.round(v * 10000) / 10000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- Text: normalising, lines, blocks, reading order.

// Ligatures and non-breaking spaces normalised, runs of whitespace collapsed; dashes kept.
export function normalizeText(s) {
  return String(s || '')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ|ﬆ/g, 'st')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ');
}

// Bold from the font's name (Bold, Black, Semibold, Heavy) or its weight.
export const isBoldFont = (name, weight = 0) => /bold|black|heavy|semibold|demibold/i.test(String(name || '')) || Number(weight) >= 600;

// items: [{ text, x, y (baseline), w, size, bold, angle }] in page points, y down from the top.
// Returns { blocks: [{ lines: [{ text, x, y, w, size, bold }], rotated }], lines: [string] }: items on
// one baseline (within half the font size) are a line, split where a gap is wider than three times
// the size (two columns); lines are a block while the gap is under 1.5× the size and the left edges
// are within 2% of the page width; blocks that overlap vertically read left to right, rows of
// blocks top to bottom; rotated text (±90°) is its own block at the end.
export function readingOrder(items, { width = 612 } = {}) {
  const flat = [];
  const turned = [];
  for (const it of items || []) {
    const text = normalizeText(it.text);
    if (!text.trim()) continue;
    const a = Math.abs(((Number(it.angle) || 0) + 360) % 360);
    const rotated = (a > 45 && a < 135) || (a > 225 && a < 315);
    (rotated ? turned : flat).push({ ...it, text });
  }
  const toLines = (list, along, across) => {
    const sorted = [...list].sort((p, q) => across(p) - across(q) || along(p) - along(q));
    const rows = [];
    for (const it of sorted) {
      const row = rows.find((r) => Math.abs(across(r.items[0]) - across(it)) <= Math.max(r.items[0].size, it.size) / 2);
      if (row) row.items.push(it);
      else rows.push({ items: [it] });
    }
    const lines = [];
    for (const r of rows) {
      const its = r.items.sort((p, q) => along(p) - along(q));
      let cur = null;
      for (const it of its) {
        const size = it.size || 10;
        const gap = cur ? along(it) - cur.end : 0;
        if (!cur || gap > 3 * Math.max(size, cur.size)) {
          cur = { parts: [it.text], x: it.x, y: it.y, start: along(it), end: along(it) + (it.w || 0), size, bold: !!it.bold, boldAll: !!it.bold, across: across(it) };
          lines.push(cur);
          continue;
        }
        const prev = cur.parts[cur.parts.length - 1];
        const space = gap > 0.15 * size && !/\s$/.test(prev) && !/^\s/.test(it.text);
        cur.parts.push(space ? ` ${it.text}` : it.text);
        cur.end = Math.max(cur.end, along(it) + (it.w || 0));
        cur.size = Math.max(cur.size, size);
        cur.boldAll = cur.boldAll && !!it.bold;
      }
    }
    return lines.map((l) => ({ text: normalizeText(l.parts.join('')).trim(), x: l.x, y: l.y, w: l.end - l.start, size: l.size, bold: l.boldAll, across: l.across, start: l.start })).filter((l) => l.text);
  };
  const lines = toLines(flat, (it) => it.x, (it) => it.y);
  // Blocks.
  const blocks = [];
  for (const l of [...lines].sort((p, q) => p.y - q.y || p.x - q.x)) {
    const b = blocks.find((k) => {
      const last = k.lines[k.lines.length - 1];
      const gap = l.y - l.size - last.y;
      return gap < 1.5 * Math.max(last.size, l.size) && gap > -last.size && Math.abs(l.x - last.x) <= 0.02 * width;
    });
    if (b) b.lines.push(l);
    else blocks.push({ lines: [l] });
  }
  for (const b of blocks) {
    b.top = Math.min(...b.lines.map((l) => l.y - l.size));
    b.bottom = Math.max(...b.lines.map((l) => l.y));
    b.left = Math.min(...b.lines.map((l) => l.x));
  }
  // Rows of blocks that overlap vertically, top to bottom; in a row, left to right.
  const rows = [];
  for (const b of [...blocks].sort((p, q) => p.top - q.top || p.left - q.left)) {
    const row = rows[rows.length - 1];
    if (row && b.top < row.bottom) {
      row.blocks.push(b);
      row.bottom = Math.max(row.bottom, b.bottom);
    } else rows.push({ blocks: [b], bottom: b.bottom });
  }
  const ordered = rows.flatMap((r) => r.blocks.sort((p, q) => p.left - q.left || p.top - q.top));
  for (const b of ordered) joinHyphens(b.lines);
  const out = ordered.map((b) => ({ lines: b.lines.map(({ text, x, y, w, size, bold }) => ({ text, x, y, w, size, bold })), rotated: false }));
  // Rotated text: one block at the end, lines across the page, each read along its baseline.
  if (turned.length) {
    const up = (it) => -it.y;
    const rl = toLines(turned, up, (it) => it.x);
    rl.sort((p, q) => p.across - q.across);
    out.push({ lines: rl.map(({ text, x, y, w, size, bold }) => ({ text: `${text} (rotated)`, x, y, w, size, bold })), rotated: true });
  }
  return { blocks: out.filter((b) => b.lines.length), lines: out.flatMap((b) => b.lines.map((l) => l.text)) };
}

// A word split by a hyphen at a line end is joined: the next line's first word moves up.
function joinHyphens(lines) {
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (!/[A-Za-z][-­]$/.test(a.text) || !/^[a-z]/.test(b.text)) continue;
    const m = /^(\S+)\s*(.*)$/.exec(b.text);
    a.text = a.text.slice(0, -1) + m[1];
    b.text = m[2];
    if (!b.text) {
      lines.splice(i + 1, 1);
      i--;
    }
  }
}

// ---- The recognisers: optional, template-free. Each adds a field when its pattern is there.

const FIXED_RE = /\b(verified fixed|no longer an issue|remediated|resolved|closed|passed|fixed|pass)\b/i;
const OPEN_RE = /\b(still an issue|not fixed|outstanding|unresolved|regressed|remains|failed|fails|fail|open)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b|\b(\d{4})-(\d{2})-(\d{2})\b|\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? (\d{1,2}),? (\d{4})\b/i;
const pad2 = (n) => String(n).padStart(2, '0');

// A date in the line, as ISO (yyyy-mm-dd), and the text it matched; null when there is none.
export function findDate(line) {
  const m = DATE_RE.exec(String(line || ''));
  if (!m) return null;
  let y;
  let mo;
  let d;
  if (m[1]) [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3].length === 2 ? `20${m[3]}` : m[3])];
  else if (m[4]) [y, mo, d] = [Number(m[4]), Number(m[5]), Number(m[6])];
  else [mo, d, y] = [MONTHS.indexOf(m[7].slice(0, 3).toLowerCase()) + 1, Number(m[8]), Number(m[9])];
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return { iso: `${y}-${pad2(mo)}-${pad2(d)}`, text: m[0] };
}

// 'fixed' | 'open' for the words, the earliest match first (and the longer at the same place), or null.
export function statusWord(text) {
  const f = FIXED_RE.exec(text);
  const o = OPEN_RE.exec(text);
  if (!f && !o) return null;
  if (f && (!o || f.index < o.index || (f.index === o.index && f[0].length >= o[0].length))) return 'fixed';
  return 'open';
}

// The page's status line: the first line with a verdict's words and at most 8 words besides its date.
export function recogniseStatus(lines) {
  for (const line of lines || []) {
    const value = statusWord(line);
    if (!value) continue;
    const date = findDate(line);
    const rest = date ? line.replace(date.text, ' ') : line;
    const words = rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (words.length > 8) continue;
    return { value, words: line.trim(), date: date ? date.iso : null, source: 'text' };
  }
  return null;
}

const CRITERION_RE = /^(\d{1,2}\.[A-Z])\b\s*(.*)$/;
const WCAG_RE = /\b[1-4]\.\d{1,2}\.\d{1,2}\b/g;
export function recogniseCriteria(lines) {
  const out = [];
  for (const line of lines || []) {
    const m = CRITERION_RE.exec(line);
    if (!m || out.some((c) => c.id === m[1])) continue;
    const known = CATALOG[m[1]];
    if (known) out.push({ id: m[1], name: known.name, wcag: known.wcag, source: 'catalog' });
    else out.push({ id: m[1], name: m[2].trim(), wcag: (m[2].match(WCAG_RE) || [null])[0], source: 'text' });
  }
  return out;
}
export const recogniseWcag = (lines) => [...new Set((lines || []).flatMap((l) => l.match(WCAG_RE) || []))];

const wordsOf = (s) => String(s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

// Every page's facts, in place: criteria, wcag, status, and the section dividers (a page whose text is
// one block of at most 6 words, no picture, no criterion) whose words are the section of the pages
// after it; a page with no status line of its own in a section named for a status takes the section's.
export function recognise(pages) {
  let section = null;
  const dividers = [];
  for (const p of pages) {
    p.criteria = recogniseCriteria(p.lines);
    p.wcag = recogniseWcag(p.lines);
    const plain = (p.blocks || []).filter((b) => !b.rotated);
    const words = plain.flatMap((b) => b.lines.flatMap((l) => wordsOf(l.text)));
    p.divider = plain.length === 1 && words.length > 0 && words.length <= 6 && !(p.images || []).length && !p.criteria.length;
    if (p.divider) {
      section = plain[0].lines.map((l) => l.text).join(' ');
      dividers.push(p.n);
      p.section = section;
      p.status = null;
      continue;
    }
    p.section = section;
    p.status = recogniseStatus(p.lines);
    if (!p.status && section) {
      const v = statusWord(section);
      if (v) p.status = { value: v, words: section, date: null, source: 'section' };
    }
  }
  return dividers;
}

// ---- The writers.

const pct = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));
const listPages = (ns) => (ns.length <= 1 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

export function reportMarkdown(m) {
  const pages = m.pages || [];
  const withText = pages.filter((p) => p.lines.length).length;
  const withPictures = pages.filter((p) => p.images.length).length;
  const head = [
    `# The tester's PDF, parsed: ${m.file}`,
    `${plural(m.pageCount, 'page')}: ${withText} with text, ${withPictures} with pictures.`,
    m.dividers.length ? `Section dividers: ${m.dividers.length === 1 ? 'page' : 'pages'} ${listPages(m.dividers)}.` : 'Section dividers: none.',
    'Below, one block per page: the facts the tool read on it, a picture of the page, and its text in reading order.',
  ];
  if (!withText && pages.length) head.push('The PDF has no text: every page is a picture only.');
  for (const n of m.notes || []) head.push(n);
  const out = [head.join('\n'), ''];
  for (const p of pages) {
    const b = [`## Page ${p.n} of ${m.pageCount}`];
    if (p.divider) b.push(`Section: ${p.section} (a section divider)`);
    else if (p.section) b.push(`Section: ${p.section}`);
    if (p.status) b.push(p.status.source === 'section' ? `Status: ${p.status.value} — from the section "${p.status.words}"` : `Status: ${p.status.value} — "${p.status.words}"${p.status.date ? ` (${p.status.date})` : ''}`);
    for (const c of p.criteria) b.push(`Criterion: ${c.id} ${c.name}${c.wcag ? ` (WCAG ${c.wcag})` : ''}`);
    if (p.picture) b.push(`Picture of the page: ${p.picture}`);
    if (p.images.length) b.push(`Pictures on the page: ${p.images.map((im) => `${im.file} (${im.width}×${im.height}, at ${pct(im.x)}–${pct(im.x + im.w)}% across, ${pct(im.y)}–${pct(im.y + im.h)}% down)`).join('; ')}`);
    if (p.imagesSkipped) b.push(`Pictures left out: ${p.imagesSkipped} (small, repeated on ${REPEATED_ON} or more pages, or past the ${MAX_IMAGES}th)`);
    b.push('');
    if (p.lines.length) b.push('Text, in reading order:', ...p.lines.map((l) => `> ${l}`));
    else b.push('Text: none (a picture only)');
    out.push(b.join('\n'), '');
  }
  return out.join('\n');
}

// ---- The parse, in the page.

// What runs in the page (served as /parse.mjs): pdf.js opens /source.pdf; open() counts the pages and
// those that paint a picture; page(n) gives the text items, the page picture and each embedded image.
const PAGE_SCRIPT = String.raw`
import * as pdfjs from '/pdfjs/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
const warnings = [];
const warn = console.warn.bind(console);
console.warn = (...a) => { warnings.push(a.map(String).join(' ')); if (warnings.length > 50) warnings.shift(); warn(...a); };
let doc = null;
const IMAGE_OPS = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject]);
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const objOf = (page, id) => new Promise((ok) => {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  const t = setTimeout(() => ok(null), 15000);
  try { store.get(id, (v) => { clearTimeout(t); ok(v || null); }); } catch { clearTimeout(t); ok(null); }
});
function hash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function toCanvas(img) {
  const w = img.width, h = img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (img.bitmap) { ctx.drawImage(img.bitmap, 0, 0); return c; }
  if (!img.data) return null;
  const out = ctx.createImageData(w, h);
  const d = img.data, o = out.data;
  if (img.kind === pdfjs.ImageKind.RGBA_32BPP) o.set(d.subarray(0, o.length));
  else if (img.kind === pdfjs.ImageKind.RGB_24BPP) { for (let i = 0, j = 0; j < o.length; i += 3, j += 4) { o[j] = d[i]; o[j + 1] = d[i + 1]; o[j + 2] = d[i + 2]; o[j + 3] = 255; } }
  else if (img.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
    const row = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = (d[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0; const j = (y * w + x) * 4; o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255; }
  } else return null;
  ctx.putImageData(out, 0, 0);
  return c;
}
const b64 = (c) => c.toDataURL('image/png').slice('data:image/png;base64,'.length);
function plain(e) {
  const n = String((e && e.name) || '');
  if (n === 'PasswordException') return 'it is protected by a password';
  if (n === 'InvalidPDFException') return 'it is damaged or incomplete';
  if (n === 'MissingPDFException') return 'the file could not be read';
  return String((e && e.message) || e || 'unknown reason');
}
window.__parse = {
  async open(maxPages) {
    try {
      doc = await pdfjs.getDocument({ url: '/source.pdf', cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', isEvalSupported: false, enableXfa: false, useSystemFonts: false, stopAtErrors: false }).promise;
    } catch (e) {
      return { error: plain(e) };
    }
    const n = Math.min(doc.numPages, maxPages);
    let withPictures = 0;
    for (let i = 1; i <= n; i++) {
      try {
        const page = await doc.getPage(i);
        const ops = await page.getOperatorList();
        if (ops.fnArray.some((f) => IMAGE_OPS.has(f))) withPictures++;
      } catch {}
    }
    if (!doc.numPages) return { error: 'it has no pages' };
    return { numPages: doc.numPages, withPictures, version: pdfjs.version };
  },
  async page(n, widthPx) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    // The page picture: rendered, with every shape drawn over the screenshots.
    const scale = widthPx / vp.width;
    const big = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(big.width);
    canvas.height = Math.round(big.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let renderError = null;
    try { await page.render({ canvas, canvasContext: ctx, viewport: big }).promise; } catch (e) { renderError = String((e && e.message) || e); }
    // The text, with each item's place on the page and its font.
    const tc = await page.getTextContent();
    const fonts = {};
    for (const it of tc.items) {
      if (!it.fontName || it.fontName in fonts) continue;
      let name = '';
      try { if (page.commonObjs.has(it.fontName)) { const f = page.commonObjs.get(it.fontName); name = (f && (f.name || f.loadedName)) || ''; if (f && f.bold) name += ' Bold'; if (f && f.black) name += ' Black'; } } catch {}
      fonts[it.fontName] = name;
    }
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
      items.push({ text: it.str, x: t[4], y: t[5], w: it.width, size, font: fonts[it.fontName] || '', angle: Math.atan2(t[1], t[0]) * 180 / Math.PI });
    }
    // The embedded pictures, in paint order, with the box each is painted in.
    const ops = await page.getOperatorList();
    const images = [];
    const failures = [];
    let small = 0, over = 0;
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === pdfjs.OPS.save) stack.push(ctm);
      else if (fn === pdfjs.OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, args);
      else if (fn === pdfjs.OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]); else if (args[0] && args[0].length === 6) ctm = mul(ctm, Array.from(args[0])); }
      else if (fn === pdfjs.OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (IMAGE_OPS.has(fn)) {
        const img = fn === pdfjs.OPS.paintInlineImageXObject ? args[0] : await objOf(page, args[0]);
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => vp.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
        const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
        const box = { x: Math.min(...xs) / vp.width, y: Math.min(...ys) / vp.height, w: (Math.max(...xs) - Math.min(...xs)) / vp.width, h: (Math.max(...ys) - Math.min(...ys)) / vp.height };
        const c = img && img.width && img.height ? toCanvas(img) : null;
        if (!c) { failures.push(warnings.slice(-1)[0] || 'pdf.js could not decode it'); continue; }
        if (c.width < 32 || c.height < 32) { small++; continue; }
        if (images.length >= 20) { over++; continue; }
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        images.push({ hash: hash(px) + '-' + c.width + 'x' + c.height, width: c.width, height: c.height, ...box, png: b64(c) });
      }
    }
    return { n, width: vp.width, height: vp.height, items, picture: b64(canvas), pictureWidth: canvas.width, pictureHeight: canvas.height, images, small, over, failures, renderError };
  },
};
window.__ready = true;
`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.json': 'application/json' };

// One-shot server on 127.0.0.1 (a random port): the page, pdf.js and the PDF; nothing else.
function serve(pdfBytes) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (path === '/') return send(200, 'text/html', '<!doctype html><meta charset="utf-8"><title>parse</title><script type="module" src="/parse.mjs"></script>');
    if (path === '/parse.mjs') return send(200, 'text/javascript', PAGE_SCRIPT);
    if (path === '/source.pdf') return send(200, 'application/pdf', pdfBytes);
    if (path.startsWith('/pdfjs/')) {
      const file = normalize(join(PDFJS_DIR, path.slice('/pdfjs/'.length)));
      if (file.startsWith(PDFJS_DIR + sep) && existsSync(file)) {
        try {
          return send(200, TYPES[extname(file)] || 'application/octet-stream', readFileSync(file));
        } catch {}
      }
    }
    send(404, 'text/plain', 'not found');
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

export class PdfUnreadable extends Error {
  constructor(reason) {
    super(`The PDF could not be opened: ${reason}.`);
    this.reason = reason;
    this.unreadable = true;
  }
}

const pageName = (n, m) => `page-${String(n).padStart(Math.max(2, String(m).length), '0')}`;

// Parses file into outDir (manifest.json, report.md, pages/*.png) and resolves the manifest.
// onOpened({ pages, withPictures }): the first pass's counts, before anything is rendered.
// Throws PdfUnreadable when pdf.js cannot open the file.
export async function parsePdf({ file, outDir, chromePath, log = null, maxPages, timeLimit, onOpened = null }) {
  const cap = Number(maxPages || process.env.A11Y_508_PDF_MAX_PAGES) > 0 ? Math.floor(Number(maxPages || process.env.A11Y_508_PDF_MAX_PAGES)) : MAX_PAGES;
  const limit = Number(timeLimit || process.env.A11Y_508_PDF_TIME_LIMIT) > 0 ? Number(timeLimit || process.env.A11Y_508_PDF_TIME_LIMIT) : TIME_LIMIT;
  const started = Date.now();
  const bytes = readFileSync(file);
  const { server, port } = await serve(bytes);
  let browser = null;
  try {
    browser = await launchChrome({ chromePath, viewport: { width: 1280, height: 800 }, headless: true });
    const session = await browser.newPage();
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; ; i++) {
      let ready = false;
      try {
        ready = await session.evaluate('!!window.__ready', { timeout: 5000 });
      } catch {}
      if (ready) break;
      if (i > 300) throw new Error('the parsing page did not load');
      await new Promise((r) => setTimeout(r, 100));
    }
    const left = () => limit - (Date.now() - started);
    const opened = await session.evaluate(`window.__parse.open(${cap})`, { timeout: Math.max(1000, left()) });
    if (opened.error) throw new PdfUnreadable(opened.error);
    const total = opened.numPages;
    const want = Math.min(total, cap);
    if (onOpened) onOpened({ pages: want, total, withPictures: opened.withPictures });
    const notes = [];
    const raw = [];
    for (let n = 1; n <= want; n++) {
      if (left() <= 0) break;
      try {
        raw.push(await session.evaluate(`window.__parse.page(${n}, ${PAGE_WIDTH_PX})`, { timeout: Math.max(1000, left()) }));
      } catch (e) {
        if (left() <= 0) break;
        notes.push(`Page ${n} could not be parsed: ${e.message}.`);
        raw.push({ n, width: 0, height: 0, items: [], picture: null, images: [], small: 0, over: 0, failures: [], failed: true });
      }
    }
    if (want < total) notes.unshift(`Stopped after ${want} pages; the PDF has ${total}.`);
    if (raw.length < want) notes.unshift(`Stopped at the time limit (${Math.round(limit / 60000) || 1} min): ${raw.length ? `pages ${raw.length + 1}–${want}` : 'every page'} not parsed.`);
    // Pictures repeated on REPEATED_ON or more pages are logos and bullets, not screenshots.
    const seenOn = new Map();
    for (const p of raw) for (const h of new Set(p.images.map((im) => im.hash))) seenOn.set(h, (seenOn.get(h) || 0) + 1);
    mkdirSync(join(outDir, 'pages'), { recursive: true });
    const pages = raw.map((p) => {
      const name = pageName(p.n, total);
      const keep = p.images.filter((im) => seenOn.get(im.hash) < REPEATED_ON);
      const W = p.width || 1;
      const H = p.height || 1;
      const items = p.items.map((it) => ({ ...it, bold: isBoldFont(it.font) }));
      const order = readingOrder(items, { width: W });
      for (const f of p.failures) notes.push(`Page ${p.n}: a picture could not be decoded (${f}); the picture of the page still shows it.`);
      if (p.renderError) notes.push(`Page ${p.n}: the picture of the page is incomplete (${p.renderError}).`);
      let picture = null;
      if (p.picture) {
        picture = `pages/${name}.png`;
        writeFileSync(join(outDir, picture), Buffer.from(p.picture, 'base64'));
      }
      const images = keep.map((im, k) => {
        const f = `pages/${name}-image-${k + 1}.png`;
        writeFileSync(join(outDir, f), Buffer.from(im.png, 'base64'));
        return { file: f, width: im.width, height: im.height, x: r4(im.x), y: r4(im.y), w: r4(im.w), h: r4(im.h) };
      });
      return {
        n: p.n, width: r4(W), height: r4(H), section: null, divider: false, status: null, criteria: [], wcag: [],
        text: items.map((it) => ({ text: normalizeText(it.text), x: r4(it.x / W), y: r4((it.y - it.size) / H), w: r4((it.w || 0) / W), h: r4(it.size / H), size: r4(it.size), bold: it.bold })),
        blocks: order.blocks, lines: order.lines, images, imagesSkipped: (p.small || 0) + (p.over || 0) + (p.images.length - keep.length), picture, truncated: false,
      };
    });
    const dividers = recognise(pages);
    const manifest = {
      file: basename(file), pageCount: total, parsed: pages.length, parsedAt: new Date().toISOString(), pdfjs: opened.version || pdfjsVersion(), dividers,
      pages: pages.map(({ blocks, ...p }) => ({ ...p, truncated: false, blocks: blocks.map((b) => ({ rotated: b.rotated, lines: b.lines.map((l) => l.text) })) })),
      notes,
    };
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(outDir, 'report.md'), reportMarkdown(manifest));
    if (log && log.debug) log.debug(`parsed ${pages.length} of ${total} pages in ${Date.now() - started} ms`);
    return manifest;
  } finally {
    if (browser) await browser.close({ fast: true }).catch(() => {});
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(() => r()));
  }
}

// The header of report.md (its lines before the first page), and one line per page, for the CLI.
export function summaryLines(m) {
  const md = reportMarkdown(m);
  const head = md.split('\n## ')[0].trim().split('\n');
  const per = m.pages.map((p) => `page ${p.n}: ${[p.divider ? `divider "${p.section}"` : null, p.status ? p.status.value : null, ...p.criteria.map((c) => c.id), plural(p.images.length, 'picture'), plural(p.lines.length, 'line')].filter(Boolean).join(', ')}`);
  return [...head, ...per];
}
