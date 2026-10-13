// Stand-in for an AI coding assistant in the loop test. Reads the prompt
// file, finds the machine-readable block, and applies two deterministic fixes
// to the fixture site; everything else it declines. Triage marks everything
// adequate except the sensory-instruction item, which it calls inadequate.
// The dashboard's Test assistant prompt gets { ok: true }.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [promptFile, resultFile] = process.argv.slice(2);
// A few lines of output first, as a real assistant prints while it works.
// FAKE_AGENT_QUIET: nothing is printed until the slow call has waited, as `claude -p` prints
// nothing until it ends.
// FAKE_AGENT_429_ONCE: the first call is refused for rate limit, as a provider's free tier does.
const refuse = process.env.FAKE_AGENT_429_ONCE;
if (refuse && !existsSync(refuse)) {
  writeFileSync(refuse, '429');
  console.error('Error: 429 Too Many Requests (rate limit)');
  process.exit(1);
}
const quiet = !!process.env.FAKE_AGENT_QUIET;
if (!quiet) console.log('fake agent: reading the prompt');
// The dashboard's test of the live output: the first call takes a while, so its counter visibly runs.
const slow = process.env.FAKE_AGENT_SLOW_ONCE;
if (slow && !existsSync(slow)) {
  writeFileSync(slow, 'slow');
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_AGENT_SLOW_MS) || 4000));
}
if (quiet) console.log('fake agent: reading the prompt');
// FAKE_AGENT_STREAM_ONCE: the first call streams Gemini CLI's stream-json events, a few seconds
// apart (FAKE_AGENT_STREAM_MS), as a real assistant's actions arrive while it works.
const streamOnce = process.env.FAKE_AGENT_STREAM_ONCE;
if (streamOnce && !existsSync(streamOnce)) {
  writeFileSync(streamOnce, 'streamed');
  const gap = Number(process.env.FAKE_AGENT_STREAM_MS) || 1500;
  const emit = (e) => process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...e }) + '\n');
  const pause = () => new Promise((r) => setTimeout(r, gap));
  emit({ type: 'init', session_id: 'fake', model: 'fake-model' });
  emit({ type: 'tool_use', tool_name: 'read_file', tool_id: '1', parameters: { absolute_path: join(process.cwd(), 'site', 'index.html') } });
  await pause();
  emit({ type: 'tool_result', tool_id: '1', status: 'success' });
  emit({ type: 'message', role: 'assistant', content: 'Looking at the finding.\n', delta: true });
  await pause();
  emit({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: '2', parameters: { command: 'npm run build' } });
  await pause();
  emit({ type: 'tool_result', tool_id: '2', status: 'success' });
  emit({ type: 'result', status: 'success', stats: {} });
}
console.log('fake agent: looking at the finding');
// FAKE_AGENT_DELAY_MS: every call takes this long, as a real assistant's does.
if (Number(process.env.FAKE_AGENT_DELAY_MS) > 0) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_AGENT_DELAY_MS)));

const prompt = readFileSync(promptFile, 'utf8');
const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
const task = blocks.map((b) => { try { return JSON.parse(b); } catch { return null; } }).find((o) => o && (o.kind === 'fix' || o.kind === 'triage' || o.kind === 'test'));
const leaked = /fixture-token-123/.test(prompt) || !!process.env.TOKEN;
const write = (obj) => writeFileSync(resultFile, JSON.stringify(Array.isArray(obj) ? obj : { ...obj, leaked }, null, 2));

if (!task) {
  write({ fixed: false, note: 'no task block found' });
} else if (task.kind === 'test') {
  // The dashboard's "Test assistant" check.
  write({ ok: true });
} else if (task.kind === 'triage') {
  write(task.items.map((it) => ({ id: it.id, decision: it.test === '13.B' ? 'inadequate' : 'adequate', reason: 'fake agent' })));
} else {
  const f = task.finding;
  const edit = (rel, from, to) => {
    const file = join(process.cwd(), rel);
    if (!existsSync(file)) return false;
    const s = readFileSync(file, 'utf8');
    if (!s.includes(from)) return false;
    writeFileSync(file, s.replace(from, to));
    return true;
  };
  if (f.test === '7.A' && /no alt attribute/.test(f.message) && /photo\.png/.test(f.html)) {
    const ok = edit('site/index.html', '<img src="/img/photo.png" width="120" height="80">', '<img src="/img/photo.png" alt="Team photo from the 2025 kickoff" width="120" height="80">');
    write({ fixed: ok, files: ok ? ['site/index.html'] : [], note: ok ? 'added alt text to the photo' : 'could not find the image' });
  } else if (f.test === '13.C') {
    const ok = edit('site/index.html', '.low-contrast { color: #999; background: #fff; }', '.low-contrast { color: #555; background: #fff; }');
    write({ fixed: ok, files: ok ? ['site/index.html'] : [], note: ok ? 'darkened the low-contrast text' : 'could not find the rule' });
  } else if (f.test === '12.D' && process.env.FAKE_AGENT_FIX_IFRAME) {
    // FAKE_AGENT_FIX_IFRAME: a third fix (the loop's tests-once-per-round bisect needs one to blame).
    const ok = edit('site/index.html', '<iframe src="/about.html" width="300" height="100"></iframe>', '<iframe src="/about.html" title="About us" width="300" height="100"></iframe>');
    write({ fixed: ok, files: ok ? ['site/index.html'] : [], note: ok ? 'titled the iframe' : 'could not find the iframe' });
  } else if (f.test === '10.D' && /direct child/.test(f.message)) {
    // Deliberately breaks the gate: the check command fails when this marker is present.
    edit('site/index.html', '<ul><div>Not a list item</div></ul>', '<ul><li>Not a list item</li></ul><!-- BREAK-THE-BUILD -->');
    write({ fixed: true, files: ['site/index.html'], note: 'wrapped the item in li (and broke the build on purpose)' });
  } else {
    write({ fixed: false, files: [], note: `fake agent does not handle ${f.test}` });
  }
}
