/* OFFER screen — faithful build of the Figma "offer Naveen flow" → "Naveen offer" frame (file 8OMg9BTNhVDJxQ5ii10OWj,
 * node 16787-77897), adapted per SPEC from "14 दिन + 14 दिन" to "₹14 Net pack + Movie FREE".
 * Contract: OfferScreen.render(el, {film, owned, busy, onCta}) — film = {title, duration, parts[], poster}. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function dur(sec) {
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? h + ' घं ' + m + ' मि' : m + ' मिनट';
  }
  function render(el, o) {
    var f = o.film || {};
    var parts = (f.parts || []).length;
    var meta = [parts > 1 ? parts + ' भाग' : '', f.duration ? dur(f.duration) : '', 'HD'].filter(Boolean).join(' · ');
    el.innerHTML =
      '<div class="nf">' +
        '<div class="nf-head">' +
          '<h1 id="offer-title" class="nf-h1">₹14 में Net पैक + फ़िल्म फ्री 🎉</h1>' +
          '<p class="nf-sub">₹14 Net pack + Movie FREE</p>' +
        '</div>' +

        '<div class="nf-hero">' +
          '<div class="nf-tag">🎁 वेलकम ऑफर</div>' +
          '<div class="nf-free">' +
            '<div class="nf-d1">₹14</div>' +
            '<div class="nf-b1">Net पैक + फ़िल्म बिल्कुल मुफ़्त</div>' +
          '</div>' +
          '<div class="nf-terms">₹14 के Net पैक के साथ पूरी फ़िल्म FREE — 48 घंटे के लिए</div>' +
        '</div>' +

        '<div class="nf-movie">' +
          '<div class="of-hero nf-poster" role="img" aria-label="' + esc(f.title) + ' पोस्टर" style="background-image:url(\'' + esc(f.poster) + '\')"></div>' +
          '<div class="nf-mi">' +
            '<div class="nf-mt">' + esc(f.title) + '</div>' +
            '<div class="nf-mm">' + esc(meta) + '</div>' +
            (o.owned ? '<div class="nf-owned" role="status">✓ फ़िल्म आपके पास है · ' + esc(o.owned) + '</div>' : '') +
          '</div>' +
        '</div>' +

        '<div class="nf-note">' +
          '<div class="nf-note-bar" aria-hidden="true"></div>' +
          '<div class="nf-note-in">' +
            '<div class="nf-note-ic" aria-hidden="true">🎁</div>' +
            '<div class="nf-note-tx">' +
              '<div class="t">पेमेंट होते ही फ़िल्म अनलॉक</div>' +
              '<div class="s">7 दिन में शुरू करें · पहली बार चलाने से 48 घंटे</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="nf-actions">' +
          '<button type="button" class="nf-cta" id="offer-cta">' +
            (o.busy ? '<span class="spin" aria-hidden="true"></span><span class="lbl-t">एक पल…</span>' :
              o.owned ? '<span aria-hidden="true">▶</span><span class="lbl-t">अभी देखें</span>' :
              '<span class="lbl-t">₹14 में पैक लें</span>') +
          '</button>' +
        '</div>' +
      '</div>';
    var b = el.querySelector('#offer-cta');
    if (o.busy) b.disabled = true;
    b.addEventListener('click', function () { o.onCta && o.onCta(); });
  }
  window.OfferScreen = { render: render };
})();
