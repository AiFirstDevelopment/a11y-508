// Brings the sign-in tab to the front: the tab a crawl or the fix loop opened for the person to
// sign in, in the dashboard's own Chrome window (--connect) or in a Chrome window of its own.
// Over the browser's DevTools port on 127.0.0.1: the tab is activated, then its window is
// minimized and restored, which is what reliably raises a window on Windows.

import { Cdp } from '../../src/cdp.mjs';
import { WebSocketClient, cdpStreams } from '../../src/ws.mjs';

const TIMEOUT = 5000;

// Where a login-waiting event says the sign-in tab is: { port, targetId }, or null.
export function signInTabOf(ev, fallbackPort = null) {
  const port = Number(ev && ev.port) || Number(fallbackPort) || null;
  const targetId = ev && typeof ev.targetId === 'string' && /^[0-9A-Za-z_-]{1,128}$/.test(ev.targetId) ? ev.targetId : null;
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535 || !targetId) return null;
  return { port, targetId };
}

const within = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out`)), ms)))]).finally(() => clearTimeout(timer));
};

// Resolves to { ok: true, calls } with the DevTools calls it made, or throws.
export async function bringToFront({ port, targetId }) {
  const res = await within(fetch(`http://127.0.0.1:${port}/json/version`), TIMEOUT, 'reaching the browser');
  const { webSocketDebuggerUrl } = await res.json();
  // Only ever the local browser: the WebSocket goes to 127.0.0.1 on the same port, whatever host it names.
  const u = new URL(webSocketDebuggerUrl);
  const ws = await WebSocketClient.connect(`ws://127.0.0.1:${port}${u.pathname}`, { timeout: TIMEOUT });
  const { reader, writer } = cdpStreams(ws);
  const cdp = new Cdp(writer, reader);
  const calls = [];
  const send = (method, params) => {
    calls.push({ method, params });
    return within(cdp.send(method, params), TIMEOUT, method);
  };
  try {
    await send('Target.activateTarget', { targetId });
    try {
      const { windowId, bounds } = await send('Browser.getWindowForTarget', { targetId });
      const back = bounds && (bounds.windowState === 'maximized' || bounds.windowState === 'fullscreen') ? bounds.windowState : 'normal';
      await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await send('Browser.setWindowBounds', { windowId, bounds: { windowState: back } });
      await send('Target.activateTarget', { targetId });
    } catch {}
    return { ok: true, calls };
  } finally {
    ws.close();
  }
}
