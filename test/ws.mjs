// The WebSocket client used by --connect (src/ws.mjs): frame encoding and decoding at the length
// boundaries, masking, fragments, control frames, and the handshake against a local server.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { OP, WebSocketClient, decodeFrames, encodeFrame } from '../src/ws.mjs';

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String(e && e.stack ? e.stack : e).split('\n').join('\n       ')}`);
  }
};

console.log('websocket:');
await check('lengths 0, 125, 126, 65535 and 65536 use the 7-bit, 16-bit and 64-bit forms and round-trip', () => {
  for (const [len, headLen] of [[0, 2], [125, 2], [126, 4], [65535, 4], [65536, 10]]) {
    const payload = Buffer.alloc(len, 0x61);
    const plain = encodeFrame(OP.TEXT, payload, { mask: false });
    assert.equal(plain.length, headLen + len, `unmasked ${len}`);
    assert.equal(plain[1] & 0x7f, len < 126 ? len : len < 65536 ? 126 : 127);
    const masked = encodeFrame(OP.TEXT, payload, { maskKey: Buffer.from([1, 2, 3, 4]) });
    assert.equal(masked.length, headLen + 4 + len, `masked ${len}`);
    assert.equal(masked[1] & 0x80, 0x80, 'the mask bit is set');
    const { frames, rest } = decodeFrames(masked);
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].fin, true);
    assert.equal(frames[0].opcode, OP.TEXT);
    assert.deepEqual(frames[0].payload, payload);
  }
});
await check('the mask is applied byte by byte with the 4-byte key', () => {
  const f = encodeFrame(OP.TEXT, Buffer.from('abcdef'), { maskKey: Buffer.from([0xff, 0, 0xff, 0]) });
  assert.deepEqual([...f.subarray(6)], [0x61 ^ 0xff, 0x62, 0x63 ^ 0xff, 0x64, 0x65 ^ 0xff, 0x66]);
});
await check('a partial frame waits for the rest; two frames in one chunk are both read', () => {
  const a = encodeFrame(OP.TEXT, Buffer.from('one'), { mask: false });
  const b = encodeFrame(OP.TEXT, Buffer.from('two'), { mask: false });
  const half = decodeFrames(a.subarray(0, 3));
  assert.equal(half.frames.length, 0);
  assert.equal(half.rest.length, 3);
  const both = decodeFrames(Buffer.concat([a, b]));
  assert.deepEqual(both.frames.map((f) => f.payload.toString()), ['one', 'two']);
});
await check('a close frame carries its status code', () => {
  const code = Buffer.alloc(2);
  code.writeUInt16BE(1000);
  const { frames } = decodeFrames(encodeFrame(OP.CLOSE, code));
  assert.equal(frames[0].opcode, OP.CLOSE);
  assert.equal(frames[0].payload.readUInt16BE(0), 1000);
});

await check('handshake, a fragmented message, ping/pong, an echo and a close against a local server', async () => {
  const pongs = [];
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // A message in two fragments, then a ping.
    socket.write(encodeFrame(OP.TEXT, Buffer.from('hel'), { mask: false, fin: false }));
    socket.write(encodeFrame(OP.CONT, Buffer.from('lo'), { mask: false }));
    socket.write(encodeFrame(OP.PING, Buffer.from('p'), { mask: false }));
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      const { frames, rest } = decodeFrames(Buffer.concat([buf, d]));
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === OP.PONG) pongs.push(f.payload.toString());
        if (f.opcode === OP.TEXT) socket.write(encodeFrame(OP.TEXT, Buffer.from('echo:' + f.payload.toString()), { mask: false }));
        if (f.opcode === OP.CLOSE) socket.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ws = await WebSocketClient.connect(`ws://127.0.0.1:${server.address().port}/devtools/browser/x`);
    const got = [];
    ws.on('message', (m) => got.push(m));
    await new Promise((r) => setTimeout(r, 200));
    ws.send('x'.repeat(200));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(got, ['hello', 'echo:' + 'x'.repeat(200)]);
    assert.deepEqual(pongs, ['p']);
    const closed = new Promise((r) => ws.once('close', r));
    ws.close();
    await closed;
    assert.equal(ws.closed, true);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

console.log(failures ? `\n${failures} websocket assertion(s) failed` : '\nall websocket assertions passed');
process.exitCode = failures ? 1 : 0;
