// The manual flow (docs/plans/manual-findings.md): fix what a tester found by hand, from their PDF,
// under the developer's approval. The assistant reads the PDF; the tool checks each finding against
// the deployed site (evidence it captures itself) and reports what is already fixed; the assistant
// plans the rest; the developer edits the plan and the assistant confirms each edit, until the
// developer approves; then each item is fixed and committed through the loop's own machinery,
// pushed, awaited, and verified in the deployed site, with one automatic retry and then a revised
// plan for what still did not hold. Every decision is logged in decisions.ndjson and, at the end,
// decisions.md. The plan approval is the one thing a person decides.
//
// The PDF is parsed first (docs/plans/pdf-parse.md): parsed/report.md, the one file the read prompt
// points at, with each page's text, recognised facts and pictures; the tool checks the assistant's
// pages, quotes, statuses and criteria against it and logs every correction.
//
// Files, under <work>/manual/<id>/: source.pdf, parsed/ (report.md, manifest.json, pages/*.png), findings.json, check.json, already-fixed.md,
// plan.json (the current version) and plan-v1.json, plan-v2.json, ..., plan-edit.json (the
// developer's edits, written by the dashboard), state.json, decisions.ndjson, decisions.md, and
// evidence/<finding>/{before,after-1,after-2,...}/.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRESET_INFO, QUOTA_DELAYS, agentLabel, agentLog, manualCheckPrompt, manualConfirmPrompt, manualFixPrompt, manualPlanPrompt, manualReadPrompt, manualReplanPrompt, manualVerifyPrompt, resolveAgentCommand, writePrompt,
} from './agent.mjs';
import { callAgent, findIndexHtml, frameworkLine, git, gitChanged, normalizeConfig, prepareRepo, sessionArgs, sh, signInOnly, splitCheck, stampBuildMarker, testRoundFixes, waitForEnter } from './loop.mjs';
import { migrateRepo, migrationLines, reportDir, shortenHome, tasksDir, workDir } from './home.mjs';
import { evidenceBrowser } from './evidence.mjs';
import { listComponents, findComponent } from './components.mjs';
import { bundleSignature, sameBuild } from './deploy-check.mjs';
import { sleep } from './page.mjs';
import { commitWebUrl, remoteWeb } from './git-web.mjs';
import { parsePdf } from './pdf-parse.mjs';

const TOOL_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MANUAL_DIR = 'manual';
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const NOT_A_PDF = 'That file is not a PDF. Choose the PDF report the tester sent.';
export const NO_FINDINGS = 'The PDF names no accessibility findings the assistant could read.';
export const PARSED_DIR = 'parsed';
// The browser a run's arguments name (--chrome <path> or --chrome=<path>), or null.
export const chromeOf = (args) => {
  const i = args.findIndex((a) => a === '--chrome' || a.startsWith('--chrome='));
  return i < 0 ? null : args[i].startsWith('--chrome=') ? args[i].slice(9) : args[i + 1] || null;
};

// "28 Sep 2026" from 2026-09-28.
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayOf = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH[Number(m[2]) - 1]} ${m[1]}` : null;
};
// What the tester's verdict and the deployed site together say (AC 7 of docs/plans/pdf-parse.md).
export const testerVerified = (f) => `The tester verified this fixed${dayOf(f.statusDate) ? ` on ${dayOf(f.statusDate)}` : ''}; the deployed site agrees.`;
export const cameBackLine = (f) => `Came back: the tester verified this fixed${dayOf(f.statusDate) ? ` on ${dayOf(f.statusDate)}` : ''}, but the deployed site has it again`;
// The words "N was/were already fixed (V of them the tester had verified)", for the Done lines.
export function alreadyWords(g, v) {
  const was = `${g} ${g === 1 ? 'was' : 'were'} already fixed`;
  if (!v) return was;
  return `${was} (${v === g ? (g === 1 ? 'the tester had verified it' : 'the tester had verified all of them') : `${v} of them the tester had verified`})`;
}
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
const pagesWords = (ns) => (ns.length === 1 ? `page ${ns[0]}` : `pages ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

// The assistant's findings checked against the parse (AC 6): pages that exist, a quote that is on one of
// them (else moved to the page it is on, or kept with quoteVerified false), and the status and
// criterion the report recognised for those pages. decide(stage, finding, by, decision, reason).
export function checkFindings(findings, manifest, decide) {
  const pages = (manifest && manifest.pages) || [];
  const M = (manifest && manifest.pageCount) || pages.length;
  const byN = new Map(pages.map((p) => [p.n, p]));
  const textOf = (n) => squash((byN.get(n) || { lines: [] }).lines.join(' '));
  const hasText = pages.some((p) => p.lines && p.lines.length);
  const out = [];
  for (const f of findings) {
    const given = f.pages;
    const ok = given.filter((n) => n >= 1 && n <= M);
    const bad = given.filter((n) => !(n >= 1 && n <= M));
    if (!ok.length) {
      decide('read', f.id, 'tool', 'dropped', `the assistant gave ${pagesWords(bad)} for it; the PDF has ${M} page${M === 1 ? '' : 's'}`);
      continue;
    }
    if (bad.length) decide('read', f.id, 'tool', `left out ${pagesWords(bad)}`, `the PDF has ${M} page${M === 1 ? '' : 's'}`);
    let list = ok;
    let pagesOk = !bad.length;
    let quote = null;
    if (f.quote && hasText) {
      const q = squash(f.quote);
      if (list.some((n) => textOf(n).includes(q))) quote = true;
      else {
        const other = pages.find((p) => !list.includes(p.n) && textOf(p.n).includes(q));
        if (other) {
          decide('read', f.id, 'tool', `moved to page ${other.n}`, `the quote is on page ${other.n}, not ${pagesWords(list)}`);
          list = [other.n];
          pagesOk = false;
          quote = true;
        } else {
          quote = false;
          decide('read', f.id, 'tool', 'kept it, although its quote is on no page of the PDF', `"${f.quote.slice(0, 120)}" is not in the text of ${pagesWords(list)} or any other page`);
        }
      }
    }
    // The report's facts for its pages: the first status, the criteria.
    const withStatus = list.map((n) => byN.get(n)).find((p) => p && p.status);
    const known = withStatus ? withStatus.status : null;
    let status = f.status;
    let statusDate = null;
    if (known) {
      if (status && status !== known.value) decide('read', f.id, 'tool', `status ${known.value}, not ${status}`, `the report reads "${known.words}" on page ${withStatus.n}`);
      status = known.value;
      statusDate = known.date || null;
    }
    const ids = [...new Set(list.flatMap((n) => ((byN.get(n) || {}).criteria || []).map((c) => c.id)))];
    let criterion = f.criterion;
    if (ids.length && !ids.includes(criterion)) {
      if (criterion) decide('read', f.id, 'tool', `criterion ${ids[0]}, not ${criterion}`, `the report names ${ids.join(', ')} on ${pagesWords(list)}`);
      criterion = ids[0];
    }
    out.push({ ...f, pages: list, page: list[0], status, statusDate, criterion: criterion || null, quoteVerified: quote, verified: { pages: pagesOk, quote } });
  }
  return out;
}

export const isPdf = (buf) => !!buf && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
export const manualRoot = (cwd) => join(workDir(cwd), MANUAL_DIR);
export const manualDir = (cwd, id) => join(manualRoot(cwd), id);
// <id>: a timestamp slug, 20261016-143005, with -2, -3 ... when one is taken.
export function newManualId(cwd, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const base = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let id = base;
  for (let i = 2; existsSync(manualDir(cwd, id)); i++) id = `${base}-${i}`;
  return id;
}
export const validId = (id) => typeof id === 'string' && /^\d{8}-\d{6}(-\d+)?$/.test(id);

const readJson = (f, fallback = null) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).trim().slice(0, max));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The routes the tool knows for the app: every page its crawls reached (the loop's rounds and the
// latest report), as full URLs.
export function knownRoutes(cwd) {
  const urls = new Set();
  const add = (file) => {
    const r = readJson(file);
    for (const p of (r && r.pages) || []) if (p && (p.finalUrl || p.url)) urls.add(p.finalUrl || p.url);
  };
  try {
    for (const d of readdirSync(workDir(cwd))) if (/^round-\d+$/.test(d)) add(join(workDir(cwd), d, 'report.json'));
  } catch {}
  add(join(reportDir(cwd), 'report.json'));
  return [...urls];
}

// Where a run had got to, from its own files: read, check, review, fix, deploy or verify (the
// dashboard's sentence after a restart names it).
export function savedStage(dir) {
  const st = readJson(join(dir, 'state.json'), null) || {};
  if (!existsSync(join(dir, 'findings.json'))) return 'read';
  if (!existsSync(join(dir, 'check.json'))) return 'check';
  if (st.stage !== 'fixing') return 'review';
  if (st.verifying) return 'verify';
  return st.awaiting ? 'deploy' : 'fix';
}

// Every decision of the run, as decisions.ndjson holds them.
export function readDecisions(dir) {
  const f = join(dir, 'decisions.ndjson');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// The decision log grouped by finding, with each finding's PDF page, commits and screenshots: what
// decisions.md says and the dashboard's Show decisions shows. web: the repository's web address.
export function decisionGroups(dir, web = null) {
  const findings = readJson(join(dir, 'findings.json'), { findings: [] }).findings || [];
  const state = readJson(join(dir, 'state.json'), {}) || {};
  const all = readDecisions(dir);
  const shots = (id) => {
    const base = join(dir, 'evidence', id);
    if (!existsSync(base)) return [];
    return readdirSync(base).filter((d) => d === 'before' || /^after-\d+$/.test(d)).sort((a, b) => (a === 'before' ? -1 : b === 'before' ? 1 : Number(a.slice(6)) - Number(b.slice(6))))
      .filter((d) => existsSync(join(base, d, 'screenshot.png'))).map((d) => ({ label: d === 'before' ? 'Before' : `After, try ${d.slice(6)}`, path: `evidence/${id}/${d}/screenshot.png` }));
  };
  const manifest = readJson(join(dir, PARSED_DIR, 'manifest.json'), null);
  const pictureOf = (n) => ((manifest && manifest.pages) || []).find((p) => p.n === n)?.picture || null;
  const groups = findings.map((f) => ({
    picture: pictureOf(f.page),
    finding: f.id, title: f.title, page: f.page, pages: f.pages || [f.page], tester: f.status || null, quote: f.quote, url: f.url || null, status: (state.items && state.items[f.id] && state.items[f.id].status) || null,
    decisions: all.filter((d) => d.finding === f.id),
    commits: ((state.items && state.items[f.id] && state.items[f.id].commits) || []).map((c) => ({ ...c, url: commitWebUrl(web, c.sha) })),
    screenshots: shots(f.id),
  }));
  const general = all.filter((d) => !d.finding || !findings.some((f) => f.id === d.finding));
  return { groups, general, pdf: 'source.pdf', parsed: existsSync(join(dir, PARSED_DIR, 'report.md')) ? `${PARSED_DIR}/report.md` : null };
}

export function decisionsMarkdown(dir, web = null) {
  const { groups, general } = decisionGroups(dir, web);
  const line = (d) => `- ${d.at} · ${d.stage} · ${d.by}: ${d.decision}${d.reason ? ` — ${d.reason}` : ''}${d.evidence ? ` (evidence: ${d.evidence})` : ''}`;
  const out = ['# Decisions', '', `From the tester's PDF: [source.pdf](source.pdf)${existsSync(join(dir, PARSED_DIR, 'report.md')) ? ` (parsed: [${PARSED_DIR}/report.md](${PARSED_DIR}/report.md))` : ''}`, ''];
  if (general.length) out.push('## The run', '', ...general.map(line), '');
  for (const g of groups) {
    out.push(`## ${g.finding}: ${g.title} — [PDF page ${g.page}](source.pdf#page=${g.page})`, '');
    if (g.quote) out.push(`> ${g.quote}`, '');
    out.push(...(g.decisions.length ? g.decisions.map(line) : ['- No decision recorded.']), '');
    if (g.commits.length) out.push('Commits:', '', ...g.commits.map((c) => `- ${c.url ? `[${c.short}](${c.url})` : c.short}: ${(c.files || []).join(', ') || 'no files'}`), '');
    for (const s of g.screenshots) out.push(`${s.label}:`, '', `![${g.finding} ${s.label.toLowerCase()}](${s.path})`, '');
  }
  return out.join('\n');
}

// The words the dashboard (or a person at the terminal) sends while the plan waits: "review" (the
// edits are in plan-edit.json) and "approve". next() resolves the next one, or 'stopped'.
function wordReader(stopped) {
  const stdin = process.stdin;
  let buf = '';
  const queue = [];
  let wake = null;
  const onData = (chunk) => {
    buf += String(chunk);
    for (;;) {
      const nl = buf.search(/\r?\n/);
      if (nl < 0) break;
      const w = buf.slice(0, nl).trim().toLowerCase();
      buf = buf.slice(nl).replace(/^\r?\n/, '');
      if (w === 'review' || w === 'approve') queue.push(w);
    }
    if (queue.length && wake) wake();
  };
  let on = false;
  return {
    async next() {
      if (!on) {
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
        on = true;
      }
      if (stdin.ref) stdin.ref();
      stdin.resume();
      try {
        while (!queue.length) {
          if (stopped()) return 'stopped';
          await Promise.race([new Promise((r) => (wake = r)), sleep(500)]);
          wake = null;
        }
        return queue.shift();
      } finally {
        stdin.pause();
        if (stdin.unref) stdin.unref();
      }
    },
    drop() {
      queue.length = 0;
    },
    close() {
      if (on) stdin.off('data', onData);
      on = false;
      stdin.pause();
      if (stdin.unref) stdin.unref();
    },
  };
}

export async function runManual({ pdf, config, cwd, log, events = false, stopSignal = { stopped: false }, passthrough = [] }) {
  const { cfg, errors } = normalizeConfig(config, { url: config._url, agent: config._agent }, { interactive: events || !!process.stdin.isTTY, events });
  const ev = (type, data) => log.event && log.event(type, data);
  const stage = (s, data = {}) => ev('manual', { stage: s, ...data });
  if (errors.length) {
    for (const e of errors) log.error(e);
    return 2;
  }
  for (const l of migrationLines(migrateRepo(cwd))) log.info(l);
  // From the dashboard the wait for a deployment has no limit unless the config sets one, as the loop's there.
  if (events && typeof config.deployTimeout !== 'number') cfg.deployTimeout = 0;
  const stopped = () => !!stopSignal.stopped;
  const work = workDir(cwd);
  const taskFolder = tasksDir(cwd);
  mkdirSync(taskFolder, { recursive: true });

  // The PDF: one already in a manual folder (the dashboard's upload, or a run taken up again) is that
  // run's; any other is copied into a new one.
  const given = resolve(cwd, String(pdf || ''));
  let buf = null;
  try {
    buf = readFileSync(given);
  } catch (e) {
    log.error(`cannot read ${pdf}: ${e.message}`);
    return 2;
  }
  if (!isPdf(buf)) {
    log.error(NOT_A_PDF);
    return 2;
  }
  if (buf.length > MAX_PDF_BYTES) {
    log.error('That PDF is larger than 50 MB.');
    return 2;
  }
  let id;
  const parent = dirname(given);
  if (dirname(parent) === resolve(manualRoot(cwd)) && validId(parent.split(sep).pop()) && given.endsWith(`${sep}source.pdf`)) id = parent.split(sep).pop();
  else {
    id = newManualId(cwd);
    mkdirSync(manualDir(cwd, id), { recursive: true });
    copyFileSync(given, join(manualDir(cwd, id), 'source.pdf'));
  }
  const dir = manualDir(cwd, id);
  const sourceDirs = cfg.source;
  const pre = prepareRepo({ cwd, cfg, sourceDirs, log });
  if (pre) {
    if (log.events) ev('precondition', pre);
    else {
      log.error(pre.message);
      log.info(`to fix: ${pre.remedy}`);
    }
    return 2;
  }

  const stateFile = join(dir, 'state.json');
  const state = readJson(stateFile, null) || { id, items: {}, version: 0, after: 0 };
  const save = () => writeJson(stateFile, state);
  const itemState = (fid) => (state.items[fid] ||= { status: null, commits: [], attempts: [] });
  const web = remoteWeb(cwd);
  const decide = (stg, finding, by, decision, reason = '', evidence = null) => {
    const d = { at: new Date().toISOString(), stage: stg, finding: finding || null, by, decision: str(decision, 600), reason: str(reason, 600), ...(evidence ? { evidence } : {}) };
    appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify(d) + '\n');
    ev('manual-decision', d);
    if (!log.events) log.info(`  decision (${stg}, ${by}${finding ? `, ${finding}` : ''}): ${d.decision}${d.reason ? ` — ${d.reason}` : ''}`);
  };
  const finish = (code, words) => {
    writeFileSync(join(dir, 'decisions.md'), decisionsMarkdown(dir, web));
    if (words) log.info(words);
    log.info(`decisions: ${shortenHome(join(dir, 'decisions.md'))}`);
    return code;
  };
  const toolRel = relative(cwd, TOOL_DIR);
  const protectedDirs = toolRel.startsWith('..') || toolRel.startsWith(sep) || /^[A-Za-z]:/.test(toolRel) ? [TOOL_DIR] : toolRel ? [toolRel] : [];
  const agentCommand = resolveAgentCommand(cfg.agent);
  const agentName = (PRESET_INFO[cfg.agent] && PRESET_INFO[cfg.agent].label) || 'the assistant';
  const AgentName = agentName.replace(/^./, (c) => c.toUpperCase());
  const framework = frameworkLine(cwd);
  let calls = 0;
  const ask = async (label, prompt) => {
    const n = ++calls;
    const promptFile = join(taskFolder, `prompt-manual-${id}-${label}-${n}.md`);
    const resultFile = join(taskFolder, `result-manual-${id}-${label}-${n}.json`);
    writePrompt(promptFile, prompt(resultFile));
    stage('agent', { task: label, state: 'start' });
    const at = new Date().toISOString();
    const res = await callAgent(work, `manual-${id}-${label}-${n}`, { command: agentCommand, promptFile, resultFile, cwd, tasksDir: taskFolder, timeout: cfg.agentTimeout, quotaDelays: cfg.quotaDelays || QUOTA_DELAYS });
    writeFileSync(join(dir, `agent-${label}-${n}.log`), agentLog(res, { at, assistant: agentLabel(cfg.agent) }));
    const why = res.result ? null : res.timedOut ? `${AgentName} did not answer in time` : res.quota ? `${AgentName} was refused for quota or rate limit` : `${AgentName} ended without an answer (exit code ${res.code})`;
    stage('agent', { task: label, state: 'done', ok: !!res.result, ...(why ? { reason: why } : {}) });
    return { result: res.result, why, res };
  };
  // A finding's page, as a full URL in the deployed site.
  const urlOf = (f) => {
    const raw = f.url || f.route || '';
    try {
      return new URL(raw || '/', cfg.url).href;
    } catch {
      return cfg.url;
    }
  };
  const named = passthrough.indexOf('--state');
  const sessionFile = named >= 0 && passthrough[named + 1] ? passthrough[named + 1] : cfg.state;
  const ci = passthrough.indexOf('--connect');
  const connectArgs = ci >= 0 && passthrough[ci + 1] ? ['--connect', passthrough[ci + 1]] : [];
  const crawlArgs = passthrough.filter((a, i) => !(i === ci || i === ci + 1));
  const browserArgs = () => [...(cfg.args || []), ...crawlArgs, ...sessionArgs(cfg, crawlArgs, cwd)];
  const signIn = async (why) => {
    log.info(`${why}: opening ${connectArgs.length ? 'a tab' : 'a window'} to sign in`);
    ev('sign-in-opening', { how: connectArgs.length ? 'tab' : 'window', why });
    return signInOnly({ cfg, cwd, log, events, stateFile: sessionFile, connectArgs, passthrough: crawlArgs.filter((a, i, all) => a !== '--state' && all[i - 1] !== '--state') });
  };

  // Evidence for findings into evidence/<finding>/<label>/: the tool's browser, one for the stage.
  // An expired sign-in opens the sign-in (as the loop does) once, then the capture goes on.
  const capture = async (list, label) => {
    const out = new Map();
    let browser = await evidenceBrowser({ startUrl: cfg.url, args: browserArgs(), cwd });
    let signedIn = false;
    try {
      for (const [i, f] of list.entries()) {
        if (stopped()) break;
        stage('capture', { label, n: i + 1, m: list.length, finding: f.id, url: urlOf(f) });
        const edir = join(dir, 'evidence', f.id, label);
        let s = await browser.capture({ url: urlOf(f), selectors: f.selectors || [], dir: edir });
        if (s.portal && !signedIn && (events || process.stdin.isTTY)) {
          signedIn = true;
          if (await signIn('the deployed site asks for a sign-in')) {
            await browser.close();
            browser = await evidenceBrowser({ startUrl: cfg.url, args: browserArgs(), cwd });
            s = await browser.capture({ url: urlOf(f), selectors: f.selectors || [], dir: edir });
          }
        }
        out.set(f.id, loadEvidence(f.id, label, s));
      }
    } finally {
      await browser.close();
    }
    return out;
  };
  // What a capture left, for the prompts: the summary, the matched elements and the Tab order, with the
  // screenshot copied into the tasks folder (the one folder of the tool's an assistant can read).
  const loadEvidence = (fid, label, summary = null) => {
    const edir = join(dir, 'evidence', fid, label);
    const s = summary || readJson(join(edir, 'summary.json'), null);
    if (!s) return null;
    let screenshot = null;
    if (existsSync(join(edir, 'screenshot.png'))) {
      screenshot = join(taskFolder, `manual-${id}-${fid}-${label}.png`);
      try {
        copyFileSync(join(edir, 'screenshot.png'), screenshot);
      } catch {
        screenshot = null;
      }
    }
    return { ...s, elements: readJson(join(edir, 'elements.json'), []), tabOrder: readJson(join(edir, 'tab-order.json'), []), screenshot, dir: `evidence/${fid}/${label}` };
  };

  stage('start', { id, pdf: `${MANUAL_DIR}/${id}/source.pdf`, url: cfg.url, agent: cfg.agent });
  log.info(`a11y-508 manual: ${shortenHome(join(dir, 'source.pdf'))}  ${cfg.url}  agent: ${cfg.agent}`);
  if (state.done) return finish(0, state.doneLine || 'Done.');

  // ---- 1. Parse the PDF (docs/plans/pdf-parse.md), then read the parse with the assistant.
  let findings = readJson(join(dir, 'findings.json'), null)?.findings || null;
  const parsedDir = join(dir, PARSED_DIR);
  let manifest = readJson(join(parsedDir, 'manifest.json'), null);
  if (!findings && !manifest) {
    stage('parse', {});
    log.info('reading the PDF');
    try {
      manifest = await parsePdf({
        file: join(dir, 'source.pdf'), outDir: parsedDir, chromePath: chromeOf(browserArgs()), log,
        onOpened: ({ pages, total, withPictures }) => stage('parse', { pages, total, withPictures }),
      });
    } catch (e) {
      const unreadable = !!e.unreadable;
      const words = unreadable ? `${e.message} Choose another PDF.` : `The PDF could not be read: ${e.message}`;
      decide('parse', null, 'tool', unreadable ? 'could not open the PDF' : 'could not parse the PDF', unreadable ? e.reason : e.message);
      stage('parse-failed', { reason: words, unreadable });
      log.error(words);
      return finish(unreadable ? 1 : 2);
    }
    if (process.env.A11Y_508_PDF_OPENED_DELAY) await sleep(Number(process.env.A11Y_508_PDF_OPENED_DELAY) || 0);
    if (stopped()) return 1;
  }
  const parsedFacts = (m) => ({ pages: m.pageCount, parsed: m.parsed, withText: m.pages.filter((p) => p.lines.length).length, withPictures: m.pages.filter((p) => p.images.length).length, dividers: m.dividers, notes: m.notes || [] });
  if (manifest) stage('parsed', parsedFacts(manifest));
  const noText = !!manifest && manifest.pages.length > 0 && !manifest.pages.some((p) => p.lines.length);
  if (!findings) {
    stage('read', { noText, pages: manifest.pageCount });
    log.info(noText ? `The PDF has no text; ${agentName} is working from the pictures of its ${plural(manifest.pageCount, 'page')}.` : `reading the parsed PDF with ${agentName}`);
    // What the assistant reads, in the tasks folder (the one folder of the tool's it can read):
    // the parse (report.md and its pictures) and, last, the PDF.
    const copyDir = join(taskFolder, `manual-${id}`);
    mkdirSync(join(copyDir, PARSED_DIR, 'pages'), { recursive: true });
    copyFileSync(join(dir, 'source.pdf'), join(copyDir, 'source.pdf'));
    for (const f of ['report.md', 'manifest.json']) copyFileSync(join(parsedDir, f), join(copyDir, PARSED_DIR, f));
    for (const f of readdirSync(join(parsedDir, 'pages'))) if (/\.png$/.test(f)) copyFileSync(join(parsedDir, 'pages', f), join(copyDir, PARSED_DIR, 'pages', f));
    const example = (manifest.pages.find((p) => p.images.length) || manifest.pages.find((p) => p.picture) || {}).picture || null;
    const readOnce = () => ask('read', (resultFile) => manualReadPrompt({ reportFile: join(copyDir, PARSED_DIR, 'report.md'), parsedDir: join(copyDir, PARSED_DIR), example, pdfFile: join(copyDir, 'source.pdf'), pageCount: manifest.pageCount, noText, startUrl: cfg.url, routes: knownRoutes(cwd), resultFile }));
    const listOf = (result) => (Array.isArray(result) ? result : result && Array.isArray(result.findings) ? result.findings : null);
    const whyNot = (result, why) => (result && result.error) || (why ? why.replace(AgentName, 'it') : '') || 'its answer had no list of findings';
    let { result, why } = await readOnce();
    if (stopped()) return 1;
    let raw = listOf(result);
    // No list of findings (or no answer at all): asked once more before the run ends.
    if (!raw) {
      const first = whyNot(result, why);
      decide('read', null, 'tool', 'asked again', `the first answer could not be used: ${first}`);
      stage('read-again', { reason: first });
      log.warn(`${AgentName} could not read the PDF (${first}); asking it again`);
      ({ result, why } = await readOnce());
      if (stopped()) return 1;
      raw = listOf(result);
    }
    if (!raw) {
      const reason = whyNot(result, why);
      const who = agentLabel(cfg.agent).replace(/^./, (c) => c.toUpperCase());
      const words = `${who} could not read the PDF (${reason}). Choose another PDF, or pick another assistant under Advanced.`;
      decide('read', null, 'agent', 'could not read the PDF', reason);
      stage('read-failed', { reason: words, assistant: who });
      log.error(words);
      return finish(1);
    }
    const ids = new Set();
    const read = raw.filter((f) => f && typeof f === 'object').map((f, i) => {
      let fid = str(f.id, 20).replace(/[^\w-]/g, '') || `F${i + 1}`;
      while (ids.has(fid)) fid = `${fid}-${i + 1}`;
      ids.add(fid);
      const int = (v) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      const given = [...new Set((Array.isArray(f.pages) ? f.pages : []).map(int).filter((n) => n !== null))].sort((a, b) => a - b);
      if (!given.length && int(f.page) !== null) given.push(int(f.page));
      const status = /^(fixed|open)$/i.test(String(f.status || '')) ? String(f.status).toLowerCase() : null;
      const out = {
        id: fid, title: str(f.title, 120) || `Finding ${i + 1}`, page: given[0] || 1, pages: given.length ? given : [1], quote: str(f.quote, 300), route: str(f.route || f.url, 500), url: null,
        element: str(f.element, 300), selectors: (Array.isArray(f.selectors) ? f.selectors : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 5), wcag: str(f.wcag, 40) || null, expected: str(f.expected, 400),
        status, criterion: str(f.criterion, 12) || null,
      };
      out.url = urlOf(out);
      for (const d of Array.isArray(f.decisions) ? f.decisions : []) if (d && d.decision) decide('read', fid, 'agent', d.decision, d.reason);
      if (!given.length) decide('read', fid, 'tool', 'tied the finding to PDF page 1', 'the assistant gave no page number for it');
      return out;
    });
    findings = checkFindings(read, manifest, decide);
    for (const f of findings) decide('read', f.id, 'agent', `read "${f.title}" from PDF ${pagesWords(f.pages)}`, f.quote ? `the tester wrote: "${f.quote}"` : '');
    writeJson(join(dir, 'findings.json'), { at: new Date().toISOString(), findings });
  }
  stage('findings', { count: findings.length, findings });
  if (!findings.length) {
    stage('no-findings', { message: NO_FINDINGS });
    state.done = true;
    state.doneLine = NO_FINDINGS;
    save();
    return finish(0, NO_FINDINGS);
  }
  log.info(`${plural(findings.length, 'finding')} read from the PDF`);
  const byId = new Map(findings.map((f) => [f.id, f]));

  // ---- 2. Check the deployed site: present or gone, from evidence the tool captures.
  let check = readJson(join(dir, 'check.json'), null);
  if (!check) {
    stage('check', { count: findings.length });
    log.info(`checking the deployed site for the ${plural(findings.length, 'finding')}`);
    const evidence = await capture(findings, 'before');
    if (stopped()) return 1;
    stage('judge', { count: findings.length });
    const { result } = await ask('check', (resultFile) => manualCheckPrompt({ findings: findings.map((f) => ({ ...f, evidence: evidence.get(f.id) })), resultFile }));
    if (stopped()) return 1;
    const verdicts = Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : [];
    const results = findings.map((f) => {
      const v = verdicts.find((x) => x && (x.id === f.id || x.finding === f.id));
      const said = v && typeof v.verdict === 'string' ? v.verdict.toLowerCase() : null;
      const e = evidence.get(f.id);
      let verdict = said === 'gone' ? 'gone' : 'present';
      let reason = v && v.reason ? str(v.reason, 400) : '';
      if (said === 'unreachable') reason = `the page could not be checked (${(e && e.error) || reason || 'it did not load'}); treated as present`;
      else if (said !== 'gone' && said !== 'present') reason = `no verdict from the assistant; treated as present${reason ? ` (${reason})` : ''}`;
      decide('check', f.id, said === 'gone' || said === 'present' ? 'agent' : 'tool', verdict === 'gone' ? 'already fixed in the deployed site' : 'still present in the deployed site', reason, `evidence/${f.id}/before`);
      return { finding: f.id, verdict, said, reason, url: (e && (e.finalUrl || e.url)) || f.url, checkedAt: (e && e.at) || new Date().toISOString(), screenshot: e && e.files && e.files.includes('screenshot.png') ? `evidence/${f.id}/before/screenshot.png` : null };
    });
    check = { at: new Date().toISOString(), results };
    writeJson(join(dir, 'check.json'), check);
  }
  const gone = check.results.filter((r) => r.verdict === 'gone');
  const present = check.results.filter((r) => r.verdict !== 'gone').map((r) => byId.get(r.finding)).filter(Boolean);
  for (const r of gone) itemState(r.finding).status = 'already-fixed';
  // The tester's verdict beside the deployed site's (docs/plans/pdf-parse.md AC 7): verified fixed and
  // gone is confirmed; verified fixed and present came back, and is planned as a return.
  const verifiedGone = gone.filter((r) => (byId.get(r.finding) || {}).status === 'fixed');
  const cameBack = present.filter((f) => f.status === 'fixed');
  for (const f of cameBack) {
    f.cameBack = cameBackLine(f);
    if (!state.cameBackLogged || !state.cameBackLogged.includes(f.id)) {
      decide('check', f.id, 'tool', f.cameBack, 'the tester marked it fixed in the PDF and the deployed site still has it', `evidence/${f.id}/before`);
      (state.cameBackLogged ||= []).push(f.id);
    }
  }
  save();

  // ---- 3. The already-fixed report.
  const pictureOf = (n) => {
    const p = manifest && manifest.pages.find((x) => x.n === n);
    return p && p.picture ? p.picture : null;
  };
  const goneRows = gone.map((r) => {
    const f = byId.get(r.finding);
    return { ...r, title: f.title, quote: f.quote, page: f.page, pages: f.pages || [f.page], picture: pictureOf(f.page), tester: f.status === 'fixed' ? testerVerified(f) : null };
  });
  writeFileSync(join(dir, 'already-fixed.md'), [
    `# Already fixed in the deployed site (${goneRows.length})`, '', `From the tester's PDF: [source.pdf](source.pdf)`, '',
    ...(verifiedGone.length || cameBack.length ? [`${verifiedGone.length} of them the tester had verified fixed; ${cameBack.length} the tester had verified fixed came back (${cameBack.length === 1 ? 'it is' : 'they are'} in the plan).`, ''] : []),
    ...goneRows.flatMap((r) => [`## ${r.finding}: ${r.title} — [PDF page ${r.page}](source.pdf#page=${r.page})`, '', r.quote ? `> ${r.quote}` : '', '', ...(r.tester ? [`- ${r.tester}`] : []), `- Checked: ${r.url} at ${r.checkedAt}`, `- Why it counts as fixed: ${r.reason || '(no reason given)'}`, r.screenshot ? `\n![${r.finding} in the deployed site](${r.screenshot})` : '', '']),
  ].join('\n'));
  const all = gone.length === findings.length;
  stage('already-fixed', { rows: goneRows, total: findings.length, all });
  if (all) {
    const v = verifiedGone.length;
    const line = (findings.length === 1 ? 'The one finding in the PDF is already fixed in the deployed site' : `All ${findings.length} findings in the PDF are already fixed in the deployed site`) + (v ? ` (${v === findings.length ? (v === 1 ? 'the tester had verified it' : 'the tester had verified all of them') : `${v} of them the tester had verified`})` : '') + '.';
    state.done = true;
    state.doneLine = line;
    save();
    stage('done', { all: true, fixed: 0, alreadyFixed: gone.length, testerVerified: v, cameBack: 0, message: line });
    return finish(0, line);
  }
  if (gone.length) log.info(`${plural(gone.length, 'finding is', 'findings are')} already fixed in the deployed site (already-fixed.md)`);

  const components = () => listComponents(cwd, sourceDirs).components;
  const evidenceOf = (fid, label = 'before') => loadEvidence(fid, label);
  // A plan item from what the assistant answered, its component one of the listed ones when it can be.
  const toItem = (f, a, list, stg) => {
    let component = null;
    const given = a && a.component ? (typeof a.component === 'string' ? { name: a.component, file: null } : { name: str(a.component.name, 200), file: str(a.component.file, 500) || null }) : null;
    const listed = findComponent(list, given);
    if (listed) component = { name: listed.name, file: listed.file, selector: listed.selector || null };
    else if (given && given.name) {
      component = { ...given, selector: null, unlisted: true };
      decide(stg, f.id, 'tool', `kept ${given.name} although it is not one of the repository's listed components`, 'the assistant named it; the developer can pick another');
    }
    const files = (Array.isArray(a && a.files) ? a.files : []).map((x) => str(x, 500)).filter(Boolean);
    if (component && component.file && !files.includes(component.file)) files.unshift(component.file);
    const fix = str(a && a.fix, 1000) || `${f.expected || f.title}.`;
    if (!a) decide(stg, f.id, 'tool', 'planned it with the tester\'s expectation as the fix', 'the assistant gave no plan for this finding');
    for (const d of Array.isArray(a && a.decisions) ? a.decisions : []) if (d && d.decision) decide(stg, f.id, 'agent', d.decision, d.reason);
    decide(stg, f.id, 'agent', `fix in ${component ? `${component.name} (${component.file || 'no file'})` : 'no named component'}: ${fix}`, files.length ? `files: ${files.join(', ')}` : '');
    return { finding: f.id, title: f.title, page: f.page, pages: f.pages || [f.page], status: f.status || null, criterion: f.criterion || null, cameBack: f.cameBack || null, picture: pictureOf(f.page), quote: f.quote, url: f.url, fix, component, files, decisions: (Array.isArray(a && a.decisions) ? a.decisions : []).filter((d) => d && d.decision).map((d) => ({ decision: str(d.decision, 400), reason: str(d.reason, 400) })), confirm: null, screenshot: existsSync(join(dir, 'evidence', f.id, 'before', 'screenshot.png')) ? `evidence/${f.id}/before/screenshot.png` : null };
  };
  const savePlan = (plan) => {
    state.version = plan.version;
    save();
    writeJson(join(dir, `plan-v${plan.version}.json`), plan);
    writeJson(join(dir, 'plan.json'), plan);
  };
  const planEvent = (plan) => stage('plan', { version: plan.version, reason: plan.reason, notHeld: plan.notHeld || 0, items: plan.items });

  // ---- 4. The plan, for the findings still present.
  let plan = readJson(join(dir, 'plan.json'), null);
  if (!plan) {
    stage('planning', { count: present.length });
    log.info(`planning the fixes for ${plural(present.length, 'finding')} with ${agentName}`);
    const list = components();
    const { result } = await ask('plan', (resultFile) => manualPlanPrompt({ findings: present.map((f) => ({ ...f, evidence: evidenceOf(f.id) })), components: list, sourceDirs, framework, resultFile }));
    if (stopped()) return 1;
    const answers = Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : [];
    plan = { version: 1, at: new Date().toISOString(), reason: 'initial', items: present.map((f) => toItem(f, answers.find((a) => a && a.finding === f.id) || null, list, 'plan')) };
    savePlan(plan);
  }

  // ---- 5. Review until approved: edits go to the assistant, which confirms each.
  const reader = wordReader(stopped);
  const review = async () => {
    for (;;) {
      planEvent(plan);
      stage('review', { version: plan.version, notHeld: plan.notHeld || 0 });
      if (!log.events) log.info(`the plan is at ${join(dir, 'plan.json')}. Write your changes to ${join(dir, 'plan-edit.json')} and type review, or type approve.`);
      // Words sent while the plan was not waiting (a second tab, a retried request) are not approvals.
      reader.drop();
      state.reviewing = plan.version;
      save();
      const word = await reader.next();
      state.reviewing = null;
      save();
      if (word === 'stopped') return false;
      if (word === 'approve') {
        const wrong = plan.items.filter((it) => it.confirm && it.confirm.understood === false);
        if (wrong.length) {
          log.warn(`not approved: the assistant did not understand the change to ${wrong.map((it) => it.finding).join(', ')}; edit ${wrong.length === 1 ? 'it' : 'them'} and send again`);
          stage('approve-refused', { findings: wrong.map((it) => it.finding) });
          continue;
        }
        decide('plan', null, 'developer', `approved plan version ${plan.version}`, `${plural(plan.items.length, 'item')}: ${plan.items.map((it) => it.finding).join(', ') || 'none'}`);
        stage('approved', { version: plan.version, items: plan.items.length });
        return true;
      }
      // review: the developer's edits.
      const edit = readJson(join(dir, 'plan-edit.json'), null);
      const edits = Array.isArray(edit && edit.items) ? edit.items : [];
      if (!edits.length) continue;
      const list = components();
      const next = { ...plan, version: plan.version + 1, at: new Date().toISOString(), reason: 'edit', items: plan.items.map((it) => ({ ...it })) };
      const toConfirm = [];
      for (const e of edits) {
        const it = next.items.find((x) => x.finding === e.finding);
        if (!it) continue;
        if (e.remove === true) {
          next.items = next.items.filter((x) => x !== it);
          decide('plan', it.finding, 'developer', 'removed from the plan', `was: ${it.fix} In ${it.component ? it.component.name : 'no component'}.`);
          continue;
        }
        const fix = typeof e.fix === 'string' && e.fix.trim() ? str(e.fix, 1000) : it.fix;
        let component = it.component;
        if (e.component) {
          const listed = findComponent(list, e.component);
          if (listed) component = { name: listed.name, file: listed.file, selector: listed.selector || null };
        }
        const changed = fix !== it.fix || (component && (!it.component || component.file !== it.component.file || component.name !== it.component.name));
        if (!changed) continue;
        const before = `${it.fix} In ${it.component ? `${it.component.name} (${it.component.file})` : 'no component'}.`;
        const after = `${fix} In ${component ? `${component.name} (${component.file})` : 'no component'}.`;
        decide('plan', it.finding, 'developer', `changed the plan item: ${before} → ${after}`, 'the developer\'s edit');
        toConfirm.push({ it, original: { fix: it.fix, component: it.component, files: it.files }, edit: { fix, component } });
      }
      if (toConfirm.length) {
        stage('confirming', { count: toConfirm.length });
        const { result } = await ask('confirm', (resultFile) => manualConfirmPrompt({ items: toConfirm.map((c) => ({ finding: c.it.finding, title: c.it.title, quote: c.it.quote, page: c.it.page, original: c.original, edit: c.edit })), components: list, resultFile }));
        if (stopped()) return false;
        const answers = Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : [];
        for (const c of toConfirm) {
          const a = answers.find((x) => x && x.finding === c.it.finding);
          c.it.fix = c.edit.fix;
          c.it.component = c.edit.component;
          const files = (Array.isArray(a && a.files) ? a.files : []).map((x) => str(x, 500)).filter(Boolean);
          if (c.edit.component && c.edit.component.file && !files.includes(c.edit.component.file)) files.unshift(c.edit.component.file);
          c.it.files = files.length ? files : c.it.files;
          c.it.confirm = a ? { understood: a.understood === true, text: str(a.text || a.reason, 600) } : { understood: false, text: 'The assistant gave no answer for this change; send it again.' };
          decide('confirm', c.it.finding, a ? 'agent' : 'tool', c.it.confirm.understood ? `understood: ${c.it.confirm.text}` : `did not understand: ${c.it.confirm.text}`, c.it.confirm.understood ? `files: ${c.it.files.join(', ')}` : '');
        }
      }
      plan = next;
      savePlan(plan);
    }
  };

  // ---- 6. Fix, push, wait, verify; one automatic retry; then a revised plan.
  const parts = cfg.checkEvery === 'finding' ? splitCheck(cfg.check) : { build: cfg.check, test: null };
  const deploySettle = typeof config.deploySettle === 'number' && config.deploySettle >= 0 ? config.deploySettle : 10000;
  const fixAll = async (items, attempt, prior) => {
    const roundBase = git(cwd, ['rev-parse', 'HEAD']).out;
    const before = cfg.deployed === 'bundle-change' ? await bundleSignature(cfg.url, { args: browserArgs(), cwd }) : null;
    const commits = [];
    const key = `${state.cycle || 1}:${attempt}`;
    for (const [i, it] of items.entries()) {
      if (stopped()) break;
      // Taken up again after an interruption: an item this attempt already committed is not fixed twice.
      if (itemState(it.finding).commits.some((r) => r.key === key)) continue;
      const f = byId.get(it.finding);
      stage('fix', { n: i + 1, m: items.length, finding: it.finding, title: it.title, attempt });
      log.info(`[${i + 1}/${items.length}] ${it.finding} ${it.title}${attempt > 1 ? ' (again)' : ''}`);
      const p = prior.get(it.finding) || null;
      const { result, why } = await ask(`fix-${it.finding}`, (resultFile) => manualFixPrompt({ finding: f, item: it, evidence: evidenceOf(it.finding), prior: p, sourceDirs, protectedDirs, framework, resultFile }));
      const changed = gitChanged(cwd, sourceDirs);
      const stray = gitChanged(cwd).filter((x) => !changed.includes(x));
      if (stray.length) {
        log.warn(`  the assistant changed files outside ${sourceDirs.join(', ')}; reverting them: ${stray.join(', ')}`);
        git(cwd, ['checkout', '--', ...stray]);
        git(cwd, ['clean', '-fdq', '--', ...stray]);
      }
      const note = (result && str(result.note, 300)) || why || 'no note';
      for (const d of Array.isArray(result && result.decisions) ? result.decisions : []) if (d && d.decision) decide('fix', it.finding, 'agent', d.decision, d.reason);
      const st = itemState(it.finding);
      st.attempts.push({ attempt, at: new Date().toISOString(), note, files: changed });
      if (!changed.length) {
        decide('fix', it.finding, 'agent', 'made no change', `${note}; it goes to verification anyway`);
        save();
        continue;
      }
      if (cfg.check && parts.build) {
        stage('gate', { finding: it.finding, check: parts.build });
        const gate = await sh(cwd, parts.build, process.env, null, cfg.checkTimeout);
        if (gate.code !== 0) {
          git(cwd, ['checkout', '--', ...sourceDirs]);
          git(cwd, ['clean', '-fdq', '--', ...sourceDirs]);
          decide('fix', it.finding, 'tool', 'reverted the change: it broke the build', gate.out.split('\n').filter((l) => l.trim()).slice(-5).join(' | '));
          save();
          continue;
        }
      }
      git(cwd, ['add', '--', ...sourceDirs]);
      const msg = `a11y-508: manual <PDF p.${it.page}> ${it.title}\n\nFrom the tester's PDF, page ${it.page}: ${it.quote}\nFix (approved): ${it.fix}\nComponent: ${it.component ? `${it.component.name} (${it.component.file})` : 'none named'}\n${note}`;
      const c = git(cwd, ['commit', '-q', '-m', msg]);
      if (c.code !== 0) {
        decide('fix', it.finding, 'tool', 'the commit failed', c.err);
        continue;
      }
      const sha = git(cwd, ['rev-parse', 'HEAD']).out;
      const short = git(cwd, ['rev-parse', '--short', 'HEAD']).out;
      const rec = { sha, short, files: changed, attempt, key, note };
      st.commits.push(rec);
      commits.push({ sha, n: i + 1, test: it.finding, message: it.title, rec, it });
      decide('fix', it.finding, 'agent', `committed ${short}: ${changed.join(', ')}`, note);
      stage('commit', { finding: it.finding, commit: short, files: changed });
      save();
    }
    if (commits.length && parts.test) {
      await testRoundFixes({
        cwd, sourceDirs, roundBase, fixes: commits, log, ev, round: attempt, stopped, checkTimeout: cfg.checkTimeout,
        runTests: (label) => {
          stage('gate', { check: parts.test, label });
          return sh(cwd, parts.test, process.env, null, cfg.checkTimeout);
        },
        onFail: (fx, gate, why) => {
          const st = itemState(fx.it.finding);
          st.commits = st.commits.filter((r) => r !== fx.rec);
          decide('fix', fx.it.finding, 'tool', `reverted ${fx.rec.short}`, why);
        },
        onReapplied: (fx) => {
          fx.rec.sha = fx.sha;
          fx.rec.short = git(cwd, ['rev-parse', '--short', fx.sha]).out;
        },
        onChange: save,
      });
      save();
    }
    // This attempt's commits, with any made before an interruption.
    const live = items.flatMap((it) => itemState(it.finding).commits.filter((r) => r.key === key));
    let marker = null;
    if (live.length && cfg.deployed === 'bundle-change') {
      const indexFile = findIndexHtml(cwd, sourceDirs);
      if (indexFile) {
        const token = `m${state.after + 1}-${Date.now().toString(36)}`;
        let stamped = false;
        try {
          stamped = stampBuildMarker(cwd, indexFile, token);
        } catch {}
        if (stamped) {
          git(cwd, ['add', '--', indexFile]);
          if (git(cwd, ['commit', '-q', '-m', `a11y-508: build marker ${token}\n\nThe manual flow verifies these fixes against a build that serves this marker.`]).code === 0) marker = token;
        }
      }
    }
    if (live.length && cfg.push) {
      const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      stage('push', { committed: live.length, branch });
      log.info(`pushing ${plural(live.length, 'fix', 'fixes')} to origin/${branch}`);
      const p = git(cwd, ['push', '-u', 'origin', branch]);
      if (p.code !== 0) throw Object.assign(new Error(`push failed: ${p.err}`), { code: 2 });
      state.pushedAt = new Date().toISOString();
    }
    // What the wait needs, kept so a run taken up again waits for this push rather than fixing again.
    state.awaiting = { key, committed: live.length, marker, before: before ? { signature: before.signature, marker: before.marker || null } : null };
    save();
    return state.awaiting;
  };
  // Until the deployment serves this push (exactly the loop's ways: the build marker, else the bundles changing).
  const awaitDeploy = async ({ committed, marker, before }) => {
    if (!committed || cfg.deployed === 'none') return 'live';
    if (cfg.deployed === 'command') {
      stage('deploy', { command: cfg.deploy });
      const d = await sh(cwd, cfg.deploy, process.env);
      if (d.code !== 0) throw Object.assign(new Error(`deploy command failed (exit ${d.code}): ${d.out.slice(-800)}`), { code: 2 });
      return 'live';
    }
    // From the dashboard nobody presses Enter: it goes on at once, as the loop does there.
    if (cfg.deployed === 'enter' && events) return 'live';
    if (cfg.deployed === 'enter') {
      await waitForEnter(`\n${plural(committed, 'fix', 'fixes')} committed. Deploy them, then press Enter to verify them in the deployed site... `, null);
      return 'live';
    }
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
    stage('await-deploy', { committed, branch, pushed: !!cfg.push, pushedAt: state.pushedAt || null, marker });
    log.info(`waiting for your deployment of ${branch}; checking ${cfg.url} every ${Math.round(cfg.deployPoll / 1000)} s`);
    const until = cfg.deployTimeout > 0 ? Date.now() + cfg.deployTimeout : Infinity;
    let changedNoMarker = 0;
    let signedIn = false;
    while (Date.now() < until) {
      if (stopped()) return 'stopped';
      const r = await bundleSignature(cfg.url, { args: browserArgs(), cwd });
      if (r.portal && !signedIn && (events || process.stdin.isTTY)) {
        signedIn = true;
        await signIn('the start page asks for a sign-in');
        continue;
      }
      let result = r.signature === null ? 'unreadable' : 'same';
      if (r.signature !== null) {
        if (marker && r.marker === marker) result = 'changed';
        else if (marker && !r.marker && before && before.signature != null && !sameBuild(r.signature, before.signature) && ++changedNoMarker >= 2) result = 'changed';
        else if (!marker && (!before || before.signature == null || !sameBuild(r.signature, before.signature))) result = 'changed';
      }
      stage('deploy-check', { at: new Date().toISOString(), result, ...(r.reason ? { reason: r.reason } : {}) });
      if (result === 'changed') {
        log.info('the new build is live');
        await sleep(deploySettle);
        return 'live';
      }
      await sleep(cfg.deployPoll);
    }
    return 'timeout';
  };
  const verify = async (items) => {
    const label = `after-${++state.after}`;
    state.verifying = label;
    save();
    stage('verify', { label, count: items.length });
    log.info(`checking the deployed site for ${plural(items.length, 'fix', 'fixes')}`);
    const evidence = await capture(items.map((it) => byId.get(it.finding)), label);
    if (stopped()) return null;
    const { result } = await ask('verify', (resultFile) => manualVerifyPrompt({ items: items.map((it) => ({ finding: byId.get(it.finding), fix: it.fix, evidence: evidence.get(it.finding) })), resultFile }));
    const answers = Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : [];
    const verdicts = items.map((it) => {
      const a = answers.find((x) => x && (x.finding === it.finding || x.id === it.finding));
      const fixed = !!a && String(a.verdict || '').toLowerCase() === 'fixed';
      const reason = a && a.reason ? str(a.reason, 400) : 'no verdict from the assistant; counted as not fixed';
      itemState(it.finding).status = fixed ? 'fixed' : 'not-fixed';
      const last = itemState(it.finding).attempts.slice(-1)[0];
      if (last) Object.assign(last, { verdict: fixed ? 'fixed' : 'not-fixed', reason, evidence: `evidence/${it.finding}/${label}` });
      decide('verify', it.finding, a ? 'agent' : 'tool', fixed ? 'fixed in the deployed site' : 'not fixed in the deployed site', reason, `evidence/${it.finding}/${label}`);
      return { finding: it.finding, verdict: fixed ? 'fixed' : 'not-fixed', reason, label };
    });
    save();
    stage('verdicts', { label, items: verdicts });
    return verdicts;
  };

  try {
    for (;;) {
      if (state.stage !== 'fixing') {
        const ok = await review();
        if (!ok) {
          log.warn('stopped while the plan waited for approval');
          return finish(1);
        }
        state.stage = 'fixing';
        state.approved = plan.items;
        state.attempt = 1;
        state.cycle = (state.cycle || 0) + 1;
        state.awaiting = null;
        save();
      } else {
        // Taken up again after an interruption: the unfinished fix's uncommitted changes are discarded.
        const left = gitChanged(cwd, sourceDirs);
        if (left.length) {
          git(cwd, ['checkout', '--', ...sourceDirs]);
          git(cwd, ['clean', '-fdq', '--', ...sourceDirs]);
          decide('fix', null, 'tool', 'discarded the interrupted fix\'s uncommitted changes', left.join(', '));
        }
      }
      let items = (state.approved || []).filter((it) => itemState(it.finding).status !== 'fixed');
      if (!items.length) break;
      const prior = new Map();
      for (let attempt = state.attempt || 1; attempt <= 2; attempt++) {
        state.attempt = attempt;
        save();
        if (attempt === 2) stage('retry', { count: items.length });
        // Pushed before an interruption: this attempt waits for its deployment and is verified, not fixed again.
        const pushed = state.awaiting && state.awaiting.key === `${state.cycle || 1}:${attempt}` ? state.awaiting : null;
        const r = pushed || (await fixAll(items, attempt, prior));
        if (stopped()) return finish(1);
        const w = await awaitDeploy(r);
        if (w === 'stopped') return finish(1);
        if (w === 'timeout') {
          log.warn(`the deployment has not arrived within ${Math.round(cfg.deployTimeout / 60000)} min; run the same command again to go on waiting`);
          return finish(4);
        }
        const verdicts = await verify(items);
        if (!verdicts) return finish(1);
        state.awaiting = null;
        state.verifying = null;
        save();
        const notFixed = verdicts.filter((v) => v.verdict !== 'fixed');
        for (const v of notFixed) {
          const a = itemState(v.finding).attempts.slice(-1)[0] || {};
          prior.set(v.finding, { note: a.note, reason: v.reason, evidence: loadEvidence(v.finding, v.label) });
        }
        items = items.filter((it) => notFixed.some((v) => v.finding === it.finding));
        if (!items.length) break;
      }
      if (!items.length) break;
      // Still not fixed after two tries: a revised plan for just those, back to the developer.
      stage('replanning', { count: items.length });
      const list = components();
      const { result } = await ask('replan', (resultFile) => manualReplanPrompt({
        items: items.map((it) => ({ finding: byId.get(it.finding), item: it, attempts: itemState(it.finding).attempts.slice(-2), evidence: prior.get(it.finding) ? prior.get(it.finding).evidence : null })), components: list, sourceDirs, resultFile,
      }));
      if (stopped()) return finish(1);
      const answers = Array.isArray(result) ? result : Array.isArray(result && result.items) ? result.items : [];
      plan = { version: plan.version + 1, at: new Date().toISOString(), reason: 'revised', notHeld: items.length, items: items.map((it) => toItem(byId.get(it.finding), answers.find((a) => a && a.finding === it.finding) || null, list, 'replan')) };
      savePlan(plan);
      state.stage = 'review';
      save();
    }
  } catch (e) {
    log.error(e.message);
    return finish(e.code || 2);
  } finally {
    reader.close();
  }
  const fixed = Object.values(state.items).filter((s) => s.status === 'fixed').length;
  const line = `Done: ${plural(fixed, 'finding')} from the PDF ${fixed === 1 ? 'is' : 'are'} fixed and confirmed in the deployed site${gone.length ? `; ${alreadyWords(gone.length, verifiedGone.length)}` : ''}${cameBack.length ? `; ${cameBack.length} had come back` : ''}.`;
  state.done = true;
  state.doneLine = line;
  state.stage = 'done';
  save();
  stage('done', { all: false, fixed, alreadyFixed: gone.length, testerVerified: verifiedGone.length, cameBack: cameBack.length, message: line });
  return finish(0, line);
}
