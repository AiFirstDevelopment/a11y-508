// Trusted Tester 14.A-14.C: tables.
// Header-less tables are classified data, layout or unsure before they are escalated (14.A), and
// header relationships are read from a grid of the cells with their spans (14.B). Technique
// informed by axe-core and IBM Equal Access; no code taken from either.
window.__a11y508.register(function tables(A) {
  const isBold = (el) => {
    const s = A.cs(el);
    return parseInt(s.fontWeight, 10) >= 600 || s.fontWeight === 'bold';
  };
  const VALID_SCOPE = new Set(['row', 'col', 'rowgroup', 'colgroup']);
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const span = (cell, attr) => {
    const n = parseInt(cell.getAttribute(attr) || '1', 10);
    return Number.isNaN(n) ? 1 : n;
  };

  // The table's own cells laid out on a grid, spans included: grid[r][c] is the cell covering
  // row r, column c; pos maps each cell to { r, c, rs, cs }. rowspan="0" runs to the last row.
  const buildGrid = (rows) => {
    const grid = rows.map(() => []);
    const pos = new Map();
    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row.cells) {
        while (grid[r][c]) c++;
        const cs = Math.min(Math.max(span(cell, 'colspan'), 1), 1000);
        let rs = span(cell, 'rowspan');
        rs = rs === 0 ? rows.length - r : Math.max(rs, 1);
        rs = Math.min(rs, rows.length - r);
        for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) grid[r + i][c + j] = cell;
        pos.set(cell, { r, c, rs, cs });
        c += cs;
      }
    });
    return { grid, pos, cols: Math.max(0, ...grid.map((g) => g.length)) };
  };
  const isHeaderCell = (cell) => cell.localName === 'th' || /^(columnheader|rowheader)$/.test(A.explicitRole(cell));
  const scopeOf = (cell) => {
    const s = norm(cell.getAttribute('scope'));
    if (s === 'col' || s === 'colgroup') return 'col';
    if (s === 'row' || s === 'rowgroup') return 'row';
    const role = A.explicitRole(cell);
    return role === 'columnheader' ? 'col' : role === 'rowheader' ? 'row' : 'auto';
  };
  // Cells in the same columns (axis 'col') or rows ('row') as cell, other than cell itself.
  const lineOf = (g, cell, axis) => {
    const p = g.pos.get(cell);
    const out = new Set();
    if (axis === 'col') {
      for (let c = p.c; c < p.c + p.cs; c++) for (const row of g.grid) if (row[c] && row[c] !== cell) out.add(row[c]);
    } else {
      for (let r = p.r; r < p.r + p.rs; r++) for (const x of g.grid[r]) if (x && x !== cell) out.add(x);
    }
    return [...out];
  };
  const hasContent = (cell) => !!(A.text(cell) || cell.querySelector('img, svg, input, select, textarea, button'));

  // Data, layout or unsure for a table with no header cells, and why. Data signals first, then
  // layout signals, then the visual ones.
  const classify = (table, rows, g) => {
    const own = [...g.pos.keys()];
    const role = A.explicitRole(table);
    const direct = (sel) => Array.from(table.children).some((c) => c.matches(sel));
    if (direct('caption')) return ['data', 'it has a caption'];
    if (direct('thead, tfoot, colgroup')) return ['data', 'it has thead, tfoot or colgroup'];
    if (table.hasAttribute('summary')) return ['data', 'it has a summary'];
    if (own.some((c) => c.hasAttribute('scope') || c.hasAttribute('headers') || c.hasAttribute('abbr'))) return ['data', 'its cells have scope, headers or abbr'];
    if (own.some((c) => /^(columnheader|rowheader)$/.test(A.explicitRole(c)))) return ['data', 'it has header roles'];
    if (/^(table|grid|treegrid)$/.test(role)) return ['data', `it has role="${role}"`];
    if (table.isContentEditable) return ['data', 'it is editable'];
    if (table.querySelector('table')) return ['layout', 'it contains a nested table'];
    if (rows.length < 2) return ['layout', 'it has fewer than two rows'];
    if (rows[Math.floor(rows.length / 2)].cells.length === 1) return ['layout', 'its middle row is one cell'];
    if (table.getBoundingClientRect().width > window.innerWidth * 0.95) return ['layout', 'it is wider than 95% of the viewport'];
    if (own.length < 10) return ['layout', 'it has fewer than ten cells'];
    if (g.cols >= 5) return ['data', 'it has five or more columns'];
    const bordered = own.some((c) => {
      const s = A.cs(c);
      return s && ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none' && s[`border${side}Style`] !== 'hidden' && A.parseColor(s[`border${side}Color`]).a > 0);
    });
    if (bordered) return ['data', 'its cells have visible borders'];
    const bg = (row) => {
      const own = A.parseColor(A.cs(row).backgroundColor);
      return own.a > 0 ? A.hex(own) + own.a : row.cells[0] ? A.cs(row.cells[0]).backgroundColor : '';
    };
    if (rows.length >= 3) {
      const b = rows.map(bg);
      if (b[0] !== b[1] && b.every((x, i) => x === b[i % 2])) return ['data', 'its rows have alternating backgrounds'];
    }
    if (rows.length >= 20) return ['data', 'it has twenty or more rows'];
    return ['unsure', 'nothing marks it as data or layout'];
  };

  for (const table of A.all('table')) {
    if (!A.isVisible(table)) continue;
    const role = (table.getAttribute('role') || '').toLowerCase();
    const ths = table.querySelectorAll('th');
    const headerish = ths.length || table.querySelector('caption, [scope], [headers], thead') || table.hasAttribute('summary');

    if (role === 'presentation' || role === 'none') {
      if (headerish) A.add({ test: '14.C', impact: 'moderate', el: table, message: 'Layout table (role="presentation") contains data-table markup (th, caption, scope, headers, thead, or summary). Remove the structure or remove the presentation role.' });
      continue;
    }

    for (const cell of table.querySelectorAll('th[scope], td[scope]')) {
      if (cell.closest('table') !== table) continue;
      const v = (cell.getAttribute('scope') || '').trim();
      if (!VALID_SCOPE.has(v.toLowerCase())) A.add({ test: '14.B', impact: 'serious', el: cell, message: `scope="${v}" is not a valid value, so assistive technology ignores it. Use col, row, colgroup or rowgroup.` });
    }
    const caption = table.querySelector(':scope > caption');
    if (caption && A.text(caption) && norm(A.text(caption)) === norm(table.getAttribute('summary'))) {
      A.add({ test: '14.B', level: 'review', impact: 'minor', el: table, message: 'The table\'s caption and summary are the same text, so screen readers announce it twice. The caption names the table; use the summary (or a description) only for how the table is organised, or remove it.' });
    }

    let rows = Array.from(table.rows || []);
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
        // Only tables that look like data, or might, are escalated.
        const [classification, reason] = classify(table, rows, buildGrid(rows));
        if (classification === 'data') {
          A.add({ test: '14.A', level: 'review', impact: 'moderate', el: table, details: { classification, reason }, message: `Table (${rows.length} rows x ${cols} cols) has no header cells and is classified as a data table (${reason}). Add <th> with scope for its headers; if it is only for layout, give it role="presentation" and no header or caption markup (14.C).` });
        } else if (classification === 'unsure') {
          A.add({ test: '14.A', level: 'review', impact: 'moderate', el: table, details: { classification, reason }, message: `Table (${rows.length} rows x ${cols} cols) has no header cells and could be a data or a layout table (${reason}). If it is a data table add <th> with scope; if it is a layout table, confirm it has no role="table" and no header/caption markup (14.C).` });
        }
      }
      continue;
    }

    // A first row that is one cell across the whole table is acting as a caption.
    const full = buildGrid(rows);
    if (full.cols >= 2 && rows[0].cells.length === 1 && span(rows[0].cells[0], 'colspan') >= full.cols && rows.length >= 3) {
      if (!caption) A.add({ test: '14.B', level: 'review', impact: 'moderate', el: rows[0].cells[0], message: `The first row is one cell across the whole table ("${A.text(rows[0].cells[0]).slice(0, 60)}"), acting as a caption. Screen readers announce it as a cell; make it a <caption>.` });
      rows = rows.slice(1);
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

    // Every data cell of a table of 3 x 3 or more has a row or column header, spans included; every
    // header labels at least one data cell.
    const g = buildGrid(rows);
    if (rows.length >= 3 && g.cols >= 3) {
      let orphans = 0;
      for (const [cell] of g.pos) {
        if (orphans >= 3) break;
        if (isHeaderCell(cell) || !hasContent(cell) || !A.isVisible(cell)) continue;
        if ((cell.getAttribute('headers') || '').trim()) continue;
        const header = lineOf(g, cell, 'col').some((h) => isHeaderCell(h) && scopeOf(h) !== 'row') || lineOf(g, cell, 'row').some((h) => isHeaderCell(h) && scopeOf(h) !== 'col');
        if (header) continue;
        orphans++;
        A.add({ test: '14.B', impact: 'serious', el: cell, message: `Data cell "${A.text(cell).slice(0, 60)}" has no row or column header, so screen readers announce it without context. Add a header for its column or row, or associate it with headers/id.` });
      }
    }
    let unlabelled = 0;
    for (const [cell] of g.pos) {
      if (unlabelled >= 3) break;
      if (!isHeaderCell(cell) || cell === g.grid[0][0] || !A.text(cell)) continue;
      const scope = scopeOf(cell);
      const labels = (scope !== 'row' && lineOf(g, cell, 'col').some((x) => !isHeaderCell(x))) || (scope !== 'col' && lineOf(g, cell, 'row').some((x) => !isHeaderCell(x)));
      const referenced = cell.id && table.querySelector(`[headers~="${CSS.escape(cell.id)}"]`);
      if (labels || referenced) continue;
      unlabelled++;
      A.add({ test: '14.B', level: 'review', impact: 'minor', el: cell, message: `Header "${A.text(cell).slice(0, 60)}" labels no data cell: there is no data cell in its ${scope === 'row' ? 'row' : scope === 'col' ? 'column' : 'row or column'}. Confirm it is a header, or make it a data cell.` });
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

  for (const grid of A.all('[role="table"], [role="grid"], [role="treegrid"]')) {
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
