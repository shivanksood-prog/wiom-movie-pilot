/* Wiom Movie Pilot — player. Shaka Player (DASH/HLS + EME) with our own wiom.tv controls.
 * DRM: "clearkey" (licence = our backend, header x-play-session) or "widevine" (Axinom token in
 * X-AxDRM-Message) + FairPlay for Safari — chosen from the /api/playback/start response.
 *
 *   const p = new WiomPlayer(rootEl, ctx); await p.start(); … p.destroy();
 *   ctx = {api, cfg, film, deviceId, token(), panel, toast(msg,kind), go(route)}
 */
(function () {
  'use strict';

  var ICON = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    back10: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
    fwd10: 'M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    pip: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    hd: 'M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm2-6h4c.55 0 1 .45 1 1v4c0 .55-.45 1-1 1h-4V9zm1.5 4.5h2v-3h-2v3z',
    speed: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
    back: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  };
  var svg = function (k) {
    var label = k === 'back10' || k === 'fwd10' ? '<text x="12" y="16.2" text-anchor="middle" font-size="6.6" font-weight="800" font-family="Noto Sans,system-ui,sans-serif">10</text>' : '';
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + ICON[k] + '"/>' + label + '</svg>';
  };
  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  var LS = { get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
             set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } } };

  function fmt(t, longForm) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var mm = String(m).padStart(h || longForm ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h || longForm ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }
  function isSafari() { var ua = navigator.userAgent; return /^((?!chrome|android|crios|fxios).)*safari/i.test(ua) || /iPad|iPhone|iPod/.test(ua); }
  function hostOf(u) { try { return new URL(u, location.href).host; } catch (e) { return '—'; } }

  function WiomPlayer(root, ctx) {
    this.root = root; this.ctx = ctx; this.film = ctx.film || {};
    this.parts = (this.film.parts || []).slice().sort(function (a, b) { return a.start - b.start; });
    this.timers = []; this.cleanup = []; this.thumbs = []; this.state = 'idle';
    this.lastSegUrl = ''; this.licT0 = 0; this.uiTimer = 0; this.dragging = false;
    this.build();
  }
  var P = WiomPlayer.prototype;

  /* ---------------- DOM ---------------- */
  P.build = function () {
    var r = this.root;
    r.innerHTML =
      '<div class="wp" tabindex="0" aria-label="वीडियो प्लेयर" role="region">' +
        '<video playsinline preload="auto"></video>' +
        '<div class="poster"></div>' +
        '<div class="wp-tap"></div><div class="wp-grad"></div>' +
        '<div class="wp-top">' +
          '<button class="cbtn" data-a="exit" aria-label="वापस">' + svg('back') + '</button>' +
          '<div class="wp-title"><span class="wp-ttl"></span><small class="wp-part"></small></div>' +
          '<span class="pill wp-rental" hidden><span class="dot"></span><span class="v"></span></span>' +
        '</div>' +
        '<div class="wp-center">' +
          '<button class="cbtn mid" data-a="back10" aria-label="10 सेकंड पीछे">' + svg('back10') + '</button>' +
          '<button class="cbtn big" data-a="toggle" aria-label="चलाएँ">' + svg('play') + '</button>' +
          '<button class="cbtn mid" data-a="fwd10" aria-label="10 सेकंड आगे">' + svg('fwd10') + '</button>' +
        '</div>' +
        '<div class="wp-bottom">' +
          '<div class="wp-scrub" role="slider" tabindex="0" aria-label="वीडियो की जगह" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">' +
            '<div class="wp-track"><div class="wp-buf"></div><div class="wp-prog"></div><div class="wp-ticks"></div><div class="wp-knob"></div></div>' +
            '<div class="wp-preview"><div class="wp-thumb none"></div><div class="wp-pchap"></div><div class="wp-ptime">0:00</div></div>' +
          '</div>' +
          '<div class="wp-row">' +
            '<button class="cbtn wp-hide-sm" data-a="toggle" aria-label="चलाएँ">' + svg('play') + '</button>' +
            '<button class="cbtn wp-hide-sm" data-a="back10" aria-label="10 सेकंड पीछे">' + svg('back10') + '</button>' +
            '<button class="cbtn wp-hide-sm" data-a="fwd10" aria-label="10 सेकंड आगे">' + svg('fwd10') + '</button>' +
            '<div class="wp-vol"><button class="cbtn" data-a="mute" aria-label="म्यूट">' + svg('vol') + '</button>' +
              '<input type="range" min="0" max="1" step="0.05" value="1" aria-label="आवाज़"></div>' +
            '<span class="wp-time"><span class="cur">0:00</span> / <span class="dur">0:00</span></span>' +
            '<span class="wp-spacer"></span>' +
            '<button class="wp-next" data-a="next" hidden>अगला भाग ›</button>' +
            '<button class="cbtn" data-a="chapters" aria-label="भाग (C)" aria-haspopup="menu">' + svg('list') + '</button>' +
            '<button class="cbtn" data-a="speed" aria-label="स्पीड" aria-haspopup="menu">' + svg('speed') + '</button>' +
            '<button class="cbtn" data-a="quality" aria-label="क्वालिटी" aria-haspopup="menu">' + svg('hd') + '</button>' +
            '<button class="cbtn wp-hide-sm" data-a="pip" aria-label="पिक्चर-इन-पिक्चर">' + svg('pip') + '</button>' +
            '<button class="cbtn" data-a="fs" aria-label="फ़ुलस्क्रीन (F)">' + svg('fs') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="wp-spinner" hidden></div>' +
      '</div>';
    var q = function (s) { return r.querySelector(s); };
    this.wrap = q('.wp'); this.video = q('video'); this.posterEl = q('.poster');
    this.scrub = q('.wp-scrub'); this.prog = q('.wp-prog'); this.buf = q('.wp-buf'); this.knob = q('.wp-knob');
    this.ticks = q('.wp-ticks'); this.preview = q('.wp-preview'); this.thumbEl = q('.wp-thumb'); this.ptime = q('.wp-ptime'); this.pchap = q('.wp-pchap');
    this.curEl = q('.cur'); this.durEl = q('.dur'); this.spinner = q('.wp-spinner'); this.rental = q('.wp-rental');
    this.partEl = q('.wp-part'); this.nextBtn = q('.wp-next'); this.volRange = q('.wp-vol input');
    q('.wp-ttl').textContent = this.film.title || '';
    if (this.film.poster) this.posterEl.style.backgroundImage = 'url("' + this.film.poster + '")';
    if (!document.pictureInPictureEnabled) r.querySelector('[data-a="pip"]').hidden = true;
    var savedVol = LS.get('wp_vol');
    if (savedVol) { this.video.volume = savedVol.v; this.video.muted = !!savedVol.m; this.volRange.value = savedVol.v; }
    this.bind();
    this.showUI();
  };

  P.on = function (target, ev, fn, opt) { target.addEventListener(ev, fn, opt); this.cleanup.push(function () { target.removeEventListener(ev, fn, opt); }); };
  P.every = function (ms, fn) { this.timers.push(setInterval(fn, ms)); };

  P.bind = function () {
    var self = this, v = this.video;
    this.on(this.wrap, 'click', function (e) {
      var b = e.target.closest('[data-a]');
      if (b) { e.stopPropagation(); self.action(b.dataset.a, b); return; }
      if (!e.target.closest('.wp-menu')) self.closeMenu();
    });
    // tap layer: mouse = click toggles play / dblclick fullscreen; touch = tap toggles UI / double-tap seeks
    var tap = this.root.querySelector('.wp-tap'), lastTap = { t: 0, side: '' }, single = 0, combo = 0;
    this.on(tap, 'pointerup', function (e) {
      if (self.menu) { self.closeMenu(); return; }
      var rect = tap.getBoundingClientRect(), x = e.clientX - rect.left;
      var side = x < rect.width * 0.38 ? 'l' : x > rect.width * 0.62 ? 'r' : 'c';
      var now = performance.now();
      if (e.pointerType === 'mouse') {
        if (now - lastTap.t < 300) { clearTimeout(single); self.toggleFs(); lastTap.t = 0; return; }
        lastTap.t = now;
        single = setTimeout(function () { self.togglePlay(); }, 220);
        return;
      }
      if (now - lastTap.t < 320 && side !== 'c' && side === lastTap.side) {
        clearTimeout(single); combo += 10;
        self.seekBy(side === 'l' ? -10 : 10, true);
        self.ripple(side, (side === 'l' ? '−' : '+') + combo + ' सेकंड');
        lastTap = { t: now, side: side };
        return;
      }
      combo = 0; lastTap = { t: now, side: side };
      clearTimeout(single);
      single = setTimeout(function () {
        if (self.wrap.classList.contains('ui')) self.hideUI(true); else self.showUI();
      }, 280);
      if (side !== 'c') combo = 10;
    });
    this.on(this.wrap, 'pointermove', function (e) { if (e.pointerType === 'mouse') self.showUI(); });
    this.on(this.wrap, 'mouseleave', function () { if (!v.paused && !self.menu) self.hideUI(); });

    // video state
    ['play', 'playing', 'pause'].forEach(function (ev) { self.on(v, ev, function () { self.syncPlay(); }); });
    this.on(v, 'timeupdate', function () { self.onTime(); });
    this.on(v, 'durationchange', function () { self.layoutTicks(); self.onTime(); });
    this.on(v, 'progress', function () { self.drawBuffer(); });
    this.on(v, 'waiting', function () { self.setBuffering(true); });
    this.on(v, 'playing', function () { self.setBuffering(false); self.wrap.classList.add('started'); });
    this.on(v, 'canplay', function () { self.setBuffering(false); });
    this.on(v, 'volumechange', function () { self.syncVol(); });
    this.on(v, 'ratechange', function () { if (self.state === 'ready' && v.playbackRate !== self.lastRate) self.osd(v.playbackRate + 'x'); self.lastRate = v.playbackRate; });
    this.on(v, 'ended', function () { self.onEnded(); });
    this.on(v, 'enterpictureinpicture', function () { self.ctx.panel.clientEvent('pip', 'picture-in-picture on'); });

    this.on(this.volRange, 'input', function () { v.volume = Number(self.volRange.value); v.muted = v.volume === 0; });

    // scrub bar: pointer + keyboard
    var sc = this.scrub;
    var pos = function (e) { var r = sc.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
    this.on(sc, 'pointerdown', function (e) {
      if (!self.duration()) return;
      self.dragging = true; sc.classList.add('drag'); sc.setPointerCapture(e.pointerId);
      self.hover(pos(e)); self.paintProgress(pos(e) * self.duration());
    });
    this.on(sc, 'pointermove', function (e) {
      if (!self.duration()) return;
      sc.classList.add('hover'); self.hover(pos(e));
      if (self.dragging) self.paintProgress(pos(e) * self.duration());
    });
    this.on(sc, 'pointerup', function (e) {
      if (!self.dragging) return;
      self.dragging = false; sc.classList.remove('drag');
      self.seekTo(pos(e) * self.duration());
    });
    this.on(sc, 'pointercancel', function () { self.dragging = false; sc.classList.remove('drag'); });
    this.on(sc, 'pointerleave', function () { sc.classList.remove('hover'); });
    this.on(sc, 'keydown', function (e) {
      var d = { ArrowLeft: -10, ArrowRight: 10, PageDown: -60, PageUp: 60 }[e.key];
      if (d) { e.preventDefault(); e.stopPropagation(); self.seekBy(d); }
      if (e.key === 'Home') { e.preventDefault(); self.seekTo(0); }
      if (e.key === 'End') { e.preventDefault(); self.seekTo(self.duration() - 5); }
    });

    this.on(document, 'keydown', function (e) { self.onKey(e); });
    this.on(document, 'fullscreenchange', function () { self.syncFs(); });
    this.on(document, 'webkitfullscreenchange', function () { self.syncFs(); });
    this.on(document, 'visibilitychange', function () { if (document.visibilityState === 'hidden') self.saveLocal(); });
    this.on(window, 'pagehide', function () { self.stopSession(true); });
  };

  /* ---------------- session + shaka ---------------- */
  P.start = async function (opts) {
    opts = opts || {};
    var self = this, ctx = this.ctx, panel = ctx.panel;
    this.clearMsg(); this.setBuffering(true); this.state = 'starting';
    if (!window.shaka) return this.fail({ t: 'प्लेयर लोड नहीं हुआ', s: 'इंटरनेट चेक करके फिर कोशिश करें', code: 'shaka_missing', retry: true });
    shaka.polyfill.installAll();
    // Axinom FairPlay on Safari/iOS needs the webkit-prefixed EME polyfill installed explicitly
    // (multi-key FairPlay fails with shaka error 3016 otherwise) — per Axinom's Shaka guide.
    if (isSafari() && !window.__wiomApplePolyfilled && shaka.polyfill.PatchedMediaKeysApple && shaka.polyfill.PatchedMediaKeysApple.install) {
      try { shaka.polyfill.PatchedMediaKeysApple.install(true); window.__wiomApplePolyfilled = true; } catch (e) { /* older shaka */ }
    }
    if (!shaka.Player.isBrowserSupported()) return this.fail({ t: 'यह ब्राउज़र सपोर्टेड नहीं है', s: 'Chrome या नया ब्राउज़र इस्तेमाल करें', code: 'browser_unsupported' });

    var s;
    try {
      s = await ctx.api('POST', '/api/playback/start', { film_id: ctx.cfg.FILM_ID, device_id: ctx.deviceId });
    } catch (e) { return this.apiFail(e); }
    if (this.destroyed) return;
    this.session = s;
    this.psid = s.play_session_id;
    this.expiresAt = s.expires_at ? Date.parse(s.expires_at) : null;
    var mode = ctx.cfg.DRM_MODE === 'auto' ? (s.drm && s.drm.mode) : ctx.cfg.DRM_MODE;
    this.mode = mode;
    var safari = isSafari();
    var manifest = s.manifest || {};
    if (typeof manifest === 'string') manifest = /\.m3u8/.test(manifest) ? { hls: manifest } : { dash: manifest };
    var useHls = (safari && manifest.hls) || !manifest.dash;
    var url = useHls ? (manifest.hls || ctx.cfg.MEDIA_BASE + 'master.m3u8') : (manifest.dash || ctx.cfg.MEDIA_BASE + 'manifest.mpd');
    this.manifestUrl = url;

    if (this.player) { try { await this.player.destroy(); } catch (e) { /* already gone */ } }
    var player = new shaka.Player();
    await player.attach(this.video);
    this.player = player;

    var drm = { servers: {}, advanced: {}, retryParameters: { maxAttempts: 2, baseDelay: 500, backoffFactor: 2, timeout: 15000 } };
    if (mode === 'clearkey') {
      drm.servers['org.w3.clearkey'] = s.drm.license_url;
    } else if (mode === 'widevine') {
      drm.servers['com.widevine.alpha'] = s.drm.license_url;
      drm.advanced['com.widevine.alpha'] = { videoRobustness: ['SW_SECURE_CRYPTO'], audioRobustness: ['SW_SECURE_CRYPTO'] };
      if (s.drm.fairplay) {
        // both key-system ids: 'com.apple.fps' (modern EME) and 'com.apple.fps.1_0' (webkit-prefixed polyfill)
        ['com.apple.fps', 'com.apple.fps.1_0'].forEach(function (ks) {
          drm.servers[ks] = s.drm.fairplay.license_url;
          drm.advanced[ks] = { serverCertificateUri: s.drm.fairplay.certificate_url };
        });
      }
    }
    var retry = { maxAttempts: 4, baseDelay: 600, backoffFactor: 2, fuzzFactor: 0.5, timeout: 20000 };
    player.configure({
      drm: drm,
      streaming: { bufferingGoal: 30, rebufferingGoal: 2, bufferBehind: 30, retryParameters: retry, stallEnabled: true },
      manifest: { retryParameters: retry },
      abr: { enabled: true, defaultBandwidthEstimate: 1200000, switchInterval: 6 },
    });
    var FP = (shaka.drm && shaka.drm.FairPlay) || (shaka.util && shaka.util.FairPlayUtils);
    if (mode === 'widevine' && safari && FP && FP.initDataTransform) {
      // shaka invokes the transform as (initData, initDataType, drmInfo); the FairPlay helper
      // wants (initData, contentId, certBytes) — wrap it, and only touch 'skd' init data.
      try {
        player.configure('drm.initDataTransform', function (initData, initDataType, drmInfo) {
          if (initDataType !== 'skd') return initData;
          var contentId = FP.defaultGetContentId ? FP.defaultGetContentId(initData) : '';
          var cert = drmInfo && drmInfo.serverCertificate;
          return FP.initDataTransform(initData, contentId, cert);
        });
      } catch (e) { /* older shaka */ }
    }

    var net = player.getNetworkingEngine(), RT = shaka.net.NetworkingEngine.RequestType;
    net.registerRequestFilter(function (type, req) {
      if (type === RT.LICENSE) {
        self.licT0 = performance.now();
        if (mode === 'clearkey') { req.headers['x-play-session'] = self.psid; var tok = ctx.token(); if (tok) req.headers['Authorization'] = 'Bearer ' + tok; }
        else if (mode === 'widevine') req.headers['X-AxDRM-Message'] = s.drm.token;
        if (mode === 'widevine' && req.uris[0] && /fairplay|fps/i.test(req.uris[0])) req.headers['Content-Type'] = 'application/octet-stream';
      } else if (type === RT.SEGMENT) {
        self.lastSegUrl = req.uris[0];
      }
    });
    net.registerResponseFilter(function (type, res) {
      if (type !== RT.LICENSE || mode !== 'clearkey') return;
      // our licence JSON also carries `events`; show them and hand the CDM only {keys, type}
      try {
        var obj = JSON.parse(new TextDecoder().decode(res.data));
        panel.logCall({ method: 'POST', path: '/api/license/clearkey', status: res.status || 200, ms: performance.now() - self.licT0, events: obj.events || [] });
        self.keyReleased = true;
        res.data = new TextEncoder().encode(JSON.stringify({ keys: obj.keys, type: obj.type || 'temporary' })).buffer;
      } catch (e) { /* non-JSON licence: pass through */ }
    });

    player.addEventListener('error', function (ev) { self.onShakaError(ev.detail); });
    player.addEventListener('buffering', function (ev) { self.setBuffering(ev.buffering); });
    player.addEventListener('adaptation', function () { self.onVariant('abr'); });
    player.addEventListener('variantchanged', function () { self.onVariant('manual'); });
    player.addEventListener('keystatuschanged', function () { self.refreshKeys(); });

    // resume: max(server, local) unless near the end
    var local = LS.get('wp_resume_' + ctx.cfg.FILM_ID);
    var serverPos = Number(s.resume_at) || 0, localPos = local && local.pos || 0;
    var startAt = opts.at != null ? opts.at : Math.max(serverPos, localPos);
    var dur = this.film.duration || 0;
    if (dur && startAt > dur - 20) startAt = 0;
    if (startAt < 5) startAt = 0;

    panel.setStats({ drm: { v: mode === 'clearkey' ? 'ClearKey · org.w3.clearkey' : 'Widevine' + (safari ? ' / FairPlay' : '') + ' (Axinom)', cls: 'ok' },
      session: this.psid, manifest: (useHls ? 'HLS ' : 'DASH ') + hostOf(url), keys: { v: 'awaiting licence…', cls: 'warn' }, lease: { v: 'held · 90 s', cls: 'ok' } });
    panel.clientEvent('player.load', (useHls ? 'HLS' : 'DASH') + ' manifest from ' + hostOf(url) + (startAt ? ' · resume ' + fmt(startAt) : ''), true, 'shaka ' + shaka.Player.version);

    try {
      await player.load(url, startAt || null);
    } catch (e) {
      if (this.destroyed) return;
      return this.onShakaError(e);
    }
    if (this.destroyed) return;
    this.state = 'ready';
    this.layoutTicks(); this.loadThumbs(); this.onVariant('init'); this.refreshKeys();
    if (startAt) this.showResume(startAt);
    this.mediaSession();
    try { await this.video.play(); }
    catch (e) { this.setBuffering(false); this.syncPlay(); this.showUI(); /* autoplay blocked → big play button */ }

    // heartbeat (renews 90 s lease, saves resume)
    var hb = Math.max(5, Number(s.heartbeat_s) || 30) * 1000;
    this.timers.forEach(clearInterval); this.timers = [];
    this.every(hb, function () { self.heartbeat(); });
    this.every(1000, function () { self.tickStats(); });
    this.every(5000, function () { self.saveLocal(); });
    this.every(15000, function () { self.paintRental(); });
    this.paintRental();
  };

  P.heartbeat = async function () {
    if (!this.psid || this.state !== 'ready') return;
    var ps = this.psid;
    try {
      var r = await this.ctx.api('POST', '/api/playback/heartbeat', { play_session_id: ps, position: this.video.currentTime });
      if (r.expires_at) { this.expiresAt = Date.parse(r.expires_at); this.paintRental(); }
      this.ctx.panel.setStats({ heartbeat: { v: 'ok ' + new Date().toLocaleTimeString('en-GB'), cls: 'ok' }, lease: { v: 'renewed · 90 s', cls: 'ok' } });
    } catch (e) {
      if (ps !== this.psid) return;
      if (e.status === 409) return this.streamTaken(e);
      if (e.status === 403) return this.fail({ t: 'फ़िल्म का समय खत्म हो गया', s: 'नया पैक लेकर फिर देखें', code: e.code, offer: true, unload: true });
      if (e.status === 401) return this.fail({ t: 'लॉगिन खत्म हो गया', s: 'फिर से लॉगिन करें', code: 'unauthorized', login: true, unload: true });
      this.ctx.panel.setStats({ heartbeat: { v: 'retrying (' + (e.code || e.status) + ')', cls: 'warn' } });
    }
  };

  P.streamTaken = function (e) {
    this.ctx.panel.setStats({ lease: { v: 'lost — other device', cls: 'bad' }, heartbeat: { v: '409 stream_taken', cls: 'bad' } });
    var at = this.video.currentTime;
    this.psid = null;
    this.unload();
    this.fail({ ic: '📱', t: 'यह फ़िल्म किसी दूसरे डिवाइस पर चल रही है', s: 'एक नंबर पर एक समय में एक ही स्क्रीन चलती है। यहाँ देखने पर दूसरी स्क्रीन रुक जाएगी।',
      code: '409 ' + (e && e.code || 'stream_taken'), takeover: at });
  };

  P.stopSession = function (beacon) {
    if (!this.psid) return;
    var body = { play_session_id: this.psid, position: this.video.currentTime || 0 };
    this.saveLocal();
    this.psid = null;
    this.ctx.panel.setStats({ lease: { v: 'released', cls: 'warn' } });
    this.ctx.api('POST', '/api/playback/stop', body, { keepalive: !!beacon }).catch(function () { /* lease expires in 90 s anyway */ });
  };

  P.unload = function () {
    this.state = 'stopped';
    this.timers.forEach(clearInterval); this.timers = [];
    try { this.video.pause(); } catch (e) { /* ignore */ }
    if (this.player) { var p = this.player; this.player = null; p.destroy().catch(function () {}); }
    this.ctx.panel.setStats({ keys: { v: 'released', cls: 'warn' } });
  };

  P.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSession(false);
    this.unload();
    this.cleanup.forEach(function (f) { f(); }); this.cleanup = [];
    if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; } catch (e) { /* ignore */ } }
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    this.root.innerHTML = '';
  };

  /* ---------------- errors ---------------- */
  P.apiFail = function (e) {
    this.setBuffering(false);
    if (e.status === 401) return this.fail({ t: 'पहले लॉगिन करें', s: 'फ़िल्म आपके नंबर से जुड़ी है', code: 'unauthorized', login: true });
    if (e.status === 403) return this.fail({ t: e.code === 'expired' ? 'फ़िल्म का समय खत्म हो गया' : 'यह फ़िल्म अभी अनलॉक नहीं है', s: '₹14 Net पैक के साथ फ़िल्म फ्री', code: e.code, offer: true });
    if (e.status === 409) return this.streamTaken(e);
    return this.fail({ t: 'फ़िल्म शुरू नहीं हो पाई', s: e.status === 0 ? 'इंटरनेट कनेक्शन चेक करें' : 'थोड़ी देर में फिर कोशिश करें', code: (e.status || 'net') + ' ' + (e.code || ''), retry: true });
  };

  P.onShakaError = function (err) {
    if (this.destroyed || !err) return;
    var C = shaka.util.Error.Code, cat = err.category, code = err.code;
    // licence HTTP errors: surface backend events + map status
    var httpStatus = null, inner = err;
    if (code === C.LICENSE_REQUEST_FAILED && err.data && err.data[0]) inner = err.data[0];
    if (inner && inner.code === C.BAD_HTTP_STATUS) {
      httpStatus = inner.data[1];
      var isLic = inner.data[4] === shaka.net.NetworkingEngine.RequestType.LICENSE;
      if (isLic) {
        try { var body = JSON.parse(inner.data[2]); this.ctx.panel.logCall({ method: 'POST', path: '/api/license/clearkey', status: httpStatus, ms: performance.now() - this.licT0, events: body.events || [] }); } catch (e) { /* not JSON */ }
        this.ctx.panel.setStats({ keys: { v: 'licence denied (' + httpStatus + ')', cls: 'bad' } });
        if (httpStatus === 409) return this.streamTaken({ code: 'licence_stream_taken' });
        if (httpStatus === 403) return this.fail({ t: 'फ़िल्म अभी अनलॉक नहीं है', s: 'लाइसेंस नहीं मिला', code: 'licence 403', offer: true, unload: true });
      }
    }
    if (err.severity === shaka.util.Error.Severity.RECOVERABLE && cat === shaka.util.Error.Category.NETWORK) {
      this.ctx.panel.clientEvent('network.retry', 'segment fetch failed (' + code + '), shaka retrying', false); return;
    }
    var msg;
    if (cat === shaka.util.Error.Category.DRM) {
      msg = code === C.REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE
        ? { t: 'इस ब्राउज़र में सुरक्षित वीडियो नहीं चलता', s: this.mode === 'clearkey' && isSafari() ? 'Safari ClearKey सपोर्ट नहीं करता — Chrome में खोलें' : 'Chrome या दूसरा ब्राउज़र आज़माएँ' }
        : { t: 'वीडियो अनलॉक नहीं हो पाया', s: 'DRM लाइसेंस में दिक्कत — फिर कोशिश करें' };
    } else if (cat === shaka.util.Error.Category.NETWORK) {
      msg = { t: 'नेटवर्क धीमा है', s: 'इंटरनेट चेक करके फिर कोशिश करें' };
    } else if (cat === shaka.util.Error.Category.MEDIA) {
      msg = { t: 'वीडियो चलाने में दिक्कत', s: 'फिर कोशिश करें' };
    } else {
      msg = { t: 'वीडियो चलाने में दिक्कत', s: 'फिर कोशिश करें' };
    }
    this.ctx.panel.clientEvent('player.error', 'shaka ' + code + ' (category ' + cat + ')', false);
    msg.code = 'shaka ' + code; msg.retry = true; msg.unload = true;
    this.fail(msg);
  };

  P.fail = function (m) {
    var self = this;
    this.setBuffering(false);
    if (m.unload) { var at = this.video.currentTime; this.stopSession(false); this.unload(); m.at = at; }
    this.clearMsg();
    var rt = this.wrap.querySelector('.wp-resume'); if (rt) rt.remove();
    var d = document.createElement('div'); d.className = 'wp-msg'; d.setAttribute('role', 'alert');
    d.innerHTML = '<div class="ic" aria-hidden="true">' + (m.ic || '⚠️') + '</div><div class="t"></div><div class="s"></div><div class="row"></div>' + (m.code ? '<div class="code"></div>' : '');
    d.querySelector('.t').textContent = m.t; d.querySelector('.s').textContent = m.s || '';
    if (m.code) d.querySelector('.code').textContent = m.code;
    var row = d.querySelector('.row');
    var btn = function (label, cls, fn) { var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + cls; b.textContent = label; b.addEventListener('click', fn); row.appendChild(b); return b; };
    if (m.takeover != null) btn('यहाँ देखें', 'primary', function () { self.ctx.panel.clientEvent('lease.takeover', 'user chose to watch on this device'); self.start({ at: m.takeover }); });
    if (m.retry) btn('फिर कोशिश करें', 'primary', function () { self.start({ at: m.at != null ? m.at : self.video.currentTime || null }); });
    if (m.offer) btn('पैक लें', 'primary', function () { self.ctx.go('offer'); });
    if (m.login) btn('लॉगिन करें', 'primary', function () { self.ctx.go('login'); });
    btn('बाहर जाएँ', 'secondary', function () { self.ctx.go('offer'); });
    this.wrap.appendChild(d); this.msgEl = d;
    this.state = 'error';
    var first = row.querySelector('button'); if (first) first.focus({ preventScroll: true });
  };
  P.clearMsg = function () { if (this.msgEl) { this.msgEl.remove(); this.msgEl = null; } };

  /* ---------------- controls ---------------- */
  P.duration = function () { var d = this.video.duration; return isFinite(d) && d > 0 ? d : (this.film.duration || 0); };
  P.action = function (a, el) {
    this.showUI();
    switch (a) {
      case 'toggle': return this.togglePlay();
      case 'back10': return this.seekBy(-10);
      case 'fwd10': return this.seekBy(10);
      case 'mute': this.video.muted = !this.video.muted; if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.5; return;
      case 'fs': return this.toggleFs();
      case 'pip': return this.togglePip();
      case 'next': return this.nextPart();
      case 'chapters': return this.openMenu('chapters', el);
      case 'speed': return this.openMenu('speed', el);
      case 'quality': return this.openMenu('quality', el);
      case 'exit': return this.ctx.go('offer');
    }
  };
  P.togglePlay = function () {
    if (this.state !== 'ready') return;
    var v = this.video;
    if (v.paused || v.ended) { var pr = v.play(); if (pr) pr.catch(function () {}); } else v.pause();
  };
  P.seekTo = function (t) {
    if (this.state !== 'ready') return;
    var d = this.duration();
    t = Math.max(0, Math.min(d ? d - 0.5 : t, t));
    this.video.currentTime = t;
    this.paintProgress(t);
  };
  P.seekBy = function (dt, quiet) { this.seekTo(this.video.currentTime + dt); if (!quiet) this.osd((dt > 0 ? '+' : '−') + Math.abs(dt) + ' सेकंड'); };
  P.partAt = function (t) { var idx = -1; this.parts.forEach(function (p, i) { if (t >= p.start - 0.01) idx = i; }); return idx; };
  P.nextPart = function () {
    var i = this.partAt(this.video.currentTime), n = this.parts[i + 1];
    if (!n) return;
    this.seekTo(n.start + 0.05); this.osd(n.title);
    this.ctx.panel.clientEvent('chapter.jump', 'jump to ' + n.title + ' @ ' + fmt(n.start));
  };
  P.gotoPart = function (i) {
    var p = this.parts[i]; if (!p) return;
    this.seekTo(p.start + 0.05); this.osd(p.title);
    this.ctx.panel.clientEvent('chapter.jump', 'jump to ' + p.title + ' @ ' + fmt(p.start));
    if (this.video.paused) this.togglePlay();
  };
  P.toggleFs = function () {
    var w = this.wrap, d = document;
    var fsEl = d.fullscreenElement || d.webkitFullscreenElement;
    if (fsEl || w.classList.contains('fs-fallback')) {
      if (fsEl) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      w.classList.remove('fs-fallback'); this.syncFs(); return;
    }
    var req = w.requestFullscreen || w.webkitRequestFullscreen;
    if (req) {
      Promise.resolve(req.call(w)).then(function () {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
      }).catch(function () { w.classList.add('fs-fallback'); });
    } else if (this.video.webkitEnterFullscreen) { this.video.webkitEnterFullscreen(); }
    else w.classList.add('fs-fallback');
    this.syncFs();
  };
  P.syncFs = function () {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement) || this.wrap.classList.contains('fs-fallback');
    var b = this.root.querySelector('[data-a="fs"]');
    if (b) { b.innerHTML = svg(on ? 'fsExit' : 'fs'); b.setAttribute('aria-label', on ? 'फ़ुलस्क्रीन बंद (F)' : 'फ़ुलस्क्रीन (F)'); }
  };
  P.togglePip = function () {
    var v = this.video;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
    else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(function () {});
  };

  P.onKey = function (e) {
    if (this.destroyed || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' && t.type !== 'range' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (this.root.offsetParent === null) return; // watch screen hidden
    var k = e.key, v = this.video, handled = true;
    if (k === ' ' || k === 'k' || k === 'K') { if (t && t.tagName === 'BUTTON' && k === ' ') return; this.togglePlay(); }
    else if (k === 'ArrowLeft' || k === 'j' || k === 'J') this.seekBy(-10);
    else if (k === 'ArrowRight' || k === 'l' || k === 'L') this.seekBy(10);
    else if (k === 'ArrowUp') { v.muted = false; v.volume = Math.min(1, v.volume + 0.1); this.osd('आवाज़ ' + Math.round(v.volume * 100) + '%'); }
    else if (k === 'ArrowDown') { v.volume = Math.max(0, v.volume - 0.1); this.osd('आवाज़ ' + Math.round(v.volume * 100) + '%'); }
    else if (k === 'f' || k === 'F') this.toggleFs();
    else if (k === 'm' || k === 'M') { v.muted = !v.muted; this.osd(v.muted ? 'म्यूट' : 'आवाज़ चालू'); }
    else if (k === 'c' || k === 'C') { if (this.menu && this.menu.kind === 'chapters') this.closeMenu(); else this.openMenu('chapters', this.root.querySelector('[data-a="chapters"]')); }
    else if (k === 'Escape' && this.menu) this.closeMenu();
    else if (k === 'n' || k === 'N') this.nextPart();
    else handled = false;
    if (handled) { e.preventDefault(); this.showUI(); }
  };

  /* menus */
  P.openMenu = function (kind, anchor) {
    if (this.menu && this.menu.kind === kind) return this.closeMenu();
    this.closeMenu();
    var self = this, v = this.video, m = document.createElement('div');
    m.className = 'wp-menu'; m.setAttribute('role', 'menu'); m.kind = kind;
    var add = function (label, small, checked, fn) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', checked ? 'true' : 'false');
      var s = document.createElement('span'); s.textContent = label;
      if (small) { var sm = document.createElement('small'); sm.textContent = ' ' + small; s.appendChild(sm); }
      b.appendChild(s); b.addEventListener('click', function (e) { e.stopPropagation(); fn(); self.closeMenu(); });
      m.appendChild(b);
    };
    var h3 = function (t) { var h = document.createElement('h3'); h.textContent = t; m.appendChild(h); };
    if (kind === 'chapters') {
      h3('भाग · Chapters');
      var cur = this.partAt(v.currentTime);
      this.parts.forEach(function (p, i) { add(p.title, fmt(p.start) + (p.end ? ' – ' + fmt(p.end) : ''), i === cur, function () { self.gotoPart(i); }); });
    } else if (kind === 'speed') {
      h3('स्पीड · Speed');
      SPEEDS.forEach(function (r) { add(r === 1 ? 'नॉर्मल (1x)' : r + 'x', '', v.playbackRate === r, function () { v.playbackRate = r; self.ctx.panel.clientEvent('speed', 'playbackRate ' + r + 'x'); }); });
    } else if (kind === 'quality') {
      h3('क्वालिटी · Quality');
      var p = this.player; if (!p) return;
      var abr = p.getConfiguration().abr.enabled;
      var tracks = this.videoTracks();
      var act = tracks.find(function (t) { return t.active; });
      add('Auto', act && abr ? act.height + 'p' : 'डेटा के हिसाब से', abr, function () { self.setQuality(null); });
      tracks.forEach(function (t) { add(t.height + 'p', (t.videoBandwidth || t.bandwidth) ? (((t.videoBandwidth || t.bandwidth) / 1e6).toFixed(1) + ' Mbps') : '', !abr && t.active, function () { self.setQuality(t); }); });
    }
    this.wrap.appendChild(m); this.menu = m;
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    this.menuAnchor = anchor;
    var first = m.querySelector('[aria-checked="true"]') || m.querySelector('button'); if (first) first.focus({ preventScroll: true });
  };
  P.closeMenu = function () {
    if (!this.menu) return;
    this.menu.remove(); this.menu = null;
    if (this.menuAnchor) { this.menuAnchor.setAttribute('aria-expanded', 'false'); this.menuAnchor = null; }
  };
  P.videoTracks = function () {
    if (!this.player) return [];
    var seen = {}, out = [];
    this.player.getVariantTracks().slice().sort(function (a, b) { return (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth; }).forEach(function (t) {
      if (!t.height || seen[t.height]) { if (t.active && seen[t.height]) seen[t.height].active = true; return; }
      seen[t.height] = t; out.push(t);
    });
    return out;
  };
  P.setQuality = function (t) {
    var p = this.player; if (!p) return;
    if (!t) { p.configure({ abr: { enabled: true } }); this.osd('Auto'); this.ctx.panel.clientEvent('quality', 'Auto (ABR on)'); return; }
    p.configure({ abr: { enabled: false } });
    p.selectVariantTrack(t, true);
    this.osd(t.height + 'p'); this.ctx.panel.clientEvent('quality', 'manual ' + t.height + 'p (ABR off)');
  };

  /* ---------------- painting ---------------- */
  P.syncPlay = function () {
    var playing = !this.video.paused && !this.video.ended;
    var self = this;
    this.root.querySelectorAll('[data-a="toggle"]').forEach(function (b) { b.innerHTML = svg(playing ? 'pause' : 'play'); b.setAttribute('aria-label', playing ? 'रोकें' : 'चलाएँ'); });
    if (playing) this.scheduleHide(); else this.showUI();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (!playing) self.saveLocal();
  };
  P.syncVol = function () {
    var v = this.video, b = this.root.querySelector('[data-a="mute"]');
    var off = v.muted || v.volume === 0;
    b.innerHTML = svg(off ? 'mute' : 'vol'); b.setAttribute('aria-label', off ? 'आवाज़ चालू करें (M)' : 'म्यूट (M)');
    this.volRange.value = v.muted ? 0 : v.volume;
    LS.set('wp_vol', { v: v.volume, m: v.muted });
  };
  P.onTime = function () {
    var t = this.video.currentTime, d = this.duration();
    if (!this.dragging) this.paintProgress(t);
    var long = d >= 3600;
    this.curEl.textContent = fmt(t, long); this.durEl.textContent = fmt(d, long);
    var i = this.partAt(t);
    this.partEl.textContent = this.parts[i] ? this.parts[i].title : '';
    if (i !== this.lastPart) { this.lastPart = i; if (this.ctx.onPart) this.ctx.onPart(i); }
    this.nextBtn.hidden = !this.parts[i + 1];
    if (this.parts[i + 1] && this.nextBtn.dataset.for !== String(i + 1)) {
      this.nextBtn.dataset.for = String(i + 1);
      this.nextBtn.innerHTML = '<span class="nx-long"></span><span class="nx-short">अगला ›</span>';
      this.nextBtn.firstChild.textContent = 'अगला भाग › ' + this.parts[i + 1].title;
      this.nextBtn.setAttribute('aria-label', 'अगला भाग: ' + this.parts[i + 1].title + ' (N)');
    }
    this.drawBuffer();
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d && isFinite(t)) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: this.video.playbackRate || 1 }); } catch (e) { /* ignore */ }
    }
  };
  P.paintProgress = function (t) {
    var d = this.duration(), pct = d ? Math.min(100, t / d * 100) : 0;
    this.prog.style.width = pct + '%'; this.knob.style.left = pct + '%';
    this.scrub.setAttribute('aria-valuemax', String(Math.round(d)));
    this.scrub.setAttribute('aria-valuenow', String(Math.round(t)));
    this.scrub.setAttribute('aria-valuetext', fmt(t) + ' / ' + fmt(d));
  };
  P.drawBuffer = function () {
    var v = this.video, d = this.duration(), b = v.buffered, end = 0;
    for (var i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) end = b.end(i);
    this.buf.style.width = (d ? Math.min(100, end / d * 100) : 0) + '%';
    this.bufferAhead = Math.max(0, end - v.currentTime);
  };
  P.layoutTicks = function () {
    var d = this.duration(), self = this;
    this.ticks.innerHTML = '';
    if (!d) return;
    this.parts.forEach(function (p, i) {
      if (i === 0 || p.start <= 0) return;
      var t = document.createElement('div'); t.className = 'wp-tick'; t.style.left = (p.start / d * 100) + '%'; t.title = p.title;
      self.ticks.appendChild(t);
    });
  };
  P.hover = function (frac) {
    var d = this.duration(), t = frac * d;
    this.preview.style.left = Math.min(Math.max(frac * 100, 0), 100) + '%';
    var w = this.scrub.clientWidth, px = frac * w;
    if (px < 84) this.preview.style.left = '84px'; else if (px > w - 84) this.preview.style.left = (w - 84) + 'px';
    this.ptime.textContent = fmt(t, d >= 3600);
    var i = this.partAt(t); this.pchap.textContent = this.parts[i] ? this.parts[i].title : '';
    var cue = null;
    for (var k = 0; k < this.thumbs.length; k++) if (t >= this.thumbs[k].s && t < this.thumbs[k].e) { cue = this.thumbs[k]; break; }
    if (cue) {
      this.thumbEl.classList.remove('none');
      this.thumbEl.style.backgroundImage = 'url("' + cue.url + '")';
      this.thumbEl.style.backgroundPosition = cue.x ? '-' + cue.x + 'px -' + cue.y + 'px' : '0 0';
      this.thumbEl.style.width = cue.w + 'px'; this.thumbEl.style.height = cue.h + 'px';
    } else this.thumbEl.classList.add('none');
  };
  P.loadThumbs = function () {
    var self = this, url = this.ctx.cfg.MEDIA_BASE + 'thumbs/thumbs.vtt';
    fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); }).then(function (txt) {
      var ts = function (s) { var p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
      var lines = txt.split(/\r?\n/), out = [];
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
        if (!m || !lines[i + 1]) continue;
        var ref = lines[i + 1].trim(), hash = ref.split('#xywh='), xywh = (hash[1] || '0,0,160,90').split(',').map(Number);
        out.push({ s: ts(m[1]), e: ts(m[2]), url: new URL(hash[0], new URL(url, location.href)).href, x: xywh[0], y: xywh[1], w: xywh[2], h: xywh[3] });
      }
      self.thumbs = out;
      if (out[0]) { var img = new Image(); img.src = out[0].url; }
    }).catch(function () { self.thumbs = []; });
  };
  P.setBuffering = function (on) { this.spinner.hidden = !on; this.wrap.setAttribute('aria-busy', on ? 'true' : 'false'); };
  P.showUI = function () { this.wrap.classList.add('ui'); this.scheduleHide(); };
  P.hideUI = function (force) {
    if (!force && (this.video.paused || this.menu || this.dragging)) return;
    if (this.menu) this.closeMenu();
    if (this.video.paused) return;
    this.wrap.classList.remove('ui');
  };
  P.scheduleHide = function () { var self = this; clearTimeout(this.uiTimer); this.uiTimer = setTimeout(function () { self.hideUI(); }, 3000); };
  P.osd = function (text) {
    var self = this;
    if (!this.osdEl) { this.osdEl = document.createElement('div'); this.osdEl.className = 'wp-osd'; this.osdEl.setAttribute('aria-live', 'polite'); this.wrap.appendChild(this.osdEl); }
    this.osdEl.textContent = text; this.osdEl.hidden = false;
    clearTimeout(this.osdT); this.osdT = setTimeout(function () { if (self.osdEl) self.osdEl.hidden = true; }, 900);
  };
  P.ripple = function (side, text) {
    var r = document.createElement('div'); r.className = 'wp-ripple ' + side; r.textContent = text;
    this.wrap.appendChild(r); setTimeout(function () { r.remove(); }, 650);
  };
  P.showResume = function (at) {
    var self = this, el = document.createElement('div'); el.className = 'wp-resume'; el.setAttribute('role', 'status');
    el.innerHTML = '<span></span><button type="button">शुरू से देखें</button>';
    el.firstChild.textContent = fmt(at) + ' से आगे चल रहा है';
    el.querySelector('button').addEventListener('click', function (e) { e.stopPropagation(); self.seekTo(0); el.remove(); });
    this.wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, 8000);
  };
  P.paintRental = function () {
    if (!this.expiresAt) { this.rental.hidden = true; return; }
    var left = this.expiresAt - Date.now();
    this.rental.hidden = false;
    var v = this.rental.querySelector('.v');
    if (left <= 0) { v.textContent = 'समय खत्म'; this.rental.classList.add('amb'); return; }
    var h = Math.floor(left / 3600e3), m = Math.floor((left % 3600e3) / 60e3);
    v.textContent = h >= 1 ? h + ':' + String(m).padStart(2, '0') + ' घंटे बाकी' : m + ' मिनट बाकी';
    this.rental.classList.toggle('amb', left < 3 * 3600e3);
    this.rental.setAttribute('aria-label', 'किराया: ' + v.textContent);
  };
  P.onVariant = function (why) {
    var t = this.player && this.player.getVariantTracks().find(function (x) { return x.active; });
    if (!t) return;
    var label = (t.height || '?') + 'p';
    if (label !== this.lastRes) {
      if (this.lastRes) this.ctx.panel.clientEvent('abr.switch', this.lastRes + ' → ' + label + (why === 'manual' ? ' (manual)' : ' (ABR)'), true, 'player');
      this.lastRes = label;
    }
  };
  P.refreshKeys = function () {
    if (!this.player) return;
    var ks = this.player.getKeyStatuses(), ids = Object.keys(ks);
    if (!ids.length) return;
    var st = ids.map(function (k) { return ks[k]; });
    var allOk = st.every(function (s) { return s === 'usable'; });
    var txt = ids.length + ' key' + (ids.length > 1 ? 's' : '') + ' · ' + st.join(',');
    this.ctx.panel.setStats({ keys: { v: txt, cls: allOk ? 'ok' : 'bad' } });
    if (allOk && !this.keysLogged) { this.keysLogged = true; this.ctx.panel.clientEvent('eme.keys', 'CDM key status usable — content decrypting (kid ' + ids[0].slice(0, 8) + '…)', true, 'EME'); }
  };
  P.tickStats = function () {
    if (!this.player) return;
    var s = this.player.getStats(), t = this.player.getVariantTracks().find(function (x) { return x.active; });
    var q = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
    this.drawBuffer();
    this.ctx.panel.setStats({
      res: (s.width && s.height ? s.width + '×' + s.height : '—') + (this.player.getConfiguration().abr.enabled ? ' (auto)' : ' (manual)'),
      bitrate: t ? ((t.videoBandwidth || t.bandwidth) / 1e6).toFixed(2) + ' Mbps' : '—',
      bw: s.estimatedBandwidth ? (s.estimatedBandwidth / 1e6).toFixed(2) + ' Mbps' : '—',
      buffer: (this.bufferAhead || 0).toFixed(1) + ' s ahead',
      dropped: (q ? q.droppedVideoFrames : s.droppedFrames) + ' / ' + (q ? q.totalVideoFrames : s.decodedFrames),
      host: this.lastSegUrl ? hostOf(this.lastSegUrl) : '—',
    });
    this.refreshKeys();
  };
  P.saveLocal = function () {
    var t = this.video.currentTime;
    if (!t || this.state !== 'ready') return;
    LS.set('wp_resume_' + this.ctx.cfg.FILM_ID, { pos: t, at: Date.now() });
  };
  P.onEnded = function () {
    LS.set('wp_resume_' + this.ctx.cfg.FILM_ID, { pos: 0, at: Date.now() });
    var self = this;
    this.ctx.panel.clientEvent('playback.ended', 'film finished');
    this.clearMsg();
    var d = document.createElement('div'); d.className = 'wp-msg';
    d.innerHTML = '<div class="ic" aria-hidden="true">🎬</div><div class="t">फ़िल्म खत्म</div><div class="s">48 घंटे के अंदर फिर से देख सकते हैं</div><div class="row"><button type="button" class="btn primary">फिर से देखें</button></div>';
    d.querySelector('button').addEventListener('click', function () { d.remove(); self.msgEl = null; self.seekTo(0); self.togglePlay(); });
    this.wrap.appendChild(d); this.msgEl = d;
  };
  P.mediaSession = function () {
    if (!('mediaSession' in navigator)) return;
    var self = this, ms = navigator.mediaSession;
    try {
      ms.metadata = new MediaMetadata({ title: this.film.title || 'Wiom TV', artist: 'Wiom TV', album: 'फ़िल्म',
        artwork: this.film.poster ? [{ src: new URL(this.film.poster, location.href).href, sizes: '1280x720', type: 'image/jpeg' }] : [] });
    } catch (e) { /* ignore */ }
    var set = function (a, fn) { try { ms.setActionHandler(a, fn); } catch (e) { /* unsupported action */ } };
    set('play', function () { self.video.play().catch(function () {}); });
    set('pause', function () { self.video.pause(); });
    set('seekbackward', function (d) { self.seekBy(-(d && d.seekOffset || 10)); });
    set('seekforward', function (d) { self.seekBy(d && d.seekOffset || 10); });
    set('seekto', function (d) { if (d && d.seekTime != null) self.seekTo(d.seekTime); });
    set('previoustrack', function () { var i = self.partAt(self.video.currentTime); self.gotoPart(Math.max(0, i - (self.video.currentTime - (self.parts[i] || {}).start < 5 ? 1 : 0))); });
    set('nexttrack', function () { self.nextPart(); });
    this.cleanup.push(function () { ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach(function (a) { set(a, null); }); });
  };

  window.WiomPlayer = WiomPlayer;
  window.WiomPlayer.fmt = fmt;
})();
