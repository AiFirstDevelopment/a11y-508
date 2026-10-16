// Desktop notifications: when the tab is not in front, the dashboard says when a round's fixes are
// pushed and when the loop ends, so nobody has to watch the page.

import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard, fixtureSite, open, moreOptions, nav, removeTemp, ROOT, TOKEN, type Dash, type Site } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;

let site: Site;
let dash: Dash;
test.beforeEach(async () => {
  site = await fixtureSite();
  dash = await dashboard();
});
test.afterEach(async () => {
  await dash.stop();
  site.close();
});

test('notifications: with permission given and the tab in the background, a pushed round and the loop\'s end are announced', async ({ page, context }) => {
  test.setTimeout(300_000);
  await context.grantPermissions(['notifications'], { origin: dash.origin });
  // The real Notification is replaced by a recorder, and the tab reads as not in front.
  await page.addInitScript(() => {
    (window as any).__notifications = [];
    class Fake {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body?: string } = {}) {
        (window as any).__notifications.push({ title, body: opts.body || '' });
      }
      close() {}
    }
    (window as any).Notification = Fake;
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
    document.hasFocus = () => false;
  });
  writeFileSync(join(dash.cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(dash.cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base + 'about.html', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'], agent: FAKE, source: ['site'], push: false, deployed: 'none', maxAttempts: 1, triageBatch: 50 }));
  const g = (...a: string[]) => require('node:child_process').spawnSync('git', a, { cwd: dash.cwd, encoding: 'utf8' });
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'app', '--author', 'a <a@example.com>');
  await open(page, dash, '/run');
  await moreOptions(page);
  await page.getByLabel('A token').check();
  await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
  await nav(page, 'Fix loop');
  await page.getByTestId('loop-start').click();
  await expect.poll(async () => (await page.evaluate(() => (window as any).__notifications)).map((n: any) => n.title), { timeout: 240_000 }).toContainEqual(expect.stringMatching(/^a11y-508: Fix loop (finished|stopped|ended)/));
  const titles: string[] = (await page.evaluate(() => (window as any).__notifications)).map((n: any) => n.title);
  expect(titles.some((t) => /^a11y-508: Fix loop/.test(t)), titles.join(' | ')).toBe(true);
});
