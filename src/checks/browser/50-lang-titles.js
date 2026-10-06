// Trusted Tester 11.A-11.B (language), 12.A-12.D (titles, frames).
window.__a11y508.register(function langTitles(A) {
  const BCP47 = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
  const html = document.documentElement;
  const lang = (html.getAttribute('lang') || '').trim();
  if (!lang) {
    A.add({ test: '11.A', impact: 'critical', el: html, message: 'The <html> element has no lang attribute, so the page language cannot be determined.' });
  } else if (!BCP47.test(lang)) {
    A.add({ test: '11.A', impact: 'serious', el: html, message: `lang="${lang}" is not a valid language tag (e.g. "en", "en-US", "es").` });
  }
  const xmlLang = html.getAttribute('xml:lang');
  if (xmlLang && lang && xmlLang.toLowerCase() !== lang.toLowerCase()) {
    A.add({ test: '11.A', impact: 'minor', el: html, message: `lang="${lang}" and xml:lang="${xmlLang}" disagree.` });
  }

  for (const el of document.querySelectorAll('[lang]')) {
    if (el === html) continue;
    const v = (el.getAttribute('lang') || '').trim();
    if (v && !BCP47.test(v)) A.add({ test: '11.B', impact: 'moderate', el, message: `lang="${v}" is not a valid language tag.` });
  }

  const title = (document.title || '').trim();
  const titleEl = document.querySelector('title');
  if (!titleEl || !title) {
    A.add({ test: '12.A', impact: 'critical', selector: 'head > title', message: 'The page has no <title> or the title is empty.' });
  } else {
    const GENERIC = /^(untitled|untitled document|home|home page|index|document|new page|page|welcome|website|site|title|default|\.|-|_)$/i;
    if (GENERIC.test(title) || title.toLowerCase() === location.hostname.toLowerCase()) {
      A.add({ test: '12.B', impact: 'serious', selector: 'head > title', message: `Page title "${title}" does not identify the page content or purpose.` });
    }
  }

  for (const f of document.querySelectorAll('frame')) {
    if (!(f.getAttribute('title') || '').trim()) A.add({ test: '12.C', impact: 'serious', el: f, message: '<frame> has no title attribute.' });
  }

  const inventory = [];
  const GENERIC_IFRAME = /^(iframe|frame|embed|embedded content|content|widget|video|map|untitled)$/i;
  for (const f of document.querySelectorAll('iframe')) {
    const s = A.cs(f);
    const r = f.getBoundingClientRect();
    const hidden = !s || s.display === 'none' || s.visibility === 'hidden' || (r.width <= 1 && r.height <= 1) || f.closest('[hidden]');
    if (hidden) continue; // tracking/zero-size iframes are not perceivable
    if (A.isAriaHidden(f)) continue;
    const { name } = A.accName(f);
    if (!name) {
      A.add({ test: '12.D', impact: 'serious', el: f, message: 'iframe has no title/aria-label describing its content.', details: { src: (f.getAttribute('src') || '').slice(0, 200) } });
    } else if (GENERIC_IFRAME.test(name)) {
      A.add({ test: '12.D', impact: 'serious', el: f, message: `iframe title "${name}" does not describe its content.`, details: { src: (f.getAttribute('src') || '').slice(0, 200) } });
    } else {
      inventory.push({ selector: A.selector(f), title: name, src: (f.getAttribute('src') || '').slice(0, 200) });
    }
  }
  if (inventory.length) {
    A.add({ test: '12.D', level: 'review', impact: 'minor', selector: 'iframe', message: `${inventory.length} iframe(s) have titles. Confirm each title describes the frame content.`, details: { iframes: inventory } });
  }
});
