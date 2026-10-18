import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';
import { pngOf } from '../../../test/fixtures/manual/png.mjs';

// docs/plans/screenshots-in.md guards c and f: POST /api/manual/screenshots refuses, in one sentence that
// names the limits, more than 40 screenshots, one larger than 10 MB, and one whose bytes are not a
// PNG, JPEG or WebP picture; nothing is kept and no run starts.
test('screenshots: 41 are refused naming 40, 11 MB naming 10 MB, text named .png as not a screenshot; no run, no folder', async () => {
  const srv = await startServer();
  try {
    const post = async (files) => {
      const form = new FormData();
      for (const [name, bytes] of files) form.append('shot', new Blob([bytes], { type: 'image/png' }), name);
      form.append('notes', JSON.stringify(files.map(() => 'a note')));
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/manual/screenshots`, { method: 'POST', headers: { 'x-a11y-508-secret': srv.secret }, body: form });
      return { status: r.status, error: (await r.json()).error };
    };
    const small = pngOf(8, 8);
    const many = await post(Array.from({ length: 41 }, (_, i) => [`s${i}.png`, small]));
    assert.equal(many.status, 400);
    assert.match(many.error, /\b40\b/);
    const big = await post([['big.png', Buffer.concat([small, Buffer.alloc(11 * 1024 * 1024)])]]);
    assert.equal(big.status, 400);
    assert.match(big.error, /10 MB/);
    const text = await post([['notes.png', Buffer.from('These are my notes, not a picture.\n')]]);
    assert.deepEqual(text, { status: 400, error: 'That is not a screenshot: only PNG, JPEG or WebP pictures can be added, at most 40 of them, 10 MB each.' });
    assert.equal((await srv.call('GET', '/api/runs/current')).json, null);
    const root = join(srv.dirs().work, 'manual');
    assert.ok(!existsSync(root) || !readdirSync(root).length);
    // The session secret is needed.
    const form = new FormData();
    form.append('shot', new Blob([small]), 'a.png');
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/manual/screenshots`, { method: 'POST', body: form })).status, 401);
  } finally {
    await srv.stop();
  }
});
