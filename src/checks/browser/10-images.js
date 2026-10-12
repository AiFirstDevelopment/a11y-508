// Trusted Tester 7.A-7.D: images, decorative images, background images, CAPTCHA; and 4.A for a
// page hidden from assistive technology and for server-side image maps.
// Rules informed by axe-core and IBM Equal Access; no code taken from either.

// The page is hidden from assistive technology: <body aria-hidden="true">, or an aria-hidden or
// inert element that holds most of the visible text while no modal dialog is open (a modal library
// left it behind). Every other check skips content hidden from assistive technology, so without
// this the page would look clean.
window.__a11y508.register(function hiddenPage(A) {
  const body = document.body;
  if (!body || A.openModal()) return;
  const hides = (el) => (el.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true' || el.hasAttribute('inert');
  const root = [document.documentElement, body].find(hides);
  if (root) {
    const attr = root.hasAttribute('inert') && (root.getAttribute('aria-hidden') || '').trim().toLowerCase() !== 'true' ? 'inert' : 'aria-hidden="true"';
    A.add({ test: '4.A', impact: 'critical', el: root, message: `<${root.localName} ${attr}> hides the whole page from assistive technology: screen reader users get nothing, and every other test on this page is silenced, because the checks skip content hidden from assistive technology. Remove ${attr === 'inert' ? 'inert' : 'aria-hidden'} from <${root.localName}>.` });
    return;
  }
  const total = A.renderedTextLength(body);
  if (!total) return;
  for (const el of body.querySelectorAll('[aria-hidden="true" i], [inert]')) {
    if (el.parentElement && el.parentElement.closest('[aria-hidden="true" i], [inert]')) continue;
    const share = A.renderedTextLength(el) / total;
    if (share < 0.8) continue;
    const attr = (el.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true' ? 'aria-hidden="true"' : 'inert';
    A.add({ test: '4.A', impact: 'critical', el, details: { share: Math.round(share * 100) / 100 }, message: `${A.selector(el)} is ${attr} and holds ${Math.round(share * 100)}% of the page's visible text, while no modal dialog is open: assistive technology gets almost nothing, and every other test on this page is silenced for that content. A modal library probably left ${attr === 'inert' ? 'inert' : 'aria-hidden'} behind when its dialog closed; remove it.` });
    return;
  }
});

window.__a11y508.register(function images(A) {
  const GENERIC = /^(image|img|photo|picture|graphic|graphics|icon|logo|spacer|blank|untitled|placeholder|screenshot|thumbnail|banner|\*|-|_|\.)$/i;
  const FILE = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|ico|avif)(\?.*)?$/i;
  const inventory = [];

  const basename = (src) => {
    try {
      return decodeURIComponent(new URL(src, location.href).pathname.split('/').pop() || '');
    } catch {
      return '';
    }
  };

  for (const img of A.all('img')) {
    if (!A.isVisible(img)) continue;
    const ariaHidden = A.isAriaHidden(img);
    const alt = img.getAttribute('alt');
    const role = (img.getAttribute('role') || '').toLowerCase();
    const { name, source } = A.accName(img);
    const presentational = role === 'presentation' || role === 'none';
    const decorative = presentational || (alt === '' && !name);
    const link = img.closest('a[href], button, [role="button"], [role="link"]');
    const r = img.getBoundingClientRect();

    if (ariaHidden) continue;

    if (img.hasAttribute('ismap')) {
      A.add({ test: '4.A', impact: 'serious', el: img, message: 'Server-side image map (ismap): the regions are chosen by mouse coordinates, so keyboard users cannot operate it. Use a client-side image map (usemap with <area> links) or ordinary links.' });
    }

    if (alt === null && !name && !presentational) {
      A.add({ test: '7.A', impact: 'critical', el: img, message: 'Image has no alt attribute and no accessible name. Add alt text, or alt="" if decorative.' });
      continue;
    }

    if (presentational && alt && alt.trim()) {
      A.add({ test: '7.B', impact: 'moderate', el: img, message: `Image has role="${role}" but also non-empty alt text. Decorative images must not have an accessible name.` });
    } else if (alt === '' && (img.hasAttribute('aria-label') || img.hasAttribute('title') || img.hasAttribute('aria-labelledby'))) {
      A.add({ test: '7.B', impact: 'moderate', el: img, message: 'Image is marked decorative with alt="" but also has a title/aria-label, which gives it an accessible name.' });
    }

    if (decorative) {
      if (link && !A.accName(link).name) {
        // reported by the links check (6.A) with the right context
      } else if (r.width >= 200 && r.height >= 100) {
        A.add({ test: '7.B', level: 'review', impact: 'minor', el: img, message: `Large image (${Math.round(r.width)}x${Math.round(r.height)}) is marked decorative. Confirm it conveys no information.`, details: { src: img.currentSrc || img.src } });
      }
      continue;
    }

    const trimmed = (name || '').trim();
    // The alt repeats the visible text of the link or button around it, so the name is read twice.
    const squash = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    if (link && alt && squash(alt) && squash(alt) === squash(A.text(link))) {
      A.add({ test: '7.A', level: 'review', impact: 'minor', el: img, message: `Alt text "${alt.trim()}" repeats the text of the ${link.localName === 'a' ? 'link' : 'control'} around it, so screen readers announce it twice. Use alt="" if the image adds nothing to the text.` });
    }
    const file = basename(img.currentSrc || img.src || '');
    if (GENERIC.test(trimmed) || FILE.test(trimmed) || (file && trimmed.toLowerCase() === file.toLowerCase()) || /^https?:\/\//i.test(trimmed)) {
      A.add({ test: '7.A', impact: 'serious', el: img, message: `Alt text "${trimmed}" is a filename or generic word and does not describe the image.`, details: { src: img.currentSrc || img.src } });
      continue;
    }
    if (trimmed.length > 150) {
      A.add({ test: '7.A', level: 'review', impact: 'minor', el: img, message: `Alt text is ${trimmed.length} characters. Long descriptions belong in surrounding text or aria-describedby; keep alt concise.`, details: { alt: trimmed } });
    }
    if (inventory.length < 60) {
      inventory.push({ selector: A.selector(img), src: (img.currentSrc || img.src || '').slice(0, 200), alt: trimmed, source, width: Math.round(r.width), height: Math.round(r.height), inLink: !!link });
    }
  }

  if (inventory.length) {
    A.add({
      test: '7.A', level: 'review', impact: 'moderate', selector: 'img',
      message: `${inventory.length} meaningful image(s) have alt text. Confirm each description is equivalent to the image (7.A) and that none are images of text (7.E).`,
      details: { images: inventory },
    });
  }

  for (const el of A.all('input[type="image"]')) {
    if (!A.isVisible(el)) continue;
    if (!A.accName(el).name) A.add({ test: '6.A', impact: 'critical', el, message: 'Image button has no alt text or accessible name.' });
  }
  for (const el of A.all('area[href]')) {
    if (!A.accName(el).name) A.add({ test: '6.A', impact: 'serious', el, message: 'Image map area has no alt text; its link purpose cannot be determined.' });
  }

  let svgCount = 0;
  for (const svg of A.all('svg')) {
    if (svgCount >= 30) break;
    if (!A.isVisible(svg) || A.isAriaHidden(svg)) continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 16 && r.height < 16) continue;
    const inNamed = svg.parentElement && svg.parentElement.closest('a[href], button, [role="button"], [role="link"]');
    if (inNamed && A.accName(inNamed).name) continue;
    const { name } = A.accName(svg);
    const role = svg.getAttribute('role');
    // An unnamed <svg role="img"> is a 7.A violation from 88-aria-structure.js (widget and image names).
    if (!name && role !== 'img') {
      svgCount++;
      A.add({ test: '7.A', level: 'review', impact: 'moderate', el: svg, message: 'Inline SVG has no accessible name and is not hidden from assistive technology. If meaningful add role="img" and a <title>/aria-label; if decorative add aria-hidden="true".' });
    } else if (name) {
      inventory.length < 60 && inventory.push({ selector: A.selector(svg), src: 'inline svg', alt: name, source: 'svg' });
    }
  }

  let iconCount = 0;
  for (const el of A.all('i, span')) {
    if (iconCount >= 20) break;
    const cls = el.className && typeof el.className === 'string' ? el.className : '';
    if (!/(^|\s)(fa|fas|far|fab|fal|fad|glyphicon|material-icons|material-symbols[\w-]*|bi|icon|icon-[\w-]+|fa-[\w-]+|dashicons|oi|ti|mdi)(\s|$)/.test(cls)) continue;
    if (!A.isVisible(el) || A.isAriaHidden(el)) continue;
    if (A.text(el) && !/material/.test(cls)) continue;
    if (el.getAttribute('aria-label') || el.getAttribute('role') === 'img') continue;
    const parent = el.parentElement && el.parentElement.closest('a[href], button, [role="button"], [role="link"], label');
    // A <label> has no role of its own; what matters is whether it holds text.
    if (parent && (parent.localName === 'label' ? A.nameFromContent(parent, false) : A.accName(parent).name)) continue;
    iconCount++;
    A.add({ test: '7.A', level: 'review', impact: 'moderate', el, message: 'Icon-font element is exposed to assistive technology without a name. Add aria-hidden="true" if decorative, or role="img" plus aria-label if it conveys meaning.' });
  }

  // Every loaded <object> needs a text alternative, whatever it embeds: fallback content, a
  // labelling attribute or a title. An image <embed> has no fallback content and is escalated.
  for (const el of A.all('object[data], embed')) {
    if (!A.isVisible(el) || A.isAriaHidden(el)) continue;
    if (el.localName === 'object') {
      if (el.parentElement && el.parentElement.closest('object')) continue; // fallback content of an outer object
      if (!A.accName(el).name && !A.nameFromContent(el, true)) A.add({ test: '7.A', impact: 'serious', el, message: `<object data="${(el.getAttribute('data') || '').slice(0, 80)}"> has no text alternative. Put a description of what it shows as its fallback content (between <object> and </object>), or give it aria-label or a title.` });
      continue;
    }
    const type = (el.getAttribute('type') || '').toLowerCase();
    const data = el.getAttribute('src') || '';
    if (/image|svg/.test(type) || FILE.test(data)) {
      if (!A.accName(el).name) A.add({ test: '7.A', level: 'review', impact: 'moderate', el, message: 'Embedded image (object/embed) has no accessible name. Provide fallback content or aria-label.' });
    }
  }

  if (A.one('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], script[src*="recaptcha" i], script[src*="hcaptcha" i], script[src*="turnstile" i], [class*="captcha" i], [id*="captcha" i], img[src*="captcha" i]')) {
    A.add({ test: '7.D', level: 'review', impact: 'serious', selector: '[captcha]', message: 'CAPTCHA detected. Confirm an alternative form (e.g. audio CAPTCHA, or a non-visual verification method) is available.' });
  }

  let bgCount = 0;
  for (const el of A.allVisible(4000)) {
    if (bgCount >= 20) break;
    const s = A.cs(el);
    if (!s || !s.backgroundImage || s.backgroundImage === 'none' || !/url\(/.test(s.backgroundImage)) continue;
    if (/gradient\(/.test(s.backgroundImage) && !/url\(/.test(s.backgroundImage)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 48 || r.height < 48) continue;
    if (A.text(el)) continue;
    if (el.querySelector('img, svg, video, canvas')) continue;
    if (A.isAriaHidden(el)) continue;
    const { name } = A.accName(el);
    if (name) {
      inventory.length < 60 && inventory.push({ selector: A.selector(el), src: 'css background', alt: name, source: 'css' });
      continue;
    }
    if (el.closest('a[href], button') && A.accName(el.closest('a[href], button')).name) continue;
    bgCount++;
    A.add({ test: '7.C', level: 'review', impact: 'moderate', el, message: `Element (${Math.round(r.width)}x${Math.round(r.height)}) shows a CSS background image and contains no text. If the image conveys information, provide it in text or as an <img> with alt.`, details: { backgroundImage: s.backgroundImage.slice(0, 200) } });
  }
});
