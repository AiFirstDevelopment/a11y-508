// Progress inside a page, for --events: which phase each page in flight is in (loading, checks,
// keyboard, disclosures, frames, zoom, names, discovery), with a count where the
// phase has one. Never more than about five events a second, and at least one every two seconds
// for a page in a long phase, so a watcher always sees the time move.

export const PHASES = ['loading', 'checks', 'keyboard', 'disclosures', 'frames', 'zoom', 'names', 'discovery'];

export function progressReporter(emit, { minGapMs = 200, heartbeatMs = 2000 } = {}) {
  const pages = new Map();
  let last = 0;
  let pending = new Set();
  let timer = null;
  const send = (url) => {
    const s = pages.get(url);
    if (!s) return;
    emit({ url, phase: s.phase, detail: s.detail, elapsedMs: Date.now() - s.t0 });
  };
  const flush = () => {
    timer = null;
    const urls = [...pending];
    pending = new Set();
    if (!urls.length) return;
    // One event per flush: the page whose phase changed first; the rest wait for the next.
    send(urls[0]);
    last = Date.now();
    for (const u of urls.slice(1)) pending.add(u);
    if (pending.size) schedule();
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, Math.max(0, minGapMs - (Date.now() - last)));
    if (timer.unref) timer.unref();
  };
  const mark = (url) => {
    pending.add(url);
    schedule();
  };
  const beat = setInterval(() => {
    for (const [url, s] of pages) if (Date.now() - s.sent >= heartbeatMs) mark(url);
  }, Math.min(500, heartbeatMs));
  if (beat.unref) beat.unref();
  const emitWrapped = emit;
  emit = (e) => {
    const s = pages.get(e.url);
    if (s) s.sent = Date.now();
    emitWrapped(e);
  };
  return {
    start(url) {
      pages.set(url, { t0: Date.now(), phase: 'loading', detail: null, sent: 0 });
      mark(url);
    },
    phase(url, phase, detail = null) {
      const s = pages.get(url);
      if (!s) return;
      const changed = s.phase !== phase;
      s.phase = phase;
      s.detail = detail;
      // A new phase goes out at once (within the rate); a count within a phase rides the heartbeat
      // unless nothing was sent for a while.
      if (changed || Date.now() - s.sent >= minGapMs * 2) mark(url);
    },
    end(url) {
      pages.delete(url);
      pending.delete(url);
    },
    stop() {
      clearInterval(beat);
      if (timer) clearTimeout(timer);
    },
  };
}
