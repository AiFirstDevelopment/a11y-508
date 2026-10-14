// The token stays secret; the API is closed to anything without the session
// secret or with a foreign Host; report files cannot escape their directory.

import { test, expect } from '@playwright/test';
import { request } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboard, fixtureSite, open, fillRun, startFromRun, waitFinished, TOKEN, SECRET_HEADER, type Dash } from './harness';

function filesSince(dir: string, since: number, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) filesSince(p, since, out, depth + 1);
    else if (st.mtimeMs >= since && st.size < 20e6) out.push(p);
  }
  return out;
}

test('AC 16: the token is in no file, API response, event, or part of the page after submission', async ({ page }) => {
  const t0 = Date.now() - 1000;
  const site = await fixtureSite();
  const dash = await dashboard();
  const bodies: { url: string; text: string }[] = [];
  page.on('response', async (res) => {
    if (!res.url().startsWith(dash.origin)) return;
    try {
      bodies.push({ url: res.url(), text: await res.text() });
    } catch {}
  });
  try {
    await open(page, dash, '/run');
    await fillRun(page, { url: site.base, token: TOKEN, maxPages: 3, advanced: { 'no-zoom': true } });
    await startFromRun(page);
    // After submission the token is nowhere in the page, including field values.
    const pageText = () => page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input,textarea')].map((e: any) => e.value).join('\n'));
    expect(await pageText()).not.toContain(TOKEN);
    await waitFinished(page);
    expect(site.unauthorized).toEqual([]); // the token really was sent to the site
    for (const screen of ['/run', '/live', '/report', '/fix-loop', '/history', '/troubleshoot', '/sign-in']) {
      await page.goto(dash.origin + screen);
      await expect(page.locator('h1')).toBeVisible();
      expect(await pageText(), screen).not.toContain(TOKEN);
    }
    // Every API response, the event stream included.
    const events = await fetch(dash.origin + '/api/runs/current/events', { headers: { [SECRET_HEADER]: dash.secret } }).then((r) => r.text());
    expect(events).toContain('"type":"summary"');
    bodies.push({ url: 'events', text: events });
    for (const p of ['/api/env', '/api/reports', '/api/reports/latest', '/api/ledger', '/api/config', '/api/runs/current']) {
      bodies.push({ url: p, text: await fetch(dash.origin + p, { headers: { [SECRET_HEADER]: dash.secret } }).then((r) => r.text()) });
    }
    expect(bodies.length).toBeGreaterThan(8);
    for (const b of bodies) expect(b.text.includes(TOKEN), b.url).toBe(false);
    // Every file written under the working directory or the system temp directory since the run began.
    const files = [...filesSince(dash.cwd, t0), ...filesSince(tmpdir(), t0)];
    expect(files.some((f) => f.endsWith('report.json'))).toBe(true);
    const leaks = files.filter((f) => {
      try {
        return readFileSync(f).includes(TOKEN);
      } catch {
        return false;
      }
    });
    expect(leaks).toEqual([]);
  } finally {
    await dash.stop();
    site.close();
  }
});

const raw = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<number>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      ok(res.statusCode!);
    });
    req.on('error', fail);
    req.end();
  });

test('AC 17: 401 without the secret, 403 for a foreign Host, 404 for a report path that escapes its report', async ({ page }) => {
  const dash: Dash = await dashboard();
  try {
    const port = Number(new URL(dash.origin).port);
    const host = `127.0.0.1:${port}`;
    // A report with its report.html, so the confinement is tested against a real file.
    mkdirSync(dash.dirs().report, { recursive: true });
    writeFileSync(join(dash.dirs().report, 'report.json'), JSON.stringify({ baseUrl: 'http://x/', finishedAt: '2026-01-01T00:00:00.000Z', passed: true, summary: { audited: 1 }, pages: [] }));
    writeFileSync(join(dash.dirs().report, 'report.html'), '<p>report</p>');
    writeFileSync(join(dash.cwd, 'report.html'), 'outside the report');
    writeFileSync(join(dash.cwd, 'secret.txt'), 'outside the report');
    const ok = { host, [SECRET_HEADER.toLowerCase()]: dash.secret };

    for (const p of ['/api/env', '/api/reports', '/api/ledger', '/api/config', '/api/reports/latest/report.html']) {
      expect(await raw(port, p, { host }), p).toBe(401);
      expect(await raw(port, p, { host, [SECRET_HEADER.toLowerCase()]: 'not-the-secret' }), p).toBe(401);
    }
    const post = await fetch(dash.origin + '/api/runs', { method: 'POST', body: '{}' });
    expect(post.status).toBe(401);
    expect(await raw(port, '/api/env', ok)).toBe(200);
    for (const evil of ['evil.example:' + port, `127.0.0.1:${port + 1}`, 'attacker.test']) {
      expect(await raw(port, '/api/env', { ...ok, host: evil }), evil).toBe(403);
      expect(await raw(port, '/', { host: evil }), evil).toBe(403);
    }
    expect(await raw(port, '/api/reports/latest/report.html', ok)).toBe(200);
    for (const p of [
      '/api/reports/latest/../../secret.txt',
      '/api/reports/latest/..%2F..%2Fsecret.txt',
      '/api/reports/latest/..%2F..%2F..%2Fpackage.json',
      '/api/reports/..%2F..%2F/report.html',
      '/api/reports/%2e%2e/report.html',
      '/api/reports/h-..%2F..%2F..%2F/report.html',
      '/api/reports/latest/screenshots/p1-1.png',
    ]) expect(await raw(port, p, ok), p).toBe(404);
    // The app itself works with the secret it was opened with.
    await open(page, dash, '/run');
    await expect(page.locator('h1')).toHaveText('Set up');
  } finally {
    await dash.stop();
  }
});
