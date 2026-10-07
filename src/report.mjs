// Report writers: JSON, self-contained HTML, Markdown summary, console output.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, IMPACTS, TEST_IDS } from './checks/catalog.mjs';

export function summarize(pages, site) {
  const byTest = {};
  for (const id of TEST_IDS) byTest[id] = { violations: 0, reviews: 0 };
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let violations = 0;
  let reviews = 0;
  const count = (f) => {
    if (!byTest[f.test]) byTest[f.test] = { violations: 0, reviews: 0 };
    if (f.level === 'violation') {
      violations++;
      byTest[f.test].violations++;
      byImpact[f.impact] = (byImpact[f.impact] || 0) + 1;
    } else {
      reviews++;
      byTest[f.test].reviews++;
    }
  };
  for (const p of pages) for (const f of p.findings || []) count(f);
  for (const f of site.findings || []) count(f);
  const audited = pages.filter((p) => !p.error && !p.skipped).length;
  const failed = pages.filter((p) => p.error).length;
  const skipped = pages.filter((p) => p.skipped).length;
  return { pages: pages.length, audited, failed, skipped, violations, reviews, byTest, byImpact };
}

export function shouldFail(summary, failOn) {
  if (!summary.audited) return true; // nothing was audited, so nothing can have passed
  if (!failOn.length) return false;
  return failOn.some((impact) => (summary.byImpact[impact] || 0) > 0);
}

export function writeReports({ outDir, report }) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'report.html'), renderHtml(report));
  writeFileSync(join(outDir, 'summary.md'), renderMarkdown(report));
  return { json: join(outDir, 'report.json'), html: join(outDir, 'report.html'), md: join(outDir, 'summary.md') };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search || '/';
  } catch {
    return u;
  }
};

export function renderMarkdown(r) {
  const s = r.summary;
  const lines = [];
  lines.push(`# Section 508 audit: ${r.baseUrl}`);
  lines.push('');
  lines.push(`Crawled ${s.pages} page(s) (${s.audited} audited, ${s.failed} failed, ${s.skipped} skipped) on ${r.finishedAt}.`);
  lines.push('');
  lines.push(`**Result: ${r.passed ? 'PASS' : 'FAIL'}** (fail on: ${r.options.failOn.join(', ') || 'none'})`);
  lines.push('');
  lines.push('| | Critical | Serious | Moderate | Minor | Review items |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| Count | ${s.byImpact.critical} | ${s.byImpact.serious} | ${s.byImpact.moderate} | ${s.byImpact.minor} | ${s.reviews} |`);
  lines.push('');
  lines.push('## By Trusted Tester test');
  lines.push('');
  lines.push('| Test | Name | WCAG | Violations | Review |');
  lines.push('|---|---|---|---|---|');
  for (const id of TEST_IDS) {
    const c = s.byTest[id];
    if (!c || (!c.violations && !c.reviews)) continue;
    lines.push(`| ${id} | ${CATALOG[id].name} | ${CATALOG[id].wcag} | ${c.violations} | ${c.reviews} |`);
  }
  lines.push('');
  lines.push('## Pages');
  lines.push('');
  lines.push('| Page | Violations | Review | Status |');
  lines.push('|---|---|---|---|');
  for (const p of r.pages) {
    const v = (p.findings || []).filter((f) => f.level === 'violation').length;
    const rv = (p.findings || []).length - v;
    lines.push(`| ${p.finalUrl || p.url} | ${v} | ${rv} | ${p.error ? 'ERROR: ' + p.error : p.skipped ? 'skipped: ' + p.skipped : p.status || ''} |`);
  }
  lines.push('');
  lines.push(`Full report: report.html / report.json in the same directory.`);
  return lines.join('\n') + '\n';
}

export function renderHtml(r) {
  const s = r.summary;
  const groups = new Map();
  const push = (f, page) => {
    if (!groups.has(f.test)) groups.set(f.test, []);
    groups.get(f.test).push({ ...f, page });
  };
  for (const p of r.pages) for (const f of p.findings || []) push(f, p.finalUrl || p.url);
  for (const f of r.site.findings || []) push(f, null);
  const testIds = TEST_IDS.filter((id) => groups.has(id));
  const pageOptions = r.pages.filter((p) => (p.findings || []).length).map((p) => `<option value="${esc(p.finalUrl || p.url)}">${esc(short(p.finalUrl || p.url))}</option>`).join('');

  const finding = (f, i) => {
    const page = f.page ? `<a href="${esc(f.page)}">${esc(short(f.page))}</a>` : f.pages ? f.pages.map((p) => `<a href="${esc(p)}">${esc(short(p))}</a>`).join(', ') : '<em>site-wide</em>';
    return `<li class="f" data-level="${f.level}" data-impact="${f.impact}" data-page="${esc(f.page || '')}" data-text="${esc((f.message + ' ' + f.selector + ' ' + f.html).toLowerCase())}">
  <div class="fh"><span class="badge ${f.level} ${f.impact}">${f.level === 'violation' ? 'Violation' : 'Review'} · ${f.impact}</span> <span class="pg">${page}</span>${f.state ? ` <span class="state">${esc(f.state)}</span>` : ''}</div>
  <p class="msg">${esc(f.message)}</p>
  ${f.selector ? `<div class="meta"><span class="k">selector</span> <code>${esc(f.selector)}</code></div>` : ''}
  ${f.html ? `<div class="meta"><span class="k">html</span> <code>${esc(f.html)}</code></div>` : ''}
  ${f.screenshot ? `<figure><img src="${esc(f.screenshot)}" alt="Screenshot of the element for finding ${i + 1}: ${esc(f.selector)}" loading="lazy"></figure>` : ''}
  ${f.details ? `<details><summary>Details</summary><pre>${esc(JSON.stringify(f.details, null, 2))}</pre></details>` : ''}
</li>`;
  };

  const sections = testIds.map((id) => {
    const list = groups.get(id);
    const v = list.filter((f) => f.level === 'violation').length;
    const c = CATALOG[id];
    return `<section class="test" id="test-${esc(id.replace('.', '-'))}" data-test="${esc(id)}">
<h3>${esc(id)} <span class="tn">${esc(c.name)}</span> <span class="wc">WCAG ${esc(c.wcag)}</span> <span class="cnt"><b>${v}</b> violation${v === 1 ? '' : 's'}, <b>${list.length - v}</b> for review</span></h3>
<p class="cond">${esc(c.condition)}</p>
<ol class="findings">${list.map(finding).join('\n')}</ol>
</section>`;
  }).join('\n');

  const manualRows = r.manual.map((m) => `<tr><th scope="row">${esc(m.test)}</th><td>${esc(m.name)}</td><td>${esc(m.wcag)}</td><td>${esc(m.automation)}</td><td>${esc(m.condition)}${m.note ? `<br><small>${esc(m.note)}</small>` : ''}</td></tr>`).join('\n');

  const pageRows = r.pages.map((p) => {
    const v = (p.findings || []).filter((f) => f.level === 'violation').length;
    const rv = (p.findings || []).length - v;
    const status = p.error ? `<span class="err">${esc(p.error)}</span>` : p.skipped ? `<span class="skip">${esc(p.skipped)}</span>` : esc(String(p.status || ''));
    const notes = (p.errors || []).length ? `<details><summary>${p.errors.length} note(s)</summary><ul>${p.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : '';
    return `<tr><td><a href="${esc(p.finalUrl || p.url)}">${esc(short(p.finalUrl || p.url))}</a></td><td>${esc(p.title || '')}</td><td>${status}</td><td>${v}</td><td>${rv}</td><td>${p.passes && p.passes.keyboard ? p.passes.keyboard.tabbed : ''}</td><td>${p.durationMs ? (p.durationMs / 1000).toFixed(1) + 's' : ''}${notes}</td></tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section 508 audit: ${esc(r.baseUrl)}</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#d9d9d9;--crit:#8b0000;--ser:#b4530a;--mod:#8a6d00;--min:#2f5f8f;--rev:#3b5f7a;--ok:#1d6b2f;--code:#f4f4f4}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
header{padding:20px 24px;border-bottom:1px solid var(--line)}h1{font-size:22px;margin:0 0 6px}h2{font-size:19px;margin:28px 0 10px}h3{font-size:17px;margin:0 0 4px}
main{padding:0 24px 60px;max-width:1200px}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}.tile{border:1px solid var(--line);border-radius:6px;padding:10px 14px;min-width:120px}.tile b{display:block;font-size:22px}
.tile.critical b{color:var(--crit)}.tile.serious b{color:var(--ser)}.tile.moderate b{color:var(--mod)}.tile.minor b{color:var(--min)}.tile.review b{color:var(--rev)}
.result{font-weight:700;padding:4px 10px;border-radius:4px;display:inline-block}.result.pass{background:#e4f3e7;color:var(--ok)}.result.fail{background:#f8e1e1;color:var(--crit)}
.filters{display:flex;flex-wrap:wrap;gap:14px;align-items:end;padding:12px;border:1px solid var(--line);border-radius:6px;margin:14px 0;background:#fafafa}
.filters label{display:flex;flex-direction:column;gap:4px;font-size:13px}.filters fieldset{border:0;padding:0;margin:0;display:flex;gap:10px;flex-wrap:wrap}.filters legend{font-size:13px;padding:0;margin-bottom:4px}
input,select{font:inherit;padding:4px 6px}
.test{border-top:1px solid var(--line);padding:16px 0}.tn{font-weight:400;color:var(--muted)}.wc{font-weight:400;font-size:13px;color:var(--muted);margin-left:8px}.cnt{font-weight:400;font-size:14px;margin-left:8px}.cond{color:var(--muted);margin:0 0 10px;font-size:14px}
ol.findings{list-style:none;padding:0;margin:0}.f{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin:0 0 10px}.f[hidden]{display:none}
.fh{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px}.badge{padding:2px 8px;border-radius:12px;color:#fff;background:var(--rev);font-weight:600}
.badge.violation.critical{background:var(--crit)}.badge.violation.serious{background:var(--ser)}.badge.violation.moderate{background:var(--mod)}.badge.violation.minor{background:var(--min)}
.state{color:var(--muted);font-style:italic}.msg{margin:6px 0}.meta{font-size:13px;margin:2px 0}.k{color:var(--muted);display:inline-block;min-width:64px}
code,pre{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 4px;border-radius:3px;white-space:pre-wrap;word-break:break-word}
pre{padding:8px;max-height:320px;overflow:auto}figure{margin:8px 0}figure img{max-width:100%;border:1px solid var(--line);max-height:300px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:#f4f4f4}
.err{color:var(--crit)}.skip{color:var(--muted)}a{color:#0b4f9c}a:focus,button:focus,input:focus,select:focus{outline:3px solid #0b4f9c;outline-offset:2px}
.toc{columns:3;font-size:14px}.toc a{display:block}@media(max-width:800px){.toc{columns:1}}
.hiddencount{font-size:13px;color:var(--muted)}
</style>
</head>
<body>
<header>
<h1>Section 508 audit: ${esc(r.baseUrl)}</h1>
<p>${esc(r.finishedAt)} · ${s.pages} page(s) crawled, ${s.audited} audited · <span class="result ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span> <small>(fails on: ${esc(r.options.failOn.join(', ') || 'none')})</small> · ${esc(r.tool.name)} ${esc(r.tool.version)} · ${esc(r.browser || '')}</p>
<div class="tiles">
<div class="tile critical"><b>${s.byImpact.critical}</b>critical</div>
<div class="tile serious"><b>${s.byImpact.serious}</b>serious</div>
<div class="tile moderate"><b>${s.byImpact.moderate}</b>moderate</div>
<div class="tile minor"><b>${s.byImpact.minor}</b>minor</div>
<div class="tile review"><b>${s.reviews}</b>for human review</div>
</div>
<p><strong>How to read this:</strong> a <em>Violation</em> is a determinate failure of a DHS Trusted Tester test condition. A <em>Review</em> item is an escalation: the tool found something a human must judge, and the message says what to check. The <a href="#manual">manual checklist</a> lists the conditions that can only be tested by hand.</p>
</header>
<main>
<h2 id="contents">Tests with findings</h2>
<nav aria-labelledby="contents" class="toc">
${testIds.map((id) => `<a href="#test-${esc(id.replace('.', '-'))}">${esc(id)} ${esc(CATALOG[id].name)} (${groups.get(id).length})</a>`).join('\n')}
</nav>
<form class="filters" aria-label="Filter findings" onsubmit="return false">
<fieldset><legend>Level</legend>
<label style="flex-direction:row;align-items:center"><input type="checkbox" name="level" value="violation" checked> Violations</label>
<label style="flex-direction:row;align-items:center"><input type="checkbox" name="level" value="review" checked> Review</label>
</fieldset>
<fieldset><legend>Impact</legend>
${IMPACTS.map((i) => `<label style="flex-direction:row;align-items:center"><input type="checkbox" name="impact" value="${i}" checked> ${i}</label>`).join('\n')}
</fieldset>
<label>Page <select name="page"><option value="">All pages</option>${pageOptions}</select></label>
<label>Search <input type="search" name="q" placeholder="message, selector, html"></label>
<span class="hiddencount" aria-live="polite" id="count"></span>
</form>
<div id="results">
${sections || '<p>No findings.</p>'}
</div>

<h2 id="manual">Manual checklist</h2>
<p>These Trusted Tester conditions are partly or wholly outside what automation can decide. "partial" means the tool reports what it can and escalates the rest; "manual" means a human tester must perform the test.</p>
<table>
<caption>Trusted Tester tests requiring human testing</caption>
<thead><tr><th scope="col">Test</th><th scope="col">Name</th><th scope="col">WCAG</th><th scope="col">Automation</th><th scope="col">Condition</th></tr></thead>
<tbody>${manualRows}</tbody>
</table>

<h2 id="pages">Pages</h2>
<table>
<caption>Crawled pages</caption>
<thead><tr><th scope="col">URL</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Violations</th><th scope="col">Review</th><th scope="col">Tab stops</th><th scope="col">Time</th></tr></thead>
<tbody>${pageRows}</tbody>
</table>
</main>
<script>
(function(){
  var form=document.querySelector('.filters');var items=Array.prototype.slice.call(document.querySelectorAll('.f'));var count=document.getElementById('count');
  function apply(){
    var levels=[].map.call(form.querySelectorAll('[name=level]:checked'),function(e){return e.value});
    var impacts=[].map.call(form.querySelectorAll('[name=impact]:checked'),function(e){return e.value});
    var page=form.page.value;var q=form.q.value.toLowerCase().trim();var shown=0;
    items.forEach(function(el){
      var ok=levels.indexOf(el.dataset.level)>=0&&impacts.indexOf(el.dataset.impact)>=0&&(!page||el.dataset.page===page)&&(!q||el.dataset.text.indexOf(q)>=0);
      el.hidden=!ok;if(ok)shown++;
    });
    document.querySelectorAll('.test').forEach(function(sec){sec.hidden=!sec.querySelector('.f:not([hidden])')});
    count.textContent=shown+' of '+items.length+' findings shown';
  }
  form.addEventListener('input',apply);apply();
})();
</script>
</body>
</html>
`;
}

export function makeLogger({ quiet, json }) {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
  const out = (s) => {
    if (!json) process.stdout.write(s + '\n');
    else process.stderr.write(s + '\n');
  };
  return {
    info: (s) => {
      if (!quiet) out(s);
    },
    warn: (s) => out(c(33, 'warn ') + s),
    error: (s) => out(c(31, 'error ') + s),
    page: (p, done, discovered) => {
      if (quiet) return;
      const v = (p.findings || []).filter((f) => f.level === 'violation').length;
      const rv = (p.findings || []).length - v;
      const mark = p.error ? c(31, '✗') : p.skipped ? c(90, '–') : v ? c(31, '✗') : c(32, '✓');
      const detail = p.error ? c(31, p.error) : p.skipped ? c(90, p.skipped) : `${v ? c(31, v + ' violation' + (v === 1 ? '' : 's')) : '0 violations'} · ${rv} review`;
      out(`${c(90, `[${String(done).padStart(3)}/${String(discovered).padStart(3)}]`)} ${mark} ${short(p.finalUrl || p.url)}  ${detail} ${c(90, `(${((p.durationMs || 0) / 1000).toFixed(1)}s)`)}`);
    },
    summary: (report, files) => {
      const s = report.summary;
      const lines = [];
      lines.push('');
      lines.push(`${c(1, 'Section 508 audit')}  ${report.baseUrl}`);
      lines.push(`pages: ${s.pages} crawled, ${s.audited} audited, ${s.failed} failed, ${s.skipped} skipped`);
      lines.push(`violations: ${c(31, s.byImpact.critical + ' critical')}, ${c(33, s.byImpact.serious + ' serious')}, ${s.byImpact.moderate} moderate, ${s.byImpact.minor} minor   review items: ${s.reviews}`);
      lines.push('');
      const rows = TEST_IDS.filter((id) => s.byTest[id] && (s.byTest[id].violations || s.byTest[id].reviews));
      if (rows.length) {
        lines.push(`${'test'.padEnd(6)} ${'name'.padEnd(44)} ${'viol'.padStart(5)} ${'review'.padStart(7)}`);
        for (const id of rows) {
          const t = s.byTest[id];
          lines.push(`${id.padEnd(6)} ${CATALOG[id].name.slice(0, 44).padEnd(44)} ${String(t.violations).padStart(5)} ${String(t.reviews).padStart(7)}`);
        }
        lines.push('');
      }
      lines.push(`report: ${files.html}`);
      lines.push(`        ${files.json}`);
      lines.push(`        ${files.md}`);
      lines.push('');
      if (!s.audited) lines.push(c(31, 'FAIL (no page could be audited)'));
      else lines.push(report.passed ? c(32, `PASS (no ${report.options.failOn.join('/') || ''} violations)`) : c(31, `FAIL (${report.options.failOn.filter((i) => s.byImpact[i]).map((i) => `${s.byImpact[i]} ${i}`).join(', ')} violations)`));
      out(lines.join('\n'));
    },
  };
}
