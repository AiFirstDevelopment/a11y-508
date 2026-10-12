// ARIA structure, derived from the model in 05-aria-data.js (WAI-ARIA 1.2, HTML-AAM): required
// owned elements and context roles (5.C), presentation-role conflicts (7.B / 5.C), focusable
// content inside controls whose children are presentational (6.A), unnamed widgets and images
// (5.C / 7.A), aria-activedescendant (4.A), and landmark structure (9.A).
// Rule set informed by axe-core and IBM Equal Access; no code or tables taken from either.
window.__a11y508.register(function ariaStructure(A) {
  const { aria } = A;
  const roleOf = (el) => A.role(el);
  const model = (role) => aria.roles[role];
  const hiddenFor = (el) => A.isHiddenForEveryone(el) || A.isHiddenFromAT(el);
  const idList = (el, attr) => (el.getAttribute(attr) || '').trim().split(/\s+/).filter(Boolean);
  const byIds = (ids) => ids.map((id) => document.getElementById(id)).filter(Boolean);
  const visible = A.allVisible(6000).filter((el) => !A.isHiddenFromAT(el));

  // Containers the accessibility tree flattens, so their children count as the parent's:
  // presentation, none, generic, group, and elements with no role of their own.
  const TRANSPARENT = new Set(['', 'presentation', 'none', 'generic', 'group']);

  // ---- Rule 5: required owned elements and required context ----
  // Roles whose structure another test already reports: list and listitem (10.D), table, grid and
  // treegrid rows (14.B). They are not reported twice.
  const OWNED_ELSEWHERE = new Set(['list', 'table', 'grid', 'treegrid']);
  const CONTEXT_ELSEWHERE = new Set(['listitem']);
  // The roles of el's accessible children: DOM children plus aria-owns, through transparent wrappers.
  const ownedRoles = (el) => {
    const out = new Set();
    const seen = new Set();
    const visit = (n) => {
      if (seen.has(n) || hiddenFor(n)) return;
      seen.add(n);
      const r = roleOf(n);
      if (TRANSPARENT.has(r)) {
        if (r === 'group') out.add(r);
        for (const c of n.children) visit(c);
        for (const o of byIds(idList(n, 'aria-owns'))) visit(o);
      } else out.add(r);
    };
    for (const c of el.children) visit(c);
    for (const o of byIds(idList(el, 'aria-owns'))) visit(o);
    return out;
  };
  // The element that owns el through aria-owns, if any.
  const owner = (el) => (el.id ? document.querySelector(`[aria-owns~="${CSS.escape(el.id)}"]`) : null);
  const contextRoles = (el) => {
    const out = new Set();
    const seen = new Set();
    let n = owner(el) || el.parentElement;
    while (n && n.nodeType === 1 && !seen.has(n)) {
      seen.add(n);
      out.add(roleOf(n));
      n = owner(n) || n.parentElement;
    }
    return out;
  };
  const list = (rs) => rs.map((r) => `"${r}"`).join(' or ');

  for (const el of visible) {
    const explicit = A.explicitRole(el);
    const m = explicit && model(explicit);
    if (!m) continue;
    if (m.requiredOwned.length && !OWNED_ELSEWHERE.has(explicit) && (el.getAttribute('aria-busy') || '').toLowerCase() !== 'true') {
      const owned = ownedRoles(el);
      if (!m.requiredOwned.some((r) => owned.has(r))) {
        A.add({ test: '5.C', impact: 'serious', el, message: `role="${explicit}" must contain an element with role ${list(m.requiredOwned)} (directly, through a wrapper, or by aria-owns); it has none, so assistive technology cannot present its items. Set aria-busy="true" while it is loading.` });
      }
    }
    if (m.requiredContext.length && !CONTEXT_ELSEWHERE.has(explicit)) {
      const ctx = contextRoles(el);
      if (!m.requiredContext.some((r) => ctx.has(r))) {
        A.add({ test: '5.C', impact: 'serious', el, message: `role="${explicit}" must be inside an element with role ${list(m.requiredContext)} (or owned by one through aria-owns); outside it, assistive technology cannot tell what it belongs to.` });
      }
    }
  }

  // ---- Rule 6: presentation conflicts ----
  // presentation/none (explicit, or the implicit role of img alt="") is ignored by the browser when
  // the element is focusable or carries a global ARIA attribute (other than aria-hidden). The
  // naming attributes on an image are reported by 10-images.js.
  const globalsOn = (el) => Array.from(el.attributes).filter((a) => a.name !== 'aria-hidden' && aria.attrs[a.name] && aria.attrs[a.name].global && a.value.trim()).map((a) => a.name);
  for (const el of visible) {
    const explicit = A.explicitRole(el);
    const img = !explicit && el.localName === 'img' && el.getAttribute('alt') === '';
    if (!img && explicit !== 'presentation' && explicit !== 'none') continue;
    const globals = globalsOn(el).filter((a) => !(img && (a === 'aria-label' || a === 'aria-labelledby')));
    const focusable = A.isFocusable(el);
    if (!focusable && !globals.length) continue;
    const why = [focusable ? 'it is focusable' : '', globals.length ? `it has ${globals.join(', ')}` : ''].filter(Boolean).join(' and ');
    const what = img ? 'alt="" marks this image as decorative' : `role="${explicit}" removes this element's semantics`;
    A.add({ test: img ? '7.B' : '5.C', level: 'review', impact: 'moderate', el, message: `${what}, but ${why}, so the browser ignores that and exposes it anyway. Confirm the intent: remove the ${focusable ? 'focusability' : 'attribute'}, or the ${img ? 'empty alt' : 'role'}.` });
  }

  // ---- Rule 7: focusable content inside a control whose children are presentational ----
  for (const el of visible) {
    const role = roleOf(el);
    const m = model(role);
    if (!m || !m.childrenPresentational || !el.firstElementChild) continue;
    let tabbable = null;
    let focusable = null;
    for (const d of el.querySelectorAll('*')) {
      if (hiddenFor(d) || !A.isFocusable(d)) continue;
      if (A.isTabbable(d)) {
        tabbable = d;
        break;
      }
      focusable = focusable || d;
    }
    const d = tabbable || focusable;
    if (!d) continue;
    const details = { descendant: A.selector(d), html: A.html(d, 160) };
    if (tabbable) A.add({ test: '6.A', impact: 'serious', el, details, message: `This ${role} contains a focusable <${d.localName}> (${A.selector(d)}). The children of a ${role} are presentational, so assistive technology does not announce the inner control, and keyboard users reach a stop with no name or purpose. Move it outside the ${role}.` });
    else A.add({ test: '6.A', level: 'review', impact: 'moderate', el, details, message: `This ${role} contains a <${d.localName}> with tabindex="-1" (${A.selector(d)}). It is not in the tab order, but if a script focuses it, assistive technology cannot announce it, because the children of a ${role} are presentational. Confirm it never receives focus.` });
  }

  // ---- Rule 8: widgets and images that need a name and never take it from content alone ----
  // Form-like widgets (textbox, combobox, switch ...) are reported by 20-forms.js under 5.A.
  // tooltip, menuitemcheckbox and menuitemradio may be named by their content (WAI-ARIA 1.2 "name
  // from: contents"); progressbar, meter and img may not.
  const NEEDS_NAME = new Set(['progressbar', 'meter', 'tooltip', 'menuitemcheckbox', 'menuitemradio', 'img']);
  for (const el of visible) {
    const explicit = A.explicitRole(el);
    if (!NEEDS_NAME.has(explicit) || (explicit === 'img' && el.localName === 'img')) continue;
    // An image inside a control whose children are presentational is not exposed at all.
    let p = el.parentElement;
    while (p && !(model(roleOf(p)) && model(roleOf(p)).childrenPresentational)) p = p.parentElement;
    if (p) continue;
    if (A.accName(el).name) continue;
    if (explicit === 'img') {
      A.add({ test: '7.A', impact: 'serious', el, message: `${el.localName === 'svg' ? '<svg role="img">' : `role="${explicit}"`} has no accessible name. Name it with aria-label or aria-labelledby${el.localName === 'svg' ? ', or a <title> as its first child' : ''}; if it is decorative, remove the role and hide it with aria-hidden="true".` });
    } else {
      A.add({ test: '5.C', impact: 'serious', el, message: `role="${explicit}" has no accessible name. Name it with aria-label or aria-labelledby${model(explicit).nameFromContent ? ', or give it text content' : ''}.` });
    }
  }

  // ---- Rule 9: aria-activedescendant ----
  // Roles that can be the active descendant: the concrete subclasses of widget.
  const takesFocus = (r) => !!model(r) && !model(r).abstract && aria.isA(r, 'widget');
  for (const host of visible) {
    const id = (host.getAttribute('aria-activedescendant') || '').trim();
    if (!id) continue;
    if (!A.isFocusable(host)) {
      A.add({ test: '4.A', impact: 'serious', el: host, message: `aria-activedescendant is on an element that cannot receive keyboard focus, so keyboard users can never move through its items. Make it focusable (tabindex="0").` });
      continue;
    }
    const target = document.getElementById(id);
    if (!target) {
      A.add({ test: '4.A', impact: 'serious', el: host, message: `aria-activedescendant points at id "${id}", which does not exist, so assistive technology announces no active item.` });
      continue;
    }
    // The target is a descendant, or inside an element the host owns or controls (a combobox's popup).
    const scopes = [host, ...byIds(idList(host, 'aria-owns')), ...byIds(idList(host, 'aria-controls'))];
    if (target === host || !scopes.some((s) => s.contains(target))) {
      A.add({ test: '4.A', impact: 'serious', el: host, message: `aria-activedescendant points at "#${id}", which is not inside this element or an element it owns (aria-owns) or controls (aria-controls), so assistive technology does not treat it as the active item.` });
      continue;
    }
    const r = roleOf(target);
    if (!takesFocus(r)) {
      A.add({ test: '4.A', impact: 'serious', el: host, message: `aria-activedescendant points at "#${id}", which has ${r ? `role ${r}` : 'no role'}; the active descendant must have a widget role (option, treeitem, row, gridcell, menuitem, tab ...) to be announced as the item in focus.` });
    }
  }

  // ---- Rule 10: landmarks (9.A, since Trusted Tester credits landmarks as a bypass) ----
  const LANDMARKS = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search']);
  const landmarks = visible.filter((el) => LANDMARKS.has(roleOf(el)));
  const landmarkAncestor = (el, roles) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (landmarks.includes(p) && (!roles || roles.includes(roleOf(p)))) return p;
    return null;
  };
  const describe = (el) => `<${el.localName}${A.explicitRole(el) ? ` role="${A.explicitRole(el)}"` : ''}>`;
  for (const role of ['main', 'banner', 'contentinfo']) {
    const all = landmarks.filter((el) => roleOf(el) === role);
    for (const el of all.slice(1)) A.add({ test: '9.A', level: 'review', impact: 'moderate', el, message: `The page has ${all.length} ${role} landmarks; there should be one, so users jumping to the ${role} land in the right place.` });
  }
  for (const el of landmarks) {
    const role = roleOf(el);
    if (role === 'banner' || role === 'contentinfo') {
      const p = el.parentElement && el.parentElement.closest('article, aside, main, nav, section, [role="article"], [role="complementary"], [role="main"], [role="navigation"], [role="region"]');
      if (p) A.add({ test: '9.A', level: 'review', impact: 'moderate', el, message: `This ${role} landmark is inside ${describe(p)}; a ${role} belongs to the whole page, at the top level. Remove the role, or move it out.` });
    }
    if (role === 'main') {
      const p = landmarkAncestor(el);
      if (p) A.add({ test: '9.A', level: 'review', impact: 'moderate', el, message: `This main landmark is inside a ${roleOf(p)} landmark (${describe(p)}); main must be at the top level.` });
    }
  }
  // Landmarks of one role a user cannot tell apart: the same accessible name, or none.
  const groups = new Map();
  for (const el of landmarks) {
    const role = roleOf(el);
    if (role === 'main' || role === 'banner' || role === 'contentinfo') continue;
    const name = A.accName(el).name.trim().toLowerCase();
    const key = `${role}|${name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  }
  for (const [key, els] of groups) {
    if (els.length < 2) continue;
    const [role, name] = key.split('|');
    for (const el of els.slice(1)) A.add({ test: '9.A', level: 'review', impact: 'minor', el, message: name ? `${els.length} ${role} landmarks share the name "${name}", so users cannot tell them apart in a list of landmarks. Give each a distinct aria-label.` : `${els.length} ${role} landmarks have no label, so users cannot tell them apart in a list of landmarks. Give each a distinct aria-label.` });
  }
});
