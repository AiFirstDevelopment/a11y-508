// Writes the manual flow's test PDFs (docs/plans/manual-findings.md): tiny, uncompressed, one text
// line per Tj, so the fake assistant (test/fake-agent.mjs) can read them without a PDF library.
// Run: node test/fixtures/manual/make-pdf.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function pdf(pages) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const text = `BT /F1 11 Tf 50 780 Td 14 TL\n${lines.map((l) => `(${esc(l)}) Tj T*`).join('\n')}\nET`;
    const content = add(`<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// FINDING lines: id | title | route | selectors (;) | element | the tester's words.
writeFileSync(join(here, 'manual-findings.pdf'), pdf([
  [
    'Manual accessibility test report - Example app',
    'Tested with NVDA and keyboard only.',
    'FINDING F1 | Search button has no accessible name | /search | #search-btn | the magnifier button in the search bar | The magnifier button in the search bar is announced only as button.',
  ],
  [
    'FINDING F2 | Company logo has no text alternative | / | footer img | the logo in the footer | The footer logo image has no alt text.',
    'FINDING F3 | Menu button has no accessible name | / | #menu-btn | the menu button in the header | The hamburger menu button in the header has no name.',
  ],
]));
writeFileSync(join(here, 'no-findings.pdf'), pdf([['Manual accessibility test report - Example app', 'No accessibility problems were found.']]));
