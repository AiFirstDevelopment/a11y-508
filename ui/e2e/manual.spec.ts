// Manual findings (docs/plans/manual-findings.md): fix what a tester found by hand, from their PDF,
// under the developer's approval. The app is test/fixtures/manual/app (a stand-in Angular app) in a
// throwaway git repository with a bare "origin", served from its working tree by
// test/manual-site.mjs, so a pushed commit is "deployed" at once; stale mode serves the old pages.
// The assistant is test/fake-agent.mjs: it describes each finding the tool listed from the parse
// by its page's FINDING line, and judges from the evidence the tool captured.

import { test, expect, type Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, gitRepo, go, now, open, record, removeTemp, runEvents, seen, tempDir, BIN, ROOT, type Dash } from './harness';

const FAKE = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fake-agent.mjs'))} {promptFile} {resultFile}`;
const FIXTURES = join(ROOT, 'test', 'fixtures', 'manual');
const PDF = join(FIXTURES, 'manual-findings.pdf');
const NO_FINDINGS_PDF = join(FIXTURES, 'no-findings.pdf');
const REVIEW = 'Approve the plan to start fixing, or edit an item and send it to the assistant.';
const NOT_A_PDF = 'That file is not a PDF. Choose the PDF report the tester sent.';

interface App {
  cwd: string;
  originDir: string;
  site: { base: string; setStale(on: boolean): void; setHeld(on: boolean): void; setDeep(on: boolean): void; setCrawlFails(on: boolean): void; close(): Promise<void> };
  g: (...args: string[]) => string;
  cleanup(): Promise<void>;
}

// crawlPages: how many pages the PDF run looks over before the assistant is asked (docs/plans/
// manual-crawl-first.md AC 1); the tool's default (60) unless given, 0 for a run that must not. The
// crawl's options keep that look quick on the fixture (no zoom pass, no clicking, no forms).
async function manualApp(opts: { crawlPages?: number } = {}): Promise<App> {
  const cwd = tempDir('a11y-508-manual-');
  const originDir = tempDir('a11y-508-manual-origin-');
  expect(spawnSync('git', ['init', '-q', '--bare'], { cwd: originDir }).status).toBe(0);
  cpSync(join(FIXTURES, 'app'), cwd, { recursive: true });
  const g = gitRepo(cwd);
  const m: any = await import('../../test/manual-site.mjs');
  const site = await m.startManualSite({ dir: cwd });
  writeFileSync(join(cwd, 'a11y-508.config.json'), JSON.stringify({
    url: site.base, args: ['--no-zoom', '--no-follow-clicks', '--no-forms'], agent: FAKE, source: ['src'], check: `${JSON.stringify(process.execPath)} -e 0`, branch: 'a11y-508', push: true,
    deployed: 'bundle-change', deployTimeout: 0, deployPoll: 500, deploySettle: 0, agentTimeout: 120000,
    ...(opts.crawlPages !== undefined ? { manualCrawlPages: opts.crawlPages } : {}),
  }, null, 2));
  g('add', '-A');
  g('commit', '-q', '-m', 'the app');
  g('remote', 'add', 'origin', originDir);
  return {
    cwd, originDir, site, g,
    cleanup: async () => {
      await site.close();
      removeTemp(cwd);
      removeTemp(originDir);
    },
  };
}

// The run's folder: <work>/manual/<id>/ (one per run; the newest).
function runDir(dash: Dash): string {
  const root = join(dash.dirs().work, 'manual');
  const ids = readdirSync(root).filter((d) => /^\d{8}-\d{6}(-\d+)?$/.test(d)).sort();
  return join(root, ids[ids.length - 1]);
}
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const decisions = (dir: string) => readFileSync(join(dir, 'decisions.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// The fix commits on the work branch for a finding's title.
const fixCommits = (app: App, title: string): string[] => {
  const r = spawnSync('git', ['log', '--format=%H %s', 'a11y-508', '--'], { cwd: app.cwd, encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => l.includes('a11y-508: manual <PDF p.') && l.includes(title)).map((l) => l.split(' ')[0]);
};
const filesOf = (app: App, sha: string) => app.g('show', '--name-only', '--format=', sha).split('\n').filter(Boolean);

// Fix from a test report (PDF): the system's file chooser, as a person uses it.
async function choosePdf(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('manual-pdf').click();
  await (await chooser).setFiles(file);
}
const item = (page: Page, id: string) => page.locator(`[data-testid="plan-item"][data-finding="${id}"]`);

test('manual AC1 / guard a: the PDF is chosen with a file chooser, stored, served back, and starts a journaled run that survives a reload; a non-PDF is refused in one sentence', async ({ page }) => {
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd });
  try {
    await open(page, dash);
    await expect(page.getByTestId('manual-pdf')).toHaveText('Fix from a test report (PDF)');
    await expect(page.locator('input[data-testid="manual-pdf-input"]')).toHaveAttribute('accept', 'application/pdf');
    // Guard a: a text file named .pdf is refused, with the sentence, and no run starts.
    const notes = tempDir('a11y-508-manual-notpdf-');
    const fake = join(notes, 'notes.pdf');
    writeFileSync(fake, 'These are my notes, not a PDF.\n');
    await choosePdf(page, fake);
    await expect(page.getByTestId('start-error')).toHaveText(NOT_A_PDF);
    expect((await api(dash, '/api/runs/current')).json).toBeNull();
    expect(existsSync(join(dash.dirs().work, 'manual')) && readdirSync(join(dash.dirs().work, 'manual')).length).toBeFalsy();
    await expect(go(page)).toHaveText('Start');
    // The API refuses it too, and the manual routes need the session secret.
    const raw = await fetch(`${dash.origin}/api/manual/pdf`, { method: 'POST', headers: { 'X-A11y-508-Secret': dash.secret, 'content-type': 'application/pdf' }, body: 'hello' });
    expect([raw.status, (await raw.json()).error]).toEqual([400, NOT_A_PDF]);
    expect((await fetch(`${dash.origin}/api/manual/components`)).status).toBe(401);

    // AC 1: the PDF is stored as <work>/manual/<id>/source.pdf and starts a run of kind manual.
    await choosePdf(page, PDF);
    await expect(go(page)).toHaveText('Stop', { timeout: 60_000 });
    await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.kind, { timeout: 30_000 }).toBe('manual');
    const run = (await api(dash, '/api/runs/current')).json;
    expect(run.meta.manualId).toMatch(/^\d{8}-\d{6}(-\d+)?$/);
    const dir = join(dash.dirs().work, 'manual', run.meta.manualId);
    expect(readFileSync(join(dir, 'source.pdf')).equals(readFileSync(PDF))).toBe(true);
    // Served back for every later link to source.pdf#page=N.
    const served = await fetch(`${dash.origin}/api/manual/${run.meta.manualId}/file/source.pdf`, { headers: { 'X-A11y-508-Secret': dash.secret } });
    expect([served.status, served.headers.get('content-type')]).toEqual([200, 'application/pdf']);
    expect(Buffer.from(await served.arrayBuffer()).equals(readFileSync(PDF))).toBe(true);
    // Journaled like the others: its record and events are on disk.
    expect(existsSync(join(dash.dirs().work, 'runs', `${run.id}.run.json`))).toBe(true);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 120_000 });
    // A reload reattaches it: the same run, the same state.
    await page.reload();
    await expect(now(page)).toHaveText(REVIEW, { timeout: 30_000 });
    await expect(go(page)).toHaveText('Stop');
    expect((await api(dash, '/api/runs/current')).json.id).toBe(run.id);
    await go(page).click();
    await expect(now(page)).toHaveText('Stopped.', { timeout: 30_000 });
    removeTemp(notes);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('manual AC2: a PDF that names no finding ends the run with the sentence and Choose a PDF', async ({ page }) => {
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd });
  try {
    await open(page, dash);
    await choosePdf(page, NO_FINDINGS_PDF);
    await expect(now(page)).toHaveText('The PDF names no accessibility findings the assistant could read.', { timeout: 120_000 });
    await expect(go(page)).toHaveText('Start', { timeout: 30_000 });
    await expect(page.getByTestId('manual-pdf')).toHaveText('Choose a PDF');
    expect(readJson(join(runDir(dash), 'findings.json')).findings).toEqual([]);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('manual AC2/3/4/5/7/8/9 / guards b c d: findings tied to PDF pages, checked in the deployed site, the already fixed reported, the rest planned, fixed, pushed, verified, and every decision logged', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await manualApp();
  const base = app.g('rev-parse', 'HEAD');
  // A remote with a web page (commits link to it); pushes still go to the local bare repository.
  app.g('remote', 'set-url', 'origin', 'https://github.com/example/manual-app.git');
  app.g('remote', 'set-url', '--push', 'origin', app.originDir);
  const dash = await dashboard({ cwd: app.cwd });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;

    // Guard b: every plan item links to its page of the PDF.
    await expect(item(page, 'F1').getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/file/source.pdf#page=1`);
    await expect(item(page, 'F3').getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/file/source.pdf#page=3`);
    await expect(item(page, 'F3').getByTestId('pdf-page')).toHaveText('PDF page 3');
    // Guard c: the finding the deployed site no longer has is in Already fixed, from evidence the tool captured.
    const fixedSection = page.getByTestId('already-fixed');
    await expect(fixedSection.locator('summary')).toHaveText('Already fixed in the deployed site (1)');
    const row = fixedSection.getByTestId('already-fixed-item');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('F2 Company logo has no text alternative');
    await expect(row.getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/file/source.pdf#page=2`);
    expect(readdirSync(join(dir, 'evidence', 'F2', 'before')).sort()).toEqual(['ax.json', 'elements.html', 'elements.json', 'screenshot.png', 'summary.json', 'tab-order.json']);
    // Guard d: it never enters the plan.
    await expect(item(page, 'F2')).toHaveCount(0);

    // AC 2: one finding per issue, each with its PDF page and the tester's words.
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.map((f: any) => [f.id, f.page])).toEqual([['F1', 1], ['F2', 2], ['F3', 3]]);
    expect(findings[0].quote).toBe('The magnifier button in the search bar is announced only as button.');
    // The agent's interpretation of the vague ones is logged.
    expect(decisions(dir).some((d) => d.stage === 'read' && d.finding === 'F2' && /took the home page/.test(d.decision))).toBe(true);

    // AC 3 / guard c: the tool captured evidence for every finding before judging.
    for (const f of ['F1', 'F2', 'F3']) {
      const ev = join(dir, 'evidence', f, 'before');
      for (const file of ['screenshot.png', 'ax.json', 'elements.html', 'tab-order.json']) expect(existsSync(join(ev, file)), `${f}/${file}`).toBe(true);
    }
    const tabs = readJson(join(dir, 'evidence', 'F3', 'before', 'tab-order.json'));
    expect(tabs.length).toBeLessThanOrEqual(60);
    expect(tabs.some((s: any) => s.selector === '#menu-btn' && s.role === 'button')).toBe(true);
    expect(readFileSync(join(dir, 'evidence', 'F1', 'before', 'elements.html'), 'utf8')).toContain('id="search-btn"');
    expect(readJson(join(dir, 'check.json')).results.map((r: any) => [r.finding, r.verdict])).toEqual([['F1', 'present'], ['F2', 'gone'], ['F3', 'present']]);

    // AC 4: the already-fixed row: title, the tester's words, its PDF page, the URL and time checked, why, the screenshot.
    await fixedSection.locator('summary').click();
    await expect(row.getByTestId('quote')).toHaveText('The footer logo image has no alt text.');
    await expect(row.getByTestId('pdf-page')).toHaveText('PDF page 2');
    await expect(row.getByTestId('checked')).toContainText(app.site.base);
    await expect(row.getByTestId('reason')).toContainText('the element has a name now');
    await expect.poll(() => row.getByTestId('screenshot').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    const report = readFileSync(join(dir, 'already-fixed.md'), 'utf8');
    expect(report).toContain('[PDF page 2](source.pdf#page=2)');
    expect(report).toContain('The footer logo image has no alt text.');

    // AC 5: the plan has the present findings, each with its PDF page, screenshot, fix, component, files and decisions.
    await expect(page.getByTestId('plan-item')).toHaveCount(2);
    await expect.poll(() => item(page, 'F1').getByTestId('screenshot').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    await expect(item(page, 'F1').getByTestId('plan-fix')).toHaveValue(/accessible name in SearchBarComponent/);
    await expect(item(page, 'F1').getByTestId('component-chosen')).toHaveText(/SearchBarComponent <app-search-bar> · src\/app\/search\/search-bar\.component\.ts/);
    await expect(item(page, 'F1').getByTestId('plan-files')).toHaveText('Files: src/app/search/search-bar.component.ts');
    await expect(item(page, 'F1').getByTestId('plan-decisions')).toContainText('the element is rendered by SearchBarComponent');
    await expect(item(page, 'F1').getByTestId('plan-remove')).toHaveText('Remove from plan');
    // The picker lists the repository's Angular components, and filters as one types.
    const comps = (await api(dash, '/api/manual/components')).json;
    expect(comps.kind).toBe('angular');
    expect(comps.components.map((c: any) => `${c.name} ${c.selector}`).sort()).toEqual(['FooterComponent app-footer', 'HeaderComponent app-header', 'HomeComponent app-home', 'ItemComponent app-item', 'SearchBarComponent app-search-bar']);
    await item(page, 'F3').getByTestId('component-search').fill('foot');
    await expect(item(page, 'F3').getByTestId('component-option')).toHaveText([/FooterComponent/]);
    await page.keyboard.press('Escape');
    // While it waits for approval the log is a collapsed section.
    await expect(page.getByTestId('decision-log')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('decision-log').locator('summary')).toHaveText(/^Decisions so far \(\d+\)$/);

    // AC 7: approve; each item fixed and committed on its own, pushed.
    await expect(page.getByTestId('approve-plan')).toBeEnabled();
    await page.getByTestId('approve-plan').click();
    // AC 8: verified in the deployed version; the run ends only then.
    await expect(now(page)).toHaveText('Done: 2 findings from the PDF are fixed and confirmed in the deployed site; 1 was already fixed.', { timeout: 240_000 });
    await expect(go(page)).toHaveText('Start', { timeout: 30_000 });
    const f1 = fixCommits(app, 'Search button has no accessible name');
    const f3 = fixCommits(app, 'Menu button has no accessible name');
    expect([f1.length, f3.length]).toEqual([1, 1]);
    expect(app.g('log', '-1', '--format=%s', f1[0])).toBe('a11y-508: manual <PDF p.1> Search button has no accessible name');
    expect(filesOf(app, f1[0])).toEqual(['src/app/search/search-bar.component.ts']);
    expect(filesOf(app, f3[0])).toEqual(['src/app/header/header.component.ts']);
    // Guard d: the already-fixed finding got no fix and no commit.
    expect(fixCommits(app, 'Company logo')).toEqual([]);
    expect(decisions(dir).filter((d) => d.finding === 'F2' && d.stage === 'fix')).toEqual([]);
    expect(app.g('log', '--format=%s', `${base}..a11y-508`).split('\n').filter((s) => /^a11y-508: manual /.test(s))).toHaveLength(2);
    // Pushed, with the build marker the wait looked for.
    expect(spawnSync('git', ['rev-parse', 'a11y-508'], { cwd: app.originDir, encoding: 'utf8' }).stdout.trim()).toBe(app.g('rev-parse', 'a11y-508'));
    expect(app.g('log', '-1', '--format=%s', 'a11y-508')).toMatch(/^a11y-508: build marker m1-/);
    for (const f of ['F1', 'F3']) expect(existsSync(join(dir, 'evidence', f, 'after-1', 'screenshot.png')), f).toBe(true);

    // clarity AC3 / guard c: Done shows what was done: one row per fixed item, open, each with its PDF
    // page, the deployed URL checked, its commit as a link, the verdict's reason and the screenshots
    // before and after; Already fixed below it, collapsed; the plan and the decisions stay, collapsed.
    const done = page.getByTestId('fixed-confirmed');
    await expect(done.locator('summary')).toHaveText('Fixed and confirmed in the deployed site (2)', { timeout: 30_000 });
    await expect(done).toHaveAttribute('open', '');
    const rows = done.getByTestId('fixed-item');
    await expect(rows).toHaveCount(2);
    for (const [f, pdfPage, sha] of [['F1', 1, f1[0]], ['F3', 3, f3[0]]] as const) {
      const r = done.locator(`[data-testid="fixed-item"][data-finding="${f}"]`);
      await expect(r.getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/file/source.pdf#page=${pdfPage}`);
      await expect(r.getByTestId('checked')).toContainText(app.site.base);
      await expect(r.getByTestId('fixed-commit')).toHaveAttribute('href', `https://github.com/example/manual-app/commit/${sha}`);
      await expect(r.getByTestId('fixed-commit')).toHaveText(sha.slice(0, 7));
      await expect(r.getByTestId('reason')).toHaveText('Why it counts as fixed: the element has a name in the deployed page');
      const shots = r.getByTestId('fixed-shot');
      await expect(shots).toHaveCount(2);
      await expect(shots.nth(0)).toHaveAttribute('src', `/api/manual/${id}/file/evidence/${f}/before/screenshot.png`);
      await expect(shots.nth(1)).toHaveAttribute('src', `/api/manual/${id}/file/evidence/${f}/after-1/screenshot.png`);
      for (const i of [0, 1]) await expect.poll(() => shots.nth(i).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    }
    await expect(page.getByTestId('already-fixed')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('decision-log')).toBeVisible();
    await expect(page.getByTestId('decision-log').locator('summary')).toHaveText(/^Decisions \(\d+\)$/);
    await expect(page.getByTestId('decision-log')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('plan')).not.toHaveAttribute('open', '');

    // AC 9: every decision, and decisions.md grouped by finding, linked to its PDF page.
    const all = decisions(dir);
    for (const stage of ['read', 'check', 'plan', 'fix', 'verify']) expect(all.some((d) => d.stage === stage), stage).toBe(true);
    expect(all.some((d) => d.by === 'developer' && /^approved plan version 1/.test(d.decision))).toBe(true);
    expect(all.filter((d) => d.stage === 'verify').map((d) => [d.finding, d.decision])).toEqual([['F1', 'fixed in the deployed site'], ['F3', 'fixed in the deployed site']]);
    const md = readFileSync(join(dir, 'decisions.md'), 'utf8');
    expect(md).toContain('## F1: Search button has no accessible name — [PDF page 1](source.pdf#page=1)');
    expect(md).toContain('## F2: Company logo has no text alternative — [PDF page 2](source.pdf#page=2)');
    // With a web remote, the commit is a link to its page.
    expect(md).toContain(`- [${f1[0].slice(0, 7)}](https://github.com/example/manual-app/commit/${f1[0]})`);
    expect(md).toContain('![F1 before](evidence/F1/before/screenshot.png)');
    expect(md).toContain('![F1 after, try 1](evidence/F1/after-1/screenshot.png)');
    // Show decisions opens it on the home screen.
    await page.getByTestId('show-decisions').click();
    const pane = page.getByTestId('decisions-panel');
    await expect(pane.getByTestId('decisions-group')).toHaveCount(3);
    const g1 = pane.getByTestId('decisions-group').filter({ hasText: 'F1: Search button' });
    await expect(g1.getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/file/source.pdf#page=1`);
    await expect(g1.getByTestId('decisions-commit')).toContainText(f1[0].slice(0, 7));
    await expect(g1.getByTestId('decisions-shot')).toHaveCount(2);
    await expect(g1.getByTestId('decision').first()).toContainText('read · agent: read "Search button has no accessible name" from PDF page 1');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('manual AC1/6 / guards e f g h k: the developer edits the plan with the picker, the assistant confirms each edit, Approve waits for understanding and is the only way forward, and the override is honoured', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await manualApp();
  const base = app.g('rev-parse', 'HEAD');
  const onceDir = tempDir('a11y-508-manual-once-');
  const marker = join(onceDir, 'refused');
  const env = { FAKE_MANUAL_PLAN_WRONG: '1', FAKE_MANUAL_MISUNDERSTAND_ONCE: marker };
  let dash = await dashboard({ cwd: app.cwd, env });
  const commitsSinceBase = () => app.g('rev-list', '--count', `${base}..HEAD`);
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect.poll(() => existsSync(join(dash.dirs().work, 'manual')) && readdirSync(join(dash.dirs().work, 'manual')).length > 0 && existsSync(join(runDir(dash), 'plan-v1.json')), { timeout: 180_000 }).toBe(true);
    const dir = runDir(dash);

    // Guard g: no commit without approval; the run sits in review (5 s, and across a dashboard restart).
    await page.waitForTimeout(5000);
    await expect(now(page)).toHaveText(REVIEW);
    // clarity AC1 / guard a: the instruction is said once on the page, by the sentence; the plan's buttons follow the items.
    await expect(page.getByText(REVIEW)).toHaveCount(1);
    expect(commitsSinceBase()).toBe('0');
    await expect(item(page, 'F1').getByTestId('component-chosen')).toHaveText(/^HeaderComponent/);
    const before = (await api(dash, '/api/runs/current')).json;
    const home = dash.home;
    // The dashboard ends (as Ctrl+C ends it) and comes back: the PDF run is taken up again from its
    // files and waits for approval again, still with nothing committed.
    await dash.stop();
    dash = await dashboard({ cwd: app.cwd, env: { ...env, A11Y_508_HOME: home } });
    await open(page, dash);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 60_000 });
    const after = (await api(dash, '/api/runs/current')).json;
    expect([after.kind, after.status, after.meta.manualId]).toEqual(['manual', 'running', before.meta.manualId]);
    expect(runDir(dash)).toBe(dir);
    expect(commitsSinceBase()).toBe('0');
    await expect(item(page, 'F1')).toBeVisible();

    // Guard h: only a listed component can be chosen; typed text never is.
    const picker = item(page, 'F1').getByTestId('component-search');
    await picker.fill('NotAComponent');
    await expect(item(page, 'F1').getByTestId('component-none')).toHaveText('No component matches “NotAComponent”');
    await picker.press('Enter');
    // Nothing should change, so the screen is given a moment to show a change before it is checked.
    await page.waitForTimeout(1000);
    // Enter chose nothing: what was typed is still there, unmatched, and the component is unchanged.
    await expect(picker).toHaveValue('NotAComponent');
    await expect(item(page, 'F1').getByTestId('component-none')).toBeVisible();
    await expect(item(page, 'F1').getByTestId('component-chosen')).toHaveText(/^HeaderComponent/);
    await expect(page.getByTestId('send-changes')).toHaveCount(0);
    // The override: SearchBarComponent, from the list.
    await picker.fill('search');
    await item(page, 'F1').getByTestId('component-option').filter({ hasText: 'SearchBarComponent' }).click();
    await expect(item(page, 'F1').getByTestId('component-chosen')).toHaveText(/^SearchBarComponent <app-search-bar>/);
    // An unsent edit: Send changes, and Approve plan is not enabled.
    await expect(page.getByTestId('send-changes')).toBeVisible();
    await expect(page.getByTestId('approve-plan')).toBeDisabled();
    // And F3 leaves the plan.
    await item(page, 'F3').getByTestId('plan-remove').click();
    await expect(item(page, 'F3').getByTestId('plan-removed')).toBeVisible();
    await page.getByTestId('send-changes').click();

    // Guard f: the assistant did not understand: Approve plan stays disabled, and the server refuses it.
    await expect(item(page, 'F1').getByTestId('plan-confirm')).toHaveText('The assistant did not understand: SearchBarComponent does not render the element the tester describes.', { timeout: 120_000 });
    await expect(item(page, 'F3')).toHaveCount(0);
    await expect(now(page)).toHaveText(REVIEW);
    await expect(page.getByTestId('approve-plan')).toBeDisabled();
    expect((await api(dash, '/api/manual/approve', { method: 'POST', body: {} })).status).toBe(409);
    // Edited again and sent: understood, with what it will now do.
    await item(page, 'F1').getByTestId('plan-fix').fill('Add aria-label="Search" to the magnifier button.');
    await page.getByTestId('send-changes').click();
    await expect(item(page, 'F1').getByTestId('plan-confirm')).toHaveText('The assistant understood: I will add aria-label="Search" to the magnifier button in SearchBarComponent, src/app/search/search-bar.component.ts.', { timeout: 120_000 });
    await expect(item(page, 'F1').getByTestId('plan-files')).toHaveText('Files: src/app/search/search-bar.component.ts');
    await expect(page.getByTestId('approve-plan')).toBeEnabled();
    // Every version of the plan is kept.
    for (const v of [1, 2, 3]) expect(existsSync(join(dir, `plan-v${v}.json`)), `plan-v${v}`).toBe(true);
    expect(readJson(join(dir, 'plan-v1.json')).items.map((it: any) => it.finding)).toEqual(['F1', 'F3']);
    expect(commitsSinceBase()).toBe('0');

    await page.getByTestId('approve-plan').click();
    // Guard e: the commit touches the chosen component's file, not the assistant's first choice.
    await expect.poll(() => fixCommits(app, 'Search button has no accessible name').length, { timeout: 120_000 }).toBeGreaterThan(0);
    const f1 = fixCommits(app, 'Search button has no accessible name');
    expect(filesOf(app, f1[f1.length - 1])).toEqual(['src/app/search/search-bar.component.ts']);
    await expect(now(page)).toHaveText('Done: 1 finding from the PDF is fixed and confirmed in the deployed site; 1 was already fixed.', { timeout: 240_000 });
    expect(fixCommits(app, 'Search button has no accessible name')).toHaveLength(1);
    expect(fixCommits(app, 'Menu button')).toEqual([]);
    // clarity AC3: the item the developer removed is under Left out of the plan, collapsed, with what it was.
    const left = page.getByTestId('left-out');
    await expect(left.locator('summary')).toHaveText('Left out of the plan (1)');
    await expect(left).not.toHaveAttribute('open', '');
    await expect(left.getByTestId('left-out-item')).toContainText('F3 Menu button has no accessible name');
    await expect(left.getByTestId('left-out-reason')).toContainText('Removed by you; the planned fix was: ');
    await expect(page.getByTestId('fixed-item')).toHaveCount(1);
    // Guard k: the developer's edits are in the log, before → after; the removal and the approval too.
    const md = readFileSync(join(dir, 'decisions.md'), 'utf8');
    expect(md).toMatch(/plan · developer: changed the plan item: .* In HeaderComponent \(src\/app\/header\/header\.component\.ts\)\. → .* In SearchBarComponent \(src\/app\/search\/search-bar\.component\.ts\)\./);
    expect(md).toMatch(/plan · developer: removed from the plan/);
    expect(md).toMatch(/plan · developer: approved plan version 3/);
    expect(md).toMatch(/confirm · agent: did not understand: SearchBarComponent does not render/);
  } finally {
    await dash.stop();
    await app.cleanup();
    removeTemp(onceDir);
  }
});

test('manual AC8 / guards i j: a fix that does not hold in the deployed site gets exactly one automatic retry, then a revised plan that waits for approval', async ({ page }) => {
  test.setTimeout(500_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd });
  try {
    // The deployment keeps serving the old pages (only its build marker changes).
    app.site.setStale(true);
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    const dir = runDir(dash);
    await page.getByTestId('approve-plan').click();
    // Guard i: the first verification judges the deployed page, not the commit: not fixed.
    const verifies = () => decisions(dir).filter((d) => d.stage === 'verify');
    await expect.poll(() => verifies().length, { timeout: 200_000 }).toBeGreaterThanOrEqual(2);
    expect(verifies().slice(0, 2).map((d) => [d.finding, d.decision, d.evidence])).toEqual([['F1', 'not fixed in the deployed site', 'evidence/F1/after-1'], ['F3', 'not fixed in the deployed site', 'evidence/F3/after-1']]);
    await expect(now(page)).toHaveText('2 fixes did not hold in the deployed site after two tries. Review the revised plan.', { timeout: 300_000 });
    // clarity AC1: the revised plan's sentence is said once.
    await expect(page.getByText('2 fixes did not hold in the deployed site after two tries. Review the revised plan.')).toHaveCount(1);
    // Guard j: exactly one automatic retry: two fix commits for each before the revised plan, and no third without a new approval.
    expect([fixCommits(app, 'Search button').length, fixCommits(app, 'Menu button').length]).toEqual([2, 2]);
    expect(verifies().map((d) => [d.finding, d.decision, d.evidence])).toEqual([
      ['F1', 'not fixed in the deployed site', 'evidence/F1/after-1'], ['F3', 'not fixed in the deployed site', 'evidence/F3/after-1'],
      ['F1', 'not fixed in the deployed site', 'evidence/F1/after-2'], ['F3', 'not fixed in the deployed site', 'evidence/F3/after-2'],
    ]);
    await page.waitForTimeout(5000);
    expect([fixCommits(app, 'Search button').length, fixCommits(app, 'Menu button').length]).toEqual([2, 2]);
    expect(existsSync(join(dir, 'evidence', 'F1', 'after-3'))).toBe(false);
    await expect(page.getByTestId('plan')).toContainText('The revised plan');
    await expect(item(page, 'F1').getByTestId('plan-fix')).toHaveValue(/^Try again/);
    expect(decisions(dir).some((d) => d.stage === 'replan' && d.finding === 'F1')).toBe(true);

    // The deployment serves the real pages again; the revised plan approved, the same cycle ends it.
    app.site.setStale(false);
    await page.getByTestId('approve-plan').click();
    await expect(now(page)).toHaveText('Done: 2 findings from the PDF are fixed and confirmed in the deployed site; 1 was already fixed.', { timeout: 300_000 });
    expect([fixCommits(app, 'Search button').length, fixCommits(app, 'Menu button').length]).toEqual([3, 3]);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('manual AC4: when every finding is already fixed in the deployed site, the run ends with the report open', async ({ page }) => {
  const app = await manualApp();
  // The deployed site already has the search and menu buttons named.
  for (const [f, id, label] of [['src/app/search/search-bar.component.ts', 'search-btn', 'Search'], ['src/app/header/header.component.ts', 'menu-btn', 'Menu']]) {
    const file = join(app.cwd, f);
    writeFileSync(file, readFileSync(file, 'utf8').replace(`<button id="${id}"`, `<button id="${id}" aria-label="${label}"`));
  }
  app.g('commit', '-q', '-am', 'named');
  const dash = await dashboard({ cwd: app.cwd });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText('All 3 findings in the PDF are already fixed in the deployed site.', { timeout: 180_000 });
    await expect(page.getByTestId('already-fixed')).toHaveAttribute('open', '');
    await expect(page.getByTestId('already-fixed-item')).toHaveCount(3);
    await expect(page.getByTestId('already-fixed-item').getByTestId('pdf-page')).toHaveText(['PDF page 1', 'PDF page 2', 'PDF page 3']);
    await expect(page.getByTestId('plan')).toHaveCount(0);
    expect(app.g('rev-list', '--count', 'HEAD', '^main')).toBe('0');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('manual AC8 / guard j: a dashboard restart while the fixes wait for their deployment waits again; nothing is fixed twice', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await manualApp();
  let dash = await dashboard({ cwd: app.cwd });
  try {
    app.site.setHeld(true);
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    await page.getByTestId('approve-plan').click();
    await expect(now(page)).toHaveText(/^Pushed 2 fixes to a11y-508; waiting for your deployment/, { timeout: 180_000 });
    const home = dash.home;
    await dash.stop();
    dash = await dashboard({ cwd: app.cwd, env: { A11Y_508_HOME: home } });
    await open(page, dash);
    await expect(now(page)).toHaveText(/waiting for your deployment/, { timeout: 60_000 });
    app.site.setHeld(false);
    await expect(now(page)).toHaveText('Done: 2 findings from the PDF are fixed and confirmed in the deployed site; 1 was already fixed.', { timeout: 240_000 });
    expect([fixCommits(app, 'Search button').length, fixCommits(app, 'Menu button').length]).toEqual([1, 1]);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('manual AC11: a11y-508 manual <pdf> runs the same flow from the command line; the review is driven on stdin (plan-edit.json, review, approve)', async () => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const home = tempDir('a11y-508-manual-cli-home-');
  try {
    const child = spawn(process.execPath, [BIN, 'manual', PDF, '--events'], { cwd: app.cwd, env: { ...process.env, A11Y_508_HOME: home, TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let reviews = 0;
    let dir = '';
    child.stdout.on('data', (d) => {
      out += d;
      for (const l of String(d).split('\n')) {
        let ev: any;
        try {
          ev = JSON.parse(l);
        } catch {
          continue;
        }
        if (ev.type === 'manual' && ev.stage === 'start') dir = join(home, 'repos', readdirSync(join(home, 'repos'))[0], 'work', 'manual', ev.id);
        if (ev.type === 'manual' && ev.stage === 'review') {
          reviews++;
          // First review: the developer removes F3 (plan-edit.json, then "review"); then approves.
          if (reviews === 1) {
            writeFileSync(join(dir, 'plan-edit.json'), JSON.stringify({ items: [{ finding: 'F3', remove: true }] }));
            child.stdin.write('review\n');
          } else child.stdin.write('approve\n');
        }
      }
    });
    const code = await new Promise((r) => child.on('exit', r));
    expect(code, out.slice(-3000)).toBe(0);
    const { parseEvents } = await import('../../test/event-schema.mjs');
    const { events, problems } = parseEvents(out);
    expect(problems).toEqual([]);
    expect(events.find((e: any) => e.type === 'start').kind).toBe('manual');
    expect(events.filter((e: any) => e.type === 'manual' && e.stage === 'plan').map((e: any) => e.items.map((it: any) => it.finding))).toEqual([['F1', 'F3'], ['F1']]);
    expect(events.find((e: any) => e.type === 'manual' && e.stage === 'done').message).toBe('Done: 1 finding from the PDF is fixed and confirmed in the deployed site; 1 was already fixed.');
    expect(events[events.length - 1]).toMatchObject({ type: 'done', code: 0 });
    expect([fixCommits(app, 'Search button').length, fixCommits(app, 'Menu button').length]).toEqual([1, 0]);
    // Without --events: the plan's path is printed, and approve on stdin goes on.
    app.g('checkout', '-q', 'main');
    const plain = spawn(process.execPath, [BIN, 'manual', PDF], { cwd: app.cwd, env: { ...process.env, A11Y_508_HOME: home, TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    let approved = false;
    plain.stdout.on('data', (d) => {
      text += d;
      if (!approved && /the plan is at \S+plan\.json\. .* type approve\./.test(text)) {
        approved = true;
        plain.stdin.write('approve\n');
      }
    });
    expect(await new Promise((r) => plain.on('exit', r)), text.slice(-3000)).toBe(0);
    // The search button was fixed by the first run (on the work branch the second run goes on with).
    expect(text).toContain('Done: 1 finding from the PDF is fixed and confirmed in the deployed site; 2 were already fixed.');
  } finally {
    await app.cleanup();
    removeTemp(home);
  }
});

// ---- docs/plans/manual-findings-clarity.md

test('clarity AC2 / guard b: a dashboard restart during a PDF run continues and says so from the first paint, never "Stopped"; a Stop stays Stopped.', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await manualApp();
  // The rerun starts 3 s after the relaunch (200 ms otherwise), so what the page and the API say meanwhile can be watched.
  const env = { A11Y_508_RERUN_DELAY: '3000' };
  let dash = await dashboard({ cwd: app.cwd, env });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    const quit = (await api(dash, '/api/runs/current')).json;
    const home = dash.home;
    await dash.stop();
    // The quit run's record carries rerun from the moment it was marked done, with the stage from state.json.
    const runsDir = join(dash.dirs().work, 'runs');
    expect(readJson(join(runsDir, `${quit.id}.run.json`)).rerun).toEqual({ reason: 'dashboard-restart', stage: 'review' });

    dash = await dashboard({ cwd: app.cwd, env: { ...env, A11Y_508_HOME: home } });
    // For 3 s from the relaunch: the API never returns a bare stopped PDF run, and the page never says Stopped.
    const bare: any[] = [];
    let watching = true;
    const apiWatch = (async () => {
      while (watching) {
        const r = (await api(dash, '/api/runs/current')).json;
        if (r && r.kind === 'manual' && r.status !== 'running' && !r.rerun) bare.push(r);
        await new Promise((ok) => setTimeout(ok, 100));
      }
    })();
    await open(page, dash);
    const seen: { text: string; button: string }[] = [];
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const text = ((await now(page).textContent().catch(() => '')) || '').trim();
      const button = ((await go(page).textContent().catch(() => '')) || '').trim();
      if (text) seen.push({ text, button });
      await page.waitForTimeout(100);
    }
    watching = false;
    await apiWatch;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].text).toBe('The dashboard was closed during the PDF run (at the plan review); continuing from there.');
    expect(seen.filter((s) => /Stopped/.test(s.text))).toEqual([]);
    expect(seen.filter((s) => s.button !== 'Stop')).toEqual([]);
    expect(bare).toEqual([]);
    // Then it is back at the plan review, the same PDF run.
    await expect(now(page)).toHaveText(REVIEW, { timeout: 60_000 });
    const after = (await api(dash, '/api/runs/current')).json;
    expect([after.kind, after.status, after.meta.manualId]).toEqual(['manual', 'running', quit.meta.manualId]);

    // A Stop the person pressed: "Stopped.", and a relaunch does not run it again.
    await go(page).click();
    await expect(now(page)).toHaveText('Stopped.', { timeout: 30_000 });
    const stopped = (await api(dash, '/api/runs/current')).json;
    await dash.stop();
    dash = await dashboard({ cwd: app.cwd, env: { ...env, A11Y_508_HOME: home } });
    await open(page, dash);
    await expect(now(page)).toHaveText('Stopped.', { timeout: 30_000 });
    await expect(go(page)).toHaveText('Start');
    await page.waitForTimeout(4000);
    await expect(now(page)).toHaveText('Stopped.');
    const cur = (await api(dash, '/api/runs/current')).json;
    expect([cur.id, cur.status, cur.rerun]).toEqual([stopped.id, 'done', undefined]);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('clarity AC2 (verifier fix): a rerun that cannot start is withdrawn; the page reads "Stopped." with Start and the PDF button, never stuck on Stop', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await manualApp();
  const env = { A11Y_508_RERUN_DELAY: '1000' };
  let dash = await dashboard({ cwd: app.cwd, env });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    const dir = runDir(dash);
    const home = dash.home;
    await dash.stop();
    // The run's PDF is gone, so its rerun cannot start.
    rmSync(join(dir, 'source.pdf'));
    dash = await dashboard({ cwd: app.cwd, env: { ...env, A11Y_508_HOME: home } });
    await open(page, dash);
    await expect(now(page)).toHaveText('Stopped.', { timeout: 30_000 });
    await expect(go(page)).toHaveText('Start');
    await expect(page.getByTestId('manual-pdf')).toBeVisible();
    expect((await api(dash, '/api/runs/current')).json.rerun ?? null).toBeNull();
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('clarity AC4 / guard d: a read answer with no list of findings is asked again, logged, and the run goes on to the plan', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_READ_FAIL: '1' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText("The assistant's answer had no list of findings; asking it again.", { timeout: 120_000 });
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    expect(decisions(runDir(dash)).filter((d) => d.stage === 'read' && d.by === 'tool' && d.decision === 'asked again').map((d) => d.reason)).toEqual(['the first answer could not be used: its answer had no list of findings']);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('clarity AC4 / guard e: a read that fails twice ends naming the assistant and Advanced, and the one button is Choose a PDF', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_READ_FAIL: '2' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    // The fake assistant is a custom command: its first word names it.
    await expect(now(page)).toHaveText('Node could not read the PDF (its answer had no list of findings). Choose a PDF, or pick another assistant under Advanced.', { timeout: 180_000 });
    await expect(go(page)).toHaveText('Start', { timeout: 30_000 });
    await expect(page.getByTestId('manual-pdf')).toHaveText('Choose a PDF');
    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
    await page.getByTestId('manual-pdf').click();
    expect((await chooser).isMultiple()).toBe(false);
    expect(decisions(runDir(dash)).filter((d) => d.decision === 'asked again')).toHaveLength(1);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

// ---- docs/plans/pdf-parse.md: the PDF is parsed first, and the assistant reads the parse.

const DECK = join(FIXTURES, 'deck.pdf');
const PICTURES_ONLY = join(FIXTURES, 'pictures-only.pdf');
const ENCRYPTED = join(FIXTURES, 'encrypted.pdf');
const TRUNCATED = join(FIXTURES, 'truncated.pdf');
const loaded = (img: ReturnType<Page['locator']>) => expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
// The read prompts of a run, from the tasks folder, oldest first.
const readPrompts = (dash: Dash, id: string): string[] => {
  const tasks = join(dash.dirs().work, 'tasks');
  return readdirSync(tasks).filter((f) => f.startsWith(`prompt-manual-${id}-describe-`)).sort().map((f) => readFileSync(join(tasks, f), 'utf8'));
};

// ---- docs/plans/read-from-parse.md: the tool lists the findings from the parse; the assistant only
// says what each page shows. The deck (test/fixtures/manual/make-pdf.mjs) has the real report's shape:
// 11 slides with a criterion, F2 the same element as F1 and F7 as F4 (merged), a second problem on
// page 7 (F6b): 10 findings, 8 verified fixed (F1 came back), 2 open.
const DECK_FINDINGS = ['F1', 'F3', 'F4', 'F5', 'F6', 'F6b', 'F8', 'F9', 'F10', 'F11'];
const COUNTS = '10 findings read from the PDF: 8 the tester verified fixed, 2 open.';
const SEEN_5C = 'A fixture page showing 5.C The combination of the accessible name and visible label is programmatically';
const SEEN_13A = 'A fixture page showing 13.A Color is not used as the only visual means of conveying information, indicating an';
const SEEN_13C = 'A fixture page showing 13.C Text and images of text, where color alone would fail, have sufficient contrast';
const tasksFile = (dash: Dash, name: string) => readFileSync(join(dash.dirs().work, 'tasks', name), 'utf8');
const headings = (prompt: string) => [...prompt.matchAll(/^## (F\w+) — page /gm)].map((m) => m[1]);
const fixedRow = (page: Page, id: string) => page.locator(`[data-testid="already-fixed-item"][data-finding="${id}"]`);

test('read-from-parse AC1/2/3/6/9 / guards g i: the deck: the tool lists 11 findings from the parse, the assistant describes each, merges two pairs and adds a second problem; what it saw is on every item, row and group; walked to Done', async ({ page }) => {
  test.setTimeout(500_000);
  const app = await manualApp();
  // The parse waits 3 s after its first pass, and each assistant call takes 2 s, so the sentences can be seen.
  const dash = await dashboard({ cwd: app.cwd, env: { A11Y_508_PDF_OPENED_DELAY: '3000', FAKE_AGENT_DELAY_MS: '2000' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText('Reading the PDF: 13 pages (11 with pictures).', { timeout: 60_000 });
    // AC 1: the step says how many findings the tool listed, on how many pages.
    await expect(now(page)).toHaveText('Reading the PDF: 11 findings on 13 pages; asking the assistant what each page shows.', { timeout: 60_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    // AC 1: candidates.json, beside findings.json: one per page with a criterion, the page facts exact.
    const cand = readJson(join(dir, 'candidates.json')).candidates;
    expect(cand.map((c: any) => [c.id, c.pages, c.status, c.criterion])).toEqual([
      ['F1', [2], 'fixed', '5.C'], ['F2', [3], 'fixed', '5.C'], ['F3', [4], 'fixed', '5.C'], ['F4', [5], 'fixed', '13.C'], ['F5', [6], 'fixed', '13.C'], ['F6', [7], 'fixed', '13.C'],
      ['F7', [8], 'fixed', '13.C'], ['F8', [9], 'fixed', '14.B'], ['F9', [10], 'fixed', '14.B'], ['F10', [12], 'open', '13.A'], ['F11', [13], 'open', '13.A'],
    ]);
    expect(cand[9]).toMatchObject({ page: 12, statusDate: '2026-09-28', criterionName: '1.4.1-color-meaning', wcag: '1.4.1', quote: '13.A Color is not used as the only visual means of conveying information, indicating an', picture: 'pages/page-12.png', images: ['pages/page-12-image-1.png'] });
    // AC 2: the prompt lists them as blocks, each with its picture, and points at the parse before the PDF.
    await expect.poll(() => readPrompts(dash, id).length, { timeout: 60_000 }).toBeGreaterThan(0);
    const prompt = readPrompts(dash, id)[0];
    // In batches of four (docs/plans/pictures-and-routes.md AC 2).
    expect(headings(prompt)).toEqual(['F1', 'F2', 'F3', 'F4']);
    expect(prompt).toMatch(/^## F2 — page 3 — 5\.C 1\.3\.1-programmatic-label — fixed \("Verified fixed – 9\/28\/2026"\)\nPicture of the page: \S+parsed\/pages\/page-03\.png {3}\(look at it; the callouts and arrows are only there\)$/m);
    await expect.poll(() => readPrompts(dash, id).length, { timeout: 60_000 }).toBeGreaterThan(2);
    expect(readPrompts(dash, id).flatMap(headings)).toEqual(cand.map((c: any) => c.id));
    expect(readPrompts(dash, id)[2]).toMatch(/^## F10 — page 12 — 13\.A 1\.4\.1-color-meaning — open \("Still an issue – 9\/28\/26"\)\nPicture of the page: \S+parsed\/pages\/page-12\.png {3}\(look at it; the callouts and arrows are only there\)$/m);
    expect(prompt.indexOf('parsed/report.md')).toBeLessThan(prompt.indexOf('source.pdf'));
    expect(prompt).toMatch(/The original PDF is \S+source\.pdf: open it only if the report is not enough\./);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    for (const f of ['report.md', 'manifest.json', 'pages/page-02.png', 'pages/page-02-image-1.png', 'pages/page-13.png']) expect(existsSync(join(dir, 'parsed', f)), f).toBe(true);

    // AC 3: the merged list: F2 into F1 and F7 into F4 (same criterion, same element), F6b from page 7.
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.map((f: any) => [f.id, f.pages, f.page, f.status, f.criterion])).toEqual([
      ['F1', [2, 3], 2, 'fixed', '5.C'], ['F3', [4], 4, 'fixed', '5.C'], ['F4', [5, 8], 5, 'fixed', '13.C'], ['F5', [6], 6, 'fixed', '13.C'], ['F6', [7], 7, 'fixed', '13.C'],
      ['F6b', [7], 7, 'fixed', '13.C'], ['F8', [9], 9, 'fixed', '14.B'], ['F9', [10], 10, 'fixed', '14.B'], ['F10', [12], 12, 'open', '13.A'], ['F11', [13], 13, 'open', '13.A'],
    ]);
    expect(findings.find((f: any) => f.id === 'F6b')).toMatchObject({ element: 'the search link in the header', selectors: ['header a[href="/search"]'], extraOf: 'F6' });
    expect(findings.every((f: any) => f.seen && f.located === true)).toBe(true);
    const read = decisions(dir).filter((d) => d.stage === 'read');
    expect(read.filter((d) => /^merged /.test(d.decision)).map((d) => [d.finding, d.decision])).toEqual([['F1', 'merged F2 (PDF page 3) into F1'], ['F4', 'merged F7 (PDF page 8) into F4']]);
    expect(read.some((d) => d.finding === 'F6b' && d.decision === 'a second problem on PDF page 7: the search link in the header')).toBe(true);
    expect(read.filter((d) => /^kept /.test(d.decision))).toEqual([]);
    // AC 3 / guard i: the counts sentence, counted after merging, matches findings.json.
    const counts = read.find((d) => d.finding === null && /read from the PDF/.test(d.decision));
    expect(counts.decision).toBe(COUNTS);
    expect(Number(/^(\d+) findings/.exec(counts.decision)![1])).toBe(findings.length);

    // The check: F1 came back, F3..F9 and F6b are gone, F10 and F11 are open and present.
    expect(readJson(join(dir, 'check.json')).results.map((r: any) => [r.finding, r.verdict])).toEqual([
      ['F1', 'present'], ['F3', 'gone'], ['F4', 'gone'], ['F5', 'gone'], ['F6', 'gone'], ['F6b', 'gone'], ['F8', 'gone'], ['F9', 'gone'], ['F10', 'present'], ['F11', 'present'],
    ]);
    const fixedSection = page.getByTestId('already-fixed');
    await expect(fixedSection.locator('summary')).toHaveText('Already fixed in the deployed site (7)');
    await fixedSection.locator('summary').click();
    await expect(fixedRow(page, 'F4').getByTestId('tester-verified')).toHaveText('The tester verified this fixed on 28 Sep 2026; the deployed site agrees.');
    await expect(item(page, 'F1').getByTestId('came-back')).toHaveText('Came back: the tester verified this fixed on 28 Sep 2026, but the deployed site has it again');
    await expect(item(page, 'F10').getByTestId('came-back')).toHaveCount(0);
    await expect(page.getByTestId('plan-item')).toHaveCount(3);
    await expect(page.getByTestId('not-located')).toHaveCount(0);

    // AC 6 / guard g: what the assistant saw, under the page picture, on every plan item and already-fixed row.
    await expect(item(page, 'F1').getByTestId('seen')).toHaveText(`What the assistant saw on page 2: ${SEEN_5C}`);
    await expect(item(page, 'F10').getByTestId('seen')).toHaveText(`What the assistant saw on page 12: ${SEEN_13A}`);
    await expect(fixedRow(page, 'F4').getByTestId('seen')).toHaveText(`What the assistant saw on page 5: ${SEEN_13C}`);
    await expect(fixedSection.getByTestId('seen')).toHaveCount(7);
    // A merged finding shows what the assistant saw on each of its pages; its decisions are under it.
    await expect(item(page, 'F1').getByTestId('seen-more')).toHaveText([`What the assistant saw on page 3: ${SEEN_5C}`]);
    await expect(fixedRow(page, 'F4').getByTestId('seen-more')).toHaveText([`What the assistant saw on page 8: ${SEEN_13C}`]);
    expect(decisions(dir).some((d) => d.finding === 'F4' && d.by === 'agent' && d.decision === 'took the home page for F7')).toBe(true);
    expect(decisions(dir).filter((d) => d.finding === null && d.by === 'agent')).toEqual([]);
    for (const [loc, n] of [[item(page, 'F1'), '02'], [item(page, 'F10'), '12'], [fixedRow(page, 'F4'), '05']] as const) {
      const pic = loc.getByTestId('page-picture');
      await expect(pic).toHaveAttribute('src', `/api/manual/${id}/parsed/pages/page-${n}.png`);
      await expect(pic.locator('xpath=..')).toHaveAttribute('href', `/api/manual/${id}/parsed/pages/page-${n}.png`);
      await loaded(pic);
      await expect(loc.getByTestId('pdf-page')).toHaveText(`PDF page ${Number(n)}`);
    }
    expect(readFileSync(join(dir, 'already-fixed.md'), 'utf8')).toContain('- The tester verified this fixed on 28 Sep 2026; the deployed site agrees.');
    expect(decisions(dir).filter((d) => d.stage === 'check' && d.finding === 'F1' && /^Came back: /.test(d.decision))).toHaveLength(1);
    expect(readFileSync(join(dir, 'already-fixed.md'), 'utf8')).toContain(`## F4: Footer logo text has too little contrast — [PDF page 5](source.pdf#page=5)\n\nWhat the assistant saw on page 5: ${SEEN_13C}\n`);
    // Show the parsed report: every page with its facts.
    await page.getByTestId('show-parsed').click();
    const pane = page.getByTestId('parsed-panel');
    await expect(pane.getByTestId('parsed-page')).toHaveCount(13);
    await expect(pane.getByTestId('parsed-head').first()).toHaveText("The tester's PDF, parsed: source.pdf");
    const p12 = pane.locator('[data-testid="parsed-page"][data-page="12"]');
    await expect(p12.getByTestId('parsed-fact')).toHaveText(['Section: Outstanding Issues', 'Status: open — "Still an issue – 9/28/26" (2026-09-28)', 'Criterion: 13.A 1.4.1-color-meaning (WCAG 1.4.1)']);
    await expect(p12.getByTestId('parsed-text')).toContainText('Still an issue – 9/28/26');
    await loaded(p12.getByTestId('parsed-picture'));
    await loaded(p12.getByTestId('parsed-image'));
    // A section divider is one short band with its words: no heading, facts, text or picture of them.
    const divider = pane.locator('[data-testid="parsed-page"][data-page="1"]');
    await expect(divider.getByTestId('parsed-divider')).toHaveText('Resolved Issues');
    for (const id of ['parsed-picture', 'parsed-fact', 'parsed-text']) await expect(divider.getByTestId(id)).toHaveCount(0);
    await expect(divider.locator('h3')).toHaveCount(0);
    const band = await divider.getByTestId('parsed-divider').boundingBox();
    expect(band && band.height).toBeLessThan(120);
    await expect(divider.getByTestId('parsed-divider').locator('a')).toHaveAttribute('href', `/api/manual/${id}/file/source.pdf#page=1`);
    await pane.getByTestId('parsed-close').click();

    // AC 9: walked to Done.
    await page.getByTestId('approve-plan').click();
    await expect(now(page)).toHaveText('Done: 3 findings from the PDF are fixed and confirmed in the deployed site; 7 were already fixed (the tester had verified all of them); 1 had come back.', { timeout: 300_000 });
    expect([fixCommits(app, 'Search button').length, fixCommits(app, 'Chart series').length, fixCommits(app, 'Map pins').length]).toEqual([1, 1, 1]);
    // AC 6: the Done row and the decisions pane's group say it too, and decisions.md's block starts with it.
    const done = page.locator('[data-testid="fixed-item"][data-finding="F10"]');
    await expect(done.getByTestId('seen')).toHaveText(`What the assistant saw on page 12: ${SEEN_13A}`, { timeout: 30_000 });
    await loaded(done.getByTestId('page-picture'));
    await page.getByTestId('show-decisions').click();
    const g = page.getByTestId('decisions-panel').getByTestId('decisions-group').filter({ hasText: 'F11: Map pins' });
    await expect(g.getByTestId('seen')).toHaveText(`What the assistant saw on page 13: A fixture page showing 13.A Color is not used as the only visual means of conveying information, indicating an`);
    await expect(page.getByTestId('decisions-panel').getByTestId('decisions-group')).toHaveCount(10);
    const md = readFileSync(join(dir, 'decisions.md'), 'utf8');
    expect(md).toContain(`## F1: Search button has no accessible name — [PDF page 2](source.pdf#page=2)\n\nWhat the assistant saw on page 2: ${SEEN_5C}\n\nWhat the assistant saw on page 3: ${SEEN_5C}\n`);
    expect(md).toContain(`read · tool: ${COUNTS}`);
    expect(md).toContain('check · tool: Came back: the tester verified this fixed on 28 Sep 2026, but the deployed site has it again');
    const f1 = page.locator('[data-testid="fixed-item"][data-finding="F1"]');
    await expect(f1.getByTestId('page-picture')).toHaveAttribute('src', `/api/manual/${id}/parsed/pages/page-02.png`);
    await expect(f1.getByTestId('pdf-page')).toHaveText('PDF page 2');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('read-from-parse guards a b: the assistant leaves F3 and F5 out; the tool keeps one finding per page and asks again for just those two', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_DESCRIBE_SKIP: 'F3,F5' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    const findings = readJson(join(dir, 'findings.json')).findings;
    // Guard a: the tool's list, not the answer's: every criterion page is a finding (or merged into one).
    expect(findings.map((f: any) => f.id)).toEqual(DECK_FINDINGS);
    expect(decisions(dir).find((d) => d.finding === null && /read from the PDF/.test(d.decision)).decision).toBe(COUNTS);
    // Guard b: asked again for just F3 and F5, which are then described (after the three batches of the first asking).
    expect(readdirSync(dir).filter((f) => /^agent-describe-/.test(f)).sort()).toEqual(['agent-describe-1.log', 'agent-describe-2.log', 'agent-describe-3.log', 'agent-describe-4.log']);
    const second = tasksFile(dash, `prompt-manual-${id}-describe-4.md`);
    expect(headings(second)).toEqual(['F3', 'F5']);
    expect(second).toContain('You did not answer for F3 and F5. Answer for each of them.');
    for (const f of ['F3', 'F5']) expect(findings.find((x: any) => x.id === f).seen, f).toMatch(/^A fixture page showing /);
    expect(decisions(dir).filter((d) => d.decision === 'kept without a description')).toEqual([]);
    expect(decisions(dir).filter((d) => d.decision === 'asked again').map((d) => d.reason)).toEqual(['it did not answer for F3 and F5']);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('read-from-parse guards c d: an answer for an id the tool did not issue is dropped; sameAs across different criteria is ignored, both logged', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_DESCRIBE_EXTRA: 'F1', FAKE_MANUAL_SAME_AS: 'F4:F1' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const findings = readJson(join(dir, 'findings.json')).findings;
    const all = decisions(dir);
    // Guard c: F99 was not issued: not a finding, and said so.
    expect(findings.filter((f: any) => !/^F\d+b?$/.test(f.id) || Number(/\d+/.exec(f.id)![0]) > 11).map((f: any) => f.id)).toEqual([]);
    expect(all.some((d) => d.stage === 'read' && d.by === 'tool' && d.decision === 'dropped an answer for F99')).toBe(true);
    // Guard d: F4 (13.C) said sameAs F1 (5.C): kept apart, logged.
    expect(findings.filter((f: any) => ['F1', 'F4'].includes(f.id)).map((f: any) => [f.id, f.pages])).toEqual([['F1', [2, 3]], ['F4', [5, 8]]]);
    expect(all.filter((d) => d.finding === 'F4' && /^kept /.test(d.decision)).map((d) => [d.by, d.decision, d.reason])).toEqual([['tool', 'kept F4 separate from F1', 'they are different criteria']]);
    expect(findings.map((f: any) => f.id)).toEqual(DECK_FINDINGS);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('read-from-parse AC4/5/7 / guards e f h: an element the tool cannot find goes back once and is found; a verdict left out is asked again; the Log row names the model', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const onceDir = tempDir('a11y-508-manual-stream-');
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_SELECTORS_WRONG: 'F1', FAKE_MANUAL_CHECK_SKIP: 'F2', FAKE_AGENT_STREAM_ONCE: join(onceDir, 'streamed'), FAKE_AGENT_STREAM_MS: '200' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    // Guard e: F1's selectors matched nothing; the locate gave the real ones; the second capture found it.
    expect(existsSync(join(dir, 'agent-locate-1.log'))).toBe(true);
    expect(headings(tasksFile(dash, `prompt-manual-${id}-locate-1.md`).replace(/^## (F\w+): /gm, '## $1 — page '))).toEqual(['F1']);
    expect(readJson(join(dir, 'evidence', 'F1', 'before', 'summary.json')).matched).toBeGreaterThan(0);
    await expect(item(page, 'F1').getByTestId('not-located')).toHaveCount(0);
    expect(readJson(join(dir, 'findings.json')).findings.find((f: any) => f.id === 'F1')).toMatchObject({ located: true, selectors: ['#search-btn'] });
    expect(decisions(dir).filter((d) => d.finding === 'F1' && d.stage === 'check' && d.by === 'tool').map((d) => d.decision)).toContain('found the element on /search');
    // Guard f: F2's verdict was left out, asked again, and is the assistant's.
    const f2 = decisions(dir).find((d) => d.stage === 'check' && d.finding === 'F2');
    expect([f2.by, f2.decision]).toEqual(['agent', 'already fixed in the deployed site']);
    expect(f2.reason).not.toMatch(/no verdict/);
    expect(tasksFile(dash, `prompt-manual-${id}-check-2.md`)).toContain('You did not answer for F2. Answer for each of them.');
    const calls = (await api(dash, `/api/manual/${id}/agent-calls`)).json;
    expect(calls.filter((c: any) => c.label === 'check').map((c: any) => c.n)).toEqual([1, 2]);
    // AC 7 / guard h: the Log row shows the model the stream named.
    expect(calls.find((c: any) => c.label === 'describe' && c.n === 1).model).toBe('fake-1');
    await page.goto(`${dash.origin}/diagnostics`);
    await expect(page.getByTestId('d-call-summary').filter({ hasText: ' · read · ' }).first()).toHaveText(/ · read · Node \(fake-1\) · .+ · answered$/, { timeout: 30_000 });
    await expect(page.getByTestId('d-call-summary').filter({ hasText: ' · check · ' })).toHaveCount(2);
  } finally {
    await dash.stop();
    await app.cleanup();
    removeTemp(onceDir);
  }
});

test('read-from-parse AC4 / pictures-and-routes AC7: an element still not found after the second look is kept with the line on its plan item; a page that did not load goes back once with the known routes, is not judged by the assistant, and its item says so', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_SELECTORS_WRONG: 'F1', FAKE_MANUAL_LOCATE_WRONG: 'F1', FAKE_MANUAL_ROUTE_DOWN: 'F2' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.map((f: any) => [f.id, f.located])).toEqual([['F1', false], ['F2', null], ['F3', true]]);
    // F1 went back, and F2 too: its page did not load (HTTP 404), so it is asked for a route from the known ones, once.
    const locate = tasksFile(dash, `prompt-manual-${id}-locate-1.md`);
    expect(headings(locate.replace(/^## (F\w+): /gm, '## $1 — page '))).toEqual(['F1', 'F2']);
    expect(locate).toContain(`Looked for on: ${app.site.base}gone\nThat page did not load: HTTP 404. It is not a page of the application the tool can open; pick the route from the known routes below.`);
    expect(locate).toContain(`These are the only routes to choose from.`);
    // The run looked the site over first (docs/plans/manual-crawl-first.md AC 2): the search page comes with its title and heading.
    expect(locate).toContain(`- ${app.site.base}search — "Search": Search\n`);
    expect(readdirSync(dir).filter((f) => /^agent-locate-/.test(f))).toEqual(['agent-locate-1.log']);
    // F2 is not open by the tester's account, so it is planned; the assistant never judged it: the tool did.
    // F1's element was not found: the tool does not ask the assistant about it, and nothing is judged.
    expect(readJson(join(dir, 'check.json')).results.map((r: any) => [r.finding, r.verdict])).toEqual([['F1', 'unlocated'], ['F2', 'unreachable'], ['F3', 'present']]);
    expect(decisions(dir).filter((d) => d.finding === 'F2' && d.stage === 'check' && d.by === 'tool').map((d) => d.decision)).toEqual(['could not open /gone', 'could not be checked in the deployed site']);
    expect(headings(tasksFile(dash, `prompt-manual-${id}-check-1.md`).replace(/^## (F\w+): /gm, '## $1 — page '))).toEqual(['F3']);
    expect(decisions(dir).filter((d) => d.finding === 'F1' && d.stage === 'check' && d.by === 'tool' && /^could not find/.test(d.decision)).map((d) => [d.decision, d.reason])).toEqual([['could not find the element on /search', "the assistant's selectors matched nothing twice"]]);
    await expect(item(page, 'F1').getByTestId('not-located')).toHaveText("The tool could not find this element on /search: the assistant's selectors matched nothing. Check the component before approving.");
    // F2's page did not load: its item says the tool could not look.
    await expect(item(page, 'F2').getByTestId('not-located')).toHaveText('The tool could not open /gone in the deployed site, so it could not look for this element. Check the component before approving.');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('read-from-parse AC2 (verifier fix): answers that never name an element keep every finding, undescribed; the run goes on', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_DESCRIBE_NO_ELEMENT: '1' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.map((f: any) => [f.id, f.seen, f.element])).toEqual([['F1', null, 'not described by the assistant'], ['F2', null, 'not described by the assistant'], ['F3', null, 'not described by the assistant']]);
    expect(decisions(dir).filter((d) => d.decision === 'kept without a description').map((d) => d.finding)).toEqual(['F1', 'F2', 'F3']);
    expect(decisions(dir).filter((d) => d.decision === 'could not read the PDF')).toEqual([]);
    await expect(item(page, 'F1').getByTestId('seen')).toHaveText('The assistant did not describe this page.');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('read-from-parse AC5: a confirmation and a verdict left out are asked again for just those, then the run goes on', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_CONFIRM_SKIP: 'F3', FAKE_MANUAL_VERIFY_SKIP: 'F1' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    // The developer changes F3's fix; the first confirmation leaves F3 out; the second has it.
    await item(page, 'F3').getByTestId('plan-fix').fill('Give the menu button the name Menu.');
    await page.getByTestId('send-changes').click();
    await expect(item(page, 'F3').getByTestId('plan-confirm')).toHaveText(/^The assistant understood: I will give the menu button the name Menu in HeaderComponent/, { timeout: 120_000 });
    expect(tasksFile(dash, `prompt-manual-${id}-confirm-2.md`)).toContain('You did not answer for F3. Answer for each of them.');
    await expect(now(page)).toHaveText(REVIEW, { timeout: 60_000 });
    await page.getByTestId('approve-plan').click();
    await expect(now(page)).toHaveText('Done: 2 findings from the PDF are fixed and confirmed in the deployed site; 1 was already fixed.', { timeout: 300_000 });
    expect(tasksFile(dash, `prompt-manual-${id}-verify-2.md`)).toContain('You did not answer for F1. Answer for each of them.');
    const v = decisions(dir).filter((d) => d.stage === 'verify' && d.finding).map((d) => [d.finding, d.by, d.decision]);
    expect(v).toEqual([['F1', 'agent', 'fixed in the deployed site'], ['F3', 'agent', 'fixed in the deployed site']]);
    expect(decisions(dir).filter((d) => /after two asks/.test(d.reason))).toEqual([]);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('pdf-parse AC8 / guard g: a PDF with no text is read from its pictures and reaches the plan', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  // Each assistant call takes 3 s, so the read's sentence can be seen.
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_AGENT_DELAY_MS: '3000' } });
  try {
    await open(page, dash);
    await choosePdf(page, PICTURES_ONLY);
    await expect(now(page)).toHaveText('The PDF has no text; the assistant is working from the pictures of its 2 pages.', { timeout: 120_000 });
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    const dir = runDir(dash);
    expect(readFileSync(join(dir, 'parsed', 'report.md'), 'utf8')).toContain('The PDF has no text: every page is a picture only.');
    expect(readJson(join(dir, 'findings.json')).findings.map((f: any) => [f.id, f.pages])).toEqual([['F1', [1, 2]]]);
    await expect(item(page, 'F1')).toBeVisible();
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('pdf-parse AC8 / guard h: a PDF that cannot be opened ends before any assistant call, in one sentence, with Choose a PDF', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd });
  try {
    await open(page, dash);
    for (const [file, why] of [[ENCRYPTED, 'it is protected by a password'], [TRUNCATED, 'it is damaged or incomplete']]) {
      await choosePdf(page, file);
      await expect(now(page)).toHaveText(`The PDF could not be opened: ${why}. Choose a PDF.`, { timeout: 120_000 });
      await expect(go(page)).toHaveText('Start', { timeout: 30_000 });
      await expect(page.getByTestId('manual-pdf')).toHaveText('Choose a PDF');
      const dir = runDir(dash);
      expect(readdirSync(dir).filter((f) => /^agent-/.test(f))).toEqual([]);
      expect(existsSync(join(dir, 'findings.json'))).toBe(false);
      expect(decisions(dir).map((d) => [d.stage, d.by, d.decision, d.reason])).toEqual([['parse', 'tool', 'could not open the PDF', why]]);
    }
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('assistant calls: a read that ends without an answer twice links from the home screen to what the assistant said, its prompt, and the diagnostics text', async ({ page, context }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_READ_FAIL: '2', FAKE_MANUAL_READ_SILENT: '1' } });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: dash.origin });
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText('Node could not read the PDF (it ended without an answer (exit code 0)). Choose a PDF, or pick another assistant under Advanced.', { timeout: 180_000 });
    // The sentence is followed by the way to what the assistant said.
    const link = page.getByTestId('see-what-said');
    await expect(link).toHaveText('See what Node said');
    await link.click();
    await expect(page).toHaveURL(/\/diagnostics#assistant-calls$/);
    await expect(page.locator('#assistant-calls')).toBeInViewport();
    const calls = page.getByTestId('d-call');
    await expect(calls).toHaveCount(2);
    for (const i of [0, 1]) await expect(calls.nth(i).getByTestId('d-call-summary')).toHaveText(/ · read · Node · .+ · ended without an answer \(exit code 0\)$/);
    // The failed call is open; the first, opened by hand, shows what it said, its prompt, and no answer file.
    await expect(calls.nth(1)).toHaveAttribute('open', '');
    await expect(calls.nth(1).getByTestId('d-call-said')).toContainText('I cannot open this file (read 2)');
    await calls.nth(0).getByTestId('d-call-summary').click();
    await expect(calls.nth(0).getByTestId('d-call-said')).toContainText('I cannot open this file (read 1)');
    await calls.nth(0).getByTestId('d-call-prompt').locator('summary').click();
    await expect(calls.nth(0).getByTestId('d-call-prompt')).toContainText("# Say what each page of a tester's report shows");
    await expect(calls.nth(0).getByTestId('d-call-result')).toHaveText('Its answer file: none.');
    // Copy diagnostics: each call's header line and what it said.
    await page.getByTestId('copy-diagnostics').click();
    await expect(page.getByTestId('diagnostics-copied')).toHaveText('Copied the whole page.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const id = runDir(dash).split(/[\\/]/).pop();
    for (const n of [1, 2]) {
      const d = (await api(dash, `/api/manual/${id}/agent-calls/describe/${n}`)).json;
      const at = copied.indexOf(`${JSON.stringify(d.header)}\nWhat it said:\n`);
      expect(at).toBeGreaterThan(-1);
      expect(copied.slice(at).split('\n\n')[0]).toContain(`I cannot open this file (read ${n})`);
    }
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('read retry / guard m: an answer that only echoes ("Here is the original image:", no answer file) is quoted back in the second prompt, which says it is not the task; the second answer is read', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_READ_ECHO: '1' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 180_000 });
    const dir = runDir(dash);
    const prompts = readPrompts(dash, dir.split(/[\\/]/).pop()!);
    // The first asking is three batches of four (docs/plans/pictures-and-routes.md AC 2); each echoes; the second asking quotes it back.
    expect(prompts).toHaveLength(6);
    for (const p of prompts.slice(0, 3)) expect(p).not.toContain('Your previous answer was');
    expect(prompts[3]).toMatch(/^# Say what each page of a tester's report shows\n\nYour previous answer was: .*Here is the original image:\. That is not the task\. Do not describe, return or echo the PDF or the pictures; read the report and write the JSON file at \S+result-manual-\S+-describe-4\.json\.\n/);
    expect(decisions(dir).filter((d) => d.decision === 'asked again')).toHaveLength(1);
    expect(readJson(join(dir, 'findings.json')).findings.map((f: any) => f.id)).toEqual(DECK_FINDINGS);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

// ---- docs/plans/pictures-and-routes.md: the assistant must open each page's picture (the stream
// says which files it opened), and a page that is not there is no evidence.

// The machine-readable block of a prompt (its last JSON block).
const machine = (prompt: string) => JSON.parse([...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].pop()![1]);
const OPEN_FIRST = 'For each finding: first open its picture with your file-reading tool, then answer. An answer for a page whose picture you did not open is wrong and will be sent back.';
const ROUTE_RULE = 'route: one of the known routes below, exactly as written; if none fits, give the closest and say so in decisions';
const ROUTE_PICK = 'pick the route whose title and headings match what the picture shows';
const unopenedSays = (id: string, page: number) => new RegExp(`^You answered for ${id} without opening the picture of page ${page} \\(\\S+parsed/pages/page-${String(page).padStart(2, '0')}\\.png\\)\\. Open it with your file-reading tool and look at it before answering; the callout's words and the arrows are only there\\.$`, 'm');

test('pictures-and-routes AC1/2/4 / guards a b c e j: the describe goes in batches of four; the stream says which pictures were opened; F3 and F5, answered unseen, are asked again with their pictures named; the router\'s routes are the choices and the decisions say how many', async ({ page }) => {
  test.setTimeout(300_000);
  // manualCrawlPages 0: the run does not look over the site, so the router alone names the routes.
  const app = await manualApp({ crawlPages: 0 });
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_SKIP_PICTURE: 'F3,F5' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    // Guards a b / AC 1: the stream showed each picture opened (F3 and F5 on the second call): every finding has seen its picture.
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.map((f: any) => [f.id, f.seenPicture])).toEqual(DECK_FINDINGS.map((f) => [f, true]));
    const prompts = readPrompts(dash, id);
    // Guard c: 11 candidates, at most 4 a call: three calls, then the fourth for the two answered unseen.
    expect(prompts.map(headings)).toEqual([['F1', 'F2', 'F3', 'F4'], ['F5', 'F6', 'F7', 'F8'], ['F9', 'F10', 'F11'], ['F3', 'F5']]);
    // AC 2: every describe prompt opens with the rule.
    for (const p of prompts) expect(p).toContain(`\n${OPEN_FIRST}\n`);
    // Guard b: the second asking names only F3 and F5, each with its picture, and why.
    expect(prompts[3]).toMatch(unopenedSays('F3', 4));
    expect(prompts[3]).toMatch(unopenedSays('F5', 6));
    expect(prompts[3]).not.toContain('You did not answer for');
    expect(machine(prompts[3]).unopened).toEqual(['F3', 'F5']);
    expect(decisions(dir).filter((d) => d.decision === 'asked again').map((d) => d.reason)).toEqual(['it answered for F3 and F5 without opening the pictures of pages 4 and 6']);
    expect(decisions(dir).filter((d) => /without opening the picture of page/.test(d.decision))).toEqual([]);
    expect(decisions(dir).find((d) => d.finding === null && /read from the PDF/.test(d.decision)).decision).toBe(COUNTS);
    await expect(page.getByTestId('seen-unseen')).toHaveCount(0);

    // AC 4 / guard e: no crawl has run (manualCrawlPages 0, and no round of a loop); the routes come from the fixture app's router (no :id, no **), then the start URL.
    const base = app.site.base;
    expect(existsSync(join(dir, 'crawl'))).toBe(false);
    const routes = readJson(join(dir, 'routes.json'));
    expect(routes.routes).toEqual([`${base}`, `${base}search`, `${base}reports`, `${base}gone`].map((url) => ({ url, from: 'router', title: null, headings: [] })));
    expect(prompts[0]).toContain(`## Known routes of the application\n\nThese are the only routes to choose from. ${ROUTE_RULE}. A route that comes with its title and headings is a page the tool has seen: ${ROUTE_PICK}.\n\n- ${base}\n- ${base}search\n- ${base}reports\n- ${base}gone\n`);
    expect(prompts[0]).toContain(`- ${ROUTE_RULE}.\n`);
    expect(machine(prompts[0]).routes).toEqual([`${base}`, `${base}search`, `${base}reports`, `${base}gone`]);
    // Guard j: the decisions pane says how many routes the tool knew, and from where.
    await page.getByTestId('show-decisions').click();
    await expect(page.getByTestId('decisions-panel').getByTestId('decision').filter({ hasText: 'Routes the tool knew' })).toHaveText([/read · tool: Routes the tool knew: 4 \(from the application's router\) — /]);
    await page.getByTestId('decisions-close').click();
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('pictures-and-routes AC2/3 / guard d: answers given without opening the picture of pages 5 and 12, even when asked again, are kept, logged and said so on the plan item, the already-fixed row, the Done row, the decisions pane and decisions.md', async ({ page }) => {
  test.setTimeout(500_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_SKIP_PICTURE_ALWAYS: 'F4,F10' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    // Asked again once, both in one call; no third ask.
    const prompts = readPrompts(dash, id);
    expect(prompts.map(headings)).toEqual([['F1', 'F2', 'F3', 'F4'], ['F5', 'F6', 'F7', 'F8'], ['F9', 'F10', 'F11'], ['F4', 'F10']]);
    expect(prompts[3]).toMatch(unopenedSays('F4', 5));
    expect(prompts[3]).toMatch(unopenedSays('F10', 12));
    // AC 2: kept, with seenPicture false and the tool's decision.
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.filter((f: any) => f.seenPicture !== true).map((f: any) => [f.id, f.seenPicture])).toEqual([['F4', false], ['F10', false]]);
    expect(decisions(dir).filter((d) => /without opening the picture of page/.test(d.decision)).map((d) => [d.stage, d.finding, d.by, d.decision])).toEqual([
      ['read', 'F4', 'tool', 'the assistant answered without opening the picture of page 5'], ['read', 'F10', 'tool', 'the assistant answered without opening the picture of page 12'],
    ]);
    // AC 3: the step's sentence after the read counts them.
    const sentence = `${COUNTS} The assistant did not open the pictures of 2 pages.`;
    expect(decisions(dir).find((d) => d.finding === null && /read from the PDF/.test(d.decision)).decision).toBe(sentence);
    expect((await runEvents(dash)).filter((e) => e.type === 'manual' && e.stage === 'findings').map((e) => e.message)).toEqual([sentence]);
    // Guard d / AC 3: on the plan item and the already-fixed row, the answer is said to be a guess.
    const unseen10 = `The assistant did not open the picture of page 12; what it says below is a guess from the text: ${SEEN_13A}`;
    await expect(item(page, 'F10').getByTestId('seen-unseen')).toHaveText(unseen10);
    await expect(item(page, 'F10').getByTestId('seen')).toHaveCount(0);
    await expect(item(page, 'F11').getByTestId('seen')).toHaveText(/^What the assistant saw on page 13: /);
    await page.getByTestId('already-fixed').locator('summary').click();
    await expect(fixedRow(page, 'F4').getByTestId('seen-unseen')).toHaveText(`The assistant did not open the picture of page 5; what it says below is a guess from the text: ${SEEN_13C}`);
    // Its merged page 8 was opened: that line is as before.
    await expect(fixedRow(page, 'F4').getByTestId('seen-more')).toHaveText([`What the assistant saw on page 8: ${SEEN_13C}`]);
    expect(readFileSync(join(dir, 'already-fixed.md'), 'utf8')).toContain(`## F4: Footer logo text has too little contrast — [PDF page 5](source.pdf#page=5)\n\nThe assistant did not open the picture of page 5; what it says below is a guess from the text: ${SEEN_13C}\n`);
    // Walked to Done: the Done row, the decisions pane and decisions.md say it too.
    await page.getByTestId('approve-plan').click();
    await expect(now(page)).toHaveText(/^Done: 3 findings from the PDF are fixed and confirmed in the deployed site; /, { timeout: 300_000 });
    await expect(page.locator('[data-testid="fixed-item"][data-finding="F10"]').getByTestId('seen-unseen')).toHaveText(unseen10, { timeout: 30_000 });
    await page.getByTestId('show-decisions').click();
    await expect(page.getByTestId('decisions-panel').getByTestId('decisions-group').filter({ hasText: 'F10: Chart series' }).getByTestId('seen-unseen')).toHaveText(unseen10);
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toContain(`— [PDF page 12](source.pdf#page=12)\n\n${unseen10}\n`);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('pictures-and-routes AC5/6/7 / guards f g i: a route not on the list is the start page; a 404 and the app\'s Not Found view are not loaded, keep their screenshot, and are never judged by the assistant', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_BAD_ROUTE: 'F1', FAKE_MANUAL_ROUTE_DOWN: 'F2', FAKE_MANUAL_ROUTE_NOT_FOUND: 'F3' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    const base = app.site.base;
    // Guard f / AC 5: F1's made-up route became the start page, said so; it was looked for there, never on the Not Found view.
    const locate = tasksFile(dash, `prompt-manual-${id}-locate-1.md`);
    expect(locate).toContain(`## F1: Search button has no accessible name (PDF page 1)\n\nWhat you said the page shows: A fixture page showing The magnifier button in the search bar is announced only as button.\nElement: the magnifier button in the search bar\nPicture of the PDF page: `);
    expect(locate).toMatch(new RegExp(`^Looked for on: ${base.replace(/[.]/g, '\\.')}\\nSelectors that matched nothing there: #search-btn$`, 'm'));
    expect(locate).toContain(`These are the only routes to choose from. ${ROUTE_RULE}.`);
    expect(decisions(dir).filter((d) => d.finding === 'F1' && /^took the start page/.test(d.decision)).map((d) => [d.stage, d.by, d.decision, d.reason])).toEqual([['read', 'tool', 'took the start page instead of /layout/form-panel', 'it is not a route of the application']]);
    // The locate's route is on the list: F1 is found on /search.
    expect(readJson(join(dir, 'findings.json')).findings.find((f: any) => f.id === 'F1')).toMatchObject({ located: true, url: `${base}search` });
    // Guard g / AC 6: /gone answered HTTP 404 and /reports is the app's own Not Found view: neither loaded; both kept their screenshot.
    const f2 = readJson(join(dir, 'evidence', 'F2', 'before', 'summary.json'));
    expect([f2.status, f2.loaded, f2.notFound, f2.error]).toEqual([404, false, false, 'HTTP 404']);
    const f3 = readJson(join(dir, 'evidence', 'F3', 'before', 'summary.json'));
    expect([f3.status, f3.loaded, f3.notFound, f3.error, f3.title, f3.heading]).toEqual([200, false, true, 'the application shows its Not Found page', 'Not Found', 'Page not found']);
    expect(f3.mainWords).toBeLessThan(60);
    for (const f of ['F2', 'F3']) expect(existsSync(join(dir, 'evidence', f, 'before', 'screenshot.png')), f).toBe(true);
    expect(readJson(join(dir, 'check.json')).results.map((r: any) => [r.finding, r.verdict, r.reason])).toEqual([
      ['F1', 'present', 'the element still has no name'],
      ['F2', 'unreachable', 'the tool could not open /gone (HTTP 404)'],
      ['F3', 'unreachable', 'the tool could not open /reports (the application shows its Not Found page)'],
    ]);
    // Guard i: the assistant was asked only about the finding whose page loaded.
    const check = machine(tasksFile(dash, `prompt-manual-${id}-check-1.md`));
    expect(check.findings.map((f: any) => [f.id, f.evidence.loaded])).toEqual([['F1', true]]);
    // AC 7: not verified fixed by the tester, so planned, with the line that the tool could not open the page.
    await expect(item(page, 'F3').getByTestId('not-located')).toHaveText('The tool could not open /reports in the deployed site, so it could not look for this element. Check the component before approving.');
    await expect(page.getByTestId('could-not-check')).toHaveCount(0);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('pictures-and-routes AC7 / guard h: a finding the tester verified fixed whose page shows Not Found could not be checked: neither planned nor already fixed, listed on the screen and in the report, and counted at Done', async ({ page }) => {
  test.setTimeout(500_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_ROUTE_NOT_FOUND: 'F4' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    const line = 'The tester verified this fixed on 28 Sep 2026; the tool could not open /reports (the application shows its Not Found page), so it could not confirm it.';
    const section = page.getByTestId('could-not-check');
    await expect(section.locator('summary')).toHaveText('Could not be checked (1)');
    const row = section.locator('[data-testid="unchecked-item"][data-finding="F4"]');
    await expect(row.getByTestId('unchecked-line')).toHaveText(line);
    await expect(row.getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/file/source.pdf#page=5`);
    await expect(section.getByTestId('unchecked-item')).toHaveCount(1);
    // Not planned, not already fixed, and not "came back".
    await expect(item(page, 'F4')).toHaveCount(0);
    await expect(fixedRow(page, 'F4')).toHaveCount(0);
    await expect(page.getByTestId('already-fixed').locator('summary')).toHaveText('Already fixed in the deployed site (6)');
    await expect(page.getByTestId('came-back')).toHaveCount(1);
    expect(readJson(join(dir, 'check.json')).results.find((r: any) => r.finding === 'F4')).toMatchObject({ verdict: 'unreachable', said: null });
    // The locate step asked once for a route for it.
    expect(headings(tasksFile(dash, `prompt-manual-${id}-locate-1.md`).replace(/^## (F\w+): /gm, '## $1 — page '))).toEqual(['F4']);
    const report = readFileSync(join(dir, 'already-fixed.md'), 'utf8');
    expect(report).toContain(`# Could not be checked (1)\n\n## F4: Footer logo text has too little contrast — [PDF page 5](source.pdf#page=5)\n`);
    expect(report).toContain(`- ${line}\n`);
    // Done counts it.
    await page.getByTestId('approve-plan').click();
    await expect(now(page)).toHaveText('Done: 3 findings from the PDF are fixed and confirmed in the deployed site; 6 were already fixed (the tester had verified all of them); 1 had come back; 1 could not be checked.', { timeout: 300_000 });
    await expect(section.locator('summary')).toHaveText('Could not be checked (1)');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('check verdicts: an element the assistant did not find on the page is no evidence: a tester-verified finding it called gone because the element is missing could not be checked, never already fixed', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_CHECK_NOT_FOUND: 'F4' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const section = page.getByTestId('could-not-check');
    await expect(section.locator('summary')).toHaveText('Could not be checked (1)');
    const row = section.locator('[data-testid="unchecked-item"][data-finding="F4"]');
    await expect(row.getByTestId('unchecked-line')).toContainText('The tester verified this fixed on 28 Sep 2026; the assistant did not find the element the tester describes on ');
    await expect(row.getByTestId('unchecked-line')).toContainText('(what the tool found there was something else), so it could not confirm it.');
    await expect(item(page, 'F4')).toHaveCount(0);
    await expect(fixedRow(page, 'F4')).toHaveCount(0);
    await expect(page.getByTestId('already-fixed').locator('summary')).toHaveText('Already fixed in the deployed site (6)');
    expect(readJson(join(dir, 'check.json')).results.find((r: any) => r.finding === 'F4')).toMatchObject({ verdict: 'unlocated', said: 'gone', found: false });
    expect(decisions(dir).filter((d) => d.finding === 'F4' && d.stage === 'check' && d.decision === 'already fixed in the deployed site')).toEqual([]);
    expect(readFileSync(join(dir, 'already-fixed.md'), 'utf8')).toContain('# Could not be checked (1)');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('pictures-and-routes AC6, amended: a server that answers deep links with HTTP 404 while serving the app: the real page it renders is evidence, so every finding is checked', async ({ page }) => {
  test.setTimeout(500_000);
  const app = await manualApp();
  app.site.setDeep(true);
  const dash = await dashboard({ cwd: app.cwd });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    // Nothing could-not-be-checked: the pages answered 404 but rendered, so the assistant judged each.
    await expect(page.getByTestId('could-not-check')).toHaveCount(0);
    await expect(page.getByTestId('already-fixed').locator('summary')).toHaveText('Already fixed in the deployed site (7)');
    await expect(page.getByTestId('came-back')).toHaveCount(1);
    const results = readJson(join(dir, 'check.json')).results;
    expect(results.filter((r: any) => r.verdict === 'unreachable')).toEqual([]);
    expect(results.every((r: any) => r.said === 'present' || r.said === 'gone')).toBe(true);
    expect(readJson(join(dir, 'evidence', 'F1', 'before', 'summary.json'))).toMatchObject({ status: 404, loaded: true, notFound: false, error: null });
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('pictures-and-routes review fixes: pictures opened through a read_many_files glob count as opened; a locate route not on the list is the start page; a tester-verified finding whose element was not found could not be checked: neither already fixed nor come back', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_MANUAL_PICTURE_GLOB: '1', FAKE_MANUAL_SELECTORS_WRONG: 'F1', FAKE_MANUAL_LOCATE_BAD_ROUTE: 'F1', FAKE_MANUAL_CHECK_GONE: 'F1' } });
  try {
    await open(page, dash);
    await choosePdf(page, DECK);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    const base = app.site.base;
    // The glob covered every picture: all seen, no second ask.
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.map((f: any) => [f.id, f.seenPicture])).toEqual(DECK_FINDINGS.map((f) => [f, true]));
    expect(readPrompts(dash, id).map(headings)).toEqual([['F1', 'F2', 'F3', 'F4'], ['F5', 'F6', 'F7', 'F8'], ['F9', 'F10', 'F11']]);
    expect(decisions(dir).filter((d) => d.decision === 'asked again')).toEqual([]);
    // The locate's made-up route became the start page, said so, and F1 was looked for there.
    expect(decisions(dir).filter((d) => d.finding === 'F1' && /^took the start page/.test(d.decision)).map((d) => [d.stage, d.by, d.decision, d.reason])).toEqual([['check', 'tool', 'took the start page instead of /layout/form-panel', 'it is not a route of the application']]);
    expect(findings.find((f: any) => f.id === 'F1')).toMatchObject({ url: base, located: false });
    // F1's element was not on the page: absence is no evidence, so the tester-verified F1 could not be checked —
    // not already fixed (the real failure: "the fields do not exist on the page" read as fixed), not planned, not come back.
    expect(readJson(join(dir, 'check.json')).results.find((r: any) => r.finding === 'F1')).toMatchObject({ verdict: 'unlocated', said: null });
    await expect(item(page, 'F1')).toHaveCount(0);
    await expect(fixedRow(page, 'F1')).toHaveCount(0);
    const row = page.getByTestId('could-not-check').locator('[data-testid="unchecked-item"][data-finding="F1"]');
    await expect(row.getByTestId('unchecked-line')).toHaveText(`The tester verified this fixed on 28 Sep 2026; the tool could not find the element on / (the assistant's selectors matched nothing), so it could not confirm it.`);
    expect(decisions(dir).filter((d) => d.finding === 'F1' && /^Came back: /.test(d.decision))).toEqual([]);
    expect(decisions(dir).filter((d) => d.finding === 'F1' && d.stage === 'check' && d.decision === 'already fixed in the deployed site')).toEqual([]);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

// ---- docs/plans/manual-crawl-first.md: the PDF run looks over the deployed site first, with the
// tool's own crawler, so the pages it offers are real pages with real ids, each with its title and
// headings. The fixture site links three item detail pages, /items/1..3 (all titled "Item"), from
// /search; the router names them only as items/:id. items.pdf: a finding on an item page, and the
// search button.

const ITEMS = join(FIXTURES, 'items.pdf');
const CRAWLING = /^Looking over the deployed site so the tool knows its pages( \(\d+ found so far\))?\.$/;
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// How many times a run's journal says a look over the site started.
const crawlStarts = (events: any[]) => events.filter((e) => e.type === 'manual' && e.stage === 'crawl' && e.state === 'start').length;
// Waits (polling every 100 ms) until fn() gives something, or fails after ms.
async function until<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const secretly = (dash: Dash, path: string) => fetch(`${dash.origin}${path}`, { headers: { 'X-A11y-508-Secret': dash.secret } });

test('crawl-first AC1/2/3/4/5 / guards a b c g: the run looks over the site before the assistant is asked and says so; the crawled pages, ids included, are the routes with their titles and headings, detail pages as one line; the item finding is found on its id page; the decisions pane says where the routes came from and links to the site as the tool saw it', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd });
  try {
    await open(page, dash);
    await record(page);
    await choosePdf(page, ITEMS);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    const id = dir.split(/[\\/]/).pop()!;
    const base = app.site.base;
    // Guard a / AC 1: the crawl ran into the run's own folder, after the parse and before the read, and the sentence said so meanwhile.
    expect(existsSync(join(dir, 'crawl', 'report.json'))).toBe(true);
    expect(existsSync(join(dir, 'crawl', 'report.html'))).toBe(true);
    expect((await seen(page)).some((t) => CRAWLING.test(t))).toBe(true);
    const events = await runEvents(dash);
    expect(crawlStarts(events)).toBe(1);
    const stages = events.filter((e) => e.type === 'manual').map((e) => e.stage);
    expect(stages.indexOf('crawl')).toBeGreaterThan(stages.indexOf('parsed'));
    expect(stages.indexOf('crawl')).toBeLessThan(stages.indexOf('read'));
    expect(events.find((e) => e.type === 'manual' && e.stage === 'crawl' && e.state === 'done')).toMatchObject({ audited: 5, found: 5 });
    expect(events.find((e) => e.type === 'manual' && e.stage === 'crawl' && e.state === 'start')).toMatchObject({ max: 60 });
    // AC 2 / guard b: the crawled pages are the routes, first, each with its title and headings, ids kept; then the router's two the crawl did not reach; the line counts both.
    const routes = readJson(join(dir, 'routes.json'));
    const crawled = routes.routes.filter((r: any) => r.from === 'crawl');
    expect(crawled.map((r: any) => [r.url, r.title, r.headings]).sort()).toEqual([
      [base, 'Example app', ['Welcome']],
      [`${base}items/1`, 'Item', ['Item']],
      [`${base}items/2`, 'Item', ['Item']],
      [`${base}items/3`, 'Item', ['Item']],
      [`${base}search`, 'Search', ['Search']],
    ]);
    expect(routes.routes.slice(crawled.length)).toEqual([{ url: `${base}reports`, from: 'router', title: null, headings: [] }, { url: `${base}gone`, from: 'router', title: null, headings: [] }]);
    expect(routes.line).toBe("Routes the tool knew: 7 (5 from looking over the site; 2 from the application's router)");
    // AC 2/3 / guard c: the describe prompt lists each route with its title and headings, says how to pick, and shows the three item pages as one line; the machine-readable list keeps them all.
    const prompt = readPrompts(dash, id)[0];
    expect(prompt).toContain(`## Known routes of the application\n\nThese are the only routes to choose from. ${ROUTE_RULE}. A route that comes with its title and headings is a page the tool has seen: ${ROUTE_PICK}.\n\n`);
    expect(prompt).toContain(`\n- ${base}search — "Search": Search\n`);
    expect(prompt).toContain(`\n- ${base} — "Example app": Welcome\n`);
    expect(prompt).toMatch(new RegExp(`^- ${rx(base)}items/[123] — "Item": Item \\(and 2 more like it\\)$`, 'm'));
    expect(prompt.match(new RegExp(`^- ${rx(base)}items/`, 'gm'))).toHaveLength(1);
    expect(prompt).toContain(`\n- ${base}reports\n- ${base}gone\n`);
    expect(machine(prompt).routes.filter((u: string) => u.startsWith(`${base}items/`)).sort()).toEqual([1, 2, 3].map((n) => `${base}items/${n}`));
    // AC 3/5 / guards a b: the item finding is on a crawled id page, chosen from the list and found there at the first look; the search button on /search.
    const findings = readJson(join(dir, 'findings.json')).findings;
    expect(findings.find((f: any) => f.id === 'F1')).toMatchObject({ url: expect.stringMatching(new RegExp(`^${rx(base)}items/[123]$`)), located: true, element: 'the photo on the item page' });
    expect(findings.find((f: any) => f.id === 'F2')).toMatchObject({ url: `${base}search`, located: true });
    expect(decisions(dir).filter((d) => /^took the start page/.test(d.decision))).toEqual([]);
    expect(readdirSync(dir).filter((f) => /^agent-locate-/.test(f))).toEqual([]);
    await expect(item(page, 'F1').getByTestId('not-located')).toHaveCount(0);
    await expect(page.getByTestId('plan-item')).toHaveCount(2);
    // AC 4: the decisions pane says how many routes the tool knew and from where, and links to the site as the tool saw it.
    await page.getByTestId('show-decisions').click();
    const pane = page.getByTestId('decisions-panel');
    await expect(pane.getByTestId('decision').filter({ hasText: 'Routes the tool knew' })).toHaveText([/read · tool: Routes the tool knew: 7 \(5 from looking over the site; 2 from the application's router\) — /]);
    await expect(pane.getByTestId('decisions-crawl')).toHaveText('the site as the tool saw it');
    await expect(pane.getByTestId('decisions-crawl')).toHaveAttribute('href', `/api/manual/${id}/crawl/report.html`);
    await page.getByTestId('decisions-close').click();
    // Guard g, at the server: the crawl's report is served; nothing above or beside it is.
    const html = await secretly(dash, `/api/manual/${id}/crawl/report.html`);
    expect([html.status, html.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
    expect((await secretly(dash, `/api/manual/${id}/crawl/report.json`)).status).toBe(200);
    expect((await secretly(dash, `/api/manual/${id}/crawl/..%2fsource.pdf`)).status).toBe(404);
    expect((await secretly(dash, `/api/manual/${id}/crawl/crawl.log`)).status).toBe(404);
    expect((await fetch(`${dash.origin}/api/manual/${id}/crawl/report.html`)).status).toBe(401);
    // AC 4: decisions.md (written when the run ends) carries the routes line and the link.
    await go(page).click();
    await expect(now(page)).toHaveText('Stopped.', { timeout: 30_000 });
    const md = readFileSync(join(dir, 'decisions.md'), 'utf8');
    expect(md).toContain("· read · tool: Routes the tool knew: 7 (5 from looking over the site; 2 from the application's router) — ");
    expect(md).toContain('The site as the tool saw it: [crawl/report.html](crawl/report.html)');
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('crawl-first AC1 / guard d: a dashboard restart during the read goes on without looking over the site again: one crawl report, one look in the run\'s journal, one routes decision', async ({ page }) => {
  test.setTimeout(400_000);
  const app = await manualApp();
  // Every assistant call takes 8 s, so the read is under way long enough to close the dashboard during it.
  const env = { FAKE_AGENT_DELAY_MS: '8000' };
  let dash = await dashboard({ cwd: app.cwd, env });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText('Reading the PDF: 3 findings on 3 pages; asking the assistant what each page shows.', { timeout: 120_000 });
    const dir = runDir(dash);
    const report = join(dir, 'crawl', 'report.json');
    const finishedAt = readJson(report).finishedAt;
    expect(typeof finishedAt).toBe('string');
    expect(crawlStarts(await runEvents(dash))).toBe(1);
    const home = dash.home;
    await dash.stop();
    dash = await dashboard({ cwd: app.cwd, env: { ...env, A11Y_508_HOME: home } });
    await open(page, dash);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    // The same look over the site, not a second one: the report is the one from before, the rerun's journal has no crawl, the decision is said once.
    expect(readJson(report).finishedAt).toBe(finishedAt);
    expect(readdirSync(dir).filter((f) => /^crawl/.test(f))).toEqual(['crawl']);
    expect(crawlStarts(await runEvents(dash))).toBe(0);
    expect(decisions(dir).filter((d) => /^Routes the tool knew/.test(d.decision))).toHaveLength(1);
    expect(readJson(join(dir, 'routes.json')).line).toBe("Routes the tool knew: 7 (5 from looking over the site; 2 from the application's router)");
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('crawl-first AC1 / guard d: a repository the fix loop has crawled is not looked over again: the loop\'s pages are the routes and the run has no crawl folder', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  const dash = await dashboard({ cwd: app.cwd });
  try {
    const base = app.site.base;
    // A round of the loop, in the tool's work folder for the repository: one page, with its title and headings.
    const round = join(dash.dirs().work, 'round-1');
    mkdirSync(round, { recursive: true });
    writeFileSync(join(round, 'report.json'), JSON.stringify({ finishedAt: '2026-10-18T09:00:00.000Z', summary: { pages: 1, audited: 1 }, pages: [{ url: `${base}search`, finalUrl: `${base}search`, title: 'Search', headings: ['Search'] }] }));
    await open(page, dash);
    await choosePdf(page, PDF);
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    const dir = runDir(dash);
    expect(existsSync(join(dir, 'crawl'))).toBe(false);
    expect(crawlStarts(await runEvents(dash))).toBe(0);
    const routes = readJson(join(dir, 'routes.json'));
    expect(routes.routes).toEqual([
      { url: `${base}search`, from: 'crawl', title: 'Search', headings: ['Search'] },
      { url: base, from: 'router', title: null, headings: [] },
      { url: `${base}reports`, from: 'router', title: null, headings: [] },
      { url: `${base}gone`, from: 'router', title: null, headings: [] },
    ]);
    expect(routes.line).toBe("Routes the tool knew: 4 (1 from looking over the site; 3 from the application's router)");
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

test('crawl-first AC1 / guard e: a look over the site that fails is logged as a decision and the run goes on to the plan with the routes it has', async ({ page }) => {
  test.setTimeout(300_000);
  const app = await manualApp();
  // The site is down (HTTP 500 to everything) while the tool looks it over; it is back up for the check.
  app.site.setCrawlFails(true);
  const dash = await dashboard({ cwd: app.cwd, env: { FAKE_AGENT_DELAY_MS: '4000' } });
  try {
    await open(page, dash);
    await choosePdf(page, PDF);
    // Until the failure is logged as a decision; or the run ended instead, which is the failure this guards against.
    const dir = await until(async () => {
      try {
        const d = runDir(dash);
        if (decisions(d).some((x) => x.decision === 'the site could not be looked over')) return d;
      } catch {}
      return /^Stopped/.test(((await now(page).textContent().catch(() => '')) || '').trim()) ? 'ended' : null;
    }, 150_000, 'the look over the site to fail');
    app.site.setCrawlFails(false);
    expect(dir, 'the run ended instead of going on without the crawl').not.toBe('ended');
    await expect(now(page)).toHaveText(REVIEW, { timeout: 240_000 });
    expect(decisions(dir).filter((d) => d.decision === 'the site could not be looked over').map((d) => [d.stage, d.by, d.finding, d.reason])).toEqual([['read', 'tool', null, 'no page could be read: HTTP 500']]);
    const routes = readJson(join(dir, 'routes.json'));
    expect(routes.routes.map((r: any) => r.from)).toEqual(['router', 'router', 'router', 'router']);
    expect(routes.line).toBe("Routes the tool knew: 4 (from the application's router)");
    expect((await runEvents(dash)).find((e) => e.type === 'manual' && e.stage === 'crawl' && e.state === 'failed')).toMatchObject({ reason: 'no page could be read: HTTP 500' });
    // The run went on: the findings were checked in the deployed site and planned.
    expect(readJson(join(dir, 'check.json')).results.map((r: any) => [r.finding, r.verdict])).toEqual([['F1', 'present'], ['F2', 'gone'], ['F3', 'present']]);
    await expect(page.getByTestId('plan-item')).toHaveCount(2);
    // No second look: the report that says nothing was read is kept, so a run taken up again does not try again.
    expect(existsSync(join(dir, 'crawl', 'report.json'))).toBe(true);
  } finally {
    await dash.stop();
    await app.cleanup();
  }
});

// ---- Screenshots in (docs/plans/screenshots-in.md): screenshots pasted, picked or dropped, each with a
// note, make the same run a PDF does, with "Screenshot N" where a PDF run says "PDF page N".
test.describe('screenshots', () => {
  const NOT_A_SHOT = 'That is not a screenshot: only PNG, JPEG or WebP pictures can be added, at most 40 of them, 10 MB each.';
  const NOTE_B = 'FINDING F1 | Search button has no accessible name | /search | #search-btn | the magnifier button in the search bar | The magnifier button is announced only as button.';
  const NOTE_A = 'FINDING F2 | Menu button has no accessible name | / | #menu-btn | the menu button in the header | The hamburger menu button in the header has no name.';
  const pngs = async () => (await import('../../test/fixtures/manual/png.mjs')) as any;
  // A synthetic paste on the dashboard: a DataTransfer carrying the file, as Ctrl+V / Cmd+V gives one.
  const paste = (page: Page, bytes: Buffer, name = 'image.png', type = 'image/png') => page.evaluate(({ b64, name, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { b64: bytes.toString('base64'), name, type });
  const pasteText = (page: Page, text: string) => page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  const drop = (page: Page, bytes: Buffer, name: string) => page.getByTestId('shots-drop').evaluate((el, { b64, name }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { b64: bytes.toString('base64'), name });
  async function pick(page: Page, files: string[]): Promise<void> {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('add-shots').click();
    await (await chooser).setFiles(files);
  }
  const rows = (page: Page) => page.getByTestId('shot-row');

  test('screenshots AC1 / guard a / guard c: pasted, picked and dropped screenshots are rows with a thumbnail, a note box and Remove; a non-picture is refused in one sentence; a reload keeps nothing', async ({ page }) => {
    const app = await manualApp({ crawlPages: 0 });
    const dash = await dashboard({ cwd: app.cwd });
    const files = tempDir('a11y-508-shots-ui-');
    try {
      const { pngOf } = await pngs();
      await open(page, dash);
      // Beside Choose a PDF: Add screenshots, and the drop area that says a paste works.
      await expect(page.getByTestId('add-shots')).toHaveText('Add screenshots');
      await expect(page.locator('.actions [data-testid="manual-pdf"] + [data-testid="add-shots"]')).toHaveCount(1);
      await expect(page.locator('input[data-testid="shots-input"]')).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');
      await expect(page.locator('input[data-testid="shots-input"]')).toHaveAttribute('multiple', '');
      await expect(page.getByTestId('shots-drop')).toContainText('or paste one: Ctrl+V / Cmd+V');
      await expect(rows(page)).toHaveCount(0);
      // Guard a: a paste carrying a PNG adds a row with its thumbnail and a note box.
      await paste(page, pngOf(120, 80, [200, 40, 40]));
      await expect(rows(page)).toHaveCount(1);
      const thumb = rows(page).first().getByTestId('shot-thumb');
      await expect(thumb).toHaveAttribute('data-shot', '1');
      await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(120);
      await expect(rows(page).first().getByLabel('Screenshot 1: What is wrong here')).toHaveAttribute('maxlength', '300');
      await expect(rows(page).first().getByTestId('shot-remove')).toHaveText('Remove');
      await expect(page.getByTestId('shots-fix')).toHaveText('Fix this 1 screenshot');
      // A paste that is not a picture is refused in one sentence; text typed into a note box is the box's.
      await pasteText(page, 'some words');
      await expect(page.getByTestId('shots-error')).toHaveText(NOT_A_SHOT);
      await rows(page).first().getByTestId('shot-note').fill('The chart has no text alternative.');
      // Picked: the files, in the order given.
      writeFileSync(join(files, 'second.png'), pngOf(60, 40));
      await pick(page, [join(files, 'second.png')]);
      await expect(rows(page)).toHaveCount(2);
      await expect(page.getByTestId('shots-error')).toHaveCount(0);
      // Guard c: a file named .png whose bytes are text is refused, with the sentence, and adds no row.
      writeFileSync(join(files, 'notes.png'), 'These are my notes, not a picture.\n');
      await pick(page, [join(files, 'notes.png')]);
      await expect(page.getByTestId('shots-error')).toHaveText(NOT_A_SHOT);
      await expect(rows(page)).toHaveCount(2);
      // Dropped: added too.
      await drop(page, pngOf(50, 50), 'dropped.png');
      await expect(rows(page)).toHaveCount(3);
      expect(await page.getByTestId('shot-thumb').evaluateAll((l) => l.map((e) => e.getAttribute('data-name')))).toEqual(['image.png', 'second.png', 'dropped.png']);
      await expect(page.getByTestId('shots-fix')).toHaveText('Fix these 3 screenshots');
      // Remove: the row goes, and the rest are numbered again.
      await rows(page).nth(1).getByTestId('shot-remove').click();
      await expect(rows(page)).toHaveCount(2);
      expect(await page.getByTestId('shot-thumb').evaluateAll((l) => l.map((e) => `${e.getAttribute('data-shot')} ${e.getAttribute('data-name')}`))).toEqual(['1 image.png', '2 dropped.png']);
      await expect(rows(page).first().getByTestId('shot-note')).toHaveValue('The chart has no text alternative.');
      // Guard c, at the server: text named .png is refused with the sentence, and no run starts.
      const form = new FormData();
      form.append('shot', new Blob([Buffer.from('These are my notes, not a picture.\n')], { type: 'image/png' }), 'notes.png');
      form.append('notes', JSON.stringify(['a note']));
      const raw = await fetch(`${dash.origin}/api/manual/screenshots`, { method: 'POST', headers: { 'X-A11y-508-Secret': dash.secret }, body: form });
      expect([raw.status, (await raw.json()).error]).toEqual([400, NOT_A_SHOT]);
      expect((await api(dash, '/api/runs/current')).json).toBeNull();
      expect(existsSync(join(dash.dirs().work, 'manual')) && readdirSync(join(dash.dirs().work, 'manual')).length).toBeFalsy();
      // Plain page state: a reload keeps nothing.
      await page.reload();
      await expect(page.getByTestId('add-shots')).toBeVisible();
      await expect(rows(page)).toHaveCount(0);
    } finally {
      removeTemp(files);
      await dash.stop();
      await app.cleanup();
    }
  });

  test('screenshots AC2-5 / guards b, d, e, g: Fix these 2 screenshots uploads them in order with their notes, the run reads them with no parse, and every link says Screenshot N and opens it', async ({ page }) => {
    test.setTimeout(300_000);
    const app = await manualApp({ crawlPages: 0 });
    // Each assistant call takes a moment, so the read's sentence can be seen.
    const dash = await dashboard({ cwd: app.cwd, env: { FAKE_AGENT_DELAY_MS: '1500' } });
    const files = tempDir('a11y-508-shots-run-');
    try {
      const { pngOf } = await pngs();
      const b = pngOf(200, 120, [200, 40, 40]);
      const a = pngOf(200, 120, [40, 40, 200]);
      writeFileSync(join(files, 'b.png'), b);
      writeFileSync(join(files, 'a.png'), a);
      await open(page, dash);
      await record(page);
      // Guard g: added as b.png, then a.png: b.png is Screenshot 1.
      await pick(page, [join(files, 'b.png')]);
      await expect(rows(page)).toHaveCount(1);
      await pick(page, [join(files, 'a.png')]);
      await expect(rows(page)).toHaveCount(2);
      expect(await page.getByTestId('shot-thumb').evaluateAll((l) => l.map((e) => `${e.getAttribute('data-shot')} ${e.getAttribute('data-name')}`))).toEqual(['1 b.png', '2 a.png']);
      await rows(page).nth(0).getByTestId('shot-note').fill(NOTE_B);
      await rows(page).nth(1).getByTestId('shot-note').fill(NOTE_A);
      await expect(page.getByTestId('shots-fix')).toHaveText('Fix these 2 screenshots');
      const uploaded = Date.now();
      await page.getByTestId('shots-fix').click();
      await expect(go(page)).toHaveText('Stop', { timeout: 60_000 });
      // The rows are gone once the run has them.
      await expect(rows(page)).toHaveCount(0);
      // AC 2: a run of kind manual from screenshots: its record and state.json say so; no PDF.
      await expect.poll(async () => (await api(dash, '/api/runs/current')).json?.kind, { timeout: 30_000 }).toBe('manual');
      const run = (await api(dash, '/api/runs/current')).json;
      expect(run.meta.source).toBe('screenshots');
      const id = run.meta.manualId;
      const dir = join(dash.dirs().work, 'manual', id);
      expect(existsSync(join(dir, 'source.pdf'))).toBe(false);
      expect(readFileSync(join(dir, 'shots', '01.png')).equals(b)).toBe(true);
      expect(readFileSync(join(dir, 'shots', '02.png')).equals(a)).toBe(true);
      expect(readJson(join(dir, 'notes.json')).shots.map((s: any) => [s.file, s.name, s.note])).toEqual([['shots/01.png', 'b.png', NOTE_B], ['shots/02.png', 'a.png', NOTE_A]]);
      await expect.poll(() => existsSync(join(dir, 'state.json')) && readJson(join(dir, 'state.json')).source, { timeout: 30_000 }).toBe('screenshots');
      // AC 3 / guards b and g: the parse, one page per screenshot in the order added, the note as its text.
      const md = readFileSync(join(dir, 'parsed', 'report.md'), 'utf8');
      expect(md).toContain('2 screenshots, with a note on 2 of them.');
      expect(md.split('\n## ')[1]).toBe(`Screenshot 1 of 2\nPicture of the page: pages/page-01.png\nNote from the person who took it:\n> ${NOTE_B}\n`);
      expect(md.split('\n## ')[2]).toContain(`Note from the person who took it:\n> ${NOTE_A}`);
      // AC 5: the read's sentence, and never the PDF's.
      await expect.poll(() => seen(page), { timeout: 60_000 }).toContain('Reading 2 screenshots; asking the assistant what each shows.');
      expect((await seen(page)).filter((t) => /PDF/.test(t))).toEqual([]);
      await expect(now(page)).toHaveText(REVIEW, { timeout: 120_000 });
      // Guard d: no parse stage, and the read started within 5 s of the upload.
      const events = await runEvents(dash);
      const manualEvents = events.filter((e) => e.type === 'manual');
      expect(manualEvents.filter((e) => e.stage === 'parse' || e.stage === 'parse-failed')).toEqual([]);
      const read = manualEvents.find((e) => e.stage === 'read');
      expect(read, JSON.stringify(manualEvents.map((e) => e.stage))).toBeTruthy();
      expect(Date.parse(read.at) - uploaded).toBeLessThan(5000);
      // Guard b: the candidates carry the notes as the quotes, and the describe prompt has them.
      const cands = readJson(join(dir, 'candidates.json')).candidates;
      expect(cands.map((c: any) => [c.id, c.page, c.quote, c.status, c.criterion])).toEqual([['F1', 1, NOTE_B, null, null], ['F2', 2, NOTE_A, null, null]]);
      const prompt = readFileSync(join(dash.dirs().work, 'tasks', `prompt-manual-${id}-describe-1.md`), 'utf8');
      // AC 4: the prompt knows they are screenshots.
      expect(prompt).toContain('A person took these screenshots of the application and wrote a note on each; the note is the tester\'s words, the picture is what they saw');
      expect(prompt).toContain('## F2 — screenshot 2 — (no criterion) — status unknown');
      expect(prompt).toContain(NOTE_A);
      expect(prompt).not.toContain('a report, a PDF');
      // Guard e / AC 5: the plan's links read Screenshot N and open the screenshot.
      await expect(item(page, 'F2').getByTestId('pdf-page')).toHaveText('Screenshot 2');
      await expect(item(page, 'F2').getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/parsed/pages/page-02.png`);
      await expect(item(page, 'F1').getByTestId('pdf-page')).toHaveText('Screenshot 1');
      const pic = await fetch(`${dash.origin}/api/manual/${id}/parsed/pages/page-02.png`, { headers: { 'X-A11y-508-Secret': dash.secret } });
      expect([pic.status, pic.headers.get('content-type')]).toEqual([200, 'image/png']);
      // The parsed report is "The screenshots".
      await expect(page.getByTestId('show-parsed')).toHaveText('Show the screenshots');
      await page.getByTestId('show-parsed').click();
      const pane = page.getByTestId('parsed-panel');
      await expect(pane.locator('h2')).toHaveText('The screenshots');
      await expect(pane.getByTestId('parsed-page')).toHaveCount(2);
      await expect(pane.getByTestId('parsed-page').first().locator('h3')).toHaveText('Screenshot 1 of 2');
      await expect(pane.getByTestId('parsed-text').first()).toHaveText(NOTE_B);
      await pane.getByTestId('parsed-close').click();
      // Approved: fixed, confirmed, Done; its rows and decisions say Screenshot N.
      await page.getByTestId('approve-plan').click();
      await expect(now(page)).toHaveText('Done: 2 findings from the screenshots are fixed and confirmed in the deployed site.', { timeout: 240_000 });
      const done = page.getByTestId('fixed-confirmed');
      await expect(done.locator('[data-testid="fixed-item"][data-finding="F2"]').getByTestId('pdf-page')).toHaveText('Screenshot 2');
      await expect(done.locator('[data-testid="fixed-item"][data-finding="F2"]').getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/parsed/pages/page-02.png`);
      await page.getByTestId('show-decisions').click();
      const groups = page.getByTestId('decisions-group');
      await expect(groups.nth(1).getByTestId('pdf-page')).toHaveText('Screenshot 2');
      await expect(groups.nth(1).getByTestId('pdf-page')).toHaveAttribute('href', `/api/manual/${id}/parsed/pages/page-02.png`);
      const dm = readFileSync(join(dir, 'decisions.md'), 'utf8');
      expect(dm).toContain('— [Screenshot 2](parsed/pages/page-02.png)');
      expect(dm).not.toContain('PDF page');
      expect(dm).not.toContain('source.pdf');
    } finally {
      removeTemp(files);
      await dash.stop();
      await app.cleanup();
    }
  });
});
