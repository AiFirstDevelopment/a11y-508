// The ARIA model in src/checks/browser/05-aria-data.js, checked against WAI-ARIA 1.2 itself:
// every superclass chain ends at roletype, every attribute a role names exists, the role and
// attribute counts are the specification's, and twenty facts read from its role and attribute
// definitions. Runs under the root `npm test` with nothing installed, on Node 18 and later.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'checks', 'browser', '05-aria-data.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: '05-aria-data.js' });
const { roles, attrs, ancestry, isConcrete, allows, replacements } = sandbox.window.__a11y508.aria;

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};
const role = (name) => {
  assert.ok(roles[name], `role ${name} is in the model`);
  return roles[name];
};
const same = (actual, expected, what) => assert.deepEqual([...actual].sort(), [...expected].sort(), what);

console.log('aria model:');
check('every role\'s superclass chain ends at roletype, and every superclass is a role', () => {
  for (const [name, r] of Object.entries(roles)) {
    if (name === 'roletype') {
      assert.equal(r.superclass.length, 0, 'roletype has no superclass');
      continue;
    }
    assert.ok(r.superclass.length > 0, `${name} has a superclass`);
    for (const s of r.superclass) assert.ok(roles[s], `${name}: superclass ${s} is a role`);
    assert.ok(ancestry(name).includes('roletype'), `${name}: chain ${ancestry(name).join(' > ')} reaches roletype`);
  }
});
check('every attribute a role names exists in attrs; every owned and context role exists in roles', () => {
  for (const [name, r] of Object.entries(roles)) {
    for (const a of [...r.requiredAttrs, ...r.supportedAttrs, ...r.prohibitedAttrs]) assert.ok(attrs[a], `${name}: ${a} is an attribute`);
    for (const a of r.requiredAttrs) assert.ok(r.supportedAttrs.includes(a), `${name}: required ${a} is also supported`);
    for (const o of [...r.requiredOwned, ...r.requiredContext]) assert.ok(roles[o], `${name}: ${o} is a role`);
  }
});
check('WAI-ARIA 1.2 defines 82 concrete and 12 abstract roles', () => {
  const all = Object.values(roles);
  assert.equal(all.filter((r) => !r.abstract).length, 82);
  same(Object.keys(roles).filter((n) => roles[n].abstract), ['command', 'composite', 'input', 'landmark', 'range', 'roletype', 'section', 'sectionhead', 'select', 'structure', 'widget', 'window'], 'abstract roles');
});
check('WAI-ARIA 1.2 defines 48 states and properties, 21 of them global; 1.3 additions are marked', () => {
  const v12 = Object.keys(attrs).filter((a) => !attrs[a].since);
  assert.equal(v12.length, 48);
  assert.equal(v12.filter((a) => attrs[a].global).length, 21);
  same(Object.keys(attrs).filter((a) => attrs[a].since === '1.3'), ['aria-braillelabel', 'aria-brailleroledescription', 'aria-colindextext', 'aria-description', 'aria-rowindextext'], '1.3 attributes');
  for (const [name, a] of Object.entries(attrs)) {
    assert.ok(['boolean', 'tristate', 'token', 'tokenlist', 'idref', 'idrefs', 'integer', 'number', 'string'].includes(a.type), `${name}: type ${a.type}`);
    if (/^token/.test(a.type)) assert.ok(a.values && a.values.length, `${name}: token values`);
  }
});

// Twenty facts, each from the role or attribute definition in WAI-ARIA 1.2.
const facts = [
  ['checkbox requires aria-checked', () => same(role('checkbox').requiredAttrs, ['aria-checked'])],
  ['tab requires the context tablist', () => same(role('tab').requiredContext, ['tablist'])],
  ['option requires the context listbox or group', () => same(role('option').requiredContext, ['group', 'listbox'])],
  ['button has presentational children; link does not', () => assert.ok(role('button').childrenPresentational && !role('link').childrenPresentational)],
  ['generic prohibits naming (aria-label, aria-labelledby)', () => same(role('generic').prohibitedAttrs, ['aria-label', 'aria-labelledby'])],
  ['aria-expanded is true/false/undefined, not tristate', () => {
    assert.equal(attrs['aria-expanded'].type, 'boolean');
    same(attrs['aria-expanded'].values, ['true', 'false', 'undefined']);
  }],
  ['aria-level is an integer', () => assert.equal(attrs['aria-level'].type, 'integer')],
  ['aria-current takes page, step, location, date, time, true, false', () => {
    assert.equal(attrs['aria-current'].type, 'token');
    same(attrs['aria-current'].values, ['page', 'step', 'location', 'date', 'time', 'true', 'false']);
  }],
  ['combobox requires aria-expanded (and no longer aria-controls)', () => same(role('combobox').requiredAttrs, ['aria-expanded'])],
  ['heading requires aria-level', () => same(role('heading').requiredAttrs, ['aria-level'])],
  ['option does not require aria-selected in 1.2, but supports it', () => {
    same(role('option').requiredAttrs, []);
    assert.ok(allows('option', 'aria-selected'));
  }],
  ['list owns listitem; table owns row or rowgroup', () => {
    same(role('list').requiredOwned, ['listitem']);
    same(role('table').requiredOwned, ['row', 'rowgroup']);
  }],
  ['aria-checked and aria-pressed are tristate', () => assert.ok(attrs['aria-checked'].type === 'tristate' && attrs['aria-pressed'].type === 'tristate')],
  ['aria-hidden, aria-describedby and aria-label are global; aria-checked is not', () => assert.ok(attrs['aria-hidden'].global && attrs['aria-describedby'].global && attrs['aria-label'].global && !attrs['aria-checked'].global)],
  ['aria-activedescendant is an ID reference, supported by composite widgets and textbox', () => {
    assert.equal(attrs['aria-activedescendant'].type, 'idref');
    assert.ok(allows('listbox', 'aria-activedescendant') && allows('textbox', 'aria-activedescendant') && !allows('link', 'aria-activedescendant'));
  }],
  ['slider requires aria-valuenow; scrollbar requires aria-controls and aria-valuenow', () => {
    same(role('slider').requiredAttrs, ['aria-valuenow']);
    same(role('scrollbar').requiredAttrs, ['aria-controls', 'aria-valuenow']);
  }],
  ['menuitemradio inherits aria-checked from menuitemcheckbox, and posinset from menuitem', () => {
    same(role('menuitemradio').superclass, ['menuitemcheckbox']);
    assert.ok(allows('menuitemradio', 'aria-checked') && allows('menuitemradio', 'aria-posinset'));
  }],
  ['directory, aria-grabbed and aria-dropeffect are deprecated, each with a replacement named', () => {
    assert.ok(role('directory').deprecated && attrs['aria-grabbed'].deprecated && attrs['aria-dropeffect'].deprecated);
    assert.ok(replacements.directory && replacements['aria-grabbed'] && replacements['aria-dropeffect']);
  }],
  ['link is named from content; textbox and img are not', () => assert.ok(role('link').nameFromContent && !role('textbox').nameFromContent && !role('img').nameFromContent)],
  ['aria-checked is not allowed on link; aria-expanded is not allowed on textbox; widget is not usable', () => {
    assert.ok(!allows('link', 'aria-checked') && !allows('textbox', 'aria-expanded') && allows('button', 'aria-pressed'));
    assert.ok(!isConcrete('widget') && isConcrete('switch') && isConcrete('doc-toc'));
  }],
];
assert.equal(facts.length, 20);
for (const [name, fn] of facts) check(name, fn);

console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exitCode = failures ? 1 : 0;
