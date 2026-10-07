// Stand-in for an AI coding assistant in the loop test. Reads the prompt
// file, finds the machine-readable block, and applies two deterministic fixes
// to the fixture site; everything else it declines. Triage marks everything
// adequate except the sensory-instruction item, which it calls inadequate.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [promptFile, resultFile] = process.argv.slice(2);
const prompt = readFileSync(promptFile, 'utf8');
const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
const task = blocks.map((b) => { try { return JSON.parse(b); } catch { return null; } }).find((o) => o && (o.kind === 'fix' || o.kind === 'triage'));
const leaked = /fixture-token-123/.test(prompt) || !!process.env.TOKEN;
const write = (obj) => writeFileSync(resultFile, JSON.stringify(Array.isArray(obj) ? obj : { ...obj, leaked }, null, 2));

if (!task) {
  write({ fixed: false, note: 'no task block found' });
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
  } else if (f.test === '10.D' && /direct child/.test(f.message)) {
    // Deliberately breaks the gate: the check command fails when this marker is present.
    edit('site/index.html', '<ul><div>Not a list item</div></ul>', '<ul><li>Not a list item</li></ul><!-- BREAK-THE-BUILD -->');
    write({ fixed: true, files: ['site/index.html'], note: 'wrapped the item in li (and broke the build on purpose)' });
  } else {
    write({ fixed: false, files: [], note: `fake agent does not handle ${f.test}` });
  }
}
