/* TITLE screen — Netflix-style pay-per-view landing for one film (wiom.tv dark look).
 * Hero backdrop → trailer plays inline → price → pay → watch. No OTP (guest session happens in app.js).
 * Contract: OfferScreen.render(el, {film, owned, busy, onCta, price}) — film = {title, duration, parts[], poster, trailer, credits}. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function dur(sec) {
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? h + ' घं ' + m + ' मि' : m + ' मिनट';
  }
  var SYNOPSIS = 'एक ही टिकट में दो पूरी फ़िल्में: Sita Sings the Blues — रामायण की सीता की कहानी, 1920s के jazz गानों के साथ एक शानदार एनिमेटेड म्यूज़िकल; और Night of the Living Dead (1968) — horror सिनेमा की सबसे मशहूर क्लासिक, जिसने zombie फ़िल्मों की शुरुआत की।';

  function render(el, o) {
    var f = o.film || {};
    var parts = f.parts || [];
    var meta = [f.duration ? dur(f.duration) : '', parts.length > 1 ? parts.length + ' भाग' : '', 'HD'].filter(Boolean).join(' · ');
    var price = o.price || '₹14';
    el.innerHTML =
      '<div class="tp">' +
        '<div class="tp-hero" id="tp-hero">' +
          '<div class="tp-bg" style="background-image:url(\'' + esc(f.poster) + '\')" role="img" aria-label="' + esc(f.title) + ' पोस्टर"></div>' +
          '<div class="tp-fade" aria-hidden="true"></div>' +
          (f.trailer ? '<button type="button" class="tp-trailer-btn" id="tp-trailer" aria-label="ट्रेलर चलाएँ"><span class="tri" aria-hidden="true"></span></button>' : '') +
          '<span class="tp-badge">PAY PER VIEW</span>' +
        '</div>' +
        '<div class="tp-body">' +
          '<h1 id="offer-title" class="tp-title">' + esc(f.title) + '</h1>' +
          '<div class="tp-meta"><span class="hd">HD</span><span>' + esc(meta) + '</span></div>' +
          (o.owned
            ? '<div class="tp-owned" role="status">✓ फ़िल्म आपके पास है · ' + esc(o.owned) + '</div>'
            : '<div class="tp-price"><span class="v">' + esc(price) + '</span><span class="s">में पूरी फ़िल्म · 48 घंटे · जितनी बार चाहें</span></div>') +
          '<button type="button" class="tp-cta" id="offer-cta">' +
            (o.busy ? '<span class="spin dark" aria-hidden="true"></span><span class="lbl-t">एक पल…</span>' :
              o.owned ? '<span class="tri dark sm" aria-hidden="true"></span><span class="lbl-t">देखना जारी रखें</span>' :
              '<span class="tri dark sm" aria-hidden="true"></span><span class="lbl-t">' + esc(price) + ' में अभी देखें</span>') +
          '</button>' +
          (f.trailer ? '<button type="button" class="tp-sec" id="tp-trailer2"><span aria-hidden="true">🎬</span> ट्रेलर देखें</button>' : '') +
          '<p class="tp-syn">' + SYNOPSIS + '</p>' +
          (parts.length ? '<div class="tp-parts"><div class="tp-ph">इस टिकट में</div>' + parts.map(function (p, i) {
            return '<div class="tp-part"><span class="n">' + (i + 1) + '</span>' +
              (p.thumb ? '<img class="th" src="' + esc(p.thumb) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
              '<div class="w"><div class="t">' + esc(p.title) + '</div><div class="s">' + dur((p.end || 0) - (p.start || 0)) + '</div></div></div>';
          }).join('') + '</div>' : '') +
          (f.credits ? '<p class="tp-credits">' + esc(f.credits) + '</p>' : '') +
        '</div>' +
      '</div>';

    var cta = el.querySelector('#offer-cta');
    if (o.busy) cta.disabled = true;
    cta.addEventListener('click', function () { o.onCta && o.onCta(); });

    function playTrailer() {
      var hero = el.querySelector('#tp-hero');
      if (!f.trailer || hero.querySelector('video')) return;
      hero.innerHTML =
        '<video class="tp-video" src="' + esc(f.trailer) + '" autoplay playsinline controls controlslist="nodownload"></video>' +
        '<span class="tp-badge">ट्रेलर</span>' +
        '<button type="button" class="tp-close" id="tp-close" aria-label="ट्रेलर बंद करें">✕</button>';
      hero.querySelector('#tp-close').addEventListener('click', function () { render(el, o); });
      var v = hero.querySelector('video');
      v.addEventListener('ended', function () { render(el, o); });
      v.play().catch(function () { /* user can press play on controls */ });
    }
    var t1 = el.querySelector('#tp-trailer'), t2 = el.querySelector('#tp-trailer2');
    if (t1) t1.addEventListener('click', playTrailer);
    if (t2) t2.addEventListener('click', playTrailer);
  }
  window.OfferScreen = { render: render };
})();
