import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';

// docs/plans/pdf-parse.md guard k: a PDF run's parse is served from /api/manual/:id/parsed/<path>, and
// only report.md, manifest.json and pages/<name>.png: nothing above it, however the path is spelled.
test('parsed: report.md, manifest.json and page pictures are served; any other path is 404', async () => {
  const srv = await startServer();
  try {
    const id = '20261017-101010';
    const dir = join(srv.dirs().work, 'manual', id);
    mkdirSync(join(dir, 'parsed', 'pages'), { recursive: true });
    writeFileSync(join(dir, 'source.pdf'), '%PDF-1.4\n');
    writeFileSync(join(dir, 'decisions.ndjson'), '{}\n');
    writeFileSync(join(dir, 'parsed', 'report.md'), '# The report\n');
    writeFileSync(join(dir, 'parsed', 'manifest.json'), '{}\n');
    writeFileSync(join(dir, 'parsed', 'pages', 'page-01.png'), 'png');
    const get = (p, opts) => srv.call('GET', `/api/manual/${id}/parsed/${p}`, opts);
    const ok = await get('report.md');
    assert.deepEqual([ok.status, ok.text, ok.headers['content-type']], [200, '# The report\n', 'text/markdown; charset=utf-8']);
    assert.equal((await get('manifest.json')).status, 200);
    assert.equal((await get('pages/page-01.png')).headers['content-type'], 'image/png');
    for (const p of ['../source.pdf', '%2e%2e/decisions.ndjson', '..%2fdecisions.ndjson', 'pages/../../source.pdf', 'pages%2f..%2f..%2fsource.pdf', 'pages/page-01.png.md', 'notes.txt', '']) {
      assert.equal((await get(p)).status, 404, p);
    }
    assert.equal((await srv.call('GET', `/api/manual/..%2f..%2f/parsed/report.md`)).status, 404);
    // Without the session secret (and no cookie): refused.
    assert.equal((await get('report.md', { secret: '' })).status, 401);
  } finally {
    await srv.stop();
  }
});
