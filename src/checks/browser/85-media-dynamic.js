// Trusted Tester 2.A-2.C (auto-playing/moving/updating), 3.A (flashing), 8.A (time limits),
// 16.A-16.B (audio-only / video-only), 17.A-17.D (synchronized media), 18.A (viewport meta).
window.__a11y508.register(function mediaDynamic(A) {
  const near = (el, re) => {
    const scope = el.closest('figure, section, article, div') || el.parentElement;
    return scope && re.test(A.text(scope));
  };

  for (const m of document.querySelectorAll('audio, video')) {
    const isVideo = m.localName === 'video';
    const autoplay = m.hasAttribute('autoplay') || m.autoplay;
    const muted = m.muted || m.hasAttribute('muted');
    const controls = m.hasAttribute('controls');
    const loop = m.hasAttribute('loop');
    const src = (m.currentSrc || m.getAttribute('src') || (m.querySelector('source') || {}).src || '').slice(0, 200);

    if (autoplay && !muted) {
      if (!controls) A.add({ test: '2.A', impact: 'critical', el: m, message: `${isVideo ? 'Video' : 'Audio'} plays automatically with sound and has no controls to pause it or change the volume.`, details: { src } });
      else A.add({ test: '2.A', level: 'review', impact: 'serious', el: m, message: `${isVideo ? 'Video' : 'Audio'} plays automatically with sound. Confirm it lasts under 3 seconds or can be paused/muted from the start.`, details: { src } });
    }
    if (isVideo && autoplay && muted) {
      A.add({ test: '2.B', level: 'review', impact: 'moderate', el: m, message: `Video auto-plays${loop ? ' and loops' : ''} as moving content. If it lasts more than 5 seconds, the user must be able to pause, stop, or hide it.`, details: { src } });
    }

    if (!isVideo) {
      const transcript = near(m, /transcript/i) || document.querySelector('a[href*="transcript" i]');
      A.add({ test: '16.A', level: 'review', impact: 'serious', el: m, message: transcript ? 'Audio content: a transcript reference was found nearby. Confirm it is accurate and complete.' : 'Audio content with no transcript reference found nearby. Audio-only content requires a text transcript.', details: { src } });
      continue;
    }

    const tracks = Array.from(m.querySelectorAll('track'));
    const captions = tracks.filter((t) => /captions|subtitles/i.test(t.kind || 'subtitles'));
    const descriptions = tracks.filter((t) => /descriptions/i.test(t.kind));
    if (!captions.length) {
      A.add({ test: '17.A', level: 'review', impact: 'serious', el: m, message: 'Video has no captions track (<track kind="captions">). If the video has speech or meaningful audio, captions are required (open captions burned into the video also satisfy this).', details: { src } });
    } else {
      A.add({ test: '17.A', level: 'review', impact: 'moderate', el: m, message: `Video has ${captions.length} caption track(s). Confirm captions are accurate, synchronized, and include relevant sounds.`, details: { src, tracks: captions.map((t) => t.src || t.label) } });
    }
    if (!descriptions.length) {
      A.add({ test: '17.B', level: 'review', impact: 'moderate', el: m, message: 'Video has no audio description track. If visual content is not already conveyed by the soundtrack, audio description (or a described version) is required.', details: { src } });
    }
    if (controls) {
      A.add({ test: '17.D', level: 'review', impact: 'minor', el: m, message: 'Native video controls: Chrome exposes a caption toggle only when a caption track exists and offers no audio-description control. Confirm caption and description controls meet 503.4.', details: { src } });
    } else {
      A.add({ test: '17.D', level: 'review', impact: 'moderate', el: m, message: 'Video has no native controls; a custom player is implied. Confirm caption and audio-description controls exist, are keyboard operable, and sit at the same menu level as volume.', details: { src } });
    }
    if (!tracks.length && !near(m, /transcript|described/i)) {
      A.add({ test: '16.B', level: 'review', impact: 'moderate', el: m, message: 'If this video has no audio track (video-only), it needs an equivalent text or audio alternative.', details: { src } });
    }
  }

  for (const f of document.querySelectorAll('iframe[src]')) {
    const src = f.getAttribute('src') || '';
    if (!/youtube|youtu\.be|vimeo|wistia|brightcove|jwplayer|kaltura|vidyard|dailymotion|soundcloud|spotify|player/i.test(src)) continue;
    if (!A.isVisible(f)) continue;
    const autoplay = /autoplay=1|autoplay=true/i.test(src);
    if (autoplay && !/mute=1|muted=1/i.test(src)) A.add({ test: '2.A', level: 'review', impact: 'serious', el: f, message: 'Embedded media player is set to autoplay. Confirm sound can be paused or muted within 3 seconds.', details: { src: src.slice(0, 200) } });
    A.add({ test: '17.A', level: 'review', impact: 'serious', el: f, message: 'Embedded media player. Confirm the media has accurate captions (17.A), audio description where needed (17.B), and keyboard-operable caption/description controls (17.D-17.F).', details: { src: src.slice(0, 200) } });
  }

  for (const el of document.querySelectorAll('marquee, blink')) {
    A.add({ test: '2.B', impact: 'serious', el, message: `<${el.localName}> scrolls or blinks content with no way to pause it.` });
  }

  let anim = 0;
  let flash = 0;
  for (const el of A.allVisible(5000)) {
    if (anim >= 10 && flash >= 5) break;
    const s = A.cs(el);
    if (!s || !s.animationName || s.animationName === 'none') continue;
    const names = s.animationName.split(',').map((x) => x.trim());
    const counts = s.animationIterationCount.split(',').map((x) => x.trim());
    const durs = s.animationDuration.split(',').map((x) => parseFloat(x) * (/ms$/.test(x.trim()) ? 1 : 1000));
    const states = (s.animationPlayState || '').split(',').map((x) => x.trim());
    for (let i = 0; i < names.length; i++) {
      const infinite = counts[i % counts.length] === 'infinite';
      const d = durs[i % durs.length] || 0;
      if (states[i % states.length] === 'paused' || d === 0) continue;
      if (infinite && d < 400 && flash < 5) {
        flash++;
        A.add({ test: '3.A', level: 'review', impact: 'serious', el, message: `CSS animation "${names[i]}" repeats every ${d}ms indefinitely. If it changes brightness or color it may flash more than 3 times per second; verify.` });
      } else if (infinite && anim < 10) {
        const r = el.getBoundingClientRect();
        if (r.width < 24 && r.height < 24) continue; // spinners
        anim++;
        A.add({ test: '2.B', level: 'review', impact: 'moderate', el, message: `Element animates indefinitely (CSS animation "${names[i]}", ${Math.round(d)}ms per cycle). Moving content that lasts more than 5 seconds needs a pause, stop, or hide control (prefers-reduced-motion alone is not sufficient).` });
      }
    }
  }

  const carousel = document.querySelector('[class*="carousel" i], [class*="slider" i]:not(input), [class*="slideshow" i], [data-ride], .swiper, .slick-slider, [class*="ticker" i]');
  if (carousel && A.isVisible(carousel)) {
    A.add({ test: '2.B', level: 'review', impact: 'moderate', el: carousel, message: 'Carousel/slider detected. If it auto-rotates for more than 5 seconds, confirm a visible, keyboard-operable pause control exists.' });
  }

  for (const meta of document.querySelectorAll('meta[http-equiv="refresh" i]')) {
    const content = meta.getAttribute('content') || '';
    const m = /^\s*(\d+)/.exec(content);
    const delay = m ? parseInt(m[1], 10) : 0;
    if (delay > 0 && /url\s*=/i.test(content)) A.add({ test: '8.A', impact: 'serious', selector: 'meta[http-equiv=refresh]', html: meta.outerHTML, message: `Page redirects automatically after ${delay} seconds (meta refresh). The user cannot turn off or extend this time limit.` });
    else if (delay > 0) A.add({ test: '2.C', impact: 'serious', selector: 'meta[http-equiv=refresh]', html: meta.outerHTML, message: `Page reloads automatically every ${delay} seconds (meta refresh) with no way to pause or control it.` });
  }

  const bodyText = A.text(document.body).slice(0, 200000);
  const tm = /(session (will|is about to|may) (expire|time ?out|end)|(timed? ?out|time ?out|expire)s? (after|in) \d+ ?(minutes?|seconds?)|you will be (logged|signed) out|inactivity)/i.exec(bodyText);
  if (tm) {
    A.add({ test: '8.A', level: 'review', impact: 'moderate', selector: 'body', message: `Page mentions a time limit ("${tm[0]}"). Confirm the user can turn it off, adjust it, or extend it with a simple action before it expires.` });
  }

  const vp = document.querySelector('meta[name="viewport" i]');
  if (vp) {
    const c = (vp.getAttribute('content') || '').toLowerCase();
    const maxScale = /maximum-scale\s*=\s*([\d.]+)/.exec(c);
    if (/user-scalable\s*=\s*(no|0)/.test(c) || (maxScale && parseFloat(maxScale[1]) < 2)) {
      A.add({ test: '18.A', impact: 'moderate', selector: 'meta[name=viewport]', html: vp.outerHTML, message: 'The viewport meta tag disables or limits user zoom (user-scalable=no / maximum-scale < 2), preventing text resize on mobile browsers.' });
    }
  }
});
