// Same-origin breadth-first crawl with a pool of tabs.

import { Page, sleep } from './page.mjs';
import { auditPage } from './audit.mjs';

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

export async function crawl({ browser, startUrl, opts, log, outDir }) {
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
  const ctx = { opts, origin, outDir, nextPageIndex: () => ++pageCounter };
  const allowed = (u) => {
    if (opts.exclude.some((re) => re.test(u))) return false;
    if (opts.include.length && !opts.include.some((re) => re.test(u))) return false;
    return true;
  };

  // Close popups opened by pages and refuse downloads.
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  await browser.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  const workerTargets = new Set();
  browser.cdp.on('Target.targetCreated', ({ targetInfo }) => {
    if (targetInfo.type === 'page' && targetInfo.openerId && !workerTargets.has(targetInfo.targetId)) {
      browser.cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
    }
  });

  async function newWorkerPage() {
    const session = await browser.newPage();
    workerTargets.add(session.targetId);
    const page = new Page(session, opts);
    await page.init();
    return { session, page };
  }

  async function worker(id) {
    let { session, page } = await newWorkerPage();
    try {
      while (true) {
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
          if (page.closed || /closed|crashed|detached/i.test(res.error || '')) {
            await browser.closePage(session).catch(() => {});
            ({ session, page } = await newWorkerPage());
          }
          res.depth = item.depth;
          if (item.via === 'click') res.foundBy = 'click';
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
          }
        } finally {
          active--;
        }
      }
    } finally {
      await browser.closePage(session).catch(() => {});
    }
  }

  const n = Math.max(1, Math.min(opts.concurrency, opts.maxPages));
  await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));
  return { pages, discovered: seen.size, overflow, clickOnly: clickOnly.size, origin, variantOverflow, variantRoutes: [...variantRoutes], variantsPerRoute: VARIANTS_PER_ROUTE };
}
