// Screenshots in (docs/plans/screenshots-in.md): a person's screenshots, each with a one-line note of
// what is wrong in it, turned into the same parsed report the PDF parse writes (src/pdf-parse.mjs):
// one page per screenshot, the note as the page's text, the picture re-encoded to PNG at most 1600 px
// wide in the Chrome the tool already drives. From the read stage on the manual flow sees pages and
// pictures as it does for a PDF.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { launchChrome } from './chrome.mjs';
import { PAGE_WIDTH_PX } from './pdf-parse.mjs';

export const SOURCE = 'screenshots';
export const MAX_SHOTS = 40;
export const MAX_SHOT_BYTES = 10 * 1024 * 1024;
export const MAX_NOTE = 300;
export const SHOTS_DIR = 'shots';
export const NOTES_FILE = 'notes.json';
// The refusals, each one sentence that says the limits.
export const NOT_A_SHOT = 'That is not a screenshot: only PNG, JPEG or WebP pictures can be added, at most 40 of them, 10 MB each.';
export const TOO_MANY_SHOTS = 'That is more than 40 screenshots: add at most 40 of them, 10 MB each.';
export const SHOT_TOO_BIG = 'That screenshot is larger than 10 MB: add at most 40 screenshots, 10 MB each.';
export const NO_SHOTS = 'There are no screenshots here: add PNG, JPEG or WebP pictures, at most 40 of them, 10 MB each.';

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

// 'png' | 'jpeg' | 'webp' by the file's first bytes, or null.
export function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// The one sentence that refuses a list of screenshots ([{ bytes }]), or null when it is fine.
export function shotsProblem(list) {
  if (!list || !list.length) return NO_SHOTS;
  if (list.length > MAX_SHOTS) return TOO_MANY_SHOTS;
  if (list.some((s) => s.bytes.length > MAX_SHOT_BYTES)) return SHOT_TOO_BIG;
  if (list.some((s) => !imageType(s.bytes))) return NOT_A_SHOT;
  return null;
}

// A note: one line, at most 300 characters.
export const cleanNote = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '');
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The screenshots of a run, kept in its folder in the order they were added: shots/01.png, ... and
// notes.json ({ shots: [{ file, name, note }] }). list: [{ bytes, name, note }].
export function storeShots(dir, list) {
  mkdirSync(join(dir, SHOTS_DIR), { recursive: true });
  const shots = list.map((s, i) => {
    const file = `${SHOTS_DIR}/${pad(i + 1)}.${EXT[imageType(s.bytes)] || 'png'}`;
    writeFileSync(join(dir, file), s.bytes);
    return { file, name: basename(String(s.name || '')) || null, note: cleanNote(s.note) };
  });
  writeFileSync(join(dir, NOTES_FILE), JSON.stringify({ shots }, null, 2) + '\n');
  return shots;
}
// What storeShots kept, or null when the folder holds no screenshots of a run.
export function storedShots(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, NOTES_FILE), 'utf8'));
    return Array.isArray(j.shots) && j.shots.length ? j.shots : null;
  } catch {
    return null;
  }
}

// A folder of screenshots for the CLI (AC 6): its PNG, JPEG and WebP files in name order, with the
// notes of an optional notes.txt ("<file name>: <note>" per line). Returns [{ bytes, name, note }].
export function readShotFolder(dir) {
  const notes = new Map();
  if (existsSync(join(dir, 'notes.txt'))) {
    for (const line of readFileSync(join(dir, 'notes.txt'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
      if (m) notes.set(m[1], m[2]);
    }
  }
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((f) => ({ bytes: readFileSync(join(dir, f)), name: f, note: notes.get(f) || '' }));
}

// report.md for screenshots (AC 3).
export function screenshotsReport(m) {
  const pages = m.pages || [];
  const noted = pages.filter((p) => (p.lines || []).length).length;
  const out = [[
    '# The screenshots, with the notes of the person who took them',
    `${plural(m.pageCount, 'screenshot')}, with a note on ${noted} of them.`,
    'Below, one block per screenshot: the picture, then what the person wrote about it.',
  ].join('\n'), ''];
  for (const p of pages) {
    const b = [`## Screenshot ${p.n} of ${m.pageCount}`, `Picture of the page: ${p.picture}`];
    if ((p.lines || []).length) b.push('Note from the person who took it:', ...p.lines.map((l) => `> ${l}`));
    else b.push('Note: none (a picture only)');
    out.push(b.join('\n'), '');
  }
  return out.join('\n');
}

const PAGE = String.raw`<!doctype html><meta charset="utf-8"><title>screenshots</title><script>
window.__shot = async (n, max) => {
  const img = new Image();
  img.src = '/shot/' + n;
  try { await img.decode(); } catch { return { error: 'the picture could not be decoded' }; }
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return { error: 'the picture is empty' };
  const s = Math.min(1, max / w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { width: c.width, height: c.height, png: c.toDataURL('image/png').slice('data:image/png;base64,'.length) };
};
window.__ready = true;
</script>`;

// One-shot server on 127.0.0.1: the page and the screenshots, nothing else.
function serve(files) {
  const { createServer } = createRequire(import.meta.url)('node:http');
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const m = /^\/shot\/(\d+)$/.exec(path);
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (path === '/') return send(200, 'text/html', PAGE);
    if (m && files[Number(m[1]) - 1]) {
      const bytes = readFileSync(files[Number(m[1]) - 1]);
      return send(200, MIME[imageType(bytes)] || 'application/octet-stream', bytes);
    }
    send(404, 'text/plain', 'not found');
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

// Writes the parse of the screenshots into outDir: pages/page-NN.png, manifest.json and report.md
// (AC 3), and resolves the manifest. shots, in order: paths, or [{ path, file (as the run keeps it),
// name, note }]; notes: the notes in the same order, when they are not on the shots.
export async function parseScreenshots({ shots: given, notes = null, outDir, chromePath = null }) {
  const shots = given.map((s, i) => {
    const o = typeof s === 'string' ? { path: s, file: basename(s), name: basename(s) } : { ...s };
    if (Array.isArray(notes) && notes[i] != null) o.note = notes[i];
    return o;
  });
  const files = shots.map((s) => s.path);
  const { server, port } = await serve(files);
  let browser = null;
  try {
    browser = await launchChrome({ chromePath: chromePath || undefined, viewport: { width: 1280, height: 800 }, headless: true });
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
      if (i > 300) throw new Error('the page that reads the screenshots did not load');
      await new Promise((r) => setTimeout(r, 100));
    }
    mkdirSync(join(outDir, 'pages'), { recursive: true });
    const pages = [];
    for (const [i, s] of shots.entries()) {
      const n = i + 1;
      const r = await session.evaluate(`window.__shot(${n}, ${PAGE_WIDTH_PX})`);
      if (!r || r.error) throw new Error(`screenshot ${n} could not be read: ${(r && r.error) || 'no answer'}`);
      const picture = `pages/page-${pad(n)}.png`;
      writeFileSync(join(outDir, picture), Buffer.from(r.png, 'base64'));
      const note = cleanNote(s.note);
      pages.push({
        n, width: r.width, height: r.height, section: null, divider: false, status: null, criteria: [], wcag: [], text: [], blocks: note ? [{ rotated: false, lines: [note] }] : [],
        lines: note ? [note] : [], images: [], imagesSkipped: 0, picture, truncated: false,
      });
    }
    const manifest = {
      file: SOURCE, source: SOURCE, pageCount: pages.length, parsed: pages.length, parsedAt: new Date().toISOString(), dividers: [],
      shots: shots.map((s) => ({ file: s.file, ...(s.name ? { name: s.name } : {}), note: cleanNote(s.note) })), pages, notes: [],
    };
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(outDir, 'report.md'), screenshotsReport(manifest));
    return manifest;
  } finally {
    if (browser) await browser.close({ fast: true }).catch(() => {});
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(() => r()));
  }
}

// The run folder's stored screenshots, parsed into <dir>/<parsedDir>.
export function parseStored(dir, parsedDir, chromePath = null) {
  const shots = (storedShots(dir) || []).map((s) => ({ ...s, path: join(dir, ...s.file.split('/')) }));
  return parseScreenshots({ shots, outDir: parsedDir, chromePath });
}
