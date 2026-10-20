// What the tool did, as dated sentences a person reads top to bottom ("What happened" on History):
// from every run's event file in the folder (the runs journal, run-journal.mjs) and the ledger's
// rounds. Nothing here changes anything; it only reads.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLedger } from '../../src/ledger.mjs';
import { runsDir } from './run-journal.mjs';
import { ledgerPath } from './reports.mjs';

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return String(u || '');
  }
};
const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The words of one check of the site's build, as the Fix step shows them (without the time).
function checkWords(ev) {
  const expected = ev.expected ? String(ev.expected) : '';
  const served = ev.marker ? String(ev.marker) : '';
  if (ev.result === 'changed') return expected && served === expected ? `the build with marker ${expected} is live` : 'a new build is live';
  if (ev.result === 'unreadable') return `the start page could not be read (${ev.reason || 'the site may be down, or behind a sign-in'})`;
  if (ev.result === 'no-baseline') return 'no build from before the fixes on record, so this one is verified';
  if (expected) return `still a build without marker ${expected}${served ? ` (it serves ${served})` : ''}`;
  return 'still the build from before the fixes';
}

function doneWords(ev) {
  const o = ev.outcome;
  if (o === 'ok') return 'The loop finished: nothing left to fix';
  if (o === 'findings') return 'The loop ended: nothing more the assistant could fix this time';
  if (o === 'stopped') return 'Stopped';
  if (o === 'interrupted') return 'The loop was interrupted';
  if (o === 'awaiting-deploy') return 'The loop ended waiting for the deployment';
  return `The loop ended with an error${typeof ev.code === 'number' ? ` (exit code ${ev.code})` : ''}`;
}

// One run's events, narrated. Consecutive checks with the same result become one entry with a
// count; so do repeated identical lines (the sign-in wait's, every few seconds).
// Whether a crawl's search ran: forms it pressed Search on, the result pages those led to, and the
// pages it found by clicking and by revealed menus. Nothing when the crawl had no page events.
export function searchLine(pages) {
  if (!pages.length) return '';
  const sum = (k) => pages.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const ran = pages.some((p) => p.searched !== null && p.searched !== undefined);
  const searched = sum('searched');
  const results = sum('searchResults');
  const clicked = sum('clickedNew');
  const revealed = sum('revealed');
  const search = !ran ? 'search was not run' : !searched ? 'no search form was pressed (none found)' : `pressed Search on ${n(searched, 'form')}: ${results ? `${n(results, 'result page')} found` : 'no results came back'}`;
  const more = [clicked ? `${n(clicked, 'page')} found by clicking` : '', revealed ? `${n(revealed, 'link')} revealed by menus` : ''].filter(Boolean).join(', ');
  return `${search}${more ? `; ${more}` : ''}`;
}

export function narrate(events) {
  const out = [];
  const add = (ev, text, kind = 'info') => {
    const last = out[out.length - 1];
    if (last && last.text === text) {
      last.count = (last.count || 1) + 1;
      last.until = ev.at || last.until;
      return;
    }
    out.push({ at: ev.at || null, kind, text });
  };
  // A crawl's pages, until its summary: whether its search ran, and what it found.
  let crawled = [];
  for (const ev of events) {
    switch (ev.type) {
      case 'page':
        crawled.push(ev);
        break;
      case 'retry':
        add(ev, `Trying again (attempt ${ev.attempt})${ev.reason ? `: ${ev.reason}` : ''}`);
        break;
      case 'resume':
        add(ev, `Continued the interrupted loop${ev.n ? ` from fix ${ev.n} of ${ev.m}` : ''}${Array.isArray(ev.discarded) && ev.discarded.length ? `; discarded the unfinished change to ${ev.discarded.join(', ')}` : ''}`);
        break;
      case 'round':
        add(ev, ev.fromLedger ? `Round ${ev.round}: fixing the remaining findings from the ledger (no crawl)` : ev.resumed ? `Round ${ev.round}: continuing where it was interrupted` : `Round ${ev.round}: re-checking the site`);
        break;
      case 'summary':
        if (ev.summary) {
          add(ev, `${ev.round ? `Round ${ev.round}: ` : ''}crawled ${n(ev.summary.audited || 0, 'page')}: ${n(ev.summary.violations || 0, 'violation')}, ${ev.summary.reviews || 0} to review${ev.summary.coverage && ev.summary.coverage.complete === false ? ' (coverage incomplete)' : ''}`);
          const s = searchLine(crawled);
          if (s) add(ev, `${ev.round ? `Round ${ev.round}: ` : ''}${s}`);
        }
        crawled = [];
        break;
      case 'step':
        if (ev.step === 'triage') add(ev, `Round ${ev.round}: asked the assistant to judge ${n(ev.count || 0, 'review item')}`);
        else if (ev.step === 'fix') add(ev, `Round ${ev.round}: fixing ${n(ev.findings || ev.count || 0, 'finding')}${ev.findings && ev.count && ev.findings !== ev.count ? ` as ${n(ev.count, 'task')}` : ''}`);
        else if (ev.step === 'push') add(ev, `Round ${ev.round}: pushed ${n(ev.committed || 0, 'commit')}${ev.held ? `, ${ev.held} of them held while the deployment was awaited` : ''}`);
        // Fixed while a deployment was awaited: committed, and kept for the next push (one push per deployment).
        else if (ev.step === 'hold') add(ev, `Round ${ev.round}: held ${n(ev.committed || 0, 'commit')} for the next push (a deployment is awaited)`);
        break;
      case 'attempt': {
        const what = `${ev.test} ${String(ev.message || '').slice(0, 90)}`;
        const files = (ev.files || []).join(', ');
        if (ev.outcome === 'committed') add(ev, `Round ${ev.round}: fixed ${what}${files ? ` in ${files}` : ''}${ev.commit ? ` (commit ${ev.commit})` : ''}`, 'fixed');
        else if (ev.outcome === 'failed-gate') add(ev, `Round ${ev.round}: a fix for ${what} broke the build or tests; reverted`, 'problem');
        else if (ev.outcome === 'timed-out') add(ev, `Round ${ev.round}: the assistant ran out of time on ${what}`, 'problem');
        else if (ev.outcome === 'no-change') add(ev, `Round ${ev.round}: the assistant made no change for ${what}${ev.note ? ` (${ev.note})` : ''}`, 'problem');
        break;
      }
      case 'marker':
        add(ev, `Round ${ev.round}: build marker ${ev.token} committed in ${ev.file}`);
        break;
      case 'await-deploy':
        add(ev, `Round ${ev.round}: waiting for the deployment of ${ev.branch || 'the branch'}${ev.host ? ` to ${ev.host}` : ''}`);
        break;
      case 'deploy-check':
        add(ev, `Checked ${ev.host || 'the site'}: ${checkWords(ev)}`, 'check');
        break;
      case 'deployment':
        if (ev.state === 'arrived') add(ev, `Deployment arrived: verifying ${n(ev.pending || 0, 'fix')}`);
        else if (ev.state === 'verify-anyway') add(ev, ev.reason === 'no-baseline' ? `Verifying ${n(ev.pending || 0, 'fix')} (no build from before them on record)` : `Verifying ${n(ev.pending || 0, 'fix')} against the site as it is`);
        break;
      case 'login-waiting':
        add(ev, `Waiting for a sign-in${ev.url ? ` on ${hostOf(ev.url)}` : ''}`);
        break;
      case 'session-saved':
        add(ev, 'Signed in; the session is saved');
        break;
      case 'sign-in-opening':
        add(ev, `Opening the sign-in in ${ev.how === 'tab' ? 'a tab' : 'a window'} (${ev.why})`);
        break;
      case 'sign-in-failed':
        add(ev, `The sign-in did not happen: ${ev.reason}`, 'problem');
        break;
      case 'precondition':
        add(ev, `The loop could not start: ${ev.message}`, 'problem');
        break;
      case 'error':
        add(ev, `Error: ${ev.message}`, 'problem');
        break;
      case 'done':
        add(ev, doneWords(ev), ev.outcome === 'error' ? 'problem' : 'info');
        break;
      default:
        break;
    }
  }
  return out;
}

function readEvents(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev.type === 'string') out.push(ev);
    } catch {}
  }
  return out;
}

// Where a run's time went, from its events: crawling (a round's start to its crawl summary), fixing
// (the fix step to the push, or the round's end), waiting for deployments (the wait to the build's
// arrival or the run's end), and waiting for a sign-in. Also each deployment's wait, for an estimate.
export function timeOf(events, endAt = null) {
  const t = { crawling: 0, fixing: 0, waiting: 0, signIn: 0 };
  const deployments = [];
  const ms = (a, b) => Math.max(0, (Date.parse(b || '') || 0) - (Date.parse(a || '') || 0));
  let crawlAt = null;
  let fixAt = null;
  let waitAt = null;
  let signAt = null;
  const last = events.length ? events[events.length - 1].at : null;
  const end = endAt || last;
  for (const ev of events) {
    switch (ev.type) {
      case 'round':
        if (fixAt) {
          t.fixing += ms(fixAt, ev.at);
          fixAt = null;
        }
        if (!ev.fromLedger && !ev.resumed) crawlAt = ev.at;
        break;
      case 'summary':
        if (crawlAt) {
          t.crawling += ms(crawlAt, ev.at);
          crawlAt = null;
        }
        break;
      case 'step':
        if (ev.step === 'fix' || ev.step === 'triage') {
          if (!fixAt) fixAt = ev.at;
        } else if (ev.step === 'push' && fixAt) {
          t.fixing += ms(fixAt, ev.at);
          fixAt = null;
        }
        break;
      case 'await-deploy':
        if (fixAt) {
          t.fixing += ms(fixAt, ev.at);
          fixAt = null;
        }
        waitAt = ev.at;
        break;
      case 'deployment':
        if (waitAt && ev.state === 'arrived') {
          const w = ms(waitAt, ev.at);
          t.waiting += w;
          deployments.push(w);
          waitAt = null;
        }
        break;
      case 'login-waiting':
        if (!signAt) signAt = ev.at;
        break;
      case 'session-saved':
        if (signAt) {
          t.signIn += ms(signAt, ev.at);
          signAt = null;
        }
        break;
      case 'done':
        if (crawlAt) t.crawling += ms(crawlAt, ev.at);
        if (fixAt) t.fixing += ms(fixAt, ev.at);
        if (waitAt) t.waiting += ms(waitAt, ev.at);
        if (signAt) t.signIn += ms(signAt, ev.at);
        crawlAt = fixAt = waitAt = signAt = null;
        break;
      default:
        break;
    }
  }
  // A run still going: its open phase runs to now.
  if (end) {
    if (crawlAt) t.crawling += ms(crawlAt, end);
    if (fixAt) t.fixing += ms(fixAt, end);
    if (waitAt) t.waiting += ms(waitAt, end);
    if (signAt) t.signIn += ms(signAt, end);
  }
  return { ...t, deployments };
}

// Every run of the folder, oldest first, narrated, with the ledger's re-check results; newest first
// in the answer, at most `limit` entries. time: where the runs' time went, and how long the
// deployments took (count and average), for an estimate of the next.
export function journal(cwd, { limit = 1500 } = {}) {
  const dir = runsDir(cwd);
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.run.json'));
  } catch {}
  const records = names.map((f) => readJson(join(dir, f))).filter((r) => r && typeof r.id === 'string' && r.startedAt).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const entries = [];
  const time = { crawling: 0, fixing: 0, waiting: 0, signIn: 0 };
  const deployments = [];
  for (const r of records) {
    const kind = r.kind === 'loop' ? 'Fix loop' : r.kind === 'dry-run' ? 'Dry run' : r.kind === 'crawl' ? 'Crawl' : r.kind === 'login' ? 'Sign-in' : r.kind || 'Run';
    const url = (r.meta && r.meta.url) || (r.request && r.request.url) || '';
    entries.push({ at: r.startedAt, kind: 'run', text: `${kind} started${url ? ` for ${url}` : ''}${r.meta && r.meta.tool ? ` (build ${r.meta.tool})` : ''}` });
    const events = readEvents(join(dir, `${r.id}.events.ndjson`));
    entries.push(...narrate(events));
    if (r.kind === 'loop') {
      const done = events.some((e) => e.type === 'done');
      const tm = timeOf(events, done ? null : new Date().toISOString());
      for (const k of Object.keys(time)) time[k] += tm[k];
      deployments.push(...tm.deployments);
    }
  }
  const file = ledgerPath(cwd);
  if (existsSync(file)) {
    try {
      for (const r of loadLedger(file).rounds || []) {
        const d = r.diff || {};
        if (d.verified || d.failed) entries.push({ at: r.at || null, kind: 'verify', text: `Round ${r.round} re-check: ${n(d.verified || 0, 'fix')} verified, ${d.failed || 0} did not hold${d.new ? `, ${n(d.new, 'new finding')}` : ''}` });
      }
    } catch {}
  }
  entries.sort((a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0));
  const avg = deployments.length ? Math.round(deployments.reduce((a, b) => a + b, 0) / deployments.length) : null;
  return { entries: entries.slice(0, limit), runs: records.length, time, deployments: { count: deployments.length, avgMs: avg } };
}
