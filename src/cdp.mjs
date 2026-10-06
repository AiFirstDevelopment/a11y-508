// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe.
// Chrome reads JSON messages on fd 3 and writes them on fd 4, each
// terminated by a NUL byte. No network port, no WebSocket, no dependencies.

import { EventEmitter } from 'node:events';

export class Cdp extends EventEmitter {
  #seq = 0;
  #pending = new Map();
  #buf = Buffer.alloc(0);
  #writer;
  #closed = false;

  constructor(writer, reader) {
    super();
    this.setMaxListeners(0);
    this.#writer = writer;
    reader.on('data', (chunk) => this.#onData(chunk));
    const onClose = () => {
      if (this.#closed) return;
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(new Error(`CDP connection closed during ${p.method}`));
      this.#pending.clear();
      this.emit('close');
    };
    reader.on('close', onClose);
    reader.on('end', onClose);
    writer.on('error', () => {});
  }

  get closed() {
    return this.#closed;
  }

  #onData(chunk) {
    let buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) continue;
      const text = buf.subarray(start, i).toString('utf8');
      start = i + 1;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      this.#dispatch(msg);
    }
    this.#buf = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
  }

  #dispatch(msg) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(`${p.method}: ${msg.error.message}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        p.reject(err);
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
    this.emit(key, msg.params ?? {});
    this.emit('event', msg);
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = ++this.#seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#writer.write(JSON.stringify(msg) + '\0', (err) => {
        if (err) {
          this.#pending.delete(id);
          reject(err);
        }
      });
    });
  }
}

export class Session {
  constructor(cdp, sessionId, targetId) {
    this.cdp = cdp;
    this.id = sessionId;
    this.targetId = targetId;
    this.#listeners = [];
  }
  #listeners;

  send(method, params = {}) {
    return this.cdp.send(method, params, this.id);
  }

  on(event, fn) {
    const key = `${this.id}:${event}`;
    this.cdp.on(key, fn);
    const off = () => this.cdp.off(key, fn);
    this.#listeners.push(off);
    return off;
  }

  waitFor(event, { timeout = 30000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const key = `${this.id}:${event}`;
      const timer = setTimeout(() => {
        this.cdp.off(key, handler);
        reject(new Error(`Timed out after ${timeout}ms waiting for ${event}`));
      }, timeout);
      timer.unref();
      const handler = (params) => {
        if (predicate && !predicate(params)) return;
        clearTimeout(timer);
        this.cdp.off(key, handler);
        resolve(params);
      };
      this.cdp.on(key, handler);
    });
  }

  // Evaluate an expression in the page and return its value.
  // Throws if the expression throws.
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeout } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
      ...(timeout ? { timeout } : {}),
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception?.description || d.exception?.value || d.text || 'Evaluation failed';
      throw new Error(String(text).split('\n')[0]);
    }
    return returnByValue ? res.result?.value : res.result;
  }

  detachAll() {
    for (const off of this.#listeners) off();
    this.#listeners = [];
  }
}
