// The loop's gate ("check": "node check.mjs"): every page under site/ must still parse as an HTML
// document, and the server must still serve each of them. Exit 0 when both hold.
//
// "Parses" is deliberately simple and dependency-free: a doctype, one html, head and body, and
// the container elements below opened and closed the same number of times, outside comments,
// scripts and styles. It catches a fix that breaks the markup, not one that changes it.
//
// Each run is appended to a11y-508-gate.log (git-ignored) with the files changed at that moment,
// so a test can match every commit of the loop to a gate run.

import { readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startServer, SITE } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINERS = ['html', 'head', 'body', 'header', 'nav', 'main', 'footer', 'section', 'article', 'aside', 'div', 'form', 'fieldset', 'table', 'thead', 'tbody', 'ul', 'ol', 'dialog', 'button', 'a', 'label', 'select', 'textarea', 'svg', 'script', 'style', 'title', 'h1', 'h2', 'h3', 'legend', 'caption'];

const pages = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) pages.push(p);
  }
};
walk(SITE);

const problems = [];
for (const file of pages) {
  const rel = relative(here, file).split('\\').join('/');
  const raw = readFileSync(file, 'utf8');
  const text = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '<$1></$1>');
  if (!/^\s*<!doctype html>/i.test(text)) problems.push(`${rel}: no <!doctype html> at the start`);
  for (const tag of CONTAINERS) {
    const open = (text.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')) || []).length;
    const close = (text.match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length;
    if (open !== close) problems.push(`${rel}: <${tag}> opened ${open} time(s), closed ${close}`);
  }
  for (const tag of ['html', 'head', 'body']) {
    if ((text.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')) || []).length !== 1) problems.push(`${rel}: expected exactly one <${tag}>`);
  }
}

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
for (const file of pages) {
  const rel = relative(SITE, file).split('\\').join('/');
  try {
    const res = await fetch(base + rel);
    const body = await res.text();
    if (res.status !== 200) problems.push(`${rel}: served with HTTP ${res.status}`);
    else if (!/<\/html>\s*$/i.test(body)) problems.push(`${rel}: served without its closing </html>`);
  } catch (e) {
    problems.push(`${rel}: ${e.message}`);
  }
}
server.close();

const changed = (spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--no-renames', '--', 'site'], { cwd: here, encoding: 'utf8' }).stdout || '')
  .split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^"(.*)"$/, '$1')).sort();
appendFileSync(join(here, 'a11y-508-gate.log'), JSON.stringify({ at: new Date().toISOString(), pages: pages.length, ok: !problems.length, changed, problems }) + '\n');

if (problems.length) {
  console.error(`check failed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check passed: ${pages.length} page(s) parse and serve`);
