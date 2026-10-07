// Command-line entry: argument parsing and orchestration.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';
import { crawl } from './crawler.mjs';
import { interactiveLogin, loadState, saveState, stateSummary } from './login.mjs';
import { siteChecks } from './site-checks.mjs';
import { summarize, shouldFail, writeReports, makeLogger } from './report.mjs';
import { CATALOG, IMPACTS, TEST_IDS } from './checks/catalog.mjs';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

// Web-storage keys that single-page apps commonly read their session token from.
export const TOKEN_STORAGE_KEYS = ['token', 'access_token', 'accessToken', 'id_token', 'idToken', 'jwt', 'auth_token', 'authToken'];

const HELP = `a11y-508 ${pkg.version} - Section 508 crawler (DHS Trusted Tester checks, no dependencies)

Usage: a11y-508 <url> [options]
       npm run e2e:a11y-508 <url> [-- options]

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
  --out <dir>              Report directory (default ./a11y-508-report)
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
  --no-interact            Skip the keyboard and disclosure-activation passes
  --no-zoom                Skip the 200% zoom pass
  --no-screenshots         Do not capture element screenshots
  --max-screenshots <n>    Screenshots per page (default 40)
  --max-tabs <n>           Maximum Tab presses per page (default 400)
  --max-activations <n>    Disclosure controls activated per page (default 12)
  --user-agent <ua>        Override the browser user agent
  --chrome <path>          Browser executable (default: auto-detect, or CHROME_PATH)
  --no-sandbox             Pass --no-sandbox to Chrome (containers running as root)
  --quiet                  Only print the summary
  --json                   Print the report summary as JSON on stdout
  --list-tests             Print the Trusted Tester test catalog and exit
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

Exit codes
  0  no violations at the --fail-on impacts     1  violations found
  2  usage or crawl error                        3  browser could not start
`;

export function parseArgs(argv) {
  const o = {
    url: null, maxPages: 200, maxDepth: 10, concurrency: 4, include: [], exclude: [], failOn: ['critical', 'serious'],
    out: 'a11y-508-report', viewport: { width: 1280, height: 800 }, timeout: 30000, settle: 500, extraHeaders: [],
    tokenHeader: 'Authorization', authOrigins: [], tokenStorage: true, tokenStorageKeys: [], cookies: [], login: false, stateFile: null, interact: true, zoom: true, screenshots: true, maxScreenshots: 40,
    maxTabs: 400, maxActivations: 12, userAgent: null, chrome: null, noSandbox: false, quiet: false, json: false,
    listTests: false, help: false, version: false,
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
      case '--zoom': o.zoom = true; break;
      case '--no-screenshots': o.screenshots = false; break;
      case '--screenshots': o.screenshots = true; break;
      case '--max-screenshots': o.maxScreenshots = int(a, next(a)); break;
      case '--max-tabs': o.maxTabs = int(a, next(a)); break;
      case '--max-activations': o.maxActivations = int(a, next(a)); break;
      case '--user-agent': o.userAgent = next(a); break;
      case '--chrome': o.chrome = next(a); break;
      case '--no-sandbox': o.noSandbox = true; break;
      case '--quiet': case '-q': o.quiet = true; break;
      case '--json': o.json = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
        if (o.url) throw new Error(`Unexpected argument "${a}" (URL already given: ${o.url})`);
        o.url = a;
    }
  }
  return o;
}

export async function main(argv) {
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
    log.warn('TOKEN is not set; crawling without an Authorization header.');
  }
  opts.cookieOrigins = opts.cookies.length ? [...origins] : [];
  if (opts.cookies.length) log.info(`cookies: setting ${opts.cookies.map((c) => c.name).join(', ')} on ${[...origins].join(', ')}`);

  const launch = (headless) => launchChrome({ chromePath: opts.chrome, viewport: opts.viewport, noSandbox: opts.noSandbox, headless });
  const closeBrowser = async (b) => {
    const { removed, userDataDir } = await b.close();
    if (!removed) log.warn(`could not remove the temporary browser profile ${userDataDir}; delete it by hand`);
  };

  opts.state = null;
  if (opts.login) {
    const file = resolve(opts.stateFile || 'a11y-508-state.json');
    let headed;
    try {
      headed = await launch(false);
    } catch (e) {
      log.error(e.message);
      return 3;
    }
    try {
      opts.state = await interactiveLogin({ browser: headed, startUrl: startUrl.href, origins: [...origins], timeout: opts.timeout, log });
    } catch (e) {
      log.error(`login failed: ${e.message}`);
      await closeBrowser(headed);
      return 2;
    }
    await closeBrowser(headed);
    saveState(file, opts.state);
    log.info(`session: saved ${stateSummary(opts.state)} to ${file}`);
    log.warn(`${file} holds live credentials; keep it out of version control. Reuse it with --state ${opts.stateFile || 'a11y-508-state.json'}`);
  } else if (opts.stateFile) {
    try {
      opts.state = loadState(resolve(opts.stateFile));
    } catch (e) {
      log.error(e.message);
      return 2;
    }
    log.info(`session: loaded ${stateSummary(opts.state)} from ${opts.stateFile}`);
  }

  const outDir = resolve(opts.out);
  let browser;
  try {
    browser = await launch(true);
  } catch (e) {
    log.error(e.message);
    return 3;
  }
  const browserName = `${browser.version.product} (${browser.exe})`;
  log.info(`browser: ${browserName}`);
  log.info(`crawling ${startUrl.href} (max ${opts.maxPages} pages, depth ${opts.maxDepth}, ${opts.concurrency} tabs)`);

  const startedAt = new Date().toISOString();
  let crawlResult;
  let exitCode = 0;
  const onSignal = async () => {
    log.warn('interrupted; closing browser');
    await closeBrowser(browser);
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    crawlResult = await crawl({ browser, startUrl: startUrl.href, opts, log, outDir });
  } catch (e) {
    log.error(`crawl failed: ${e.message}`);
    await closeBrowser(browser);
    return 2;
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await closeBrowser(browser);

  const { pages } = crawlResult;
  const site = siteChecks(pages);
  const summary = summarize(pages, site);
  const passed = !shouldFail(summary, opts.failOn);
  const report = {
    tool: { name: pkg.name, version: pkg.version },
    browser: browserName,
    baseUrl: startUrl.href,
    startedAt,
    finishedAt: new Date().toISOString(),
    options: {
      maxPages: opts.maxPages, maxDepth: opts.maxDepth, concurrency: opts.concurrency, include: opts.include.map(String), exclude: opts.exclude.map(String),
      failOn: opts.failOn, viewport: opts.viewport, timeout: opts.timeout, interact: opts.interact, zoom: opts.zoom, screenshots: opts.screenshots,
      tokenHeader: opts.auth ? opts.tokenHeader : null, authOrigins: opts.auth ? [...opts.auth.origins] : [],
      tokenStorage: opts.auth && opts.auth.storage ? opts.auth.storage.keys : [], cookies: opts.cookies.map((c) => c.name),
      session: opts.state ? { cookies: opts.state.cookies.length, origins: Object.keys(opts.state.storage || {}) } : null,
    },
    passed,
    summary,
    site: { findings: site.findings },
    manual: site.manual,
    pages,
    catalog: CATALOG,
  };
  const files = writeReports({ outDir, report });
  log.summary(report, files);
  if (opts.json) process.stdout.write(JSON.stringify({ passed, summary, files, baseUrl: report.baseUrl }, null, 2) + '\n');

  if (pages.length === 1 && (pages[0].error || pages[0].skipped)) {
    log.error(`the start page could not be audited: ${pages[0].error || pages[0].skipped}`);
    exitCode = 2;
  } else if (!passed) exitCode = 1;
  return exitCode;
}
