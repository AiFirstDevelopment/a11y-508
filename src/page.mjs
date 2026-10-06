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
    s.on('Network.responseReceived', (p) => {
      if (p.type === 'Document' && p.frameId === this.mainFrameId) {
        this.docResponse = { status: p.response.status, mimeType: p.response.mimeType, url: p.response.url };
      }
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

    // Single-page apps usually keep the session token in web storage and send
    // the user to a login page when it is missing, so a header alone does not
    // get past their auth guard. Seed the raw token before any page script
    // runs, on the auth origins only, and never overwrite a value the app has
    // since written (for example a refreshed token).
    if (auth && auth.storage) {
      const source = `(() => {
  const origins = new Set(${JSON.stringify([...auth.origins])});
  if (!origins.has(location.origin)) return;
  const keys = ${JSON.stringify(auth.storage.keys)};
  const value = ${JSON.stringify(auth.storage.value)};
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const store = window[name];
      for (const k of keys) if (store.getItem(k) === null) store.setItem(k, value);
    } catch {}
  }
})();`;
      await s.send('Page.addScriptToEvaluateOnNewDocument', { source });
    }

    for (const origin of this.opts.cookieOrigins || []) {
      for (const c of this.opts.cookies || []) {
        const r = await s.send('Network.setCookie', { name: c.name, value: c.value, url: origin + '/' }).catch(() => ({ success: false }));
        if (!r.success) debug('setCookie failed', origin, c.name);
      }
    }
  }

  async waitLifecycle(name, loaderId, timeout) {
    const hit = this.lifecycle.find((e) => e.name === name && (!loaderId || e.loaderId === loaderId));
    if (hit) return hit;
    return this.s.waitFor('Page.lifecycleEvent', {
      timeout,
      predicate: (e) => e.frameId === this.mainFrameId && e.name === name && (!loaderId || e.loaderId === loaderId),
    });
  }

  async goto(url, timeout = 30000) {
    this.docResponse = null;
    this.lifecycle = [];
    debug('goto', url);
    const res = await this.s.send('Page.navigate', { url });
    debug('navigate ->', res);
    if (res.errorText) return { error: res.errorText };
    let timedOut = false;
    try {
      await this.waitLifecycle('load', res.loaderId, timeout);
    } catch {
      timedOut = true;
      await this.s.send('Page.stopLoading').catch(() => {});
    }
    try {
      await this.waitLifecycle('networkIdle', res.loaderId, timedOut ? 500 : Math.min(5000, timeout));
    } catch {}
    if (this.opts.settle) await sleep(this.opts.settle);
    const doc = this.docResponse;
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
