// Every state of the Fix step says what happened in one plain sentence and offers at most one step;
// what does not help with that (the ledger, the raw error) is closed until the person opens it.

import { test, expect, type Page } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOVED_BUTTONS, api, dashboard, fixtureSite, gitRepo, moreOptions, nav, open, removeTemp, run, tempDir, BIN, ROOT, TOKEN, type Dash, type Site } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const QUICK = ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots', '--no-follow-clicks', '--no-token-storage'];
const RAW = 'crawl failed: the crawl produced no report (exit 2):\nwarn A browser window is open on https://app.example.gov/\nerror login failed: gave up after 10 minutes waiting for sign-in to finish';

async function appWithReport(site: Site, prefix: string): Promise<{ cwd: string; report: any }> {
  const cwd = tempDir(prefix);
  const g = gitRepo(cwd);
  mkdirSync(join(cwd, 'site'));
  cpSync(join(ROOT, 'test', 'fixtures', 'index.html'), join(cwd, 'site', 'index.html'));
  writeFileSync(join(cwd, '.gitignore'), 'a11y-508-work/\na11y-508-report/\na11y-508-history/\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base, args: QUICK, agent: FAKE, source: ['site'], push: false, deployed: 'none', triageBatch: 50 }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'app');
  const crawl = await run(process.execPath, [BIN, site.base, ...QUICK, '--out', 'a11y-508-report', '--quiet', '--fail-on', 'none'], { cwd, env: { ...process.env, TOKEN } });
  expect(crawl.status, crawl.output).toBe(0);
  return { cwd, report: JSON.parse(readFileSync(join(cwd, 'a11y-508-report', 'report.json'), 'utf8')) };
}

// A fix loop that ended because its crawl's sign-in waited 10 minutes and gave up, as its journal
// records it (the dashboard moves it to the tool's folder on start and shows it on the Fix step),
// with a ledger from an earlier round.
async function signInTimedOut(cwd: string, site: Site, report: any): Promise<string> {
  const id = '22222222-3333-4444-8555-666666666666';
  const runs = join(cwd, 'a11y-508-work', 'runs');
  mkdirSync(runs, { recursive: true });
  const startedAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const at = new Date(Date.now() - 4 * 60_000).toISOString();
  const command = `a11y-508 loop ${site.base} --sign-in-first --events`;
  writeFileSync(join(runs, `${id}.run.json`), JSON.stringify({ id, kind: 'loop', pid: 999999, startedAt, cwd, url: site.base, args: [], meta: { url: site.base, command }, request: { kind: 'loop', url: site.base, auth: { mode: 'none' }, maxRounds: 1 } }));
  const evs = [
    { type: 'run', id, kind: 'loop', at: startedAt, url: site.base, command },
    { type: 'round', round: 2, at: startedAt },
    { type: 'step', round: 2, step: 'crawl', first: true, at: startedAt },
    { type: 'login-waiting', at: startedAt },
    { type: 'error', message: RAW, at },
    { type: 'done', code: 2, signal: null, stopped: false, outcome: 'error', at },
  ];
  writeFileSync(join(runs, `${id}.events.ndjson`), evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  // @ts-ignore -- plain JS from the core
  const { applyReport } = await import('../../src/ledger.mjs');
  const ledger: any = { version: 1, rounds: [], findings: {} };
  applyReport(ledger, report, 1);
  writeFileSync(join(cwd, 'a11y-508-work', 'ledger.json'), JSON.stringify(ledger, null, 2));
  return id;
}

const bigButtons = (page: Page) => page.locator('main button.big:visible, main a.button.big:visible');

// docs/plans/turnkey-loop.md AC 5: a loop that ended with an error is tried again by itself; the step
// says what happened and when, and Stop is its one button.
test('next step: a loop that ended with an error says so plainly and when it tries again, offers only Stop, and keeps the ledger and the raw error closed', async ({ page }) => {
  const site = await fixtureSite();
  const { cwd, report } = await appWithReport(site, 'a11y-508-next-signin-');
  const id = await signInTimedOut(cwd, site, report);
  const dash: Dash = await dashboard({ cwd, env: { A11Y_508_RETRY_DELAYS: '600' } });
  try {
    await open(page, dash, '/fix-loop', { details: false });
    const headline = page.getByTestId('fix-status');
    await expect(headline).toHaveText(/^The site could not be checked: the crawl produced no report\. Trying again in (9 m \d\d s|10 min) \(attempt 2\)\.$/, { timeout: 30_000 });
    await expect(headline).toBeVisible();
    await expect(page.getByTestId('where-now-text')).toHaveText('Now: stopped: the site could not be checked: the crawl produced no report; trying again by itself');
    await expect(page.getByTestId('where-next-text')).toHaveText(/^Next: fix the \d+ remaining$/);
    // Exactly one big button, and it is Stop.
    await expect(bigButtons(page)).toHaveCount(1);
    await expect(bigButtons(page)).toHaveText('Stop');
    await expect(page.getByRole('button', { name: REMOVED_BUTTONS })).toHaveCount(0);
    await expect(page.getByTestId('run-again')).toHaveCount(0);
    // The raw CLI text is under a closed Details, not on the screen.
    await expect(page.getByTestId('loop-problem')).toHaveCount(0);
    await expect(page.getByTestId('problem-message')).toBeHidden();
    await expect(page.locator('main')).not.toContainText('gave up after', { useInnerText: true });
    await page.getByTestId('why').locator('> summary').click();
    await expect(page.getByTestId('problem-message')).toBeVisible();
    await expect(page.getByTestId('problem-message')).toContainText('gave up after 10 minutes waiting for sign-in to finish');
    // The ledger: closed by default, its summary says what is in it, and it opens.
    const ledger = page.getByTestId('ledger');
    await expect(ledger).toHaveJSProperty('open', false);
    await expect(page.getByTestId('ledger-summary')).toHaveText(/^Ledger \(\d+ open(, .+)?\)$/);
    await expect(page.getByTestId('ledger-counts')).toBeHidden();
    await ledger.locator('> summary').click();
    await expect(page.getByTestId('ledger-counts')).toBeVisible();
    // No crawl ran: no empty "0 of 0 pages" or empty page table, even with every Details open.
    const details = page.getByTestId('details');
    await details.locator('> summary').click();
    await expect(details).toHaveJSProperty('open', true);
    await expect(page.locator('main')).not.toContainText('No page has finished yet');
    await expect(page.locator('main')).not.toContainText(/Finished: 0 of 0/);
    await expect(page.getByTestId('page-list')).toHaveCount(0);
    // The person's choices are remembered: after a reload the ledger is still open, and the try again is still coming.
    await page.reload();
    await expect(headline).toHaveText(/ Trying again in (9 m \d\d s|10 min) \(attempt 2\)\.$/, { timeout: 30_000 });
    await expect(page.getByTestId('ledger')).toHaveJSProperty('open', true);

    // Stop cancels the try again; Fix the violations is then the step forward, and starts the loop
    // (the way in chosen on Set up: a token, so no window opens here).
    await page.getByTestId('loop-stop').click();
    await expect(headline).toHaveText('Stopped.', { timeout: 15_000 });
    await nav(page, 'Run');
    await moreOptions(page);
    await page.getByLabel('A token').check();
    await page.getByLabel(/^Token \(sent as/).fill(TOKEN);
    await nav(page, 'Fix loop');
    await expect(page.getByTestId('assistant-line')).toHaveText(/Fixing with/, { timeout: 60_000 });
    await page.getByTestId('loop-start').click();
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json.id, { timeout: 60_000 }).not.toBe(id);
    expect((await api(dash, '/api/runs/current')).json.kind).toBe('loop');
    await expect(page.getByTestId('loop-stop')).toBeVisible({ timeout: 30_000 });
    await api(dash, '/api/runs/current/stop', { method: 'POST' });
    await expect(page.getByTestId('loop-start')).toBeVisible({ timeout: 60_000 });
  } finally {
    await dash.stop();
    removeTemp(cwd);
    site.close();
  }
});

test('next step: a crawl whose sign-in timed out says so plainly on the Crawl step, with no empty page counts and one "Run again"', async ({ page }) => {
  const cwd = tempDir('a11y-508-next-crawl-');
  gitRepo(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  const id = '33333333-4444-4555-8666-777777777777';
  const url = 'https://app.example.gov/';
  const startedAt = new Date(Date.now() - 12 * 60_000).toISOString();
  const at = new Date(Date.now() - 60_000).toISOString();
  const command = `a11y-508 ${url} --login --stay --events`;
  // The server's stream for the crawl that ended, as it replays it (a finished crawl is not kept
  // across a relaunch, so the page is given its events directly).
  const evs = [
    { type: 'run', id, kind: 'crawl', at: startedAt, url, command },
    { type: 'login-waiting', at: startedAt },
    { type: 'error', message: 'login failed: gave up after 10 minutes waiting for sign-in to finish', at },
    { type: 'done', code: 2, signal: null, stopped: false, outcome: 'error', at },
  ];
  const dash: Dash = await dashboard({ cwd });
  try {
    await page.route('**/api/env', async (route) => {
      const res = await route.fetch();
      const env = await res.json();
      await route.fulfill({ response: res, json: { ...env, run: { id, kind: 'crawl', status: 'done', startedAt } } });
    });
    await page.route('**/api/runs/current/events', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') }));
    await open(page, dash, '/live', { details: false });
    await expect(page.getByTestId('crawl-status')).toHaveText('Nobody signed in, so the site was not checked.', { timeout: 30_000 });
    await expect(bigButtons(page)).toHaveCount(1);
    await expect(bigButtons(page)).toHaveText('Run again');
    await expect(page.getByRole('button', { name: REMOVED_BUTTONS })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('crawl-pages')).toHaveCount(0);
    await expect(page.getByTestId('crawl-counts')).toHaveCount(0);
    // The raw text is under the closed Details; opened, it is there, and still no empty page table.
    await expect(page.locator('main')).not.toContainText('gave up after', { useInnerText: true });
    await page.getByTestId('details').locator('> summary').click();
    await expect(page.locator('[data-notice="error"]')).toContainText('gave up after 10 minutes waiting for sign-in to finish');
    await expect(page.getByTestId('page-list')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/Finished: 0 of 0|No page has finished yet/);
  } finally {
    await dash.stop();
    removeTemp(cwd);
  }
});
