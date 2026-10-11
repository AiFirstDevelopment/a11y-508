// AC 20: a11y-508 audits the dashboard itself, through the tool's own auth
// features, and finds no critical or serious violations on any screen.

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
      const ev = await api(dash, '/api/runs/current/events');
      throw new Error(`the ${name} run did not finish in 150s:\n${ev.text.slice(-4000)}`);
    };
    expect((await api(dash, '/api/runs', { method: 'POST', body: { kind: 'crawl', url: site.base, options: { 'max-pages': '3', 'no-zoom': true, 'max-screenshots': '2' }, auth: { mode: 'token', token: TOKEN } } })).status).toBe(202);
    await wait('crawl');
    writeFileSync(join(dash.cwd, 'a11y-508.config.json'), JSON.stringify({ url: site.base + 'about.html', args: ['--max-pages', '1', '--no-interact', '--no-zoom', '--no-screenshots'] }));
    expect((await api(dash, '/api/runs', { method: 'POST', body: { kind: 'dry-run', auth: { mode: 'token' } } })).status).toBe(202);
    await wait('dry-run');

    const out = tempDir('a11y-508-self-');
    // Asynchronously: this process also serves the fixture site, which a blocking spawn would freeze.
    const r = await run(
      process.execPath,
      [BIN, dash.origin + '/run', '--token-header', SECRET_HEADER, '--token-storage', 'a11y508.secret', '--no-follow-clicks', '--max-pages', '30', '--out', out, '--json'],
      { env: { ...process.env, TOKEN: dash.secret }, timeout: 200_000 }
    );
    phase(`self crawl exit ${r.status}`);
    if (!existsSync(join(out, 'report.json'))) throw new Error(`the self crawl wrote no report (exit ${r.status}):\n${r.output.slice(-6000)}\n--- dashboard ---\n${dash.output().slice(-3000)}`);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    const paths = report.pages.map((p: any) => new URL(p.finalUrl || p.url).pathname);
    for (const route of ROUTES) expect(paths, `audited ${route}`).toContain(route);
    for (const p of report.pages) expect(p.error, `${p.url}: ${p.error}`).toBeNull();
    const bad = [...report.pages.flatMap((p: any) => p.findings.map((f: any) => ({ ...f, page: p.url }))), ...report.site.findings].filter(
      (f: any) => f.level === 'violation' && ['critical', 'serious'].includes(f.impact)
    );
    expect(bad.map((f: any) => `${f.page} ${f.test} ${f.impact}: ${f.message} [${f.selector}]`), r.output).toEqual([]);
  } finally {
    await dash.stop();
    site.close();
  }
});
