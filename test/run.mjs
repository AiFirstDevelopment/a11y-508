// End-to-end test: serves the fixture site, requires a bearer token on every
// request, runs the CLI against it, and asserts on report.json.

import { createServer } from 'node:http';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures');
const TOKEN = 'fixture-token-123';
const COOKIE = 'fixture-cookie-456';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };

const externalHits = [];
const external = createServer((req, res) => {
  externalHits.push({ url: req.url, auth: req.headers.authorization || null });
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PNG);
});
await new Promise((r) => external.listen(0, '127.0.0.1', r));
const externalUrl = `http://127.0.0.1:${external.address().port}/pixel.png`;

const unauthorized = [];
const cookieHeaders = [];
const site = createServer((req, res) => {
  if (req.headers.cookie) cookieHeaders.push(req.headers.cookie);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    unauthorized.push(req.url);
    res.writeHead(401, { 'content-type': 'text/plain' });
    return res.end('unauthorized');
  }
  let path = new URL(req.url, 'http://x').pathname;
  if (path === '/') path = '/index.html';
  const ext = extname(path);
  if (path.startsWith('/img/')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG);
  }
  if (path === '/report.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    return res.end('%PDF-1.4 fixture');
  }
  if (path.startsWith('/media/')) {
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
    return res.end('');
  }
  if (path === '/submit') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><html lang="en"><title>Submitted</title><main><h1>Submitted</h1></main></html>');
  }
  const file = join(fixtures, path);
  if (!file.startsWith(fixtures) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('<!doctype html><html lang="en"><title>Not found</title><h1>404</h1></html>');
  }
  let body = readFileSync(file);
  if (ext === '.html') body = Buffer.from(body.toString('utf8').replace('EXTERNAL_IMAGE', externalUrl).replace('FIXTURE_TOKEN', TOKEN));
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}/`;
const out = join(here, '.report');
rmSync(out, { recursive: true, force: true });

console.log(`fixture site at ${base}`);
const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(root, 'bin/a11y-508.mjs'), base, '--out', out, '--concurrency', '2', '--max-screenshots', '5', '--json', '--token-storage', 'fixture_custom_key', '--cookie', `session=${COOKIE}`], {
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
site.close();
external.close();
console.log(`cli finished in ${((Date.now() - t0) / 1000).toFixed(1)}s with exit code ${run.status}`);
if (run.status === null) throw new Error('CLI was killed after 300s');

const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
const pages = Object.fromEntries(report.pages.map((p) => [new URL(p.url).pathname, p]));
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
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};

console.log('assertions:');
check('exit code 1 because violations exist', () => assert.equal(run.status, 1));
check('crawled all five html pages and the 404', () => {
  for (const p of ['/', '/forms.html', '/tables.html', '/media.html', '/about.html']) assert.ok(pages[p], p);
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

console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
