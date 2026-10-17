import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers.mjs';
import { agentLog } from '../../../src/agent.mjs';
import { parseAgentLog } from '../agent-calls.mjs';

// The Log page's "Assistant calls": what a run's calls said, and nothing outside the run's own files.
test('assistant calls: listed and read back for a PDF run and a loop; a path that leaves the run is refused', async () => {
  const s = await startServer();
  try {
    const work = s.dirs().work;
    const tasks = join(work, 'tasks');
    const id = '20261017-120000';
    const dir = join(work, 'manual', id);
    mkdirSync(dir, { recursive: true });
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(dir, 'agent-read-1.log'), agentLog({ code: 0, stdout: 'I cannot open this file', stderr: 'warn', durationMs: 1200 }, { at: '2026-10-17T12:00:01.000Z', assistant: 'Gemini CLI' }));
    writeFileSync(join(tasks, `prompt-manual-${id}-read-1.md`), '# Read the PDF');
    writeFileSync(join(work, 'agent-r1-fix-0.log'), agentLog({ code: 0, result: { fixed: true }, stdout: 'fixed it', durationMs: 50 }, { at: new Date().toISOString(), assistant: 'Codex' }));
    writeFileSync(join(tasks, 'prompt-r1-fix-0.md'), '# Fix one');
    writeFileSync(join(tasks, 'result-r1-fix-0.json'), '{"fixed":true}');
    // Decoys outside the run's files.
    writeFileSync(join(s.cwd, 'secret.log'), 'outside');
    writeFileSync(join(work, 'agent-outside.log'), '{"code":0}\noutside');

    const list = await s.call('GET', `/api/manual/${id}/agent-calls`);
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.text), [{ label: 'read', n: 1, at: '2026-10-17T12:00:01.000Z', code: 0, timedOut: false, quota: false, answered: false, durationMs: 1200, assistant: 'Gemini CLI', model: null }]);
    const one = JSON.parse((await s.call('GET', `/api/manual/${id}/agent-calls/read/1`)).text);
    assert.equal(one.stdout, 'I cannot open this file');
    assert.equal(one.stderr, 'warn');
    assert.equal(one.prompt, '# Read the PDF');
    assert.equal(one.result, null);
    const loop = JSON.parse((await s.call('GET', '/api/loop/agent-calls')).text);
    assert.deepEqual(loop.map((c) => [c.name, c.round, c.kind, c.index, c.of, c.answered, c.assistant]), [['r1-fix-0', 1, 'fix', 1, 1, true, 'Codex']]);
    const fix = JSON.parse((await s.call('GET', '/api/loop/agent-calls/r1-fix-0')).text);
    assert.equal(fix.prompt, '# Fix one');
    assert.equal(fix.result, '{"fixed":true}');

    for (const p of [
      `/api/manual/${id}/agent-calls/..%2F..%2F..%2Fsecret/1`, `/api/manual/${id}/agent-calls/read/..%2F1`, `/api/manual/${id}/agent-calls/%2e%2e/1`, `/api/manual/${id}/agent-calls/read/1%2F..`,
      `/api/manual/..%2F..%2F/agent-calls`, `/api/manual/${id}/agent-calls/..%5C..%5Csecret/1`, `/api/manual/${id}/agent-calls/read-..%2F/1`,
      '/api/loop/agent-calls/..%2F..%2Fsecret', '/api/loop/agent-calls/outside', '/api/loop/agent-calls/r1-fix-0%2F..%2F..', '/api/loop/agent-calls/%2e%2e%2fsecret',
    ]) {
      const r = await s.call('GET', p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.text.includes('outside'), p);
    }
  } finally {
    await s.stop();
  }
});

// docs/plans/read-from-parse.md AC 7: the model a call ran on, from its header or its stream's init line.
test('assistant calls: the model a call ran on is listed, from the log header or the stream\'s init line', async () => {
  const s = await startServer();
  try {
    const id = '20261017-130000';
    const dir = join(s.dirs().work, 'manual', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-describe-1.log'), agentLog({ code: 0, result: {}, stdout: 'ok', durationMs: 60000, model: 'gemini-2.5-pro' }, { at: '2026-10-17T13:00:01.000Z', assistant: 'Gemini CLI' }));
    writeFileSync(join(dir, 'agent-check-1.log'), agentLog({ code: 0, result: {}, stdout: '{"type":"init","session_id":"s","model":"fake-1"}\n{"type":"result"}', durationMs: 50 }, { at: '2026-10-17T13:00:02.000Z', assistant: 'Node' }));
    writeFileSync(join(dir, 'agent-plan-1.log'), agentLog({ code: 0, result: {}, stdout: 'plain words', durationMs: 50 }, { at: '2026-10-17T13:00:03.000Z', assistant: 'Node' }));
    const list = JSON.parse((await s.call('GET', `/api/manual/${id}/agent-calls`)).text);
    assert.deepEqual(list.map((c) => [c.label, c.model]), [['describe', 'gemini-2.5-pro'], ['check', 'fake-1'], ['plan', null]]);
  } finally {
    await s.stop();
  }
});

test('assistant calls: a log reads back as its header, what it said and its errors', () => {
  const p = parseAgentLog(agentLog({ code: 2, timedOut: true, stdout: 'a\nb', stderr: '', durationMs: 5 }));
  assert.equal(p.header.code, 2);
  assert.equal(p.header.timedOut, true);
  assert.equal(p.stdout, 'a\nb');
  assert.equal(p.stderr, '');
  assert.equal(parseAgentLog('not json'), null);
});
