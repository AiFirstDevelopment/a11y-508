// The application's routes, read from its Angular router configuration (docs/plans/pictures-and-
// routes.md AC 4): the fixture router under test/fixtures/routes (a flat route, nested children with
// a '' default, loadChildren to a routes file, to an NgModule and to one whose routes are in its
// routing module, a ':id' parameter, a '**' wildcard),
// and how knownRoutes puts them under the start URL. Run: node test/routes.mjs  (or -g "<name>").

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBase, closing, hashRoute, lazyTarget, routeTrees, routeUrls, scanRoutes } from '../src/routes.mjs';
import { knownRoutes, onRouteList, routeSources, routesLine } from '../src/manual.mjs';

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
  assert.deepEqual(plain, [{ url: start, from: 'start' }]);
  assert.equal(routesLine(plain), 'Routes the tool knew: 1 (the start page only)');
  assert.equal(routesLine([{ url: start, from: 'crawl' }, { url: `${start}x`, from: 'router' }]), "Routes the tool knew: 2 (from the crawl and the application's router)");
  // Without a start URL (the old call), the crawl's routes only: none here.
  assert.deepEqual(knownRoutes(FIXTURE), []);
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
