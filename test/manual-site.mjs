// The manual flow's fixture app (test/fixtures/manual/app): a stand-in for an Angular app served
// from its repository's working tree, so a commit is "deployed" at once. Each page is src/index.html
// with every <app-x></app-x> replaced by the inline template of the component whose selector is
// app-x. stale: the components as they were when the server started (a deployment that serves the
// old page), while index.html (the build marker) is read as it is now.

import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function components(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.component\.ts$/.test(e.name)) {
        const text = readFileSync(full, 'utf8');
        const sel = /selector:\s*'([^']+)'/.exec(text);
        const tpl = /template:\s*`([\s\S]*?)`/.exec(text);
        if (sel && tpl) out[sel[1]] = tpl[1];
      }
    }
  };
  walk(join(dir, 'src', 'app'));
  return out;
}

export async function startManualSite({ dir, port = 0 } = {}) {
  let snapshot = components(dir);
  let stale = false;
  const PAGES = { '/': '<app-home></app-home>', '/search': '<h1>Search</h1>\n<app-search-bar></app-search-bar>' };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('// the app');
    }
    if (path === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    const page = PAGES[path.replace(/\/+$/, '') || '/'];
    if (!page || !existsSync(join(dir, 'src', 'index.html'))) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
    }
    const comps = stale ? snapshot : components(dir);
    let html = readFileSync(join(dir, 'src', 'index.html'), 'utf8').replace('<!-- PAGE -->', page);
    for (let i = 0; i < 3; i++) html = html.replace(/<(app-[\w-]+)><\/\1>/g, (m, sel) => comps[sel] ?? m);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  return {
    base,
    // From now on, the deployment keeps serving the components as they are at this moment.
    setStale(on) {
      if (on) snapshot = components(dir);
      stale = on;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
