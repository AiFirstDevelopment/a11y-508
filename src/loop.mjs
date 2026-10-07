// The autonomous fix loop: crawl, diff against the ledger, triage review
// items through the agent, fix open findings through the agent one at a
// time, gate each fix with the app's own build/test command, commit and push,
// wait for the deployment, and go round again until nothing is open or the
// person stops it. State lives in the ledger, so Ctrl+C and resume are safe.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReport, byStatus, isDone, loadLedger, openFindings, saveLedger, statusCounts } from './ledger.mjs';
import { agentEnv, fixPrompt, resolveAgentCommand, runAgent, triagePrompt, writePrompt } from './agent.mjs';
import { testInfo } from './checks/catalog.mjs';
import { sleep } from './page.mjs';

export const WORK_DIR = 'a11y-508-work';
const TOOL_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = join(TOOL_DIR, 'bin', 'a11y-508.mjs');

export function loadConfig(file, cwd) {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return { _path: path, _missing: true };
  let c;
  try {
    c = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  return { _path: path, ...c };
}

export function normalizeConfig(c, overrides = {}) {
  const cfg = {
    url: overrides.url || c.url || null,
    args: Array.isArray(c.args) ? c.args : [],
    agent: overrides.agent || c.agent || null,
    source: Array.isArray(c.source) && c.source.length ? c.source : ['src'],
    check: c.check || null,
    checkEvery: c.checkEvery === 'round' ? 'round' : 'finding',
    branch: c.branch || null,
    push: c.push !== false,
    deployed: c.deployed || (c.deploy ? 'command' : 'enter'),
    deploy: c.deploy || null,
    deployTimeout: typeof c.deployTimeout === 'number' ? c.deployTimeout : 30 * 60 * 1000,
    maxAttempts: typeof c.maxAttempts === 'number' ? c.maxAttempts : 3,
    agentTimeout: typeof c.agentTimeout === 'number' ? c.agentTimeout : 15 * 60 * 1000,
    triageBatch: typeof c.triageBatch === 'number' ? c.triageBatch : 15,
  };
  const errors = [];
  if (!cfg.url) errors.push('no start URL: pass it on the command line or set "url" in the config');
  if (!cfg.agent) errors.push('no agent: set "agent" in the config to claude, gemini, codex, or a command with {promptFile}');
  if (cfg.deployed === 'command' && !cfg.deploy) errors.push('"deployed" is "command" but no "deploy" command is set');
  if (!['command', 'bundle-change', 'enter', 'none'].includes(cfg.deployed)) errors.push(`"deployed" must be command, bundle-change, enter, or none (got ${cfg.deployed})`);
  if (cfg.deployed === 'enter' && !process.stdin.isTTY) errors.push('"deployed" is "enter" but there is no interactive terminal to press Enter in; set "deploy" or "deployed": "bundle-change"');
  return { cfg, errors };
}

const git = (cwd, args, opts = {}) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

// Changed paths under the given directories, from porcelain output (which
// must not be trimmed: the first two columns can be spaces).
const gitChanged = (cwd, paths = []) => {
  const r = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd, encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
};

const sh = (cwd, command, env) =>
  new Promise((r) => {
    const child = spawn(command, { cwd, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => (out = (out + d).slice(-8000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code) => r({ code, out }));
  });

async function crawlOnce({ cfg, cwd, round, log, passthrough }) {
  const out = join(cwd, WORK_DIR, `round-${round}`);
  mkdirSync(out, { recursive: true });
  const args = [BIN, cfg.url, ...cfg.args, ...passthrough, '--out', out, '--json', '--quiet'];
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-6000)));
  const code = await new Promise((r) => child.on('exit', r));
  writeFileSync(join(out, 'crawl.log'), stderr);
  const reportFile = join(out, 'report.json');
  if (!existsSync(reportFile)) throw new Error(`the crawl produced no report (exit ${code}):\n${stderr.split('\n').filter((l) => /error|warn|redirected/.test(l)).slice(-6).join('\n')}`);
  for (const l of stderr.split('\n')) if (/^(warn|error) /.test(l) && !/TOKEN is not set/.test(l)) log.warn(`crawl: ${l.replace(/^(warn|error) /, '')}`);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  return { report, code, out };
}

async function bundleSignature(url) {
  try {
    const headers = {};
    if (process.env.TOKEN) headers.authorization = /^\S+\s+\S/.test(process.env.TOKEN.trim()) ? process.env.TOKEN.trim() : `Bearer ${process.env.TOKEN.trim()}`;
    const res = await fetch(url, { headers, redirect: 'follow' });
    const html = await res.text();
    const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi)].map((m) => m[1]).sort();
    return refs.join('\n');
  } catch {
    return null;
  }
}

function waitForEnter(message) {
  process.stdout.write(message);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (chunk) => {
      if (!/[\r\n]/.test(String(chunk))) return;
      stdin.off('data', onData);
      stdin.pause();
      resolve();
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

export async function runLoop({ config, cwd, log, maxRounds = 20, dryRun = false, passthrough = [], stopSignal }) {
  const { cfg, errors } = normalizeConfig(config, { url: config._url, agent: config._agent });
  if (dryRun) errors.splice(0, errors.length, ...errors.filter((e) => !/agent|deploy|Enter/.test(e)));
  if (errors.length) {
    for (const e of errors) log.error(e);
    return 2;
  }
  const work = join(cwd, WORK_DIR);
  mkdirSync(work, { recursive: true });
  const ledgerFile = join(work, 'ledger.json');
  const ledger = loadLedger(ledgerFile);
  const save = () => saveLedger(ledgerFile, ledger);
  const protectedDirs = [relative(cwd, TOOL_DIR) || '.', WORK_DIR, 'a11y-508-report'];
  const agentCommand = resolveAgentCommand(cfg.agent);
  const sourceDirs = cfg.source;
  const stopped = () => stopSignal && stopSignal.stopped;

  if (!dryRun) {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']).out !== 'true') {
      log.error(`${cwd} is not a git repository; the loop commits each fix, so it needs one`);
      return 2;
    }
    const dirty = gitChanged(cwd, sourceDirs);
    if (dirty.length) {
      log.error(`uncommitted changes under ${sourceDirs.join(', ')}; commit or stash them first so the loop's commits contain only its own fixes:\n${dirty.join('\n')}`);
      return 2;
    }
    if (cfg.branch) {
      const current = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      if (current !== cfg.branch) {
        const sw = git(cwd, ['checkout', cfg.branch]);
        if (sw.code !== 0) {
          const mk = git(cwd, ['checkout', '-b', cfg.branch]);
          if (mk.code !== 0) {
            log.error(`cannot switch to branch ${cfg.branch}: ${mk.err}`);
            return 2;
          }
        }
        log.info(`on branch ${cfg.branch}`);
      }
    }
    if (!cfg.check) log.warn('no "check" command in the config: fixes are committed without a build or test gate');
  }

  const startRound = ledger.rounds.length + 1;
  log.info(`a11y-508 loop: ${cfg.url}  agent: ${cfg.agent}  ledger: ${relative(cwd, ledgerFile)}${ledger.rounds.length ? `  (resuming after round ${ledger.rounds.length})` : ''}`);

  for (let round = startRound; round < startRound + maxRounds; round++) {
    if (stopped()) break;
    log.info('');
    log.info(`=== round ${round}: crawl ===`);
    const signatureBefore = cfg.deployed === 'bundle-change' ? await bundleSignature(cfg.url) : null;
    let crawl;
    try {
      crawl = await crawlOnce({ cfg, cwd, round, log, passthrough });
    } catch (e) {
      log.error(`crawl failed: ${e.message}`);
      save();
      return 2;
    }
    const { report } = crawl;
    const s = report.summary;
    if (!s.audited) {
      log.error(`no page could be audited this round; the loop cannot continue. Run the crawl by hand with --troubleshoot.`);
      save();
      return 2;
    }
    const diff = applyReport(ledger, report, round, { maxAttempts: cfg.maxAttempts });
    save();
    log.info(`pages: ${s.pages} crawled, ${s.audited} audited  violations: ${s.violations}  review items: ${s.reviews}`);
    if (round > 1 || diff.verified.length) log.info(`since last round: ${diff.verified.length} verified fixed, ${diff.failed.length} fix(es) did not hold, ${diff.new.length} new, ${diff.still.length} still open, ${diff.gone.length} gone on their own, ${diff.reopened.length} came back, ${diff.unchecked.length} on pages not audited this round`);
    else log.info(`${diff.new.length} finding(s) recorded`);
    for (const e of diff.gaveUp) log.warn(`giving up on ${e.test} "${e.message.slice(0, 80)}" after ${e.attempts.length} attempts; marked needs-human`);
    for (const w of (s.coverage && s.coverage.warnings) || []) log.warn(`coverage: ${w}`);

    if (isDone(ledger)) {
      log.info('');
      log.info(`nothing left to fix. ${summaryLine(ledger)}`);
      return 0;
    }
    if (dryRun) {
      log.info(`dry run: ${summaryLine(ledger)}`);
      return 1;
    }
    if (stopped()) break;

    // Triage review items in batches.
    const review = byStatus(ledger, 'review');
    if (review.length) {
      log.info(`=== round ${round}: triage ${review.length} review item(s) ===`);
      for (let i = 0; i < review.length && !stopped(); i += cfg.triageBatch) {
        const batch = review.slice(i, i + cfg.triageBatch).map((e, k) => ({ id: `r${round}-${i + k}`, entry: e }));
        const items = batch.map(({ id, entry }) => ({ id, test: entry.test, name: entry.name, wcag: entry.wcag, condition: testInfo(entry.test).condition, message: entry.message, selector: entry.selector, html: entry.html, pages: entry.pages }));
        const promptFile = join(work, `prompt-r${round}-triage-${i}.md`);
        const resultFile = join(work, `result-r${round}-triage-${i}.json`);
        writePrompt(promptFile, triagePrompt({ items, resultFile }));
        const res = await runAgent({ command: agentCommand, promptFile, resultFile, cwd, timeout: cfg.agentTimeout });
        const decisions = Array.isArray(res.result) ? res.result : Array.isArray(res.result && res.result.items) ? res.result.items : null;
        if (!decisions) {
          log.warn(`triage batch ${i / cfg.triageBatch + 1}: the agent did not return a decision list (exit ${res.code}${res.timedOut ? ', timed out' : ''}); items stay in review`);
          continue;
        }
        for (const { id, entry } of batch) {
          const d = decisions.find((x) => x && x.id === id);
          const decision = d && typeof d.decision === 'string' ? d.decision.toLowerCase() : 'unsure';
          if (decision === 'adequate') entry.status = 'adequate';
          else if (decision === 'inadequate') entry.status = 'open';
          else entry.status = 'needs-human';
          entry.triage = { round, decision, reason: d && d.reason ? String(d.reason).slice(0, 300) : '' };
        }
        save();
      }
      const c = statusCounts(ledger);
      log.info(`triage done: ${byStatus(ledger, 'adequate').length} adequate, ${c.open || 0} open to fix, ${c['needs-human'] || 0} need a person`);
    }

    // Fix open findings, one bounded prompt each.
    const open = openFindings(ledger);
    log.info(`=== round ${round}: fix ${open.length} open finding(s) ===`);
    let committed = 0;
    const roundFixed = [];
    for (const [n, entry] of open.entries()) {
      if (stopped()) break;
      const label = `${entry.test} ${entry.impact} "${entry.message.slice(0, 70)}"`;
      log.info(`[${n + 1}/${open.length}] ${label}`);
      const promptFile = join(work, `prompt-r${round}-fix-${n}.md`);
      const resultFile = join(work, `result-r${round}-fix-${n}.json`);
      writePrompt(promptFile, fixPrompt({ finding: entry, sourceDirs, protectedDirs, resultFile, condition: testInfo(entry.test).condition }));
      const res = await runAgent({ command: agentCommand, promptFile, resultFile, cwd, timeout: cfg.agentTimeout });
      const changed = gitChanged(cwd, sourceDirs);
      const strayChanges = gitChanged(cwd).filter((f) => !changed.includes(f) && !f.startsWith(WORK_DIR) && !f.startsWith('a11y-508-report'));
      if (strayChanges.length) {
        log.warn(`  agent changed files outside ${sourceDirs.join(', ')}; reverting them: ${strayChanges.join(', ')}`);
        git(cwd, ['checkout', '--', ...strayChanges]);
        git(cwd, ['clean', '-fdq', '--', ...strayChanges]);
      }
      const note = res.result && res.result.note ? String(res.result.note).slice(0, 300) : res.timedOut ? 'agent timed out' : `agent exit ${res.code}, no result file`;
      const attempt = { round, files: changed, note, outcome: 'pending' };
      entry.attempts.push(attempt);
      if (!changed.length) {
        attempt.outcome = 'no-change';
        log.info(`  no change (${note})`);
        if (entry.attempts.length >= cfg.maxAttempts) {
          entry.status = 'needs-human';
          entry.reason = note;
          log.warn(`  marked needs-human after ${entry.attempts.length} attempts`);
        }
        save();
        continue;
      }
      if (cfg.check && cfg.checkEvery === 'finding') {
        log.info(`  checking: ${cfg.check}`);
        const gate = await sh(cwd, cfg.check, process.env);
        if (gate.code !== 0) {
          attempt.outcome = 'failed-gate';
          attempt.gateOutput = gate.out.slice(-2000);
          log.warn(`  check failed (exit ${gate.code}); reverting ${changed.join(', ')}`);
          git(cwd, ['checkout', '--', ...sourceDirs]);
          git(cwd, ['clean', '-fdq', '--', ...sourceDirs]);
          if (entry.attempts.length >= cfg.maxAttempts) {
            entry.status = 'needs-human';
            entry.reason = 'the fix broke the build or tests';
          }
          save();
          continue;
        }
      }
      git(cwd, ['add', '--', ...sourceDirs]);
      const msg = `a11y-508: ${entry.test} ${entry.name}: ${entry.message.slice(0, 72)}\n\nPages: ${entry.pages.slice(0, 5).join(', ')}\nSelector: ${entry.selector}\n${note}`;
      const c = git(cwd, ['commit', '-q', '-m', msg]);
      if (c.code !== 0) {
        log.warn(`  commit failed: ${c.err}`);
        attempt.outcome = 'no-change';
        save();
        continue;
      }
      attempt.commit = git(cwd, ['rev-parse', '--short', 'HEAD']).out;
      entry.status = 'pending';
      committed++;
      roundFixed.push(entry);
      log.info(`  committed ${attempt.commit}: ${changed.join(', ')}`);
      save();
    }

    if (committed && cfg.check && cfg.checkEvery === 'round') {
      log.info(`checking the round's ${committed} fix(es): ${cfg.check}`);
      const gate = await sh(cwd, cfg.check, process.env);
      if (gate.code !== 0) {
        log.warn(`check failed (exit ${gate.code}); rolling back this round's ${committed} commit(s)`);
        git(cwd, ['reset', '--hard', `HEAD~${committed}`]);
        for (const e of roundFixed) {
          const a = e.attempts[e.attempts.length - 1];
          a.outcome = 'failed-gate';
          a.gateOutput = gate.out.slice(-2000);
          delete a.commit;
          e.status = e.attempts.length >= cfg.maxAttempts ? 'needs-human' : 'open';
        }
        committed = 0;
        save();
      }
    }

    if (!committed) {
      log.info(`round ${round}: nothing was fixed. ${summaryLine(ledger)}`);
      if (!openFindings(ledger).length && !byStatus(ledger, 'review').length) {
        log.info('nothing left the agent can fix; stopping.');
        return isDone(ledger) ? 0 : 1;
      }
      if (!byStatus(ledger, 'pending').length) {
        log.warn('no fix was committed and nothing is pending, so another round would do the same work again; stopping.');
        return 1;
      }
    }

    if (committed && cfg.push) {
      const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      log.info(`pushing ${committed} commit(s) to origin/${branch}`);
      const p = git(cwd, ['push', '-u', 'origin', branch]);
      if (p.code !== 0) {
        log.error(`push failed: ${p.err}`);
        save();
        return 2;
      }
    }

    if (committed) {
      if (cfg.deployed === 'command') {
        log.info(`deploying: ${cfg.deploy}`);
        const d = await sh(cwd, cfg.deploy, process.env);
        if (d.code !== 0) {
          log.error(`deploy command failed (exit ${d.code}):\n${d.out.slice(-1500)}`);
          save();
          return 2;
        }
      } else if (cfg.deployed === 'bundle-change') {
        log.info('waiting for the deployment: polling the start page until its script bundles change');
        const until = Date.now() + cfg.deployTimeout;
        let live = false;
        while (Date.now() < until && !stopped()) {
          await sleep(15000);
          const sig = await bundleSignature(cfg.url);
          if (sig && sig !== signatureBefore) {
            live = true;
            break;
          }
        }
        if (!live) {
          if (stopped()) break;
          log.error(`the start page's bundles did not change within ${Math.round(cfg.deployTimeout / 60000)} minutes; stopping. Rerun the loop once the deployment is live.`);
          save();
          return 1;
        }
        log.info('new build is live; giving it 10 seconds to settle');
        await sleep(10000);
      } else if (cfg.deployed === 'enter') {
        await waitForEnter(`\nround ${round}: ${committed} fix(es) committed. Deploy them, then press Enter to start round ${round + 1} (Ctrl+C to stop)... `);
      }
    }
    log.info(`round ${round} done. ${summaryLine(ledger)}`);
  }
  if (stopped()) log.warn(`stopped. ${summaryLine(ledger)} Rerun the same command to resume.`);
  else log.warn(`reached --max-rounds. ${summaryLine(ledger)} Rerun to continue.`);
  save();
  return isDone(ledger) ? 0 : 1;
}

export function summaryLine(ledger) {
  const c = statusCounts(ledger);
  const part = (k, label) => (c[k] ? `${c[k]} ${label}` : null);
  return [part('open', 'open'), part('review', 'awaiting triage'), part('pending', 'pending verification'), part('verified', 'verified fixed'), part('needs-human', 'need a person'), part('wont-fix', "won't fix"), part('adequate', 'adequate'), part('gone', 'gone')].filter(Boolean).join(', ') + '.';
}

export function printStatus(cwd, out) {
  const file = join(cwd, WORK_DIR, 'ledger.json');
  if (!existsSync(file)) {
    out(`no ledger at ${relative(cwd, file)}; run "a11y-508 loop <url>" first`);
    return 0;
  }
  const ledger = loadLedger(file);
  out(`a11y-508 loop status: ${ledger.rounds.length} round(s). ${summaryLine(ledger)}`);
  for (const r of ledger.rounds.slice(-5)) out(`  round ${r.round} ${r.at || ''}: ${r.audited}/${r.pages} pages audited, ${r.violations} violations, ${r.reviews} review; +${r.diff.new} new, ${r.diff.verified} verified, ${r.diff.failed} did not hold${r.coverage && !r.coverage.complete ? ', coverage incomplete' : ''}`);
  const groups = [['open', 'OPEN'], ['pending', 'PENDING VERIFICATION'], ['review', 'AWAITING TRIAGE'], ['needs-human', 'NEEDS A PERSON']];
  for (const [status, title] of groups) {
    const list = byStatus(ledger, status);
    if (!list.length) continue;
    out(`\n${title} (${list.length})`);
    for (const e of list.slice(0, 40)) out(`  ${e.test} ${e.impact.padEnd(8)} ${e.message.slice(0, 90)}  [${e.pages.length} page(s), ${e.attempts.length} attempt(s)]${e.reason ? `  ${e.reason}` : ''}`);
    if (list.length > 40) out(`  ... and ${list.length - 40} more`);
  }
  return 0;
}
