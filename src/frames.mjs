// Same-origin frames are audited as part of the page they appear in. Each frame's checks run in the
// frame's own execution context (found through CDP: DOM.describeNode on the iframe element names the
// frame, and Runtime's context events give its main world), so the in-page helpers use the frame's
// own document and window: getComputedStyle, elementsFromPoint and getBoundingClientRect need no
// change. What is found there is attributed to the frame, with selectors prefixed by the frame's
// selector and rects moved into the top document's coordinates.

export const MAX_FRAME_DEPTH = 3;

// The auditable frames of the page, outermost first:
// frames: [{ path, depth, contextId, offset: { x, y } }], path being the frame element's selector,
// prefixed by its parent frames' (" >>> " between them). crossOrigin: labels of frames from other
// origins, which cannot be read. deep: same-origin frames nested deeper than maxDepth.
export async function discoverFrames(page, { maxDepth = MAX_FRAME_DEPTH } = {}) {
  const frames = [];
  const crossOrigin = [];
  let deep = 0;
  const visit = async (contextId, prefix, depth, offset) => {
    const list = await page.evaluate('window.__a11y508.frameCandidates()', { contextId });
    for (const c of list || []) {
      if (c.skip) continue;
      if (!c.sameOrigin) {
        crossOrigin.push(c.label);
        continue;
      }
      if (depth > maxDepth) {
        deep++;
        continue;
      }
      const ctx = await page.frameContext(`window.__a11y508.frameEls[${c.i}]`, contextId);
      if (!ctx) continue;
      try {
        await page.ensureInjected(ctx);
      } catch {
        continue;
      }
      const scroll = (await page.evaluate('window.__a11y508.scrollPosition()', { contextId: ctx }).catch(() => null)) || { x: 0, y: 0 };
      // offset: from the frame's document coordinates to the top document's, at the frame's scroll
      // when found (scroll), which the audit's checks restore; a Tab sample brings its own.
      const fr = { path: prefix + c.selector, depth, contextId: ctx, scroll, offset: { x: offset.x + c.x - scroll.x, y: offset.y + c.y - scroll.y } };
      frames.push(fr);
      await visit(ctx, fr.path + ' >>> ', depth + 1, fr.offset);
    }
  };
  await visit(undefined, '', 1, { x: 0, y: 0 });
  return { frames, crossOrigin, deep };
}

// The selector of the page-level 13.C item (60-sensory-contrast.js): one per page, frames included.
export const BETWEEN_IMAGES = 'text over images';

// Keys in a finding's details that hold one selector, or a list of selectors, of the frame's
// document (besides "selector" at any depth, which always does).
const SELECTOR_KEYS = new Set(['near', 'descendant']);
const SELECTOR_LISTS = new Set(['labels', 'frames']);

// The details of a frame's finding with every selector in them prefixed by the frame's path.
function prefixDetails(v, prefix, key) {
  if (Array.isArray(v)) return v.map((x) => (SELECTOR_LISTS.has(key) && typeof x === 'string' ? prefix + x : prefixDetails(x, prefix)));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = typeof x === 'string' && (k === 'selector' || SELECTOR_KEYS.has(k)) && x ? prefix + x : prefixDetails(x, prefix, k);
  }
  return out;
}

// A finding from a frame's checks, as part of the page: the frame named, the selectors prefixed
// (its own and those in its details), the rect in the top document's coordinates. The frame's root
// element has an empty selector of its own. The page-level "text over images" item keeps its
// selector, so it merges with the page's; each of its elements names the frame instead.
export function inFrame(f, fr) {
  const prefix = `${fr.path} >>> `;
  const between = f.test === '13.C' && f.selector === BETWEEN_IMAGES;
  const out = { ...f, selector: between ? f.selector : prefix + (f.selector || 'html'), frame: between ? undefined : fr.path };
  if (f.details) {
    out.details = prefixDetails(f.details, prefix);
    if (between && Array.isArray(out.details.elements)) out.details.elements = out.details.elements.map((e) => ({ ...e, frame: fr.path }));
  }
  if (between) out.message = f.message.replace(/Check each visually: .*$/, `Check each visually: ${(out.details.elements || []).slice(0, 20).map((e) => e.selector).join(', ')}${out.details.total > 20 ? ` and ${out.details.total - 20} more` : ''}.`);
  if (f.rect) out.rect = { ...f.rect, x: Math.round(f.rect.x + fr.offset.x), y: Math.round(f.rect.y + fr.offset.y) };
  return out;
}
