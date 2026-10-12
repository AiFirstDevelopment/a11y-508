// AC 20: a11y-508 audits the dashboard itself, through the tool's own auth
// features, and finds no critical or serious violations on any screen, with the
// WCAG 2.2 profile on (checks-beyond-508 AC 13).
// Folder picker AC 12: the picker's dialog is opened and checked on each one.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, dashboard, fixtureSite, run, BIN, TOKEN, SECRET_HEADER, tempDir } from './harness';

const ROUTES = ['/run', '/live', '/report', '/troubleshoot', '/sign-in', '/fix-loop', '/history'];

test('AC 20: every screen is audited and none has a critical or serious violation', async () => {
  test.setTimeout(540_000);
  const site = await fixtureSite();
  const dash = await dashboard();
  try {
    // Content for every screen: a crawl, then a dry-run loop.
    // Each phase is bounded and says which one ran long, with its output.
    const t0 = Date.now();
    const phase = (name: string) => console.log(`self-audit: ${name} at ${Math.round((Date.now() - t0) / 1000)}s`);
    const wait = async (name: string) => {
      for (let i = 0; i < 150; i++) {
        const r = await api(dash, '/api/runs/current');
        if (r.json && r.json.status === 'done') return phase(`${name} done`);
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      // Not the event stream: it stays open while the run is going.
      throw new Error(`the ${name} run did not finish in 150s: ${JSON.stringify((await api(dash, '/api/runs/current')).json).slice(0, 2000)}`);
    };
    expect((await api(dash, '/api/runs', { method: 'POST', body: { kind: 'crawl', url: site.base, options: { 'max-pages': '3', 'no-zoom': true, 'max-screenshots': '2' }, auth: { mode: 'token', token: TOKEN } } })).status).toBe(202);
    await wait('crawl');
    writeFileSync(join(dash.cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base + 'about.html', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'] }));
    expect((await api(dash, '/api/runs', { method: 'POST', body: { kind: 'dry-run', auth: { mode: 'token' } } })).status).toBe(202);
    await wait('dry-run');

    // Every screen asks for the environment; how long its first detection takes on this host.
    const env = await api(dash, '/api/env');
    phase(`environment detected (${env.json.shell.name}; ${env.json.presets.filter((p: any) => p.found).map((p: any) => p.name).join(', ') || 'no assistants'})`);

    const out = tempDir('a11y-508-self-');
    // Asynchronously: this process also serves the fixture site, which a blocking spawn would freeze.
    const r = await run(
      process.execPath,
      // With the WCAG 2.2 profile on (docs/plans/checks-beyond-508.md): the dashboard passes its own rules beyond Section 508 too.
      [BIN, dash.origin + '/run', '--token-header', SECRET_HEADER, '--token-storage', 'a11y508.secret', '--no-follow-clicks', '--max-pages', '30', '--wcag', '2.2', '--out', out, '--json'],
      // In CI, the core's debug log, so a page that never finishes is named.
      { env: { ...process.env, TOKEN: dash.secret, ...(process.env.CI ? { A11Y_508_DEBUG: '1' } : {}) }, timeout: 200_000 }
    );
    phase(`self crawl exit ${r.status}`);
    if (!existsSync(join(out, 'report.json'))) throw new Error(`the self crawl wrote no report (exit ${r.status}):\n${r.output.slice(-6000)}\n--- dashboard ---\n${dash.output().slice(-3000)}`);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    const paths = report.pages.map((p: any) => new URL(p.finalUrl || p.url).pathname);
    for (const route of ROUTES) expect(paths, `audited ${route}`).toContain(route);
    expect(report.options.wcag, 'the self-audit ran with the profile').toBe('2.2');
    for (const p of report.pages) expect(p.error, `${p.url}: ${p.error}`).toBeNull();
    const bad = [...report.pages.flatMap((p: any) => p.findings.map((f: any) => ({ ...f, page: p.url }))), ...report.site.findings].filter(
      (f: any) => f.level === 'violation' && ['critical', 'serious'].includes(f.impact)
    );
    expect(bad.map((f: any) => `${f.page} ${f.test} ${f.impact}: ${f.message} [${f.selector}]`), r.output).toEqual([]);

    // The folder picker (Change… in the header, aria-haspopup="dialog") is a
    // disclosure on every screen. Every disclosure on each screen was
    // activated, so Change… was, and its dialog's focus checks (4.G focus
    // moves in, 4.H focus returns) raised nothing. The core closes a dialog
    // with Escape before it re-audits the page, so the open dialog's own
    // contents are covered by the picker's Playwright tests instead.
    for (const route of ROUTES) {
      const d = report.pages.find((x: any) => new URL(x.finalUrl || x.url).pathname === route).passes.disclosure;
      expect(d.candidates, `${route}: disclosure candidates`).toBeGreaterThanOrEqual(1);
      expect(d.activated, `${route}: every disclosure, Change… among them, was activated`).toBe(d.candidates);
    }
    const dialogIssues = [...report.pages.flatMap((p: any) => p.findings.map((f: any) => ({ ...f, page: p.url }))), ...report.site.findings].filter(
      (f: any) => ['4.G', '4.H'].includes(f.test) || /Dialog has no accessible name|did not close with Escape|did not change aria-expanded/.test(f.message) || /Change working directory/.test(f.message)
    );
    expect(dialogIssues.map((f: any) => `${f.page} ${f.test} ${f.impact}: ${f.message} [${f.selector}]`)).toEqual([]);
  } finally {
    await dash.stop();
    site.close();
  }
});
