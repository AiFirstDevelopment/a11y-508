// Cross-page checks: 9.B consistent navigation, 9.C consistent identification,
// 12.B duplicate titles, 19.A multiple ways. Plus the manual checklist.

import { CATALOG, testInfo } from './checks/catalog.mjs';

const GENERIC = /^(click here|here|more|read more|learn more|link|details|view|see more|more info|info|download|open|next|previous|back|home)$/i;

export function siteChecks(pages) {
  const findings = [];
  const add = (f) => {
    const info = testInfo(f.test);
    findings.push({ ...f, name: info.name, wcag: info.wcag, level: f.level || 'violation', impact: f.impact || 'moderate' });
  };
  const audited = pages.filter((p) => p.info && !p.error && !p.skipped);
  if (audited.length < 2) return { findings, manual: manualChecklist() };

  // 9.B consistent navigation: relative order of shared nav items must match
  const ref = audited[0];
  let navIssues = 0;
  for (const p of audited.slice(1)) {
    if (navIssues >= 20) break;
    const a = ref.info.nav;
    const b = p.info.nav;
    const common = a.filter((x) => b.includes(x));
    if (common.length < 3) continue;
    const orderB = common.map((x) => b.indexOf(x));
    let broken = null;
    for (let i = 1; i < orderB.length; i++) {
      if (orderB[i] < orderB[i - 1]) {
        broken = { before: common[i - 1], after: common[i] };
        break;
      }
    }
    if (broken) {
      navIssues++;
      add({ test: '9.B', impact: 'moderate', selector: 'nav', message: `Navigation order differs between pages: "${broken.before}" precedes "${broken.after}" on ${ref.finalUrl} but follows it on ${p.finalUrl}. Repeated navigation must keep the same relative order.`, pages: [ref.finalUrl, p.finalUrl], details: { reference: a.slice(0, 20), page: b.slice(0, 20) } });
    }
  }

  // 9.C consistent identification: same destination, different names
  const byHref = new Map();
  for (const p of audited) {
    for (const [href, name] of p.info.linkNames || []) {
      const key = href;
      const n = name.replace(/\s+/g, ' ').trim();
      if (!n || GENERIC.test(n) || n.length > 80) continue;
      if (!byHref.has(key)) byHref.set(key, new Map());
      const m = byHref.get(key);
      const nk = n.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
      if (!nk) continue;
      if (!m.has(nk)) m.set(nk, { name: n, pages: new Set() });
      m.get(nk).pages.add(p.finalUrl);
    }
  }
  let idIssues = 0;
  for (const [href, names] of byHref) {
    if (names.size < 2 || idIssues >= 30) continue;
    const variants = Array.from(names.values());
    // ignore the case where one variant is a prefix/suffix of another (e.g. "Contact" vs "Contact us")
    const distinct = variants.filter((v, i) => !variants.some((w, j) => i !== j && (w.name.toLowerCase().includes(v.name.toLowerCase()))));
    if (distinct.length < 2) continue;
    idIssues++;
    add({ test: '9.C', level: 'review', impact: 'moderate', selector: `a[href="${href}"]`, message: `Links to ${href} are named differently across pages: ${distinct.map((v) => `"${v.name}"`).join(', ')}. Components with the same function should be identified consistently.`, pages: Array.from(new Set(distinct.flatMap((v) => Array.from(v.pages)))).slice(0, 6) });
  }

  // 12.B duplicate titles
  const byTitle = new Map();
  for (const p of audited) {
    const t = (p.title || '').trim();
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(p.finalUrl);
  }
  let dupTitles = 0;
  for (const [title, urls] of byTitle) {
    if (urls.length < 2 || dupTitles >= 20) continue;
    const distinctUrls = Array.from(new Set(urls.map((u) => u.replace(/\/$/, ''))));
    if (distinctUrls.length < 2) continue;
    dupTitles++;
    add({ test: '12.B', impact: 'serious', selector: 'head > title', message: `${distinctUrls.length} pages share the title "${title}", so the title does not identify the page.`, pages: distinctUrls.slice(0, 10) });
  }
  const titles = audited.map((p) => ({ url: p.finalUrl, title: p.title })).slice(0, 200);
  add({ test: '12.B', level: 'review', impact: 'minor', selector: 'head > title', message: `Page titles for ${titles.length} page(s). Confirm each identifies its page's content or purpose.`, details: { titles } });

  // 19.A multiple ways
  const ways = [];
  const withNav = audited.filter((p) => p.info.navCount >= 3).length;
  if (withNav >= audited.length / 2) ways.push('site navigation menu');
  if (audited.some((p) => p.info.search)) ways.push('site search');
  if (audited.some((p) => p.info.sitemap)) ways.push('site map link');
  if (audited.filter((p) => p.info.breadcrumb).length >= audited.length / 2) ways.push('breadcrumbs');
  if (ways.length < 2) {
    add({ test: '19.A', level: 'review', impact: 'moderate', selector: 'site', message: `Only ${ways.length} way(s) to locate pages detected (${ways.join(', ') || 'none'}). Two or more are required (e.g. navigation plus search, site map, or table of contents) unless pages are steps in a process.` });
  } else {
    add({ test: '19.A', level: 'review', impact: 'minor', selector: 'site', message: `Ways to locate pages detected: ${ways.join(', ')}. Confirm at least two work site-wide.` });
  }

  return { findings, manual: manualChecklist() };
}

export function manualChecklist() {
  return Object.entries(CATALOG)
    .filter(([, t]) => t.automation !== 'auto')
    .map(([id, t]) => ({ test: id, name: t.name, wcag: t.wcag, automation: t.automation, condition: t.condition, note: t.note || '' }));
}
