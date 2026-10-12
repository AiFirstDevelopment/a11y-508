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

// A finding from a frame's checks, as part of the page: the frame named, the selector prefixed, the
// rect in the top document's coordinates. The frame's root element has an empty selector of its own.
export function inFrame(f, fr) {
  const out = { ...f, selector: `${fr.path} >>> ${f.selector || 'html'}`, frame: fr.path };
  if (f.rect) out.rect = { ...f.rect, x: Math.round(f.rect.x + fr.offset.x), y: Math.round(f.rect.y + fr.offset.y) };
  return out;
}
