// Trusted Tester 4.A/4.F static checks and ARIA integrity (reported under the test they affect).
// ARIA attribute validity is derived from the model in 05-aria-data.js (WAI-ARIA 1.2): unknown
// attributes, invalid values, broken ID references, attributes the role does not support, naming
// on roles that prohibit it, required attributes, and deprecated roles and attributes (all 5.C).
// Rule set informed by axe-core and IBM Equal Access; no code or tables taken from either.
window.__a11y508.register(function ariaKeyboard(A) {
  const COMPOSITE = '[role="listbox"], [role="tablist"], [role="menu"], [role="menubar"], [role="tree"], [role="grid"], [role="treegrid"], [role="radiogroup"], [role="toolbar"]';
  const CHILD_ROLES = new Set(['option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell', 'row', 'radio']);
  const FIELD = 'input, select, textarea, [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"]';
  const { aria } = A;
  const KNOWN = Object.keys(aria.attrs);
  A.meta.pointerCandidates = [];
  A.meta.selectCandidates = [];

  // Levenshtein distance, for "did you mean" on a misspelled attribute.
  const distance = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  };
  const suggestion = (name) => {
    let best = null;
    let bestD = Infinity;
    for (const k of KNOWN) {
      const d = distance(name, k);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return bestD <= 2 ? best : null;
  };
  const orList = (vs) => (vs.length === 1 ? vs[0] : `${vs.slice(0, -1).join(', ')} or ${vs[vs.length - 1]}`);
  const tokens = (v) => v.trim().split(/\s+/).filter(Boolean);
  // A message when value is not valid for the attribute's type, else null. An empty value is the
  // attribute's default (a required attribute left empty is reported as missing instead).
  const valueProblem = (name, def, raw) => {
    const v = raw.trim();
    if (!v) return null;
    const lower = v.toLowerCase();
    if (def.type === 'boolean' || def.type === 'tristate' || def.type === 'token') {
      const values = def.values || ['true', 'false'];
      // For aria-current and aria-invalid, WAI-ARIA treats an unknown value as true.
      const effect = name === 'aria-current' || name === 'aria-invalid' ? 'assistive technology treats it as "true"' : 'assistive technology ignores it';
      return values.includes(lower) ? null : `${name}="${v}" is not a valid value, so ${effect}. Use ${orList(values)}.`;
    }
    if (def.type === 'tokenlist') {
      const bad = tokens(lower).filter((t) => !def.values.includes(t));
      return bad.length ? `${name}="${v}" contains ${bad.map((t) => `"${t}"`).join(', ')}, not a valid value. Use one or more of ${orList(def.values)}.` : null;
    }
    if (def.type === 'integer') return /^[+-]?\d+$/.test(v) ? null : `${name}="${v}" is not an integer, so assistive technology ignores it.`;
    if (def.type === 'number') return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v) ? null : `${name}="${v}" is not a number, so assistive technology ignores it.`;
    return null;
  };
  // A required attribute the native element already provides (a checkbox input's checked state).
  const nativeProvides = (el, attr) => {
    const t = el.localName;
    const type = t === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    if (attr === 'aria-checked') return type === 'checkbox' || type === 'radio';
    if (attr === 'aria-valuenow') return type === 'range' || type === 'number' || t === 'progress' || t === 'meter';
    if (attr === 'aria-expanded') return t === 'select';
    if (attr === 'aria-level') return /^h[1-6]$/.test(t);
    return false;
  };
  const describeRole = (el, role, explicit) => (explicit ? `role="${role}"` : `<${el.localName}> (role ${role})`);

  const checkAttributes = (el, ariaHidden) => {
    const explicit = A.explicitRole(el);
    const role = A.role(el);
    const model = aria.roles[role];
    let namingReported = false;
    for (const { name, value } of Array.from(el.attributes)) {
      if (!name.startsWith('aria-')) continue;
      const def = aria.attrs[name];
      if (!def) {
        // Rule 1: not an ARIA attribute.
        const near = suggestion(name);
        A.add({ test: '5.C', impact: 'serious', el, message: near ? `${name} is not an ARIA attribute, so it does nothing. Did you mean ${near}?` : `${name} is not an ARIA attribute, so it does nothing. Remove it or use a valid aria-* attribute.` });
        continue;
      }
      // Rule 2: the value fits the attribute's type; ID references resolve.
      const problem = valueProblem(name, def, value);
      if (problem) A.add({ test: '5.C', impact: 'serious', el, message: problem });
      if ((def.type === 'idref' || def.type === 'idrefs') && name !== 'aria-activedescendant') {
        const missing = tokens(value).filter((id) => !A.byId(el, id));
        const naming = /^aria-(labelledby|describedby|errormessage)$/.test(name) || (name === 'aria-controls' && el.matches(FIELD));
        if (missing.length) A.add({ test: '5.C', impact: naming ? 'serious' : 'moderate', el, message: `${name} references id(s) that do not exist: ${missing.join(', ')}.` });
      }
      if (ariaHidden || !value.trim()) continue;
      // Rule 11: deprecated attributes.
      if (def.deprecated) A.add({ test: '5.C', level: 'review', impact: 'minor', el, message: `${name} is deprecated in WAI-ARIA and ignored by most assistive technology; it has ${aria.replacements[name]}.` });
      // Rule 3: attributes the role does not support, and naming where the role prohibits it.
      // presentation/none are left to the presentation-conflict rule (88-aria-structure.js).
      if (!model || role === 'presentation' || role === 'none') continue;
      if (model.prohibitedAttrs.includes(name)) {
        if (!namingReported) A.add({ test: '5.C', impact: 'serious', el, message: `${name} is not allowed on ${describeRole(el, role, explicit)}, whose role prohibits naming, so assistive technology ignores the name. Put the text in the content, or give the element a role that can be named.` });
        namingReported = true;
      } else if (!aria.allows(role, name)) {
        A.add({ test: '5.C', impact: 'moderate', el, message: `${name} is not supported on ${describeRole(el, role, explicit)}, so assistive technology ignores it. Remove it, or use a role that supports it.` });
      }
    }
    if (ariaHidden || !explicit || !aria.roles[explicit]) return;
    // Rule 11: deprecated roles.
    if (aria.roles[explicit].deprecated) A.add({ test: '5.C', level: 'review', impact: 'minor', el, message: `role="${explicit}" is deprecated in WAI-ARIA 1.2; use ${aria.replacements[explicit]}.` });
    // Rule 4: required states and properties of an explicit role.
    for (const attr of aria.roles[explicit].requiredAttrs) {
      if ((el.getAttribute(attr) || '').trim() || nativeProvides(el, attr)) continue;
      const empty = el.hasAttribute(attr) ? ` (${attr}="" is empty)` : '';
      A.add({ test: '5.C', impact: /^(combobox|heading)$/.test(explicit) ? 'moderate' : 'serious', el, message: attr === 'aria-checked' ? `role="${explicit}" requires aria-checked to expose its state${empty}.` : `role="${explicit}" requires ${attr}${empty}.` });
    }
  };

  for (const el of A.allVisible(6000)) {
    const roleAttr = (el.getAttribute('role') || '').trim();
    // The first valid token wins; the attribute is wrong only when no token is valid.
    const role = A.explicitRole(el);
    const tabindex = A.tabindexOf(el);
    const focusable = A.isFocusable(el);
    const ariaHidden = A.isHiddenFromAT(el);

    if (roleAttr && !role) {
      const abstract = roleAttr.toLowerCase().split(/\s+/).find((t) => aria.roles[t] && aria.roles[t].abstract);
      if (abstract) A.add({ test: '5.C', impact: 'moderate', el, message: `role="${roleAttr}" uses "${abstract}", an abstract ARIA role that authors must not use; browsers ignore it, so the element's role cannot be determined. Use a concrete role.` });
      else A.add({ test: '5.C', impact: 'moderate', el, message: `role="${roleAttr}" is not a valid ARIA role, so the element's role cannot be determined.` });
    }
    checkAttributes(el, ariaHidden);

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

  // An iframe taken out of the tab order (tabindex="-1") whose same-origin document has content
  // that can be tabbed to. Frames smaller than 30 x 15 px, frames hidden from assistive technology
  // (behind an open modal included) and cross-origin frames are skipped.
  const FRAME_FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]';
  const tabbableInFrame = (el) => {
    const t = A.tabindexOf(el);
    if (t !== null && t < 0) return false;
    if (t === null && !el.matches(FRAME_FOCUSABLE.replace(', [tabindex]', ''))) return false;
    if (el.matches('input[type="hidden"]') || el.matches(':disabled') || el.closest('[inert]')) return false;
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse' && el.getClientRects().length > 0;
  };
  for (const f of A.all('iframe[tabindex]')) {
    const t = A.tabindexOf(f);
    if (t === null || t >= 0 || !A.isVisible(f) || A.isHiddenFromAT(f)) continue;
    const r = f.getBoundingClientRect();
    if (r.width < 30 || r.height < 15) continue;
    let doc = null;
    try {
      doc = f.contentDocument;
    } catch {}
    if (!doc || !doc.documentElement) continue; // cross-origin: its content cannot be read from here
    const inner = Array.from(doc.querySelectorAll(FRAME_FOCUSABLE)).find(tabbableInFrame);
    if (inner) A.add({ test: '4.A', impact: 'serious', el: f, details: { content: A.html(inner, 160) }, message: `This iframe has tabindex="-1", but its document has content keyboard users can tab to (<${inner.localName}>${A.text(inner) ? ` "${A.text(inner).slice(0, 40)}"` : ''}). Depending on the browser, keyboard users cannot reach that content, or reach it inside a frame taken out of the tab order. Remove tabindex="-1", or take the content out of the tab order too.` });
  }

  // A scrolling region with content outside its box and nothing in it that can take keyboard
  // focus. Chrome 130 and later make such a region focusable, so this is escalated: keyboard users
  // on other browsers cannot scroll to the content.
  let scrollers = 0;
  for (const el of A.allVisible(6000)) {
    if (scrollers >= 20) break;
    if (el === document.body || el === document.documentElement || /^(textarea|select|iframe)$/.test(el.localName)) continue;
    const s = A.cs(el);
    if (!s) continue;
    const sx = /^(auto|scroll)$/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const sy = /^(auto|scroll)$/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (!sx && !sy) continue;
    if (A.isHiddenFromAT(el) || A.isTabbable(el)) continue;
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const c = range.getBoundingClientRect();
    if (!(c.bottom > box.bottom + 1 || c.right > box.right + 1 || c.top < box.top - 1 || c.left < box.left - 1)) continue;
    if (Array.from(el.querySelectorAll('*')).some((d) => A.isTabbable(d) && A.isVisible(d))) continue;
    scrollers++;
    A.add({ test: '4.A', level: 'review', impact: 'moderate', el, message: `This region scrolls (${sy ? 'vertically' : 'horizontally'}), but neither it nor anything in it can take keyboard focus. Chrome lets keyboard users focus it; on other browsers they cannot scroll to the content outside its box. Add tabindex="0" with a role and a name (for example role="region" and aria-label), or put a focusable element inside.` });
  }

  // Duplicate ids that break ARIA/label references. Ids are unique per tree: the document and each
  // shadow root resolve their own references, so the same id in two roots is not a duplicate.
  const refIds = new Map(); // id + root -> { id, el: a referencing element in that root }
  for (const el of A.all('[aria-labelledby], [aria-describedby], [aria-controls], [aria-owns], [headers], label[for], [aria-errormessage], [aria-activedescendant], [aria-details], [aria-flowto]')) {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'headers', 'for', 'aria-errormessage', 'aria-activedescendant', 'aria-details', 'aria-flowto']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const root = A.rootOf(el);
      for (const id of v.split(/\s+/)) {
        if (!id) continue;
        let byRoot = refIds.get(id);
        if (!byRoot) refIds.set(id, (byRoot = new Map()));
        if (!byRoot.has(root)) byRoot.set(root, el);
      }
    }
  }
  let dup = 0;
  for (const [id, byRoot] of refIds) {
    if (dup >= 10) break;
    for (const ref of byRoot.values()) {
      if (dup >= 10) break;
      const matches = A.idMatches(ref, id);
      if (matches.length > 1) {
        dup++;
        A.add({ test: '5.C', impact: 'serious', el: matches[1], message: `id="${id}" is used ${matches.length} times and is referenced by a label or ARIA attribute. Only the first element will be associated.` });
      }
    }
  }

  const keys = new Map();
  for (const el of A.all('[accesskey]')) {
    const k = (el.getAttribute('accesskey') || '').toLowerCase();
    if (!k) continue;
    if (keys.has(k)) A.add({ test: '4.A', level: 'review', impact: 'minor', el, message: `accesskey="${k}" is assigned to more than one element.` });
    keys.set(k, el);
  }
});
