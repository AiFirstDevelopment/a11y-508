// The routes of an Angular application, read from its router configuration in the source folders
// (docs/plans/pictures-and-routes.md AC 4): every `path: '...'` inside a Routes array, a
// RouterModule.forRoot(...) / forChild(...) or provideRouter(...) call, or the file a loadChildren
// points at, joined parent to child. Parameter segments (:id) and wildcards (**) are left out, with
// their children: a page that needs an id the tool does not have is not a page it can open. Pure:
// text in, paths out; nothing is executed.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { walk } from './components.mjs';

const MAX_FILE = 1024 * 1024;
const MAX_ROUTES = 2000;
// A file worth parsing names one of these.
const HINT = /\bRoutes\b|\bRoute\[\]|\bforRoot\s*\(|\bforChild\s*\(|\bprovideRouter\s*\(/;

// The index of the bracket closing the one at `open`, skipping strings, template literals and
// comments; -1 when it never closes.
export function closing(text, open) {
  const pairs = { '[': ']', '{': '}', '(': ')' };
  const stack = [pairs[text[open]]];
  if (!stack[0]) return -1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      if (i < 0) return -1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ']' || c === '}' || c === ')') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// The index of the quote closing the string opened at i (a template literal's ${...} is skipped as
// a bracket); -1 when it never closes.
function skipString(text, i) {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (q === '`' && c === '$' && text[j + 1] === '{') {
      const end = closing(text, j + 1);
      if (end < 0) return -1;
      j = end;
      continue;
    }
    if (c === q) return j;
    if (q !== '`' && c === '\n') return -1;
  }
  return -1;
}

// The top-level elements of the bracketed text between open and close, as [start, end) ranges,
// split at commas outside nested brackets and strings; a comment before an element is not part of it.
function elements(text, open, close) {
  const out = [];
  let start = open + 1;
  let content = false;
  for (let i = open + 1; i < close; i++) {
    const c = text[i];
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const end = text[i + 1] === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2) + 1;
      if (end < i) break;
      if (!content) start = end + 1;
      i = end;
      continue;
    }
    if (c === ',') {
      out.push([start, i]);
      start = i + 1;
      content = false;
      continue;
    }
    if (!/\s/.test(c)) content = true;
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i);
      if (end < 0) break;
      i = end;
    } else if (c === '[' || c === '{' || c === '(') {
      const end = closing(text, i);
      if (end < 0) break;
      i = end;
    }
  }
  if (text.slice(start, close).trim()) out.push([start, close]);
  return out;
}

// A string literal's value, when the text (trimmed) is one with no expression in it; else null.
const literal = (t) => {
  const m = /^(['"`])([^'"`$]*)\1$/.exec(t.trim());
  return m ? m[2] : null;
};

// The start of the `[` of the array a `const NAME = [` in the file declares; -1 when there is none.
function declStart(text, name) {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b[^=;]*=\\s*\\[`).exec(text);
  return decl ? decl.index + decl[0].length - 1 : -1;
}

// A file's own route arrays: the starts of their `[`.
function routeArrayStarts(text) {
  const starts = new Set();
  for (const m of text.matchAll(/:\s*(?:Routes|Route\[\])\s*=\s*\[/g)) starts.add(m.index + m[0].length - 1);
  for (const m of text.matchAll(/\b(?:RouterModule\s*\.\s*(?:forRoot|forChild)|provideRouter)\s*\(\s*/g)) {
    const at = m.index + m[0].length;
    if (text[at] === '[') starts.add(at);
    else {
      const id = /^[A-Za-z_$][\w$]*/.exec(text.slice(at, at + 80));
      if (id && declStart(text, id[0]) >= 0) starts.add(declStart(text, id[0]));
    }
  }
  return [...starts].sort((a, b) => a - b);
}

// The route objects of the array opened at `open`: [{ path, children, lazy }], where children are the
// same shape and lazy is the module specifier a loadChildren imports (or null). A `...NAME` spread
// of another array in the same file is followed, and so is `children: NAME`; refs collects the starts
// of the arrays followed so (they are part of this tree, not trees of their own).
function parseArray(text, open, seen = new Set(), refs = new Set()) {
  const close = closing(text, open);
  if (close < 0) return [];
  const out = [];
  for (const [s, e] of elements(text, open, close)) {
    const el = text.slice(s, e).trim();
    if (!el) continue;
    if (el.startsWith('{')) {
      const at = text.indexOf('{', s);
      const r = parseRoute(text, at, seen, refs);
      if (r) out.push(r);
      continue;
    }
    const spread = /^\.\.\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(el);
    if (spread && !seen.has(spread[1])) {
      const at = declStart(text, spread[1]);
      if (at >= 0) {
        seen.add(spread[1]);
        refs.add(at);
        out.push(...parseArray(text, at, seen, refs));
      }
    }
  }
  return out.slice(0, MAX_ROUTES);
}

function parseRoute(text, open, seen, refs) {
  const close = closing(text, open);
  if (close < 0) return null;
  const route = { path: null, children: [], lazy: null };
  for (const [s, e] of elements(text, open, close)) {
    const prop = text.slice(s, e);
    const m = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/.exec(prop);
    if (!m) continue;
    const key = m[1] || m[2] || m[3];
    const value = prop.slice(m[0].length);
    if (key === 'path') route.path = literal(value);
    else if (key === 'children') {
      const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(value);
      if (name) {
        const at = declStart(text, name[1]);
        if (at >= 0 && !seen.has(name[1])) {
          refs.add(at);
          route.children = parseArray(text, at, new Set([...seen, name[1]]), refs);
        }
      } else {
        const at = text.indexOf('[', s + m[0].length);
        if (at >= 0 && at < e) route.children = parseArray(text, at, seen, refs);
      }
    } else if (key === 'loadChildren') {
      const imp = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/.exec(value);
      if (imp) route.lazy = imp[2];
    }
  }
  return route.path === null && !route.children.length && !route.lazy ? null : route;
}

// The route trees a TypeScript source declares: one list per route array found in it.
export function routeTrees(text) {
  if (!HINT.test(text)) return [];
  // An array another tree spreads or names as its children is part of that tree, not a root.
  const refs = new Set();
  const trees = routeArrayStarts(text).map((at) => [at, parseArray(text, at, new Set(), refs)]);
  return trees.filter(([at, list]) => list.length && !refs.has(at)).map(([, list]) => list);
}

// The module file a loadChildren's import names, relative to the importing file; null when none exists.
export function lazyTarget(file, spec) {
  if (!/^\.\.?\//.test(spec)) return null;
  const base = resolve(dirname(file), spec);
  for (const f of [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, '.ts')]) {
    try {
      if (existsSync(f) && statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

const segment = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
const joinPath = (parent, child) => [segment(parent), segment(child)].filter(Boolean).join('/');
// A segment the tool cannot fill in: a parameter (:id), a matrix parameter, or a wildcard.
const unfillable = (p) => /(^|\/)(\*\*|:[^/]*)(\/|$)|\*/.test(segment(p));

// Every route path of the application, as '/a/b' strings, joined parent to child and across
// loadChildren files, without parameters and wildcards; deduplicated, in the order found. cwd: the
// repository; sourceDirs: its source folders (never node_modules or a build's output).
export function scanRoutes(cwd, sourceDirs = ['src']) {
  const files = new Map(); // absolute path -> { text, trees }
  walk(cwd, sourceDirs, (full, rel) => {
    if (!/\.ts$/.test(rel) || /\.(spec|test|d)\.ts$/.test(rel)) return;
    let text;
    try {
      if (statSync(full).size > MAX_FILE) return;
      text = readFileSync(full, 'utf8');
    } catch {
      return;
    }
    if (!HINT.test(text)) return;
    const trees = routeTrees(text);
    if (trees.length) files.set(resolve(full), { trees });
  });
  // The files with the routes a loadChildren target brings: itself, or, for an NgModule with none of
  // its own (the Angular CLI's --routing layout), the files it imports that have them.
  const routesOf = (t) => {
    if (files.has(t)) return [t];
    let text = '';
    try {
      if (statSync(t).size <= MAX_FILE) text = readFileSync(t, 'utf8');
    } catch {}
    const out = [];
    for (const m of text.matchAll(/\bimport\s+[^'";]*?\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/g)) {
      const f = lazyTarget(t, m[2]);
      if (f && files.has(f) && !out.includes(f)) out.push(f);
    }
    return out;
  };
  // The files other files load lazily are children of the routes that load them, not roots.
  const lazy = new Set();
  const targets = new Map(); // `${file}\n${spec}` -> the files with its routes
  for (const [file, { trees }] of files) {
    const visit = (routes) => {
      for (const r of routes) {
        if (r.lazy) {
          const t = lazyTarget(file, r.lazy);
          if (t) {
            const list = routesOf(t);
            for (const x of list) lazy.add(x);
            targets.set(`${file}\n${r.lazy}`, list);
          }
        }
        visit(r.children);
      }
    };
    for (const t of trees) visit(t);
  }
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const path = `/${segment(p)}`;
    if (seen.has(path) || out.length >= MAX_ROUTES) return;
    seen.add(path);
    out.push(path);
  };
  const expand = (file, routes, parent, visited) => {
    for (const r of routes) {
      if (r.path === null && !r.children.length && !r.lazy) continue;
      if (r.path !== null && unfillable(r.path)) continue;
      const full = joinPath(parent, r.path || '');
      add(full);
      if (r.children.length) expand(file, r.children, full, visited);
      if (r.lazy) {
        for (const t of targets.get(`${file}\n${r.lazy}`) || []) {
          if (visited.has(t) || !files.has(t)) continue;
          const next = new Set([...visited, t]);
          for (const tree of files.get(t).trees) expand(t, tree, full, next);
        }
      }
    }
  };
  for (const [file, { trees }] of files) {
    if (lazy.has(file)) continue;
    for (const tree of trees) expand(file, tree, '', new Set([file]));
  }
  return out;
}

// Where the application's routes live under its start URL: the start URL's folder, or, when the
// start URL is itself one of the routes (a deep link), what comes before that route.
export function appBase(startUrl, paths = []) {
  const u = new URL(startUrl);
  let path = u.pathname.replace(/\/+$/, '');
  let best = '';
  for (const p of paths) {
    const seg = segment(p);
    if (seg && (path === `/${seg}` || path.endsWith(`/${seg}`)) && seg.length > best.length) best = seg;
  }
  if (best) path = path.slice(0, path.length - best.length - 1);
  return `${u.origin}${path}/`;
}

// A hash-routed application's route in a URL ('#/a/b' of http://h/#/a/b?x, without the query or a
// trailing slash), or '' when its URL has no '#/'.
export function hashRoute(url) {
  const h = url && typeof url === 'object' ? url.hash : String(url || '').replace(/^[^#]*/, '');
  return h.startsWith('#/') ? `#/${segment(h.slice(2).split('?')[0])}` : '';
}

// The known routes as the prompts list them (docs/plans/manual-crawl-first.md AC 3): routes that
// differ only in their last path segment and share a title (five request detail pages) are one entry,
// the first of them with the others under `more`, so the list stays short. A route with no title, a
// top-level page (its parent is the root), or one alone under its parent stays an entry of its own.
// routes: [{ url, title, ... }] in order; the entries keep the order of their first member. Pure.
export function groupRoutes(routes) {
  const out = [];
  const groups = new Map(); // `${origin}${parent path}\n${title}` -> the entry
  for (const r of routes) {
    const title = String(r.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let key = null;
    try {
      const u = new URL(r.url);
      const path = `${u.pathname.replace(/\/+$/, '')}${hashRoute(u)}`;
      const cut = path.lastIndexOf('/');
      if (title && cut > 0) key = `${u.origin}${path.slice(0, cut)}\n${title}`;
    } catch {}
    const entry = key ? groups.get(key) : null;
    if (entry) {
      entry.more.push(r.url);
      continue;
    }
    const e = { ...r, more: [] };
    out.push(e);
    if (key) groups.set(key, e);
  }
  return out;
}

// The router's paths as full URLs under the start URL. An application that routes by the hash
// (useHash: a start URL like http://h/#/home) has them after the '#/' of the start URL's page.
export function routeUrls(startUrl, paths) {
  let base;
  try {
    const u = new URL(startUrl);
    if (hashRoute(u)) return paths.map((p) => `${u.origin}${u.pathname}#/${segment(p)}`);
    base = appBase(startUrl, paths);
  } catch {
    return [];
  }
  return paths.map((p) => new URL(segment(p), base).href);
}
