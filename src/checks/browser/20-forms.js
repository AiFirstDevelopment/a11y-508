// Trusted Tester 5.A-5.H: forms.
window.__a11y508.register(function forms(A) {
  const FIELD_SEL = 'input, select, textarea, [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"]';
  const SKIP_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);
  const labelList = [];

  const labelHasVisualRequired = (el) => {
    const labels = el.labels ? Array.from(el.labels) : [];
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
    for (const l of [...labels, ...ids]) {
      const t = A.text(l) + (A.cs(l, '::after') || {}).content + (A.cs(l, '::before') || {}).content;
      if (/\*|required|\(req\)|mandatory/i.test(t)) return true;
      if (l.querySelector('.required, .req, [class*="required" i], abbr[title*="required" i]')) return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll(FIELD_SEL)) {
    const type = el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    if (SKIP_TYPES.has(type)) continue;
    if (!A.isVisible(el)) continue;
    if (A.isAriaHidden(el)) continue;
    const role = A.role(el);
    const { name, source } = A.accName(el);

    // Broken ID references and required ARIA states are reported by 87-aria-keyboard.js for every element.

    if (!name) {
      A.add({ test: '5.A', impact: 'critical', el, message: `${role || el.localName} has no label or accessible name.` });
    } else if (source === 'placeholder') {
      A.add({ test: '5.A', impact: 'serious', el, message: `Field is labelled only by its placeholder ("${name}"), which disappears once the user types. Provide a persistent <label>.` });
    } else if (source === 'title') {
      A.add({ test: '5.A', level: 'review', impact: 'moderate', el, message: `Field is labelled only by its title attribute ("${name}"), which is not visible. Confirm a visible label or instruction exists nearby.` });
    } else if (source === 'label' && Array.from(el.labels).every((l) => A.isHiddenForEveryone(l))) {
      A.add({ test: '5.A', level: 'review', impact: 'moderate', el, message: `Field's only label ("${name}") is hidden (display:none or visibility:hidden), so sighted users see no label. Show the label, or hide it visually only (an sr-only class) if a visible cue already identifies the field.` });
    } else if (source === 'aria-label' && !(el.labels && el.labels.length)) {
      A.add({ test: '5.A', level: 'review', impact: 'minor', el, message: `Field is named by aria-label ("${name}") with no visible <label>. Confirm a visible label, adjacent text, or icon makes its purpose clear to sighted users.` });
    }

    // More than one visible <label> for one field: assistive technology joins them all into the
    // name, unless aria-labelledby chooses one.
    if (!el.hasAttribute('aria-labelledby') && el.labels && el.labels.length > 1) {
      const shown = Array.from(el.labels).filter((l) => !A.isHiddenForEveryone(l) && !A.isHiddenFromAT(l));
      if (shown.length > 1) A.add({ test: '5.C', level: 'review', impact: 'moderate', el, details: { labels: shown.map((l) => A.selector(l)) }, message: `Field has ${shown.length} visible labels (${shown.map((l) => `"${A.nameFromContent(l, true, el)}"`).join(', ')}), which assistive technology joins into one name. Keep one label, or point aria-labelledby at the one that names the field.` });
    }

    if (name && (/^[\s*:.\-_]*$/.test(name) || name.length < 2)) {
      A.add({ test: '5.B', impact: 'serious', el, message: `Label "${name}" is not descriptive.` });
    }

    const visualReq = labelHasVisualRequired(el);
    const progReq = el.required || el.getAttribute('aria-required') === 'true';
    if (visualReq && !progReq) {
      A.add({ test: '5.C', impact: 'moderate', el, message: 'Label visually marks the field as required but the field has no required or aria-required="true" attribute.' });
    } else if (progReq && !visualReq && name) {
      A.add({ test: '5.A', level: 'review', impact: 'minor', el, message: 'Field is programmatically required but its label shows no required indication. Confirm sighted users are told it is required.' });
    }

    if (el.getAttribute('aria-invalid') === 'true' && !el.getAttribute('aria-describedby') && !el.getAttribute('aria-errormessage')) {
      A.add({ test: '5.F', impact: 'serious', el, message: 'Field is marked aria-invalid="true" but no error message is associated via aria-describedby or aria-errormessage.' });
    }

    if (el.localName === 'select') {
      const oc = el.getAttribute('onchange') || '';
      if (/submit\(|location|\.href|window\.open|navigate/i.test(oc)) {
        A.add({ test: '5.D', impact: 'serious', el, message: 'Changing this select immediately submits or navigates (onchange handler). Provide a separate submit control.' });
      }
    }

    if (labelList.length < 80 && name) labelList.push({ selector: A.selector(el), role: role || el.localName, label: name, source });
  }

  for (const label of document.querySelectorAll('label[for]')) {
    const id = label.getAttribute('for');
    if (!id) continue;
    const matches = document.querySelectorAll('[id="' + id.replace(/"/g, '\\"') + '"]');
    if (!matches.length) {
      if (A.isVisible(label)) A.add({ test: '5.C', impact: 'moderate', el: label, message: `<label for="${id}"> does not match any element id.` });
    } else if (matches.length > 1) {
      A.add({ test: '5.C', impact: 'serious', el: label, message: `<label for="${id}"> targets a duplicated id (${matches.length} elements). Only the first receives the label.` });
    }
  }

  const radioGroups = new Map();
  for (const r of document.querySelectorAll('input[type="radio"]')) {
    if (!A.isVisible(r)) continue;
    const key = (r.form ? 'f' + Array.from(document.forms).indexOf(r.form) : 'none') + ':' + (r.name || A.selector(r));
    if (!radioGroups.has(key)) radioGroups.set(key, []);
    radioGroups.get(key).push(r);
  }
  for (const group of radioGroups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const fs = first.closest('fieldset');
    const grp = first.closest('[role="group"], [role="radiogroup"]');
    const named = (fs && A.accName(fs).name) || (grp && A.accName(grp).name);
    if (!named) A.add({ test: '5.C', level: 'review', impact: 'moderate', el: first, message: `Radio group of ${group.length} has no group label (fieldset/legend or role="radiogroup" with a name). Confirm the question the radios answer is programmatically associated.` });
  }

  // Checkboxes that answer one question (the same name in the same form) need a group label, as
  // radios do: a fieldset with a legend, or role="group" with a name.
  const boxGroups = new Map();
  for (const c of document.querySelectorAll('input[type="checkbox"]')) {
    if (!c.name || !A.isVisible(c) || A.isHiddenFromAT(c) || A.explicitRole(c)) continue;
    const key = (c.form ? 'f' + Array.from(document.forms).indexOf(c.form) : 'none') + ':' + c.name;
    if (!boxGroups.has(key)) boxGroups.set(key, []);
    boxGroups.get(key).push(c);
  }
  for (const group of boxGroups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const fs = first.closest('fieldset');
    const grp = first.closest('[role="group"]');
    const named = (fs && fs.contains(group[group.length - 1]) && A.accName(fs).name) || (grp && grp.contains(group[group.length - 1]) && A.accName(grp).name);
    if (!named) A.add({ test: '5.C', level: 'review', impact: 'moderate', el: first, message: `Group of ${group.length} checkboxes named "${first.name}" has no group label (fieldset/legend, or role="group" with a name). Confirm the question the checkboxes answer is programmatically associated.` });
  }

  // fieldset structure: one legend, the first child, with text. A fieldset named by aria-label or
  // aria-labelledby has a group label without one.
  for (const fs of document.querySelectorAll('fieldset')) {
    if (!A.isVisible(fs) || A.isHiddenFromAT(fs)) continue;
    const legends = Array.from(fs.children).filter((c) => c.localName === 'legend');
    const labelled = (fs.getAttribute('aria-label') || '').trim() || (fs.getAttribute('aria-labelledby') || '').trim();
    let problem = '';
    if (!legends.length) problem = labelled ? '' : 'has no <legend>, so its controls have no group label';
    else if (legends.length > 1) problem = `has ${legends.length} <legend> elements; only the first names the group`;
    else if (fs.firstElementChild !== legends[0]) problem = 'has a <legend> that is not its first child; HTML requires the legend first, and some assistive technology does not announce a later one as the group label';
    else if (!A.nameFromContent(legends[0], true)) problem = 'has an empty <legend>';
    if (problem) A.add({ test: '5.C', impact: 'moderate', el: fs, message: `This fieldset ${problem}. Give it one <legend> with text, as its first child.` });
  }

  const forms = Array.from(document.querySelectorAll('form')).filter((f) => A.isVisible(f) && f.querySelector(FIELD_SEL));
  for (const form of forms) {
    const fields = Array.from(form.querySelectorAll(FIELD_SEL)).filter((f) => !SKIP_TYPES.has((f.getAttribute('type') || '').toLowerCase()) && A.isVisible(f));
    if (!fields.length) continue;
    const text = (A.text(form) + ' ' + fields.map((f) => (f.name || '') + ' ' + (f.id || '')).join(' ')).toLowerCase();
    A.add({
      test: '5.F', level: 'review', impact: 'moderate', el: form,
      message: `Form with ${fields.length} field(s). Submit it with invalid/missing data and confirm each error is identified in text next to the field (5.F) and tells the user how to fix it (5.G).`,
      details: { fields: fields.slice(0, 30).map((f) => A.accName(f).name || A.selector(f)) },
    });
    if (/credit|debit|card number|payment|purchase|checkout|ssn|social security|tax|legal|agree|signature|i certify|delete (my )?account|cancel (my )?(account|subscription)|transfer/.test(text)) {
      A.add({ test: '5.H', level: 'review', impact: 'serious', el: form, message: 'Form appears to be legal, financial, or data-modifying. Confirm the user can review, correct, or confirm before the submission is final.' });
    }
  }

  if (labelList.length) {
    A.add({ test: '5.B', level: 'review', impact: 'minor', selector: 'form fields', message: `${labelList.length} labelled field(s) on this page. Confirm each label describes the input sufficiently.`, details: { fields: labelList } });
  }
});
