/* "⚙ बैकएंड लाइव" — live timeline of every backend step (the `events` array of every API response)
 * plus live player stats. Open by default on desktop (≥1024px), a drawer on mobile. */
(function () {
  'use strict';
  var MAX_CALLS = 150;
  var el, list, grid, toggleBtn, countEl, scrim;
  var total = 0, stats = {}, statsDirty = false;
  var desktop = window.matchMedia('(min-width:1024px)');

  var STAT_ROWS = [
    ['drm', 'DRM'], ['keys', 'Key status'], ['session', 'Play session'], ['lease', 'Lease'],
    ['res', 'Resolution'], ['bitrate', 'Bitrate'], ['bw', 'Est. bandwidth'], ['buffer', 'Buffer'],
    ['dropped', 'Dropped frames'], ['host', 'Segment host'], ['manifest', 'Manifest'], ['heartbeat', 'Heartbeat'],
  ];

  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clock(ts) {
    var d = ts ? new Date(ts) : new Date();
    if (isNaN(d)) d = new Date();
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  function build() {
    el = document.getElementById('bp');
    toggleBtn = document.getElementById('bp-toggle');
    countEl = document.getElementById('bp-count');
    el.innerHTML = '';
    var head = h('div', 'bp-head');
    var title = h('h2'); title.appendChild(h('span', 'live')); title.appendChild(document.createTextNode('बैकएंड लाइव'));
    var clr = h('button', null, 'साफ़ करें'); clr.type = 'button'; clr.addEventListener('click', clear);
    var cls = h('button', 'bp-close-m', '✕'); cls.type = 'button'; cls.setAttribute('aria-label', 'पैनल बंद करें'); cls.addEventListener('click', close);
    head.append(title, clr, cls);

    var st = h('section', 'bp-stats'); st.setAttribute('aria-label', 'Player stats');
    st.appendChild(h('h3', null, 'Player stats'));
    grid = h('dl', 'bp-grid');
    STAT_ROWS.forEach(function (r) { var dt = h('dt', null, r[1]); var dd = h('dd', null, '—'); dd.dataset.k = r[0]; grid.append(dt, dd); });
    st.appendChild(grid);

    var tl = h('section', 'bp-tl'); tl.setAttribute('aria-label', 'Backend timeline');
    tl.appendChild(h('h3', null, 'Timeline · हर API कॉल के backend steps'));
    list = h('div', 'bp-list'); list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite');
    list.appendChild(h('div', 'bp-empty', 'अभी कोई कॉल नहीं — ऑफ़र से शुरू करें'));
    tl.appendChild(list);
    el.append(head, st, tl);

    toggleBtn.addEventListener('click', toggle);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !desktop.matches && !el.hidden) close(); });
    var pref = store('bp_open');
    if (desktop.matches ? pref !== '0' : false) open(true); else close(true);
    desktop.addEventListener('change', function (m) { if (m.matches && store('bp_open') !== '0') open(true); else if (!m.matches) close(true); });
    setInterval(flushStats, 1000);
  }

  function open(silent) {
    el.hidden = false; toggleBtn.setAttribute('aria-expanded', 'true');
    if (!desktop.matches) {
      if (!scrim) { scrim = h('div', 'bp-scrim'); scrim.addEventListener('click', close); }
      document.body.appendChild(scrim);
    }
    if (!silent) store('bp_open', '1');
    list.scrollTop = list.scrollHeight;
  }
  function close(silent) {
    el.hidden = true; toggleBtn.setAttribute('aria-expanded', 'false');
    if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
    if (silent !== true && desktop.matches) store('bp_open', '0');
  }
  function toggle() { if (el.hidden) open(); else close(); }
  function clear() { list.innerHTML = ''; list.appendChild(h('div', 'bp-empty', 'टाइमलाइन साफ़')); total = 0; countEl.textContent = '0'; }

  /** One API call (or client step group) with the backend events it returned. */
  function logCall(c) {
    var empty = list.querySelector('.bp-empty'); if (empty) empty.remove();
    var box = h('div', 'bp-call new' + (c.client ? ' client' : ''));
    var hd = h('div', 'bp-call-h');
    hd.appendChild(h('span', 'bp-m', c.method || 'CLIENT'));
    var p = h('span', 'bp-p', c.path || ''); p.title = c.path || ''; hd.appendChild(p);
    if (c.status != null) {
      var cls = c.status === 0 ? 'bad' : c.status < 300 ? 'ok' : c.status === 409 || c.status === 429 ? 'warn' : 'bad';
      hd.appendChild(h('span', 'bp-s ' + cls, c.status === 0 ? 'NET' : String(c.status)));
    }
    if (c.ms != null) hd.appendChild(h('span', 'bp-ms', Math.round(c.ms) + 'ms'));
    box.appendChild(hd);
    (c.events || []).forEach(function (e) {
      var row = h('div', 'bp-ev' + (e.ok === false ? ' bad' : ''));
      row.appendChild(h('span', 'b'));
      var s = h('div', 'st', e.step || '?'); var t = h('time', null, clock(e.ts)); s.appendChild(t);
      row.appendChild(s);
      row.appendChild(h('div', 'dt', e.detail || ''));
      box.appendChild(row);
      total++;
    });
    var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.appendChild(box);
    while (list.children.length > MAX_CALLS) list.removeChild(list.firstChild);
    if (nearBottom || c.method) list.scrollTop = list.scrollHeight;
    countEl.textContent = String(total);
    setTimeout(function () { box.classList.remove('new'); }, 1100);
  }

  /** Client-side step (player / EME) shown in the same timeline. */
  function clientEvent(step, detail, ok, label) {
    logCall({ client: true, method: 'CLIENT', path: label || 'player', events: [{ ts: new Date().toISOString(), step: step, detail: detail, ok: ok !== false }] });
  }

  /** stats values: string or {v, cls} */
  function setStats(partial) { for (var k in partial) stats[k] = partial[k]; statsDirty = true; }
  function flushStats() {
    if (!statsDirty || !grid || el.hidden) return;
    statsDirty = false;
    grid.querySelectorAll('dd').forEach(function (dd) {
      var v = stats[dd.dataset.k];
      if (v == null) return;
      var text = typeof v === 'object' ? v.v : v;
      if (dd.textContent !== String(text)) { dd.textContent = text; dd.title = text; }
      dd.className = typeof v === 'object' && v.cls ? v.cls : '';
    });
  }

  window.BackendPanel = { init: build, logCall: logCall, clientEvent: clientEvent, setStats: setStats, open: open, close: close, toggle: toggle, clear: clear };
})();
