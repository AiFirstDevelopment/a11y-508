// Trusted Tester 14.A-14.C: tables.
window.__a11y508.register(function tables(A) {
  const isBold = (el) => {
    const s = A.cs(el);
    return parseInt(s.fontWeight, 10) >= 600 || s.fontWeight === 'bold';
  };

  for (const table of document.querySelectorAll('table')) {
    if (!A.isVisible(table)) continue;
    const role = (table.getAttribute('role') || '').toLowerCase();
    const ths = table.querySelectorAll('th');
    const headerish = ths.length || table.querySelector('caption, [scope], [headers], thead') || table.hasAttribute('summary');

    if (role === 'presentation' || role === 'none') {
      if (headerish) A.add({ test: '14.C', impact: 'moderate', el: table, message: 'Layout table (role="presentation") contains data-table markup (th, caption, scope, headers, thead, or summary). Remove the structure or remove the presentation role.' });
      continue;
    }

    const rows = Array.from(table.rows || []);
    if (rows.length < 2) continue;
    const cols = Math.max(...rows.map((r) => r.cells.length));
    if (cols < 2) continue;
    if (table.querySelector('table')) {
      if (!headerish) {
        A.add({ test: '14.C', level: 'review', impact: 'minor', el: table, message: 'Table contains nested tables and no header markup; it looks like a layout table. Confirm, and avoid role="table" on layout tables.' });
        continue;
      }
    }

    if (!ths.length && !table.querySelector('[headers]')) {
      const first = rows[0];
      const firstCells = Array.from(first.cells);
      const looksHeader = firstCells.length >= 2 && firstCells.every((c) => A.text(c).length > 0 && A.text(c).length < 40) && (firstCells.every(isBold) || first.parentElement.localName === 'thead' || table.querySelector('caption'));
      if (looksHeader) {
        A.add({ test: '14.B', impact: 'serious', el: table, message: `Data table has no <th> cells. The first row (${firstCells.map((c) => A.text(c)).slice(0, 4).join(' | ')}) looks like headers; mark them up as <th scope="col">.` });
      } else {
        A.add({ test: '14.A', level: 'review', impact: 'moderate', el: table, message: `Table (${rows.length} rows x ${cols} cols) has no header cells. If it is a data table add <th> with scope; if it is a layout table, confirm it has no role="table" and no header/caption markup (14.C).` });
      }
      continue;
    }

    // Header geometry
    const firstRowThs = Array.from(rows[0].cells).filter((c) => c.localName === 'th');
    const hasColHeaders = firstRowThs.length >= Math.max(1, Math.floor(rows[0].cells.length / 2));
    const bodyRows = rows.slice(1);
    const rowHeaderCount = bodyRows.filter((r) => r.cells[0] && r.cells[0].localName === 'th').length;
    const hasRowHeaders = bodyRows.length > 0 && rowHeaderCount >= Math.ceil(bodyRows.length / 2);
    const spanned = Array.from(ths).some((th) => (parseInt(th.getAttribute('colspan') || '1', 10) > 1) || (parseInt(th.getAttribute('rowspan') || '1', 10) > 1));
    const headerRows = rows.filter((r) => r.cells.length && Array.from(r.cells).every((c) => c.localName === 'th')).length;
    const midThs = bodyRows.some((r) => Array.from(r.cells).slice(1).some((c) => c.localName === 'th'));
    const complex = spanned || headerRows > 1 || midThs;
    const anyScope = table.querySelector('th[scope]');
    const anyHeaders = table.querySelector('td[headers], th[headers]');

    for (const cell of table.querySelectorAll('[headers]')) {
      const missing = (cell.getAttribute('headers') || '').split(/\s+/).filter((id) => id && !table.querySelector('#' + CSS.escape(id)));
      if (missing.length) A.add({ test: '14.B', impact: 'serious', el: cell, message: `headers attribute references id(s) not found in the table: ${missing.join(', ')}.` });
    }

    if (complex && !anyHeaders) {
      if (anyScope && table.querySelector('th[scope="colgroup"], th[scope="rowgroup"]')) {
        A.add({ test: '14.B', level: 'review', impact: 'moderate', el: table, message: 'Complex table (spanned or multi-level headers) relies on scope="colgroup/rowgroup". Confirm every data cell resolves to the correct headers with a screen reader.' });
      } else {
        A.add({ test: '14.B', impact: 'serious', el: table, message: 'Complex table (spanned or multi-level headers) has no headers/id associations. Screen readers cannot associate data cells with the right headers; use id/headers (or simplify the table).' });
      }
    } else if (hasColHeaders && hasRowHeaders && !anyScope && !anyHeaders) {
      A.add({ test: '14.B', impact: 'moderate', el: table, message: 'Table has both column and row headers but <th> cells have no scope attribute. Add scope="col" and scope="row".' });
    } else if (!hasColHeaders && !hasRowHeaders && !anyHeaders) {
      A.add({ test: '14.B', level: 'review', impact: 'moderate', el: table, message: 'Table has <th> cells but they are not arranged as a header row or header column. Confirm each data cell is associated with its headers.' });
    }

    let emptyTh = 0;
    ths.forEach((th, i) => {
      if (!A.text(th) && !A.accName(th).name) {
        const isCorner = th === rows[0].cells[0];
        if (!isCorner && emptyTh < 3) {
          emptyTh++;
          A.add({ test: '14.B', level: 'review', impact: 'minor', el: th, message: 'Header cell is empty. Data cells in this row/column will be announced without a header.' });
        }
      }
    });
  }

  for (const grid of document.querySelectorAll('[role="table"], [role="grid"], [role="treegrid"]')) {
    if (grid.localName === 'table' || !A.isVisible(grid)) continue;
    const rows = grid.querySelectorAll('[role="row"]');
    if (!rows.length) {
      A.add({ test: '14.B', impact: 'moderate', el: grid, message: `role="${grid.getAttribute('role')}" has no role="row" descendants.` });
      continue;
    }
    if (!grid.querySelector('[role="columnheader"], [role="rowheader"]')) {
      A.add({ test: '14.B', impact: 'moderate', el: grid, message: `role="${grid.getAttribute('role')}" has no columnheader/rowheader cells, so data cells cannot be associated with headers.` });
    }
  }
});
