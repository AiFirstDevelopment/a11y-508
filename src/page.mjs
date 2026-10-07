// A single Chrome tab driven over CDP: navigation, auth header injection,
// web-storage and cookie seeding, script injection, keyboard input,
// screenshots, zoom emulation.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const CHECKS_DIR = fileURLToPath(new URL('./checks/browser/', import.meta.url));
let bundle = null;

export function checksBundle() {
  if (bundle) return bundle;
  const files = readdirSync(CHECKS_DIR).filter((f) => f.endsWith('.js')).sort();
  bundle = files.map((f) => `/* ${f} */\n` + readFileSync(join(CHECKS_DIR, f), 'utf8')).join('\n;\n');
  return bundle;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG = !!process.env.A11Y_508_DEBUG;
export const debug = (...a) => {
  if (DEBUG) process.stderr.write('[debug] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
};

// Navigation failures that are usually momentary (a dropped socket on the
// first request, a server restarting, a network change) and worth retrying.
const TRANSIENT_NET = /ERR_(SOCKET_NOT_CONNECTED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|CONNECTION_REFUSED|EMPTY_RESPONSE|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)\b/;
const NAV_RETRIES = 3;

// Turns a cookie from Network.getAllCookies, a saved session file, or --cookie
// into the parameters Network.setCookie accepts.
export function cookieParam(c) {
  const p = { name: c.name, value: c.value };
  if (c.url) p.url = c.url;
  if (c.domain) p.domain = c.domain;
  if (c.path) p.path = c.path;
  if (c.secure) p.secure = true;
  if (c.httpOnly) p.httpOnly = true;
  if (c.sameSite) p.sameSite = c.sameSite;
  if (typeof c.expires === 'number' && c.expires > 0) p.expires = c.expires;
  return p;
}

const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
};

export class Page {
  constructor(session, opts) {
    this.s = session;
    this.opts = opts;
    this.mainFrameId = null;
    this.docResponse = null;
    this.docRequestId = null;
    this.docLoaderId = null;
    this.docError = null;
    this.lifecycle = [];
    this.viewport = opts.viewport;
    this.closed = false;
  }

  async init() {
    const s = this.s;
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    await s.send('Network.enable', { maxResourceBufferSize: 1 << 20, maxTotalBufferSize: 4 << 20 });
    await s.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await s.send('Emulation.setDeviceMetricsOverride', { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false });
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    if (this.opts.userAgent) await s.send('Network.setUserAgentOverride', { userAgent: this.opts.userAgent }).catch(() => {});
    const { frameTree } = await s.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;

    s.on('Page.lifecycleEvent', (e) => {
      if (e.frameId !== this.mainFrameId) return;
      debug('lifecycle', e.name, e.loaderId);
      this.lifecycle.push(e);
      if (this.lifecycle.length > 60) this.lifecycle.shift();
    });
    s.on('Network.requestWillBeSent', (p) => {
      if (p.type === 'Document' && p.frameId === this.mainFrameId) {
        this.docRequestId = p.requestId;
        this.docLoaderId = p.loaderId;
        this.docError = null;
      }
    });
    s.on('Network.responseReceived', (p) => {
      if (p.type === 'Document' && p.frameId === this.mainFrameId) {
        this.docResponse = { status: p.response.status, mimeType: p.response.mimeType, url: p.response.url };
      }
    });
    s.on('Network.loadingFailed', (p) => {
      if (p.requestId === this.docRequestId && !p.canceled) this.docError = p.errorText;
    });
    s.on('Page.javascriptDialogOpening', () => {
      s.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    });
    s.on('Inspector.targetCrashed', () => {
      this.closed = true;
    });

    const extra = this.opts.extraHeaders || [];
    const auth = this.opts.auth; // { header, value, origins:Set }
    if (extra.length || auth) {
      await s.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      s.on('Fetch.requestPaused', (p) => {
        const headers = Object.entries(p.request.headers || {}).map(([name, value]) => ({ name, value }));
        const has = (n) => headers.some((h) => h.name.toLowerCase() === n.toLowerCase());
        let origin = '';
        try {
          origin = new URL(p.request.url).origin;
        } catch {}
        if (auth && auth.origins.has(origin) && !has(auth.header)) headers.push({ name: auth.header, value: auth.value });
        debug('request', p.request.url, auth && auth.origins.has(origin) ? '(auth)' : '');
        for (const h of extra) if (!has(h.name) || h.override) headers.push(h);
        s.send('Fetch.continueRequest', { requestId: p.requestId, headers }).catch(() => {});
      });
    }

    // Single-page apps usually keep the session in web storage and send the
    // user to a login page when it is missing, so a header alone does not get
    // past their auth guard. Seed web storage before any page script runs:
    // the raw TOKEN under the common keys on the auth origins, plus whatever a
    // saved session (--login / --state) captured. Values are only written
    // when absent, so a token the app has since refreshed is never clobbered.
    const seeds = {};
    const seed = (origin, store, key, value) => {
      (seeds[origin] ||= { local: {}, session: {} })[store][key] = String(value);
    };
    if (auth && auth.storage) {
      for (const origin of auth.origins) for (const k of auth.storage.keys) {
        seed(origin, 'local', k, auth.storage.value);
        seed(origin, 'session', k, auth.storage.value);
      }
    }
    const state = this.opts.state;
    if (state && state.storage) {
      for (const [origin, st] of Object.entries(state.storage)) {
        for (const [k, v] of Object.entries(st.local || {})) seed(origin, 'local', k, v);
        for (const [k, v] of Object.entries(st.session || {})) seed(origin, 'session', k, v);
      }
    }
    if (Object.keys(seeds).length) {
      const source = `(() => {
  const seeds = ${JSON.stringify(seeds)};
  const mine = seeds[location.origin];
  if (!mine) return;
  for (const [name, items] of [['localStorage', mine.local], ['sessionStorage', mine.session]]) {
    try {
      const store = window[name];
      for (const k in items) if (store.getItem(k) === null) store.setItem(k, items[k]);
    } catch {}
  }
})();`;
      await s.send('Page.addScriptToEvaluateOnNewDocument', { source });
    }

    const cookies = [];
    for (const origin of this.opts.cookieOrigins || []) for (const c of this.opts.cookies || []) cookies.push({ name: c.name, value: c.value, url: origin + '/' });
    for (const c of (state && state.cookies) || []) cookies.push(c);
    for (const c of cookies) {
      const r = await s.send('Network.setCookie', cookieParam(c)).catch(() => ({ success: false }));
      if (!r.success) debug('setCookie failed', c.domain || c.url, c.name);
    }
  }

  // Resolves 'load' when the document with this loader finishes loading,
  // 'replaced' as soon as another main-frame document starts instead, or
  // 'timeout'.
  async waitLoadOrReplaced(loaderId, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (this.lifecycle.some((e) => e.name === 'load' && e.loaderId === loaderId)) return 'load';
      if (this.docLoaderId && this.docLoaderId !== loaderId) return 'replaced';
      if (this.closed) return 'timeout';
      await sleep(50);
    }
    return 'timeout';
  }

  async waitLifecycle(name, loaderId, timeout) {
    const hit = this.lifecycle.find((e) => e.name === name && (!loaderId || e.loaderId === loaderId));
    if (hit) return hit;
    return this.s.waitFor('Page.lifecycleEvent', {
      timeout,
      predicate: (e) => e.frameId === this.mainFrameId && e.name === name && (!loaderId || e.loaderId === loaderId),
    });
  }

  // Navigates and waits for load. Momentary network failures are retried a
  // few times with backoff; the result carries how many retries it took.
  async goto(url, timeout = 30000) {
    let retries = 0;
    for (;;) {
      const r = await this.navigateOnce(url, timeout);
      if (!r.error || !TRANSIENT_NET.test(r.error) || retries >= NAV_RETRIES) return { ...r, retries };
      retries++;
      debug('transient navigation error, retrying', r.error, `(${retries}/${NAV_RETRIES})`);
      await sleep(500 * 2 ** (retries - 1));
    }
  }

  async navigateOnce(url, timeout) {
    this.docResponse = null;
    this.docRequestId = null;
    this.docLoaderId = null;
    this.docError = null;
    this.lifecycle = [];
    debug('goto', url);
    const res = await this.s.send('Page.navigate', { url });
    debug('navigate ->', res);
    if (res.errorText) return { error: res.errorText };
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(100, deadline - Date.now());
    let loaderId = res.loaderId;
    let timedOut = false;
    for (let hop = 0; ; hop++) {
      const outcome = await this.waitLoadOrReplaced(loaderId, remaining());
      if (outcome === 'replaced' && hop < 8) {
        // A script replaced this document before it finished loading (an
        // auth guard in <head>, for example); wait for the new one instead.
        debug('document replaced before load', loaderId, '->', this.docLoaderId);
        loaderId = this.docLoaderId;
        continue;
      }
      if (outcome !== 'load') {
        timedOut = true;
        await this.s.send('Page.stopLoading').catch(() => {});
      }
      try {
        await this.waitLifecycle('networkIdle', loaderId, timedOut ? 500 : Math.min(5000, remaining()));
      } catch {}
      if (this.opts.settle) await sleep(this.opts.settle);
      // A script or meta refresh may have started another navigation by now
      // (a sign-in bounce through a portal, a landing redirect). Follow it
      // rather than auditing a document that is about to be replaced.
      if (timedOut || !this.docLoaderId || this.docLoaderId === loaderId || hop >= 8 || Date.now() >= deadline) break;
      debug('following client-side navigation', this.docLoaderId);
      loaderId = this.docLoaderId;
    }
    const doc = this.docResponse;
    if (!doc && this.docError) return { error: this.docError };
    debug('loaded', url, doc, timedOut ? 'TIMED OUT' : '');
    let finalUrl = url;
    try {
      finalUrl = await this.evaluate('location.href');
    } catch {}
    return { status: doc ? doc.status : null, mimeType: doc ? doc.mimeType : null, finalUrl, timedOut };
  }

  evaluate(expression, opts) {
    return this.s.evaluate(expression, opts);
  }

  async ensureInjected() {
    const ok = await this.evaluate('typeof window.__a11y508 === "object" && typeof window.__a11y508.run === "function"').catch(() => false);
    if (ok) return;
    await this.evaluate(checksBundle(), { awaitPromise: false });
  }

  async click(x, y) {
    await this.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async press(name, modifiers = 0) {
    const k = KEYS[name];
    if (!k) throw new Error(`Unknown key ${name}`);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    await this.s.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async screenshot(rect, pad = 6) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const clip = {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad),
      width: Math.min(1600, rect.width + pad * 2),
      height: Math.min(1200, rect.height + pad * 2),
      scale: 1,
    };
    const { data } = await this.s.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true, fromSurface: true });
    return Buffer.from(data, 'base64');
  }

  async setZoom(factor) {
    const w = Math.round(this.viewport.width / factor);
    const h = Math.round(this.viewport.height / factor);
    await this.s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: factor, mobile: false });
  }

  // Returns the event listener types attached directly to the element matched by `selector`.
  async listenerTypes(selectorOrExpr, isExpr = false) {
    const expr = isExpr ? selectorOrExpr : `document.querySelector(${JSON.stringify(selectorOrExpr)})`;
    const { result } = await this.s.send('Runtime.evaluate', { expression: expr, returnByValue: false });
    if (!result || !result.objectId) return [];
    try {
      const { listeners } = await this.s.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
      return listeners.map((l) => l.type);
    } catch {
      return [];
    } finally {
      this.s.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    }
  }
}
