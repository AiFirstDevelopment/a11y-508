// Stand-in for an AI coding assistant in the loop test. Reads the prompt
// file, finds the machine-readable block, and applies two deterministic fixes
// to the fixture site; everything else it declines. Triage marks everything
// adequate except the sensory-instruction item, which it calls inadequate.
// The dashboard's Test assistant prompt gets { ok: true }.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
// FAKE_AGENT_SAY_FILES: names the prompt file by its full path, as a real assistant's output does.
if (process.env.FAKE_AGENT_SAY_FILES) console.log(`fake agent: prompt at ${promptFile}`);
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
  emit({ type: 'init', session_id: 'fake', model: 'fake-1' });
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
const task = blocks.map((b) => { try { return JSON.parse(b); } catch { return null; } }).find((o) => o && (o.kind === 'fix' || o.kind === 'triage' || o.kind === 'test' || /^manual-/.test(String(o.kind))));
const leaked = /fixture-token-123/.test(prompt) || !!process.env.TOKEN;
const write = (obj) => writeFileSync(resultFile, JSON.stringify(Array.isArray(obj) ? obj : { ...obj, leaked }, null, 2));

if (task && /^manual-/.test(task.kind)) {
  manual(task);
} else if (!task) {
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
  // A task can be one problem on several elements (task.elements): the photo among them, or the same image problem everywhere.
  const els = Array.isArray(task.elements) && task.elements.length ? task.elements : [f];
  if (f.test === '7.A' && /no alt attribute/.test(f.message) && els.some((e) => /photo\.png/.test(e.html || ''))) {
    const ok = edit('site/index.html', '<img src="/img/photo.png" width="120" height="80">', '<img src="/img/photo.png" alt="Team photo from the 2025 kickoff" width="120" height="80">');
    write({ fixed: ok, files: ok ? ['site/index.html'] : [], note: ok ? 'added alt text to the photo' : 'could not find the image' });
  } else if (f.test === '7.A' && /no alt attribute/.test(f.message) && els.length > 1) {
    const file = join(process.cwd(), 'site', 'index.html');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const after = before.replace(/<img src="(\/img\/[^"]+)">/g, '<img src="$1" alt="">');
    if (after !== before) writeFileSync(file, after);
    write({ fixed: after !== before, files: after !== before ? ['site/index.html'] : [], note: `marked the ${els.length} images decorative in one change` });
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

// ---- The manual flow (docs/plans/manual-findings.md), scripted by env:
// FAKE_MANUAL_PLAN_WRONG: the plan puts F1 (the search button) in HeaderComponent.
// FAKE_MANUAL_MISUNDERSTAND_ONCE=<file>: the first confirmation answers understood: false.
// FAKE_MANUAL_READ_FAIL=<n>: the first n describes answer with no list of answers.
// FAKE_MANUAL_READ_SILENT=1 (with it): those describes say "I cannot open this file" and write no answer at all.
// FAKE_MANUAL_READ_ECHO=1: a describe whose prompt does not quote its previous answer says only "Here is the original image:".
// docs/plans/read-from-parse.md AC 8:
// FAKE_MANUAL_DESCRIBE_SKIP=F3,F5: the first describe leaves those ids out; the second answers them.
// FAKE_MANUAL_DESCRIBE_EXTRA=F1: the describe adds a copy of F1's answer under an id the tool did not issue.
// FAKE_MANUAL_SAME_AS=F4:F1: F4's answer says sameAs F1.
// FAKE_MANUAL_SELECTORS_WRONG=F1: the describe gives F1 selectors that match nothing; the locate gives the right ones.
// FAKE_MANUAL_CHECK_SKIP=F2: the first check leaves F2's verdict out.
// Besides the plan's: FAKE_MANUAL_LOCATE_WRONG=F1 (the locate's selectors match nothing either),
// FAKE_MANUAL_ROUTE_DOWN=F2 (the describe puts F2 on a page that does not load, with selectors that
// match nothing), FAKE_MANUAL_VERIFY_SKIP=F1 and FAKE_MANUAL_CONFIRM_SKIP=F3 (the first verify or
// confirmation leaves that id out).
// The describe answers each candidate from its page's FINDING line (id | title | route | selectors |
// element | words): a tag other than the candidate's own id says the page shows that earlier finding
// (sameAs); a second FINDING line on a page is a second problem (extra); a page with none names no
// problem when it has no criterion. Its "seen" is "A fixture page showing <the candidate's quote>".
// The check and the verify judge from the evidence the tool captured (a button with no aria-label,
// an image with no alt, is the problem); a fix edits the approved component's file.
function manual(task) {
  const FINDING = /^FINDING (\S+) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*)$/;
  const ids = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = (obj) => writeFileSync(task.resultFile, JSON.stringify(obj, null, 2));
  const problem = (ev) => {
    if (!ev || !ev.loaded) return null;
    const html = (ev.elements || []).flatMap((m) => m.html || []);
    if (!html.length) return null;
    return html.some((h) => /^<button\b(?![^>]*\baria-label=)/.test(h) || /^<img\b(?![^>]*\balt=)/.test(h));
  };
  const second = prompt.includes('You did not answer for');
  if (task.kind === 'manual-describe') {
    // FAKE_MANUAL_READ_FAIL=<n>: the first n describes answer without a list (counted in a file beside
    // the result, in the run's tasks folder).
    const fails = Number(process.env.FAKE_MANUAL_READ_FAIL) || 0;
    if (fails) {
      const count = join(dirname(task.resultFile), 'fake-manual-read-fails');
      const n = existsSync(count) ? Number(readFileSync(count, 'utf8')) || 0 : 0;
      if (n < fails) {
        writeFileSync(count, String(n + 1));
        if (process.env.FAKE_MANUAL_READ_SILENT) return console.log(`I cannot open this file (read ${n + 1})`);
        return out({ note: 'I could not make out the findings in this PDF.' });
      }
      // Asked again: a moment before the answer, so the page's sentence for the wait can be seen.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
    // FAKE_MANUAL_READ_ECHO: a describe whose prompt does not say what the previous answer was answers
    // as Gemini CLI once did ("Here is the original image:", exit 0, no answer file).
    if (process.env.FAKE_MANUAL_READ_ECHO && !prompt.includes('Your previous answer was')) return console.log('Here is the original image:');
    // It reads the tool's parse, never the PDF: the prompt names report.md and the picture of each page, which exist.
    if (!task.report || !/report\.md$/.test(task.report) || !existsSync(task.report) || !prompt.includes(task.report)) return out({ error: 'the prompt names no parsed report (report.md)' });
    for (const c of task.candidates) if (!c.picture || !existsSync(c.picture) || !prompt.includes(c.picture)) return out({ error: `the prompt names no picture of page ${c.page}` });
    const skip = second ? [] : ids(process.env.FAKE_MANUAL_DESCRIBE_SKIP);
    const sameAs = Object.fromEntries(ids(process.env.FAKE_MANUAL_SAME_AS).map((p) => p.split(':')));
    const wrong = ids(process.env.FAKE_MANUAL_SELECTORS_WRONG);
    const noText = !task.candidates.some((c) => c.lines.length);
    const answers = [];
    for (const c of task.candidates) {
      if (skip.includes(c.id)) continue;
      const seen = `A fixture page showing ${c.quote || `the picture of page ${c.page}`}`;
      const tags = c.lines.map((l) => FINDING.exec(l)).filter(Boolean);
      const fields = (m) => ({ title: m[2], route: m[3], selectors: m[4].split(';').map((x) => x.trim()), element: m[5], expected: `${m[5]} has a text alternative` });
      let a;
      if (noText) {
        // A PDF with no text (a scan): every page the same search button, from the pictures.
        a = { id: c.id, seen, title: 'Search button has no accessible name', route: '/search', selectors: ['#search-btn'], element: 'the magnifier button in the pictures', expected: 'the button has a text alternative', sameAs: c.id === task.candidates[0].id ? null : task.candidates[0].id, decisions: [{ decision: 'read the problem from the pictures of the pages', reason: 'the PDF has no text' }] };
      } else if (!tags.length) {
        a = c.criterion ? { id: c.id, seen, title: `Page ${c.page}`, element: `the element on page ${c.page}`, route: '/', selectors: [], expected: '' } : { id: c.id, none: true, seen };
      } else {
        const m = tags[0];
        a = { id: c.id, seen, ...fields(m), sameAs: m[1] !== c.id ? m[1] : null, decisions: m[3] === '/' ? [{ decision: `took the home page for ${c.id}`, reason: 'the tester names no page; the header and footer are on every page' }] : [] };
        if (tags[1]) a.extra = { seen: `${seen}, and a second problem`, ...fields(tags[1]) };
      }
      if (sameAs[c.id]) a.sameAs = sameAs[c.id];
      if (wrong.includes(c.id)) a.selectors = ['#not-on-this-page'];
      if (ids(process.env.FAKE_MANUAL_ROUTE_DOWN).includes(c.id)) Object.assign(a, { route: 'http://127.0.0.1:9/', selectors: ['#not-on-this-page'] });
      answers.push(a);
    }
    const extra = ids(process.env.FAKE_MANUAL_DESCRIBE_EXTRA);
    for (const x of extra) {
      const a = answers.find((y) => y.id === x);
      if (a) answers.push({ ...a, id: 'F99', title: `${a.title} (an id the tool did not issue)` });
    }
    return out({ answers });
  }
  if (task.kind === 'manual-locate') {
    // The fixture's real route and selectors, from the finding's FINDING line.
    return out({ answers: task.items.map((it) => {
      const m = it.lines.map((l) => FINDING.exec(l)).filter(Boolean)[0];
      if (ids(process.env.FAKE_MANUAL_LOCATE_WRONG).includes(it.id)) return { id: it.id, route: m ? m[3] : '/', selectors: ['#still-not-on-this-page'], reason: 'a guess' };
      return m ? { id: it.id, route: m[3], selectors: m[4].split(';').map((x) => x.trim()), notOnThisRoute: false, reason: 'the element is in the deployed page under these selectors' } : { id: it.id, route: '/', selectors: [], reason: 'cannot tell' };
    }) });
  }
  if (task.kind === 'manual-check' || task.kind === 'manual-verify') {
    const skip = second ? [] : ids(process.env[task.kind === 'manual-check' ? 'FAKE_MANUAL_CHECK_SKIP' : 'FAKE_MANUAL_VERIFY_SKIP']);
    const list = (task.kind === 'manual-check' ? task.findings : task.items).filter((f) => !skip.includes(f.id || f.finding));
    return out(list.map((f) => {
      const p = problem(f.evidence);
      const id = f.id || f.finding;
      if (task.kind === 'manual-check') return { id, verdict: p === null ? 'unreachable' : p ? 'present' : 'gone', reason: p === null ? 'no element matched' : p ? 'the element still has no name' : 'the element has a name now' };
      return { finding: id, verdict: p === false ? 'fixed' : 'not-fixed', reason: p === false ? 'the element has a name in the deployed page' : 'the deployed page still shows the element without a name' };
    }));
  }
  const fileOf = (name) => (task.components || []).find((c) => c.name === name);
  const owner = (f) => {
    const sel = (f.selectors || []).join(' ');
    const id = (/#([\w-]+)/.exec(sel) || [])[1];
    const comps = task.components || [];
    const hit = comps.find((c) => existsSync(join(process.cwd(), c.file)) && (id ? readFileSync(join(process.cwd(), c.file), 'utf8').includes(`id="${id}"`) : /img/.test(sel) && readFileSync(join(process.cwd(), c.file), 'utf8').includes('<img')));
    return hit || comps[0];
  };
  if (task.kind === 'manual-plan' || task.kind === 'manual-replan') {
    const list = task.kind === 'manual-plan' ? task.findings : task.items.map((it) => ({ id: it.finding, title: it.finding, selectors: [], component: it.component }));
    return out({ items: list.map((f) => {
      let c = f.component || owner(f);
      if (task.kind === 'manual-plan' && process.env.FAKE_MANUAL_PLAN_WRONG && f.id === 'F1') c = fileOf('HeaderComponent') || c;
      return { finding: f.id, fix: `${task.kind === 'manual-replan' ? 'Try again: give' : 'Give'} the element the tester names an accessible name in ${c.name}.`, component: { name: c.name, file: c.file }, files: [c.file], decisions: [{ decision: `the element is rendered by ${c.name}`, reason: `${c.file} holds its markup` }] };
    }) });
  }
  if (task.kind === 'manual-confirm') {
    const once = process.env.FAKE_MANUAL_MISUNDERSTAND_ONCE;
    const refuse = once && !existsSync(once);
    if (refuse) writeFileSync(once, 'refused');
    const skip = second ? [] : ids(process.env.FAKE_MANUAL_CONFIRM_SKIP);
    return out(task.items.filter((it) => !skip.includes(it.finding)).map((it) => (refuse
      ? { finding: it.finding, understood: false, text: `${it.edit.component.name} does not render the element the tester describes.`, files: [] }
      : { finding: it.finding, understood: true, text: `I will ${it.edit.fix.replace(/^./, (c) => c.toLowerCase()).replace(/\.$/, '')} in ${it.edit.component.name}, ${it.edit.component.file}${it.original.component && it.original.component.name !== it.edit.component.name ? `, instead of ${it.original.component.name}` : ''}.`, files: [it.edit.component.file] })));
  }
  if (task.kind === 'manual-fix') {
    const rel = task.component && task.component.file;
    const file = rel ? join(process.cwd(), rel) : null;
    if (!file || !existsSync(file)) return out({ fixed: false, files: [], note: 'no component file to change' });
    let s = readFileSync(file, 'utf8');
    const id = (/#([\w-]+)/.exec((task.finding.selectors || []).join(' ')) || [])[1];
    const label = id ? id.replace(/-btn$/, '').replace(/^./, (c) => c.toUpperCase()) : 'Label';
    const before = s;
    const target = id && new RegExp(`<button id="${id}"(?![^>]*aria-label=)`).test(s) ? new RegExp(`<button id="${id}"(?![^>]*aria-label=)`) : /<button\b(?![^>]*aria-label=)/;
    const image = id && new RegExp(`<img id="${id}"(?![^>]*\\balt=)`);
    if (image && image.test(s)) s = s.replace(image, (m) => `${m} alt="${label}"`);
    else if (target.test(s)) s = s.replace(target, (m) => `${m} aria-label="${label}"`);
    else if (/<img\b(?![^>]*\balt=)/.test(s)) s = s.replace(/<img\b(?![^>]*\balt=)/, (m) => `${m} alt="${label}"`);
    else if (id) s = s.replace(new RegExp(`(<button id="${id}"[^>]*aria-label=")([^"]*)"`), (m, a, v) => `${a}${v} again"`);
    if (s === before) return out({ fixed: false, files: [], note: 'nothing to change' });
    writeFileSync(file, s);
    return out({ fixed: true, files: [rel], note: `gave the element an accessible name in ${task.component.name}`, decisions: [{ decision: `labelled it "${label}"`, reason: 'the visible icon means that' }] });
  }
  out({ error: `fake agent does not handle ${task.kind}` });
}
