// Command-line entry: argument parsing and orchestration.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, browserField, connectChrome } from './chrome.mjs';
import { crawl, deathText } from './crawler.mjs';
import { addDiarySecrets, writeDiary } from './diary.mjs';
import { interactiveLogin, loadState, saveState, stateSummary } from './login.mjs';
import { troubleshoot, formatTroubleshoot } from './troubleshoot.mjs';
import { loadConfig, printStatus, runLoop } from './loop.mjs';
import { gitDirOf, migrateRepo, migrationLines, reportDir } from './home.mjs';
import { siteChecks } from './site-checks.mjs';
import { summarize, shouldFail, writeReports, makeLogger, coverage, eventWriter } from './report.mjs';
import { BEYOND, CATALOG, IMPACTS, TEST_IDS, WCAG_VERSIONS, beyondIds, beyondHeading } from './checks/catalog.mjs';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

// Web-storage keys that single-page apps commonly read their session token from.
export const TOKEN_STORAGE_KEYS = ['token', 'access_token', 'accessToken', 'id_token', 'idToken', 'jwt', 'auth_token', 'authToken'];

const HELP = `a11y-508 ${pkg.version} - Section 508 crawler (DHS Trusted Tester checks, no dependencies)

Usage: a11y-508 <url> [options]
       npm run e2e:a11y-508 <url> [-- options]
       a11y-508 loop [url] [--config <file>] [--max-rounds <n>] [--agent <spec>] [--dry-run] [--sign-in-first] [--from-report <file>] [crawl options]
       a11y-508 status

Crawls every same-origin page reachable from <url> in headless Chrome, runs the
automatable Trusted Tester checks on each page, and writes a report with
violations (determinate failures) and review items (escalations for a human).

Options
  --max-pages <n>          Maximum pages to audit (default 200)
  --max-depth <n>          Maximum link depth from the start URL (default 10)
  --concurrency <n>        Parallel tabs (default 4)
  --include <regex>        Only audit URLs matching this pattern (repeatable)
  --exclude <regex>        Skip URLs matching this pattern (repeatable)
  --fail-on <list>         Impacts that fail the run: critical,serious,moderate,minor
                           or "none" (default critical,serious)
  --out <dir>              Report directory (default: inside a git repository, the tool's
                           own folder for it, ~/.a11y-508/repos/<name>-<hash>/report;
                           elsewhere ./a11y-508-report)
  --viewport <WxH>         Viewport size (default 1280x800)
  --timeout <ms>           Page load timeout (default 30000)
  --settle <ms>            Extra wait after load for scripts to render (default 500)
  --header "Name: value"   Extra request header, sent to every request (repeatable)
  --token-header <name>    Header that carries TOKEN (default Authorization)
  --auth-origin <origin>   Additional origin that also receives TOKEN (repeatable)
  --token-storage <key>    Also seed TOKEN into web storage under <key> (repeatable)
  --no-token-storage       Do not seed TOKEN into localStorage/sessionStorage
  --cookie "name=value"    Cookie set on the start origin before the crawl (repeatable)
  --login                  Open a visible browser to sign in once (works with external
                           SSO portals), save the session to --state, then crawl with it
  --state <file>           Session file to crawl with, or to write when used with --login
                           (default with --login: a11y-508-state.json)
  --login-only             Sign in and save the session file, then exit without crawling
  --stay                   With --login: keep the signed-in window and crawl in it (one
                           tab), so whatever the sign-in set up is used as it is
  --connect <port|ws://…>  Use a browser that is already running (started with
                           --remote-debugging-port): tabs open in its window, one at a
                           time, and are closed at the end; the browser stays open.
                           With --login the sign-in tab is where the crawl continues
  --troubleshoot           Load only the start URL with the configured auth and explain
                           what happened (redirects, storage keys the app read, cookies,
                           whether the header went out) with the next step to take
  --no-interact            Skip the keyboard and disclosure-activation passes
  --no-zoom                Skip the 200% zoom pass
  --wcag <version>         2.0 (default): the Trusted Tester checks only, as Section 508
                           requires. 2.1 or 2.2 also runs the WCAG 2.1/2.2 rules and best
                           practices beyond Section 508, listed under their own heading
  --beyond-508             Same as --wcag 2.2
  --no-screenshots         Do not capture element screenshots
  --max-screenshots <n>    Screenshots per page (default 40)
  --max-tabs <n>           Maximum Tab presses per page (default 400)
  --max-activations <n>    Disclosure controls activated per page (default 12)
  --max-clicks <n>         Link-less navigation controls clicked per page to find pages
                           reachable only through click handlers (default 30)
  --no-follow-clicks       Do not click controls to discover pages; follow href links only
  --no-forms               Do not fill and submit search and filter forms to find result pages
  --search-months <n>      The date range a search form is filled with: from n months ago to
                           today (default 3)
  --user-agent <ua>        Override the browser user agent
  --chrome <path>          Browser executable (default: auto-detect, or CHROME_PATH)
  --no-sandbox             Pass --no-sandbox to Chrome (containers running as root)
  --quiet                  Only print the summary
  --json                   Print the report summary as JSON on stdout
  --events                 Print one JSON event per line on stdout instead of the
                           human-readable output (for tools; see the README)
  --list-tests             Print the Trusted Tester test catalog and exit (with --wcag
                           2.1/2.2, also the rules beyond Section 508)
  -h, --help               Show this help
  -v, --version            Show the version

Environment
  TOKEN         Sent on same-origin requests as "<token-header>: Bearer <TOKEN>".
                If TOKEN already contains a scheme ("Bearer x", "Basic x") it is sent as-is.
                The raw token is also written to localStorage and sessionStorage on those
                origins before any page script runs, under the keys most single-page apps
                read (token, access_token, accessToken, id_token, idToken, jwt, auth_token,
                authToken, plus any --token-storage key), so an app that checks web storage
                does not bounce the crawler to its login page.
  CHROME_PATH   Path to Chrome, Chromium, or Edge.

Fix loop
  loop          Crawl, triage review items and fix violations through an AI coding
                assistant, gate each fix with the app's build/test command, commit, push,
                wait for the deployment, and repeat until nothing is open or Ctrl+C.
                Reads a11y-508.config.json (--config) in the current directory; state
                lives in the ledger in the tool's own folder for the repository
                (~/.a11y-508/repos/<name>-<hash>/work), so a stopped loop resumes where it was.
    --max-rounds <n>   Rounds to run before stopping (default 20)
    --agent <spec>     claude | gemini | codex | a command with {promptFile} (overrides config)
    --dry-run          Crawl and update the ledger only; no agent, no commits
    --sign-in-first    Round 1 crawls in a visible window after you sign in (--login --stay),
                       saving the session the later rounds crawl with
    --from-report <file>  Round 1 starts from this report.json instead of crawling (it must be
                       for the config's URL and newer than the loop's last commit); round 2
                       crawls to verify the fixes
    --resume           Go on with the ledger's last round where it was interrupted: its open
                       findings are fixed with no new crawl; the next round crawls
  status        Print the ledger: what is open, pending, verified, and needs a person, and
                where the tool keeps its files for this repository.

Exit codes
  0  no violations at the --fail-on impacts     1  violations found
  2  usage or crawl error                        3  browser could not start
`;

export function parseArgs(argv) {
  const o = {
    url: null, maxPages: 200, maxDepth: 10, concurrency: 4, include: [], exclude: [], failOn: ['critical', 'serious'],
    out: null, viewport: { width: 1280, height: 800 }, timeout: 30000, settle: 500, extraHeaders: [],
    tokenHeader: 'Authorization', authOrigins: [], tokenStorage: true, tokenStorageKeys: [], cookies: [], login: false, loginOnly: false, stay: false, connect: null, stateFile: null, troubleshoot: false, interact: true, zoom: true, screenshots: true, maxScreenshots: 40,
    maxTabs: 400, maxActivations: 12, maxClicks: 30, followClicks: true, forms: true, searchMonths: 3, userAgent: null, chrome: null, noSandbox: false, quiet: false, json: false, events: false,
    listTests: false, help: false, version: false, wcag: '2.0',
  };
  const args = [...argv];
  const next = (flag) => {
    const v = args.shift();
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  const int = (flag, v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 0) throw new Error(`${flag} expects a non-negative integer, got "${v}"`);
    return n;
  };
  while (args.length) {
    let a = args.shift();
    if (a === '--') continue;
    let inline;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
      args.unshift(inline);
    }
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '--list-tests': o.listTests = true; break;
      case '--max-pages': o.maxPages = int(a, next(a)); break;
      case '--max-depth': o.maxDepth = int(a, next(a)); break;
      case '--concurrency': o.concurrency = Math.max(1, int(a, next(a))); break;
      case '--include': o.include.push(new RegExp(next(a))); break;
      case '--exclude': o.exclude.push(new RegExp(next(a))); break;
      case '--fail-on': {
        const v = next(a).toLowerCase();
        o.failOn = v === 'none' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
        for (const i of o.failOn) if (!IMPACTS.includes(i)) throw new Error(`--fail-on: unknown impact "${i}" (use ${IMPACTS.join(', ')}, or none)`);
        break;
      }
      case '--out': o.out = next(a); break;
      case '--viewport': {
        const m = /^(\d+)x(\d+)$/i.exec(next(a));
        if (!m) throw new Error('--viewport expects WIDTHxHEIGHT, e.g. 1280x800');
        o.viewport = { width: +m[1], height: +m[2] };
        break;
      }
      case '--timeout': o.timeout = int(a, next(a)); break;
      case '--settle': o.settle = int(a, next(a)); break;
      case '--header': {
        const v = next(a);
        const i = v.indexOf(':');
        if (i < 1) throw new Error('--header expects "Name: value"');
        o.extraHeaders.push({ name: v.slice(0, i).trim(), value: v.slice(i + 1).trim(), override: true });
        break;
      }
      case '--token-header': o.tokenHeader = next(a); break;
      case '--auth-origin': o.authOrigins.push(next(a)); break;
      case '--token-storage': o.tokenStorageKeys.push(next(a)); break;
      case '--no-token-storage': o.tokenStorage = false; break;
      case '--login': o.login = true; break;
      case '--login-only': o.login = true; o.loginOnly = true; break;
      case '--stay': o.stay = true; break;
      case '--connect': o.connect = next(a); break;
      case '--troubleshoot': case '--trouble-shoot': case '--diagnose': o.troubleshoot = true; break;
      case '--state': o.stateFile = next(a); break;
      case '--cookie': {
        const v = next(a);
        const i = v.indexOf('=');
        if (i < 1) throw new Error('--cookie expects "name=value"');
        o.cookies.push({ name: v.slice(0, i).trim(), value: v.slice(i + 1).trim() });
        break;
      }
      case '--no-interact': o.interact = false; break;
      case '--interact': o.interact = true; break;
      case '--no-zoom': o.zoom = false; break;
      case '--wcag': {
        const v = next(a).trim();
        if (!WCAG_VERSIONS.includes(v)) throw new Error(`--wcag: unknown version "${v}" (use ${WCAG_VERSIONS.join(', ')}; 2.0 is Section 508's own level)`);
        o.wcag = v;
        break;
      }
      case '--beyond-508': o.wcag = '2.2'; break;
      case '--zoom': o.zoom = true; break;
      case '--no-screenshots': o.screenshots = false; break;
      case '--screenshots': o.screenshots = true; break;
      case '--max-screenshots': o.maxScreenshots = int(a, next(a)); break;
      case '--max-tabs': o.maxTabs = int(a, next(a)); break;
      case '--max-activations': o.maxActivations = int(a, next(a)); break;
      case '--max-clicks': o.maxClicks = int(a, next(a)); break;
      case '--no-follow-clicks': o.followClicks = false; break;
      case '--follow-clicks': o.followClicks = true; break;
      case '--no-forms': o.forms = false; break;
      case '--forms': o.forms = true; break;
      case '--search-months': o.searchMonths = int(a, next(a)); break;
      case '--user-agent': o.userAgent = next(a); break;
      case '--chrome': o.chrome = next(a); break;
      case '--no-sandbox': o.noSandbox = true; break;
      case '--quiet': case '-q': o.quiet = true; break;
      case '--json': o.json = true; break;
      case '--events': o.events = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
        if (o.url) throw new Error(`Unexpected argument "${a}" (URL already given: ${o.url})`);
        o.url = a;
    }
  }
  if (o.connect && o.login && !o.loginOnly) o.stay = true;
  if (o.connect && !/^(\d+|wss?:\/\/\S+)$/.test(o.connect)) throw new Error('--connect expects a port number or a ws:// URL');
  if (o.stay && !o.login) throw new Error('--stay keeps the sign-in window to crawl in; use it with --login');
  if (o.stay && o.loginOnly) throw new Error('--stay crawls in the sign-in window; --login-only does not crawl, so use --login --stay');
  return o;
}

// "loop" and "status" take the loop's own flags; everything else is validated
// with parseArgs and passed through to each round's crawl.
export function splitLoopArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'loop' && command !== 'status') return null;
  const loop = { command, config: 'a11y-508.config.json', maxRounds: 20, agent: null, dryRun: false, signInFirst: false, fromReport: null, resume: false, help: false };
  const remaining = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => {
      const v = eq > 0 ? a.slice(eq + 1) : rest[++i];
      if (v === undefined) throw new Error(`${key} requires a value`);
      return v;
    };
    if (key === '--config') loop.config = val();
    else if (key === '--max-rounds') loop.maxRounds = Math.max(1, parseInt(val(), 10) || 0);
    else if (key === '--agent') loop.agent = val();
    else if (key === '--dry-run') loop.dryRun = true;
    else if (key === '--sign-in-first') loop.signInFirst = true;
    else if (key === '--from-report') loop.fromReport = val();
    else if (key === '--resume') loop.resume = true;
    else if (key === '-h' || key === '--help') loop.help = true;
    else remaining.push(a);
  }
  return { loop, remaining };
}

async function loopMain(split) {
  const { loop, remaining } = split;
  if (loop.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const out = (s) => process.stdout.write(s + '\n');
  if (loop.command === 'status') return printStatus(process.cwd(), out);
  let crawlOpts;
  try {
    crawlOpts = parseArgs(remaining);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n${HELP}`);
    return 2;
  }
  // --events is the loop's own: crawlOnce decides whether each round's crawl gets it.
  const passthrough = remaining.filter((a) => a !== crawlOpts.url && a !== '--events');
  const events = crawlOpts.events;
  const log = makeLogger({ quiet: false, json: false, events });
  log.event('start', { kind: 'loop', version: pkg.version, url: crawlOpts.url || null, dryRun: loop.dryRun });
  let config;
  try {
    config = loadConfig(loop.config, process.cwd());
  } catch (e) {
    log.error(e.message);
    return 2;
  }
  if (config._missing && !loop.dryRun) log.warn(`no ${loop.config} found; using command-line values only`);
  if (crawlOpts.url) {
    try {
      config._url = new URL(/^https?:\/\//i.test(crawlOpts.url) ? crawlOpts.url : 'http://' + crawlOpts.url).href;
    } catch {
      log.error(`"${crawlOpts.url}" is not a valid URL`);
      return 2;
    }
  }
  config._agent = loop.agent;
  const stopSignal = { stopped: false };
  const onSignal = () => {
    if (stopSignal.stopped) process.exit(130);
    stopSignal.stopped = true;
    log.warn('stopping after the current step (press Ctrl+C again to quit at once)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await runLoop({ config, cwd: process.cwd(), log, maxRounds: loop.maxRounds, dryRun: loop.dryRun, signInFirst: loop.signInFirst, fromReport: loop.fromReport, resume: loop.resume, passthrough, stopSignal, events });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

// Why the run failed, when a person should read it on the run's outcome (the done event's reason).
const runReason = { message: null };

// With --events the last line on stdout is always {"type":"done","code":N}.
export async function main(argv) {
  if (!argv.includes('--events') || argv[0] === 'status') return run(argv);
  const emit = eventWriter();
  let code;
  try {
    code = await run(argv);
  } catch (e) {
    emit('error', { message: `${e && e.message ? e.message : e}` });
    emit('done', { code: 2 });
    throw e;
  }
  emit('done', { code, ...(runReason.message && code !== 0 ? { reason: runReason.message } : {}) });
  return code;
}

async function run(argv) {
  const split = splitLoopArgs(argv);
  if (split) return loopMain(split);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(pkg.version + '\n');
    return 0;
  }
  if (opts.listTests) {
    for (const id of TEST_IDS) process.stdout.write(`${id.padEnd(5)} ${CATALOG[id].automation.padEnd(8)} ${CATALOG[id].name.padEnd(46)} WCAG ${CATALOG[id].wcag}\n`);
    const extra = beyondIds(opts.wcag);
    if (extra.length) {
      process.stdout.write(`\n${beyondHeading(opts.wcag)}\n`);
      for (const id of extra) {
        const t = BEYOND[id];
        process.stdout.write(`${id.padEnd(6)} ${t.automation.padEnd(8)} ${t.name.padEnd(46)} ${t.level === 'best-practice' ? 'best practice' : `WCAG ${t.wcag} (${t.level})`}\n`);
      }
    }
    return 0;
  }
  if (!opts.url) {
    process.stderr.write(`error: a start URL is required\n\n${HELP}`);
    return 2;
  }
  let startUrl;
  try {
    if (!/^https?:\/\//i.test(opts.url)) opts.url = 'http://' + opts.url;
    startUrl = new URL(opts.url);
  } catch {
    process.stderr.write(`error: "${opts.url}" is not a valid URL\n`);
    return 2;
  }

  const log = makeLogger(opts);
  log.event('start', { kind: opts.troubleshoot ? 'troubleshoot' : opts.loginOnly ? 'login' : 'crawl', version: pkg.version, url: startUrl.href, maxPages: opts.maxPages });
  const origins = new Set([startUrl.origin, ...opts.authOrigins.map((o) => new URL(o).origin)]);
  const token = process.env.TOKEN;
  if (token) {
    const trimmed = token.trim();
    const hasScheme = /^\S+\s+\S/.test(trimmed);
    const value = hasScheme ? trimmed : `Bearer ${trimmed}`;
    const raw = hasScheme ? trimmed.replace(/^\S+\s+/, '') : trimmed;
    const keys = [...new Set([...(opts.tokenStorage ? TOKEN_STORAGE_KEYS : []), ...opts.tokenStorageKeys])];
    opts.auth = { header: opts.tokenHeader, value, origins, storage: keys.length ? { keys, value: raw } : null };
    log.info(`auth: sending ${opts.tokenHeader} header on ${[...origins].join(', ')}`);
    if (keys.length) log.info(`auth: seeding TOKEN into localStorage and sessionStorage as ${keys.join(', ')}`);
  } else {
    opts.auth = null;
    if (opts.tokenStorageKeys.length) log.warn('--token-storage ignored because TOKEN is not set.');
    // A saved session or cookies are a way in of their own; the warning is for a run with no way in at all.
    if (!opts.login && !opts.stateFile && !opts.cookies.length) log.warn('TOKEN is not set; crawling without an Authorization header.');
  }
  // Nothing the run was given as a credential reaches the diagnostics diary.
  addDiarySecrets([token, ...opts.cookies.map((c) => c.value), ...opts.extraHeaders.map((h) => h.value)]);
  opts.cookieOrigins = opts.cookies.length ? [...origins] : [];
  if (opts.cookies.length) log.info(`cookies: setting ${opts.cookies.map((c) => c.name).join(', ')} on ${[...origins].join(', ')}`);

  // --connect: the running browser (its window), one tab at a time.
  if (opts.connect) opts.concurrency = 1;
  const launch = (headless) => (opts.connect ? connectChrome(opts.connect) : launchChrome({ chromePath: opts.chrome, viewport: opts.viewport, noSandbox: opts.noSandbox, headless }));
  // fast: the Stop path (an interrupt): a short grace, then the browser's process tree is killed.
  const closeBrowser = async (b, { fast = false } = {}) => {
    const { removed, userDataDir } = await b.close({ fast });
    if (!removed) log.warn(`could not remove the temporary browser profile ${userDataDir}; delete it by hand`);
  };

  opts.state = null;
  let stayBrowser = null;
  if (opts.login) {
    const file = resolve(opts.stateFile || 'a11y-508-state.json');
    let headed;
    try {
      headed = await launch(false);
    } catch (e) {
      log.error(e.message);
      return 3;
    }
    // Stopped while the sign-in window is open (Ctrl+C, the dashboard's Stop): close that browser too.
    const onLoginSignal = async () => {
      log.warn('interrupted; closing the sign-in browser');
      await closeBrowser(headed, { fast: true }).catch(() => {});
      process.exit(130);
    };
    process.once('SIGINT', onLoginSignal);
    process.once('SIGTERM', onLoginSignal);
    try {
      opts.state = await interactiveLogin({ browser: headed, startUrl: startUrl.href, origins: [...origins], timeout: opts.timeout, log, keepOpen: opts.stay });
    } catch (e) {
      // The sign-in's browser went away under it (closed, killed or crashed): said plainly, and recorded.
      const d = headed.death ? headed.death() : null;
      if (d) {
        const message = opts.connect ? `the browser the crawl was using closed: ${deathText(d)}` : `the sign-in browser closed: ${deathText(d)}`;
        writeDiary({ type: 'sign-in-browser-died', connected: !!opts.connect, url: startUrl.href, code: d.code, signal: d.signal, stderr: d.stderr, cause: deathText(d) }, { source: 'cli' });
        log.error(message);
        runReason.message = message;
      } else log.error(`login failed: ${e.message}`);
      await closeBrowser(headed);
      return 2;
    } finally {
      process.off('SIGINT', onLoginSignal);
      process.off('SIGTERM', onLoginSignal);
    }
    // --stay: the signed-in window stays open and the crawl runs in it, one tab at
    // a time (a visible browser paints only its front tab).
    if (opts.stay) {
      stayBrowser = headed;
      opts.concurrency = 1;
    } else await closeBrowser(headed);
    saveState(file, opts.state);
    log.info(`session: saved ${stateSummary(opts.state)} to ${file}`);
    log.event('session-saved', { file, summary: stateSummary(opts.state) });
    log.warn(`${file} holds live credentials; keep it out of version control. Reuse it with --state ${opts.stateFile || 'a11y-508-state.json'}`);
    if (opts.loginOnly) {
      log.info('session saved; not crawling (--login-only)');
      return 0;
    }
  } else if (opts.stateFile) {
    try {
      opts.state = loadState(resolve(opts.stateFile));
    } catch (e) {
      log.error(e.message);
      return 2;
    }
    log.info(`session: loaded ${stateSummary(opts.state)} from ${opts.stateFile}`);
  }

  let browser = stayBrowser;
  if (!browser) {
    try {
      browser = await launch(true);
    } catch (e) {
      log.error(e.message);
      return 3;
    }
  }
  const browserName = `${browser.version.product} (${browser.exe})`;
  log.info(`browser: ${browserName}`);
  if (browser.launchRetries) log.warn(`browser: it did not answer on its first launch and was started again with a fresh profile (launchRetries ${browser.launchRetries})`);

  if (opts.troubleshoot) {
    let result;
    try {
      result = await troubleshoot({ browser, startUrl: startUrl.href, opts });
    } catch (e) {
      log.error(`troubleshoot failed: ${e.message}`);
      await closeBrowser(browser);
      return 2;
    }
    await closeBrowser(browser);
    if (opts.events) log.event('troubleshoot', { result });
    else process.stdout.write(opts.json ? JSON.stringify(result, null, 2) + '\n' : formatTroubleshoot(result));
    return result.ok ? 0 : 2;
  }

  // Inside a repository the report goes to the tool's own folder for it, never into the repository
  // (an explicit --out is used as given); elsewhere ./a11y-508-report.
  let outDir = opts.out ? resolve(opts.out) : null;
  if (!outDir && gitDirOf(process.cwd())) {
    for (const l of migrationLines(migrateRepo(process.cwd()))) log.info(l);
    outDir = reportDir(process.cwd());
  }
  if (!outDir) outDir = resolve('a11y-508-report');
  log.info(`crawling ${startUrl.href} (max ${opts.maxPages} pages, depth ${opts.maxDepth}, ${opts.concurrency} tabs)`);

  const startedAt = new Date().toISOString();
  let crawlResult;
  let exitCode = 0;
  const onSignal = async () => {
    log.warn('interrupted; closing browser');
    await closeBrowser(browser, { fast: true });
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // The crawl's own browser is launched again once if it dies (never a --connect or --stay one).
  const relaunch = opts.connect || stayBrowser ? null : () => launch(true);
  try {
    crawlResult = await crawl({ browser, startUrl: startUrl.href, opts, log, outDir, relaunch, onBrowser: (b) => (browser = b) });
  } catch (e) {
    // A browser that went away (in --connect mode, or a second time) ends the crawl with that cause.
    if (e && e.browserGone) {
      log.error(e.message);
      runReason.message = e.message;
    } else if (opts.connect && browser.death && browser.death()) {
      const message = `the browser the crawl was using closed: ${deathText(browser.death())}`;
      writeDiary({ type: 'crawl-browser-died', connected: true, url: startUrl.href, cause: deathText(browser.death()) }, { source: 'cli' });
      log.error(message);
      runReason.message = message;
    } else log.error(`crawl failed: ${e.message}`);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await closeBrowser(browser).catch(() => {});
    return 2;
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await closeBrowser(browser);

  const { pages } = crawlResult;
  const site = siteChecks(pages);
  const summary = summarize(pages, site);
  summary.coverage = coverage(pages, crawlResult, opts);
  const passed = !shouldFail(summary, opts.failOn);
  const report = {
    tool: { name: pkg.name, version: pkg.version },
    browser: browserField(browser),
    baseUrl: startUrl.href,
    startedAt,
    finishedAt: new Date().toISOString(),
    options: {
      maxPages: opts.maxPages, maxDepth: opts.maxDepth, concurrency: opts.concurrency, include: opts.include.map(String), exclude: opts.exclude.map(String),
      failOn: opts.failOn, viewport: opts.viewport, timeout: opts.timeout, interact: opts.interact, followClicks: opts.followClicks, maxClicks: opts.maxClicks, forms: opts.forms, searchMonths: opts.searchMonths, zoom: opts.zoom, screenshots: opts.screenshots,
      tokenHeader: opts.auth ? opts.tokenHeader : null, authOrigins: opts.auth ? [...opts.auth.origins] : [],
      tokenStorage: opts.auth && opts.auth.storage ? opts.auth.storage.keys : [], cookies: opts.cookies.map((c) => c.name),
      session: opts.state ? { cookies: opts.state.cookies.length, origins: Object.keys(opts.state.storage || {}) } : null,
      // Recorded only when the profile is on, so a default report.json keeps its shape.
      ...(opts.wcag !== '2.0' ? { wcag: opts.wcag } : {}),
      // Recorded only for a crawl that ran in the signed-in, visible window (--login --stay).
      ...(stayBrowser && browser === stayBrowser ? { stay: true } : {}),
      // Recorded only for a crawl in a browser that was already running (--connect).
      ...(opts.connect ? { connected: true } : {}),
    },
    passed,
    summary,
    site: { findings: site.findings },
    manual: site.manual,
    pages,
    catalog: opts.wcag !== '2.0' ? { ...CATALOG, ...Object.fromEntries(beyondIds(opts.wcag).map((id) => [id, BEYOND[id]])) } : CATALOG,
  };
  const files = writeReports({ outDir, report });
  log.summary(report, files);
  if (opts.json && !opts.events) process.stdout.write(JSON.stringify({ passed, summary, files, baseUrl: report.baseUrl }, null, 2) + '\n');

  if (pages.length === 1 && (pages[0].error || pages[0].skipped)) {
    log.error(`the start page could not be audited: ${pages[0].error || pages[0].skipped}`);
    exitCode = 2;
  } else if (!passed) exitCode = 1;
  return exitCode;
}
