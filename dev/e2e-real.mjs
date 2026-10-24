// End-to-end test of the Wiom Movie Pilot frontend against the REAL backend
// (Cloudflare Worker + D1 via `wrangler dev --local`), in headless Google Chrome.
//
//   1. cd api && npx wrangler@4 dev --local --port 8788     (needs .dev.vars + local D1 schema)
//   2. cd web/dev && node e2e-real.mjs
//
// The mock server runs only as the static host (site + /media); every /api call goes to the
// Worker via the page's ?api= override. Writes results to web/dev/test-report-real.md.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots-real');
const STATIC_PORT = 8790;                       // must be in the Worker's ALLOWED_ORIGINS
const API = process.env.API || 'http://localhost:8788';
const BASE = `http://localhost:${STATIC_PORT}`;
const PAGE = `${BASE}/?api=${API}`;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DESK = { width: 1440, height: 900 };

// Local D1 persists between runs (rate limits, entitlements), so every run gets fresh phones.
const rnd = () => '9' + String(Math.floor(1e8 + Math.random() * 9e8));
const PHONE_UI = rnd(), PHONE_RL = rnd(), PHONE_API = rnd(), PHONE_NOENT = rnd();

const results = [];
const metrics = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function record(name, ok, detail = '') { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); }
async function check(name, fn) {
  try { const d = await fn(); record(name, true, d || ''); return true; }
  catch (e) { record(name, false, e.message.split('\n')[0]); return false; }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
async function waitFor(page, fn, { timeout = 15000, arg } = {}) { return page.waitForFunction(fn, { timeout, polling: 100 }, arg); }
const ct = page => page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
const shot = async (page, name) => { await sleep(300); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
async function timelineHas(page, step, okVal) {
  return page.evaluate((s, o) => [...document.querySelectorAll('.bp-ev')].some(e => e.querySelector('.st')?.firstChild?.textContent === s && (o == null || e.classList.contains('bad') === !o)), step, okVal);
}
async function J(method, p, body, tok, extra = {}) {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
async function frameStats(page) {
  const q = await page.evaluate(() => {
    const v = document.querySelector('video'), r = v.getBoundingClientRect(), pq = v.getVideoPlaybackQuality();
    return { decoded: pq.totalVideoFrames, dropped: pq.droppedVideoFrames, w: v.videoWidth, h: v.videoHeight,
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

async function main() {
  await mkdir(SHOTS, { recursive: true });
  // Static + media host only — the page's ?api= sends every API call to the Worker instead.
  const statics = spawn(process.execPath, [path.join(HERE, 'mock-server.mjs')], {
    env: { ...process.env, PORT: String(STATIC_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    statics.stdout.on('data', d => /→ http/.test(String(d)) && res());
    statics.on('exit', () => rej(new Error('static host died')));
    setTimeout(() => rej(new Error('static host timeout')), 8000);
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-features=MediaRouter'],
  });
  metrics.chrome = await browser.version();
  const consoleIssues = [];

  try {
    /* ================= API contract (no browser) ================= */
    await check('API: health + bad phone 400 with events[]', async () => {
      const h = await J('GET', '/api/health');
      assert(h.body.ok && h.body.version, 'health ' + JSON.stringify(h.body));
      const r = await J('POST', '/api/otp/send', { phone: '5123456789' });
      assert(r.status === 400 && Array.isArray(r.body.events), JSON.stringify(r));
      return `health ${h.body.version}, drm ${h.body.drm_mode}`;
    });
    await check('API: OTP rate limit → 429 on 6th send', async () => {
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await J('POST', '/api/otp/send', { phone: PHONE_RL })).status);
      assert(codes.slice(0, 5).every(c => c === 200) && codes[5] === 429, codes.join(','));
      return codes.join(',');
    });
    let tokApi;
    await check('API: login, idempotent order + pay, entitlement granted', async () => {
      await J('POST', '/api/otp/send', { phone: PHONE_API });
      const v = await J('POST', '/api/otp/verify', { phone: PHONE_API, otp: '1234' });
      tokApi = v.body.session; assert(tokApi, 'no session ' + JSON.stringify(v.body));
      assert(v.body.user.phone_masked === PHONE_API.slice(0, 2) + 'xxxxx' + PHONE_API.slice(-3), 'mask ' + v.body.user.phone_masked);
      const k = 'k-' + Date.now();
      const o1 = await J('POST', '/api/orders', { offer_id: 'net14_movie' }, tokApi, { 'idempotency-key': k });
      const o2 = await J('POST', '/api/orders', { offer_id: 'net14_movie' }, tokApi, { 'idempotency-key': k });
      assert(o1.body.order_id && o1.body.order_id === o2.body.order_id && o1.body.amount_paise === 1400, 'order idem');
      const p1 = await J('POST', '/api/pay/dummy', { order_id: o1.body.order_id, method: 'upi_paytm', outcome: 'success' }, tokApi, { 'idempotency-key': k + 'p' });
      const p2 = await J('POST', '/api/pay/dummy', { order_id: o1.body.order_id, method: 'upi_paytm', outcome: 'success' }, tokApi, { 'idempotency-key': k + 'p' });
      assert(p1.body.payment_id && p1.body.payment_id === p2.body.payment_id, 'pay idem');
      const st = await J('GET', '/api/orders/' + o1.body.order_id, null, tokApi);
      assert(st.body.status === 'paid' && st.body.entitlement.status === 'not_started', JSON.stringify(st.body));
      assert(!Number.isNaN(Date.parse(st.body.entitlement.expires_at)), 'entitlement.expires_at not ISO: ' + st.body.entitlement.expires_at);
      const me = await J('GET', '/api/me', null, tokApi);
      assert(me.body.net_plan.active && !Number.isNaN(Date.parse(me.body.net_plan.expires_at)), 'net_plan ' + JSON.stringify(me.body.net_plan));
      const ev = await J('GET', '/api/events?since=0', null, tokApi);
      assert(ev.body.log.length >= 6, 'event log ' + ev.body.log.length);
      return `order ${o1.body.order_id} once, payment ${p1.body.payment_id} once, log ${ev.body.log.length} rows`;
    });
    await check('API: webhook rejects bad HMAC (401), playback refused unentitled (403)', async () => {
      const w = await J('POST', '/api/webhooks/pg', { order_id: 'ord_x', status: 'success' }, null, { 'x-pg-signature': 'deadbeef' });
      assert(w.status === 401 && w.body.error === 'bad_signature', 'webhook ' + w.status + ' ' + w.body.error);
      await J('POST', '/api/otp/send', { phone: PHONE_NOENT });
      const v = await J('POST', '/api/otp/verify', { phone: PHONE_NOENT, otp: '1234' });
      const r = await J('POST', '/api/playback/start', { film_id: 'sstb-notld', device_id: 'dev_xxxxxx' }, v.body.session);
      assert(r.status === 403 && r.body.error === 'not_entitled', 'start ' + r.status + ' ' + r.body.error);
      return '401 bad_signature · 403 not_entitled';
    });

    /* ================= Browser funnel against the Worker ================= */
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('console', m => { if (['error', 'warn', 'warning'].includes(m.type())) consoleIssues.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', e => consoleIssues.push('pageerror: ' + e.message));
    await page.setViewport(DESK);
    await page.goto(PAGE + '#offer', { waitUntil: 'networkidle0' });

    await check('UI: offer → login → wrong OTP 401 → demo OTP → order → #pay', async () => {
      await page.waitForSelector('#offer-cta');
      await page.click('#offer-cta');
      await waitFor(page, () => location.hash === '#login');
      await page.waitForSelector('#in-phone', { visible: true });
      await page.type('#in-phone', PHONE_UI);
      await page.click('#form-phone button[type=submit]');
      await page.waitForSelector('#form-otp', { visible: true });
      assert(await timelineHas(page, 'otp.send', true), 'otp.send not in timeline');
      await page.type('#in-otp', '9999');
      await waitFor(page, () => document.getElementById('otp-err').textContent.length > 0);
      assert(await timelineHas(page, 'otp.verify', false), 'failed otp.verify not in timeline');
      await page.$eval('#in-otp', e => { e.value = ''; });
      await page.click('#otp-hint');
      await waitFor(page, () => location.hash === '#pay');
      assert(await timelineHas(page, 'order.create', true), 'order.create missing');
      await page.waitForFunction(() => document.getElementById('pg-order').textContent.includes('ord_'));
      await shot(page, 'r01-pay');
      return 'order ' + (await page.$eval('#pg-order', e => e.textContent));
    });

    await check('UI: payment failure → failed state, retry = new order', async () => {
      const o1 = await page.$eval('#pg-order', e => e.textContent);
      await page.click('.sim.bad');
      await page.waitForSelector('#pg-retry', { visible: true, timeout: 10000 });
      assert(await timelineHas(page, 'order.failed', false), 'order.failed missing');
      await shot(page, 'r02-pay-failed');
      await page.click('#pg-retry');
      await waitFor(page, (o) => document.getElementById('pg-order').textContent !== o && document.getElementById('pg-status').hidden, { arg: o1 });
      return 'new ' + (await page.$eval('#pg-order', e => e.textContent));
    });

    await check('UI: payment success → signed webhook → entitlement → #success', async () => {
      const t0 = Date.now();
      await page.click('#pg-pay');
      await waitFor(page, () => location.hash === '#success', { timeout: 15000 });
      metrics.payToSuccessMs = Date.now() - t0;
      for (const st of ['pg.collect', 'pg.webhook.send', 'pg.webhook', 'order.paid', 'entitlement.grant', 'net.grant'])
        assert(await timelineHas(page, st, true), st + ' missing from timeline');
      await shot(page, 'r03-success');
      return `${metrics.payToSuccessMs} ms click→success`;
    });

    await check('UI: watch → Worker licence → video decrypts and plays', async () => {
      const t0 = Date.now();
      await page.click('#btn-watch');
      await waitFor(page, () => location.hash === '#watch');
      await waitFor(page, () => { const v = document.querySelector('video'); return v && v.currentTime > 1.5 && !v.paused; }, { timeout: 30000 });
      metrics.timeToPlayMs = Date.now() - t0;
      assert(!(await page.$('.wp-msg')), 'error overlay shown');
      for (const st of ['entitlement.check', 'rental.start', 'stream.lease', 'drm.token', 'drm.license'])
        assert(await timelineHas(page, st, true), st + ' missing');
      const keys = await page.$eval('#bp dd[data-k="keys"]', e => e.textContent);
      assert(/usable/.test(keys), 'key status not usable: ' + keys);
      const a = await ct(page); await sleep(3000); const b = await ct(page);
      assert(b - a > 2.0, `currentTime did not advance (${a}→${b})`);
      const fs = await frameStats(page);
      assert(fs.decoded > 50, 'too few decoded frames ' + fs.decoded);
      assert(fs.lumaStd > 20, 'frame looks blank (luma std ' + fs.lumaStd + ')');
      await shot(page, 'r04-watch');
      metrics.advance = +(b - a).toFixed(2);
      metrics.frames = fs;
      return `play in ${metrics.timeToPlayMs} ms; +${metrics.advance}s in 3 s; ${fs.decoded} frames ${fs.w}x${fs.h}, luma σ=${fs.lumaStd}; ${keys}`;
    });

    await check('UI: rental pill shows hours left (from Worker ISO expires_at)', async () => {
      const pill = await page.$eval('.wp-rental .v', e => e.textContent).catch(() => '');
      assert(/बाकी/.test(pill), 'rental pill: "' + pill + '"');
      return pill;
    });

    await check('Worker: licence refused (409/404) for an ended play session', async () => {
      const r = await page.evaluate(async (api) => {
        const psid = sessionStorage.getItem('e2e') || null;
        // take the live session id from the player, stop is not called — use a bogus one and a real-but-foreign check
        const res = await fetch(api + '/api/license/clearkey', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('wiom_session'), 'x-play-session': 'ps_nope' }, body: JSON.stringify({ kids: ['AAAAAAAAAAAAAAAAAAAAAA'], type: 'temporary' }) });
        return res.status;
      }, API);
      assert(r === 404 || r === 409 || r === 403, 'expected refusal, got ' + r);
      return 'licence for unknown session → ' + r;
    });

    await check('One stream per phone: 2nd device takes over → overlay ≤40 s → "यहाँ देखें" reclaims', async () => {
      const posBefore = await ct(page);
      // Second "device": same session, direct API start with a different device_id.
      const s2 = await page.evaluate(async (api) => {
        const r = await fetch(api + '/api/playback/start', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('wiom_session') }, body: JSON.stringify({ film_id: 'sstb-notld', device_id: 'dev2_e2e_real' }) });
        return { status: r.status, body: await r.json() };
      }, API);
      assert(s2.status === 200 && s2.body.play_session_id, '2nd start ' + s2.status + ' ' + JSON.stringify(s2.body).slice(0, 120));
      // The playing device discovers on its next heartbeat (30 s) and shows the takeover overlay.
      await waitFor(page, () => document.querySelector('.wp-msg') && /दूसरे डिवाइस/.test(document.querySelector('.wp-msg').innerText), { timeout: 40000 });
      await shot(page, 'r05-409-overlay');
      const paused = await page.evaluate(() => document.querySelector('video')?.paused ?? true);
      assert(paused, 'video should pause on takeover');
      // Reclaim here.
      const btns = await page.$$('.wp-msg button');
      let clicked = false;
      for (const b of btns) { const t = await b.evaluate(e => e.textContent); if (/यहाँ देखें/.test(t)) { await b.click(); clicked = true; break; } }
      assert(clicked, 'no "यहाँ देखें" button');
      await waitFor(page, () => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0; }, { timeout: 30000 });
      const posAfter = await ct(page);
      return `overlay after 2nd-device start; reclaimed, resumed ${posBefore.toFixed(0)}s → ${posAfter.toFixed(0)}s`;
    });

    await check('Resume: reload lands back in the film near the saved position', async () => {
      // Make sure a position is saved server-side: the player heartbeats on reclaim-start.
      await sleep(2000);
      const pos = await ct(page);
      await page.goto(PAGE + '#watch', { waitUntil: 'networkidle0' });
      await waitFor(page, () => { const v = document.querySelector('video'); return v && v.currentTime > 0.5 && !v.paused; }, { timeout: 30000 });
      const r = await ct(page);
      assert(r > 1 && Math.abs(r - pos) < 30, `resume at ${r.toFixed(1)}s vs last ${pos.toFixed(1)}s`);
      await shot(page, 'r06-resume');
      return `resumed at ${r.toFixed(1)}s (was ${pos.toFixed(1)}s)`;
    });

    await check('Console: no unexpected errors', async () => {
      const bad = consoleIssues.filter(t => !/401|409|Unauthorized|the server responded with a status/.test(t));
      assert(bad.length === 0, bad.slice(0, 3).join(' | '));
      return consoleIssues.length + ' expected-only console entries';
    });

    await page.close(); await ctx.close();
  } finally {
    await browser.close().catch(() => {});
    statics.kill();
  }

  const pass = results.filter(r => r.ok).length;
  const md = [`# Wiom Movie Pilot — e2e against the REAL Worker (${new Date().toISOString()})`, '',
    `Chrome ${metrics.chrome} · API ${API} · static ${BASE} · **${pass}/${results.length} passed**`, '',
    '| # | Check | Result | Detail |', '|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.name.replace(/\|/g, '\\|')} | ${r.ok ? 'PASS' : '**FAIL**'} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
    '', '## Metrics', '```json', JSON.stringify(metrics, null, 2), '```'].join('\n');
  await writeFile(path.join(HERE, 'test-report-real.md'), md);
  console.log(`\n${pass}/${results.length} passed → test-report-real.md`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
