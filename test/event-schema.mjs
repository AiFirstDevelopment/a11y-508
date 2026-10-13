// The --events contract: every type the CLI emits and the fields each one must
// carry. Used by test/run.mjs, test/loop.mjs and the dashboard's server tests,
// so a renamed type or a dropped field turns all of them red.

const str = (v) => typeof v === 'string';
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const bool = (v) => typeof v === 'boolean';
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => Array.isArray(v);
const opt = (f) => (v) => v === undefined || v === null || f(v);
const oneOf = (...xs) => (v) => xs.includes(v);

export const EVENT_SCHEMA = {
  start: { kind: oneOf('crawl', 'troubleshoot', 'login', 'loop'), version: str, url: opt(str) },
  info: { message: str },
  warn: { message: str },
  error: { message: str },
  page: { url: str, finalUrl: str, title: str, status: opt(num), error: opt(str), skipped: opt(str), violations: num, reviews: num, byImpact: obj, durationMs: num, foundBy: str, modalOnLoad: opt(obj), servedWith: opt(num), links: num, clicked: opt(num), clickedNew: opt(num), skippedActions: arr, skippedActionsCount: num, done: num, discovered: num, limit: opt(num), round: opt(num) },
  progress: { url: str, phase: oneOf('loading', 'checks', 'keyboard', 'disclosures', 'frames', 'zoom', 'names', 'screenshots', 'discovery', 'search'), detail: opt(obj), elapsedMs: num, round: opt(num) },
  coverage: { complete: bool, warnings: arr, notes: arr, round: opt(num) },
  summary: { result: oneOf('pass', 'fail', 'incomplete', 'nothing-audited'), passed: bool, baseUrl: str, failOn: arr, summary: obj, files: obj, round: opt(num) },
  troubleshoot: { result: obj },
  'login-waiting': { url: str, stableSeconds: num },
  'session-saved': { file: str, summary: str },
  round: { round: num },
  step: { round: num, step: oneOf('crawl', 'report', 'triage', 'fix', 'gate', 'commit', 'push', 'deploy', 'await-deploy') },
  'agent-output': { round: num, task: num, kind: oneOf('fix', 'triage'), stream: oneOf('stdout', 'stderr'), text: str },
  task: { round: num, n: num, m: num, test: str, impact: str, message: str, state: oneOf('start', 'done'), outcome: opt(str) },
  ledger: { rounds: num, counts: obj, line: str },
  'await-deploy': { round: num, committed: num, nextRound: num },
  'agent-wait': { round: num, task: num, kind: oneOf('fix', 'triage'), reason: oneOf('quota'), delayMs: num, attempt: num, attempts: num },
  'agent-result': { round: num, task: num, kind: oneOf('fix', 'triage'), ok: bool, timedOut: bool, quota: bool, code: opt(num), message: opt(str) },
  gate: { round: num, state: oneOf('start', 'done'), check: str, n: opt(num), m: opt(num), ok: opt(bool), durationMs: opt(num), tail: opt(str) },
  'gate-output': { round: num, text: str },
  commit: { round: num, n: num, m: num, commit: str, files: arr },
  changes: { round: num, n: num, m: num, files: arr },
  attempt: { round: num, n: num, m: num, test: str, message: str, files: arr, outcome: oneOf('committed', 'failed-gate', 'no-change', 'timed-out', 'commit-failed'), commit: opt(str), agentMs: opt(num), gateMs: opt(num), gateCode: opt(num), gateTail: opt(str) },
  precondition: { code: oneOf('not-a-repo', 'dirty-tree', 'branch'), message: str, remedy: str },
  done: { code: num },
};

// Returns a list of problems with one event; empty when it fits the contract.
export function eventProblems(ev) {
  if (!obj(ev)) return ['not an object'];
  const shape = EVENT_SCHEMA[ev.type];
  if (!shape) return [`unknown type ${JSON.stringify(ev.type)}`];
  const problems = [];
  if (!str(ev.at) || Number.isNaN(Date.parse(ev.at))) problems.push(`${ev.type}: "at" is not a timestamp`);
  for (const [k, ok] of Object.entries(shape)) if (!ok(ev[k])) problems.push(`${ev.type}: bad ${k}: ${JSON.stringify(ev[k])}`);
  return problems;
}

// Parses NDJSON stdout; every line must be an event that fits the contract.
export function parseEvents(stdout) {
  const events = [];
  const problems = [];
  for (const [i, line] of stdout.split('\n').entries()) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1} is not JSON: ${line.slice(0, 120)}`);
      continue;
    }
    events.push(ev);
    problems.push(...eventProblems(ev).map((p) => `line ${i + 1}: ${p}`));
  }
  return { events, problems };
}
