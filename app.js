/* Wiom Movie Pilot — SPA: #offer → #login → #pay → #success → #watch */
(function () {
  'use strict';
  var CFG = window.WIOM_CONFIG;
  var Panel = window.BackendPanel;
  var $ = function (id) { return document.getElementById(id); };
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };
  var uuid = function () { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); };
  var rs = function (paise) { return '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };

  var S = {
    session: LS.get('wiom_session'),
    phone: LS.get('wiom_phone_masked'),
    orderId: LS.get('wiom_order_id'),
    order: null,
    intent: LS.get('wiom_intent'), // 'buy' | 'watch' — what to do right after login
    film: null,
  };
  var deviceId = LS.get('wiom_device_id') || (function () { var d = 'dev_' + uuid().replace(/-/g, '').slice(0, 16); LS.set('wiom_device_id', d); return d; })();
  var player = null;

  /* ---------------- API client: every response's `events` → backend panel ---------------- */
  function ApiError(status, code, message) { var e = new Error(message || code); e.status = status; e.code = code; return e; }
  async function api(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (S.session) headers['Authorization'] = 'Bearer ' + S.session;
    if (opts.idem) headers['Idempotency-Key'] = opts.idem;
    var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || 15000);
    var t0 = performance.now(), res, data = {};
    var shown = path.split('?')[0];
    try {
      res = await fetch(CFG.API_BASE + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal, keepalive: !!opts.keepalive, credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      clearTimeout(timer);
      Panel.logCall({ method: method, path: shown, status: 0, ms: performance.now() - t0, events: [{ ts: new Date().toISOString(), step: 'network', detail: e.name === 'AbortError' ? 'timed out' : 'request failed (offline / CORS)', ok: false }] });
      throw ApiError(0, 'network', 'इंटरनेट कनेक्शन चेक करें');
    }
    clearTimeout(timer);
    try { data = await res.json(); } catch (e) { data = {}; }
    Panel.logCall({ method: method, path: shown, status: res.status, ms: performance.now() - t0, events: data.events || [] });
    if (!res.ok) {
      if (res.status === 401 && S.session && path !== '/api/otp/verify') setSession(null, null);
      throw ApiError(res.status, data.error || 'http_' + res.status, data.message);
    }
    return data;
  }

  function setSession(tok, phone) {
    S.session = tok; S.phone = phone;
    LS.set('wiom_session', tok); LS.set('wiom_phone_masked', phone);
    var chip = $('user-chip');
    chip.hidden = !tok;
    chip.textContent = phone || '';
  }
  function setIntent(i) { S.intent = i; LS.set('wiom_intent', i); }

  var toastT = 0;
  function toast(msg, kind) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast on' + (kind ? ' ' + kind : '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'toast'; }, 3200);
  }
  function busy(btn, on, label) {
    if (!btn) return;
    var l = btn.querySelector('.lbl-t');
    if (on) { btn.dataset.lbl = l ? l.textContent : ''; btn.classList.add('busy'); btn.disabled = true; if (l) l.innerHTML = '<span class="spin" aria-hidden="true"></span> ' + (label || 'एक पल…'); }
    else { btn.classList.remove('busy'); btn.disabled = false; if (l && btn.dataset.lbl != null) l.textContent = btn.dataset.lbl; }
  }

  /* ---------------- film metadata ---------------- */
  var FALLBACK_FILM = {
    title: 'Sita Sings the Blues + Night of the Living Dead', duration: 10624,
    parts: [{ title: 'Part 1 · Sita Sings the Blues', start: 0, end: 4891.24 }, { title: 'Part 2 · Night of the Living Dead', start: 4891.24, end: 10624 }],
    credits: 'Sita Sings the Blues © Nina Paley, CC0 · Night of the Living Dead (1968), public domain',
  };
  async function loadFilm() {
    var f = null;
    try { var r = await fetch(CFG.MEDIA_BASE + 'film.json', { cache: 'no-cache' }); if (r.ok) f = await r.json(); } catch (e) { /* fall back */ }
    f = Object.assign({}, FALLBACK_FILM, f || {});
    var base = new URL(CFG.MEDIA_BASE, location.href);
    f.poster = new URL(f.poster || 'poster.jpg', base).href;
    if (f.trailer) f.trailer = new URL(f.trailer, base).href;
    S.film = f;
    $('watch-title').textContent = f.title;
    $('watch-credits').textContent = f.credits || '';
    renderParts(-1);
  }
  function renderParts(active) {
    var box = $('watch-parts'); box.innerHTML = '';
    (S.film.parts || []).forEach(function (p, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'part-chip' + (i === active ? ' on' : '');
      b.innerHTML = '<span></span><small></small>';
      b.firstChild.textContent = p.title;
      b.lastChild.textContent = WiomPlayer.fmt(p.start) + (p.end ? '–' + WiomPlayer.fmt(p.end) : '');
      b.setAttribute('aria-pressed', i === active ? 'true' : 'false');
      b.addEventListener('click', function () { if (player) player.gotoPart(i); });
      box.appendChild(b);
    });
  }

  /* ---------------- router ---------------- */
  var ROUTES = ['offer', 'login', 'pay', 'success', 'watch'];
  function go(r) { if (location.hash === '#' + r) route(); else location.hash = r; }
  function route() {
    var r = (location.hash || '#offer').slice(1).split('?')[0];
    if (ROUTES.indexOf(r) < 0) r = 'offer';
    if (r !== 'watch' && player) { player.destroy(); player = null; }
    // guards — PPV flow has no login: a guest session is created silently, then we re-route
    if ((r === 'pay' || r === 'success' || r === 'watch') && !S.session) {
      ensureSession().then(route, function () { toast('कनेक्शन नहीं बन पाया — फिर कोशिश करें', 'bad'); go('offer'); });
      return;
    }
    if (r === 'pay' && !S.orderId) return go('offer');
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.dataset.route !== r; });
    window.scrollTo(0, 0);
    var h = document.querySelector('#screen-' + r + ' h1');
    ({ offer: showOffer, login: showLogin, pay: showPay, success: showSuccess, watch: showWatch })[r]();
    if (h && r !== 'watch') { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  /* ---------------- 1. offer ---------------- */
  var offerOwned = null;
  function entLabel(e) {
    if (!e) return null;
    var left = Date.parse(e.expires_at) - Date.now();
    if (e.status === 'active') return Math.floor(left / 3600e3) + ' घंटे बाकी';
    if (e.status === 'not_started') return 'अभी शुरू नहीं की';
    return null;
  }
  function showOffer() {
    var el = $('screen-offer');
    var draw = function (busyFlag) { OfferScreen.render(el, { film: S.film, owned: offerOwned, busy: busyFlag, onCta: offerCta }); };
    draw(false);
    if (S.session) {
      api('GET', '/api/me').then(function (me) {
        var e = (me.entitlements || []).find(function (x) { return x.status === 'active' || x.status === 'not_started'; });
        offerOwned = entLabel(e);
        if (!$('screen-offer').hidden) draw(false);
      }).catch(function () { offerOwned = null; });
    } else offerOwned = null;
  }
  async function ensureSession() {
    if (S.session) return;
    var r = await api('POST', '/api/session/guest', { device_id: deviceId });
    setSession(r.session, r.user && r.user.phone_masked);
  }
  async function offerCta() {
    if (offerOwned) return go('watch');
    var btn = $('offer-cta');
    busy(btn, true);
    try {
      await ensureSession();
      var me = await api('GET', '/api/me');
      var owned = (me.entitlements || []).some(function (x) { return x.status === 'active' || x.status === 'not_started'; });
      if (owned) return go('watch');
      await createOrder(); go('pay');
    }
    catch (e) { toast(e.message || 'ऑर्डर नहीं बन पाया', 'bad'); busy(btn, false); }
  }
  async function createOrder() {
    var o = await api('POST', '/api/orders', { offer_id: CFG.OFFER_ID }, { idem: uuid() });
    S.order = o; S.orderId = o.order_id; LS.set('wiom_order_id', o.order_id);
    return o;
  }

  /* ---------------- 2. login ---------------- */
  var loginPhone = '';
  function showLogin() {
    if (S.session) return go('offer');
    $('form-phone').hidden = false; $('form-otp').hidden = true;
    $('phone-err').textContent = ''; $('otp-err').textContent = '';
    setTimeout(function () { $('in-phone').focus(); }, 50);
  }
  function bindLogin() {
    var phoneIn = $('in-phone'), otpIn = $('in-otp');
    phoneIn.addEventListener('input', function () { phoneIn.value = phoneIn.value.replace(/\D/g, '').slice(0, 10); $('phone-err').textContent = ''; });
    otpIn.addEventListener('input', function () { otpIn.value = otpIn.value.replace(/\D/g, '').slice(0, 4); $('otp-err').textContent = ''; if (otpIn.value.length === 4) $('form-otp').requestSubmit(); });
    $('form-phone').addEventListener('submit', async function (e) {
      e.preventDefault();
      var p = phoneIn.value.trim();
      if (!/^[6-9]\d{9}$/.test(p)) { $('phone-err').textContent = '10 अंकों का मोबाइल नंबर डालें (6–9 से शुरू)'; phoneIn.setAttribute('aria-invalid', 'true'); return; }
      phoneIn.removeAttribute('aria-invalid');
      var btn = e.submitter || this.querySelector('button[type=submit]');
      busy(btn, true, 'भेज रहे हैं…');
      try {
        var r = await api('POST', '/api/otp/send', { phone: p });
        loginPhone = p;
        $('otp-to').textContent = '· +91 ' + p.slice(0, 2) + 'xxxx' + p.slice(-4);
        $('otp-hint').querySelector('b').textContent = r.demo_otp || '1234';
        $('otp-hint').dataset.otp = r.demo_otp || '1234';
        $('form-phone').hidden = true; $('form-otp').hidden = false; otpIn.value = '';
        otpIn.focus();
      } catch (err) { $('phone-err').textContent = err.message || 'OTP नहीं भेज पाए'; }
      finally { busy(btn, false); }
    });
    $('otp-hint').addEventListener('click', function () { otpIn.value = this.dataset.otp || '1234'; otpIn.dispatchEvent(new Event('input')); });
    $('otp-change').addEventListener('click', function () { $('form-otp').hidden = true; $('form-phone').hidden = false; phoneIn.focus(); });
    var verifying = false;
    $('form-otp').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (verifying) return;
      var otp = otpIn.value.trim();
      if (!/^\d{4}$/.test(otp)) { $('otp-err').textContent = '4 अंकों का OTP डालें'; return; }
      var btn = this.querySelector('button[type=submit]');
      verifying = true; busy(btn, true, 'जाँच रहे हैं…');
      try {
        var r = await api('POST', '/api/otp/verify', { phone: loginPhone, otp: otp });
        setSession(r.session, r.user && r.user.phone_masked);
        toast('लॉगिन हो गया ✓', 'ok');
        var intent = S.intent; setIntent(null);
        if (intent === 'watch') return go('watch');
        if (intent === 'buy') {
          var me = await api('GET', '/api/me');
          var owned = (me.entitlements || []).some(function (x) { return x.status === 'active' || x.status === 'not_started'; });
          if (owned) { toast('यह फ़िल्म पहले से आपके पास है', 'ok'); return go('offer'); }
          await createOrder(); return go('pay');
        }
        go('offer');
      } catch (err) { $('otp-err').textContent = err.message || 'OTP जाँच नहीं हो पाई'; otpIn.select(); }
      finally { verifying = false; busy(btn, false); }
    });
  }

  /* ---------------- 3. dummy PG ---------------- */
  var payMethod = 'upi_phonepe', pollT = 0, payBusy = false;
  async function showPay() {
    stopPoll(); payBusy = false; setPayBusy(false); payStatus(null);
    $('pg-order').textContent = 'ऑर्डर ' + S.orderId;
    if (!S.order || S.order.order_id !== S.orderId) {
      try { var st = await api('GET', '/api/orders/' + encodeURIComponent(S.orderId)); if (st.status === 'paid') return go('success'); }
      catch (e) { S.orderId = null; LS.set('wiom_order_id', null); return go('offer'); }
    }
    var o = S.order || { amount_paise: 1400, items: [{ title: '₹14 Net पैक', amount_paise: 1400 }, { title: 'फ़िल्म · 48 घंटे', amount_paise: 0 }] };
    $('pg-amount').textContent = rs(o.amount_paise);
    $('pg-pay').querySelector('.lbl-t').textContent = rs(o.amount_paise) + ' का पेमेंट करें';
    var ul = $('pg-items'); ul.innerHTML = '';
    (o.items || []).forEach(function (it) {
      var li = document.createElement('li'); li.innerHTML = '<span></span><span></span>';
      li.firstChild.textContent = it.title;
      li.lastChild.textContent = it.amount_paise ? rs(it.amount_paise) : 'फ्री';
      if (!it.amount_paise) li.lastChild.className = 'free';
      ul.appendChild(li);
    });
    selectMethod(payMethod);
  }
  function selectMethod(m) {
    payMethod = m;
    document.querySelectorAll('#pg-methods .pm').forEach(function (b) { var on = b.dataset.m === m; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    var qr = $('pg-qr');
    qr.hidden = m !== 'qr';
    if (m === 'qr') qr.innerHTML = fakeQr(S.orderId || 'wiom');
    $('pg-pay').querySelector('.upi-tag').textContent = m === 'card' ? 'CARD' : m === 'qr' ? 'QR' : 'UPI';
  }
  function fakeQr(seed) { // decorative pattern only — the dummy PG has no real QR
    var h = 2166136261; for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    var n = 25, cells = '';
    var finder = function (x, y) { return '<rect x="' + x + '" y="' + y + '" width="7" height="7" fill="#161021"/><rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="5" height="5" fill="#fff"/><rect x="' + (x + 2) + '" y="' + (y + 2) + '" width="3" height="3" fill="#161021"/>'; };
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      if ((x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9)) continue;
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      if ((h >>> 0) % 2) cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
    }
    return '<svg viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges"><rect width="' + n + '" height="' + n + '" fill="#fff"/><g fill="#161021">' + cells + '</g>' + finder(0, 0) + finder(n - 7, 0) + finder(0, n - 7) + '</svg>';
  }
  function setPayBusy(on) {
    document.querySelectorAll('#screen-pay .sim, #pg-methods .pm').forEach(function (b) { b.disabled = on; });
    busy($('pg-pay'), on, 'पेमेंट हो रहा है…');
  }
  function payStatus(kind, html) {
    var s = $('pg-status');
    if (!kind) { s.hidden = true; s.innerHTML = ''; return; }
    s.hidden = false; s.className = 'pg-status ' + kind; s.innerHTML = html;
  }
  function stopPoll() { clearTimeout(pollT); pollT = 0; }
  async function pay(outcome) {
    if (payBusy) return;
    payBusy = true; setPayBusy(true); payStatus(null);
    try {
      var r = await api('POST', '/api/pay/dummy', { order_id: S.orderId, method: payMethod, outcome: outcome }, { idem: S.orderId + ':' + uuid() });
      if (r.status === 'pending') payStatus('wait', '<span class="spin" aria-hidden="true"></span> पेमेंट पेंडिंग है — बैंक से कन्फ़र्मेशन का इंतज़ार…');
      else payStatus('wait', '<span class="spin" aria-hidden="true"></span> पेमेंट कन्फ़र्म हो रहा है…');
      poll(Date.now());
    } catch (e) {
      payBusy = false; setPayBusy(false);
      payStatus('bad', 'पेमेंट शुरू नहीं हो पाया · ' + (e.message || ''));
    }
  }
  function poll(t0) {
    stopPoll();
    pollT = setTimeout(async function tick() {
      if ($('screen-pay').hidden) return;
      try {
        var st = await api('GET', '/api/orders/' + encodeURIComponent(S.orderId));
        if (st.status === 'paid') { payStatus('ok', '✓ पेमेंट मिल गया — फ़िल्म शुरू हो रही है'); payBusy = false; LS.set('wiom_order_id', null); return setTimeout(function () { go('watch'); }, 600); }
        if (st.status === 'failed') return payFailed();
      } catch (e) { /* transient — keep polling */ }
      if (Date.now() - t0 > 120000) { payBusy = false; setPayBusy(false); return payStatus('bad', 'कन्फ़र्मेशन में देर हो रही है — पैसे कटे हों तो अपने-आप वापस आ जाएँगे'); }
      pollT = setTimeout(tick, 2000);
    }, 700);
  }
  function payFailed() {
    payBusy = false; setPayBusy(false);
    payStatus('bad', '<span>पेमेंट नहीं हो पाया · कोई पैसा नहीं कटा</span><button type="button" class="btn primary" id="pg-retry">फिर से कोशिश करें</button>');
    $('pg-retry').addEventListener('click', async function () {
      var b = this; b.disabled = true;
      try { await createOrder(); showPay(); toast('नया ऑर्डर बना — फिर से पेमेंट करें'); }
      catch (e) { b.disabled = false; toast(e.message || 'ऑर्डर नहीं बन पाया', 'bad'); }
    });
    $('pg-retry').focus();
  }
  function bindPay() {
    $('pg-methods').addEventListener('click', function (e) { var b = e.target.closest('.pm'); if (b) selectMethod(b.dataset.m); });
    $('pg-methods').addEventListener('keydown', function (e) {
      var list = Array.prototype.slice.call(this.querySelectorAll('.pm')), i = list.findIndex(function (b) { return b.dataset.m === payMethod; });
      var d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return; e.preventDefault();
      var n = list[(i + d + list.length) % list.length]; selectMethod(n.dataset.m); n.focus();
    });
    $('pg-pay').addEventListener('click', function () { pay('success'); });
    document.querySelectorAll('#screen-pay .sim').forEach(function (b) { b.addEventListener('click', function () { pay(b.dataset.outcome); }); });
  }

  /* ---------------- 4. success ---------------- */
  async function showSuccess() {
    var ul = $('succ-list'); ul.innerHTML = '';
    var item = function (ic, t, s) { var li = document.createElement('li'); li.innerHTML = '<span class="ic" aria-hidden="true"></span><div><div class="t"></div><div class="s"></div></div>'; li.querySelector('.ic').textContent = ic; li.querySelector('.t').textContent = t; li.querySelector('.s').textContent = s; ul.appendChild(li); };
    try {
      var me = await api('GET', '/api/me');
      var e = (me.entitlements || []).find(function (x) { return x.status === 'active' || x.status === 'not_started'; });
      if (!e) { toast('फ़िल्म अभी अनलॉक नहीं है', 'bad'); return go('offer'); }
      if (me.net_plan && me.net_plan.active) item('📶', '₹14 Net पैक चालू', 'वैध: ' + new Date(me.net_plan.expires_at).toLocaleString('hi-IN', { dateStyle: 'medium', timeStyle: 'short' }) + ' तक');
      item('🎬', S.film.title, e.status === 'active' ? entLabel(e) : '48 घंटे · पहली बार चलाने से शुरू');
    } catch (err) { item('⚠️', 'जानकारी लोड नहीं हुई', err.message || ''); }
    $('btn-watch').focus({ preventScroll: true });
  }

  /* ---------------- 5. watch ---------------- */
  function showWatch() {
    if (player) return;
    player = new WiomPlayer($('player-root'), {
      api: api, cfg: CFG, film: S.film, deviceId: deviceId, panel: Panel, toast: toast,
      token: function () { return S.session; }, go: go, onPart: renderParts,
    });
    player.start();
    setTimeout(function () { var w = document.querySelector('.wp'); if (w) w.focus({ preventScroll: true }); }, 50);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    Panel.init();
    setSession(S.session, S.phone);
    $('user-chip').addEventListener('click', function () {
      if (!S.session) return;
      if (player) { player.destroy(); player = null; }
      setSession(null, null); toast('लॉगआउट हो गया'); go('offer');
    });
    document.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.go); }); });
    $('btn-watch').addEventListener('click', function () { go('watch'); });
    bindLogin(); bindPay();
    await loadFilm();
    api('GET', '/api/health').catch(function () { toast('बैकएंड से कनेक्ट नहीं हो पाया', 'bad'); });
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
