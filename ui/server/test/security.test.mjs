import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';

test('the API needs the session secret, refuses foreign hosts, and confines report files', async () => {
  const s = await startServer();
  try {
    for (const p of ['/api/env', '/api/reports', '/api/ledger', '/api/config', '/api/command']) {
      assert.equal((await s.call('GET', p, { secret: null })).status, 401, p);
      assert.equal((await s.call('GET', p, { secret: 'nope' })).status, 401, p);
    }
    assert.equal((await s.call('POST', '/api/runs', { secret: null, body: {} })).status, 401);
    assert.equal((await s.call('GET', '/api/env')).status, 200);
    assert.equal((await s.call('GET', '/api/env', { secret: `Bearer ${s.secret}` })).status, 200, 'the crawler sends it with a scheme');
    for (const host of ['evil.example', `localhost:${s.port + 1}`, `127.0.0.1.nip.io:${s.port}`]) {
      assert.equal((await s.call('GET', '/api/env', { host })).status, 403, host);
      assert.equal((await s.call('GET', '/', { host })).status, 403, host);
    }
    assert.equal((await s.call('GET', '/api/env', { host: `localhost:${s.port}` })).status, 200);
    // The report-file cookie is not the API secret and opens nothing else.
    const cookie = /a11y508_\d+=([0-9a-f]+)/.exec((await s.call('GET', '/api/env')).headers['set-cookie'][0])[1];
    assert.notEqual(cookie, s.secret);
    assert.equal((await s.call('GET', '/api/env', { secret: cookie })).status, 401);
    assert.equal((await s.call('GET', '/api/env', { secret: null, headers: { cookie: `a11y508_${s.port}=${cookie}` } })).status, 401);
    mkdirSync(join(s.dirs().report, 'screenshots'), { recursive: true });
    writeFileSync(join(s.dirs().report, 'report.json'), JSON.stringify({ finishedAt: 'x', summary: {}, pages: [] }));
    writeFileSync(join(s.dirs().report, 'screenshots', 'a.png'), 'png');
    writeFileSync(join(s.cwd, 'outside.txt'), 'outside');
    assert.equal((await s.call('GET', '/api/reports/latest/screenshots/a.png')).status, 200);
    for (const p of ['/api/reports/latest/screenshots/..%2F..%2Foutside.txt', '/api/reports/latest/screenshots/%2e%2e/%2e%2e/outside.txt', '/api/reports/latest/screenshots/../../outside.txt', '/api/reports/h-..%2F..%2F/screenshots/a.png']) {
      assert.equal((await s.call('GET', p)).status, 404, p);
    }
  } finally {
    await s.stop();
  }
});

test('a token is held in memory only: never returned, never in an event, redacted from output', async () => {
  const s = await startServer({ env: { TOKEN: 'server-env-token-value' } });
  try {
    const env = await s.call('GET', '/api/env');
    assert.equal(env.json.tokenInEnv, true);
    assert.ok(!env.text.includes('server-env-token-value'));
    // A crawl of an unreachable site, with a token from the form; the CLI's arguments never carry it.
    const r = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: 'http://127.0.0.1:9/', options: { 'max-pages': '1', 'no-interact': true, 'no-zoom': true }, auth: { mode: 'token', token: 'form-token-value-123' } } });
    assert.equal(r.status, 202, r.text);
    assert.ok(!r.text.includes('form-token-value-123'));
    await s.waitDone();
    const events = await s.call('GET', '/api/runs/current/events');
    assert.match(events.text, /"type":"done"/);
    assert.ok(!events.text.includes('form-token-value-123'));
    assert.ok(!(await s.call('GET', '/api/env')).text.includes('form-token-value-123'));
    assert.equal((await s.call('GET', '/api/env')).json.tokenHeld, true);
  } finally {
    await s.stop();
  }
});
