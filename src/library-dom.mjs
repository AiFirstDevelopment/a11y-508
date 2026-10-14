// Elements rendered by a UI library from npm (Angular Material, PrimeNG, ag-Grid, MUI, ...). Their
// authors tested them and the fixing assistant cannot edit node_modules, so findings on them are
// dropped (src/audit.mjs). Bootstrap's classes are app-authored markup here, not a library.
//
// A tag or class is a library's when it starts with one of these prefixes and the prefix is followed
// by a letter (so Tailwind's p-4 or e-2 is not). A prefix with `ancestor` is short enough to collide
// with app classes: it counts only inside an element matching that clearly-library root selector.
// The in-page checks get this same table and the matchers below as source (libraryPrelude()).

export const LIBRARY_TAG_PREFIXES = [
  'mat-', 'cdk-', 'mdc-', 'p-', 'ag-', 'ngx-', 'kendo-', 'dx-', 'ejs-', 'e-', 'ion-', 'nz-', 'nb-', 'clr-', 'tui-',
  'ng-select', 'ng-dropdown-panel', 'ng-option', 'ngb-', 'bs-', 'igx-', 'mwc-', 'md-', 'sl-', 'vaadin-', 'ui5-',
  'fluent-', 'calcite-', 'swiper-', 'highcharts-', 'apx-', 'full-calendar', 'ckeditor', 'quill-', 'google-map',
  'mgl-', 'esri-', 'arcgis-', 'gmp-', 'gmpx-',
];

export const LIBRARY_CLASS_PREFIXES = [
  // Angular
  { prefix: 'mat-' }, { prefix: 'mdc-' }, { prefix: 'cdk-' }, { prefix: 'ngx-' }, { prefix: 'ng-select' },
  { prefix: 'ng-dropdown-panel' }, { prefix: 'ngb-' }, { prefix: 'ion-' }, { prefix: 'nz-' }, { prefix: 'clr-' },
  { prefix: 'tui-' }, { prefix: 'igx-' },
  { prefix: 'p-', ancestor: '.p-component, [class*="p-component"]' },
  { prefix: 'nb-', ancestor: '[class*="nb-theme-"], nb-layout' },
  // Grids, suites
  { prefix: 'ag-' }, { prefix: 'dx-' }, { prefix: 'e-', ancestor: '.e-control, .e-lib' },
  { prefix: 'k-', ancestor: '[class*="k-widget"], .k-component, [class*="k-grid"]' },
  { prefix: 'dataTables_' }, { prefix: 'dt-', ancestor: '.dataTables_wrapper, .dt-container' },
  // React
  { prefix: 'Mui' }, { prefix: 'ant-' }, { prefix: 'chakra-' }, { prefix: 'bp3-' }, { prefix: 'bp4-' },
  { prefix: 'bp5-' }, { prefix: 'bp6-' }, { prefix: 'react-select__' }, { prefix: 'recharts-' },
  // Vue
  { prefix: 'el-', ancestor: '.el-popper, .el-overlay, .el-form, .el-table, .el-select, .el-input, .el-date-editor, .el-dialog, .el-menu, .el-dropdown, .el-tabs, .el-pagination' },
  { prefix: 'v-', ancestor: '.v-application, .v-overlay-container, .v-theme--light, .v-theme--dark' },
  // Calendars, maps, editors, carousels, pickers, dialogs, charts
  { prefix: 'fc-', ancestor: '.fc' },
  { prefix: 'leaflet-' }, { prefix: 'ol-', ancestor: '.ol-viewport' }, { prefix: 'mapboxgl-' },
  { prefix: 'maplibregl-' }, { prefix: 'esri-' }, { prefix: 'gm-', ancestor: '.gm-style' },
  { prefix: 'ck-', ancestor: '.ck' }, { prefix: 'tox-' }, { prefix: 'ql-', ancestor: '.ql-container, .ql-toolbar' },
  { prefix: 'CodeMirror' }, { prefix: 'cm-', ancestor: '.cm-editor' }, { prefix: 'monaco-' },
  { prefix: 'swiper' }, { prefix: 'slick-' }, { prefix: 'owl-' }, { prefix: 'flatpickr-' }, { prefix: 'swal2-' },
  { prefix: 'highcharts-' }, { prefix: 'apexcharts-' }, { prefix: 'plotly' }, { prefix: 'js-plotly' },
  // jQuery plugins
  { prefix: 'ui-', ancestor: '.ui-widget, .ui-datepicker, .ui-dialog, .ui-menu' },
  { prefix: 'select2-' },
];

// The prefix starts the name and is followed by a letter (or, after a word such as "swiper" or
// "Mui", by a separator or an upper-case letter); the bare word itself counts too.
export function prefixMatch(name, prefix) {
  if (!name || !name.startsWith(prefix)) return false;
  if (name.length === prefix.length) return !/[-_]$/.test(prefix);
  const next = name[prefix.length];
  return /[-_]$/.test(prefix) ? /[A-Za-z]/.test(next) : /[-_A-Z]/.test(next);
}

// 'yes' when the tag or a class is a library's outright, 'ancestor' (with the root selectors) when
// only a short prefix matched and the element must be inside (or be) a library root, otherwise null.
export function libraryMatch(tag, classes, tagPrefixes, classPrefixes) {
  const t = String(tag || '').toLowerCase();
  if (t.includes('-') && tagPrefixes.some((p) => prefixMatch(t, p))) return { kind: 'yes' };
  const roots = [];
  for (const c of classes) {
    for (const e of classPrefixes) {
      if (!prefixMatch(c, e.prefix)) continue;
      if (!e.ancestor) return { kind: 'yes' };
      if (!roots.includes(e.ancestor)) roots.push(e.ancestor);
    }
  }
  return roots.length ? { kind: 'ancestor', roots } : null;
}

// The Node side: the finding's own opening tag in `html` (tag name and class attribute), and the
// selector's last segment. Short prefixes need an ancestor the Node side cannot see: not dropped here.
export function fromLibrary({ selector, html } = {}) {
  const open = /^\s*<([A-Za-z][\w-]*)([^>]*)>/.exec(html || '');
  if (open) {
    const cls = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(open[2]);
    const classes = cls ? (cls[1] ?? cls[2] ?? cls[3]).split(/\s+/).filter(Boolean) : [];
    const m = libraryMatch(open[1], classes, LIBRARY_TAG_PREFIXES, LIBRARY_CLASS_PREFIXES);
    if (m && m.kind === 'yes') return true;
  }
  const last = String(selector || '').split(/\s*(?:>>>|>|\s)\s*/).filter(Boolean).pop() || '';
  const tag = (/^[A-Za-z][\w-]*/.exec(last) || [''])[0];
  const classes = (last.match(/\.(-?[A-Za-z_][\w-]*)/g) || []).map((c) => c.slice(1));
  const m = libraryMatch(tag, classes, LIBRARY_TAG_PREFIXES, LIBRARY_CLASS_PREFIXES);
  return !!(m && m.kind === 'yes');
}

// The in-page side, as source injected ahead of the checks: window.__a11y508.isLibraryElement(el).
export function libraryPrelude() {
  return `;(() => {
  const A = (window.__a11y508 = window.__a11y508 || {});
  const TAGS = ${JSON.stringify(LIBRARY_TAG_PREFIXES)};
  const CLASSES = ${JSON.stringify(LIBRARY_CLASS_PREFIXES)};
  const prefixMatch = ${prefixMatch.toString()};
  const libraryMatch = ${libraryMatch.toString()};
  A.isLibraryElement = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const m = libraryMatch(el.localName, Array.from(el.classList || []), TAGS, CLASSES);
    if (!m) return false;
    if (m.kind === 'yes') return true;
    return m.roots.some((r) => { try { return !!el.closest(r); } catch { return false; } });
  };
})();\n`;
}
