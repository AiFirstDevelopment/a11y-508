// The assistants' streamed output, as the Fix step's pane shows it: recorded Gemini CLI and Claude
// Code stream-json in, one readable line per action out, never raw JSON
// (docs/plans/loop-resilience.md AC 12). And the presets ask for that stream.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRESETS, QUOTA } from '../src/agent.mjs';
import { readable, samePath, streamDecoder } from '../src/agent-stream.mjs';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};
const cwd = join(tmpdir(), 'app');
const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

// The shapes Gemini CLI's non-interactive mode writes with --output-format stream-json.
const GEMINI = jsonl(
  { type: 'init', timestamp: 't', session_id: 's1', model: 'gemini-2.5-pro' },
  { type: 'message', timestamp: 't', role: 'user', content: 'the whole prompt' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'I will look at ', delta: true },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'the header.\n', delta: true },
  { type: 'tool_use', timestamp: 't', tool_name: 'read_file', tool_id: 'a', parameters: { absolute_path: join(cwd, 'src', 'app', 'header.component.html') } },
  { type: 'tool_result', timestamp: 't', tool_id: 'a', status: 'success', output: '<header>…' },
  { type: 'tool_use', timestamp: 't', tool_name: 'grep_search', tool_id: 'b', parameters: { pattern: 'aria-label', path: 'src' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'b', status: 'success' },
  { type: 'tool_use', timestamp: 't', tool_name: 'replace', tool_id: 'c', parameters: { file_path: join(cwd, 'src', 'app', 'header.component.html'), old_string: 'x', new_string: 'y' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'c', status: 'success' },
  { type: 'tool_use', timestamp: 't', tool_name: 'write_file', tool_id: 'd', parameters: { file_path: 'src/app/header.component.css', content: '…' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'd', status: 'success' },
  { type: 'tool_use', timestamp: 't', tool_name: 'run_shell_command', tool_id: 'e', parameters: { command: 'npm run build' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'e', status: 'error', error: { type: 'SHELL', message: 'exit code 1' } },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'Fixed the label.', delta: true },
  { type: 'result', timestamp: 't', status: 'success', stats: { total_tokens: 10, tool_calls: 5 } },
);
// Claude Code's -p --output-format stream-json --verbose.
const CLAUDE = jsonl(
  { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet', tools: ['Read'] },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the prompt file.' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: join(cwd, 'a11y-508-work', 'prompt-r1-fix-0.md') } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the prompt' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'alt=', path: 'src' } }, { type: 'tool_use', id: 't3', name: 'Glob', input: { pattern: '**/*.html' } }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: join(cwd, 'src', 'index.html'), old_string: 'a', new_string: 'b' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', is_error: true, content: 'File has not been read yet' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'npm test', description: 'run tests' } }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added the alt text. Result: {"fixed": true}' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Added the alt text.', session_id: 's' },
);

check('loop-resilience AC12: Gemini CLI stream-json becomes one readable line per action, never JSON', () => {
  const { lines, recognized } = readable(GEMINI, { cwd });
  assert.equal(recognized, true);
  assert.deepEqual(lines, [
    'Started (gemini-2.5-pro)',
    'I will look at the header.',
    'Reading src/app/header.component.html',
    'Searching for "aria-label" in src',
    'Editing src/app/header.component.html',
    'Writing src/app/header.component.css',
    'Running npm run build',
    'Failed: exit code 1',
    'Fixed the label.',
    'Done: 2 files changed',
  ]);
  assert.ok(lines.every((l) => !l.startsWith('{')));
});
check('loop-resilience AC12: Claude Code stream-json becomes the same kind of lines', () => {
  const { lines, text } = readable(CLAUDE, { cwd });
  assert.deepEqual(lines, [
    'Started (claude-sonnet)',
    'Reading the prompt file.',
    'Reading a11y-508-work/prompt-r1-fix-0.md',
    'Searching for "alt=" in src',
    'Looking for files matching **/*.html',
    'Editing src/index.html',
    'Failed: File has not been read yet',
    'Running npm test',
    'Added the alt text. Result: {"fixed": true}',
    'Done: 1 file changed',
  ]);
  assert.ok(lines.every((l) => !l.startsWith('{')));
  // The assistant's own words keep its answer, for a command that prints it instead of writing the result file.
  assert.match(text, /\{"fixed": true\}/);
});
check('loop-resilience AC12: the lines arrive as the stream does, split anywhere; other output passes as it is', () => {
  const got = [];
  const d = streamDecoder((l) => got.push(l), { cwd });
  const all = 'plain text from a custom command\n' + GEMINI;
  for (let i = 0; i < all.length; i += 7) d.push(all.slice(i, i + 7));
  assert.equal(got[0], 'plain text from a custom command');
  // Before the end, the actions so far are already there.
  assert.ok(got.includes('Running npm run build'));
  d.end();
  assert.equal(got.at(-1), 'Done: 2 files changed');
  assert.deepEqual(readable('{"not": "an event"}\nnot json {\n').lines, ['{"not": "an event"}', 'not json {']);
});
check('loop-resilience AC12: a quota refusal inside a stream event is still seen as one', () => {
  const { text } = readable(jsonl({ type: 'error', timestamp: 't', severity: 'error', message: 'You exceeded your current quota (RESOURCE_EXHAUSTED)' }, { type: 'result', timestamp: 't', status: 'error', error: { type: 'API', message: 'status 429' } }));
  assert.match(text, QUOTA);
});
check('loop-resilience AC14: the loop words the closing line, so it is not read as the loop finishing', () => {
  const doneLine = (changed) => `Gemini CLI is done: ${changed} files changed — checking the fix next`;
  const { lines } = readable(GEMINI, { cwd, doneLine });
  assert.equal(lines.at(-1), 'Gemini CLI is done: 2 files changed — checking the fix next');
  assert.ok(!lines.includes('Done: 2 files changed'));
});
check('the result file and files outside the checkout do not count as changed', () => {
  const tasks = join(tmpdir(), 'home', '.a11y-508', 'repos', 'app-1', 'work', 'tasks');
  const write = (id, file_path) => [{ type: 'tool_use', timestamp: 't', tool_name: 'write_file', tool_id: id, parameters: { file_path, content: '…' } }, { type: 'tool_result', timestamp: 't', tool_id: id, status: 'success' }];
  const end = { type: 'result', timestamp: 't', status: 'success' };
  const only = jsonl(...write('a', join(tasks, 'result-r1-fix-1.json')), ...write('b', join(tmpdir(), 'elsewhere', 'x.txt')), ...write('c', '~/.a11y-508/repos/app-1/work/tasks/result-r1-fix-1.json'), end);
  assert.equal(readable(only, { cwd, ignore: [tasks] }).lines.at(-1), 'Done: no files changed');
  const one = jsonl(...write('a', join(tasks, 'result-r1-fix-1.json')), ...write('b', 'src/app/x.html'), end);
  assert.equal(readable(one, { cwd, ignore: [tasks] }).lines.at(-1), 'Done: 1 file changed');
});
check('pictures-and-routes AC1: the files the read tools opened are kept as absolute paths, resolved against cwd, for Gemini CLI and Claude Code alike', () => {
  const g = readable(GEMINI, { cwd });
  assert.deepEqual(g.opened, [join(cwd, 'src', 'app', 'header.component.html')]);
  const c = readable(CLAUDE, { cwd });
  assert.deepEqual(c.opened, [join(cwd, 'a11y-508-work', 'prompt-r1-fix-0.md')]);
  // Relative paths, read_many_files' list and absolute_path all count; a grep or a write does not.
  const many = jsonl(
    { type: 'tool_use', timestamp: 't', tool_name: 'read_many_files', tool_id: 'a', parameters: { paths: ['parsed/pages/page-02.png', join(cwd, 'parsed', 'pages', 'page-03.png')] } },
    { type: 'tool_use', timestamp: 't', tool_name: 'read_file', tool_id: 'b', parameters: { file_path: 'parsed/pages/page-04.png' } },
    { type: 'tool_use', timestamp: 't', tool_name: 'write_file', tool_id: 'c', parameters: { file_path: 'result.json', content: '{}' } },
    { type: 'tool_use', timestamp: 't', tool_name: 'grep_search', tool_id: 'd', parameters: { pattern: 'x', path: 'parsed/pages/page-05.png' } },
    { type: 'result', timestamp: 't', status: 'success' },
  );
  const r = readable(many, { cwd });
  assert.deepEqual(r.opened, [join(cwd, 'parsed', 'pages', 'page-02.png'), join(cwd, 'parsed', 'pages', 'page-03.png'), join(cwd, 'parsed', 'pages', 'page-04.png')]);
  assert.ok(r.opened.some((o) => samePath(o, 'parsed/pages/page-04.png', { cwd })));
  assert.ok(!r.opened.some((o) => samePath(o, 'parsed/pages/page-05.png', { cwd })));
  // The same helper, on Windows: case and slashes do not matter.
  assert.equal(samePath('C:\\Users\\dev\\Parsed\\pages\\page-02.png', 'c:/users/dev/parsed/pages/PAGE-02.PNG', { cwd: 'C:\\Users\\dev', platform: 'win32' }), true);
  assert.equal(samePath('page-02.png', 'C:\\Users\\dev\\page-02.png', { cwd: 'C:\\Users\\dev', platform: 'win32' }), true);
  // Nothing opened: an empty list, not a missing one.
  assert.deepEqual(readable('plain words\n', { cwd }).opened, []);
});
check('loop-resilience AC12: the Gemini and Claude presets ask for the stream', () => {
  assert.match(PRESETS.gemini, / --output-format stream-json /);
  assert.match(PRESETS.claude, / --output-format stream-json --verbose /);
  assert.match(PRESETS.gemini, / < "\{promptFile\}"$/);
});
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
