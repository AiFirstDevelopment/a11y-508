// The WAI-ARIA model the ARIA checks derive from, as data: every role and every state and property
// of WAI-ARIA 1.2, and the implicit roles of HTML elements. Loaded after 00-core.js and before the
// checks (the bundle concatenates the files in name order).
//
// Written from the specifications, not from any other tool's tables:
// - WAI-ARIA 1.2 (W3C Recommendation, 6 June 2023), https://www.w3.org/TR/wai-aria-1.2/
//   - "Relationships Between Concepts": superclass roles (the chain ends at roletype).
//   - "Characteristics of Roles": abstract roles; required, supported, inherited and prohibited
//     states and properties; required owned elements; required context role; name from
//     (contents / author / prohibited); presentational children.
//   - "Definition of Roles": the 82 concrete and 12 abstract roles, their values for the above.
//   - "Global States and Properties" and "Definitions of States and Properties": the 48 aria-*
//     attributes, which are global, and which are deprecated (aria-grabbed, aria-dropeffect).
//   - "Value" types: true/false, tristate (true/false/mixed), true/false/undefined, ID reference,
//     ID reference list, integer, number, string, token, token list.
//   - "Presentational Roles Conflict Resolution": presentation/none is ignored on an element that
//     is focusable or carries a global state or property.
//   - The role directory is deprecated in 1.2 (use list).
// - WAI-ARIA 1.3 (draft): the role alias image (img), and the attributes aria-description,
//   aria-braillelabel, aria-brailleroledescription, aria-colindextext and aria-rowindextext, which
//   Chrome supports. They are marked since: '1.3' and kept out of the 1.2 counts.
// - DPUB-ARIA 1.1 (doc-*) and Graphics-ARIA 1.0 (graphics-*): valid role names only.
// - HTML Accessibility API Mappings (HTML-AAM), "HTML Element Role Mappings": implicitRole().
// Plain script (not a module); it runs inside the audited page, and test/aria-data.mjs loads it in Node.
(() => {
  const A = (window.__a11y508 = window.__a11y508 || {});
  const words = (s) => (s ? s.split(' ') : []);

  // ---- Roles ----
  // R(name, superclasses, { abstract, deprecated, required, supported, prohibited, owned, context,
  // content, presentational }). supported is the role's own; inherited ones are added below.
  const roles = {};
  const NAMING = ['aria-label', 'aria-labelledby'];
  const R = (name, superclass, o = {}) => {
    roles[name] = {
      abstract: !!o.abstract,
      deprecated: !!o.deprecated,
      superclass: words(superclass),
      requiredAttrs: words(o.required),
      ownAttrs: [...new Set([...words(o.required), ...words(o.supported)])],
      supportedAttrs: [],
      prohibitedAttrs: o.prohibited ? NAMING.slice() : [],
      requiredOwned: words(o.owned),
      requiredContext: words(o.context),
      nameFromContent: !!o.content,
      childrenPresentational: !!o.presentational,
    };
  };
  const RANGE = 'aria-valuemax aria-valuemin aria-valuenow aria-valuetext';

  // Abstract roles (12).
  R('roletype', '', { abstract: true });
  R('structure', 'roletype', { abstract: true });
  R('widget', 'roletype', { abstract: true });
  R('window', 'roletype', { abstract: true, supported: 'aria-modal' });
  R('section', 'structure', { abstract: true });
  R('sectionhead', 'structure', { abstract: true });
  R('command', 'widget', { abstract: true });
  R('composite', 'widget', { abstract: true, supported: 'aria-activedescendant' });
  R('input', 'widget', { abstract: true });
  R('range', 'structure', { abstract: true, supported: RANGE });
  R('landmark', 'section', { abstract: true });
  R('select', 'composite group', { abstract: true, supported: 'aria-orientation' });

  // Concrete roles (82).
  R('alert', 'section');
  R('alertdialog', 'alert dialog');
  R('application', 'structure', { supported: 'aria-activedescendant aria-expanded' });
  R('article', 'document', { supported: 'aria-posinset aria-setsize' });
  R('banner', 'landmark');
  R('blockquote', 'section');
  R('button', 'command', { supported: 'aria-expanded aria-pressed', content: true, presentational: true });
  R('caption', 'section', { context: 'figure grid table treegrid', prohibited: true });
  R('cell', 'section', { supported: 'aria-colindex aria-colspan aria-rowindex aria-rowspan', context: 'row', content: true });
  R('checkbox', 'input', { required: 'aria-checked', supported: 'aria-expanded aria-readonly aria-required', content: true, presentational: true });
  R('code', 'section', { prohibited: true });
  R('columnheader', 'cell gridcell sectionhead', { supported: 'aria-sort', context: 'row', content: true });
  R('combobox', 'input', { required: 'aria-expanded', supported: 'aria-activedescendant aria-autocomplete aria-readonly aria-required' });
  R('complementary', 'landmark');
  R('contentinfo', 'landmark');
  R('definition', 'section');
  R('deletion', 'section', { prohibited: true });
  R('dialog', 'window');
  R('directory', 'list', { deprecated: true });
  R('document', 'structure');
  R('emphasis', 'section', { prohibited: true });
  R('feed', 'list', { owned: 'article' });
  R('figure', 'section');
  R('form', 'landmark');
  R('generic', 'structure', { prohibited: true });
  R('grid', 'composite table', { supported: 'aria-multiselectable aria-readonly', owned: 'row rowgroup' });
  R('gridcell', 'cell widget', { supported: 'aria-expanded aria-readonly aria-required aria-selected', context: 'row', content: true });
  R('group', 'section', { supported: 'aria-activedescendant' });
  R('heading', 'sectionhead', { required: 'aria-level', content: true });
  R('img', 'section', { presentational: true });
  R('insertion', 'section', { prohibited: true });
  R('link', 'command', { supported: 'aria-expanded', content: true });
  R('list', 'section', { owned: 'listitem' });
  R('listbox', 'select', { supported: 'aria-expanded aria-multiselectable aria-readonly aria-required', owned: 'option' });
  R('listitem', 'section', { supported: 'aria-level aria-posinset aria-setsize', context: 'directory list' });
  R('log', 'section');
  R('main', 'landmark');
  R('marquee', 'section');
  R('math', 'section', { presentational: true });
  R('menu', 'select', { owned: 'menuitem menuitemcheckbox menuitemradio' });
  R('menubar', 'menu', { owned: 'menuitem menuitemcheckbox menuitemradio' });
  R('menuitem', 'command', { supported: 'aria-expanded aria-posinset aria-setsize', context: 'group menu menubar', content: true });
  R('menuitemcheckbox', 'menuitem', { required: 'aria-checked', context: 'group menu menubar', content: true, presentational: true });
  R('menuitemradio', 'menuitemcheckbox', { required: 'aria-checked', context: 'group menu menubar', content: true, presentational: true });
  R('meter', 'range', { required: 'aria-valuenow', presentational: true });
  R('navigation', 'landmark');
  R('none', 'structure');
  R('note', 'section');
  R('option', 'input', { supported: 'aria-checked aria-posinset aria-selected aria-setsize', context: 'group listbox', content: true, presentational: true });
  R('paragraph', 'section', { prohibited: true });
  R('presentation', 'structure');
  R('progressbar', 'range widget', { presentational: true });
  R('radio', 'input', { required: 'aria-checked', supported: 'aria-posinset aria-setsize', content: true, presentational: true });
  R('radiogroup', 'select', { supported: 'aria-readonly aria-required', owned: 'radio' });
  R('region', 'landmark');
  R('row', 'group widget', { supported: 'aria-colindex aria-expanded aria-level aria-posinset aria-rowindex aria-selected aria-setsize', owned: 'cell columnheader gridcell rowheader', context: 'grid rowgroup table treegrid', content: true });
  R('rowgroup', 'structure', { owned: 'row', context: 'grid table treegrid' });
  R('rowheader', 'cell gridcell sectionhead', { supported: 'aria-sort', context: 'row', content: true });
  R('scrollbar', 'range widget', { required: 'aria-controls aria-valuenow', supported: 'aria-orientation', presentational: true });
  R('search', 'landmark');
  R('searchbox', 'textbox');
  R('separator', 'structure widget', { supported: 'aria-orientation ' + RANGE, presentational: true });
  R('slider', 'input range', { required: 'aria-valuenow', supported: 'aria-orientation aria-readonly', presentational: true });
  R('spinbutton', 'composite input range', { supported: 'aria-readonly aria-required' });
  R('status', 'section');
  R('strong', 'section', { prohibited: true });
  R('subscript', 'section', { prohibited: true });
  R('superscript', 'section', { prohibited: true });
  R('switch', 'checkbox', { required: 'aria-checked', content: true, presentational: true });
  R('tab', 'sectionhead widget', { supported: 'aria-expanded aria-posinset aria-selected aria-setsize', context: 'tablist', content: true, presentational: true });
  R('table', 'section', { supported: 'aria-colcount aria-rowcount', owned: 'row rowgroup' });
  R('tablist', 'composite', { supported: 'aria-multiselectable aria-orientation', owned: 'tab' });
  R('tabpanel', 'section');
  R('term', 'section');
  R('textbox', 'input', { supported: 'aria-activedescendant aria-autocomplete aria-multiline aria-placeholder aria-readonly aria-required' });
  R('time', 'section');
  R('timer', 'status');
  R('toolbar', 'group', { supported: 'aria-orientation' });
  R('tooltip', 'section', { content: true });
  R('tree', 'select', { supported: 'aria-multiselectable aria-required', owned: 'treeitem' });
  R('treegrid', 'grid tree', { owned: 'row rowgroup' });
  R('treeitem', 'listitem option', { supported: 'aria-expanded', context: 'group tree', content: true });

  // Every superclass of role, transitively, nearest first (role itself excluded).
  const ancestry = (role) => {
    const out = [];
    const visit = (r) => {
      for (const s of (roles[r] && roles[r].superclass) || []) {
        if (out.includes(s)) continue;
        out.push(s);
        visit(s);
      }
    };
    visit(role);
    return out;
  };
  // Inherited states and properties: a role supports its own and every superclass's.
  for (const [name, r] of Object.entries(roles)) {
    const all = new Set(r.ownAttrs);
    for (const s of ancestry(name)) for (const a of roles[s].ownAttrs) all.add(a);
    r.supportedAttrs = [...all].sort();
  }
  for (const r of Object.values(roles)) delete r.ownAttrs;

  // ---- States and properties ----
  // T(name, type, values, { global, deprecated, since }). For true/false/undefined attributes the
  // values list includes "undefined"; booleans otherwise take true and false.
  const attrs = {};
  const T = (name, type, values, o = {}) => {
    attrs[name] = { type, ...(values ? { values: words(values) } : {}), ...(o.global ? { global: true } : {}), ...(o.deprecated ? { deprecated: true } : {}), ...(o.since ? { since: o.since } : {}) };
  };
  const G = { global: true };
  T('aria-activedescendant', 'idref');
  T('aria-atomic', 'boolean', null, G);
  T('aria-autocomplete', 'token', 'inline list both none');
  T('aria-busy', 'boolean', null, G);
  T('aria-checked', 'tristate', 'true false mixed undefined');
  T('aria-colcount', 'integer');
  T('aria-colindex', 'integer');
  T('aria-colspan', 'integer');
  T('aria-controls', 'idrefs', null, G);
  T('aria-current', 'token', 'page step location date time true false', G);
  T('aria-describedby', 'idrefs', null, G);
  // An ID reference in 1.2, a list in 1.3: a list is accepted.
  T('aria-details', 'idrefs', null, G);
  T('aria-disabled', 'boolean', null, G);
  T('aria-dropeffect', 'tokenlist', 'copy execute link move none popup', { global: true, deprecated: true });
  T('aria-errormessage', 'idrefs', null, G);
  T('aria-expanded', 'boolean', 'true false undefined');
  T('aria-flowto', 'idrefs', null, G);
  T('aria-grabbed', 'boolean', 'true false undefined', { global: true, deprecated: true });
  T('aria-haspopup', 'token', 'false true menu listbox tree grid dialog', G);
  T('aria-hidden', 'boolean', 'true false undefined', G);
  T('aria-invalid', 'token', 'grammar false spelling true', G);
  T('aria-keyshortcuts', 'string', null, G);
  T('aria-label', 'string', null, G);
  T('aria-labelledby', 'idrefs', null, G);
  T('aria-level', 'integer');
  T('aria-live', 'token', 'assertive off polite', G);
  T('aria-modal', 'boolean');
  T('aria-multiline', 'boolean');
  T('aria-multiselectable', 'boolean');
  T('aria-orientation', 'token', 'horizontal undefined vertical');
  T('aria-owns', 'idrefs', null, G);
  T('aria-placeholder', 'string');
  T('aria-posinset', 'integer');
  T('aria-pressed', 'tristate', 'true false mixed undefined');
  T('aria-readonly', 'boolean');
  T('aria-relevant', 'tokenlist', 'additions all removals text', G);
  T('aria-required', 'boolean');
  T('aria-roledescription', 'string', null, G);
  T('aria-rowcount', 'integer');
  T('aria-rowindex', 'integer');
  T('aria-rowspan', 'integer');
  T('aria-selected', 'boolean', 'true false undefined');
  T('aria-setsize', 'integer');
  T('aria-sort', 'token', 'ascending descending none other');
  T('aria-valuemax', 'number');
  T('aria-valuemin', 'number');
  T('aria-valuenow', 'number');
  T('aria-valuetext', 'string');
  // WAI-ARIA 1.3 attributes Chrome already exposes: valid, but not part of 1.2.
  T('aria-braillelabel', 'string', null, { global: true, since: '1.3' });
  T('aria-brailleroledescription', 'string', null, { global: true, since: '1.3' });
  T('aria-colindextext', 'string', null, { since: '1.3' });
  T('aria-description', 'string', null, { global: true, since: '1.3' });
  T('aria-rowindextext', 'string', null, { since: '1.3' });
  roles.cell.supportedAttrs.push('aria-colindextext', 'aria-rowindextext');
  roles.row.supportedAttrs.push('aria-colindextext', 'aria-rowindextext');
  for (const r of ['columnheader', 'gridcell', 'rowheader']) roles[r].supportedAttrs.push('aria-colindextext', 'aria-rowindextext');

  // Replacements named in messages about deprecated roles and attributes.
  const replacements = {
    directory: 'role="list"',
    'aria-grabbed': 'no replacement attribute; describe the drag state in text (for example with aria-describedby)',
    'aria-dropeffect': 'no replacement attribute; describe the drop target and its effect in text (for example with aria-describedby)',
  };

  // DPUB-ARIA and Graphics-ARIA roles: valid names, no further constraints modelled here.
  const extraRoles = new Set((
    'doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref ' +
    'doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes ' +
    'doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index ' +
    'doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote ' +
    'doc-qna doc-subtitle doc-tip doc-toc graphics-document graphics-object graphics-symbol'
  ).split(' '));

  // A role an author may use: a concrete WAI-ARIA role, or a DPUB/Graphics role. Abstract roles are not.
  const isConcrete = (r) => (!!roles[r] && !roles[r].abstract) || extraRoles.has(r);
  const isA = (role, ancestor) => role === ancestor || ancestry(role).includes(ancestor);
  // Is attr allowed on role: a global attribute, or one the role supports (own or inherited).
  const allows = (role, attr) => !!attrs[attr] && (!!attrs[attr].global || (!!roles[role] && roles[role].supportedAttrs.includes(attr)));

  // ---- HTML-AAM implicit roles ----
  const hasName = (el) => ['aria-label', 'aria-labelledby', 'title'].some((a) => (el.getAttribute(a) || '').trim());
  const SECTIONING = 'article, aside, main, nav, section';
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  const TAG_ROLES = {
    article: 'article', aside: 'complementary', blockquote: 'blockquote', button: 'button', caption: 'caption', code: 'code',
    datalist: 'listbox', dd: 'definition', del: 'deletion', details: 'group', dfn: 'term', dialog: 'dialog', dt: 'term',
    em: 'emphasis', fieldset: 'group', figure: 'figure', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', hr: 'separator', html: 'document', ins: 'insertion', main: 'main', math: 'math',
    menu: 'list', meter: 'meter', nav: 'navigation', ol: 'list', optgroup: 'group', option: 'option', output: 'status',
    p: 'paragraph', progress: 'progressbar', s: 'deletion', search: 'search', strong: 'strong', sub: 'subscript',
    summary: 'button', sup: 'superscript', table: 'table', tbody: 'rowgroup', textarea: 'textbox', tfoot: 'rowgroup',
    thead: 'rowgroup', time: 'time', tr: 'row', ul: 'list', address: 'group',
    b: 'generic', bdi: 'generic', bdo: 'generic', body: 'generic', data: 'generic', div: 'generic', i: 'generic',
    pre: 'generic', q: 'generic', samp: 'generic', small: 'generic', span: 'generic', u: 'generic',
  };
  // The role HTML-AAM gives el with no role attribute: 'generic' for div and span, '' for elements
  // with no corresponding role (label, svg, iframe ...). Input types HTML-AAM leaves unmapped
  // (date, color, password ...) are textbox, as A.role has always returned.
  const implicitRole = (el) => {
    const t = el.localName;
    if (t === 'a' || t === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return '';
      if (INPUT_ROLES[type]) return type === 'search' && el.hasAttribute('list') ? 'combobox' : INPUT_ROLES[type];
      return el.hasAttribute('list') && /^(text|email|tel|url)$/.test(type) ? 'combobox' : 'textbox';
    }
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img';
    if (t === 'header' || t === 'footer') return el.parentElement && el.parentElement.closest(SECTIONING) ? 'generic' : t === 'header' ? 'banner' : 'contentinfo';
    if (t === 'section') return hasName(el) ? 'region' : 'generic';
    if (t === 'form') return hasName(el) ? 'form' : 'generic';
    if (t === 'li') {
      const p = el.parentElement;
      return p && /^(ul|ol|menu)$/.test(p.localName) && !(p.getAttribute('role') || '').trim() ? 'listitem' : p && A.role(p) === 'list' ? 'listitem' : 'generic';
    }
    if (t === 'td') {
      const table = el.closest('table');
      return table && /^(grid|treegrid)$/.test(A.explicitRole(table)) ? 'gridcell' : 'cell';
    }
    if (t === 'th') return /^row(group)?$/.test((el.getAttribute('scope') || '').toLowerCase()) ? 'rowheader' : 'columnheader';
    return TAG_ROLES[t] || '';
  };

  A.aria = { roles, attrs, extraRoles, replacements, ancestry, isA, isConcrete, allows, implicitRole };
})();
