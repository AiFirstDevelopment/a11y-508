// The dashboard's side of the diagnostics diary (src/diary.mjs): what the dashboard was doing when
// something went away, the sentence a person reads for each diary entry, and the dashboard's own
// browser started with its stderr kept (so its last lines can be written down when it exits).

import { spawn } from 'node:child_process';
import { KILL_WORDS, codeText, exitCause, stderrRing } from '../../src/diary.mjs';

// What the active run was doing, from its events: { kind, round, step, n, lastEvent, words }, or null.
export function doingOf(run) {
  if (!run || run.status !== 'running') return null;
  let round = null;
  let step = null;
  let task = null;
  let gate = null;
  let page = null;
  let lastEvent = null;
  let loginWaiting = false;
  for (const e of run.events || []) {
    if (!e || e.type === 'raw') continue;
    lastEvent = e.type;
    if (e.type === 'round') round = e.round;
    if (e.type === 'step') {
      step = e.step;
      if (typeof e.round === 'number') round = e.round;
      if (e.step !== 'gate') gate = null;
    }
    if (e.type === 'task' && e.state === 'start') task = { n: e.n, m: e.m };
    if (e.type === 'gate') gate = e.state === 'start' ? { n: typeof e.n === 'number' ? e.n : null } : null;
    if (e.type === 'page') page = { done: e.done, discovered: e.discovered };
    if (e.type === 'login-waiting') loginWaiting = true;
    if (e.type === 'session-saved' || e.type === 'page') loginWaiting = false;
  }
  const kind = run.kind;
  let words;
  if (kind === 'loop' || kind === 'dry-run') {
    const n = (gate && gate.n) || (task && task.n) || null;
    const STEP = {
      crawl: 'crawling', report: 'writing the report', triage: 'sorting the findings', commit: 'committing a fix', push: 'pushing',
      deploy: 'deploying', 'await-deploy': 'waiting for the deploy',
    };
    if (gate || step === 'gate') words = n ? `checking fix ${n}` : 'checking the fixes';
    else if (step === 'fix') words = task ? `fixing ${task.n} of ${task.m}` : 'fixing';
    else words = STEP[step] || (kind === 'dry-run' ? 'the dry run' : 'the fix loop');
    if (round) words = `round ${round}, ${words}`;
  } else if (kind === 'login' || loginWaiting) words = 'waiting for the sign-in';
  else if (kind === 'install') words = 'installing an assistant';
  else words = page ? `${kind === 'troubleshoot' ? 'troubleshooting' : 'crawling'}, ${page.done} of ${page.discovered} pages done` : `starting the ${kind}`;
  return { kind, round, step, n: (gate && gate.n) || (task && task.n) || null, lastEvent, words };
}

const CAUSE_WORDS = { killed: 'Chrome was killed', crashed: 'Chrome crashed', 'closed normally': 'Chrome closed normally', 'exited unexpectedly': 'Chrome exited unexpectedly', exited: 'Chrome exited' };

export const timeOf = (at) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// "The dashboard's browser window closed at 4:52 PM (Chrome was killed — exit code 1, signal none —
// during round 2, checking fix 3; a11y-508 had just run Stop)."
export function ownExitMessage({ at, code, signal, doing, kill, platform = process.platform }) {
  const cause = CAUSE_WORDS[exitCause(code, signal, platform)];
  return `The dashboard's browser window closed at ${timeOf(at)} (${cause} — exit code ${codeText(code)}, signal ${signal || 'none'}${doing ? ` — during ${doing}` : ''}${kill ? `; a11y-508 had just run ${KILL_WORDS[kill] || kill}` : ''}).`;
}

const STOP_WORDS = { 'ctrl-c': 'Ctrl+C in its terminal', sigterm: 'it was asked to end (SIGTERM)', quit: 'Quit in the dashboard', idle: 'nothing used it for a day', crash: 'it crashed' };

// One diary entry in plain words, with its details (exit code, signal, stderr, error) as lines.
export function describeEntry(e) {
  const details = [];
  if ('code' in e || 'signal' in e) details.push(`exit code ${codeText(e.code)}, signal ${e.signal || 'none'}`);
  if (e.doing && e.type !== 'own-browser-exit') details.push(`the dashboard was ${e.doing}`);
  if (e.run && e.run.lastEvent) details.push(`last run event: ${e.run.lastEvent}`);
  if (e.error) details.push(...String(e.error).split('\n').slice(0, 12));
  if (Array.isArray(e.stderr) && e.stderr.length) details.push("Chrome's last output:", ...e.stderr.map((l) => `  ${l}`));
  let text;
  switch (e.type) {
    case 'own-browser-exit':
      text = e.message || ownExitMessage(e);
      break;
    case 'own-browser-start':
      text = `The dashboard's browser window opened (process ${e.browserPid}).`;
      break;
    case 'kill':
      text = `a11y-508 ran ${KILL_WORDS[e.kill] || e.kill}${e.target ? `, ending process ${e.target}${e.run ? ` (the ${e.run} run)` : ''}` : ''}.`;
      break;
    case 'kill-refused':
      text = `${String(e.message || 'refused to kill a protected process').replace(/^./, (c) => c.toUpperCase())}.`;
      break;
    case 'crawl-browser-died':
      text = `${e.connected ? 'The browser a crawl was using (the dashboard\'s window) went away' : "A crawl's browser closed mid-crawl"}: ${e.cause}${e.relaunching ? '; it was started again' : ''}.`;
      break;
    case 'crawl-browser-relaunched':
      text = `The crawl's browser was started again after ${e.afterPages} page(s); the crawl went on.`;
      break;
    case 'sign-in-browser-died':
      text = `The sign-in browser closed: ${e.cause}.`;
      break;
    case 'run-ended':
      text = `The ${e.kind} run ${e.outcome === 'interrupted' ? 'was interrupted' : 'failed'}${e.code !== null && e.code !== undefined ? ` (exit code ${e.code})` : ''}${e.reason ? `: ${e.reason}` : ''}${e.doing ? `, during ${e.doing}` : ''}.`;
      break;
    case 'server-start':
      text = `The dashboard started for ${e.cwd} (process ${e.pid}).`;
      break;
    case 'server-stop':
      text = `The dashboard stopped: ${STOP_WORDS[e.reason] || e.reason}.`;
      break;
    default:
      text = e.message || e.type;
  }
  return { at: e.at, type: e.type, text, details };
}

// A .js/.mjs "browser" is a stand-in run with Node (tests), as src/chrome.mjs does for the crawl's.
export function browserCommand(exe, args) {
  return /\.m?js$/i.test(exe) ? [process.execPath, [exe, ...args]] : [exe, args];
}

// Starts the dashboard's own browser with its stderr piped into a ring of its last 50 lines (always
// drained, so it never blocks). Chrome on Windows writes its log to stderr only when asked.
export function spawnOwnBrowser(exe, args) {
  const [cmd, argv] = browserCommand(exe, [...args, ...(process.platform === 'win32' ? ['--enable-logging=stderr'] : [])]);
  const proc = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
  const tail = stderrRing(proc.stderr, 50);
  let ended = false;
  proc.stderr.on('end', () => (ended = true));
  proc.stderr.on('close', () => (ended = true));
  // Resolves once what the browser wrote before it exited has been read (or after 500 ms).
  const drained = () =>
    new Promise((resolve) => {
      if (ended) return resolve();
      const t = setTimeout(resolve, 500);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      proc.stderr.once('end', done);
      proc.stderr.once('close', done);
    });
  return { proc, tail, drained };
}
