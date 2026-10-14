// Same-origin breadth-first crawl with a pool of tabs.

import { Page, sleep } from './page.mjs';
import { progressReporter } from './progress.mjs';
import { auditPage } from './audit.mjs';
import { codeText, exitCause, writeDiary } from './diary.mjs';

// The crawl's browser went away and the crawl cannot go on: message is what a person reads.
export class BrowserGone extends Error {
  constructor(message, death) {
    super(message);
    this.browserGone = true;
    this.death = death || null;
  }
}

// A browser's death in words: "Chrome exited with code 1, signal none" (or the connection lost).
export function deathText(d) {
  if (!d) return 'it stopped answering';
  if (d.how && d.how !== 'exited') return d.how;
  return `Chrome ${exitCause(d.code, d.signal)} (exit code ${codeText(d.code)}, signal ${d.signal || 'none'})${d.stderr && d.stderr.length ? `; its last output: ${d.stderr[d.stderr.length - 1]}` : ''}`;
}

// A11Y_508_TEST_KILL_BROWSER_AFTER=2[,3]: tests only. Kills the crawl's launched browser once the
// crawl has recorded that many pages, as a browser that dies mid-crawl.
const KILL_AFTER = String(process.env.A11Y_508_TEST_KILL_BROWSER_AFTER || '').split(',').map(Number).filter((n) => n > 0);

const BINARY = /\.(pdf|zip|gz|tgz|tar|rar|7z|exe|dmg|pkg|msi|png|jpe?g|gif|svg|webp|bmp|ico|mp3|mp4|m4a|m4v|mov|avi|wmv|webm|ogg|wav|flac|doc|docx|xls|xlsx|ppt|pptx|csv|xml|json|rss|atom|woff2?|ttf|eot|css|js|mjs)(\?.*)?$/i;

export function normalizeUrl(href, origin) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== origin) return null;
  if (!/^#!?\//.test(u.hash)) u.hash = ''; // keep hash routes (#/path), drop in-page anchors
  u.username = '';
  u.password = '';
  if (BINARY.test(u.pathname)) return null;
  let s = u.href;
  if (s.endsWith('?')) s = s.slice(0, -1);
  return s;
}

// The route a URL belongs to: its path (and hash route) plus the names of its
// query parameters, not their values. /search?from=1&to=2 and
// /search?from=3&to=4 are one route, and an app whose pages link to date
// variants of themselves would otherwise be crawled to the page limit.
export function routeKey(url) {
  const u = new URL(url);
  const keys = [...u.searchParams.keys()].sort().join('&');
  return `${u.pathname}${u.hash}${keys ? '?' + keys : ''}`;
}
const VARIANTS_PER_ROUTE = 2;

// relaunch: a function that launches a new browser (the crawl's own, headless one), or null for a
// browser the crawl must not replace (--connect, --login --stay). When the browser dies mid-crawl it
// is launched once more and the crawl goes on from the next page; a second death, or a death with
// no relaunch, ends the crawl with BrowserGone. onBrowser(b) is told of each new browser.
export async function crawl({ browser: firstBrowser, startUrl, opts, log, outDir, relaunch = null, onBrowser = null }) {
  let browser = firstBrowser;
  const relaunches = [];
  let recovering = null;
  let fatal = null;
  const origin = new URL(startUrl).origin;
  const first = normalizeUrl(startUrl, origin) || startUrl;
  const queue = [{ url: first, depth: 0 }];
  const seen = new Set([first]);
  // URLs a page landed on after a redirect: already audited, never queued again.
  const landed = new Set();
  const audited = new Set(); // final URLs of pages audited so far, so a redirect target is audited once
  const variants = new Map(); // route key -> query variants of it accepted so far
  const variantRoutes = new Set();
  let variantOverflow = 0;
  // True when this URL may be crawled: a URL without a query always, one with a query
  // only while its route has fewer than VARIANTS_PER_ROUTE variants accepted.
  const acceptVariant = (u) => {
    if (!new URL(u).search) return true;
    const k = routeKey(u);
    const c = variants.get(k) || 0;
    if (c >= VARIANTS_PER_ROUTE) return false;
    variants.set(k, c + 1);
    return true;
  };
  acceptVariant(first);
  const pages = [];
  let active = 0;
  let pageCounter = 0;
  let overflow = 0;
  const clickOnly = new Set();
  // --events: where each page in flight is (src/progress.mjs).
  const progress = opts.events && log.event ? progressReporter((e) => log.event('progress', e)) : null;
  const ctx = { opts, origin, outDir, nextPageIndex: () => ++pageCounter, progress };
  const allowed = (u) => {
    if (opts.exclude.some((re) => re.test(u))) return false;
    if (opts.include.length && !opts.include.some((re) => re.test(u))) return false;
    return true;
  };

  const workerTargets = new Set();
  // Close popups opened by pages and refuse downloads.
  async function prepare(b) {
    await b.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await b.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    b.cdp.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type === 'page' && targetInfo.openerId && !workerTargets.has(targetInfo.targetId)) {
        b.cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
      }
    });
  }
  await prepare(browser);

  const dead = (b = browser) => (b.alive ? !b.alive() : b.cdp.closed);
  // The browser died: launch it again once (all workers wait on the same relaunch), or end the crawl.
  function recover() {
    if (fatal) return Promise.reject(fatal);
    if (!dead()) return Promise.resolve();
    if (recovering) return recovering;
    const old = browser;
    recovering = (async () => {
      const d = old.death ? old.death() : null;
      const cause = deathText(d);
      const connected = !!old.connected;
      writeDiary({ type: 'crawl-browser-died', connected, url: startUrl, pagesDone: pages.length, code: d ? d.code : null, signal: d ? d.signal : null, stderr: d ? d.stderr : [], cause, relaunching: !!relaunch && relaunches.length === 0 }, { source: 'cli' });
      if (!relaunch) throw (fatal = new BrowserGone(`the browser the crawl was using closed: ${cause}`, d));
      if (relaunches.length >= 1) throw (fatal = new BrowserGone(`the browser the crawl was using closed again: ${cause}`, d));
      log.warn(`the crawl's browser closed after ${pages.length} page(s) (${cause}); starting it again and going on from the next page`);
      await old.close().catch(() => {});
      let next;
      try {
        next = await relaunch();
      } catch (e) {
        throw (fatal = new BrowserGone(`the browser the crawl was using closed (${cause}), and could not be started again: ${e.message}`, d));
      }
      relaunches.push({ afterPages: pages.length, cause });
      browser = next;
      if (onBrowser) onBrowser(next);
      await prepare(next);
      writeDiary({ type: 'crawl-browser-relaunched', url: startUrl, afterPages: pages.length, cause }, { source: 'cli' });
    })().finally(() => {
      recovering = null;
    });
    return recovering;
  }

  async function newWorkerPage() {
    if (dead()) await recover();
    const b = browser;
    const session = await b.newPage();
    workerTargets.add(session.targetId);
    const page = new Page(session, opts);
    await page.init();
    return { session, page, b };
  }

  async function worker(id) {
    let { session, page, b } = await newWorkerPage();
    try {
      while (true) {
        if (fatal) throw fatal;
        // This worker's tab belongs to a browser that died (or was replaced): a new tab first.
        if (b !== browser || dead(b)) {
          await recover();
          ({ session, page, b } = await newWorkerPage());
        }
        const item = queue.shift();
        if (!item) {
          if (active === 0) break;
          await sleep(100);
          continue;
        }
        active++;
        try {
          let res;
          try {
            res = await auditPage(page, item.url, ctx);
          } catch (e) {
            res = { url: item.url, error: e.message, findings: [], passes: {}, errors: [] };
          }
          if (dead(b)) {
            // The browser died while this page was audited: the page is recorded with the error
            // and the crawl goes on from the next one, in a browser started again.
            const d = b.death ? b.death() : null;
            res = { url: item.url, error: `the browser closed while this page was audited (${deathText(d)})`, findings: [], passes: {}, errors: [] };
            await recover();
            ({ session, page, b } = await newWorkerPage());
          } else if (page.closed || /closed|crashed|detached/i.test(res.error || '')) {
            await b.closePage(session).catch(() => {});
            ({ session, page, b } = await newWorkerPage());
          }
          res.depth = item.depth;
          if (item.via === 'click') res.foundBy = 'click';
          if (item.via === 'form') res.foundBy = 'form';
          // A page that lands on another URL (an app's start route that
          // redirects to its default view) is that URL's page: audit it once.
          const landedOn = (res.finalUrl && normalizeUrl(res.finalUrl, origin)) || item.url;
          if (!res.error && !res.skipped) {
            if (audited.has(landedOn)) {
              res.skipped = `the same page as ${landedOn}, already audited`;
              res.findings = [];
            } else {
              audited.add(landedOn);
              if (landedOn !== item.url) {
                // Not added to seen: that set is the "pages found" count, and the
                // landing page is the same page as the URL that led to it.
                landed.add(landedOn);
                acceptVariant(landedOn); // the landing page counts as a variant of its route
                for (let i = queue.length - 1; i >= 0; i--) if (queue[i].url === landedOn) queue.splice(i, 1);
              }
            }
          }
          pages.push(res);
          log.page(res, pages.length, seen.size);
          if (KILL_AFTER.includes(pages.length) && browser.proc && !dead()) {
            try {
              process.kill(browser.proc.pid, 'SIGKILL');
            } catch {}
            await Promise.race([browser.exited, sleep(5000)]);
          }
          if (res.info && item.depth < opts.maxDepth) {
            const viaClick = (res.discovery && res.discovery.urls) || [];
            for (const link of [...res.info.links, ...viaClick]) {
              const n = normalizeUrl(link, origin);
              if (!n || seen.has(n) || landed.has(n) || !allowed(n)) continue;
              if (!acceptVariant(n)) {
                variantOverflow++;
                variantRoutes.add(routeKey(n));
                continue;
              }
              if (seen.size >= opts.maxPages) {
                overflow++;
                continue;
              }
              seen.add(n);
              if (viaClick.includes(link) && !res.info.links.includes(link)) clickOnly.add(n);
              queue.push({ url: n, depth: item.depth + 1, via: clickOnly.has(n) ? 'click' : 'link' });
            }
            // What a search revealed: the first two results of each search are queued whatever the
            // query-variant limit says.
            for (const { url, priority } of (res.search && res.search.urls) || []) {
              const n = normalizeUrl(url, origin);
              if (!n || seen.has(n) || landed.has(n) || !allowed(n)) continue;
              if (priority) {
                const k = routeKey(n);
                variants.set(k, (variants.get(k) || 0) + 1);
              } else if (!acceptVariant(n)) {
                variantOverflow++;
                variantRoutes.add(routeKey(n));
                continue;
              }
              if (seen.size >= opts.maxPages) {
                overflow++;
                continue;
              }
              seen.add(n);
              queue.push({ url: n, depth: item.depth + 1, via: 'form' });
            }
          }
        } finally {
          active--;
        }
      }
    } finally {
      if (!dead(b)) await b.closePage(session).catch(() => {});
    }
  }

  const n = Math.max(1, Math.min(opts.concurrency, opts.maxPages));
  try {
    await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));
  } finally {
    if (progress) progress.stop();
  }
  return { pages, discovered: seen.size, overflow, clickOnly: clickOnly.size, origin, variantOverflow, variantRoutes: [...variantRoutes], variantsPerRoute: VARIANTS_PER_ROUTE, browser, relaunches };
}
