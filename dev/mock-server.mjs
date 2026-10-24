#!/usr/bin/env node
// Wiom Movie Pilot — in-memory MOCK backend (no dependencies).
// Implements the API in ../../SPEC.md exactly, and serves the static site (../) and the
// encrypted test asset (../../testassets/out) at /media/.
//
//   node web/dev/mock-server.mjs            → http://localhost:8790
//
// Env:
//   PORT=8790
//   MOCK_DRM=clearkey|widevine   (widevine returns a fake Axinom-shaped licence + token; it will not decrypt locally)
//   MOCK_LATENCY_MS=120          (adds realistic latency to API calls)
//   MOCK_PENDING_MS=8000         (how long an outcome:"pending" payment waits before the late webhook lands)
//   MOCK_HEARTBEAT_S=30          (heartbeat interval the player is told to use; e2e uses 5)
//   ALLOW_ORIGINS=https://x.github.io,https://y   (CORS allow-list in addition to localhost)
//   KEYS_FILE=../../testassets/keys.json
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const MEDIA_ROOT = path.resolve(HERE, process.env.MEDIA_ROOT || '../../testassets/out');
const KEYS_FILE = path.resolve(HERE, process.env.KEYS_FILE || '../../testassets/keys.json');
const PORT = Number(process.env.PORT || 8790);
const DRM = process.env.MOCK_DRM || 'clearkey';
const LATENCY = Number(process.env.MOCK_LATENCY_MS ?? 120);
const PENDING_MS = Number(process.env.MOCK_PENDING_MS ?? 8000);
const HEARTBEAT_S = Number(process.env.MOCK_HEARTBEAT_S ?? 30);
const VERSION = 'mock-1.0.0';
const PG_SECRET = randomBytes(32).toString('hex'); // per-process; never leaves the server
const ALLOW = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const LEASE_MS = 90_000;
const RENTAL_MS = 48 * 3600_000;
const START_BY_MS = 7 * 24 * 3600_000;
const NET_PACK_MS = 24 * 3600_000; // assumption for the pilot mock; the real value comes from billing
const OTP = '1234';
const OFFERS = {
  net14_movie: {
    amount_paise: 1400,
    items: [
      { sku: 'net_sachet_14', title: '₹14 Net पैक', amount_paise: 1400 },
      { sku: 'film_rental_48h', title: 'फ़िल्म · 48 घंटे', amount_paise: 0 },
    ],
  },
};
const FILM_IDS = new Set(['sstb-notld', 'test-pattern']);

// ---- key material -----------------------------------------------------------------------------
let KEY = null;
if (existsSync(KEYS_FILE)) {
  const k = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
  KEY = { kid: hexToB64u(k.kid_hex || k.key_id), k: hexToB64u(k.key_hex || k.key) }; // testassets/keys.json or secrets/clearkey.json shape
}
function hexToB64u(h) { return Buffer.from(h, 'hex').toString('base64url'); }

// ---- in-memory state --------------------------------------------------------------------------
const users = new Map();      // phone -> {phone, created_at, entitlements: Map(film_id->ent), net_plan, events:[], outbox:[]}
const sessions = new Map();   // token -> phone
const orders = new Map();     // order_id -> {...}
const payments = new Map();   // payment_id -> {...}
const webhooksSeen = new Set();
const leases = new Map();     // phone -> {play_session_id, device_id, film_id, expires}
const playSessions = new Map(); // play_session_id -> {phone, film_id, device_id, position, created}
const idem = new Map();       // `${phone}:${key}` -> {status, body}
const rl = new Map();         // bucket -> [timestamps]

const mask = p => `${p.slice(0, 2)}xxxx${p.slice(-4)}`;
const now = () => Date.now();
const iso = t => (t == null ? null : new Date(t).toISOString());
const id = (p) => `${p}_${randomBytes(6).toString('hex')}`;

function limited(bucket, max, windowMs) {
  const t = now();
  const arr = (rl.get(bucket) || []).filter(x => t - x < windowMs);
  if (arr.length >= max) { rl.set(bucket, arr); return true; }
  arr.push(t); rl.set(bucket, arr); return false;
}

// ---- request context: collects events for this call -----------------------------------------
class Ctx {
  constructor(req, res) { this.req = req; this.res = res; this.events = []; this.user = null; }
  ev(step, detail, ok = true) {
    const e = { ts: new Date().toISOString(), step, detail, ok };
    this.events.push(e);
    if (this.user) pushLog(this.user, e);
    return e;
  }
}
function pushLog(user, e) { user.events.push(e); if (user.events.length > 200) user.events.splice(0, user.events.length - 200); }
function asyncEvent(user, step, detail, ok = true) {
  const e = { ts: new Date().toISOString(), step, detail, ok };
  pushLog(user, e); user.outbox.push(e);
}

function corsHeaders(origin) {
  if (!origin) return {};
  let ok = false;
  try { const u = new URL(origin); ok = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || ALLOW.includes(origin); } catch {}
  if (!ok) return {};
  return {
    'access-control-allow-origin': origin,
    'vary': 'Origin',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-play-session,x-pg-signature',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': '600',
  };
}

function send(ctx, status, body) {
  const u = ctx.user;
  // deliver async events (e.g. a late PG webhook) on the user's next response
  const outbox = u ? u.outbox.splice(0) : [];
  const payload = JSON.stringify({ ...body, events: [...outbox, ...ctx.events] });
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(ctx.req.headers.origin),
  });
  ctx.res.end(payload);
}
const err = (ctx, status, code, message) => send(ctx, status, { error: code, message });

async function readBody(req, limit = 64 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
async function json(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function auth(ctx) {
  const h = ctx.req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const phone = sessions.get(tok);
  if (!phone) return null;
  ctx.user = users.get(phone);
  return ctx.user;
}

function idemKey(ctx) { const k = ctx.req.headers['idempotency-key']; return k && ctx.user ? `${ctx.user.phone}:${ctx.req.url}:${k}` : null; }

function entView(e) {
  if (!e) return null;
  const t = now();
  let status = e.first_play_at ? 'active' : 'not_started';
  let expires = e.first_play_at ? e.first_play_at + RENTAL_MS : e.granted_at + START_BY_MS;
  if (t >= expires) status = 'expired';
  return { film_id: e.film_id, status, expires_at: iso(expires), granted_at: iso(e.granted_at), first_play_at: iso(e.first_play_at) };
}
function netView(u) { return u.net_plan ? { active: now() < u.net_plan.expires_at, expires_at: iso(u.net_plan.expires_at) } : { active: false, expires_at: null }; }

// ---- PG webhook: the single code path that grants entitlement --------------------------------
function sign(raw) { return createHmac('sha256', PG_SECRET).update(raw).digest('hex'); }
function processWebhook(raw, signature, log) {
  const expected = Buffer.from(sign(raw), 'hex');
  const got = Buffer.from(String(signature || ''), 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    log('pg.webhook.verify', 'HMAC-SHA256 signature mismatch — rejected', false);
    return { status: 401, body: { error: 'bad_signature' } };
  }
  const evt = JSON.parse(raw);
  log('pg.webhook.verify', `x-pg-signature valid (HMAC-SHA256) for ${evt.payment_id}`);
  const dedupe = `${evt.payment_id}:${evt.status}`;
  if (webhooksSeen.has(dedupe)) {
    log('pg.webhook.idempotent', `duplicate ${evt.status} for ${evt.payment_id} ignored`);
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  webhooksSeen.add(dedupe);
  const order = orders.get(evt.order_id);
  const pay = payments.get(evt.payment_id);
  if (!order || !pay) { log('pg.webhook.lookup', 'unknown order/payment', false); return { status: 404, body: { error: 'unknown_order' } }; }
  pay.status = evt.status;
  const u = users.get(order.phone);
  if (evt.status === 'success') {
    if (order.status === 'paid') { log('order.update', `${order.order_id} already paid`); return { status: 200, body: { ok: true } }; }
    order.status = 'paid'; order.paid_at = now();
    log('order.update', `${order.order_id} → paid (₹${order.amount_paise / 100})`);
    const film = 'sstb-notld';
    if (!u.entitlements.has(film)) {
      u.entitlements.set(film, { film_id: film, granted_at: now(), first_play_at: null, order_id: order.order_id });
      log('entitlement.grant', `film ${film}: 48 h rental, clock starts on first play (start within 7 days)`);
    } else log('entitlement.grant', `film ${film} already entitled — no change`);
    const base = Math.max(now(), u.net_plan?.expires_at || 0);
    u.net_plan = { expires_at: base + NET_PACK_MS, order_id: order.order_id };
    log('net_sachet.record', `₹14 Net पैक recorded for ${mask(u.phone)} (sachet_id ${id('sch')})`);
  } else if (evt.status === 'failure') {
    order.status = 'failed';
    log('order.update', `${order.order_id} → failed (${evt.reason || 'declined'})`, false);
  }
  return { status: 200, body: { ok: true } };
}

// ---- routes -----------------------------------------------------------------------------------
const routes = [];
const route = (m, p, fn) => routes.push({ m, re: new RegExp(`^${p.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

route('GET', '/api/health', async (ctx) => { ctx.ev('health', `ok · ${VERSION} · drm=${DRM}`); send(ctx, 200, { ok: true, version: VERSION }); });

route('POST', '/api/otp/send', async (ctx) => {
  const { phone } = await json(ctx.req);
  if (!/^[6-9]\d{9}$/.test(String(phone || ''))) { ctx.ev('otp.validate', 'phone must be 10 digits starting 6–9', false); return err(ctx, 400, 'bad_phone', 'मोबाइल नंबर सही नहीं है'); }
  const ip = ctx.req.socket.remoteAddress || 'ip';
  if (limited(`ip:${ip}`, 30, 60_000)) { ctx.ev('ratelimit', '30/min per IP exceeded', false); return err(ctx, 429, 'rate_limited', 'बहुत ज़्यादा कोशिशें, थोड़ी देर बाद'); }
  if (limited(`otp:${phone}`, 5, 600_000)) { ctx.ev('ratelimit', `5 OTP / 10 min exceeded for ${mask(phone)}`, false); return err(ctx, 429, 'rate_limited', '10 मिनट में 5 OTP हो गए, थोड़ी देर बाद'); }
  ctx.ev('otp.validate', `phone ${mask(phone)} valid`);
  ctx.ev('otp.ratelimit', 'within 5/10 min per phone, 30/min per IP');
  ctx.ev('otp.issue', `demo OTP issued for ${mask(phone)} (no SMS in pilot)`);
  send(ctx, 200, { sent: true, demo_otp: OTP });
});

// PPV flow: no OTP — identity is the device.
route('POST', '/api/session/guest', async (ctx) => {
  const { device_id } = await json(ctx.req);
  if (!/^[\w-]{6,64}$/.test(String(device_id || ''))) return err(ctx, 400, 'bad_device', 'device_id सही नहीं है');
  const phone = 'g' + createHmac('sha256', 'guest').update(device_id).digest('hex').slice(0, 15);
  let u = users.get(phone);
  const isNew = !u;
  if (!u) { u = { phone, created_at: now(), entitlements: new Map(), net_plan: null, events: [], outbox: [] }; users.set(phone, u); }
  ctx.user = u;
  ctx.ev('session.guest', `guest session for device …${String(device_id).slice(-4)} (no OTP in PPV flow)`);
  ctx.ev(isNew ? 'user.create' : 'user.lookup', `${isNew ? 'new' : 'returning'} device identity`);
  const token = randomBytes(24).toString('base64url');
  sessions.set(token, phone);
  ctx.ev('session.issue', 'bearer session issued (30 d)');
  send(ctx, 200, { session: token, user: { phone_masked: 'इसी डिवाइस पर' } });
});

route('POST', '/api/otp/verify', async (ctx) => {
  const { phone, otp } = await json(ctx.req);
  if (!/^[6-9]\d{9}$/.test(String(phone || ''))) return err(ctx, 400, 'bad_phone', 'मोबाइल नंबर सही नहीं है');
  if (limited(`verify:${phone}`, 10, 600_000)) { ctx.ev('ratelimit', 'too many OTP attempts', false); return err(ctx, 429, 'rate_limited', 'बहुत ज़्यादा कोशिशें'); }
  if (String(otp) !== OTP) { ctx.ev('otp.verify', `OTP mismatch for ${mask(phone)}`, false); return err(ctx, 401, 'bad_otp', 'OTP गलत है'); }
  let u = users.get(phone);
  const isNew = !u;
  if (!u) { u = { phone, created_at: now(), entitlements: new Map(), net_plan: null, events: [], outbox: [] }; users.set(phone, u); }
  ctx.user = u;
  ctx.ev('otp.verify', `OTP matched for ${mask(phone)}`);
  ctx.ev(isNew ? 'user.create' : 'user.lookup', `${isNew ? 'new' : 'existing'} user ${mask(phone)}`);
  const token = randomBytes(24).toString('base64url');
  sessions.set(token, phone);
  ctx.ev('session.issue', 'bearer session issued (30 d)');
  send(ctx, 200, { session: token, user: { phone_masked: mask(phone) } });
});

route('GET', '/api/me', async (ctx) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  ctx.ev('session.check', `session valid for ${mask(u.phone)}`);
  const ents = [...u.entitlements.values()].map(entView);
  ctx.ev('entitlement.list', ents.length ? ents.map(e => `${e.film_id}:${e.status}`).join(', ') : 'no entitlements');
  send(ctx, 200, { user: { phone_masked: mask(u.phone) }, entitlements: ents, net_plan: netView(u) });
});

route('POST', '/api/orders', async (ctx) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  const k = idemKey(ctx);
  if (k && idem.has(k)) { const r = idem.get(k); ctx.ev('idempotency.hit', `replayed order ${r.body.order_id}`); return send(ctx, r.status, r.body); }
  const { offer_id } = await json(ctx.req);
  const offer = OFFERS[offer_id];
  if (!offer) { ctx.ev('order.validate', `unknown offer ${offer_id}`, false); return err(ctx, 400, 'bad_offer', 'यह ऑफ़र उपलब्ध नहीं है'); }
  const order = { order_id: id('ord'), phone: u.phone, offer_id, amount_paise: offer.amount_paise, currency: 'INR', items: offer.items, status: 'created', created_at: now() };
  orders.set(order.order_id, order);
  ctx.ev('order.create', `${order.order_id} · ${offer_id} · ₹${offer.amount_paise / 100}`);
  const body = { order_id: order.order_id, amount_paise: order.amount_paise, currency: 'INR', items: order.items, gateway_url: `/pay/dummy?order_id=${order.order_id}` };
  if (k) idem.set(k, { status: 200, body });
  send(ctx, 200, body);
});

route('GET', '/api/orders/:id', async (ctx, p) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  const o = orders.get(p.id);
  if (!o || o.phone !== u.phone) return err(ctx, 404, 'not_found', 'ऑर्डर नहीं मिला');
  ctx.ev('order.status', `${o.order_id}: ${o.status}`);
  send(ctx, 200, { order_id: o.order_id, status: o.status, entitlement: o.status === 'paid' ? entView(u.entitlements.get('sstb-notld')) : null });
});

route('POST', '/api/pay/dummy', async (ctx) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  const k = idemKey(ctx);
  if (k && idem.has(k)) { const r = idem.get(k); ctx.ev('idempotency.hit', `replayed payment ${r.body.payment_id}`); return send(ctx, r.status, r.body); }
  const { order_id, method, outcome } = await json(ctx.req);
  const o = orders.get(order_id);
  if (!o || o.phone !== u.phone) return err(ctx, 404, 'not_found', 'ऑर्डर नहीं मिला');
  if (!['upi_phonepe', 'upi_gpay', 'upi_paytm', 'qr', 'card'].includes(method)) return err(ctx, 400, 'bad_method', 'पेमेंट तरीका सही नहीं');
  if (!['success', 'failure', 'pending'].includes(outcome)) return err(ctx, 400, 'bad_outcome', 'outcome सही नहीं');
  if (o.status === 'paid') { ctx.ev('pg.charge', `${order_id} already paid — no double charge`); return send(ctx, 200, { payment_id: o.payment_id, status: 'success' }); }
  const pay = { payment_id: id('pay'), order_id, method, status: 'pending', created_at: now() };
  payments.set(pay.payment_id, pay); o.payment_id = pay.payment_id;
  ctx.ev('pg.charge', `dummy PG: ${method} ₹${o.amount_paise / 100} → ${outcome} (${pay.payment_id})`);
  const fire = (status, log) => {
    const raw = JSON.stringify({ payment_id: pay.payment_id, order_id, status, amount_paise: o.amount_paise, method, reason: status === 'failure' ? 'test_decline' : undefined, ts: now() });
    log('pg.webhook.send', `PG → POST /api/webhooks/pg (${status}) signed x-pg-signature`);
    return processWebhook(raw, sign(raw), log);
  };
  if (outcome === 'pending') {
    o.status = 'pending';
    ctx.ev('order.update', `${order_id} → pending (bank confirmation awaited)`);
    setTimeout(() => fire('success', (s, d, ok) => asyncEvent(u, s, d, ok)), PENDING_MS).unref();
  } else {
    fire(outcome, (s, d, ok) => ctx.ev(s, d, ok));
  }
  const body = { payment_id: pay.payment_id, status: outcome };
  if (k) idem.set(k, { status: 200, body });
  send(ctx, 200, body);
});

route('POST', '/api/webhooks/pg', async (ctx) => {
  const raw = await readBody(ctx.req);
  let phone = null; try { phone = orders.get(JSON.parse(raw).order_id)?.phone; } catch {}
  if (phone) ctx.user = users.get(phone);
  const r = processWebhook(raw, ctx.req.headers['x-pg-signature'], (s, d, ok) => ctx.ev(s, d, ok));
  ctx.user = null; // do not drain someone's outbox into the PG's response
  send(ctx, r.status, r.body);
});

route('POST', '/api/playback/start', async (ctx) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  const { film_id, device_id } = await json(ctx.req);
  if (!FILM_IDS.has(film_id) || !device_id) return err(ctx, 400, 'bad_request', 'film_id / device_id चाहिए');
  const fid = 'sstb-notld';
  const e = u.entitlements.get(fid);
  const v = entView(e);
  if (!v) { ctx.ev('entitlement.check', `${mask(u.phone)} has no entitlement for ${fid}`, false); return err(ctx, 403, 'not_entitled', 'पहले पैक लें'); }
  if (v.status === 'expired') { ctx.ev('entitlement.check', `rental expired at ${v.expires_at}`, false); return err(ctx, 403, 'expired', 'किराया खत्म हो गया'); }
  ctx.ev('entitlement.check', `${fid}: ${v.status}`);
  if (!e.first_play_at) { e.first_play_at = now(); ctx.ev('rental.clock.start', `first play — 48 h rental runs until ${iso(e.first_play_at + RENTAL_MS)}`); }
  const prev = leases.get(u.phone);
  if (prev && prev.expires > now() && prev.device_id !== device_id) ctx.ev('lease.takeover', `stream moved from device …${prev.device_id.slice(-4)} to …${device_id.slice(-4)} (one stream per phone)`);
  else if (prev && prev.expires > now()) ctx.ev('lease.replace', 'same device restarted — old session closed');
  const psid = id('ps');
  const resume = Math.max(0, ...[...playSessions.values()].filter(s => s.phone === u.phone && s.film_id === fid).map(s => s.position || 0), u.resume?.[fid] || 0);
  playSessions.set(psid, { phone: u.phone, film_id: fid, device_id, position: resume, created: now() });
  leases.set(u.phone, { play_session_id: psid, device_id, film_id: fid, expires: now() + LEASE_MS });
  ctx.ev('lease.acquire', `${psid} lease 90 s (1 active stream per phone)`);
  const origin = `http://${ctx.req.headers.host}`;
  const drm = DRM === 'widevine'
    ? { mode: 'widevine', license_url: 'https://drm-widevine-licensing.axtest.net/AcquireLicense', token: `mock.${randomBytes(12).toString('base64url')}`,
        fairplay: { license_url: 'https://drm-fairplay-licensing.axtest.net/AcquireLicense', certificate_url: 'https://vtb.axinom.com/FPScert/fairplay.cer' } }
    : { mode: 'clearkey', license_url: `${origin}/api/license/clearkey` };
  ctx.ev('drm.config', drm.mode === 'clearkey' ? 'ClearKey licence URL issued (key released only to this live session)' : 'Widevine/FairPlay licence token signed (mock)');
  if (resume) ctx.ev('resume.lookup', `resume at ${Math.round(resume)} s`);
  send(ctx, 200, {
    play_session_id: psid, drm, resume_at: resume, expires_at: iso(e.first_play_at + RENTAL_MS),
    manifest: { dash: `${origin}/media/manifest.mpd`, hls: `${origin}/media/master.m3u8` },
    heartbeat_s: HEARTBEAT_S,
  });
});

function liveSession(ctx, psid) {
  const s = playSessions.get(psid);
  if (!s || s.phone !== ctx.user.phone) return { code: 404 };
  const l = leases.get(s.phone);
  if (!l || l.play_session_id !== psid) return { code: 409, s };
  if (l.expires < now()) return { code: 410, s };
  return { code: 200, s, l };
}

route('POST', '/api/playback/heartbeat', async (ctx) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  const { play_session_id, position } = await json(ctx.req);
  const r = liveSession(ctx, play_session_id);
  if (r.code === 404) return err(ctx, 404, 'no_session', 'सेशन नहीं मिला');
  if (Number.isFinite(position) && r.s) { r.s.position = position; u.resume = { ...(u.resume || {}), [r.s.film_id]: position }; }
  if (r.code === 409) { ctx.ev('lease.check', 'another device has taken this stream', false); return err(ctx, 409, 'stream_taken', 'यह फ़िल्म किसी दूसरे डिवाइस पर चल रही है'); }
  if (r.code === 410) { ctx.ev('lease.check', 'lease expired (no heartbeat for 90 s)', false); return err(ctx, 409, 'lease_expired', 'सेशन खत्म हो गया, फिर से चलाएँ'); }
  r.l.expires = now() + LEASE_MS;
  const v = entView(u.entitlements.get(r.s.film_id));
  if (v.status === 'expired') { leases.delete(u.phone); ctx.ev('entitlement.check', 'rental expired during playback', false); return err(ctx, 403, 'expired', 'किराया खत्म हो गया'); }
  ctx.ev('heartbeat', `lease renewed 90 s · position ${Math.round(position || 0)} s saved`);
  send(ctx, 200, { ok: true, lease_expires_at: iso(r.l.expires), expires_at: v.expires_at });
});

route('POST', '/api/playback/stop', async (ctx) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  const { play_session_id, position } = await json(ctx.req);
  const r = liveSession(ctx, play_session_id);
  if (r.s && Number.isFinite(position)) { r.s.position = position; u.resume = { ...(u.resume || {}), [r.s.film_id]: position }; }
  if (r.code === 200) { leases.delete(u.phone); ctx.ev('lease.release', `${play_session_id} released at ${Math.round(position || 0)} s`); }
  else ctx.ev('lease.release', 'session was not holding the lease — nothing to release');
  send(ctx, 200, { ok: true });
});

route('POST', '/api/license/clearkey', async (ctx) => {
  const psid = ctx.req.headers['x-play-session'];
  const s = playSessions.get(psid);
  if (s) ctx.user = users.get(s.phone);
  const body = await json(ctx.req);
  if (!s) { ctx.ev('licence.check', 'no/unknown x-play-session — key withheld', false); return err(ctx, 403, 'no_session', 'licence denied'); }
  const l = leases.get(s.phone);
  if (!l || l.play_session_id !== psid || l.expires < now()) { ctx.ev('licence.check', 'play session not live (lease lost) — key withheld', false); return err(ctx, 409, 'stream_taken', 'licence denied'); }
  const v = entView(ctx.user.entitlements.get(s.film_id));
  if (!v || v.status === 'expired') { ctx.ev('licence.check', 'not entitled — key withheld', false); return err(ctx, 403, 'not_entitled', 'licence denied'); }
  if (!KEY) { ctx.ev('licence.keys', 'server has no key material', false); return err(ctx, 500, 'no_keys', 'licence error'); }
  const kids = Array.isArray(body.kids) ? body.kids : [];
  const keys = kids.filter(k => k === KEY.kid).map(kid => ({ kty: 'oct', kid, k: KEY.k }));
  ctx.ev('licence.check', `session ${psid} live + entitled`);
  ctx.ev('licence.keys', keys.length ? `released ${keys.length} ClearKey key (kid ${KEY.kid.slice(0, 6)}…)` : `requested kid not known`, keys.length > 0);
  send(ctx, keys.length ? 200 : 404, { keys, type: body.type || 'temporary' });
});

route('GET', '/api/events', async (ctx) => {
  const u = auth(ctx); if (!u) return err(ctx, 401, 'unauthorized', 'फिर से लॉगिन करें');
  const since = new URL(ctx.req.url, 'http://x').searchParams.get('since');
  const t = since ? Date.parse(since) || Number(since) : 0;
  const log = u.events.filter(e => Date.parse(e.ts) > t).slice(-200);
  u.outbox.length = 0; // already part of the log
  ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(ctx.req.headers.origin) });
  ctx.res.end(JSON.stringify({ log, events: [] }));
});

// ---- static ------------------------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.mpd': 'application/dash+xml', '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8' };
async function serveStatic(req, res, root, rel) {
  const file = path.resolve(root, '.' + decodeURIComponent(rel));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  let st; try { st = await stat(file); } catch { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  if (st.isDirectory()) return serveStatic(req, res, root, path.posix.join(rel, 'index.html'));
  if (file.includes(`${path.sep}dev${path.sep}node_modules`)) { res.writeHead(404); return res.end(); }
  const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size,
    'cache-control': root === MEDIA_ROOT ? 'public, max-age=3600' : 'no-cache', 'access-control-allow-origin': '*' };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req.headers.origin)); return res.end(); }
  if (url.pathname.startsWith('/media/')) return serveStatic(req, res, MEDIA_ROOT, url.pathname.slice(6));
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, WEB_ROOT, url.pathname);
  const ctx = new Ctx(req, res);
  for (const r of routes) {
    if (r.m !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      if (LATENCY) await new Promise(ok => setTimeout(ok, LATENCY * (0.6 + Math.random() * 0.8)));
      await r.fn(ctx, m.groups || {});
    } catch (e) {
      if (!res.headersSent) err(ctx, e.status || 500, e.status ? 'bad_request' : 'server_error', e.status ? 'अनुरोध सही नहीं' : 'सर्वर में दिक्कत');
      if (!e.status) console.error(e);
    }
    return;
  }
  err(ctx, 404, 'not_found', 'not found');
});

server.listen(PORT, () => {
  console.log(`Wiom Movie Pilot mock → http://localhost:${PORT}  (drm=${DRM}, keys=${KEY ? 'loaded' : 'MISSING — run testassets/build.sh'})`);
});
