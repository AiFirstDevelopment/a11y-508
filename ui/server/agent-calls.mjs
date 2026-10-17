// The assistant's calls, for the Log page's "Assistant calls": what each call of a run was, how it
// ended, and on request what it said (the agent-*.log the run wrote: a JSON header line, then the
// tail of its output), the prompt it was given and its answer file.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tasksDir, workDir } from '../../src/home.mjs';
import { streamModel } from '../../src/agent.mjs';
import { runsDir } from './run-journal.mjs';

// A PDF run's call: read, check, plan, confirm, verify, replan, fix-<finding>; n is its number in the run.
export const MANUAL_LABEL = /^[a-z]+(?:-[A-Za-z0-9_]{1,40})?$/;
export const CALL_N = /^\d{1,5}$/;
// A loop's call: r<round>-fix-<n> or r<round>-triage-<i>.
export const LOOP_NAME = /^r(\d{1,6})-(fix|triage)-(\d{1,6})$/;

const text = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

// { header, stdout, stderr } of one agent-*.log; null when it cannot be read.
export function parseAgentLog(raw) {
  if (typeof raw !== 'string') return null;
  const nl = raw.indexOf('\n');
  let header = null;
  try {
    header = JSON.parse(nl < 0 ? raw : raw.slice(0, nl));
  } catch {
    return null;
  }
  const rest = nl < 0 ? '' : raw.slice(nl + 1);
  const OUT = '--- stdout (tail)\n';
  const ERR = '\n--- stderr (tail)\n';
  const a = rest.indexOf(OUT);
  const b = rest.indexOf(ERR, a < 0 ? 0 : a);
  const stdout = a < 0 ? '' : rest.slice(a + OUT.length, b < 0 ? undefined : b);
  const stderr = b < 0 ? '' : rest.slice(b + ERR.length).replace(/\n$/, '');
  return { header, stdout, stderr };
}

// The row for one call, from its log's header (the file's time when the header has none).
function row(file, extra) {
  const parsed = parseAgentLog(text(file));
  if (!parsed) return null;
  const h = parsed.header || {};
  let at = typeof h.at === 'string' ? h.at : null;
  if (!at) {
    try {
      at = new Date(statSync(file).mtimeMs - (Number(h.durationMs) || 0)).toISOString();
    } catch {}
  }
  return {
    ...extra, at, code: typeof h.code === 'number' ? h.code : null, timedOut: !!h.timedOut, quota: !!h.quota, answered: !!h.result,
    durationMs: typeof h.durationMs === 'number' ? h.durationMs : null, assistant: typeof h.assistant === 'string' ? h.assistant : null,
    // The model, from the header, else from the stream's init line (docs/plans/read-from-parse.md AC 7).
    model: typeof h.model === 'string' && h.model ? h.model : streamModel(parsed.stdout),
  };
}

const byTime = (a, b) => String(a.at || '').localeCompare(String(b.at || '')) || (a.n || 0) - (b.n || 0);

// Every call of a PDF run, oldest first.
export function manualCalls(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  const out = [];
  for (const name of names) {
    const m = /^agent-(.+)-(\d+)\.log$/.exec(name);
    if (!m || !MANUAL_LABEL.test(m[1]) || !CALL_N.test(m[2])) continue;
    const r = row(join(dir, name), { label: m[1], n: Number(m[2]) });
    if (r) out.push(r);
  }
  return out.sort(byTime);
}

// One call of a PDF run, with what it said, its prompt and its answer file; null when there is none.
export function manualCall(cwd, dir, id, label, n) {
  if (!MANUAL_LABEL.test(label) || !CALL_N.test(String(n))) return null;
  const parsed = parseAgentLog(text(join(dir, `agent-${label}-${n}.log`)));
  if (!parsed) return null;
  const tasks = tasksDir(cwd);
  return { ...parsed, prompt: text(join(tasks, `prompt-manual-${id}-${label}-${n}.md`)), result: text(join(tasks, `result-manual-${id}-${label}-${n}.json`)) };
}

// When the latest fix loop started (its run record), or null.
export function latestLoopStart(cwd) {
  let best = null;
  let names = [];
  try {
    names = readdirSync(runsDir(cwd)).filter((n) => n.endsWith('.run.json'));
  } catch {}
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(runsDir(cwd), n), 'utf8'));
      if (r && ['loop', 'dry-run'].includes(r.kind) && r.startedAt && (!best || Date.parse(r.startedAt) > Date.parse(best))) best = r.startedAt;
    } catch {}
  }
  return best;
}

// Every call of the latest fix loop (every one on record when no loop run is known), oldest first,
// with its place in its round.
export function loopCalls(cwd) {
  const work = workDir(cwd);
  const since = Date.parse(latestLoopStart(cwd) || '') || 0;
  let names = [];
  try {
    names = readdirSync(work);
  } catch {}
  const out = [];
  for (const name of names) {
    const m = /^agent-(.+)\.log$/.exec(name);
    const p = m && LOOP_NAME.exec(m[1]);
    if (!p) continue;
    const r = row(join(work, name), { name: m[1], round: Number(p[1]), kind: p[2], n: Number(p[3]) });
    if (r && (!since || (Date.parse(r.at || '') || 0) >= since - 1000)) out.push(r);
  }
  // index: its place among the round's calls of its kind (1 first), of: how many there were.
  for (const r of out) {
    const same = out.filter((x) => x.kind === r.kind && x.round === r.round).map((x) => x.n).sort((a, b) => a - b);
    r.index = same.indexOf(r.n) + 1;
    r.of = same.length;
  }
  return out.sort((a, b) => byTime(a, b) || a.round - b.round);
}

// One call of the loop; null when there is none.
export function loopCall(cwd, name) {
  if (!LOOP_NAME.test(name)) return null;
  const parsed = parseAgentLog(text(join(workDir(cwd), `agent-${name}.log`)));
  if (!parsed) return null;
  const tasks = tasksDir(cwd);
  return { ...parsed, prompt: text(join(tasks, `prompt-${name}.md`)), result: text(join(tasks, `result-${name}.json`)) };
}
