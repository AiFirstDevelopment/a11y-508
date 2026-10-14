import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers.mjs';
import { connectChrome } from '../../../src/chrome.mjs';
import { Session } from '../../../src/cdp.mjs';

const HEADLESS_OWN = join(dirname(fileURLToPath(import.meta.url)), 'headless-own-browser.mjs');

// A sign-in page that never finishes: the tab stays on /login, so the run keeps waiting.
async function loginSite() {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html lang="en"><title>Sign in</title><main><h1>Sign in</h1></main></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/login`, close: () => new Promise((r) => srv.close(r)) };
}

test('Show the sign-in tab: POST /api/sign-in/show activates the sign-in tab and raises its window over DevTools', { timeout: 180000 }, async () => {
  const site = await loginSite();
  const s = await startServer({ open: true, env: { A11Y_508_OWN_BROWSER_PATH: HEADLESS_OWN } });
  let conn = null;
  try {
    // No sign-in yet: nothing to show.
    assert.equal((await s.call('POST', '/api/sign-in/show')).status, 409);
    const started = await s.call('POST', '/api/runs', { body: { kind: 'crawl', url: site.url, options: {}, auth: { mode: 'signin' } } });
    assert.equal(started.status, 202, started.text);

    // The run's login-waiting event names the tab; until it arrives the endpoint answers 409.
    let shown = null;
    for (let i = 0; i < 300 && !shown; i++) {
      const r = await s.call('POST', '/api/sign-in/show');
      if (r.status === 200) shown = r.json;
      else await new Promise((ok) => setTimeout(ok, 200));
    }
    assert.ok(shown, `the endpoint never found the sign-in tab:\n${s.output()}`);
    const methods = shown.calls.map((c) => c.method);
    assert.deepEqual(methods, ['Target.activateTarget', 'Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Browser.setWindowBounds', 'Target.activateTarget'], JSON.stringify(shown.calls));
    const targetId = shown.calls[0].params.targetId;
    assert.equal(shown.calls[2].params.bounds.windowState, 'minimized');
    assert.equal(shown.calls[3].params.bounds.windowState, 'normal');

    // The target is the tab on the sign-in page, in the dashboard's browser.
    conn = await connectChrome(shown.port, { returnUrl: null });
    const { targetInfos } = await conn.cdp.send('Target.getTargets');
    const tab = targetInfos.find((t) => t.targetId === targetId);
    assert.ok(tab && tab.url === site.url, JSON.stringify(targetInfos));
    const { sessionId } = await conn.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const signIn = new Session(conn.cdp, sessionId, targetId);

    // Another tab takes the front; Show the sign-in tab brings the sign-in tab back.
    const other = await conn.newPage();
    await conn.cdp.send('Target.activateTarget', { targetId: other.targetId });
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(await signIn.evaluate('document.visibilityState'), 'hidden', 'the other tab is in front');
    const again = await s.call('POST', '/api/sign-in/show');
    assert.equal(again.status, 200, again.text);
    await new Promise((ok) => setTimeout(ok, 500));
    assert.equal(await signIn.evaluate('document.visibilityState'), 'visible');
    assert.equal(await other.evaluate('document.visibilityState'), 'hidden');
    const { windowId } = await conn.cdp.send('Browser.getWindowForTarget', { targetId });
    const { bounds } = await conn.cdp.send('Browser.getWindowBounds', { windowId });
    assert.equal(bounds.windowState, 'normal');
  } finally {
    if (conn) await conn.close().catch(() => {});
    await s.call('POST', '/api/runs/current/stop').catch(() => {});
    await s.stop();
    await site.close();
  }
});
