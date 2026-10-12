// A static server for the loop test app: serves ./site (relative to this file) on 127.0.0.1.
//
//   node server.mjs [--port 4321]
//
// It reads the files on every request, so a fix the loop commits is live at once ("deployed":
// "none"). Exported for check.mjs, which starts it on a free port to see that every page serves.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SITE = join(here, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript; charset=utf-8' };

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(SITE, path));
    if (!file.startsWith(SITE)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="en"><title>Not found</title><h1>Not found</h1></html>');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Run directly (realpath: a temporary directory can be reached through a symlink, as on macOS).
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const at = process.argv.indexOf('--port');
  const server = await startServer(at > 0 ? Number(process.argv[at + 1]) : 4321);
  process.stdout.write(`loop app at http://127.0.0.1:${server.address().port}/\n`);
}
