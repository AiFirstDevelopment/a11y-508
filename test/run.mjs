// End-to-end test: serves the fixture site, requires a bearer token on every
// request, runs the CLI against it, and asserts on report.json.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { Page } from '../src/page.mjs';
import { shouldFail } from '../src/report.mjs';
import { normalizeUrl } from '../src/crawler.mjs';
import { CATALOG } from '../src/checks/catalog.mjs';
import { startFixtureSite, TOKEN, COOKIE } from './fixture-site.mjs';
import { parseEvents } from './event-schema.mjs';
import { humanRun, readGolden, HUMAN_ARGS } from './human-golden.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// --only /checks-focus.html crawls that one fixture page and runs only the
// assertions that look at it: a mutation check in seconds instead of a full
// crawl. The troubleshoot, --events and golden runs are skipped, and so is
// every assertion that never reads the chosen page.
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1] : null;
if (only && !/^\/[\w.-]+$/.test(only)) throw new Error('--only takes one fixture path, such as /checks-focus.html');
// The checks-beyond-* pages are asserted from a crawl with the WCAG 2.2 profile (--wcag 2.2). With
// --only, that flag is passed through for them, and the page is also crawled once without it, for
// the assertions about the default run.
const beyondOnly = !!only && /^\/checks-beyond-/.test(only);

const fixture = await startFixtureSite();
const { externalHits, unauthorized, cookieHeaders, dangerHits } = fixture;
const site = { close: () => fixture.close() };
const external = { close: () => {} };
const base = fixture.base;
const out = join(here, '.report');
rmSync(out, { recursive: true, force: true });
const origin = new URL(base).origin;
const stateFile = join(here, '.state.json');
writeFileSync(stateFile, JSON.stringify({
  version: 1,
  origins: [origin],
  cookies: [{ name: 'state_cookie', value: 'from-state', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, sameSite: 'Lax', expires: -1 }],
  storage: { [origin]: { local: { state_key: 'from-state' }, session: { state_session_key: 'from-state' } } },
}));

console.log(`fixture site at ${base}`);
const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'bin/a11y-508.mjs'), only ? base + only.slice(1) : base, ...(only ? ['--max-pages', '1'] : []), ...(beyondOnly ? ['--wcag', '2.2'] : []), '--out', out, '--concurrency', '2', '--max-screenshots', '5', '--json', '--token-storage', 'fixture_custom_key', '--cookie', `session=${COOKIE}`, '--state', stateFile], {
    env: { ...process.env, TOKEN, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ status: code, stdout });
  });
});
// --troubleshoot against the same fixture: one run that gets in, one that is bounced by the app's guard.
const runCliReal = (args, env, killAfter = 120000) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'bin/a11y-508.mjs'), ...args], { env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), killAfter);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ status: code, stdout, stderr });
  });
});
// In --only mode the extra runs do not happen; the assertions that read them never touch the chosen page, so they are skipped.
const runCli = only ? async () => ({ status: null, stdout: '', stderr: '' }) : runCliReal;
const tsOk = await runCli([base + 'app.html', '--troubleshoot', '--json', '--quiet', '--token-storage', 'fixture_custom_key', '--state', stateFile], { TOKEN });
const tsBounced = await runCli([base + 'app.html', '--troubleshoot', '--json', '--quiet', '--no-token-storage', '--state', stateFile], { TOKEN });
const thin = await runCli([base + 'submit', '--json', '--quiet', '--no-interact', '--no-zoom', '--no-screenshots', '--out', join(here, '.report-thin')], { TOKEN });
rmSync(join(here, '.report-thin'), { recursive: true, force: true });
// A crawl that starts on a page whose modal ignores Escape: two pages, nothing else incomplete.
const modalOut = join(here, '.report-modal');
const stuck = await runCli([base + 'checks-modal-stuck.html', '--out', modalOut, '--fail-on', 'none', '--no-follow-clicks', '--no-zoom', '--no-screenshots'], { TOKEN });
const stuckReport = existsSync(join(modalOut, 'report.json')) ? JSON.parse(readFileSync(join(modalOut, 'report.json'), 'utf8')) : null;
rmSync(modalOut, { recursive: true, force: true });
const tsText = await runCli([base + 'app.html', '--troubleshoot', '--quiet', '--no-token-storage'], { TOKEN });
// Round 4b: the checks-beyond-* pages crawled again with the WCAG 2.2 profile. With --only on one of
// them, the main crawl above had the flag, and this is the same page without it.
const beyondOut = join(here, '.report-beyond');
rmSync(beyondOut, { recursive: true, force: true });
const beyondArgs = beyondOnly
  ? [base + only.slice(1), '--max-pages', '1', '--out', beyondOut, '--json', '--fail-on', 'none']
  : [base + 'checks-beyond-index.html', '--wcag', '2.2', '--include', 'checks-beyond-', '--out', beyondOut, '--concurrency', '2', '--max-screenshots', '2', '--json', '--fail-on', 'none'];
const beyondRun = only && !beyondOnly ? { status: null, stdout: '', stderr: '' } : await runCliReal(beyondArgs, { TOKEN }, 300000);
const beyondFile = (f) => (existsSync(join(beyondOut, f)) ? readFileSync(join(beyondOut, f), 'utf8') : '');
const beyondReport = beyondFile('report.json') ? JSON.parse(beyondFile('report.json')) : null;
const beyondMd = beyondFile('summary.md');
const beyondHtml = beyondFile('report.html');
rmSync(beyondOut, { recursive: true, force: true });
// --list-tests needs no browser.
const listDefault = await runCli(['--list-tests']);
const list22 = await runCli(['--list-tests', '--wcag', '2.2']);
const list21 = await runCli(['--list-tests', '--wcag', '2.1']);
const listBad = await runCli(['--list-tests', '--wcag', '3']);
site.close();
external.close();
rmSync(stateFile, { force: true });

// --events: the same crawl as the golden human run, as a JSON event stream, and
// the human run itself, which must match origin/main's output line for line.
const evSite = only ? { base: '', close() {} } : await startFixtureSite();
const evOut = join(here, '.report-events');
rmSync(evOut, { recursive: true, force: true });
// One after the other: two Chrome crawls at once can time out.
const evRun = await runCli([evSite.base, '--out', evOut, ...HUMAN_ARGS, '--events', '--json', '--quiet'], { TOKEN }, 400000);
const human = only ? '' : await humanRun(root);
evSite.close();
const evReport = existsSync(join(evOut, 'report.json')) ? JSON.parse(readFileSync(join(evOut, 'report.json'), 'utf8')) : null;
rmSync(evOut, { recursive: true, force: true });
console.log(`cli finished in ${((Date.now() - t0) / 1000).toFixed(1)}s with exit code ${run.status}`);
if (run.status === null) throw new Error('CLI was killed after 300s');

const mainReport = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
// report: the default crawl. flagged: the crawl with --wcag 2.2 (null with --only on another page).
const report = beyondOnly ? beyondReport : mainReport;
const flagged = beyondOnly ? mainReport : beyondReport;
if (!report) throw new Error(`the default crawl of ${only} wrote no report:\n${beyondRun.stderr}`);
const pagesRaw = Object.fromEntries(report.pages.map((p) => [new URL(p.url).pathname, p]));
const flaggedRaw = flagged ? Object.fromEntries(flagged.pages.map((p) => [new URL(p.url).pathname, p])) : {};
// In --only mode, an assertion counts only if it read the chosen page and no other; the rest are skipped, pass or fail.
let touchedOnly = false;
class NeedsOtherPage extends Error {}
const scoped = (raw) => only
  ? new Proxy(raw, {
      get(t, k) {
        if (k === only) touchedOnly = true;
        else if (typeof k === 'string' && k.startsWith('/')) throw new NeedsOtherPage(k);
        return t[k];
      },
    })
  : raw;
const pages = scoped(pagesRaw);
// The pages of the --wcag 2.2 crawl.
const bpages = scoped(flaggedRaw);
const has = (path, test, level, re) => {
  const p = pages[path];
  assert.ok(p, `page ${path} was crawled`);
  const hit = (p.findings || []).find((f) => f.test === test && (!level || f.level === level) && (!re || re.test(f.message)));
  assert.ok(hit, `${path}: expected ${test} ${level || ''} ${re || ''}\n  got: ${(p.findings || []).filter((f) => f.test === test).map((f) => `[${f.level}] ${f.message}`).join('\n       ') || '(none)'}`);
  return hit;
};
const siteHas = (test, level, re) => {
  const hit = report.site.findings.find((f) => f.test === test && (!level || f.level === level) && (!re || re.test(f.message)));
  assert.ok(hit, `site: expected ${test} ${level || ''} ${re || ''}`);
  return hit;
};

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  touchedOnly = false;
  try {
    fn();
    if (only && !touchedOnly) return;
    ran++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    if (only && (!touchedOnly || e instanceof NeedsOtherPage)) return;
    ran++;
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};

console.log('assertions:');
check('exit code 1 because violations exist', () => assert.equal(run.status, 1));
check('crawled all five html pages and the 404', () => {
  for (const p of ['/', '/forms.html', '/tables.html', '/media.html', '/about.html']) assert.ok(pages[p], p);
  for (const p of ['focus', 'opacity', 'contrast-exempt', 'hidden', 'roles', 'lists-audio', 'icons', 'names']) assert.equal(pages[`/checks-${p}.html`]?.error, null, `/checks-${p}.html crawled without error`);
  assert.ok(pages['/missing.html'] && /404/.test(pages['/missing.html'].error), 'broken link recorded as HTTP 404');
});
check('token sent to the site, never to the other origin', () => {
  assert.equal(unauthorized.length, 0, `unauthorized requests: ${unauthorized.join(', ')}`);
  assert.ok(externalHits.length > 0, 'external image was requested');
  assert.ok(externalHits.every((h) => h.auth === null), 'external origin must not receive the token');
});
check('token seeded into web storage gets past a client-side auth guard', () => {
  const p = pages['/app.html'];
  assert.ok(p, '/app.html was crawled');
  assert.equal(p.error, null, `app page error: ${p.error}`);
  assert.ok(/\/app\.html$/.test(p.finalUrl), `stayed on /app.html, got ${p.finalUrl}`);
  assert.equal(p.title, 'Application - a11y-508 test site');
  assert.ok(!pages['/login.html'], 'login page was never visited');
});
check('--cookie is sent to the site', () => {
  assert.ok(cookieHeaders.some((c) => new RegExp(`(^|;\\s*)session=${COOKIE}(;|$)`).test(c)), `cookies seen: ${[...new Set(cookieHeaders)].join(' | ') || '(none)'}`);
});
check('--state cookie and web storage are applied', () => {
  assert.ok(cookieHeaders.some((c) => /(^|;\s*)state_cookie=from-state(;|$)/.test(c)), `cookies seen: ${[...new Set(cookieHeaders)].join(' | ') || '(none)'}`);
  assert.ok(!/reason=state/.test(pages['/app.html'].finalUrl), `app page bounced for missing session storage: ${pages['/app.html'].finalUrl}`);
  assert.deepEqual(report.options.session, { cookies: 1, origins: [origin] });
});
check('script redirect to a slow page is followed; the landing page is audited', () => {
  const p = pages['/bounce.html'];
  assert.ok(p, '/bounce.html was crawled');
  assert.equal(p.error, null, `bounce page error: ${p.error}`);
  assert.equal(p.skipped, null, `bounce page skipped: ${p.skipped}`);
  assert.ok(/\/landed\.html$/.test(p.finalUrl), `expected to land on /landed.html, got ${p.finalUrl}`);
  assert.equal(p.title, 'Landed - a11y-508 test site');
});
check('--troubleshoot reports success when the page is reached', () => {
  assert.equal(tsOk.status, 0, tsOk.stdout + tsOk.stderr);
  const r = JSON.parse(tsOk.stdout);
  assert.equal(r.ok, true);
  assert.ok(/Authentication is working/.test(r.verdict), r.verdict);
  assert.ok(r.auth.sentOn > 0, 'header seen on the wire');
  assert.ok(r.auth.seededKeys.includes('fixture_custom_key'));
  assert.ok(r.storage.read.localStorage.some((k) => k.key === 'access_token' && k.seeded && k.present), JSON.stringify(r.storage.read));
  assert.ok(r.cookies.some((c) => c.name === 'state_cookie'));
  assert.ok(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes('from-state'), 'no secret values in the output');
});
check('--troubleshoot explains a client-side bounce and names the key the app read', () => {
  assert.equal(tsBounced.status, 2, tsBounced.stdout + tsBounced.stderr);
  const r = JSON.parse(tsBounced.stdout);
  assert.equal(r.ok, false);
  assert.ok(/its own script navigated to .*\/login\.html/.test(r.verdict), r.verdict);
  assert.ok(/--token-storage access_token/.test(r.next), r.next);
  assert.ok(r.navigation.hops.some((h) => h.kind === 'navigation' && h.initiator === 'script'), JSON.stringify(r.navigation.hops));
  assert.ok(r.storage.read.localStorage.some((k) => k.key === 'access_token' && !k.seeded && !k.present), JSON.stringify(r.storage.read));
});
check('--troubleshoot plain text output has the sections', () => {
  for (const re of [/^auth /m, /^navigation$/m, /page script navigated to/, /^verdict /m, /^next /m]) assert.ok(re.test(tsText.stdout), `missing ${re} in:\n${tsText.stdout}`);
});
check('pages behind link-less controls are found by clicking and audited', () => {
  for (const p of ['/reports.html', '/dashboard.html']) {
    assert.ok(pages[p], `${p} was crawled`);
    assert.equal(pages[p].error, null, `${p}: ${pages[p].error}`);
    assert.equal(pages[p].foundBy, 'click', `${p} foundBy`);
  }
  const d = pages['/'].discovery;
  assert.ok(d && d.routes.some((r) => r.name === 'Reports') && d.routes.some((r) => r.name === 'Dashboard'), JSON.stringify(d));
  assert.ok(report.summary.coverage.notes.some((n) => /reachable only by clicking/.test(n)), JSON.stringify(report.summary.coverage));
});
check('controls named like actions are never clicked, and that is reported', () => {
  assert.equal(dangerHits.length, 0, `Delete was clicked ${dangerHits.length} time(s)`);
  assert.ok(pages['/'].discovery.skipped.some((s) => s.name === 'Delete account'));
  assert.ok(report.summary.coverage.warnings.some((w) => /look like actions \("Delete account"/.test(w)), JSON.stringify(report.summary.coverage.warnings));
});
check('hash routes are kept as distinct URLs, in-page anchors are not', () => {
  const o = 'http://h.test';
  assert.equal(normalizeUrl('http://h.test/app#/reports', o), 'http://h.test/app#/reports');
  assert.equal(normalizeUrl('http://h.test/app#!/reports', o), 'http://h.test/app#!/reports');
  assert.equal(normalizeUrl('http://h.test/app#section-2', o), 'http://h.test/app');
});
check('a one-page crawl with nothing to follow is flagged as incomplete', () => {
  const r = JSON.parse(thin.stdout);
  assert.equal(r.summary.audited, 1, thin.stderr);
  assert.equal(r.summary.coverage.complete, false);
  assert.ok(r.summary.coverage.warnings.some((w) => /Only the start page was audited/.test(w)), JSON.stringify(r.summary.coverage));
  assert.ok(/COVERAGE IS INCOMPLETE/.test(thin.stderr), thin.stderr);
});
check('a run that audited nothing never passes', () => {
  assert.equal(shouldFail({ audited: 0, byImpact: {} }, ['critical', 'serious']), true);
  assert.equal(shouldFail({ audited: 0, byImpact: {} }, []), true);
  assert.equal(shouldFail({ audited: 1, byImpact: {} }, ['critical', 'serious']), false);
});
check('dropped sockets on navigation do not fail the page', () => {
  assert.equal(fixture.dropsLeft, 0, 'the server dropped both requests');
  assert.equal(pages['/forms.html'].error, null, `forms page error: ${pages['/forms.html'].error}`);
});
check('report records storage keys and cookie names, not values', () => {
  assert.ok(report.options.tokenStorage.includes('access_token') && report.options.tokenStorage.includes('fixture_custom_key'));
  assert.deepEqual(report.options.cookies, ['session']);
  assert.ok(!JSON.stringify(report.options).includes(COOKIE) && !JSON.stringify(report.options).includes(TOKEN));
});
check('pdf and off-site links not crawled', () => {
  assert.ok(!pages['/report.pdf']);
  assert.ok(report.pages.every((p) => p.url.startsWith(base)));
});
check('about page has no violations', () => assert.equal(pages['/about.html'].findings.filter((f) => f.level === 'violation').length, 0, JSON.stringify(pages['/about.html'].findings.filter((f) => f.level === 'violation').map((f) => f.test + ' ' + f.message))));

check('7.A image without alt', () => has('/', '7.A', 'violation', /no alt attribute/));
check('7.A filename alt', () => has('/', '7.A', 'violation', /filename or generic/));
check('7.B decorative with title', () => has('/', '7.B', 'violation', /title\/aria-label/));
check('6.A decorative image is only link content', () => has('/', '6.A', 'violation', /decorative image \(alt=""\) is its only content/));
check('7.A inventory review', () => has('/', '7.A', 'review', /meaningful image/));
check('6.A generic link with context -> review', () => has('/', '6.A', 'review', /Generic link text "click here"/));
check('6.A generic link without context -> violation', () => has('/', '6.A', 'violation', /Generic link text "click here" with no programmatic context/));
check('6.A empty link', () => has('/', '6.A', 'violation', /Link has no accessible name/));
check('10.C skipped heading level', () => has('/', '10.C', 'review', /jumps from h2 to h4/));
check('10.B fake heading', () => has('/', '10.B', 'review', /styled like a heading/));
check('10.D fake list', () => has('/', '10.D', 'violation', /not marked up as a list/));
check('10.D ul with non-li child', () => has('/', '10.D', 'violation', /direct child/));
check('13.C low contrast', () => has('/', '13.C', 'violation', /below 4.5:1/));
check('13.A link by color alone', () => has('/', '13.A', null, /only by color/));
check('13.B sensory instruction', () => has('/', '13.B', 'review', /green button on the right/));
check('4.A role=button not focusable', () => has('/', '4.A', 'violation', /role="button" but is not keyboard focusable/));
check('4.A click listener on span (CDP probe)', () => has('/', '4.A', 'violation', /click listener but is not keyboard focusable/));
check('4.D no focus indicator', () => has('/', '4.D', 'violation', /No visible change/));
check('18.A clipped text at 200%', () => has('/', '18.A', 'violation', /clipped at 200% zoom/));
check('12.D iframe without title', () => has('/', '12.D', 'violation', /no title/));
check('disclosure pass reveals hidden image violation', () => {
  const f = has('/', '7.A', 'violation', /no alt attribute/);
  const revealed = pages['/'].findings.find((x) => x.test === '7.A' && x.state && /Show details/.test(x.state));
  assert.ok(revealed, 'finding tagged with disclosure state');
  assert.ok(f);
});
check('screenshots captured', () => assert.ok(pages['/'].findings.some((f) => f.screenshot && existsSync(join(out, f.screenshot)))));

check('11.A missing lang', () => has('/forms.html', '11.A', 'violation', /no lang attribute/));
check('5.A unlabelled input', () => has('/forms.html', '5.A', 'violation', /no label or accessible name/));
check('5.A placeholder only', () => has('/forms.html', '5.A', 'violation', /placeholder/));
check('5.C label for missing id', () => has('/forms.html', '5.C', 'violation', /does not match any element id/));
check('5.C duplicate id', () => has('/forms.html', '5.C', 'violation', /duplicated id/));
check('5.C describedby missing', () => has('/forms.html', '5.C', 'violation', /aria-describedby references/));
check('5.C required visual but not programmatic', () => has('/forms.html', '5.C', 'violation', /visually marks the field as required/));
check('5.F invalid without message', () => has('/forms.html', '5.F', 'violation', /aria-invalid/));
check('5.C custom checkbox state', () => has('/forms.html', '5.C', 'violation', /aria-checked/));
check('5.C radio group label', () => has('/forms.html', '5.C', 'review', /Radio group/));
check('5.D select auto-submit', () => has('/forms.html', '5.D', 'violation', /immediately submits/));
check('5.H financial form', () => has('/forms.html', '5.H', 'review', /legal, financial/));
check('5.F/5.G form review', () => has('/forms.html', '5.F', 'review', /Submit it with invalid/));

check('14.B table without th', () => has('/tables.html', '14.B', 'violation', /no <th> cells/));
check('14.B th without scope', () => has('/tables.html', '14.B', 'violation', /no scope attribute/));
check('14.C layout table with th', () => has('/tables.html', '14.C', 'violation', /role="presentation"/));
check('14.B headers attr missing id', () => has('/tables.html', '14.B', 'violation', /headers attribute references/));
check('4.C keyboard trap', () => has('/tables.html', '4.C', 'violation', /Keyboard trap/));
check('no false keyboard trap on pages with iframes', () => {
  for (const p of ['/', '/media.html']) assert.ok(!pages[p].findings.some((f) => f.test === '4.C'), `${p} reported a trap`);
});

check('2.A autoplay without controls', () => has('/media.html', '2.A', 'violation', /plays automatically with sound/));
check('17.A no captions review', () => has('/media.html', '17.A', 'review', /no captions track/));
check('16.A audio transcript review', () => has('/media.html', '16.A', 'review', /transcript/));
check('2.B marquee', () => has('/media.html', '2.B', 'violation', /marquee/));
check('2.B infinite animation review', () => has('/media.html', '2.B', 'review', /animates indefinitely/));
check('15.A generated text', () => has('/media.html', '15.A', 'review', /inserted with CSS/));
check('12.D generic iframe title', () => has('/media.html', '12.D', 'violation', /does not describe/));
check('11.B invalid part lang', () => has('/media.html', '11.B', 'violation', /not a valid language tag/));
check('15.B row-reverse', () => has('/media.html', '15.B', 'review', /row-reverse/));
check('18.A viewport blocks zoom', () => has('/media.html', '18.A', 'violation', /user-scalable/));
check('2.C meta refresh', () => has('/media.html', '2.C', 'violation', /reloads automatically/));

check('12.B duplicate titles across pages', () => siteHas('12.B', 'violation', /share the title/));
check('9.B inconsistent navigation order', () => siteHas('9.B', 'violation', /Navigation order differs/));
check('9.C inconsistent identification', () => siteHas('9.C', 'review', /About/));
check('19.A multiple ways', () => siteHas('19.A', 'review'));
check('manual checklist present', () => assert.ok(report.manual.some((m) => m.test === '4.B')));
check('html report written', () => assert.ok(existsSync(join(out, 'report.html')) && existsSync(join(out, 'summary.md'))));

// Checks round 1 (docs/plans/checks-false-positives.md): each fixture page holds the false
// positive that must be gone and, beside it, the true positive that must still be reported.
const findingsOn = (path) => {
  assert.ok(pages[path], `page ${path} was crawled`);
  return pages[path].findings || [];
};
const listed = (fs) => fs.map((f) => `${f.selector} [${f.level}] ${f.message}${f.state ? ` (${f.state})` : ''}`).join('\n       ') || '(none)';
const on = (path, test, selector, level, re) => {
  const hit = findingsOn(path).find((f) => f.test === test && f.selector === selector && (!level || f.level === level) && (!re || re.test(f.message)));
  assert.ok(hit, `${path}: expected ${test} ${level || ''} on ${selector} ${re || ''}\n  got: ${listed(findingsOn(path).filter((f) => f.test === test))}`);
  return hit;
};
const noneOn = (path, test, selectors, level) => {
  const hits = findingsOn(path).filter((f) => (!test || f.test === test) && selectors.some((s) => f.selector === s || f.selector.startsWith(s + ' ')) && (!level || f.level === level));
  assert.equal(hits.length, 0, `${path}: unexpected ${test || 'findings'} on ${selectors.join(', ')}\n  got: ${listed(hits)}`);
};

const FOCUS = '/checks-focus.html';
check('AC1 4.D: hidden checkbox, radio and switch that show focus on the label or box are not reported', () => {
  noneOn(FOCUS, '4.D', ['#cb-styled-label', '#cb-uswds-label', '#rd-styled-label', '#sw-styled-label', '#cb-styled', '#cb-uswds', '#rd-styled', '#sw-styled']);
});
check('AC1 4.D: hidden checkbox, radio and switch with no focus style anywhere are reported on the label', () => {
  on(FOCUS, '4.D', '#cb-bare-label', 'violation', /visually hidden checkbox input/);
  on(FOCUS, '4.D', '#rd-bare-label', 'violation', /visually hidden radio input/);
  on(FOCUS, '4.D', '#sw-bare-label', 'violation', /visually hidden switch input/);
});

const OPACITY = '/checks-opacity.html';
check('AC2 13.C: #aaa on a .9-opacity #222 card is not a violation (5.55:1)', () => {
  noneOn(OPACITY, '13.C', ['#op-light'], 'violation');
  for (const f of findingsOn(OPACITY).filter((x) => x.test === '13.C' && x.selector === '#op-light')) assert.ok(Math.abs(f.details.ratio - 5.55) <= 0.05, `ratio ${f.details.ratio}`);
});
check('AC2 13.C: #777 on the same card is reported at the hand-computed 3.16:1', () => {
  const f = on(OPACITY, '13.C', '#op-mid', 'violation');
  assert.ok(Math.abs(f.details.ratio - 3.16) <= 0.05, `ratio ${f.details.ratio}, expected 3.16 ± 0.05`);
});

const EXEMPT = '/checks-contrast-exempt.html';
check('AC3 13.C: grey labels of disabled controls are exempt', () => noneOn(EXEMPT, '13.C', ['#ex-dis-label', '#ex-wrap-label', '#ex-lb']));
check('AC3 13.C: the same grey label of an enabled control is reported', () => on(EXEMPT, '13.C', '#ex-en-label', 'violation', /below 4.5:1/));
check('AC3 13.C: 1:1, single-character and pseudo-element-background text are review items', () => {
  on(EXEMPT, '13.C', '#ex-same', 'review', /same color \(1:1/);
  on(EXEMPT, '13.C', '#ex-char', 'review', /Single-character text "x"/);
  on(EXEMPT, '13.C', '#ex-pill', 'review', /positioned ::before background covering/);
  noneOn(EXEMPT, '13.C', ['#ex-same', '#ex-char', '#ex-pill'], 'violation');
});

const HIDDEN = '/checks-hidden.html';
check('AC4 4.A: links in an inert, aria-hidden off-canvas nav are not reported', () => noneOn(HIDDEN, null, ['#oc-inert-1', '#oc-inert-2', '#oc-inert']));
check('AC4: nothing in an inert off-canvas nav is reported, even unnamed controls', () => noneOn(HIDDEN, null, ['#oc-inert-only-1', '#oc-inert-only-2', '#oc-inert-only']));
check('AC4 4.A: the same nav with aria-hidden and no inert is still reported', () => on(HIDDEN, '4.A', '#oc-hidden-1', 'violation', /inside aria-hidden/));
check('AC4 4.A: controls in a disabled, aria-hidden fieldset are not reported', () => noneOn(HIDDEN, '4.A', ['#fs-input', '#fs-button']));
check('AC4 4.A: aria-hidden="TRUE" hides like "true"', () => on(HIDDEN, '4.A', '#upper-link', 'violation', /inside aria-hidden/));
check('AC4 4.A: a non-focusable role="scrollbar" is not reported', () => noneOn(HIDDEN, '4.A', ['#custom-scrollbar']));
check('AC4 13.C: text revealed above the fold after the page scrolled is checked', () => {
  const f = on(HIDDEN, '13.C', '#notice', 'violation');
  assert.ok(/Show notice/.test(f.state || ''), `state: ${f.state}`);
});

const ROLES = '/checks-roles.html';
check('AC5 5.C: role="toggle button" and role="image" are valid', () => noneOn(ROLES, '5.C', ['#role-toggle', '#role-image']));
check('AC5 5.C: role="foo bar" is invalid', () => on(ROLES, '5.C', '#role-foo', 'violation', /not a valid ARIA role/));
check('AC5 5.C: role="widget" gets the abstract-role message', () => on(ROLES, '5.C', '#role-widget', 'violation', /abstract ARIA role/));

const LISTS = '/checks-lists-audio.html';
check('AC6 10.D: a ul with another role, and a hidden child, are not reported', () => noneOn(LISTS, '10.D', ['#list-tablist', '#list-hidden-child']));
check('AC6 10.D: a plain ul with a div child is still reported', () => on(LISTS, '10.D', '#list-plain', 'violation', /not <li> \(div\)/));
check('AC6 2.A: 1-second autoplaying audio without controls is a review item', () => on(LISTS, '2.A', '#audio-short', 'review', /lasts 1\.0 s \(3 seconds or less\)/));
check('AC6 2.A: the same audio with loop, and a 10-second one, are violations', () => {
  on(LISTS, '2.A', '#audio-loop', 'violation', /no controls to pause it/);
  on(LISTS, '2.A', '#audio-long', 'violation', /no controls to pause it/);
});

const ICONS = '/checks-icons.html';
check('AC7 6.A: an icon-font glyph is not a name; the message shows the glyph', () => {
  on(ICONS, '6.A', '#icon-bare', 'violation', /^Link has no accessible name\. Its only content is an icon-font glyph \("", U\+E900\)/);
  on(ICONS, '6.A', '#icon-button', 'violation', /^Button has no accessible name\. Its only content is an icon-font glyph \("", U\+E901\)/);
});
check('AC7 6.A: the icon link with visible text, or with aria-label, is named', () => noneOn(ICONS, '6.A', ['#icon-text', '#icon-label']));
check('AC7 6.A: a button named by CSS-generated words is still named', () => noneOn(ICONS, '6.A', ['#css-words']));

const NAMES = '/checks-names.html';
check('AC8 5.C: a dialog is not named by its content', () => {
  on(NAMES, '5.C', '#name-dialog', 'violation', /Dialog has no accessible name/);
  noneOn(NAMES, '5.C', ['#name-dialog-ok']);
});
check('AC8 5.C: a fieldset of radios with no legend is an unlabelled radio group', () => {
  on(NAMES, '5.C', '#size-small', 'review', /Radio group of 2 has no group label/);
  noneOn(NAMES, '5.C', ['#delivery-mail']);
});
check('AC8 5.A: a listbox is not named by its options', () => on(NAMES, '5.A', '#name-listbox', 'violation', /^listbox has no label or accessible name/));
check('AC8 6.A: a button is still named by its text', () => noneOn(NAMES, '6.A', ['#name-save']));
check('AC8: a link-styled disclosure without href keeps its text for the disclosure pass', () => on(NAMES, '4.A', '#name-disclosure', 'review', /^"More filters" did not change aria-expanded/));
check('AC8 7.A: an <object> image with fallback text is named', () => noneOn(NAMES, '7.A', ['#name-object']));

// Checks round 2 (docs/plans/checks-foundations.md). Ratios are computed by hand in each fixture's comment.
const near = (v, want, what) => assert.ok(typeof v === 'number' && Math.abs(v - want) <= 0.05, `${what}: ${v}, expected ${want} ± 0.05`);
check('round 2 fixture pages were crawled without error', () => {
  for (const p of ['contrast-lines', 'contrast-scroll', 'contrast-images', 'contrast-shadow', 'contrast-forms', 'link-color', 'label-names', 'modal-escape', 'modal-stuck']) assert.equal(pages[`/checks-${p}.html`]?.error, null, `/checks-${p}.html crawled without error`);
});

const LINES = '/checks-contrast-lines.html';
check('AC1 13.C: text whose lines sit on different backgrounds is a review item naming the failing line', () => {
  const f = on(LINES, '13.C', '#ln-mixed', 'review', /^Text contrast differs between its lines: line \d+ of \d+ is [\d.]+:1, #595959 on #222222, below 4\.5:1/);
  near(f.details.ratio, 2.27, 'failing line');
  near(f.details.lines.passingRatio, 7.0, 'passing line');
});
check('AC1 13.C: text that fails on every line is a violation at the worst ratio', () => near(on(LINES, '13.C', '#ln-fail', 'violation', /below 4\.5:1/).details.ratio, 1.71, 'worst line'));
check('AC1 13.C: text that passes on every line has no finding', () => noneOn(LINES, '13.C', ['#ln-pass']));

const SCROLL = '/checks-contrast-scroll.html';
check('AC2 13.C: failing text 3000px down, over a positioned overlay that is not its ancestor, is reported', () => near(on(SCROLL, '13.C', '#scroll-low', 'violation').details.ratio, 2.27, 'ratio'));
check('AC2: the checks leave every page scrolled where it was', () => {
  for (const p of [pages[SCROLL], ...report.pages.filter((x) => !x.error && !x.skipped)]) assert.equal(p.passes.static.scrollRestored, true, `${p.url} scrollRestored`);
});

const IMAGES = '/checks-contrast-images.html';
check('AC3 13.C: #555 over a background image is a review item with both bound ratios', () => {
  const f = on(IMAGES, '13.C', '#img-mid', 'review', /^Text over a background image has contrast between/);
  near(f.details.bounds.white, 7.46, 'if white');
  near(f.details.bounds.black, 2.62, 'if black');
});
check('AC3 13.C: #ccc over a background image fails over any background', () => {
  const f = on(IMAGES, '13.C', '#img-light', 'violation', /fails 4\.5:1 over any background/);
  near(f.details.bounds.white, 1.61, 'if white');
  near(f.details.bounds.black, 1.77, 'if black');
});
check('AC3 13.C: #000 over the image has no finding', () => noneOn(IMAGES, '13.C', ['#img-dark']));
check('AC3 13.C: text passing both bounds but colored between them is a review item', () => {
  // Round 3 AC 13: listed in the page's one review item for this case (see below), with its bounds.
  const f = on(IMAGES, '13.C', 'text over images', 'review', /color lies between the two/);
  const item = f.details.elements.find((e) => e.selector === '#img-between');
  assert.ok(item, JSON.stringify(f.details));
  near(item.white, 4.54, 'if white');
  near(item.black, 4.62, 'if black');
});
check('AC3 13.C: #999 on a light gradient is a review item at the worst stop', () => near(on(IMAGES, '13.C', '#grad-grey', 'review', /gradient's worst point/).details.ratio, 2.61, 'worst stop'));
check('AC3 13.C: #333 on the gradient has no finding', () => noneOn(IMAGES, '13.C', ['#grad-dark']));

const SHADOW = '/checks-contrast-shadow.html';
check('AC4 13.C: white text with a halo on a light panel is a review item naming the shadow', () => on(SHADOW, '13.C', '#sh-halo', 'review', /text-shadow: rgb\(0, 0, 0\) 0px 0px 8px/));
check('AC4 13.C: a stroke-like shadow, or a halo on text that passes, makes no finding', () => noneOn(SHADOW, '13.C', ['#sh-stroke', '#sh-pass-halo']));
check('AC4 13.C: the same white text with no shadow is a violation', () => near(on(SHADOW, '13.C', '#sh-none', 'violation').details.ratio, 1.16, 'ratio'));

const FORMTEXT = '/checks-contrast-forms.html';
check('AC5 13.C: light typed text in a field is a violation', () => near(on(FORMTEXT, '13.C', '#f-value', 'violation', /^Text in this field has contrast/).details.ratio, 1.92, 'ratio'));
check('AC5 13.C: a light placeholder is a violation with the placeholder message', () => near(on(FORMTEXT, '13.C', '#f-ph', 'violation', /^Placeholder text "Type a keyword" has contrast/).details.ratio, 1.92, 'ratio'));
check('AC5 13.C: a select whose selected option is light is reported', () => near(on(FORMTEXT, '13.C', '#f-select', 'violation', /^Text in this field/).details.ratio, 1.92, 'ratio'));
check('AC5 13.C: the same controls disabled have no finding', () => noneOn(FORMTEXT, '13.C', ['#f-dis', '#f-ph-dis']));

const LINKCOLOR = '/checks-link-color.html';
check('AC6 13.A: a link told apart only by color from the text around it in its block is reported', () => on(LINKCOLOR, '13.A', '#lk-plain', 'violation', /link\/text contrast is 1\.5:1 \(below 3:1\)/));
check('AC6 13.A: an underline, a border-bottom, a background, or a color 3:1 from the text: no finding', () => noneOn(LINKCOLOR, '13.A', ['#lk-under', '#lk-border', '#lk-bg', '#lk-far']));
check('AC6 13.A: a link with less text around it than its own: no finding', () => noneOn(LINKCOLOR, '13.A', ['#lk-short']));

const LABELS = '/checks-label-names.html';
const inventory = (path) => (findingsOn(path).find((f) => f.test === '5.B' && f.selector === 'form fields')?.details?.fields || []);
const labelOf = (path, selector) => inventory(path).find((x) => x.selector === selector)?.label;
// Round 3 AC 12 corrects these two, as Chrome names them: a control named by the label that wraps
// it does not read its own value.
check('AC7 5.B: a label wrapping a select names it without its own selected option', () => assert.equal(labelOf(LABELS, '#show-rows'), 'Show rows', JSON.stringify(inventory(LABELS))));
check('AC7 5.B: a label wrapping a text field names it without its own typed value', () => assert.equal(labelOf(LABELS, '#typed'), 'Search for nearby', JSON.stringify(inventory(LABELS))));
check('AC8 5.A: a control whose only label is hidden for everyone is a review item', () => {
  on(LABELS, '5.A', '#hid-none', 'review', /only label \("Email address"\) is hidden/);
  on(LABELS, '5.A', '#hid-vis', 'review', /only label \("Postal code"\) is hidden/);
});
check('AC8 5.A: an sr-only label counts; a hidden label beside an aria-label makes no finding', () => noneOn(LABELS, '5.A', ['#sr-label', '#hid-aria']));

const MODAL_OK = '/checks-modal-escape.html';
const MODAL_STUCK = '/checks-modal-stuck.html';
const STUCK_WARNING = "A modal dialog (Consent required) was open when /checks-modal-stuck.html loaded and did not close with Escape; the page behind it was not audited. Dismiss it with --cookie or a saved session, or audit the dialog's close control.";
check('AC9: a modal on load that closes with Escape: dismissed, and the page behind it audited with the state label', () => {
  const { redismissed, ...modal } = pages[MODAL_OK].modalOnLoad; // redismissed: round 3 AC 14, below
  assert.deepEqual(modal, { selector: '#consent-ok', name: 'Cookie preferences', dismissed: true });
  assert.equal(on(MODAL_OK, '7.A', '#behind-ok', 'violation', /no alt attribute/).state, 'after closing the modal shown on load');
  assert.ok(!report.summary.coverage.warnings.some((w) => /Cookie preferences/.test(w)), JSON.stringify(report.summary.coverage.warnings));
});
check('AC9: a modal on load that ignores Escape: not dismissed, the page behind it unaudited, and a coverage warning', () => {
  assert.deepEqual(pages[MODAL_STUCK].modalOnLoad, { selector: '#consent-stuck', name: 'Consent required', dismissed: false });
  noneOn(MODAL_STUCK, '7.A', ['#behind-stuck']);
  assert.ok(report.summary.coverage.warnings.includes(STUCK_WARNING), JSON.stringify(report.summary.coverage.warnings));
  assert.equal(report.summary.modalsNotDismissed, 1);
  assert.ok(stuckReport, stuck.stdout + stuck.stderr);
  assert.deepEqual(stuckReport.summary.coverage.warnings, [STUCK_WARNING]);
  assert.ok(/^PASS on the 2 page\(s\) audited, but COVERAGE IS INCOMPLETE/m.test(stuck.stdout), stuck.stdout);
});

// Checks round 3 (docs/plans/checks-aria.md): the ARIA model and the rules derived from it. Each
// fixture page holds the failing cases and, beside them, the passing ones.
check('round 3 fixture pages were crawled without error', () => {
  for (const p of ['attrs', 'allowed', 'required', 'owned', 'presentation', 'nested', 'names', 'activedescendant', 'landmarks', 'landmarks-ok', 'deprecated']) assert.equal(pages[`/checks-aria-${p}.html`]?.error, null, `/checks-aria-${p}.html crawled without error`);
});

const ATTRS = '/checks-aria-attrs.html';
check('AC2 5.C: aria-labeledby is not an attribute, and the message suggests aria-labelledby', () => on(ATTRS, '5.C', '#at-misspelled', 'violation', /^aria-labeledby is not an ARIA attribute.*Did you mean aria-labelledby\?$/));
check('AC2 5.C: aria-expanded="yes" is an invalid value, and the message names the allowed values', () => on(ATTRS, '5.C', '#at-expanded-yes', 'violation', /^aria-expanded="yes" is not a valid value.*Use true, false or undefined\.$/));
check('AC2 5.C: aria-level="x" is not an integer', () => on(ATTRS, '5.C', '#at-level-x', 'violation', /^aria-level="x" is not an integer/));
check('AC2 5.C: aria-controls naming a missing id is reported', () => on(ATTRS, '5.C', '#at-controls-missing', 'violation', /^aria-controls references id\(s\) that do not exist: at-nowhere\.$/));
check('AC2 5.C: aria-expanded="true" and aria-level="2" are not reported', () => noneOn(ATTRS, '5.C', ['#at-expanded-ok', '#at-level-ok']));

const ALLOWED = '/checks-aria-allowed.html';
check('AC3 5.C: aria-checked on a link is not supported', () => on(ALLOWED, '5.C', '#al-checked', 'violation', /^aria-checked is not supported on <a> \(role link\)/));
check('AC3 5.C: aria-label on a span with no role gets the naming-prohibited message', () => on(ALLOWED, '5.C', '#al-span-label', 'violation', /^aria-label is not allowed on <span> \(role generic\), whose role prohibits naming/));
check('AC3 5.C: aria-label on a span with role="button" is not reported', () => noneOn(ALLOWED, '5.C', ['#al-button-label']));
check('AC3 5.C: global attributes (aria-hidden, aria-describedby) are allowed on any element', () => noneOn(ALLOWED, '5.C', ['#al-global']));

const REQUIRED = '/checks-aria-required.html';
check('AC4 5.C: role="checkbox" without aria-checked, and role="heading" without aria-level, are violations', () => {
  on(REQUIRED, '5.C', '#rq-checkbox', 'violation', /^role="checkbox" requires aria-checked/);
  on(REQUIRED, '5.C', '#rq-heading', 'violation', /^role="heading" requires aria-level/);
});
check('AC4 5.C: with the attributes present, and an option without aria-selected, no finding', () => noneOn(REQUIRED, '5.C', ['#rq-checkbox-ok', '#rq-heading-ok', '#rq-option']));

const OWNED = '/checks-aria-owned.html';
check('AC5 5.C: a tablist with no tab is a violation', () => on(OWNED, '5.C', '#ow-empty', 'violation', /^role="tablist" must contain an element with role "tab"/));
check('AC5 5.C: a tab outside a tablist is a violation', () => on(OWNED, '5.C', '#ow-orphan', 'violation', /^role="tab" must be inside an element with role "tablist"/));
check('AC5 5.C: tabs inside a div wrapper, or owned with aria-owns, are not reported', () => noneOn(OWNED, '5.C', ['#ow-wrapped', '#ow-owned', '#ow-t1', '#ow-t2']));
check('AC5 5.C: an empty listbox with aria-busy="true" is not reported', () => noneOn(OWNED, '5.C', ['#ow-busy']));

const PRESENTATION = '/checks-aria-presentation.html';
check('AC6 7.B: a focusable image with alt="" is a review item', () => on(PRESENTATION, '7.B', '#pr-img-focus', 'review', /^alt="" marks this image as decorative, but it is focusable/));
check('AC6 5.C: role="presentation" with aria-label is a review item', () => on(PRESENTATION, '5.C', '#pr-div-label', 'review', /^role="presentation" removes this element's semantics, but it has aria-label/));
check('AC6: an image with alt="" alone is not reported', () => noneOn(PRESENTATION, null, ['#pr-img-plain']));

const NESTED = '/checks-aria-nested.html';
check('AC7 6.A: a link inside a button is a violation', () => on(NESTED, '6.A', '#ns-button-link', 'violation', /^This button contains a focusable <a>/));
check('AC7 6.A: a tabindex="-1" span inside role="button" is a review item, not a violation', () => {
  on(NESTED, '6.A', '#ns-div-span', 'review', /^This button contains a <span> with tabindex="-1"/);
  noneOn(NESTED, '6.A', ['#ns-div-span'], 'violation');
});
check('AC7 6.A: a button with plain text is not reported', () => noneOn(NESTED, '6.A', ['#ns-plain']));

const WIDGETS = '/checks-aria-names.html';
check('AC8: unnamed textbox, combobox and switch are 5.A; progressbar and tooltip 5.C; role="img" and svg role="img" 7.A', () => {
  for (const id of ['#nm-textbox', '#nm-combobox', '#nm-switch']) on(WIDGETS, '5.A', id, 'violation', /has no label or accessible name/);
  for (const id of ['#nm-progress', '#nm-tooltip']) on(WIDGETS, '5.C', id, 'violation', /has no accessible name/);
  on(WIDGETS, '7.A', '#nm-img', 'violation', /^role="img" has no accessible name/);
  on(WIDGETS, '7.A', '#nm-svg', 'violation', /^<svg role="img"> has no accessible name/);
});
check('AC8: a textbox whose only text is its content is unnamed', () => on(WIDGETS, '5.A', '#nm-textbox-content', 'violation', /^textbox has no label or accessible name/));
check('AC8: the same widgets with aria-label, and the svg with a <title>, are not reported', () => {
  const ok = ['#nm-textbox-ok', '#nm-combobox-ok', '#nm-switch-ok', '#nm-progress-ok', '#nm-tooltip-ok', '#nm-img-ok', '#nm-svg-ok'];
  noneOn(WIDGETS, null, ok, 'violation');
  noneOn(WIDGETS, '7.A', ok);
});

const ACTIVE = '/checks-aria-activedescendant.html';
check('AC9 4.A: aria-activedescendant on a host that cannot take focus', () => on(ACTIVE, '4.A', '#ad-nofocus', 'violation', /^aria-activedescendant is on an element that cannot receive keyboard focus/));
check('AC9 4.A: aria-activedescendant to a missing id', () => on(ACTIVE, '4.A', '#ad-missing', 'violation', /^aria-activedescendant points at id "ad-nowhere", which does not exist/));
check('AC9 4.A: aria-activedescendant to an element outside the host', () => on(ACTIVE, '4.A', '#ad-elsewhere', 'violation', /^aria-activedescendant points at "#ad-outside", which is not inside this element/));
check('AC9 4.A: aria-activedescendant to a descendant with no widget role', () => on(ACTIVE, '4.A', '#ad-norole', 'violation', /^aria-activedescendant points at "#ad-plain", which has role generic/));
check('AC9 4.A: a focusable listbox pointing at its own option is not reported', () => noneOn(ACTIVE, '4.A', ['#ad-ok']));

const LANDMARKS = '/checks-aria-landmarks.html';
const LANDMARKS_OK = '/checks-aria-landmarks-ok.html';
check('AC10 9.A: more than one main is a review item', () => on(LANDMARKS, '9.A', '#lm-main-2', 'review', /^The page has 3 main landmarks/));
check('AC10 9.A: a banner inside an article is a review item; a plain header there is not a banner', () => {
  on(LANDMARKS, '9.A', '#lm-banner-nested', 'review', /^This banner landmark is inside <article>/);
  noneOn(LANDMARKS, '9.A', ['#lm-header-plain']);
});
check('AC10 9.A: a main inside a nav is a review item', () => on(LANDMARKS, '9.A', '#lm-main-3', 'review', /^This main landmark is inside a navigation landmark/));
check('AC10 9.A: two navs with no label are a review item', () => on(LANDMARKS, '9.A', '#lm-nav-b', 'review', /^2 navigation landmarks have no label/));
check('AC10 9.A: navs with different labels are not reported', () => noneOn(LANDMARKS, '9.A', ['#lm-nav-c', '#lm-nav-d', '#lm-nav-e']));
check('AC10 9.A: one main, a top-level header and footer, and two differently labelled navs: no landmark finding', () => {
  const hits = findingsOn(LANDMARKS_OK).filter((f) => f.test === '9.A' && /landmark/.test(f.message));
  assert.equal(hits.length, 0, listed(hits));
});

const DEPRECATED = '/checks-aria-deprecated.html';
check('AC11 5.C: role="directory" is a review item naming role="list"', () => on(DEPRECATED, '5.C', '#dp-directory', 'review', /^role="directory" is deprecated.*use role="list"/));
check('AC11 5.C: aria-grabbed is a review item saying what replaces it', () => on(DEPRECATED, '5.C', '#dp-grabbed', 'review', /^aria-grabbed is deprecated.*no replacement attribute; describe the drag state in text/));
check('AC11 5.C: role="list" is not reported', () => noneOn(DEPRECATED, '5.C', ['#dp-list']));

check('AC12: a button labelled by a label that wraps a select is named with the select\'s value', () => on(LABELS, '4.A', '#ref-button', 'review', /^"Show 10 rows" did not change aria-expanded/));
check('AC13 13.C: text colored between the image bounds is one review item for the page, listing each element', () => {
  const items = findingsOn(IMAGES).filter((f) => f.test === '13.C' && /color lies between the two/.test(f.message));
  assert.equal(items.length, 1, listed(items));
  assert.deepEqual(items[0].details.elements.map((e) => e.selector), ['#img-between', '#img-between-2', '#img-between-3']);
  assert.match(items[0].message, /^3 text element\(s\) over a background image .*: #img-between, #img-between-2, #img-between-3\.$/);
  assert.equal(items[0].details.elements[2].state, 'after activating "More photos" (#more-photos)');
  noneOn(IMAGES, '13.C', ['#img-between', '#img-between-2', '#img-between-3']);
});
check('AC13 13.C: text that fails over any background is still a violation on its own element', () => on(IMAGES, '13.C', '#img-light', 'violation', /fails 4\.5:1 over any background/));
check('AC14: after a reload the load-time modal is dismissed again, so the disclosure pass sees the page', () => {
  const p = pages[MODAL_OK];
  assert.ok(p.modalOnLoad.redismissed >= 1, JSON.stringify(p.modalOnLoad));
  assert.ok(p.discovery, 'route discovery ran after its reload');
  assert.equal(on(MODAL_OK, '7.A', '#me-hidden-img', 'violation', /no alt attribute/).state, 'after activating "Show the policy" (#me-reveal)');
  noneOn(MODAL_OK, '4.G', ['#consent-ok', '#me-reveal', '#me-nav']);
  noneOn(MODAL_OK, '4.H', ['#consent-ok', '#me-reveal', '#me-nav']);
});

// Checks round 4a (docs/plans/checks-rule-packs.md): the rule packs. Each fixture page holds the
// failing cases and, beside them, the passing ones.
check('round 4a fixture pages were crawled without error', () => {
  for (const p of ['a', 'a-body', 'a-wrapper', 'a-modal', 'b', 'c', 'd', 'e', 'f', 'g', 'followups']) assert.equal(pages[`/checks-pack-${p}.html`]?.error, null, `/checks-pack-${p}.html crawled without error`);
});

const PACK_BODY = '/checks-pack-a-body.html';
const PACK_WRAPPER = '/checks-pack-a-wrapper.html';
const PACK_MODAL = '/checks-pack-a-modal.html';
check('AC1 4.A: <body aria-hidden="true"> is critical, and the message says every other test is silenced', () => {
  assert.equal(on(PACK_BODY, '4.A', 'body', 'violation', /^<body aria-hidden="true"> hides the whole page from assistive technology.*every other test on this page is silenced/).impact, 'critical');
});
check('AC1 4.A: an aria-hidden wrapper holding most of the text, with no modal open, is critical and named', () => {
  assert.equal(on(PACK_WRAPPER, '4.A', '#pa-app', 'violation', /^#pa-app is aria-hidden="true" and holds 9\d% of the page's visible text, while no modal dialog is open.*A modal library probably left aria-hidden behind/).impact, 'critical');
});
check('AC1 4.A: the same wrapper while a modal dialog is open is not reported', () => {
  assert.equal(pages[PACK_MODAL].modalOnLoad?.dismissed, true, JSON.stringify(pages[PACK_MODAL].modalOnLoad));
  noneOn(PACK_MODAL, '4.A', ['#pm-app']);
});

const PACK_A = '/checks-pack-a.html';
check('AC2 4.A: an img with ismap inside a link is a violation', () => on(PACK_A, '4.A', '#pa-ismap', 'violation', /^Server-side image map \(ismap\)/));
check('AC2 7.A: <object> with no fallback text is a violation, an SVG and an HTML document alike; one with text is not', () => {
  on(PACK_A, '7.A', '#pa-object-svg', 'violation', /^<object data="\/img\/budget\.svg"> has no text alternative/);
  on(PACK_A, '7.A', '#pa-object-html', 'violation', /^<object data="\/frames\/text\.html"> has no text alternative/);
  noneOn(PACK_A, '7.A', ['#pa-object-ok']);
});
check('AC2 7.A: an alt that repeats its link\'s text (case and spacing aside) is a review item; alt="" there is not', () => {
  on(PACK_A, '7.A', '#pa-redundant', 'review', /^Alt text "Annual {2}Report" repeats the text of the link around it/);
  noneOn(PACK_A, '7.A', ['#pa-empty-alt']);
});
check('AC3 7.A: an unnamed svg role="img" inside a named link is a review item suggesting aria-hidden, not a violation', () => {
  on(PACK_A, '7.A', '#pa-svg-in-link', 'review', /inside a link already named "Start here"\. If the image adds nothing to that name, hide it with aria-hidden="true"/);
  noneOn(PACK_A, '7.A', ['#pa-svg-in-link'], 'violation');
});
check('AC3 7.A: the same svg standing alone is a violation', () => on(PACK_A, '7.A', '#pa-svg-alone', 'violation', /^<svg role="img"> has no accessible name/));

const PACK_B = '/checks-pack-b.html';
check('AC4 5.C: a field with two visible labels is a review item listing both', () => on(PACK_B, '5.C', '#pb-email', 'review', /^Field has 2 visible labels \("Email", "Work email"\)/));
check('AC4 5.C: with aria-labelledby choosing one label, it is not reported', () => noneOn(PACK_B, '5.C', ['#pb-phone']));
check('AC4 5.C: three same-name checkboxes with no group label are a review item', () => on(PACK_B, '5.C', '#pb-topic-1', 'review', /^Group of 3 checkboxes named "topics" has no group label/));
check('AC4 5.C: the same checkboxes inside a fieldset with a legend are not reported', () => noneOn(PACK_B, '5.C', ['#pb-alerts', '#pb-alert-1', '#pb-alert-2', '#pb-alert-3']));
check('AC4 5.C: a fieldset with no legend, with two, and with the legend not first are violations', () => {
  on(PACK_B, '5.C', '#pb-fs-none', 'violation', /^This fieldset has no <legend>/);
  on(PACK_B, '5.C', '#pb-fs-two', 'violation', /^This fieldset has 2 <legend> elements/);
  on(PACK_B, '5.C', '#pb-fs-late', 'violation', /^This fieldset has a <legend> that is not its first child/);
});

const PACK_C = '/checks-pack-c.html';
check('AC5 12.D: two iframes titled "Content" and " content " are a violation', () => on(PACK_C, '12.D', '#pc-dup-b', 'violation', /^2 iframes share the title "Content"/));
check('AC5 4.A: iframe tabindex="-1" whose same-origin document has a link is a violation', () => on(PACK_C, '4.A', '#pc-focusable', 'violation', /^This iframe has tabindex="-1", but its document has content keyboard users can tab to \(<a> "About the office"\)/));
check('AC5 4.A: the same frame at 20x10 px, and a cross-origin frame, are not reported', () => noneOn(PACK_C, '4.A', ['#pc-small', '#pc-cross']));

const PACK_D = '/checks-pack-d.html';
check('AC6 4.A: a scrolling region with nothing focusable is a review item', () => on(PACK_D, '4.A', '#pd-scroll', 'review', /^This region scrolls \(vertically\), but neither it nor anything in it can take keyboard focus/));
check('AC6 4.A: the region with tabindex="0", or holding a link, is not reported', () => noneOn(PACK_D, '4.A', ['#pd-scroll-focusable', '#pd-scroll-link']));

const PACK_E = '/checks-pack-e.html';
check('AC7 14.A: a header-less table nesting another, and one wider than the viewport with under ten cells, are layout and not escalated', () => noneOn(PACK_E, '14.A', ['#te-nested', '#te-inner', '#te-wide']));
check('AC7 14.A: a bordered header-less table with five columns is classified data and escalated', () => {
  const f = on(PACK_E, '14.A', '#te-bordered', 'review', /^Table \(3 rows x 5 cols\) has no header cells and is classified as a data table/);
  assert.equal(f.details.classification, 'data');
});
check('AC7 14.B: a data cell no header covers is a violation; cells under the colspan header are covered', () => {
  on(PACK_E, '14.B', '#te-orphan-cell', 'violation', /^Data cell "Extra" has no row or column header/);
  noneOn(PACK_E, '14.B', ['#te-notes-1', '#te-notes-2', '#te-notes-3']);
});
check('AC7 14.B: scope="column" is a violation', () => on(PACK_E, '14.B', '#te-scope-bad', 'violation', /^scope="column" is not a valid value/));
check('AC7 14.B: a first row that is one cell across the table is a review item suggesting a caption', () => on(PACK_E, '14.B', '#te-fakecap-cell', 'review', /acting as a caption.*make it a <caption>/));
check('plan item 13 14.B: a header that labels no data cell, and a caption equal to the summary, are review items', () => {
  on(PACK_E, '14.B', '#te-nodata-th', 'review', /^Header "Notes" labels no data cell/);
  on(PACK_E, '14.B', '#te-summary', 'review', /caption and summary are the same text/);
});

const PACK_F = '/checks-pack-f.html';
check('AC8 11.A: lang="jp" is a violation whose message names ja', () => on(PACK_F, '11.A', '', 'violation', /^lang="jp": "jp" is not an ISO 639-1 language code.*probably "ja"/));
check('AC8 11.B: en-US, zh-Hant and haw are not reported', () => noneOn(PACK_F, '11.B', ['#pf-en-us', '#pf-zh-hant', '#pf-haw']));
check('AC8 11.B: lang="fra" with text is a review item naming fr', () => on(PACK_F, '11.B', '#pf-fra', 'review', /^lang="fra": "fra" has the two-letter code "fr"/));
check('AC8 11.B: lang="xx" on an empty element is not reported; with text it is', () => {
  noneOn(PACK_F, '11.B', ['#pf-xx-empty']);
  on(PACK_F, '11.B', '#pf-xx', 'violation', /^lang="xx": "xx" is not an ISO 639-1 language code/);
});

const PACK_G = '/checks-pack-g.html';
check('AC9 9.A: a display:none skip link is reported with the reason', () => on(PACK_G, '9.A', '#pg-skip-none', 'violation', /^Skip link "Skip to main content" is hidden for everyone \(display:none/));
check('AC9 9.A: a visually hidden skip link that a :focus style reveals satisfies 9.A', () => noneOn(PACK_G, '9.A', ['#pg-skip-ok']));
check('AC9 9.A: a skip link whose target is inside a closed <details> is reported', () => on(PACK_G, '9.A', '#pg-skip-details', 'violation', /^Skip link target "#pg-answer" is hidden \(inside a closed <details>\)/));
check('fix round 9.A: a skip link hidden by a :not(:focus) rule is revealed on focus and not reported', () => noneOn(PACK_G, '9.A', ['#pg-skip-bs']));
check('fix round 9.A: a skip link outside a modal open on load is not reported as hidden from assistive technology', () => noneOn(PACK_MODAL, '9.A', ['#pm-skip']));
check('plan item 16 9.A: a visually hidden skip link that no :focus style reveals is a review item', () => on(PACK_G, '9.A', '#pg-skip-unrevealed', 'review', /is visually hidden and no :focus style reveals it/));

const FOLLOWUPS = '/checks-pack-followups.html';
check('AC10 6.A: a link inside <summary> is a review item, not a violation', () => {
  on(FOLLOWUPS, '6.A', '#pu-summary-link', 'review', /^This summary contains a focusable <a>/);
  noneOn(FOLLOWUPS, '6.A', ['#pu-summary-link'], 'violation');
});
check('AC10 6.A: a link inside a button stays a violation', () => on(FOLLOWUPS, '6.A', '#pu-button-link', 'violation', /^This button contains a focusable <a>/));

// Checks round 4b (docs/plans/checks-beyond-508.md): rules beyond Section 508, behind --wcag 2.2.
// Each checks-beyond-* page holds a rule's failing case and, beside it, its passing ones; they are
// asserted from the crawl with the profile (bpages) and, where the plan says so, from the default
// crawl (pages).
const BEYOND_PAGES = ['index', 'names', 'targets', 'spacing', 'orientation', 'focus', 'reflow', 'contrast', 'bp'].map((p) => `/checks-beyond-${p}.html`);
const bFindingsOn = (path) => {
  assert.ok(bpages[path], `page ${path} was crawled with --wcag 2.2`);
  return bpages[path].findings || [];
};
const onB = (path, test, selector, level, re) => {
  const hit = bFindingsOn(path).find((f) => f.test === test && f.selector === selector && (!level || f.level === level) && (!re || re.test(f.message)));
  assert.ok(hit, `${path} (--wcag 2.2): expected ${test} ${level || ''} on ${selector} ${re || ''}\n  got: ${listed(bFindingsOn(path).filter((f) => f.test === test))}`);
  return hit;
};
const noneB = (path, test, selectors, level) => {
  const hits = bFindingsOn(path).filter((f) => (!test || f.test === test) && selectors.some((x) => f.selector === x || f.selector.startsWith(x + ' ')) && (!level || f.level === level));
  assert.equal(hits.length, 0, `${path} (--wcag 2.2): unexpected ${test || 'findings'} on ${selectors.join(', ')}\n  got: ${listed(hits)}`);
};
const TT_IDS = new Set(Object.keys(CATALOG));
const BEYOND_IDS = ['1.3.4', '1.3.5', '1.4.10', '1.4.11', '1.4.12', '2.4.11', '2.5.3', '2.5.8', 'BP'];
const ttLines = (text) => text.split('\n').filter((l) => /^\d+\.[A-H] /.test(l));

check('AC1 --list-tests: no flag prints the Trusted Tester catalog only; --wcag 2.2 adds the Beyond Section 508 section', () => {
  assert.equal(listDefault.status, 0, listDefault.stderr);
  assert.ok(!/Beyond Section 508/.test(listDefault.stdout), listDefault.stdout);
  assert.equal(ttLines(listDefault.stdout).length, TT_IDS.size);
  assert.equal(list22.status, 0, list22.stderr);
  const [tt, beyond] = list22.stdout.split('\nBeyond Section 508 (WCAG 2.2)\n');
  assert.equal(tt, listDefault.stdout, 'the Trusted Tester part is unchanged');
  assert.deepEqual(beyond.trim().split('\n').map((l) => l.split(/\s+/)[0]), BEYOND_IDS);
  assert.match(beyond, /^2\.5\.8\s+partial\s+2\.5\.8-target-size-minimum\s+WCAG 2\.5\.8 \(2\.2\)$/m);
});
check('AC1 --list-tests --wcag 2.1 lists the 2.1 rules only (not 2.5.8, 2.4.11); --wcag 3 exits 2 with a message', () => {
  assert.equal(list21.status, 0, list21.stderr);
  const beyond = list21.stdout.split('\nBeyond Section 508 (WCAG 2.1)\n')[1];
  assert.ok(beyond, list21.stdout);
  assert.deepEqual(beyond.trim().split('\n').map((l) => l.split(/\s+/)[0]), ['1.3.4', '1.3.5', '1.4.10', '1.4.11', '1.4.12', '2.5.3', 'BP']);
  assert.equal(listBad.status, 2);
  assert.match(listBad.stderr, /^error: --wcag: unknown version "3" \(use 2\.0, 2\.1, 2\.2/);
});
check('AC2: the default crawl reports no beyond508 finding and keeps the report.json shape', () => {
  for (const k of Object.keys(pagesRaw)) {
    const hits = (pages[k].findings || []).filter((f) => f.beyond508 || !TT_IDS.has(f.test));
    assert.equal(hits.length, 0, `${k}: ${listed(hits)}`);
    for (const pass of ['spacing', 'reflow']) assert.equal(pages[k].passes?.[pass], undefined, `${k}: the ${pass} pass ran without the profile`);
  }
  assert.ok((report.site.findings || []).every((f) => TT_IDS.has(f.test) && !f.beyond508));
  assert.deepEqual(Object.keys(report.summary.byTest).filter((t) => !TT_IDS.has(t)), []);
  assert.equal(report.options.wcag, undefined);
  assert.ok(!report.summary.coverage.notes.some((n) => /profile/.test(n)), JSON.stringify(report.summary.coverage.notes));
});
check('AC2: the --wcag 2.2 crawl audits every beyond page, records the profile and tags each beyond finding', () => {
  for (const p of BEYOND_PAGES) assert.equal(bpages[p]?.error, null, `${p} crawled without error`);
  assert.equal(flagged.options.wcag, '2.2');
  for (const id of BEYOND_IDS) assert.equal(flagged.catalog[id]?.beyond508, true, id);
  const all = Object.keys(flaggedRaw).flatMap((k) => bpages[k].findings);
  for (const f of all) if (BEYOND_IDS.includes(f.test)) assert.equal(f.beyond508, true, `${f.test} ${f.selector}`);
  for (const id of BEYOND_IDS) assert.ok(all.some((f) => f.test === id), `some ${id} finding`);
});
check('AC2/plan item 3: with the profile, summary.md, report.html, the summary table and the coverage note name the Beyond Section 508 heading', () => {
  assert.ok(flagged.summary.coverage.notes.some((n) => /^The WCAG 2\.2 profile was on \(--wcag 2\.2\)/.test(n)), JSON.stringify(flagged.summary.coverage.notes));
  assert.match(beyondMd, /\n## Beyond Section 508 \(WCAG 2\.2\)\n\n\| Rule \| Name \| WCAG \| Violations \| Review \|\n/);
  assert.match(beyondMd, /\n\| 2\.5\.8 \| 2\.5\.8-target-size-minimum \| 2\.5\.8 \| [1-9]\d* \| 0 \|\n/);
  assert.match(beyondHtml, /<h2 id="beyond">Beyond Section 508 \(WCAG 2\.2\)<\/h2>\n<section class="test" id="test-1-3\.4" data-test="1\.3\.4">/);
  assert.match(beyondRun.stderr, /\nBeyond Section 508 \(WCAG 2\.2\)\nrule +name +viol +review\n1\.3\.4 /);
});

const B_NAMES = '/checks-beyond-names.html';
check('AC3 2.5.3: "Read more" named "Learn about pricing" is a violation showing both strings', () => {
  onB(B_NAMES, '2.5.3', '#bn-mismatch', 'violation', /^The visible label "Read more" is not part of the accessible name "Learn about pricing" \(from aria-label\)/);
});
check('AC3 2.5.3: "Read more" named "Read more about pricing", and "search" named "Search the site", are not reported', () => noneB(B_NAMES, '2.5.3', ['#bn-match', '#bn-case']));
check('AC4 1.3.5: autocomplete="e-mail" is a violation', () => onB(B_NAMES, '1.3.5', '#bn-email-bad', 'violation', /^autocomplete="e-mail": "e-mail" is not an autofill token/));
check('AC4 1.3.5: "shipping email" and "section-blue billing tel" are valid', () => noneB(B_NAMES, '1.3.5', ['#bn-ship', '#bn-tel']));
check('AC4 1.3.5: autocomplete="email" on a checkbox is a violation', () => onB(B_NAMES, '1.3.5', '#bn-check', 'violation', /"email" cannot be used on <input type="checkbox">/));

const B_TARGETS = '/checks-beyond-targets.html';
check('AC5 2.5.8: a 16x16 icon button beside another is a violation', () => {
  const f = onB(B_TARGETS, '2.5.8', '#bt-a', 'violation', /^Target is 16x16 px, under 24x24, and a 24 px circle centred on it reaches #bt-b/);
  assert.equal(f.beyond508, true);
});
check('AC5 2.5.8: the same button alone with clear space around it is not reported', () => noneB(B_TARGETS, '2.5.8', ['#bt-alone']));
check('AC5 2.5.8: links inline in a sentence are not reported', () => noneB(B_TARGETS, '2.5.8', ['#bt-inline-1', '#bt-inline-2']));

const B_SPACING = '/checks-beyond-spacing.html';
check('AC6 1.4.12: inline letter-spacing:0 !important is a violation', () => onB(B_SPACING, '1.4.12', '#bs-important', 'violation', /^Inline style "letter-spacing: 0(px)? !important" overrides a user's text-spacing setting/));
check('AC6 1.4.12: a container that clips its text under the spacing pass is reported with the clipped element', () => {
  const f = onB(B_SPACING, '1.4.12', '#bs-clip', 'violation', /^Text "ABCDEFGHIJ KLMNOPQRS" is clipped when the user's text spacing is applied .*px cut horizontally/);
  assert.ok(/(\d+)px cut/.exec(f.message)[1] >= 8, f.message);
});
check('AC6 1.4.12: text that reflows is not reported, and the spacing style is removed afterwards', () => {
  noneB(B_SPACING, '1.4.12', ['#bs-flow']);
  assert.equal(bpages[B_SPACING].passes.spacing.restored, true);
});

check('AC7 1.3.4: a rule rotating .app a quarter turn under (orientation: portrait) is a review item', () => {
  onB('/checks-beyond-orientation.html', '1.3.4', '.app', 'review', /^Under @media \(orientation: portrait\), "\.app" rotates it a quarter turn \(rotate\(90deg\)\)/);
});

const B_FOCUS = '/checks-beyond-focus.html';
check('AC8 2.4.11: focus landing entirely under the fixed bar is a violation with the profile, not a 4.D review', () => {
  onB(B_FOCUS, '2.4.11', '#bf-under', 'violation', /entirely hidden by fixed or sticky content \(#bf-bar\)/);
  noneB(B_FOCUS, '4.D', ['#bf-under']);
});
check('AC8 4.D: the same focus without the profile is a 4.D review, and no 2.4.11', () => {
  on(B_FOCUS, '4.D', '#bf-under', 'review', /overlapped by another element/);
  noneOn(B_FOCUS, '2.4.11', ['#bf-under']);
});
check('AC8 2.4.11: a partly covered focused link stays a 4.D review with the profile, never 2.4.11', () => {
  noneB(B_FOCUS, '2.4.11', ['#bf-partial']);
  onB(B_FOCUS, '4.D', '#bf-partial', 'review', /overlapped by another element/);
});

const B_REFLOW = '/checks-beyond-reflow.html';
check('AC9 1.4.10: a 600 px wide block needs horizontal scrolling at 320 px', () => onB(B_REFLOW, '1.4.10', '#rf-wide', 'violation', /^At 320 CSS px wide \(400% zoom\), this element reaches \d+px \(it is 600px wide\)/));
check('fix round 1.4.10: a 600 px block cut off by an overflow:hidden wrapper is reported (its content is lost)', () => onB(B_REFLOW, '1.4.10', '#rf-clipped', 'violation', /^At 320 CSS px wide/));
check('AC9 1.4.10: a wide table and a pre are not reported', () => noneB(B_REFLOW, '1.4.10', ['#rf-table', '#rf-pre']));
check('AC9 1.4.10: the viewport is restored after the reflow pass', () => {
  assert.equal(bpages[B_REFLOW].passes.reflow.restored, true, JSON.stringify(bpages[B_REFLOW].passes.reflow));
});

const B_CONTRAST = '/checks-beyond-contrast.html';
check('AC10 1.4.11: a text field with a #ddd border on white is a review item', () => onB(B_CONTRAST, '1.4.11', '#bc-light', 'review', /^The border of this text field is #dddddd on #ffffff, 1\.36:1, below the 3:1/));
check('AC10 1.4.11: a #767676 border (3.99:1 on its #f0f0f0 panel) is not reported', () => noneB(B_CONTRAST, '1.4.11', ['#bc-dark']));
check('plan item 12 1.4.11: a focus indicator that only changes the background #fff to #eee is a review item', () => {
  onB(B_FOCUS, '1.4.11', '#bf-weak', 'review', /^The focus indicator is a change of background-color from #ffffff to #eeeeee, 1\.16:1 against its unfocused state/);
  noneOn(B_FOCUS, '4.D', ['#bf-weak']);
});

const B_BP = '/checks-beyond-bp.html';
check('AC11 BP: visible text outside every landmark is a review item', () => onB(B_BP, 'BP', '#bp-stray', 'review', /^Text "Office hours are nine to five on weekdays\." is outside every landmark/));
check('AC11 BP: text directly in the header and footer is inside a landmark', () => noneB(B_BP, 'BP', ['#bp-header', '#bp-footer']));
check('AC11 BP: a page with no h1, <li role="button">, and maximum-scale=2 are review items', () => {
  onB(B_BP, 'BP', 'h1', 'review', /^The page has no level-one heading/);
  onB(B_BP, 'BP', '#bp-li', 'review', /^role="button" is not allowed on <li>/);
  onB(B_BP, 'BP', 'meta[name=viewport]', 'review', /limits zoom to 200% \(maximum-scale=2\)/);
});

check('AC12 13.C: 20 px bold CJK text at 4.00:1 is a violation with the profile, noted and tagged beyond508', () => {
  const f = onB(B_CONTRAST, '13.C', '#bc-cjk', 'violation', /^Text contrast 4\.0\d?:1 is below 4\.5:1 \(20px bold, #7f7f7f on #ffffff\)\. \(CJK text counts as large only at 29\.3 px, or 24 px bold/);
  assert.equal(f.beyond508, true);
  assert.ok(Math.abs(f.details.ratio - 4.0) < 0.05, JSON.stringify(f.details));
});
check('AC12 13.C: the same text is large and passes 3:1 without the profile', () => noneOn(B_CONTRAST, '13.C', ['#bc-cjk']));
check('AC12 4.D: a button at opacity 0.05 receiving focus is a violation with the profile, and nothing without it', () => {
  assert.equal(onB(B_FOCUS, '4.D', '#bf-faint', 'violation', /almost transparent \(opacity under 0\.1/).beyond508, true);
  noneOn(B_FOCUS, '4.D', ['#bf-faint']);
});

const LEGACY = '/checks-modal-legacy.html';
check('AC15 4.A: a visible role="dialog" beside an aria-hidden app root (no aria-modal) is the open modal: no hidden-page finding', () => {
  assert.equal(pages[LEGACY].modalOnLoad?.selector, '#ml-dialog', JSON.stringify(pages[LEGACY].modalOnLoad));
  assert.equal(pages[LEGACY].modalOnLoad.name, 'Newsletter sign-up');
  assert.equal(pages[LEGACY].modalOnLoad.dismissed, true);
  noneOn(LEGACY, '4.A', ['#ml-root', 'body']);
});
check('AC15 4.A: the same root still aria-hidden with the dialog gone is a critical hidden-page finding', () => {
  assert.equal(on('/checks-modal-legacy-gone.html', '4.A', '#ml-root', 'violation', /^#ml-root is aria-hidden="true" and holds \d+% of the page's visible text, while no modal dialog is open/).impact, 'critical');
});

{
  const { events, problems } = parseEvents(evRun.stdout);
  const pageEvents = events.filter((e) => e.type === 'page');
  check('--events: every line on stdout is an event that fits the schema', () => {
    assert.ok(events.length > 0, evRun.stdout + evRun.stderr);
    assert.deepEqual(problems, []);
  });
  check('--events: starts with start, ends with done carrying the exit code', () => {
    assert.equal(events[0].type, 'start');
    assert.equal(events[0].kind, 'crawl');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).code, evRun.status);
    assert.equal(evRun.status, 1);
  });
  check('--events: one page event per page in report.json, with the same counts', () => {
    assert.ok(evReport, 'report.json written');
    assert.equal(pageEvents.length, evReport.pages.length);
    for (const p of evReport.pages) {
      const e = pageEvents.find((x) => x.finalUrl === (p.finalUrl || p.url));
      assert.ok(e, `page event for ${p.finalUrl || p.url}`);
      const v = (p.findings || []).filter((f) => f.level === 'violation').length;
      assert.equal(e.violations, v, `${e.finalUrl} violations`);
      assert.equal(e.reviews, (p.findings || []).length - v, `${e.finalUrl} reviews`);
      assert.equal(e.error, p.error || null);
    }
  });
  check('--events: page events count up, and discovered never trails done', () => {
    pageEvents.forEach((e, i) => {
      assert.equal(e.done, i + 1);
      assert.ok(e.discovered >= e.done, JSON.stringify(e));
      assert.equal(e.limit, 8);
    });
  });
  check('--events: summary and coverage equal report.json; --json and --quiet do not leak through', () => {
    const sum = events.find((e) => e.type === 'summary');
    assert.deepEqual(sum.summary, evReport.summary);
    assert.equal(sum.result, 'fail');
    assert.deepEqual(events.find((e) => e.type === 'coverage').warnings, evReport.summary.coverage.warnings);
    assert.ok(events.some((e) => e.type === 'info'), 'info lines are events even with --quiet');
  });
}
check('without --events the human output is unchanged from origin/main', () => {
  const golden = readGolden();
  const a = golden.split('\n');
  const b = human.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  assert.equal(human, golden, `first difference at line ${i + 1}:\n  origin/main: ${a[i]}\n  this tree:   ${b[i]}`);
});

// The navigation retry loop, with the single navigation stubbed out: Chrome
// absorbs plain socket drops itself, so this is the only way to drive it.
const stubbed = (outcomes) => {
  const page = new Page(null, { viewport: { width: 800, height: 600 }, settle: 0 });
  const attempts = [];
  page.navigateOnce = async (url) => {
    const e = outcomes.shift();
    attempts.push(e);
    return e ? { error: e } : { status: 200, finalUrl: url, timedOut: false };
  };
  return { page, attempts };
};
{
  const { page, attempts } = stubbed(['net::ERR_SOCKET_NOT_CONNECTED', 'net::ERR_CONNECTION_RESET', null]);
  const r = await page.goto('http://example.test/', 1000);
  check('transient navigation errors are retried until the page loads', () => {
    assert.equal(r.status, 200);
    assert.equal(r.retries, 2);
    assert.equal(attempts.length, 3);
  });
}
{
  const { page, attempts } = stubbed(['net::ERR_NAME_NOT_RESOLVED', null]);
  const r = await page.goto('http://example.test/', 1000);
  check('non-transient navigation errors are not retried', () => {
    assert.equal(r.error, 'net::ERR_NAME_NOT_RESOLVED');
    assert.equal(r.retries, 0);
    assert.equal(attempts.length, 1);
  });
}
{
  const { page, attempts } = stubbed(Array(10).fill('net::ERR_SOCKET_NOT_CONNECTED'));
  const r = await page.goto('http://example.test/', 1000);
  check('retries give up after three attempts', () => {
    assert.equal(r.error, 'net::ERR_SOCKET_NOT_CONNECTED');
    assert.equal(r.retries, 3);
    assert.equal(attempts.length, 4);
  });
}

console.log(failures ? `\n${failures} assertion(s) failed` : only ? `\nall ${ran} assertion(s) that read ${only} passed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
