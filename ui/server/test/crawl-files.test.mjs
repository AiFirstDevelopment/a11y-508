import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';

// docs/plans/manual-crawl-first.md guard g: a PDF run's own look over the site is served from
// /api/manual/:id/crawl/<file>, and only its report.html and report.json: nothing above it, nothing
// beside it (crawl.log), however the path is spelled.
test('crawl files: report.html and report.json are served; any other path is 404', async () => {
  const srv = await startServer();
  try {
    const id = '20261018-101010';
    const dir = join(srv.dirs().work, 'manual', id);
    mkdirSync(join(dir, 'crawl'), { recursive: true });
    writeFileSync(join(dir, 'source.pdf'), '%PDF-1.4\n');
    writeFileSync(join(dir, 'decisions.ndjson'), '{}\n');
    writeFileSync(join(dir, 'crawl', 'report.html'), '<!doctype html><title>The site</title>\n');
    writeFileSync(join(dir, 'crawl', 'report.json'), '{"pages":[]}\n');
    writeFileSync(join(dir, 'crawl', 'crawl.log'), 'warn x\n');
    const get = (p, opts) => srv.call('GET', `/api/manual/${id}/crawl/${p}`, opts);
    const html = await get('report.html');
    assert.deepEqual([html.status, html.text, html.headers['content-type']], [200, '<!doctype html><title>The site</title>\n', 'text/html; charset=utf-8']);
    const json = await get('report.json');
    assert.deepEqual([json.status, json.json], [200, { pages: [] }]);
    for (const p of ['../source.pdf', '%2e%2e/decisions.ndjson', '..%2fdecisions.ndjson', '../parsed/report.md', 'crawl.log', 'report.html.bak', 'summary.md', 'report.json/', '']) {
      assert.equal((await get(p)).status, 404, p);
    }
    assert.equal((await srv.call('GET', `/api/manual/..%2f..%2f/crawl/report.html`)).status, 404);
    // Without the session secret (and no cookie): refused.
    assert.equal((await get('report.html', { secret: '' })).status, 401);
  } finally {
    await srv.stop();
  }
});
