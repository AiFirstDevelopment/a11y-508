// Evidence for the manual flow (docs/plans/manual-findings.md): the tool, not the assistant, opens a
// deployed page in the crawler's own headless browser with the crawl's way in (the saved sign-in,
// cookies, the TOKEN header) and keeps what a reviewer would look at: a screenshot, the
// accessibility tree, the outer HTML of the elements the finding describes, and the Tab order.
// The assistant is handed these files; it never gets a browser.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './chrome.mjs';
import { Page, sleep } from './page.mjs';
import { crawlOptions } from './deploy-check.mjs';

export const TAB_STOPS = 60;
const MAX_MATCHES = 10;

// What the focused element is, read in the page: role, accessible name (a close approximation) and
// a short selector.
const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const implicit = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', IFRAME: 'document' };
  const type = (el.getAttribute('type') || '').toLowerCase();
  let role = el.getAttribute('role') || implicit[el.tagName] || el.tagName.toLowerCase();
  if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(type)) role = type;
  if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) role = 'button';
  const by = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => id && document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ');
  const label = el.id ? [...document.querySelectorAll('label')].find((l) => l.htmlFor === el.id) : null;
  const name = (el.getAttribute('aria-label') || by || (label && label.textContent) || el.getAttribute('alt') || (el.tagName === 'INPUT' ? el.value : el.innerText) || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const path = [];
  for (let n = el; n && n.nodeType === 1 && path.length < 4; n = n.parentElement) {
    if (n.id) { path.unshift('#' + CSS.escape(n.id)); break; }
    const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
    path.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : ''));
  }
  return JSON.stringify({ role, name, selector: path.join(' > ') });
})()`;

// What the loaded document says about itself, for the not-found check: its title, its first heading,
// the first 200 characters of its main region's text and how many words that region has (the body
// when there is no main).
const ABOUT = `(() => {
  const main = document.querySelector('main, [role=main]') || document.body;
  const text = ((main && main.innerText) || '').replace(/\\s+/g, ' ').trim();
  const h = document.querySelector('h1, h2');
  return JSON.stringify({ title: document.title || '', heading: h ? (h.innerText || h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : '', main: text.slice(0, 200), mainWords: text ? text.split(' ').length : 0 });
})()`;

// Whether a document that loaded is the application's own "Not Found" view (docs/plans/
// pictures-and-routes.md AC 6): its title, first heading or the start of its main text says so, and
// the main region is short. Pure, so it can be tested without a browser.
export const NOT_FOUND_WORDS = /\b(not found|page not found|404|no such page|does ?n.t exist)\b/i;
export const NOT_FOUND_MAX_WORDS = 60;
export function notFoundView({ title = '', heading = '', main = '', mainWords = 0 } = {}) {
  const says = [title, heading, String(main || '').slice(0, 200)].some((t) => NOT_FOUND_WORDS.test(String(t || '')));
  return says && Number(mainWords) < NOT_FOUND_MAX_WORDS;
}

const MATCHES = (selectors) => `(() => {
  const out = [];
  for (const sel of ${JSON.stringify(selectors)}) {
    let list = [];
    try { list = [...document.querySelectorAll(sel)]; } catch { out.push({ selector: sel, error: 'not a valid selector', html: [] }); continue; }
    out.push({ selector: sel, count: list.length, html: list.slice(0, ${MAX_MATCHES}).map((e) => e.outerHTML.slice(0, 2000)) });
  }
  return JSON.stringify(out);
})()`;

// One browser for a stage's captures. args: the crawl's options (--state, --cookie, ...), read as
// the crawl reads them. capture({ url, selectors, dir }) resolves the summary (also written to
// dir/summary.json): { url, finalUrl, status, loaded, portal, error, at, matched, files, notFound,
// title, heading, mainWords }. A page is loaded only when it answered below HTTP 400 and is not the
// application's own Not Found view; the screenshot is kept either way, so the person can see what
// the tool saw.
export async function evidenceBrowser({ startUrl, args = [], cwd = process.cwd(), timeout = 45000 }) {
  let opts = await crawlOptions(startUrl, args, cwd);
  const browser = await launchChrome({ chromePath: opts.chrome, viewport: opts.page.viewport, noSandbox: opts.noSandbox, headless: true });
  return {
    // After a sign-in: the saved session is read again for the next captures.
    async refresh() {
      opts = await crawlOptions(startUrl, args, cwd);
    },
    async capture({ url, selectors = [], dir }) {
      mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      const summary = { url, finalUrl: null, status: null, loaded: false, portal: false, error: null, at, matched: 0, files: [], notFound: false, title: null, heading: null, mainWords: null };
      const session = await browser.newPage();
      try {
        const page = new Page(session, opts.page);
        await page.init();
        try {
          await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        } catch {}
        const r = await page.goto(url, timeout);
        summary.finalUrl = r.finalUrl || url;
        summary.status = r.status ?? null;
        let host = null;
        try {
          host = new URL(summary.finalUrl).host;
        } catch {}
        summary.portal = r.status === 401 || r.status === 403 || (!!host && host !== new URL(url).host);
        // Any answer of HTTP 400 or more is a page that is not there, a 404 included: no evidence.
        summary.error = r.error || (r.timedOut ? 'the page did not finish loading in time' : summary.portal ? `the page asks for a sign-in (${r.status === 401 || r.status === 403 ? `HTTP ${r.status}` : `sent to ${host}`})` : r.status >= 400 ? `HTTP ${r.status}` : null);
        summary.loaded = !summary.error;
        if (!r.error) {
          // The application's own Not Found view (an SPA answers HTTP 200 for every path): no evidence either.
          try {
            const about = JSON.parse(await page.evaluate(ABOUT));
            summary.title = about.title || null;
            summary.heading = about.heading || null;
            summary.mainWords = Number.isFinite(about.mainWords) ? about.mainWords : null;
            if (summary.loaded && notFoundView(about)) {
              summary.notFound = true;
              summary.loaded = false;
              summary.error = 'the application shows its Not Found page';
            }
          } catch {}
          try {
            const shot = await session.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(dir, 'screenshot.png'), Buffer.from(shot.data, 'base64'));
            summary.files.push('screenshot.png');
          } catch {}
          try {
            const { nodes } = await session.send('Accessibility.getFullAXTree');
            const tree = (nodes || []).filter((n) => !n.ignored).slice(0, 800).map((n) => ({ role: n.role && n.role.value, name: n.name && n.name.value }));
            writeFileSync(join(dir, 'ax.json'), JSON.stringify(tree, null, 2));
            summary.files.push('ax.json');
          } catch {}
          let matches = [];
          try {
            matches = JSON.parse(await page.evaluate(MATCHES(selectors.slice(0, 5))));
          } catch {}
          summary.matched = matches.reduce((a, m) => a + (m.count || 0), 0);
          writeFileSync(join(dir, 'elements.json'), JSON.stringify(matches, null, 2));
          writeFileSync(join(dir, 'elements.html'), matches.map((m) => `<!-- ${m.selector}: ${m.error || `${m.count} match(es)`} -->\n${m.html.join('\n')}`).join('\n\n') + '\n');
          summary.files.push('elements.json', 'elements.html');
          const stops = [];
          try {
            await page.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur(), 0');
            let first = null;
            for (let i = 0; i < TAB_STOPS; i++) {
              await page.press('Tab');
              await sleep(30);
              const raw = await page.evaluate(FOCUSED);
              if (!raw) continue;
              const s = JSON.parse(raw);
              if (first && s.selector === first) break;
              if (!first) first = s.selector;
              stops.push(s);
            }
          } catch {}
          writeFileSync(join(dir, 'tab-order.json'), JSON.stringify(stops, null, 2));
          summary.files.push('tab-order.json');
        }
      } catch (e) {
        summary.error = `the browser could not capture it (${e && e.message ? e.message : e})`;
        summary.loaded = false;
      } finally {
        await browser.closePage(session).catch(() => {});
      }
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
      return summary;
    },
    close: () => browser.close({ fast: true }).catch(() => {}),
  };
}
