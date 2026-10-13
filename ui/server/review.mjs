// The Needs a person screen's server side: every finding whose ledger status is needs-human (and
// every one a person has decided), with where to look -- its pages, its element's screenshot from the
// latest report that has one (served from that report's folder, never copied), its rendered HTML
// and selector, and the places in the source that hold its markup -- and the person's decision,
// written back into the ledger in the work folder.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { testInfo } from '../../src/checks/catalog.mjs';
import { decide, fingerprint, loadLedger, saveLedger } from '../../src/ledger.mjs';
import { locate } from './loop-match.mjs';
import { confinedFile, listReports, readReport, sameStartUrl, WORK_DIR } from './reports.mjs';

// How many reports, newest first, are looked through for a finding's screenshot.
const REPORTS_LOOKED_AT = 10;

export const ledgerFile = (cwd) => join(cwd, WORK_DIR, 'ledger.json');

const reportFileUrl = (id, rel) => `/api/reports/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

// fingerprint -> [{ id, finding }] over the newest reports (for the loop's URL when it is known).
function findingsByFingerprint(cwd, url) {
  const out = new Map();
  const reports = listReports(cwd).filter((r) => !url || !r.baseUrl || sameStartUrl(r.baseUrl, url)).slice(0, REPORTS_LOOKED_AT);
  for (const entry of reports) {
    const r = readReport(cwd, entry.id);
    if (!r) continue;
    const all = [...(r.pages || []).flatMap((p) => p.findings || []), ...((r.site && r.site.findings) || [])];
    for (const f of all) {
      const fp = fingerprint(f);
      if (!out.has(fp)) out.set(fp, []);
      out.get(fp).push({ id: entry.id, finding: f });
    }
  }
  return out;
}

// The pages of a site-wide finding: the ones it names (pages, or the URLs in its details), else
// every page its report audited.
function sitePagesOf(cwd, { id, finding }) {
  if (Array.isArray(finding.pages) && finding.pages.length) return finding.pages;
  const named = Object.values(finding.details || {}).flatMap((v) => (Array.isArray(v) ? v.map((x) => x && x.url).filter((u) => typeof u === 'string') : []));
  if (named.length) return named;
  const r = readReport(cwd, id);
  return ((r && r.pages) || []).filter((p) => !p.error && !p.skipped).map((p) => p.finalUrl || p.url);
}

export function reviewList(cwd, { sourceDirs = [], url = null } = {}) {
  const file = ledgerFile(cwd);
  if (!existsSync(file)) return { exists: false, items: [], decided: [] };
  const ledger = loadLedger(file);
  const entries = Object.values(ledger.findings).filter((e) => e.status === 'needs-human' || (e.decision && e.decision.by === 'person'));
  const seen = entries.length ? findingsByFingerprint(cwd, url) : new Map();
  const files = new Map();
  const card = (e) => {
    const inReports = seen.get(e.fingerprint) || [];
    // The newest report whose copy of the finding has a screenshot file that is still there.
    let screenshot = null;
    let screenshotMissing = false;
    for (const { id, finding } of inReports) {
      if (!finding.screenshot) continue;
      if (confinedFile(cwd, id, finding.screenshot)) {
        screenshot = reportFileUrl(id, finding.screenshot);
        break;
      }
      screenshotMissing = true;
    }
    // A site-wide finding (pages: ['site']): the pages it names, else every page its report audited.
    const site = (e.pages || []).includes('site');
    const sitePages = site && inReports.length ? sitePagesOf(cwd, inReports[0]) : [];
    const pages = (e.pages || []).flatMap((p) => (p === 'site' ? sitePages : [p])).filter((p, i, all) => typeof p === 'string' && all.indexOf(p) === i);
    // About the page as a whole, not one element: site-wide, no selector, or no element behind it
    // (a heading outline, "body" for a missing skip link): no rectangle and no markup.
    const copy = inReports[0] && inReports[0].finding;
    const wholePage = site || !e.selector || (!!copy && !copy.rect && !e.html);
    const info = testInfo(e.test);
    return {
      fingerprint: e.fingerprint, test: e.test, name: e.name || info.name, wcag: e.wcag || info.wcag, impact: e.impact, level: e.level || null,
      condition: info.condition || '', message: e.message, reason: e.reason || (e.triage && e.triage.reason) || null,
      status: e.status, round: e.lastSeenRound || e.firstSeenRound || 0, attempts: (e.attempts || []).length,
      wholePage, selector: e.selector || '', frame: e.frame || null, html: e.html || '', pages,
      screenshot: wholePage ? null : screenshot, screenshotMissing: !wholePage && !screenshot && screenshotMissing,
      sources: e.html || (!wholePage && e.selector) ? locate(cwd, e, sourceDirs, { files }) : [],
      decision: e.decision || null,
    };
  };
  const newest = (a, b) => b.round - a.round || a.test.localeCompare(b.test, undefined, { numeric: true });
  const cards = entries.map(card);
  return { exists: true, items: cards.filter((c) => c.status === 'needs-human').sort(newest), decided: cards.filter((c) => c.status !== 'needs-human').sort(newest) };
}

// POST /api/ledger/decision: { fingerprint, status: adequate | wont-fix | open, note }.
export function recordDecision(cwd, body) {
  const keys = Object.keys(body || {});
  if (!body || typeof body !== 'object' || Array.isArray(body) || keys.some((k) => !['fingerprint', 'status', 'note'].includes(k)) || typeof body.fingerprint !== 'string' || typeof body.status !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) {
    throw Object.assign(new Error('body must be { "fingerprint": "...", "status": "adequate" | "wont-fix" | "open", "note"?: "..." }'), { status: 400 });
  }
  const file = ledgerFile(cwd);
  if (!existsSync(file)) throw Object.assign(new Error('there is no ledger in this folder yet'), { status: 404 });
  const ledger = loadLedger(file);
  const entry = decide(ledger, body.fingerprint, { status: body.status, note: body.note || '' });
  saveLedger(file, ledger);
  return { fingerprint: entry.fingerprint, status: entry.status, decision: entry.decision };
}
