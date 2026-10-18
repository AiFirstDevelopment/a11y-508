// The application's routes, read from its Angular router configuration (docs/plans/pictures-and-
// routes.md AC 4): the fixture router under test/fixtures/routes (a flat route, nested children with
// a '' default, loadChildren to a routes file, to an NgModule and to one whose routes are in its
// routing module, a ':id' parameter, a '**' wildcard),
// and how knownRoutes puts them under the start URL. Run: node test/routes.mjs  (or -g "<name>").

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBase, closing, groupRoutes, hashRoute, lazyTarget, routeTrees, routeUrls, scanRoutes } from '../src/routes.mjs';
import { knownRoutes, needsCrawl, onRouteList, routeSources, routesLine } from '../src/manual.mjs';
import { routeLines } from '../src/agent.mjs';
import { workDir } from '../src/home.mjs';

const only = process.argv.includes('-g') ? process.argv[process.argv.indexOf('-g') + 1] : null;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'routes');
// knownRoutes reads the crawl's reports under the tool's state base: a temporary one, with none.
const home = mkdtempSync(join(tmpdir(), 'a11y-508-routes-'));
process.env.A11Y_508_HOME = home;

// HELP_ROUTES is its own typed array, but routes spreads it, so it is read there, where the spread is.
// /settings is an NgModule whose routes are in the routing module it imports.
const EXPECTED = ['/', '/search', '/layout', '/layout/default', '/layout/form-panel', '/reports', '/reports/summary', '/admin', '/admin/users', '/settings', '/settings/profile', '/help'];

test('AC4 / guard e: the fixture router yields every route, nested and lazy, with the default joined to its parent and no ** or :id', () => {
  assert.deepEqual(scanRoutes(FIXTURE, ['src']), EXPECTED);
  // Deterministic.
  assert.deepEqual(scanRoutes(FIXTURE, ['src']), EXPECTED);
  // A folder that is not an Angular router: nothing.
  assert.deepEqual(scanRoutes(join(FIXTURE, 'nowhere'), ['src']), []);
});

test('AC4: a route array is found as a typed const, inside forRoot/forChild/provideRouter (a literal or a name), and read past strings, comments and nested brackets', () => {
  const literal = `@NgModule({ imports: [RouterModule.forRoot([ { path: '', component: A }, { path: 'about', component: B, data: { x: ']' } } ], { useHash: true })] })`;
  assert.deepEqual(routeTrees(literal).map((t) => t.map((r) => r.path)), [['', 'about']]);
  const named = `const r: Routes = [{ path: 'a' }, { path: 'b', children: [{ path: 'c' }] }];\nexport const cfg = { providers: [provideRouter(r)] };`;
  assert.deepEqual(routeTrees(named).map((t) => t.map((r) => [r.path, r.children.map((c) => c.path)])), [[['a', []], ['b', ['c']]]]);
  const lazy = `export const X: Route[] = [{ path: 'admin', loadChildren: () => import('./admin/admin.module').then((m) => m.AdminModule) }];`;
  assert.deepEqual(routeTrees(lazy)[0].map((r) => [r.path, r.lazy]), [['admin', './admin/admin.module']]);
  // children: NAME and a spread inside children are followed, and the named arrays are not trees of their own.
  const children = (t) => routeTrees(t).map((tree) => tree.map((r) => [r.path, r.children.map((c) => c.path)]));
  assert.deepEqual(children(`const ACCT_CHILDREN: Routes = [{ path: 'settings' }];\nexport const routes: Routes = [{ path: 'acct', children: ACCT_CHILDREN }];`), [[['acct', ['settings']]]]);
  assert.deepEqual(children(`const SUB: Routes = [{ path: 'x' }];\nexport const routes: Routes = [{ path: 'acct', children: [...SUB, { path: 'y' }] }];`), [[['acct', ['x', 'y']]]]);
  // Nothing route-like: nothing.
  assert.deepEqual(routeTrees('const a = [1, 2, 3];'), []);
  assert.equal(closing("[ 'x]', `a${']'}b` ]", 0), 19);
  assert.equal(closing('[ unclosed', 0), -1);
  assert.equal(lazyTarget(join(FIXTURE, 'src', 'app', 'app.routes.ts'), './reports/reports.routes'), join(FIXTURE, 'src', 'app', 'reports', 'reports.routes.ts'));
  assert.equal(lazyTarget(join(FIXTURE, 'src', 'app', 'app.routes.ts'), '@scope/package'), null);
});

test('AC4: the routes are put under the start URL, or under what comes before it when the start URL is itself a route', () => {
  assert.equal(appBase('http://127.0.0.1:4100/', EXPECTED), 'http://127.0.0.1:4100/');
  assert.equal(appBase('https://host.test/app/', EXPECTED), 'https://host.test/app/');
  assert.equal(appBase('https://host.test/app/layout/default', EXPECTED), 'https://host.test/app/');
  assert.equal(appBase('https://host.test/layout/', EXPECTED), 'https://host.test/');
  assert.deepEqual(routeUrls('https://host.test/app/layout/default', EXPECTED).slice(0, 5), ['https://host.test/app/', 'https://host.test/app/search', 'https://host.test/app/layout', 'https://host.test/app/layout/default', 'https://host.test/app/layout/form-panel']);
  assert.deepEqual(routeUrls('not a url', ['/']), []);
  // Hash routing (useHash): the routes go after the start page's '#/', and the list check keeps them apart.
  assert.deepEqual(routeUrls('http://h/#/home', ['/', '/home', '/a/b']), ['http://h/#/', 'http://h/#/home', 'http://h/#/a/b']);
  assert.deepEqual(routeUrls('http://h/app/index.html#/home', ['/x']), ['http://h/app/index.html#/x']);
  assert.equal(hashRoute('http://h/#/a/b/?q=1'), '#/a/b');
  assert.equal(hashRoute('http://h/page#section'), '');
  const hashed = routeUrls('http://h/#/home', ['/', '/home']);
  assert.equal(onRouteList('http://h/#/home/', hashed, 'http://h/#/home'), true);
  assert.equal(onRouteList('http://h/#/made-up', hashed, 'http://h/#/home'), false);
  assert.deepEqual(routeSources(FIXTURE, { startUrl: 'http://h/#/search', sourceDirs: ['src'] }).map((r) => r.url).slice(0, 3), ['http://h/#/', 'http://h/#/search', 'http://h/#/layout']);
});

test('AC4 / guard e: with no crawl, knownRoutes is the router\'s routes under the start URL, then the start URL, deduplicated; the line names the source', () => {
  const start = 'http://127.0.0.1:4100/';
  const routes = routeSources(FIXTURE, { startUrl: start, sourceDirs: ['src'] });
  assert.deepEqual(routes.map((r) => r.url), EXPECTED.map((p) => `${start}${p.slice(1)}`));
  assert.deepEqual([...new Set(routes.map((r) => r.from))], ['router']);
  assert.deepEqual(knownRoutes(FIXTURE, { startUrl: start, sourceDirs: ['src'] }), routes.map((r) => r.url));
  assert.equal(routesLine(routes), "Routes the tool knew: 12 (from the application's router)");
  // A non-Angular folder: the start URL only.
  const plain = routeSources(join(FIXTURE, 'src'), { startUrl: start, sourceDirs: ['app'] });
  assert.deepEqual(plain, [{ url: start, from: 'start', title: null, headings: [] }]);
  assert.equal(routesLine(plain), 'Routes the tool knew: 1 (the start page only)');
  assert.equal(routesLine([{ url: start, from: 'crawl' }, { url: `${start}x`, from: 'router' }]), "Routes the tool knew: 2 (1 from looking over the site; 1 from the application's router)");
  assert.equal(routesLine([{ url: start, from: 'crawl' }, { url: `${start}x`, from: 'crawl' }]), 'Routes the tool knew: 2 (from looking over the site)');
  // Without a start URL (the old call), the crawl's routes only: none here.
  assert.deepEqual(knownRoutes(FIXTURE), []);
});

// ---- docs/plans/manual-crawl-first.md: the PDF run's own look over the site comes first.

// A crawl report as the crawler writes it: pages with their title and headings, one that answered an
// error, one sent off to a sign-in, a query variant and a trailing slash of pages already there.
const CRAWLED = (start) => ({ finishedAt: '2026-10-18T10:00:00.000Z', summary: { pages: 8, audited: 6 }, pages: [
  { url: start, finalUrl: start, title: 'Example app', headings: ['Welcome'] },
  { url: `${start}search`, finalUrl: `${start}search`, title: 'Search', headings: ['Search', 'Results'] },
  { url: `${start}search?q=a`, finalUrl: `${start}search?q=a`, title: 'Search', headings: ['Search'] },
  { url: `${start}layout/mra-request/BR-1234g`, finalUrl: `${start}layout/mra-request/BR-1234g`, title: 'MRA Request', headings: ['Request BR-1234g', 'Status'] },
  { url: `${start}layout/mra-request/BR-1235h/`, finalUrl: `${start}layout/mra-request/BR-1235h/`, title: 'MRA Request', headings: ['Request BR-1235h', 'Status'] },
  { url: `${start}layout/mra-request/BR-1234g/`, finalUrl: `${start}layout/mra-request/BR-1234g/`, title: 'MRA Request', headings: ['Request BR-1234g'] },
  { url: `${start}broken`, finalUrl: `${start}broken`, title: '', error: 'HTTP 500' },
  { url: `${start}secret`, finalUrl: 'https://login.example/x', title: 'Sign in', skipped: 'redirected off-origin to https://login.example/x' },
] });

test('crawl-first AC2 / guard b: the run\'s crawl report comes first, with each page\'s title and headings, pages deduplicated without the query or a trailing slash, error and sign-in pages left out, then the router\'s routes; the line counts both', () => {
  const start = 'http://127.0.0.1:4100/';
  const run = mkdtempSync(join(tmpdir(), 'a11y-508-run-'));
  mkdirSync(join(run, 'crawl'), { recursive: true });
  writeFileSync(join(run, 'crawl', 'report.json'), JSON.stringify(CRAWLED(start)));
  const routes = routeSources(FIXTURE, { startUrl: start, sourceDirs: ['src'], runDir: run });
  assert.deepEqual(routes.slice(0, 4), [
    { url: start, from: 'crawl', title: 'Example app', headings: ['Welcome'] },
    { url: `${start}search`, from: 'crawl', title: 'Search', headings: ['Search', 'Results'] },
    { url: `${start}layout/mra-request/BR-1234g`, from: 'crawl', title: 'MRA Request', headings: ['Request BR-1234g', 'Status'] },
    { url: `${start}layout/mra-request/BR-1235h/`, from: 'crawl', title: 'MRA Request', headings: ['Request BR-1235h', 'Status'] },
  ]);
  assert.deepEqual(routes.filter((r) => r.from === 'crawl').length, 4);
  // The router's routes follow, the two already crawled left out; nothing from the start URL (crawled).
  assert.deepEqual(routes.filter((r) => r.from === 'router').map((r) => r.url), EXPECTED.filter((p) => p !== '/' && p !== '/search').map((p) => `${start}${p.slice(1)}`));
  assert.deepEqual(routes.filter((r) => r.from === 'start'), []);
  assert.equal(routesLine(routes), "Routes the tool knew: 14 (4 from looking over the site; 10 from the application's router)");
  // Headings a report keeps under info (an older build's) are read too; a page record with none has [].
  const old = { pages: [{ url: `${start}a`, title: 'A', info: { headings: ['One'] } }, { url: `${start}b`, title: 'B' }] };
  writeFileSync(join(run, 'crawl', 'report.json'), JSON.stringify(old));
  assert.deepEqual(routeSources(FIXTURE, { runDir: run }), [{ url: `${start}a`, from: 'crawl', title: 'A', headings: ['One'] }, { url: `${start}b`, from: 'crawl', title: 'B', headings: [] }]);
  rmSync(run, { recursive: true, force: true });
});

test('crawl-first AC2/3 / guards c f: the prompt lists each route with its title and headings; detail pages that differ only in their last segment and share a title are one line, kept apart from other folders and from untitled routes; a looked-at group is listed in full', () => {
  const h = 'http://h/';
  const list = [
    { url: `${h}`, from: 'crawl', title: 'Example app', headings: ['Welcome'] },
    { url: `${h}search`, from: 'crawl', title: 'Search', headings: ['Search'] },
    { url: `${h}items/1`, from: 'crawl', title: 'Item', headings: ['Item'] },
    { url: `${h}items/2`, from: 'crawl', title: 'Item', headings: ['Item'] },
    { url: `${h}orders/1`, from: 'crawl', title: 'Item', headings: ['Order'] },
    { url: `${h}items/new`, from: 'crawl', title: 'New item', headings: [] },
    { url: `${h}reports`, from: 'router', title: null, headings: [] },
    { url: `${h}gone`, from: 'router', title: null, headings: [] },
  ];
  // Guard f: one entry for the two items, /orders/1 apart (another folder), /items/new apart (another title), untitled routes never grouped.
  const groups = groupRoutes(list);
  assert.deepEqual(groups.map((g) => [g.url, g.more]), [[h, []], [`${h}search`, []], [`${h}items/1`, [`${h}items/2`]], [`${h}orders/1`, []], [`${h}items/new`, []], [`${h}reports`, []], [`${h}gone`, []]]);
  // Top-level pages sharing a title are not grouped either (the root is not a folder of detail pages).
  assert.deepEqual(groupRoutes([{ url: `${h}a`, title: 'X' }, { url: `${h}b`, title: 'X' }]).map((g) => g.more), [[], []]);
  // Hash-routed detail pages group by the route after #/.
  assert.deepEqual(groupRoutes([{ url: `${h}#/items/1`, title: 'Item' }, { url: `${h}#/items/2`, title: 'Item' }]).map((g) => [g.url, g.more]), [[`${h}#/items/1`, [`${h}#/items/2`]]]);
  // Hash-routed top-level pages are kept apart as path-routed ones are: '#/' is the root, not a folder of detail pages (under the site's root or under a path).
  assert.deepEqual(groupRoutes([{ url: `${h}#/home`, title: 'App' }, { url: `${h}#/search`, title: 'App' }]).map((g) => [g.url, g.more]), [[`${h}#/home`, []], [`${h}#/search`, []]]);
  assert.deepEqual(groupRoutes([{ url: `${h}app/#/home`, title: 'App' }, { url: `${h}app/#/search`, title: 'App' }]).map((g) => g.more), [[], []]);
  assert.equal(routeLines([{ url: `${h}#/home`, title: 'App' }, { url: `${h}#/search`, title: 'App' }], h), `- ${h}#/home — "App"\n- ${h}#/search — "App"`);
  // Guard c: the lines.
  assert.equal(routeLines(list, h), [
    `- ${h} — "Example app": Welcome`,
    `- ${h}search — "Search": Search`,
    `- ${h}items/1 — "Item": Item (and 1 more like it)`,
    `- ${h}orders/1 — "Item": Order`,
    `- ${h}items/new — "New item"`,
    `- ${h}reports`,
    `- ${h}gone`,
  ].join('\n'));
  // The locate step, when the page looked at was one of a group: the group in full.
  assert.equal(routeLines(list.slice(2, 4), h, [`${h}items/1`]), `- ${h}items/1 — "Item": Item\n- ${h}items/2 — "Item": Item`);
  // Plain URLs (an older routes.json) still list; none at all lists the start URL; the words after the URL stop at 120 characters.
  assert.equal(routeLines([`${h}x`, `${h}y`], h), `- ${h}x\n- ${h}y`);
  assert.equal(routeLines([], h), `- ${h}`);
  const long = routeLines([{ url: `${h}p`, title: 'T', headings: Array.from({ length: 8 }, (_, i) => `Heading number ${i + 1} of the page`) }], h);
  assert.equal(long.length, `- ${h}p`.length + 120);
  assert.ok(long.endsWith('…'));
});

test('crawl-first AC1 / guard d: the run crawls once: not when its own crawl report is there, not when the loop has crawled the repository already (round-1/report.json), and not when the config says 0 pages', () => {
  const run = mkdtempSync(join(tmpdir(), 'a11y-508-run-'));
  assert.equal(needsCrawl(FIXTURE, run, 60), true);
  assert.equal(needsCrawl(FIXTURE, run, 0), false);
  mkdirSync(join(run, 'crawl'), { recursive: true });
  writeFileSync(join(run, 'crawl', 'report.json'), JSON.stringify({ pages: [] }));
  assert.equal(needsCrawl(FIXTURE, run, 60), false);
  rmSync(join(run, 'crawl'), { recursive: true, force: true });
  // A loop's round in the repository's work folder: its pages are the routes; no crawl of the run's own.
  const round = join(workDir(FIXTURE), 'round-1');
  mkdirSync(round, { recursive: true });
  writeFileSync(join(round, 'report.json'), JSON.stringify({ pages: [{ url: 'http://127.0.0.1:4100/search', title: 'Search', headings: ['Search'] }] }));
  assert.equal(needsCrawl(FIXTURE, run, 60), false);
  assert.deepEqual(routeSources(FIXTURE, { runDir: run }), [{ url: 'http://127.0.0.1:4100/search', from: 'crawl', title: 'Search', headings: ['Search'] }]);
  // A round whose pages all failed is no crawl to go by.
  writeFileSync(join(round, 'report.json'), JSON.stringify({ pages: [{ url: 'http://127.0.0.1:4100/', error: 'HTTP 500' }] }));
  assert.equal(needsCrawl(FIXTURE, run, 60), true);
  rmSync(round, { recursive: true, force: true });
  assert.equal(existsSync(round), false);
  rmSync(run, { recursive: true, force: true });
});

let failed = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${t.name}\n${e.stack}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'routes: all passed');
process.exit(failed ? 1 : 0);
