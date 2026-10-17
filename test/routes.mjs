// The application's routes, read from its Angular router configuration (docs/plans/pictures-and-
// routes.md AC 4): the fixture router under test/fixtures/routes (a flat route, nested children with
// a '' default, loadChildren to a routes file and to an NgModule, a ':id' parameter, a '**' wildcard),
// and how knownRoutes puts them under the start URL. Run: node test/routes.mjs  (or -g "<name>").

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBase, closing, lazyTarget, routeTrees, routeUrls, scanRoutes } from '../src/routes.mjs';
import { knownRoutes, routeSources, routesLine } from '../src/manual.mjs';

const only = process.argv.includes('-g') ? process.argv[process.argv.indexOf('-g') + 1] : null;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'routes');
// knownRoutes reads the crawl's reports under the tool's state base: a temporary one, with none.
const home = mkdtempSync(join(tmpdir(), 'a11y-508-routes-'));
process.env.A11Y_508_HOME = home;

// HELP_ROUTES is its own typed array earlier in the file, so it is read first; its spread into routes adds nothing twice.
const EXPECTED = ['/help', '/', '/search', '/layout', '/layout/default', '/layout/form-panel', '/reports', '/reports/summary', '/admin', '/admin/users'];

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
  assert.deepEqual(routeUrls('https://host.test/app/layout/default', EXPECTED).slice(1, 6), ['https://host.test/app/', 'https://host.test/app/search', 'https://host.test/app/layout', 'https://host.test/app/layout/default', 'https://host.test/app/layout/form-panel']);
  assert.deepEqual(routeUrls('not a url', ['/']), []);
});

test('AC4 / guard e: with no crawl, knownRoutes is the router\'s routes under the start URL, then the start URL, deduplicated; the line names the source', () => {
  const start = 'http://127.0.0.1:4100/';
  const routes = routeSources(FIXTURE, { startUrl: start, sourceDirs: ['src'] });
  assert.deepEqual(routes.map((r) => r.url), EXPECTED.map((p) => `${start}${p.slice(1)}`));
  assert.deepEqual([...new Set(routes.map((r) => r.from))], ['router']);
  assert.deepEqual(knownRoutes(FIXTURE, { startUrl: start, sourceDirs: ['src'] }), routes.map((r) => r.url));
  assert.equal(routesLine(routes), "Routes the tool knew: 10 (from the application's router)");
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
