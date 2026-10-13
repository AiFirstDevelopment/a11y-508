// One crawl of the fixture site through the dashboard, then what the screens
// show about it. ensureCrawl() runs it once; AC 2's test runs it itself so it
// can watch the progress from the start.

import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { moreOptions, dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, readReport, nav, run, api, shellLine, exists, processList, WIN, tempDir, TOKEN, QUICK, type Dash, type Site } from './harness';

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
      const status = document.querySelector('[data-testid="crawl-status"]')?.textContent?.trim() || '';
      const s = { value: bar.hasAttribute('value') ? bar.value : null, max: bar.max, label, rows, status };
      const last = w.__samples[w.__samples.length - 1];
      if (!last || last.value !== s.value || last.label !== s.label || last.rows !== s.rows || last.status !== s.status) w.__samples.push(s);
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
  const samples: { value: number | null; max: number; label: string; rows: number; status: string }[] = await page.evaluate(() => (window as any).__samples);
  // "Starting the browser" only before the first page, never between pages.
  const starting = samples.filter((s) => s.status === 'Starting the browser');
  expect(starting.every((s) => s.rows === 0), JSON.stringify(samples.map((s) => [s.rows, s.status]))).toBe(true);
  // The counts line and the Done line agree, site-wide items included and named.
  const siteV = report.site.findings.filter((f: any) => f.level === 'violation').length;
  const siteR = report.site.findings.length - siteV;
  expect(siteV + siteR).toBeGreaterThan(0);
  const counts = `${report.summary.violations} violation${report.summary.violations === 1 ? '' : 's'}${siteV ? `, ${siteV} site-wide` : ''} · ${report.summary.reviews} to review${siteR ? `, ${siteR} site-wide` : ''}`;
  await expect(page.getByTestId('crawl-counts')).toHaveText(counts);
  await expect(page.getByTestId('crawl-status')).toHaveText(`Done: ${report.summary.audited} pages · ${counts}`);

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

// The Found column says what discovery did on each page: links, controls clicked, new URLs.
test('discovery: the Live and Report page tables show links found, controls clicked and the new URLs, from report.json', async () => {
  await ensureCrawl();
  const report = readReport(dash.cwd);
  const index = report.pages.find((p: any) => (p.finalUrl || p.url) === site.base);
  const links = index.info.links.length;
  const clicked = index.discovery.clicked;
  expect(links).toBeGreaterThan(0);
  expect(clicked).toBeGreaterThan(0);
  const text = `${links} links · ${clicked} clicked → ${index.discovery.urls.length} new`;
  await nav(page, 'Live run');
  await expect(page.getByTestId('page-list').locator(`tr[data-url="${site.base}"] [data-testid="found"]`)).toHaveText(new RegExp(`^\\s*${text}`));
  // The controls left alone because they look like actions, named on the page's row.
  const skipped = index.discovery.skipped.map((x: any) => `"${x.name}"`);
  expect(skipped.length).toBeGreaterThan(0);
  await expect(page.getByTestId('page-list').locator(`tr[data-url="${site.base}"] [data-testid="skipped-actions"]`)).toContainText(skipped[0]);
  await nav(page, 'Report');
  await expect(page.getByTestId('report-pages').locator(`tr[data-url="${site.base}"] [data-testid="found"]`)).toHaveText(new RegExp(`^\\s*${text}`));
  await expect(page.getByTestId('report-pages').locator(`tr[data-url="${site.base}"] [data-testid="skipped-actions"]`)).toContainText(skipped[0]);
  // The serial tests after this one start on the Live screen.
  await nav(page, 'Live run');
});

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

test('AC 5: on the selected page, findings filter by level, impact, test and text; the detail panel shows selector, HTML, WCAG and screenshot', async () => {
  await ensureCrawl();
  const report = readReport(dash.cwd);
  const urlOf = (p: any) => p.finalUrl || p.url;
  await nav(page, 'Report');
  const count = page.getByTestId('finding-count');
  const rows = page.getByTestId('finding-row');
  const route = (url: string) => page.getByTestId('routes').locator(`[data-testid="route"][data-url="${url}"]`);
  // Selecting a page in the route list stands where the Page filter was.
  const forms = report.pages.find((p: any) => /forms\.html$/.test(urlOf(p)));
  await route(urlOf(forms)).click();
  await expect(route(urlOf(forms))).toHaveAttribute('aria-current', 'true');
  const all = forms.findings;
  const shown = (n: number) => new RegExp(`^${n} of ${all.length} findings on /forms\\.html shown$`);
  await expect(count).toHaveText(shown(all.length));
  await expect(rows).toHaveCount(Math.min(all.length, 300));

  await page.getByLabel('Level', { exact: true }).selectOption('violation');
  await expect(count).toHaveText(shown(all.filter((f: any) => f.level === 'violation').length));
  await page.getByLabel('Impact', { exact: true }).selectOption('critical');
  const crit = all.filter((f: any) => f.level === 'violation' && f.impact === 'critical');
  await expect(count).toHaveText(shown(crit.length));
  for (const t of await rows.getByTestId('badge').allTextContents()) expect(t).toBe('critical violation');
  await page.getByLabel('Level', { exact: true }).selectOption('');
  await page.getByLabel('Impact', { exact: true }).selectOption('');

  await page.getByLabel('Test', { exact: true }).selectOption('5.A');
  await expect(count).toHaveText(shown(all.filter((f: any) => f.test === '5.A').length));
  await page.getByLabel('Test', { exact: true }).selectOption('');
  await page.getByLabel('Text', { exact: true }).fill('placeholder');
  const text = all.filter((f: any) => `${f.message} ${f.selector || ''} ${f.html || ''}`.toLowerCase().includes('placeholder'));
  expect(text.length).toBeGreaterThan(0);
  await expect(count).toHaveText(shown(text.length));
  await page.getByLabel('Text', { exact: true }).fill('');
  // Violations come first, the most serious first.
  const badges = await rows.getByTestId('badge').allTextContents();
  const weight = (b: string) => (b.endsWith('violation') ? 0 : 10) + ['critical', 'serious', 'moderate', 'minor'].findIndex((i) => b.includes(i));
  expect(badges.map(weight)).toEqual([...badges.map(weight)].sort((a, b) => a - b));

  // A finding with a screenshot: the detail panel shows all four.
  const shotPage = report.pages.find((p: any) => p.findings.some((f: any) => f.screenshot && f.selector));
  const withShot = shotPage.findings.find((f: any) => f.screenshot && f.selector);
  await route(urlOf(shotPage)).click();
  await page.getByLabel('Text', { exact: true }).fill(withShot.selector);
  await rows.filter({ hasText: withShot.message }).first().getByRole('button', { name: /Details/ }).click();
  const detail = page.getByTestId('detail');
  await expect(detail.getByTestId('detail-selector')).toHaveText(withShot.selector);
  await expect(detail.getByTestId('detail-html')).toHaveText(withShot.html);
  await expect(detail.getByTestId('detail-wcag')).toHaveText(withShot.wcag);
  const img = detail.getByTestId('detail-screenshot');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  await page.getByLabel('Text', { exact: true }).fill('');
});

test('report routes: each audited page is listed once, worst first; selecting the second shows only its findings', async () => {
  await ensureCrawl();
  const report = readReport(dash.cwd);
  const urlOf = (p: any) => p.finalUrl || p.url;
  const audited = [...new Set(report.pages.filter((p: any) => !p.error && !p.skipped).map(urlOf))];
  // A fresh Report screen (the previous test left a page selected).
  await nav(page, 'Live run');
  await nav(page, 'Report');
  const list = page.getByTestId('routes').locator('[data-testid="route"]:not([data-url="site-wide"])');
  await expect(list).toHaveCount(audited.length);
  const urls = await list.evaluateAll((bs) => bs.map((b) => b.getAttribute('data-url')));
  expect([...urls].sort()).toEqual([...audited].sort());
  expect(new Set(urls).size).toBe(urls.length);
  // Worst first, and selected by default.
  await expect(list.first()).toHaveAttribute('aria-current', 'true');
  const findingsOf = (url: string) => report.pages.find((p: any) => urlOf(p) === url).findings.map((f: any) => f.message);
  const [first, second] = urls as string[];
  const onlySecond = findingsOf(second).find((m: string) => !findingsOf(first).includes(m));
  const onlyFirst = findingsOf(first).find((m: string) => !findingsOf(second).includes(m));
  expect(onlySecond && onlyFirst, 'each of the two pages has a finding of its own').toBeTruthy();
  await list.nth(1).click();
  await expect(list.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(list.first()).not.toHaveAttribute('aria-current', 'true');
  const rows = page.getByTestId('finding-row');
  await expect(rows.filter({ hasText: onlySecond })).not.toHaveCount(0);
  await expect(rows.filter({ hasText: onlyFirst })).toHaveCount(0);
  // No Page column: the route is the list's, not each row's.
  await expect(page.getByTestId('findings').locator('thead th')).toHaveText(['Kind', 'Test', 'Message', 'Details']);
});

test('AC 10: the command on the Run screen, run in a terminal with TOKEN set, gives the same summary', async () => {
  await ensureCrawl();
  const dashboardSummary = readReport(dash.cwd).summary;
  await nav(page, 'Run');
  await moreOptions(page);
  // The form still holds the crawl's settings; the token field was cleared.
  await expect(page.getByLabel(/^Token \(sent as/)).toHaveValue('');
  // The path is quoted when it holds a backslash (Windows, Git Bash syntax).
  await expect(page.getByTestId('command')).toHaveText(/^TOKEN=\$TOKEN node '?\S+a11y-508\.mjs'? /);
  const command = (await page.getByTestId('command').textContent())!.trim();
  expect(command).not.toContain(TOKEN);
  // Asynchronously: the fixture site is served from this same process.
  const term = tempDir('a11y-508-term-');
  // In the dashboard's shell: sh here, Git Bash on Windows.
  const [file, args, extra] = shellLine(command, (await api(dash, '/api/env')).json.shell);
  const r = await run(file, args, { cwd: term, env: { ...process.env, ...extra, TOKEN } });
  // If the shell returned early, say whether the CLI went on without it.
  let diag = '';
  if (r.status !== 1 && WIN) {
    await new Promise((ok) => setTimeout(ok, 30_000));
    diag = `\nreport written later: ${exists(join(term, 'a11y-508-report', 'report.json'))}\nCLI processes: ${(processList() as string).split(/\r?\n/).filter((l) => /a11y-508\.mjs|bash/.test(l)).join('\n')}`;
  }
  expect(r.status, r.output + diag).toBe(1);
  const terminalSummary = readReport(term).summary;
  expect(terminalSummary).toEqual(dashboardSummary);
});

// docs/plans/checks-foundations.md AC 10: the page event carries modalOnLoad and the live list says so.
test('checks-foundations AC 10: the live page list notes a modal dialog open on load, closed by Escape or not', async () => {
  await open(page, dash, '/run');
  await fillRun(page, { url: site.base + 'checks-modal-escape.html', token: TOKEN, ...QUICK, maxPages: 2 });
  await startFromRun(page);
  await waitFinished(page);
  const note = (path: string) => page.getByTestId('page-list').locator(`tr[data-url$="${path}"] [data-testid="modal-note"]`);
  await expect(note('/checks-modal-escape.html')).toHaveText('A modal dialog (Cookie preferences) was open on load; it closed with Escape and the page behind it was audited.');
  await expect(note('/checks-modal-stuck.html')).toHaveText('A modal dialog (Consent required) was open on load and did not close with Escape; the page behind it was not audited.');
});
