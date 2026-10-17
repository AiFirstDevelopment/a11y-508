// Where the assistant's answer is read from: the content it streamed into the result file first
// (Gemini CLI's write_file unescapes \" before saving, so the file on disk may not be valid JSON
// though the stream's copy is), the file second, its words last; and when the answer it wrote does
// not parse, the real cause (JSON.parse's message) rather than "ended without an answer".
// Run: node test/agent-answer.mjs

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentLog, noAnswerWhy, runAgent } from '../src/agent.mjs';
import { readable, samePath } from '../src/agent-stream.mjs';

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};
const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

// A fake assistant: prints the stream in its case folder, and writes that folder's file.txt (when
// there is one) to the result file it is given, as the real one would.
const root = mkdtempSync(join(tmpdir(), 'a11y-508-answer-'));
const fake = join(root, 'fake-assistant.mjs');
writeFileSync(fake, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , caseDir, resultFile] = process.argv;
process.stdout.write(readFileSync(join(caseDir, 'stream.jsonl'), 'utf8'));
if (existsSync(join(caseDir, 'file.txt'))) writeFileSync(resultFile, readFileSync(join(caseDir, 'file.txt'), 'utf8'));
`);
let n = 0;
// Runs the fake on a stream (a function of the result file's path) and a file, through runAgent.
const run = async (stream, file = null) => {
  const dir = join(root, `case-${++n}`);
  mkdirSync(dir);
  const resultFile = join(dir, 'result-manual-x-read-1.json');
  writeFileSync(join(dir, 'stream.jsonl'), stream(resultFile));
  if (file !== null) writeFileSync(join(dir, 'file.txt'), file);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} ${JSON.stringify(dir)} "{resultFile}"`;
  return runAgent({ command, promptFile: join(dir, 'prompt-manual-x-read-1.md'), resultFile, cwd: root, timeout: 20000, quotaDelays: [] });
};

// Gemini CLI's events around one write of the result file, and Claude Code's.
const geminiWrite = (file_path, content) => [
  { type: 'init', timestamp: 't', session_id: 's1', model: 'gemini-2.5-pro' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'Writing my findings.\n', delta: true },
  { type: 'tool_use', timestamp: 't', tool_name: 'write_file', tool_id: 'a', parameters: { file_path, content } },
  { type: 'tool_result', timestamp: 't', tool_id: 'a', status: 'success', output: 'Successfully created' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'I have written my findings to the specified JSON file. I am done.', delta: true },
  { type: 'result', timestamp: 't', status: 'success', stats: { total_tokens: 10, tool_calls: 1 } },
];
const geminiNoWrite = [
  { type: 'init', timestamp: 't', session_id: 's1', model: 'gemini-2.5-pro' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'I am done.', delta: true },
  { type: 'result', timestamp: 't', status: 'success', stats: { total_tokens: 10, tool_calls: 0 } },
];
const claudeWrite = (file_path, content) => [
  { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet', tools: ['Write'] },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path, content } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File created' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's' },
];

// What Gemini streamed (valid), and what its write_file left on disk (the \" unescaped: not JSON).
const escaped = '{"seen":"The \\"Form Panel\\" page is displayed","element":"\\"Bill of Lading\\" text input field"}';
const unescaped = '{"seen":"The "Form Panel" page is displayed","element":""Bill of Lading" text input field"}';
const parseError = (text) => {
  try {
    JSON.parse(text);
  } catch (e) {
    return e.message;
  }
  return null;
};

await check('(i) Gemini streamed valid JSON into the result file but saved it unescaped: the answer comes from the stream', async () => {
  const res = await run((f) => jsonl(...geminiWrite(f, escaped)), unescaped);
  assert.equal(res.code, 0);
  assert.deepEqual(res.result, JSON.parse(escaped));
  assert.equal(res.result.seen, 'The "Form Panel" page is displayed');
  assert.equal(res.answerError, undefined);
  assert.equal(JSON.parse(agentLog(res).split('\n')[0]).answerError, undefined);
  // The stream's copy comes first even when the file does parse.
  const both = await run((f) => jsonl(...geminiWrite(f, escaped)), '{"from":"file"}');
  assert.deepEqual(both.result, JSON.parse(escaped));
});
await check('(ii) no write in the stream: the answer comes from the file', async () => {
  const res = await run(() => jsonl(...geminiNoWrite), '{"from":"file"}');
  assert.deepEqual(res.result, { from: 'file' });
  assert.equal(res.answerError, undefined);
});
await check('(iii) a file that is not JSON and nothing usable in the stream: no answer, and the parse error is kept and worded', async () => {
  const res = await run(() => jsonl(...geminiNoWrite), unescaped);
  assert.equal(res.result, null);
  assert.equal(res.code, 0);
  assert.equal(res.answerError.source, 'file');
  assert.equal(res.answerError.message, parseError(unescaped));
  assert.equal(res.answerError.preview, unescaped.slice(0, 160));
  const m = / at position (\d+)/.exec(res.answerError.message);
  assert.equal(res.answerError.position, m ? Number(m[1]) : null);
  // The sentence the manual flow and the loop say names the real cause.
  const why = `Gemini CLI ${noAnswerWhy(res)}`;
  assert.match(why, /^Gemini CLI wrote an answer that is not valid JSON \(/);
  assert.ok(why.includes('not valid JSON'), why);
  assert.ok(why.includes(res.answerError.message), why);
  if (m) assert.ok(why.includes(`, at character ${m[1]}`), why);
  assert.ok(!/ended without an answer/.test(why), why);
  // The log's header carries it; a genuine no-answer keeps the old sentence.
  assert.deepEqual(JSON.parse(agentLog(res).split('\n')[0]).answerError, res.answerError);
  assert.equal(noAnswerWhy({ code: 0 }), 'ended without an answer (exit code 0)');
  assert.equal(noAnswerWhy({ code: 1, answerError: { source: 'file', message: 'Unexpected end of JSON input', position: null } }), 'wrote an answer that is not valid JSON (Unexpected end of JSON input)');
});
await check('(iii) the streamed content not parsing either: the stream is tried, then the file; the file\'s error is the one kept', async () => {
  const res = await run((f) => jsonl(...geminiWrite(f, '{"seen": nope')), unescaped);
  assert.equal(res.result, null);
  assert.equal(res.answerError.source, 'file');
  assert.equal(res.answerError.message, parseError(unescaped));
  const only = await run((f) => jsonl(...geminiWrite(f, '{"seen": nope')));
  assert.equal(only.result, null);
  assert.deepEqual([only.answerError.source, only.answerError.message, only.answerError.preview], ['stream', parseError('{"seen": nope'), '{"seen": nope']);
});
await check('(iv) Claude Code\'s Write of the result file: the answer comes from the stream', async () => {
  const res = await run((f) => jsonl(...claudeWrite(f, '{"from":"claude-stream","seen":"The \\"Form Panel\\" page"}')), '{"from":"file"}');
  assert.deepEqual(res.result, { from: 'claude-stream', seen: 'The "Form Panel" page' });
  assert.equal(res.answerError, undefined);
});
await check('(v) a write of another file is not the answer', async () => {
  const other = join(root, 'src', 'app', 'findings.json');
  const res = await run(() => jsonl(...geminiWrite(other, '{"from":"wrong-file"}')), '{"from":"file"}');
  assert.deepEqual(res.result, { from: 'file' });
  const none = await run(() => jsonl(...geminiWrite(other, '{"from":"wrong-file"}')));
  assert.equal(none.result, null);
  assert.equal(none.answerError, undefined);
  // And the decoder itself: only a write of the result file is kept, the last of them.
  const target = join(root, 'tasks', 'result-r1-fix-1.json');
  const { answer, lines } = readable(jsonl(...geminiWrite(other, '{"a":1}').slice(0, 4), ...geminiWrite(target, '{"b":2}').slice(2, 4), ...geminiWrite(target, '{"c":3}').slice(2)), { cwd: root, ignore: [join(root, 'tasks')], resultFile: target });
  assert.equal(answer, '{"c":3}');
  assert.equal(readable(jsonl(...geminiWrite(other, '{"a":1}')), { cwd: root, resultFile: target }).answer, null);
  // The readable lines are as before.
  assert.deepEqual(lines, ['Started (gemini-2.5-pro)', 'Writing my findings.', 'Writing src/app/findings.json', 'Writing tasks/result-r1-fix-1.json', 'Writing tasks/result-r1-fix-1.json', 'I have written my findings to the specified JSON file. I am done.', 'Done: 1 file changed']);
});
await check('(vi) on Windows the event\'s path matches the result file whatever its slashes and letter case', async () => {
  const want = 'C:\\Users\\Dev\\.a11y-508\\repos\\app-1\\work\\tasks\\result-manual-x-read-1.json';
  assert.equal(samePath('c:/users/dev/.a11y-508/repos/app-1/work/tasks/RESULT-manual-x-read-1.json', want, { platform: 'win32' }), true);
  assert.equal(samePath('C:\\Users\\Dev\\.a11y-508\\repos\\app-1\\work\\tasks\\result-manual-x-read-1.json', want, { platform: 'win32' }), true);
  assert.equal(samePath('C:\\Users\\Dev\\.a11y-508\\repos\\app-1\\work\\tasks\\result-manual-x-read-2.json', want, { platform: 'win32' }), false);
  assert.equal(samePath('tasks\\result-manual-x-read-1.json', want, { cwd: 'C:\\Users\\Dev\\.a11y-508\\repos\\app-1\\work', platform: 'win32' }), true);
  // Elsewhere the case matters, and a relative path is taken from cwd.
  assert.equal(samePath('/home/dev/tasks/Result.json', '/home/dev/tasks/result.json', { platform: 'linux' }), false);
  assert.equal(samePath('tasks/result.json', '/home/dev/tasks/result.json', { cwd: '/home/dev', platform: 'linux' }), true);
  assert.equal(samePath('', '/home/dev/tasks/result.json', { platform: 'linux' }), false);
  assert.equal(samePath(undefined, undefined, { platform: 'linux' }), false);
});

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
