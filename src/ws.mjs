// A minimal WebSocket client (RFC 6455) in plain Node, for attaching to a browser that is already
// running (--connect): the opening handshake, masked client frames, fragmented and control
// frames from the server. Text frames only carry the DevTools protocol's JSON. No dependencies.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// One frame. Client frames are masked (RFC 6455 5.3); the length takes 7 bits, or 126 and 16 bits,
// or 127 and 64 bits.
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = true, fin = true, maskKey = randomBytes(4) } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  const head = [(fin ? 0x80 : 0) | opcode];
  let ext = Buffer.alloc(0);
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) {
    head.push((mask ? 0x80 : 0) | 126);
    ext = Buffer.alloc(2);
    ext.writeUInt16BE(len);
  } else {
    head.push((mask ? 0x80 : 0) | 127);
    ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(len));
  }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, data]);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ maskKey[i % 4];
  return Buffer.concat([Buffer.from(head), ext, maskKey, body]);
}

// Reads the frames complete in buf: { frames: [{ fin, opcode, payload }], rest }.
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    let key = null;
    if (masked) {
      if (buf.length - p < 4) break;
      key = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// A connection: emits 'message' (string), 'close'; send(text); close().
export class WebSocketClient extends EventEmitter {
  #socket;
  #buf = Buffer.alloc(0);
  #parts = [];
  #closed = false;

  static connect(url, { timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === 'wss:';
      const port = Number(u.port || (secure ? 443 : 80));
      const socket = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
      const key = randomBytes(16).toString('base64');
      const expect = createHash('sha1').update(key + GUID).digest('base64');
      let head = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`WebSocket handshake with ${url} timed out`));
      }, timeout);
      const onError = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      socket.once('error', onError);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        socket.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      const onData = (d) => {
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        clearTimeout(timer);
        const lines = head.subarray(0, end).toString('latin1').split('\r\n');
        const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0]);
        const accept = lines.map((l) => /^sec-websocket-accept:\s*(.+)$/i.exec(l)).find(Boolean);
        if (!status || status[1] !== '101' || !accept || accept[1].trim() !== expect) {
          socket.destroy();
          return reject(new Error(`WebSocket handshake with ${url} failed: ${lines[0]}`));
        }
        socket.off('error', onError);
        const ws = new WebSocketClient(socket);
        const rest = Buffer.from(head.subarray(end + 4));
        resolve(ws);
        // Frames that came with the handshake reply are read once the caller has its listeners on.
        if (rest.length) setImmediate(() => ws.#onData(rest));
      };
      socket.on('data', onData);
    });
  }

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.#onData(d));
    socket.on('close', () => this.#end());
    socket.on('error', () => this.#end());
  }

  get closed() {
    return this.#closed;
  }

  #end() {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close');
  }

  #onData(chunk) {
    const { frames, rest } = decodeFrames(Buffer.concat([this.#buf, chunk]));
    this.#buf = Buffer.from(rest);
    for (const f of frames) {
      if (f.opcode === OP.PING) this.#socket.write(encodeFrame(OP.PONG, f.payload));
      else if (f.opcode === OP.CLOSE) {
        if (!this.#closed) this.#socket.write(encodeFrame(OP.CLOSE, f.payload.subarray(0, 2)));
        this.#socket.end();
        this.#end();
      } else if (f.opcode === OP.TEXT || f.opcode === OP.BINARY || f.opcode === OP.CONT) {
        this.#parts.push(f.payload);
        if (f.fin) {
          const msg = Buffer.concat(this.#parts).toString('utf8');
          this.#parts = [];
          this.emit('message', msg);
        }
      }
    }
  }

  send(text, cb) {
    if (this.#closed) return cb && cb(new Error('WebSocket closed'));
    this.#socket.write(encodeFrame(OP.TEXT, Buffer.from(text, 'utf8')), cb);
  }

  close() {
    if (this.#closed) return;
    try {
      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000);
      this.#socket.write(encodeFrame(OP.CLOSE, code));
      this.#socket.end();
    } catch {}
    setTimeout(() => this.#socket.destroy(), 1000).unref();
    this.#end();
  }
}

// The Cdp class reads NUL-terminated messages from a stream and writes them to one; this makes a
// WebSocket look like that pair.
export function cdpStreams(ws) {
  const reader = new EventEmitter();
  ws.on('message', (m) => reader.emit('data', Buffer.from(m + '\0', 'utf8')));
  ws.on('close', () => reader.emit('close'));
  const writer = new EventEmitter();
  writer.write = (text, cb) => ws.send(String(text).replace(/\0$/, ''), cb);
  return { reader, writer };
}
