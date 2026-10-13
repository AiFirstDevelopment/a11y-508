// Does the working directory hold the app's code? Distinctive pieces of the latest report's
// findings (element ids, class names, aria-label values, visible text) are looked for in the
// folders the Fix loop would edit. None found means the loop is about to run against the wrong
// repository (the tool's own, say), where every fix would be a guess.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const MAX_TOKENS = 20;
const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024;
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.angular', '.next', 'coverage', 'a11y-508-work', 'a11y-508-report', 'a11y-508-history']);
const TEXT_FILES = /\.(html?|[cm]?[jt]sx?|vue|svelte|astro|css|scss|sass|less|json|cshtml|razor|jsp|erb|hbs|handlebars|php|ejs|pug|twig|liquid|njk|py|rb|java|cs|go|xml|md)$/i;
// Words too common to tell one app from another.
const COMMON = new Set(['container', 'content', 'wrapper', 'button', 'header', 'footer', 'main', 'nav', 'navbar', 'active', 'hidden', 'disabled', 'row', 'col', 'btn', 'link', 'icon', 'image', 'title', 'label', 'input', 'form', 'table', 'list', 'item', 'text', 'small', 'large', 'primary', 'secondary', 'selected', 'show', 'open', 'close', 'clearfix', 'sr-only', 'visually-hidden']);

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// The tokens of one finding, most distinctive kinds first.
export function tokensOf(f) {
  const html = typeof f.html === 'string' ? f.html : '';
  const selector = typeof f.selector === 'string' ? f.selector : '';
  const out = [];
  const add = (kind, value) => {
    const v = squash(decode(String(value || '')));
    if (COMMON.has(v.toLowerCase())) return;
    if (kind === 'text') {
      // Visible text: 8 characters or more, and more than one word.
      if (v.length < 8 || !/\S\s+\S/.test(v)) return;
    } else {
      // Framework-generated ids and classes (ng-tns-c12-3, css-1x2y3z, _ngcontent-abc) say nothing about the source.
      if (/^(ng-|_ng|css-|sc-|jsx-|svelte-|v-)|\d{3,}/.test(v)) return;
      // A plain word ("name", "phone") is in every codebase: a compound name (main-nav, searchBox,
      // results_2) or several words (an aria-label) is distinctive.
      const compound = /[-_\d]/.test(v) || /[a-z][A-Z]/.test(v) || /\S\s+\S/.test(v);
      if (v.length < 6 || !compound) return;
    }
    out.push({ kind, value: v });
  };
  for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) add('id', m[1]);
  for (const m of selector.matchAll(/#([A-Za-z][\w-]*)/g)) add('id', m[1]);
  for (const m of html.matchAll(/\baria-label\s*=\s*["']([^"']+)["']/gi)) add('aria-label', m[1]);
  const text = squash(decode(html.replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ')));
  for (const chunk of text.split(/\s{2,}|[|•·]/)) {
    const t = squash(chunk).replace(/(…|\.\.\.)$/, '').trim();
    if (t.length >= 8) add('text', t.slice(0, 40).trim());
  }
  for (const m of html.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) for (const c of m[1].split(/\s+/)) add('class', c);
  for (const m of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) add('class', m[1]);
  return out;
}

export function matchTokens(report) {
  const findings = [...((report && report.pages) || []).flatMap((p) => p.findings || []), ...((report && report.site && report.site.findings) || [])];
  const order = { id: 0, 'aria-label': 1, text: 2, class: 3 };
  const seen = new Set();
  const all = [];
  for (const f of findings) {
    for (const t of tokensOf(f)) {
      if (seen.has(t.value)) continue;
      seen.add(t.value);
      all.push(t);
    }
  }
  // Ids, labels and text before class names; longer before shorter within a kind.
  all.sort((a, b) => order[a.kind] - order[b.kind] || b.value.length - a.value.length);
  return all.slice(0, MAX_TOKENS);
}

function sourceFiles(cwd, dirs) {
  const files = [];
  const walk = (dir) => {
    if (files.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name));
      } else if (e.isFile() && TEXT_FILES.test(e.name)) files.push(join(dir, e.name));
    }
  };
  for (const d of dirs) walk(join(cwd, d));
  return files;
}

// { checked, found, examples: [{ token, kind, file }] } for the latest report against the source folders.
export function matchSource(cwd, report, sourceDirs) {
  const tokens = matchTokens(report);
  if (!tokens.length) return { checked: 0, found: 0, examples: [] };
  const left = new Map(tokens.map((t) => [t.value, t]));
  const hits = [];
  for (const file of sourceFiles(cwd, sourceDirs)) {
    if (!left.size) break;
    let text;
    try {
      if (statSync(file).size > MAX_BYTES) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const flat = squash(decode(text));
    for (const [value, t] of left) {
      if (text.includes(value) || (t.kind === 'text' && flat.includes(value))) {
        hits.push({ token: value, kind: t.kind, file: relative(cwd, file).split('\\').join('/') });
        left.delete(value);
      }
    }
  }
  return { checked: tokens.length, found: hits.length, examples: hits.slice(0, 5) };
}

// Where one finding's markup is in the source: every line under the source folders that holds one of
// its distinctive literals (ids, aria-labels, text, class names, as matchSource looks for them, and
// data-testid values and image file names). files: a { path -> text } cache shared across findings.
// [{ file: 'site/index.html', line: 21, token, kind }], at most `max`.
export function locate(cwd, finding, sourceDirs, { files = null, max = 8 } = {}) {
  const html = typeof finding.html === 'string' ? finding.html : '';
  const tokens = tokensOf(finding);
  for (const m of html.matchAll(/\bdata-testid\s*=\s*["']([^"']{3,})["']/gi)) tokens.push({ kind: 'data-testid', value: m[1] });
  // An image's file name (harbour.svg), never a data: URL.
  for (const m of html.matchAll(/\b(?:src|srcset)\s*=\s*["']([^"'\s]+)/gi)) {
    if (/^data:/i.test(m[1])) continue;
    const name = m[1].split(/[?#]/)[0].split('/').pop();
    if (name && name.length >= 5 && /\.\w{2,5}$/.test(name)) tokens.push({ kind: 'src', value: name });
  }
  if (!tokens.length) return [];
  const cache = files || new Map();
  if (!cache.size) {
    for (const file of sourceFiles(cwd, sourceDirs)) {
      try {
        if (statSync(file).size > MAX_BYTES) continue;
        cache.set(relative(cwd, file).split('\\').join('/'), readFileSync(file, 'utf8'));
      } catch {}
    }
  }
  const out = [];
  const seen = new Set();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const t of tokens) {
    // Text may wrap across lines in the source: any run of white space matches any other.
    const re = new RegExp(t.value.split(/\s+/).map(esc).join('\\s+'), 'g');
    for (const [file, text] of cache) {
      for (const m of text.matchAll(re)) {
        const line = text.slice(0, m.index).split('\n').length;
        const key = `${file}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file, line, token: t.value, kind: t.kind });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}
