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
  u.hash = '';
  u.username = '';
  u.password = '';
  if (BINARY.test(u.pathname)) return null;
  let s = u.href;
  if (s.endsWith('?')) s = s.slice(0, -1);
  return s;
}

export async function crawl({ browser, startUrl, opts, log, outDir }) {
  const origin = new URL(startUrl).origin;
  const first = normalizeUrl(startUrl, origin) || startUrl;
  const queue = [{ url: first, depth: 0 }];
  const seen = new Set([first]);
  const pages = [];
  let active = 0;
  let pageCounter = 0;
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
          pages.push(res);
          log.page(res, pages.length, seen.size);
          if (res.info && item.depth < opts.maxDepth) {
            for (const link of res.info.links) {
              const n = normalizeUrl(link, origin);
              if (!n || seen.has(n) || !allowed(n)) continue;
              if (seen.size >= opts.maxPages) break;
              seen.add(n);
              queue.push({ url: n, depth: item.depth + 1 });
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
  return { pages, discovered: seen.size, origin };
}
