// Needs a person (docs/plans/needs-a-person.md): the findings the loop could not decide, each with
// what to check and where to look (pages, screenshot, HTML, selector, the source lines), and the
// person's decision written to the ledger, which the loop then follows.
//
// The loop test app (test/loop-app) in a throwaway git repository, crawled with screenshots; its
// ledger is round 1 of that report with two findings that need a person (the image with no alt on
// the home page, and the site-wide page titles) and three open ones.

import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dashboard, open, nav, removeTemp, run, tempDir, BIN, ROOT, type Dash } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const IMG = '7.A|#main > img|';
const TITLES = '12.B|head > title|';
const OPEN = ['13.C|', '6.A|#share|', '5.A|#email|'];

interface App {
  cwd: string;
  url: string;
  dash: Dash;
  fp(prefix: string): string;
  ledger(): any;
  close(): Promise<void>;
}

async function loopApp(): Promise<App> {
  const cwd = tempDir('a11y-508-np-');
  const setup = spawnSync(process.execPath, [join(ROOT, 'test', 'loop-app', 'setup.mjs'), cwd, '--agent', FAKE], { encoding: 'utf8' });
  expect(setup.status, setup.stderr).toBe(0);
  const { startServer } = await import(pathToFileURL(join(cwd, 'server.mjs')).href);
  const server = await startServer(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const config = JSON.parse(readFileSync(join(cwd, 'a11y-508.config.json'), 'utf8'));
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({ ...config, url, args: ['--max-pages', '5', '--no-interact', '--no-zoom', '--no-screenshots'] }, null, 2));
  spawnSync('git', ['commit', '-qam', 'the config names the server'], { cwd });
  const crawl = await run(process.execPath, [BIN, url, '--max-pages', '5', '--no-interact', '--no-zoom', '--max-screenshots', '20', '--fail-on', 'none', '--quiet', '--out', join(cwd, 'a11y-508-report')]);
  expect(crawl.status, crawl.output).toBe(0);
  // @ts-ignore -- the core's own ledger, plain JS
  const { applyReport, saveLedger } = await import(pathToFileURL(join(ROOT, 'src', 'ledger.mjs')).href);
  const report = JSON.parse(readFileSync(join(cwd, 'a11y-508-report', 'report.json'), 'utf8'));
  const ledger = { version: 1, rounds: [], findings: {} as Record<string, any> };
  applyReport(ledger, report, 1);
  const find = (prefix: string) => {
    const k = Object.keys(ledger.findings).find((f) => f.startsWith(prefix));
    expect(k, `a finding ${prefix} in the loop app's report`).toBeTruthy();
    return k!;
  };
  const nh = [find(IMG), find(TITLES)];
  const open = OPEN.map(find);
  for (const [k, e] of Object.entries(ledger.findings)) {
    e.status = nh.includes(k) ? 'needs-human' : open.includes(k) ? 'open' : 'adequate';
    if (nh.includes(k)) {
      e.reason = k === nh[0] ? 'still present after 3 fix attempts' : null;
      if (k === nh[1]) e.triage = { round: 1, decision: 'unsure', reason: 'a person must judge whether each title names its page' };
    }
  }
  // The image is also on a page whose address has a query string, which the card hides.
  ledger.findings[nh[0]].pages.push(`${url}index.html?from=news`);
  // The ledger and the report where an earlier version left them: the dashboard moves them to its own folder for the repository.
  saveLedger(join(cwd, 'a11y-508-work', 'ledger.json'), ledger);
  const dash = await dashboard({ cwd, keepCwd: true });
  return {
    cwd, url, dash,
    fp: find,
    ledger: () => JSON.parse(readFileSync(join(dash.dirs().work, 'ledger.json'), 'utf8')),
    close: async () => {
      await dash.stop();
      server.close();
      removeTemp(cwd, { maxRetries: 15, retryDelay: 200 });
    },
  };
}

const card = (page: Page, prefix: string) => page.locator(`[data-testid="review-card"][data-fingerprint^="${prefix}"]`);

test('NP AC 1, guards 1 and 7: the Fix step and History link to the screen, which lists exactly the findings that need a person', async ({ page }) => {
  const app = await loopApp();
  try {
    await open(page, app.dash, '/fix-loop');
    await expect(page.getByTestId('ledger-counts')).toBeVisible();
    // The old bullet list under Details is gone; one line with the count and the link instead.
    await expect(page.locator('[data-list="needs-human"]')).toHaveCount(0);
    await expect(page.getByTestId('needs-person-link')).toHaveText('2 need a person — review them');
    await nav(page, 'History');
    await expect(page.getByTestId('needs-person-link')).toHaveText('2 need a person — review them');
    await page.getByRole('link', { name: '2 need a person — review them' }).click();
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.locator('h1')).toHaveText('Needs a person');
    await expect(page.getByRole('heading', { name: 'To decide (2)' })).toBeVisible();
    // The two needs-human findings, and none of the three open ones.
    const shown = await page.getByTestId('review-card').evaluateAll((cs) => cs.map((c) => c.getAttribute('data-fingerprint')));
    expect(shown.map((s) => s!.split('|').slice(0, 2).join('|') + '|').sort()).toEqual([IMG, TITLES].sort());
    await expect(page.locator('[data-testid="review-card"][data-status="open"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('NP AC 2 and 3, guards 2 and 3: each card says what to check and where to look, with the screenshot served from the report folder', async ({ page }) => {
  const app = await loopApp();
  try {
    await open(page, app.dash, '/review');
    const img = card(page, IMG);
    // What to check: the test's condition and the finding's message.
    await expect(img.getByTestId('review-condition')).toHaveText(/\S/);
    await expect(img.getByTestId('review-message')).toHaveText(/^Image has no alt attribute/);
    await expect(img.getByTestId('review-reason')).toHaveText('Why it needs a person: still present after 3 fix attempts');
    // Where to look: the pages as routes (query hidden), opening in a new tab.
    const links = img.getByTestId('review-page');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute('href', app.url);
    await expect(links.nth(0)).toHaveAttribute('target', '_blank');
    await expect(links.nth(0)).toHaveText('/ (opens in a new tab)');
    await expect(links.nth(1)).toHaveAttribute('href', `${app.url}index.html?from=news`);
    await expect(links.nth(1)).toHaveText('/index.html?… (opens in a new tab)');
    await expect(img.getByTestId('review-selector')).toHaveText('#main > img');
    await expect(img.getByTestId('review-html')).toContainText('img/harbour.svg');
    // The likely source: the line in site/index.html that holds the image.
    const line = readFileSync(join(app.cwd, 'site', 'index.html'), 'utf8').split('\n').findIndex((l) => l.includes('img/harbour.svg')) + 1;
    expect(line).toBeGreaterThan(1);
    await expect(img.getByTestId('review-source')).toContainText([`site/index.html:${line}`]);
    // The screenshot, from the latest report's folder: it loads as a PNG.
    const shot = img.getByTestId('review-screenshot');
    await expect(shot).toBeVisible();
    const src = await shot.getAttribute('src');
    const res = await page.request.get(app.dash.origin + src);
    expect(res.status(), `GET ${src}`).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(src).toMatch(/^\/api\/reports\/latest\/screenshots\/[^/]+\.png$/);
    await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    // Not copied into the dashboard: the file is the report's own.
    expect(readdirSync(join(app.dash.dirs().report, 'screenshots'))).toContain(src!.split('/').pop());

    // A page-level finding: Whole page, its pages, no screenshot.
    const titles = card(page, TITLES);
    await expect(titles.getByTestId('whole-page')).toContainText('Whole page');
    await expect(titles.getByTestId('review-screenshot')).toHaveCount(0);
    await expect(titles.getByTestId('no-screenshot')).toHaveCount(0);
    await expect(titles.getByTestId('review-page')).toHaveText(['/ (opens in a new tab)', '/gallery.html (opens in a new tab)', '/table.html (opens in a new tab)', '/form.html (opens in a new tab)']);
    await expect(titles.getByTestId('review-reason')).toHaveText('Why it needs a person: a person must judge whether each title names its page');

    // A screenshot whose file is gone: "No screenshot", not a broken image.
    rmSync(join(app.dash.dirs().report, src!.replace(/^\/api\/reports\/latest\//, '')));
    await page.reload();
    await expect(card(page, IMG).getByTestId('no-screenshot')).toHaveText('No screenshot (the file is no longer in the report folder).');
    await expect(card(page, IMG).getByTestId('review-screenshot')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('NP AC 4, 5 and 6, guard 4: a decision is written to the ledger, shown after a reload, counted in History, and followed by the loop', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await loopApp();
  try {
    await open(page, app.dash, '/review');
    // Won't fix needs a note.
    await card(page, IMG).getByRole('button', { name: "Won't fix" }).click();
    await expect(card(page, IMG).getByTestId('decision-error')).toHaveText("Say why it won't be fixed in the note, then choose Won't fix again.");
    await expect(card(page, IMG).getByLabel(/^Note/)).toBeFocused();
    expect(app.ledger().findings[app.fp(IMG)].status).toBe('needs-human');
    // Looks fine: written to the ledger, and the card says so.
    await card(page, IMG).getByRole('button', { name: 'Looks fine' }).click();
    await expect(page.getByRole('heading', { name: 'To decide (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Decided by you (1)' })).toBeVisible();
    const decided = /^Decided by you on \d{1,2} \S+ \d{4}, \d{1,2}:\d{2}\s?(AM|PM|am|pm)? — Looks fine$/;
    await expect(card(page, IMG).getByTestId('decision-line')).toHaveText(decided);
    const e = app.ledger().findings[app.fp(IMG)];
    expect([e.status, e.decision.by, e.decision.status]).toEqual(['adequate', 'person', 'adequate']);
    // After a reload, from the ledger.
    await page.reload();
    await expect(card(page, IMG).getByTestId('decision-line')).toHaveText(decided);
    // The titles go back to the assistant, with guidance.
    const NOTE = 'Give the gallery page a title that names the gallery.';
    await card(page, TITLES).getByLabel(/^Note/).fill(NOTE);
    await card(page, TITLES).getByRole('button', { name: 'Ask the assistant to fix it' }).click();
    await expect(card(page, TITLES).getByTestId('decision-line')).toHaveText(/ — Ask the assistant to fix it$/);
    await expect(card(page, TITLES).getByTestId('decision-note')).toHaveText(`Your note: ${NOTE}`);
    const t = app.ledger().findings[app.fp(TITLES)];
    expect([t.status, t.attempts.length, t.decision.note]).toEqual(['open', 0, NOTE]);

    // History: the decision is resolved, not remaining, and counted.
    await nav(page, 'History');
    await expect(page.getByTestId('loop-summary')).toHaveText(/ · 4 remaining · 1 decided by a person$/);
    await expect(page.getByTestId('needs-person-link')).toHaveCount(0);

    // The loop follows it: the image is not given to the assistant; the titles are, with the note.
    const loop = await run(process.execPath, [BIN, 'loop', '--max-rounds', '1'], { cwd: app.cwd, env: { ...process.env, TOKEN: '', A11Y_508_HOME: app.dash.home }, timeout: 300_000 });
    const work = join(app.dash.dirs().work, 'tasks');
    const prompts = readdirSync(work).filter((f) => /^prompt-r2-fix-\d+\.md$/.test(f)).map((f) => readFileSync(join(work, f), 'utf8'));
    expect(prompts.length, loop.output).toBeGreaterThan(0);
    const block = (p: string) => JSON.parse([...p.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((b) => b.includes('"kind": "fix"'))!).finding;
    const fps = prompts.map((p) => { const f = block(p); return `${f.test}|${f.selector}|${f.message}`; });
    expect(fps, loop.output).not.toContain(app.fp(IMG));
    const titlesPrompt = prompts[fps.indexOf(app.fp(TITLES))];
    expect(titlesPrompt, loop.output).toContain(`A person reviewed this and says: ${NOTE}`);
    expect(app.ledger().findings[app.fp(IMG)].status).toBe('adequate');
  } finally {
    await app.close();
  }
});

test('NP AC 7: each card is a labelled region with real buttons and a labelled note', async ({ page }) => {
  const app = await loopApp();
  try {
    await open(page, app.dash, '/review');
    const region = page.getByRole('region', { name: /^7\.A .*Image has no alt attribute/ });
    await expect(region).toHaveCount(1);
    await expect(page.getByRole('region', { name: /^12\.B / })).toHaveCount(1);
    for (const name of ['Looks fine', "Won't fix", 'Ask the assistant to fix it']) await expect(region.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(region.getByRole('textbox', { name: /^Note/ })).toBeVisible();
    await expect(region.getByRole('img', { name: 'Screenshot of the element #main > img' })).toBeVisible();
    // By keyboard alone: the note, then Looks fine.
    await region.getByRole('textbox', { name: /^Note/ }).focus();
    await page.keyboard.press('Tab');
    await expect(region.getByRole('button', { name: 'Looks fine' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('review-status')).toHaveText(/^Recorded for 7\.A “Image has no alt attribute.*”: Looks fine\.$/);
  } finally {
    await app.close();
  }
});
