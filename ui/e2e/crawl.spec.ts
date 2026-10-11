// One crawl of the fixture site through the dashboard, then what the screens
// show about it. ensureCrawl() runs it once; AC 2's test runs it itself so it
// can watch the progress from the start.

import { test, expect, type Page } from '@playwright/test';
import { dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, readReport, nav, run, tempDir, TOKEN, QUICK, type Dash, type Site } from './harness';

let site: Site;
let dash: Dash;
let page: Page;
let crawled = false;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  site = await fixtureSite();
  dash = await dashboard();
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page?.close();
  await dash?.stop();
  site?.close();
});

// Records every rendered state of the crawl progress bar and the page list.
async function recordProgress(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as any;
    w.__samples = [];
    const sample = () => {
      const bar = document.getElementById('crawl-progress') as HTMLProgressElement | null;
      if (!bar) return;
      const label = document.getElementById('crawl-progress-label')?.textContent?.trim() || '';
      const rows = document.querySelectorAll('[data-testid="page-list"] tbody tr[data-url]').length;
      const s = { value: bar.hasAttribute('value') ? bar.value : null, max: bar.max, label, rows };
      const last = w.__samples[w.__samples.length - 1];
      if (!last || last.value !== s.value || last.label !== s.label || last.rows !== s.rows) w.__samples.push(s);
    };
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    sample();
  });
}

async function ensureCrawl(): Promise<void> {
  if (crawled) return;
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base, token: TOKEN, ...QUICK });
  await startFromRun(page);
  await waitFinished(page);
  crawled = true;
}

test('AC 2: the live view moves page by page and matches report.json', async () => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base, token: TOKEN, ...QUICK });
  await startFromRun(page);
  await recordProgress(page);
  await waitFinished(page);
  crawled = true;
  const report = readReport(dash.cwd);
  const samples: { value: number | null; max: number; label: string; rows: number }[] = await page.evaluate(() => (window as any).__samples);

  // The page list equals report.json, page by page.
  const rows = await page.getByTestId('page-list').locator('tbody tr[data-url]').evaluateAll((trs) =>
    trs.map((tr) => ({ url: tr.getAttribute('data-url'), v: Number(tr.children[2].textContent), r: Number(tr.children[3].textContent) }))
  );
  expect(rows.length).toBe(report.pages.length);
  for (const p of report.pages) {
    const v = p.findings.filter((f: any) => f.level === 'violation').length;
    expect(rows.find((r) => r.url === (p.finalUrl || p.url)), p.url).toEqual({ url: p.finalUrl || p.url, v, r: p.findings.length - v });
  }
  // Before the first page: indeterminate, "Starting the browser".
  expect(samples[0]).toMatchObject({ value: null, label: 'Starting the browser', rows: 0 });
  // At every rendered state the bar's value is the number of pages finished, and its label says so.
  const running = samples.filter((s) => s.value !== null && !s.label.startsWith('Finished'));
  expect(running.length).toBeGreaterThan(1);
  for (const s of running) {
    expect(s.value, JSON.stringify(s)).toBe(s.rows);
    expect(s.label).toBe(`${s.value} of ${s.max} pages found (limit 5)`);
  }
  const values = running.map((s) => s.value!);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(new Set(values).size).toBeGreaterThan(1);

  // At the end the bar reads the final counts and the result.
  const bar = page.locator('#crawl-progress');
  await expect(bar).toHaveAttribute('value', String(report.pages.length));
  await expect(page.locator('#crawl-progress-label')).toHaveText(`Finished: ${report.pages.length} of ${report.pages.length} pages found (limit 5), FAIL`);

  // The live chart's data table equals the page list's running totals.
  await page.getByRole('button', { name: /Show data table/ }).click();
  await expect(page.locator('table[data-chart="live-chart"] tbody tr')).toHaveCount(rows.length);
  const table = await page.locator('table[data-chart="live-chart"] tbody tr').evaluateAll((trs) =>
    trs.map((tr) => [...tr.children].map((c) => Number(c.textContent)))
  );
  let running2 = 0;
  expect(table.length).toBe(rows.length);
  table.forEach((cells, i) => {
    running2 += rows[i].v;
    expect(cells[0]).toBe(i + 1);
    expect(cells.slice(1).reduce((a, b) => a + b, 0)).toBe(running2);
  });
});

const tableOf = async (p: Page, chart: string) => {
  const panel = p.locator(`app-chart-panel#${chart}`);
  const toggle = panel.getByRole('button', { name: /data table/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(panel.locator('table tbody tr').first()).toBeVisible();
  return panel.locator('table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent!.trim())));
};
// The bars ngx-charts drew, as [label, value] from each bar's accessible label.
const barsOf = (p: Page, chart: string) =>
  p.locator(`app-chart-panel#${chart} svg path.bar`).evaluateAll((ps) => ps.map((b) => b.getAttribute('aria-label') || ''));

test('AC 4: the Report screen equals report.json: result line, totals, review count, and every chart table', async () => {
  await ensureCrawl();
  const report = readReport(dash.cwd);
  const s = report.summary;
  // Exit code 1 is a finding: the live screen says FAIL and shows no error notice.
  await expect(page.getByTestId('run-status')).toHaveText('Finished: FAIL');
  await expect(page.locator('[data-notice="error"]')).toHaveCount(0);

  await nav(page, 'Report');
  const failOn = report.options.failOn as string[];
  await expect(page.getByTestId('result-line')).toHaveText(`FAIL (${failOn.filter((i) => s.byImpact[i]).map((i) => `${s.byImpact[i]} ${i}`).join(', ')} violations)`);
  for (const i of ['critical', 'serious', 'moderate', 'minor']) await expect(page.locator(`[data-impact="${i}"] dd`)).toHaveText(String(s.byImpact[i]));
  await expect(page.locator('[data-impact="review"] dd')).toHaveText(String(s.reviews));

  const byImpact = await tableOf(page, 'by-impact');
  expect(byImpact).toEqual(['critical', 'serious', 'moderate', 'minor'].map((i) => [i, String(s.byImpact[i])]));
  const byTest = await tableOf(page, 'by-test');
  expect(byTest).toEqual(Object.entries(s.byTest as Record<string, any>).filter(([, c]) => c.violations).map(([t, c]) => [t, String(c.violations)]));
  const worst = await tableOf(page, 'worst-pages');
  const expected = report.pages
    .map((p: any) => ({ page: new URL(p.finalUrl || p.url).pathname, v: p.findings.filter((f: any) => f.level === 'violation').length }))
    .filter((p: any) => p.v)
    .sort((a: any, b: any) => b.v - a.v)
    .slice(0, 15);
  expect(worst.map((r) => Number(r[1]))).toEqual(expected.map((p: any) => p.v));
  expect(worst.map((r) => r[0]).sort()).toEqual(expected.map((p: any) => p.page).sort());
  // ...and each table holds the numbers its chart drew.
  for (const [chart, rows] of [['by-impact', byImpact], ['by-test', byTest], ['worst-pages', worst]] as const) {
    const bars = await barsOf(page, chart);
    const drawn = rows.filter((r) => Number(r[1]) > 0 || chart === 'by-impact');
    expect(bars.length, chart).toBe(drawn.length);
    for (const r of drawn) expect(bars.some((b) => b.startsWith(r[0] + ' ') && b.endsWith(' ' + r[1])), `${chart}: ${r.join(' ')} in ${bars.join(' | ')}`).toBe(true);
  }
});

test('AC 5: findings filter by level, impact, test, page and text; the detail panel shows selector, HTML, WCAG and screenshot', async () => {
  await ensureCrawl();
  const report = readReport(dash.cwd);
  const all = [
    ...report.pages.flatMap((p: any) => p.findings.map((f: any) => ({ ...f, page: p.finalUrl || p.url }))),
    ...report.site.findings.map((f: any) => ({ ...f, page: (f.pages || []).join(', ') || 'site-wide' })),
  ];
  await nav(page, 'Report');
  const count = page.getByTestId('finding-count');
  await expect(count).toHaveText(`${all.length} of ${all.length} findings shown`);
  const rows = page.getByTestId('finding-row');

  await page.getByLabel('Level', { exact: true }).selectOption('violation');
  await expect(count).toHaveText(`${all.filter((f) => f.level === 'violation').length} of ${all.length} findings shown`);
  await page.getByLabel('Impact', { exact: true }).selectOption('critical');
  const crit = all.filter((f) => f.level === 'violation' && f.impact === 'critical');
  await expect(count).toHaveText(`${crit.length} of ${all.length} findings shown`);
  for (const t of await rows.locator('td:nth-child(2)').allTextContents()) expect(t).toBe('critical');
  await page.getByLabel('Level', { exact: true }).selectOption('');
  await page.getByLabel('Impact', { exact: true }).selectOption('');

  await page.getByLabel('Test', { exact: true }).selectOption('7.A');
  await expect(count).toHaveText(`${all.filter((f) => f.test === '7.A').length} of ${all.length} findings shown`);
  await page.getByLabel('Test', { exact: true }).selectOption('');
  const formsUrl = report.pages.find((p: any) => /forms\.html$/.test(p.finalUrl || p.url));
  await page.getByLabel('Page', { exact: true }).selectOption(formsUrl.finalUrl || formsUrl.url);
  await expect(count).toHaveText(`${all.filter((f) => f.page === (formsUrl.finalUrl || formsUrl.url)).length} of ${all.length} findings shown`);
  await page.getByLabel('Page', { exact: true }).selectOption('');
  await page.getByLabel('Text', { exact: true }).fill('placeholder');
  const text = all.filter((f) => `${f.message} ${f.selector || ''} ${f.html || ''}`.toLowerCase().includes('placeholder'));
  expect(text.length).toBeGreaterThan(0);
  await expect(count).toHaveText(`${text.length} of ${all.length} findings shown`);
  await page.getByLabel('Text', { exact: true }).fill('');

  // A finding with a screenshot: the detail panel shows all four.
  const withShot = all.find((f) => f.screenshot && f.selector);
  await page.getByLabel('Text', { exact: true }).fill(withShot.selector);
  await rows.filter({ hasText: withShot.message }).first().getByRole('button', { name: /Details/ }).click();
  const detail = page.getByTestId('detail');
  await expect(detail.getByTestId('detail-selector')).toHaveText(withShot.selector);
  await expect(detail.getByTestId('detail-html')).toHaveText(withShot.html);
  await expect(detail.getByTestId('detail-wcag')).toHaveText(withShot.wcag);
  const img = detail.getByTestId('detail-screenshot');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
});

test('AC 10: the command on the Run screen, run in a terminal with TOKEN set, gives the same summary', async () => {
  await ensureCrawl();
  const dashboardSummary = readReport(dash.cwd).summary;
  await nav(page, 'Run');
  // The form still holds the crawl's settings; the token field was cleared.
  await expect(page.getByLabel(/^Token \(sent as/)).toHaveValue('');
  await expect(page.getByTestId('command')).toHaveText(/^TOKEN=\$TOKEN node \S+a11y-508\.mjs /);
  const command = (await page.getByTestId('command').textContent())!.trim();
  expect(command).not.toContain(TOKEN);
  // Asynchronously: the fixture site is served from this same process.
  const term = tempDir('a11y-508-term-');
  const r = await run('/bin/sh', ['-c', command], { cwd: term, env: { ...process.env, TOKEN } });
  expect(r.status, r.output).toBe(1);
  const terminalSummary = readReport(term).summary;
  expect(terminalSummary).toEqual(dashboardSummary);
});
