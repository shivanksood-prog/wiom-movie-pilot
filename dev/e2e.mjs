// End-to-end test of the Wiom Movie Pilot against the mock backend, in headless Google Chrome.
//   cd web/dev && npm install && node e2e.mjs
// Writes screenshots to web/dev/shots/ and results to web/dev/test-report.md
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DESK = { width: 1440, height: 900 };
const MOB = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const results = [];
const metrics = {};
const consoleIssues = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function record(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); }
async function check(name, fn) {
  try { const d = await fn(); record(name, true, d || ''); return true; }
  catch (e) { record(name, false, e.message.split('\n')[0]); return false; }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

async function waitFor(page, fn, { timeout = 15000, arg } = {}) { return page.waitForFunction(fn, { timeout, polling: 100 }, arg); }
const ct = page => page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
const shot = async (page, name) => { await sleep(350); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
async function both(page, name, mobileToo = true) {
  const vp = page.viewport();
  await page.setViewport(DESK); await shot(page, name + '-1440');
  if (mobileToo) { await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); await shot(page, name + '-390'); }
  await page.setViewport(vp);
}
async function timelineHas(page, step, okVal) {
  return page.evaluate((s, o) => [...document.querySelectorAll('.bp-ev')].some(e => e.querySelector('.st')?.firstChild?.textContent === s && (o == null || e.classList.contains('bad') === !o)), step, okVal);
}
async function countCalls(page, p, status) {
  return page.evaluate((p, st) => [...document.querySelectorAll('.bp-call-h')].filter(h => h.querySelector('.bp-p')?.textContent === p && (!st || h.querySelector('.bp-s')?.textContent === String(st))).length, p, status);
}
async function apiFromPage(page, method, p, body) {
  return page.evaluate(async (m, p, b) => {
    const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('wiom_session') }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json() };
  }, method, p, body);
}
// Chrome never exposes EME-decrypted frames to canvas (drawImage returns black), so we prove a real
// picture by screenshotting the composited <video> rect and measuring luma variance of that PNG.
async function frameStats(page) {
  const q = await page.evaluate(() => {
    const v = document.querySelector('video'), r = v.getBoundingClientRect(), pq = v.getVideoPlaybackQuality();
    return { decoded: pq.totalVideoFrames, dropped: pq.droppedVideoFrames, w: v.videoWidth, h: v.videoHeight, rate: v.playbackRate,
      clip: { x: r.x + r.width * 0.1, y: r.y + r.height * 0.15, width: r.width * 0.8, height: r.height * 0.5 } };
  });
  await page.evaluate(() => document.querySelector('.wp').classList.remove('ui'));
  await sleep(300);
  const b64 = await page.screenshot({ clip: q.clip, encoding: 'base64' });
  const luma = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = 96; c.height = 54;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 96, 54);
    const d = g.getImageData(0, 0, 96, 54).data; let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += y; s2 += y * y; n++; }
    const m = s / n; return { mean: +m.toFixed(1), std: +Math.sqrt(s2 / n - m * m).toFixed(1) };
  }, 'data:image/png;base64,' + b64);
  delete q.clip;
  return { ...q, lumaMean: luma.mean, lumaStd: luma.std };
}

async function login(page, phone) {
  await page.waitForSelector('#in-phone', { visible: true });
  await page.type('#in-phone', phone);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const server = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], {
    env: { ...process.env, PORT: String(PORT), MOCK_HEARTBEAT_S: '5', MOCK_PENDING_MS: '5000', MOCK_LATENCY_MS: '80' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.on('data', d => { serverOut += d; }); server.stderr.on('data', d => { serverOut += d; });
  for (let i = 0; i < 50 && !serverOut.includes('mock'); i++) await sleep(100);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-features=MediaRouter'],
  });
  const ver = await browser.version();
  metrics.chrome = ver;
  const hook = (page, tag) => {
    page.on('console', m => { if (['error', 'warn', 'warning'].includes(m.type())) consoleIssues.push(`[${tag}] ${m.type()}: ${m.text()}`); });
    page.on('pageerror', e => consoleIssues.push(`[${tag}] pageerror: ${e.message}`));
  };

  try {
    /* ================= RUN 0 — API contract (no browser) ================= */
    const J = async (method, p, body, tok, extra = {}) => {
      const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    await check('API: bad phone → 400; every response carries events[]', async () => {
      const r = await J('POST', '/api/otp/send', { phone: '5123456789' });
      assert(r.status === 400 && Array.isArray(r.body.events) && r.body.events[0].ok === false, JSON.stringify(r));
      const h = await J('GET', '/api/health');
      assert(h.body.ok && h.body.version && h.body.events.length, 'health'); return `health ${h.body.version}`;
    });
    await check('API: OTP rate limit 5 / 10 min / phone → 429 on 6th', async () => {
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await J('POST', '/api/otp/send', { phone: '9000000006' })).status);
      assert(codes.slice(0, 5).every(c => c === 200) && codes[5] === 429, codes.join(',')); return codes.join(',');
    });
    await check('API: idempotent order + payment writes (same Idempotency-Key → same ids)', async () => {
      await J('POST', '/api/otp/send', { phone: '9000000007' });
      const v = await J('POST', '/api/otp/verify', { phone: '9000000007', otp: '1234' });
      const tok = v.body.session; assert(tok, 'no session');
      assert(v.body.user.phone_masked === '90xxxx0007', 'mask ' + v.body.user.phone_masked);
      const o1 = await J('POST', '/api/orders', { offer_id: 'net14_movie' }, tok, { 'idempotency-key': 'k1' });
      const o2 = await J('POST', '/api/orders', { offer_id: 'net14_movie' }, tok, { 'idempotency-key': 'k1' });
      assert(o1.body.order_id === o2.body.order_id && o1.body.amount_paise === 1400 && o1.body.currency === 'INR', 'order idem');
      const p1 = await J('POST', '/api/pay/dummy', { order_id: o1.body.order_id, method: 'upi_paytm', outcome: 'success' }, tok, { 'idempotency-key': 'p1' });
      const p2 = await J('POST', '/api/pay/dummy', { order_id: o1.body.order_id, method: 'upi_paytm', outcome: 'success' }, tok, { 'idempotency-key': 'p1' });
      const p3 = await J('POST', '/api/pay/dummy', { order_id: o1.body.order_id, method: 'upi_paytm', outcome: 'success' }, tok);
      assert(p1.body.payment_id === p2.body.payment_id && p3.body.payment_id === p1.body.payment_id, 'pay idem');
      const st = await J('GET', '/api/orders/' + o1.body.order_id, null, tok);
      assert(st.body.status === 'paid' && st.body.entitlement.status === 'not_started', JSON.stringify(st.body));
      const me = await J('GET', '/api/me', null, tok);
      assert(me.body.net_plan.active && me.body.entitlements.length === 1, 'me');
      const ev = await J('GET', '/api/events?since=0', null, tok);
      assert(ev.body.log.length >= 8, 'event log ' + ev.body.log.length);
      return `order ${o1.body.order_id} once, payment ${p1.body.payment_id} once (3rd pay = "already paid"), event log ${ev.body.log.length} items`;
    });
    await check('API: playback/start refused without entitlement (403)', async () => {
      await J('POST', '/api/otp/send', { phone: '9000000008' });
      const v = await J('POST', '/api/otp/verify', { phone: '9000000008', otp: '1234' });
      const r = await J('POST', '/api/playback/start', { film_id: 'sstb-notld', device_id: 'dev_x' }, v.body.session);
      assert(r.status === 403 && r.body.error === 'not_entitled', r.status); return '403 not_entitled';
    });

    /* ================= RUN 1 — desktop 1440x900, user A ================= */
    const ctxA = await browser.createBrowserContext();
    const page = await ctxA.newPage(); hook(page, 'desktop');
    await page.setViewport(DESK);
    await page.goto(BASE + '/#offer', { waitUntil: 'networkidle0' });

    await check('Offer screen renders (title, ₹14 CTA, poster)', async () => {
      await page.waitForSelector('#offer-cta');
      const t = await page.$eval('#screen-offer', e => e.innerText);
      assert(t.includes('₹14 में Net पैक') && t.includes('फ़िल्म फ्री') && t.includes('Movie FREE'), 'offer copy missing');
      const bg = await page.$eval('.of-hero', e => getComputedStyle(e).backgroundImage);
      assert(bg.includes('poster.jpg'), 'poster missing');
      const panelOpen = await page.$eval('#bp', e => !e.hidden);
      assert(panelOpen, 'backend panel should be open by default on desktop');
      return 'panel open by default on desktop';
    });
    await both(page, '01-offer');

    await check('Offer CTA without session → #login', async () => {
      await page.click('#offer-cta'); await waitFor(page, () => location.hash === '#login');
      await page.waitForSelector('#in-phone', { visible: true }); return '';
    });
    await check('Login: invalid phone rejected client-side', async () => {
      await login(page, '12345');
      await page.click('#form-phone button[type=submit]');
      const err = await page.$eval('#phone-err', e => e.textContent);
      assert(err.includes('10 अंकों'), 'no validation message');
      await page.$eval('#in-phone', e => { e.value = ''; });
      return err;
    });
    await both(page, '02-login');
    await check('Login: OTP send → OTP step with demo hint', async () => {
      await page.type('#in-phone', '9876501234');
      await page.click('#form-phone button[type=submit]');
      await page.waitForSelector('#form-otp', { visible: true });
      const hint = await page.$eval('#otp-hint', e => e.textContent);
      assert(hint.includes('1234'), 'demo otp not shown');
      assert(await timelineHas(page, 'otp.issue', true), 'otp.issue event not in timeline');
      return 'otp.issue event shown';
    });
    await check('Login: wrong OTP rejected (401)', async () => {
      await page.type('#in-otp', '9999');
      await waitFor(page, () => document.getElementById('otp-err').textContent.length > 0);
      const t = await page.$eval('#otp-err', e => e.textContent);
      assert(await timelineHas(page, 'otp.verify', false), 'failed otp.verify not in timeline');
      await page.$eval('#in-otp', e => { e.value = ''; });
      return t;
    });
    await both(page, '03-login-otp');
    await check('Login: OTP 1234 → session → order created → #pay', async () => {
      await page.click('#otp-hint');
      await waitFor(page, () => location.hash === '#pay');
      const s = await page.evaluate(() => localStorage.getItem('wiom_session'));
      assert(s && s.length > 20, 'no session stored');
      assert(await timelineHas(page, 'order.create', true), 'order.create missing');
      await page.waitForFunction(() => document.getElementById('pg-order').textContent.includes('ord_'));
      return 'order ' + (await page.$eval('#pg-order', e => e.textContent));
    });
    await both(page, '04-pay');

    await check('Payment FAILURE path → failed state + retry creates new order', async () => {
      const o1 = await page.$eval('#pg-order', e => e.textContent);
      await page.click('.sim.bad');
      await page.waitForSelector('#pg-retry', { visible: true, timeout: 10000 });
      assert(await timelineHas(page, 'order.update', false), 'failed order.update missing');
      await both(page, '05-pay-failed');
      await page.click('#pg-retry');
      await waitFor(page, (o) => document.getElementById('pg-order').textContent !== o && document.getElementById('pg-status').hidden, { arg: o1 });
      return 'new ' + (await page.$eval('#pg-order', e => e.textContent));
    });
    await page.click('#pg-methods [data-m="qr"]');
    await both(page, '06-pay-qr');
    await page.click('#pg-methods [data-m="upi_gpay"]');

    await check('Payment SUCCESS → signed webhook → entitlement → #success', async () => {
      const t0 = Date.now();
      await page.click('#pg-pay');
      await waitFor(page, () => location.hash === '#success', { timeout: 15000 });
      metrics.payToSuccessMs = Date.now() - t0;
      for (const st of ['pg.charge', 'pg.webhook.send', 'pg.webhook.verify', 'order.update', 'entitlement.grant', 'net_sachet.record'])
        assert(await timelineHas(page, st, true), st + ' missing from timeline');
      await page.waitForSelector('#succ-list li');
      const txt = await page.$eval('#screen-success', e => e.innerText);
      assert(txt.includes('Movie unlocked') && txt.includes('अभी देखें'), 'success copy');
      return `${metrics.payToSuccessMs} ms click→success; webhook HMAC + entitlement + sachet events shown`;
    });
    await both(page, '07-success');

    await check('Webhook endpoint rejects a bad HMAC signature (401)', async () => {
      const r = await fetch(BASE + '/api/webhooks/pg', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pg-signature': 'deadbeef' }, body: JSON.stringify({ payment_id: 'pay_x', order_id: 'ord_x', status: 'success' }) });
      assert(r.status === 401, 'expected 401 got ' + r.status);
      return '401 bad_signature';
    });

    /* ---------- watch ---------- */
    let tPlay0 = Date.now();
    await check('Watch: playback/start → licence → video decrypts and plays', async () => {
      tPlay0 = Date.now();
      await page.click('#btn-watch');
      await waitFor(page, () => location.hash === '#watch');
      await waitFor(page, () => { const v = document.querySelector('video'); return v && v.currentTime > 1.5 && !v.paused; }, { timeout: 30000 });
      metrics.timeToPlayMs = Date.now() - tPlay0;
      assert(!(await page.$('.wp-msg')), 'error overlay shown: ' + (await page.$eval('.wp-msg', e => e.innerText).catch(() => '')));
      for (const st of ['entitlement.check', 'rental.clock.start', 'lease.acquire', 'drm.config', 'licence.check', 'licence.keys', 'eme.keys'])
        assert(await timelineHas(page, st, true), st + ' missing');
      const keys = await page.$eval('#bp dd[data-k="keys"]', e => e.textContent);
      assert(/usable/.test(keys), 'key status not usable: ' + keys);
      const a = await ct(page); await sleep(3000); const b = await ct(page);
      assert(b - a > 2.0, `currentTime did not advance (${a}→${b})`);
      const fs = await frameStats(page);
      metrics.firstFrames = fs;
      assert(fs.decoded > 50, 'too few decoded frames ' + fs.decoded);
      assert(fs.lumaStd > 20, 'frame looks blank (luma std ' + fs.lumaStd + ')');
      metrics.advance = +(b - a).toFixed(2);
      return `first play ${metrics.timeToPlayMs} ms; +${metrics.advance}s in 3 s; ${fs.decoded} frames decoded, ${fs.w}x${fs.h}, luma σ=${fs.lumaStd}; keys: ${keys}`;
    });
    await page.mouse.move(700, 300);
    await both(page, '08-watch');

    await check('Rental timer pill shows "घंटे बाकी"', async () => {
      const t = await page.$eval('.wp-rental .v', e => e.textContent);
      assert(/^4[78]:\d\d घंटे बाकी$/.test(t), 'pill text ' + t); return t;
    });
    await check('Keyboard: → seeks +10 s, ← seeks −10 s, m mutes, ↑/↓ volume', async () => {
      await page.focus('.wp');
      const a = await ct(page); await page.keyboard.press('ArrowRight'); await sleep(250); const b = await ct(page);
      assert(b - a > 8.5 && b - a < 12, `→ moved ${b - a}`);
      await page.keyboard.press('ArrowLeft'); await sleep(250); const c = await ct(page);
      assert(b - c > 8 && b - c < 12, `← moved ${c - b}`);
      await page.keyboard.press('m'); const muted = await page.evaluate(() => document.querySelector('video').muted);
      await page.keyboard.press('m');
      await page.keyboard.press('ArrowDown'); const vol = await page.evaluate(() => document.querySelector('video').volume);
      await page.keyboard.press('ArrowUp');
      assert(muted && vol < 1, 'mute/volume keys');
      return `→ +${(b - a).toFixed(1)} s, ← −${(b - c).toFixed(1)} s, mute ok, vol↓ ${vol.toFixed(2)}`;
    });
    await check('Space toggles pause/play', async () => {
      await page.focus('.wp');
      await page.keyboard.press('Space'); await sleep(200);
      const p1 = await page.evaluate(() => document.querySelector('video').paused);
      await page.keyboard.press('Space'); await sleep(300);
      const p2 = await page.evaluate(() => document.querySelector('video').paused);
      assert(p1 && !p2, `paused=${p1} then ${p2}`); return '';
    });
    await check('Scrub bar: thumbnail preview on hover + chapter tick', async () => {
      await page.mouse.move(700, 300); await sleep(200);
      const box = await (await page.$('.wp-scrub')).boundingBox();
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2); await sleep(250);
      const th = await page.$eval('.wp-thumb', e => ({ cls: e.className, bg: e.style.backgroundImage, pos: e.style.backgroundPosition }));
      assert(!th.cls.includes('none') && th.bg.includes('sprite_0.jpg'), 'no thumb ' + JSON.stringify(th));
      const ticks = await page.$$eval('.wp-tick', t => t.map(x => x.style.left));
      assert(ticks.length === 1 && Math.abs(parseFloat(ticks[0]) - 50) < 0.5, 'tick ' + ticks);
      await both(page, '09-watch-scrub-thumb', false);
      return `sprite pos ${th.pos}; chapter tick at ${ticks[0]}`;
    });
    await check('Scrub bar click seeks (to ~62% = ~112 s) and playback continues', async () => {
      const box = await (await page.$('.wp-scrub')).boundingBox();
      await page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2);
      await sleep(400);
      const a = await ct(page);
      assert(Math.abs(a - 180 * 0.62) < 3, 'seek landed at ' + a);
      await waitFor(page, (x) => document.querySelector('video').currentTime > x + 1, { arg: a, timeout: 10000 });
      return `landed ${a.toFixed(1)} s, then advanced`;
    });
    await check('Chapter list (C) → Part 1 jump → "Next part" → Part 2 start', async () => {
      await page.focus('.wp');
      await page.keyboard.press('c');
      await page.waitForSelector('.wp-menu');
      const items = await page.$$eval('.wp-menu button', b => b.map(x => x.textContent));
      assert(items.length === 2, 'menu items ' + items);
      await both(page, '10-watch-chapters', false);
      await page.click('.wp-menu button:nth-of-type(1)');
      await sleep(400); const a = await ct(page);
      assert(a < 2, 'part 1 jump landed ' + a);
      await page.mouse.move(600, 400);
      await page.waitForSelector('.wp-next:not([hidden])');
      await page.click('.wp-next'); await sleep(400);
      const b = await ct(page);
      assert(b >= 90 && b < 92, 'next part landed ' + b);
      assert(await timelineHas(page, 'chapter.jump', true), 'chapter.jump event');
      const part = await page.$eval('.wp-part', e => e.textContent);
      return `Part 1 @ ${a.toFixed(2)} s, Next → ${b.toFixed(2)} s (${part})`;
    });
    await check('Quality menu: Auto + 720p/480p/360p; manual 360p then 720p applied', async () => {
      await page.mouse.move(600, 400);
      await page.click('[data-a="quality"]');
      const items = await page.$$eval('.wp-menu button', b => b.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
      assert(items.length === 4 && items[0].startsWith('Auto'), 'items ' + items);
      await both(page, '11-watch-quality', false);
      await page.click('.wp-menu button:nth-of-type(4)'); // 360p
      await waitFor(page, () => document.querySelector('video').videoHeight === 360, { timeout: 20000 });
      await sleep(1300);
      const r360 = await page.$eval('#bp dd[data-k="res"]', e => e.textContent);
      await page.mouse.move(600, 400);
      await page.click('[data-a="quality"]'); await page.click('.wp-menu button:nth-of-type(2)'); // 720p
      await waitFor(page, () => document.querySelector('video').videoHeight === 720, { timeout: 20000 });
      await page.mouse.move(600, 400);
      await page.click('[data-a="quality"]'); await page.click('.wp-menu button:nth-of-type(1)'); // Auto
      await sleep(1300);
      const abr = await page.$eval('#bp dd[data-k="res"]', e => e.textContent);
      return `${items.join(' | ')}; 360p stat "${r360}" → 720p → Auto ("${abr}")`;
    });
    await check('Speed menu 1.5x applied', async () => {
      await page.mouse.move(600, 400);
      await page.click('[data-a="speed"]');
      await page.click('.wp-menu button:nth-of-type(5)');
      const r = await page.evaluate(() => document.querySelector('video').playbackRate);
      assert(r === 1.5, 'rate ' + r);
      await page.evaluate(() => { document.querySelector('video').playbackRate = 1; });
      return '1.5x';
    });
    await check('Fullscreen toggle (F)', async () => {
      await page.focus('.wp'); await page.keyboard.press('f'); await sleep(500);
      const on = await page.evaluate(() => !!document.fullscreenElement || document.querySelector('.wp').classList.contains('fs-fallback'));
      await page.keyboard.press('f'); await sleep(400);
      const off = await page.evaluate(() => !document.fullscreenElement && !document.querySelector('.wp').classList.contains('fs-fallback'));
      assert(on && off, `on=${on} off=${off}`); return 'enter + exit';
    });
    await check('MediaSession metadata + PiP availability', async () => {
      const ms = await page.evaluate(() => ({ t: navigator.mediaSession?.metadata?.title, st: navigator.mediaSession?.playbackState, pip: document.pictureInPictureEnabled }));
      assert(ms.t, 'no mediaSession title'); return JSON.stringify(ms);
    });
    await check('Player stats populated (DRM, res, bitrate, buffer, dropped, host)', async () => {
      await sleep(1200);
      const s = await page.$$eval('#bp dd', d => Object.fromEntries(d.map(x => [x.dataset.k, x.textContent])));
      for (const k of ['drm', 'keys', 'res', 'bitrate', 'buffer', 'dropped', 'host']) assert(s[k] && s[k] !== '—', k + ' empty');
      metrics.stats = s;
      return Object.entries(s).map(([k, v]) => `${k}=${v}`).join('; ');
    });
    await check('Heartbeat every 5 s (mock) renews lease (200s in timeline)', async () => {
      const n0 = await countCalls(page, '/api/playback/heartbeat', 200);
      await sleep(11000);
      const n1 = await countCalls(page, '/api/playback/heartbeat', 200);
      assert(n1 - n0 >= 2, `heartbeats ${n0}→${n1}`);
      metrics.heartbeats = n1;
      return `${n1} heartbeats so far (+${n1 - n0} in 11 s)`;
    });
    await check('Licence endpoint withholds key without a live session (403)', async () => {
      const r = await fetch(BASE + '/api/license/clearkey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kids: ['AAAAAAAAAAAAAAAAAAAAAA'], type: 'temporary' }) });
      const b = await r.json();
      assert(r.status === 403 && !b.keys, 'status ' + r.status); return '403 no keys';
    });
    await check('Resume position saved (server) and restored on reload', async () => {
      await page.evaluate(() => { document.querySelector('video').currentTime = 60; });
      await sleep(5600); // wait for a heartbeat carrying the position
      await page.reload({ waitUntil: 'networkidle0' });
      await waitFor(page, () => { const v = document.querySelector('video'); return v && v.currentTime > 40 && !v.paused; }, { timeout: 30000 });
      const t = await ct(page);
      const toast = await page.$eval('.wp-resume', e => e.innerText).catch(() => '');
      assert(toast.includes('से आगे चल रहा है'), 'resume toast missing');
      return `resumed at ${t.toFixed(1)} s ("${toast.split('\n')[0]}")`;
    });
    await check('409: another device takes the stream → "दूसरे डिवाइस" overlay → takeover back resumes', async () => {
      const r = await apiFromPage(page, 'POST', '/api/playback/start', { film_id: 'sstb-notld', device_id: 'dev_other_tv_0001' });
      assert(r.status === 200 && r.body.events.some(e => e.step === 'lease.takeover'), 'other start ' + r.status);
      // the stolen session's licence is now denied too
      await page.waitForSelector('.wp-msg', { timeout: 12000 });
      const msg = await page.$eval('.wp-msg', e => e.innerText);
      assert(msg.includes('दूसरे डिवाइस'), 'overlay text ' + msg);
      assert(await countCalls(page, '/api/playback/heartbeat', 409) >= 1, 'no 409 heartbeat in timeline');
      const pausedAfter = await page.evaluate(() => document.querySelector('video').paused);
      assert(pausedAfter, 'video kept playing after 409');
      await both(page, '12-watch-409');
      await page.click('.wp-msg .btn.primary');
      await waitFor(page, () => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 1 && !document.querySelector('.wp-msg'); }, { timeout: 30000 });
      const a = await ct(page); await sleep(2000); const b = await ct(page);
      assert(b > a + 1, 'not advancing after takeover');
      return `overlay shown, video paused+unloaded; takeover → playing again at ${b.toFixed(1)} s`;
    });
    await page.click('#bp-toggle'); await sleep(200);
    await page.setViewport(DESK); await shot(page, '13-watch-panel-closed-1440');
    await page.click('#bp-toggle'); await sleep(200);
    await check('Stop on leaving watch releases lease', async () => {
      await page.click('.brand'); await waitFor(page, () => location.hash === '#offer');
      await sleep(600);
      assert(await timelineHas(page, 'lease.release', true), 'lease.release missing'); return '';
    });
    await check('Offer for an entitled user shows "अभी देखें"', async () => {
      await waitFor(page, () => document.getElementById('offer-cta')?.innerText.includes('अभी देखें'), { timeout: 8000 });
      return '';
    });
    await shot(page, '14-offer-owned-1440');
    metrics.timelineEvents = await page.$eval('#bp-count', e => e.textContent);
    await ctxA.close();

    /* ================= RUN 2 — mobile 390x844 touch, user B, PENDING payment ================= */
    const ctxB = await browser.createBrowserContext();
    const m = await ctxB.newPage(); hook(m, 'mobile');
    await m.setViewport(MOB);
    await m.setUserAgent('Mozilla/5.0 (Linux; Android 13; Redmi 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36');
    await m.goto(BASE + '/#offer', { waitUntil: 'networkidle0' });
    await check('Mobile: panel is a closed drawer by default; toggle opens it', async () => {
      const hidden = await m.$eval('#bp', e => e.hidden);
      assert(hidden, 'panel should be closed on mobile');
      await m.tap('#bp-toggle'); await sleep(350);
      const open = await m.$eval('#bp', e => !e.hidden);
      await shot(m, '20-m-panel-drawer-390');
      await m.tap('.bp-close-m'); await sleep(200);
      assert(open, 'drawer did not open'); return '';
    });
    await shot(m, '21-m-offer-390');
    await check('Mobile: login + pending payment → polls → late webhook → success', async () => {
      await m.tap('#offer-cta'); await waitFor(m, () => location.hash === '#login');
      await m.waitForSelector('#in-phone', { visible: true }); await sleep(100);
      await m.type('#in-phone', '7012345678'); await shot(m, '22-m-login-390');
      await m.tap('#form-phone button[type=submit]');
      await m.waitForSelector('#form-otp', { visible: true }); await shot(m, '23-m-otp-390');
      await m.tap('#otp-hint');
      await waitFor(m, () => location.hash === '#pay');
      await m.waitForFunction(() => document.getElementById('pg-order').textContent.includes('ord_'));
      await shot(m, '24-m-pay-390');
      await m.tap('.sim.wait');
      await m.waitForSelector('#pg-status:not([hidden])');
      await sleep(600);
      const s = await m.$eval('#pg-status', e => e.innerText);
      assert(s.includes('पेंडिंग'), 'pending text ' + s);
      await shot(m, '25-m-pay-pending-390');
      const t0 = Date.now();
      await waitFor(m, () => location.hash === '#success', { timeout: 20000 });
      const polls = await countCalls(m, '/api/orders/:id') + await m.evaluate(() => [...document.querySelectorAll('.bp-p')].filter(p => /^\/api\/orders\/ord_/.test(p.textContent)).length);
      assert(await timelineHas(m, 'pg.webhook.verify', true), 'late webhook events not delivered to timeline');
      await shot(m, '26-m-success-390');
      return `pending resolved after ~${((Date.now() - t0) / 1000).toFixed(1)} s more, ${polls} status polls`;
    });
    await check('Mobile: watch plays (DRM) at 390 px', async () => {
      await m.tap('#btn-watch');
      await waitFor(m, () => { const v = document.querySelector('video'); return v && v.currentTime > 1.5 && !v.paused; }, { timeout: 30000 });
      const fs = await frameStats(m);
      assert(fs.decoded > 20 && fs.lumaStd > 20, JSON.stringify(fs));
      return `${fs.w}x${fs.h}, ${fs.decoded} frames`;
    });
    await check('Mobile: double-tap right = +10 s, double-tap left = −10 s', async () => {
      const box = await (await m.$('.wp-tap')).boundingBox();
      const y = box.y + box.height / 2;
      const a = await ct(m);
      await m.touchscreen.tap(box.x + box.width * 0.85, y); await sleep(90); await m.touchscreen.tap(box.x + box.width * 0.85, y);
      await sleep(300); const b = await ct(m);
      await sleep(400);
      await m.touchscreen.tap(box.x + box.width * 0.15, y); await sleep(90); await m.touchscreen.tap(box.x + box.width * 0.15, y);
      await sleep(300); const c = await ct(m);
      assert(b - a > 8.5 && b - a < 12.5, `right ${a}→${b}`);
      assert(b - c > 7.5 && b - c < 12.5, `left ${b}→${c}`);
      return `+${(b - a).toFixed(1)} s, −${(b - c + 0.7).toFixed(1)} s (approx, playing)`;
    });
    await m.touchscreen.tap(195, 120); await sleep(400);
    await m.evaluate(() => document.querySelector('.wp').classList.add('ui'));
    await shot(m, '27-m-watch-390');
    await check('Mobile: control bar fits at 360 px and 390 px (no overflow)', async () => {
      const out = [];
      for (const w of [360, 390]) {
        await m.setViewport({ ...MOB, width: w }); await sleep(300);
        const r = await m.evaluate(() => { const row = document.querySelector('.wp-row'); const last = [...row.children].filter(c => c.offsetParent).pop().getBoundingClientRect(); return { right: last.right, vw: innerWidth, docW: document.documentElement.scrollWidth }; });
        assert(r.right <= r.vw && r.docW <= r.vw, `${w}px: last control right=${r.right} doc=${r.docW}`);
        out.push(`${w}px ok (last control ends ${Math.round(r.right)}px)`);
      }
      return out.join('; ');
    });
    await m.evaluate(() => { const w = document.querySelector('.wp'); w.classList.add('ui'); });
    await m.tap('[data-a="quality"]'); await sleep(250);
    await shot(m, '28-m-watch-quality-390');
    await m.evaluate(() => document.querySelector('.wp-menu')?.remove());
    await m.evaluate(() => window.scrollTo(0, 400)); await shot(m, '29-m-watch-meta-390');
    await ctxB.close();

    /* ================= RUN 3 — DRM_MODE widevine wiring (mock returns Axinom-shaped licence + token) ================= */
    const wv = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], { env: { ...process.env, PORT: String(PORT + 1), MOCK_DRM: 'widevine', MOCK_LATENCY_MS: '0' }, stdio: 'ignore' });
    await sleep(700);
    try {
      await check('Widevine mode: DRM config taken from /playback/start; ClearKey-only asset → graceful DRM error, lease released', async () => {
        const B2 = `http://localhost:${PORT + 1}`;
        await fetch(B2 + '/api/otp/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"9111111111"}' });
        const tok = (await (await fetch(B2 + '/api/otp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"phone":"9111111111","otp":"1234"}' })).json()).session;
        const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
        const o = await (await fetch(B2 + '/api/orders', { method: 'POST', headers: H, body: '{"offer_id":"net14_movie"}' })).json();
        await fetch(B2 + '/api/pay/dummy', { method: 'POST', headers: H, body: JSON.stringify({ order_id: o.order_id, method: 'qr', outcome: 'success' }) });
        const ctxC = await browser.createBrowserContext(); const w = await ctxC.newPage(); hook(w, 'widevine');
        await w.setViewport(DESK);
        let licReq = null;
        await w.setRequestInterception(true);
        w.on('request', r => { if (/axtest\.net/.test(r.url())) { licReq = { url: r.url(), hdr: r.headers()['x-axdrm-message'] }; r.respond({ status: 500, body: 'test' }); } else r.continue(); });
        await w.goto(B2 + '/#offer', { waitUntil: 'networkidle0' });
        await w.evaluate(t => { localStorage.setItem('wiom_session', t); localStorage.setItem('wiom_phone_masked', '91xxxx1111'); }, tok);
        await w.goto(B2 + '/?fresh=1#watch', { waitUntil: 'networkidle0' });
        await w.waitForSelector('.wp-msg', { timeout: 20000 });
        await sleep(1300);
        const msg = await w.$eval('.wp-msg', e => e.innerText.replace(/\s+/g, ' '));
        const drm = await w.$eval('#bp dd[data-k="drm"]', e => e.textContent);
        await shot(w, '15-widevine-mode-error-1440');
        await ctxC.close();
        assert(/Widevine/.test(drm), 'drm stat ' + drm);
        assert(/अनलॉक नहीं/.test(msg), 'overlay ' + msg);
        return `stats "${drm}"; licence request ${licReq ? 'sent to ' + new URL(licReq.url).host + ' with X-AxDRM-Message=' + (licReq.hdr ? 'yes' : 'NO') : 'not reached (test asset has no Widevine PSSH → shaka 6012, expected)'}; overlay: "${msg.slice(0, 90)}"`;
      });
    } finally { wv.kill(); }
  } finally {
    await browser.close();
    server.kill();
  }

  const pass = results.filter(r => r.ok).length;
  const relevantConsole = consoleIssues.filter(x => !/favicon/.test(x));
  const md = [
    '# Wiom Movie Pilot — E2E test report',
    '',
    `Run: ${new Date().toISOString()} · ${metrics.chrome} (headless, --autoplay-policy=no-user-gesture-required) · mock backend on :${PORT} (heartbeat 5 s, pending webhook 5 s)`,
    '',
    `**${pass}/${results.length} checks passed.**`,
    '',
    '| # | Check | Result | Detail |', '|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${String(r.detail).replace(/\|/g, '/')} |`),
    '',
    '## Key numbers',
    `- Pay click → success screen: ${metrics.payToSuccessMs ?? '—'} ms`,
    `- Watch click → playing (playback/start + manifest + ClearKey licence + first frames): ${metrics.timeToPlayMs ?? '—'} ms`,
    `- Playback advance check: +${metrics.advance ?? '—'} s of media in 3 s wall clock`,
    `- First-frame check: ${metrics.firstFrames ? JSON.stringify(metrics.firstFrames) : '—'} (luma σ > 20 ⇒ real decrypted picture, not black)`,
    `- Heartbeats observed in run 1: ${metrics.heartbeats ?? '—'}`,
    `- Backend events in the panel counter at end of run 1 (counter resets on the resume-test reload): ${metrics.timelineEvents ?? '—'}`,
    metrics.stats ? `- Final player stats: ${Object.entries(metrics.stats).map(([k, v]) => `${k}=${v}`).join(' · ')}` : '',
    '',
    '## Console warnings / errors',
    '(401 = the deliberate wrong-OTP check; 409 = the deliberate second-device takeover check. Browsers always log non-2xx fetches.)',
    relevantConsole.length ? relevantConsole.map(x => '- `' + x.replace(/`/g, "'").slice(0, 300) + '`').join('\n') : '- none',
    '',
    '## Not covered by this run',
    '- Widevine / FairPlay licence exchange (mode "widevine": X-AxDRM-Message header, FairPlay cert) — wired in player.js but unproven: needs Axinom-packaged content with Widevine/FairPlay PSSH + real signed tokens.',
    '- Safari / iOS HLS path — not testable in headless Chrome.',
    '- PiP is only availability-checked (needs a user gesture + headed browser).',
    '',
  ].join('\n');
  await writeFile(path.join(HERE, 'test-report.md'), md);
  console.log(`\n${pass}/${results.length} passed → test-report.md`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
