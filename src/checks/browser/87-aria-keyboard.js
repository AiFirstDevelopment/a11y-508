// Trusted Tester 4.A/4.F static checks and ARIA integrity (reported under the test they affect).
window.__a11y508.register(function ariaKeyboard(A) {
  const COMPOSITE = '[role="listbox"], [role="tablist"], [role="menu"], [role="menubar"], [role="tree"], [role="grid"], [role="treegrid"], [role="radiogroup"], [role="toolbar"]';
  const CHILD_ROLES = new Set(['option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell', 'row', 'radio']);
  A.meta.pointerCandidates = [];
  A.meta.selectCandidates = [];

  for (const el of A.allVisible(6000)) {
    const roleAttr = (el.getAttribute('role') || '').trim();
    const role = roleAttr ? roleAttr.split(/\s+/)[0].toLowerCase() : '';
    const tabindex = A.tabindexOf(el);
    const focusable = A.isFocusable(el);
    const ariaHidden = A.isAriaHidden(el);

    if (roleAttr && !A.VALID_ROLES.has(role)) {
      A.add({ test: '5.C', impact: 'moderate', el, message: `role="${roleAttr}" is not a valid ARIA role, so the element's role cannot be determined.` });
    }

    for (const attr of ['aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-flowto', 'aria-details']) {
      if (!el.hasAttribute(attr)) continue;
      const missing = el.getAttribute(attr).split(/\s+/).filter((id) => id && !document.getElementById(id));
      if (missing.length) A.add({ test: '5.C', impact: 'moderate', el, message: `${attr} references id(s) that do not exist: ${missing.join(', ')}.` });
    }

    if (ariaHidden && A.isTabbable(el) && !el.matches('a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"]')) {
      A.add({ test: '4.A', impact: 'serious', el, message: 'Focusable element is inside aria-hidden="true": keyboard users reach it but assistive technology does not announce it.' });
    }

    if (tabindex !== null && tabindex > 0) {
      A.add({ test: '4.F', level: 'review', impact: 'moderate', el, message: `tabindex="${tabindex}" forces this element ahead of the natural focus order. Confirm the resulting order preserves meaning; prefer tabindex="0" with DOM order.` });
    }

    if (role && A.INTERACTIVE_ROLES.has(role) && !focusable && el.getAttribute('aria-disabled') !== 'true' && !ariaHidden) {
      if (CHILD_ROLES.has(role)) {
        const comp = el.closest(COMPOSITE);
        const managed = comp && (A.isFocusable(comp) || comp.querySelector('[tabindex="0"]') || comp.hasAttribute('aria-activedescendant'));
        if (managed) continue;
      }
      if (role === 'row' || role === 'gridcell' || role === 'columnheader' || role === 'rowheader') continue;
      A.add({ test: '4.A', impact: 'serious', el, message: `Element has role="${role}" but is not keyboard focusable (no tabindex and not a native control).` });
      continue;
    }

    const hasOnClick = el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('onmouseup') || el.hasAttribute('ondblclick');
    if (hasOnClick && !focusable && !A.hasInteractiveAncestor(el) && !ariaHidden && !el.matches('body, html, form, label, option')) {
      A.add({ test: '4.A', impact: 'serious', el, message: 'Element has a mouse click handler but is not keyboard focusable, so its function cannot be reached with the keyboard.' });
      continue;
    }

    if (tabindex === 0 && !role && !A.isNativeFocusable(el) && !el.matches('[contenteditable], [role], div[aria-label], section[aria-label], [aria-labelledby]')) {
      if (el.closest('[role="dialog"], [role="alertdialog"], dialog')) continue;
      const s = A.cs(el);
      if (s && (s.overflowY === 'auto' || s.overflowY === 'scroll')) continue; // scrollable regions are legitimately focusable
      A.add({ test: '4.A', level: 'review', impact: 'minor', el, message: `<${el.localName}> has tabindex="0" but no role. If it is interactive it needs a role and keyboard handlers; if not, remove it from the tab order.` });
    }

    // Candidates for the Node-side event-listener probe
    if (!focusable && !ariaHidden && !A.hasInteractiveAncestor(el) && !el.matches('body, html, label, option, img, svg, path, canvas, video, audio, iframe')) {
      const s = A.cs(el);
      if (s && s.cursor === 'pointer' && A.meta.pointerCandidates.length < 150) {
        const parentPointer = el.parentElement && A.cs(el.parentElement).cursor === 'pointer';
        if (!parentPointer) A.meta.pointerCandidates.push(A.selector(el));
      }
    }
    if (el.localName === 'select' && A.meta.selectCandidates.length < 50) A.meta.selectCandidates.push(A.selector(el));
  }

  // Duplicate ids that break ARIA/label references
  const refIds = new Set();
  for (const el of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls], [aria-owns], [headers], label[for], [aria-errormessage]')) {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'headers', 'for', 'aria-errormessage']) {
      const v = el.getAttribute(attr);
      if (v) v.split(/\s+/).forEach((id) => id && refIds.add(id));
    }
  }
  let dup = 0;
  for (const id of refIds) {
    if (dup >= 10) break;
    const matches = document.querySelectorAll(`[id="${id.replace(/"/g, '\\"')}"]`);
    if (matches.length > 1) {
      dup++;
      A.add({ test: '5.C', impact: 'serious', el: matches[1], message: `id="${id}" is used ${matches.length} times and is referenced by a label or ARIA attribute. Only the first element will be associated.` });
    }
  }

  const keys = new Map();
  for (const el of document.querySelectorAll('[accesskey]')) {
    const k = (el.getAttribute('accesskey') || '').toLowerCase();
    if (!k) continue;
    if (keys.has(k)) A.add({ test: '4.A', level: 'review', impact: 'minor', el, message: `accesskey="${k}" is assigned to more than one element.` });
    keys.set(k, el);
  }
});
