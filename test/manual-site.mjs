// The manual flow's fixture app (test/fixtures/manual/app): a stand-in for an Angular app served
// from its repository's working tree, so a commit is "deployed" at once. Each page is src/index.html
// with every <app-x></app-x> replaced by the inline template of the component whose selector is
// app-x. stale: the components as they were when the server started (a deployment that serves the
// old page), while index.html (the build marker) is read as it is now.

import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The app's own Not Found view: a heading and a sentence.
const NOT_FOUND = '<h2>Page not found</h2>\n<p>The page you asked for does not exist.</p>';
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
  // held: the deployment has not arrived (the build marker the fixes committed is not served).
  let held = false;
  let deep = false;
  // crawlFails: every request is answered HTTP 500 (a site that is down), for the test of a look over
  // the site that fails while the run goes on (docs/plans/manual-crawl-first.md guard e).
  let crawlFails = false;
  // The app's pages, each with its title. /search links to three item detail pages, /items/1..3, all
  // titled "Item" as detail pages of one kind are (docs/plans/manual-crawl-first.md AC 5): a crawl
  // finds them; the router names them only as items/:id.
  const PAGES = {
    '/': { title: 'Example app', html: '<app-home></app-home>' },
    '/search': { title: 'Search', html: '<h1>Search</h1>\n<app-search-bar></app-search-bar>\n<ul><li><a href="/items/1">Item 1</a></li><li><a href="/items/2">Item 2</a></li><li><a href="/items/3">Item 3</a></li></ul>' },
  };
  for (const id of [1, 2, 3]) PAGES[`/items/${id}`] = { title: 'Item', html: `<app-item></app-item>\n<p>Item number ${id}.</p>` };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (crawlFails) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('the site is down');
    }
    if (path === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('// the app');
    }
    if (path === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    // /gone answers HTTP 404; any other path the app has no page for is its own Not Found view, with
    // HTTP 200, as a single-page app's router shows it (docs/plans/pictures-and-routes.md AC 8).
    const page = PAGES[path.replace(/\/+$/, '') || '/'];
    if (path.replace(/\/+$/, '') === '/gone' || !existsSync(join(dir, 'src', 'index.html'))) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
    }
    const comps = stale ? snapshot : components(dir);
    let html = readFileSync(join(dir, 'src', 'index.html'), 'utf8').replace('<!-- PAGE -->', page ? page.html : NOT_FOUND);
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${page ? page.title : 'Not Found'}</title>`);
    if (held) html = html.replace(/<meta name="a11y-508-build"[^>]*>\s*/i, '');
    for (let i = 0; i < 3; i++) html = html.replace(/<(app-[\w-]+)><\/\1>/g, (m, sel) => comps[sel] ?? m);
    // deep: the server answers every page but the first with HTTP 404 and still serves the app, as some
    // deployments do for a deep link; the app then shows the real page.
    res.writeHead(deep && page && path.replace(/\/+$/, '') ? 404 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
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
    setHeld(on) {
      held = on;
    },
    setDeep(on) {
      deep = on;
    },
    // The site answers every request HTTP 500 until this is turned off again.
    setCrawlFails(on) {
      crawlFails = on;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
