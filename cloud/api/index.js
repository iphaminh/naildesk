// Dream Nails POS — single serverless function (Express) for Vercel.
// All /api/* routes land here via vercel.json rewrite.
const express = require('express');
const path = require('path');
const XLSX = require('xlsx');
const { q, ins, upd, del, rpc, uploadBinary } = require('../lib/supa');

const app = express();

// ---------- product domain: nailmind.app ----------
// The global NailMind product lives on nailmind.app — landing at /, studio at
// /app, shared gallery images, and ONLY the nailmind APIs. The salon's POS,
// booking and kiosk never answer on this host; they stay on dreamnails.phaminh.com.
const NM_HOSTS = new Set(['nailmind.app', 'www.nailmind.app']);
const nmLanding = express.static(path.join(__dirname, '..', 'public', 'landing'));
app.use((req, res, next) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!NM_HOSTS.has(host)) return next();
  if (req.path === '/app' || req.path === '/app/') {
    return res.sendFile(path.join(__dirname, '..', 'public', 'nailmind.html'));
  }
  // NailMind's own back office lives here too — selling credits and issuing
  // refunds belong with the product, not with the salon's POS.
  if (req.path === '/admin' || req.path === '/admin/') {
    return res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
  }
  if (req.path.startsWith('/admin/')) return next();
  // /terms and /privacy without the extension — these get printed on receipts
  // and pasted into App Store Connect, so they should be typeable.
  if (req.path === '/terms' || req.path === '/privacy') {
    return res.sendFile(path.join(__dirname, '..', 'public', 'landing', req.path.slice(1) + '.html'));
  }
  if (req.path.startsWith('/api/')) {
    if (req.path.startsWith('/api/public/nailmind')) return next();
    if (req.path.startsWith('/api/nailmind/')) return next();
    if (req.path === '/api/auth/check' || req.path === '/api/settings') return next();
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.path.startsWith('/gallery/')) return next();
  return nmLanding(req, res, () => res.status(404).send('Not found'));
});

// The other direction. NailMind's members, their balances and their refunds are
// reachable behind one shared PIN — the same PIN the whole front desk types to
// open the register. Salon staff are not NailMind staff, so the salon's domain
// does not get these routes at all.
app.use('/api/nailmind', (req, res, next) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (NM_HOSTS.has(host) || host === 'localhost' || host === '127.0.0.1') return next();
  return res.status(404).json({ error: 'Not found' });
});

// Body parsing that works both locally and on Vercel (which may pre-parse req.body)
app.use((req, res, next) => {
  if (req.body !== undefined) return next();
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    next();
  });
});
app.use(express.json ? (req, res, next) => next() : (req, res, next) => next());

// ---------- helpers ----------
const LA = 'America/Los_Angeles';
const todayISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: LA });
const thisMonthMM = () => todayISO().slice(5, 7);

function normalizeMobile(m) {
  const digits = String(m || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits || null;
}

let settingsCache = { at: 0, val: null };
async function getSettings(fresh = false) {
  if (!fresh && settingsCache.val && Date.now() - settingsCache.at < 30000) return settingsCache.val;
  const rows = await q('settings', 'select=key,value');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  settingsCache = { at: Date.now(), val: out };
  return out;
}

function classify(c, s) {
  if (c.visits >= Number(s.vip_min_visits) || Number(c.lifetime_spend) >= Number(s.vip_min_spend)) return 'VIP';
  if (c.visits >= Number(s.loyal_min_visits)) return 'LOYAL';
  return 'NEW';
}

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e);
  res.status(e.status === 404 ? 404 : 500).json({ error: e.message || 'Server error' });
});

// Text the owner via their existing Twilio account (configured in admin Settings).
// Best-effort: a failed text must never break the flow that triggered it.
async function textOwner(s, body) {
  try {
    if (!s.twilio_sid || !s.twilio_token || !s.twilio_from || !s.owner_cell) return false;
    if (String(s.notify_on_booking || '1') === '0') return false;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.twilio_sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${s.twilio_sid}:${s.twilio_token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ From: s.twilio_from, To: s.owner_cell, Body: body })
    });
    if (!r.ok) console.error('Twilio send failed:', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('Twilio error:', e.message); return false; }
}

// Secrets must never travel to a browser, even an authenticated one: the admin
// UI shows a masked placeholder and writes a new value, it never reads the old.
const SECRET_SETTINGS = ['stripe_secret_key', 'gemini_api_key', 'twilio_token', 'twilio_sid', 'admin_pin'];
function redactSettings(s) {
  const out = { ...s };
  for (const k of SECRET_SETTINGS) if (out[k]) out[k] = '__SET__';
  return out;
}

// ---------- admin auth ----------
// Failed PIN attempts are counted per IP: a 4-digit PIN is only 10,000 guesses,
// so without a lockout the admin API is a few minutes of scripting away.
const pinFails = new Map();
function pinLocked(ip) {
  const rec = pinFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.at > 15 * 60000) { pinFails.delete(ip); return false; }
  return rec.n >= 5;
}
function notePinFail(ip) {
  const rec = pinFails.get(ip) || { n: 0, at: Date.now() };
  rec.n += 1; rec.at = Date.now();
  pinFails.set(ip, rec);
}

async function requirePin(req, res, next) {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (pinLocked(ip)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes.' });
    const s = await getSettings();
    // Header only: a PIN in the query string leaks into browser history,
    // referrer headers and every proxy log along the way.
    const pin = req.headers['x-admin-pin'];
    if (!pin || String(pin) !== String(s.admin_pin)) {
      notePinFail(ip);
      return res.status(401).json({ error: 'PIN required' });
    }
    pinFails.delete(ip);
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

app.post('/api/auth/check', wrap(async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (pinLocked(ip)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes.' });
  const s = await getSettings();
  const pin = req.headers['x-admin-pin'] || (req.body && req.body.pin);
  if (String(pin) === String(s.admin_pin)) { pinFails.delete(ip); return res.json({ ok: true }); }
  notePinFail(ip);
  res.status(401).json({ error: 'Wrong PIN' });
}));

// ---------- public: info + services ----------
app.get('/api/public/info', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ salon_name: s.salon_name, open_time: s.open_time, close_time: s.close_time });
}));

app.get('/api/public/services', wrap(async (req, res) => {
  const rows = await q('services', 'active=eq.true&order=category.asc,name.asc&select=id,name,category,price,duration_min,description');
  res.json(rows);
}));

// Active techs qualified for a service — NailBook only offers artists who can do the job
app.get('/api/public/techs', wrap(async (req, res) => {
  const serviceId = Number(req.query.service_id) || 0;
  const techs = await q('techs', 'active=eq.true&order=name.asc&select=id,name,all_services');
  if (!serviceId) return res.json(techs.map(t => ({ id: t.id, name: t.name })));
  const links = await q('tech_services', `service_id=eq.${serviceId}&select=tech_id`);
  const ok = new Set(links.map(l => l.tech_id));
  res.json(techs.filter(t => t.all_services || ok.has(t.id)).map(t => ({ id: t.id, name: t.name })));
}));

// ---------- public: slots ----------
function genSlots(s) {
  const [oh, om] = String(s.open_time || '09:00').split(':').map(Number);
  const [ch, cm] = String(s.close_time || '19:00').split(':').map(Number);
  const step = Number(s.slot_minutes || 30);
  const out = [];
  for (let mins = oh * 60 + om; mins <= ch * 60 + cm - step; mins += step) {
    const h = Math.floor(mins / 60), m = mins % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hh = ((h + 11) % 12) + 1;
    out.push(`${hh}:${String(m).padStart(2, '0')} ${ampm}`);
  }
  return out;
}
function slotToMinutes(t) {
  const m = String(t).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

app.get('/api/public/slots', wrap(async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date required' });
  const s = await getSettings();
  const closedDays = String(s.closed_days || '').split(',').filter(x => x !== '').map(Number);
  const weekday = new Date(date + 'T12:00:00').getDay();
  if (closedDays.includes(weekday)) return res.json({ closed: true, slots: [] });

  const capacity = Number(s.slot_capacity || 3);
  const techId = Number(req.query.tech_id) || 0;
  const [appts, blocked] = await Promise.all([
    q('appointments', `booking_date=eq.${date}&status=neq.cancelled&select=booking_time,tech_id`),
    q('blocked_slots', `booking_date=eq.${date}&select=booking_time`)
  ]);
  const counts = {};
  const techBusy = new Set();
  for (const a of appts) {
    counts[a.booking_time] = (counts[a.booking_time] || 0) + 1;
    if (techId && Number(a.tech_id) === techId) techBusy.add(a.booking_time);
  }
  const manuallyBlocked = new Set(blocked.map(b => b.booking_time));

  const isToday = date === todayISO();
  const nowMins = (() => {
    const t = new Date().toLocaleTimeString('en-US', { timeZone: LA, hour12: false, hour: '2-digit', minute: '2-digit' });
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  })();

  const slots = genSlots(s).map(time => {
    const past = isToday && slotToMinutes(time) <= nowMins;
    const full = (counts[time] || 0) >= capacity || manuallyBlocked.has(time) || techBusy.has(time);
    return { time, available: !past && !full };
  });
  res.json({ closed: false, slots });
}));

// ---------- public: book ----------
app.post('/api/public/book', wrap(async (req, res) => {
  const { clientName, clientPhone, clientEmail, service, addons, notes, bookingDate, bookingTime,
    smsConsent, inspoStyle, photoData, serviceId, techId } = req.body || {};
  if (!clientName || !clientPhone || !service || !bookingDate || !bookingTime) {
    return res.status(400).json({ error: 'Please fill in your name, phone, service, date and time.' });
  }
  const s = await getSettings();
  const capacity = Number(s.slot_capacity || 3);
  const existing = await q('appointments', `booking_date=eq.${bookingDate}&booking_time=eq.${encodeURIComponent(bookingTime)}&status=neq.cancelled&select=id,tech_id`);
  if (existing.length >= capacity) {
    return res.status(409).json({ error: 'SLOT_TAKEN', message: 'Sorry, that time just filled up. Please pick another.' });
  }

  // Requested tech: must exist, be active, be qualified for the service, and be free at that slot
  const svcId = Number(serviceId) || null;
  const reqTechId = Number(techId) || null;
  let techName = null;
  if (reqTechId) {
    const [tech] = await q('techs', `id=eq.${reqTechId}&active=eq.true&select=id,name,all_services&limit=1`);
    if (!tech) return res.status(400).json({ error: 'That nail artist is not available. Please pick another.' });
    if (!tech.all_services) {
      if (!svcId) return res.status(400).json({ error: 'Please re-pick your service and artist.' });
      const link = await q('tech_services', `tech_id=eq.${reqTechId}&service_id=eq.${svcId}&select=service_id&limit=1`);
      if (!link.length) {
        return res.status(400).json({ error: `${tech.name} does not offer that service. Please pick another artist.` });
      }
    }
    if (existing.some(a => Number(a.tech_id) === reqTechId)) {
      return res.status(409).json({ error: 'TECH_TAKEN', message: `${tech.name} just got booked for that time. Pick another time or another artist.` });
    }
    techName = tech.name;
  }

  const mobile = normalizeMobile(clientPhone);
  let customer_id = null;
  if (mobile) {
    const found = await q('customers', `mobile=eq.${encodeURIComponent(mobile)}&select=id&limit=1`);
    if (found.length) customer_id = found[0].id;
  }

  // Inspo photo upload (base64 data URL -> Supabase Storage), photo failure never blocks the booking
  let photoUrl = null;
  if (photoData && typeof photoData === 'string' && photoData.startsWith('data:image')) {
    try {
      const m = photoData.match(/^data:(image\/\w+);base64,(.+)$/);
      if (m) {
        const contentType = m[1];
        const bytes = Buffer.from(m[2], 'base64');
        const ext = contentType.split('/')[1] || 'jpg';
        const safePhone = String(mobile || 'guest').replace(/\D/g, '');
        photoUrl = await uploadBinary('inspo-photos', `${bookingDate}/${safePhone}-${Date.now()}.${ext}`, bytes, contentType);
      }
    } catch (e) { console.error('Inspo photo upload failed:', e.message); }
  }

  const [appt] = await ins('appointments', [{
    customer_id,
    client_name: String(clientName).trim(),
    client_phone: mobile || String(clientPhone).trim(),
    client_email: clientEmail ? String(clientEmail).trim() : null,
    service: String(service),
    addons: addons ? String(addons) : null,
    notes: notes ? String(notes) : null,
    inspo_style: inspoStyle ? String(inspoStyle) : null,
    photo_url: photoUrl,
    booking_date: bookingDate,
    booking_time: String(bookingTime),
    status: 'pending',
    sms_consent: smsConsent === true,
    service_id: svcId,
    tech_id: reqTechId
  }]);

  // Text the owner about the new booking (never blocks the client's confirmation)
  const alertLines = [
    `New booking at ${s.salon_name || 'the salon'}:`,
    `${String(clientName).trim()} ${mobile || clientPhone}`,
    `${service}${addons ? ' + ' + addons : ''}`,
    `${bookingDate} at ${bookingTime}${techName ? ' with ' + techName : ''}`
  ];
  if (inspoStyle) alertLines.push(`Style: ${inspoStyle}`);
  if (photoUrl) alertLines.push(`Inspo photo: ${photoUrl}`);
  textOwner(s, alertLines.join('\n')).catch(() => {});

  res.json({ ok: true, id: appt.id, linked: !!customer_id });
}));

// ---------- public: kiosk check-in ----------
app.post('/api/public/checkin', wrap(async (req, res) => {
  const { mobile, first_name, birthday, referral_phone } = req.body || {};
  const norm = normalizeMobile(mobile);
  if (!norm) return res.status(400).json({ error: 'Enter a valid phone number' });
  const s = await getSettings();

  let [cust] = await q('customers', `mobile=eq.${encodeURIComponent(norm)}&select=*&limit=1`);
  let isNew = false;
  let referredBy = null;
  if (!cust) {
    if (!first_name || !String(first_name).trim()) return res.json({ notFound: true });
    [cust] = await ins('customers', [{
      first_name: String(first_name).trim(),
      mobile: norm,
      birthday: birthday ? String(birthday).trim() : ''
    }]);
    isNew = true;
    // Referral: brand-new member names the friend who sent them (by phone).
    // Points are held until the new client's first PAID visit — blocks fake referrals.
    const refNorm = normalizeMobile(referral_phone);
    if (refNorm && refNorm !== norm) {
      const [ref] = await q('customers', `mobile=eq.${encodeURIComponent(refNorm)}&select=id,first_name&limit=1`);
      if (ref) {
        try {
          await ins('referrals', [{ referrer_id: ref.id, referred_id: cust.id }]);
          referredBy = ref.first_name;
        } catch (e) { console.error('referral insert skipped:', e.message); }
      }
    }
  } else if (birthday && !cust.birthday) {
    await upd('customers', `id=eq.${cust.id}`, { birthday: String(birthday).trim() });
    cust.birthday = String(birthday).trim();
  }

  const today = todayISO();
  const bonus = Number(s.checkin_bonus_points || 10);
  const inserted = await ins('checkins',
    [{ customer_id: cust.id, checkin_date: today, points: bonus }],
    { onConflict: 'customer_id,checkin_date', ignoreDuplicates: true });

  let awarded = 0;
  let birthdayBonus = 0;
  const alreadyToday = !inserted || inserted.length === 0;

  if (!alreadyToday) {
    awarded = bonus;
    // birthday month bonus, once per month, only when a birthday is on file
    if (cust.birthday && cust.birthday.slice(0, 2) === thisMonthMM()) {
      const monthStart = `${today.slice(0, 7)}-01`;
      const prior = await q('checkins', `customer_id=eq.${cust.id}&birthday_bonus=eq.true&checkin_date=gte.${monthStart}&select=id&limit=1`);
      if (prior.length === 0) {
        birthdayBonus = Number(s.birthday_bonus_points || 50);
        awarded += birthdayBonus;
        await upd('checkins', `customer_id=eq.${cust.id}&checkin_date=eq.${today}`, { points: awarded, birthday_bonus: true });
      }
    }
    await upd('customers', `id=eq.${cust.id}`, { points_earned: Number(cust.points_earned) + awarded });
    cust.points_earned = Number(cust.points_earned) + awarded;
  }

  const balance = Number(cust.points_earned) - Number(cust.points_redeemed);
  res.json({
    ok: true,
    isNew,
    alreadyToday,
    awarded,
    birthdayBonus,
    referredBy,
    first_name: cust.first_name,
    class: cust.class,
    balance,
    point_value: Number(s.point_value_dollars),
    next_reward_at: 100
  });
}));

// ---------- public: NailMind AI images ----------
app.get('/api/public/nailmind-status', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({
    ai: !!(s.gemini_api_key && s.gemini_api_key.trim()),
    packs: parsePacks(s),
    welcome: Number(s.nailmind_welcome_credits || 0),
    salon: s.salon_name || 'the salon'
  });
}));

// ---------- NailMind credit accounts ----------
// One account per real 10-digit phone number. Balance lives on the row;
// nailmind_ledger is the audit trail. All balance changes go through the
// atomic nm_credit_adjust() Postgres function (row-locked — safe under
// concurrency). Sign-in is verified by SMS code when Twilio is configured;
// a bearer token is issued on sign-in and required to see or spend credits.
const crypto = require('crypto');

function parsePacks(s) {
  // settings.nailmind_packs = "10:5,25:10,60:20"  → [{credits, dollars, link}]
  return String(s.nailmind_packs || '10:5,25:10,60:20').split(',').map(p => {
    const [c, d] = p.split(':').map(Number);
    if (!(c > 0 && d > 0)) return null;
    return { credits: c, dollars: d, link: (s['stripe_link_' + c] || '').trim() || null };
  }).filter(Boolean);
}

// Only real US-length numbers may hold accounts (blocks '1'-digit fake phones)
function strictPhone(p) {
  const n = normalizeMobile(p);
  return n && /^\d{3}-\d{3}-\d{4}$/.test(n) ? n : null;
}

async function nmAccount(phone) {
  const norm = strictPhone(phone);
  if (!norm) return null;
  const [acct] = await q('nailmind_accounts', `phone=eq.${encodeURIComponent(norm)}&select=*&limit=1`);
  return acct || null;
}

async function nmAuthed(phone, token) {
  if (!token) return null;
  const acct = await nmAccount(phone);
  return acct && acct.token && String(acct.token) === String(token) ? acct : null;
}

// Atomic adjust. Returns new balance; throws 'INSUFFICIENT' when a spend
// would go below zero.
async function nmAdjust(accountId, delta, reason, ref) {
  const out = await rpc('nm_credit_adjust', { p_account_id: accountId, p_delta: delta, p_reason: reason, p_ref: ref || null });
  const bal = Number(out);
  if (bal === -1) { const e = new Error('INSUFFICIENT'); e.code = 'INSUFFICIENT'; throw e; }
  if (bal === -2) { const e = new Error('NO_ACCOUNT'); e.code = 'NO_ACCOUNT'; throw e; }
  return bal;
}

async function nmWelcomeIfFirst(acct, s) {
  const welcome = Number(s.nailmind_welcome_credits || 0);
  if (welcome <= 0) return Number(acct.credits);
  const prior = await q('nailmind_ledger', `account_id=eq.${acct.id}&reason=eq.welcome&select=id&limit=1`);
  if (prior.length) return Number(acct.credits);
  return nmAdjust(acct.id, welcome, 'welcome');
}

function nmToken() { return crypto.randomBytes(24).toString('hex'); }
function nmTwilioReady(s) { return !!(s.twilio_sid && s.twilio_token && s.twilio_from); }

// One-time starter offer: only before any purchase, with a real 24h window
// anchored to the account's first generation. Returns null when not eligible.
async function nmStarter(acct, s) {
  const credits = Number(s.nailmind_starter_credits || 0);
  const price = Number(s.nailmind_starter_price || 0);
  if (!(credits > 0 && price > 0)) return null;
  const purchases = await q('nailmind_ledger',
    `account_id=eq.${acct.id}&reason=in.(${encodeURIComponent('"stripe purchase","front-desk sale","starter pack"')})&select=id&limit=1`);
  if (purchases.length) return null;
  const [firstGen] = await q('nailmind_ledger',
    `account_id=eq.${acct.id}&reason=eq.generate&order=created_at.asc&select=created_at&limit=1`);
  let deadline = null;
  if (firstGen) {
    deadline = new Date(new Date(firstGen.created_at).getTime() + 24 * 3600e3).toISOString();
    if (new Date(deadline) < new Date()) return null;
  }
  return { credits, price, deadline, link: (s.stripe_link_starter || '').trim() || null };
}

async function textClient(s, to, body) {
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.twilio_sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${s.twilio_sid}:${s.twilio_token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: s.twilio_from, To: '+1' + to.replace(/\D/g, '').slice(-10), Body: body })
  });
  if (!r.ok) console.error('Twilio client send failed:', r.status, await r.text());
  return r.ok;
}

// Step 1 of sign-in. With Twilio configured: text a 6-digit code (account row
// is created without welcome credits — those arrive only after verification).
// Without Twilio (kiosk mode): sign in directly.
app.post('/api/public/nailmind/account', wrap(async (req, res) => {
  const { phone, name = '' } = req.body || {};
  const norm = strictPhone(phone);
  if (!norm) return res.status(400).json({ error: 'Enter your full 10-digit phone number' });
  const s = await getSettings();
  let acct = await nmAccount(norm);
  if (!acct) [acct] = await ins('nailmind_accounts', [{ phone: norm, name: String(name).trim().slice(0, 40) }]);
  else if (name && !acct.name) await upd('nailmind_accounts', `id=eq.${acct.id}`, { name: String(name).trim().slice(0, 40) });

  if (nmTwilioReady(s)) {
    const code = String(crypto.randomInt(100000, 999999));
    await upd('nailmind_accounts', `id=eq.${acct.id}`, {
      otp_code: code,
      otp_expires: new Date(Date.now() + 5 * 60000).toISOString()
    });
    const sent = await textClient(s, norm, `${s.salon_name || 'NailMind'}: your sign-in code is ${code}. It expires in 5 minutes.`);
    if (!sent) return res.status(502).json({ error: 'Could not text you right now — please ask the front desk.' });
    return res.json({ ok: true, otp: true });
  }

  // No SMS available. A brand-new number may sign in directly — there is
  // nothing to steal and this keeps the funnel frictionless. But an account
  // that already holds credits or saved designs must never be handed over on
  // the strength of typing its phone number, so those require verification.
  const [hasDesigns] = await q('nailmind_designs', `account_id=eq.${acct.id}&select=id&limit=1`);
  const valuable = Number(acct.credits) > 0 || !!hasDesigns;
  if (valuable) {
    return res.status(409).json({
      error: 'VERIFY_UNAVAILABLE',
      message: 'This number already has an account. Text verification is not switched on yet — please contact support@nailmind.app to get back in.'
    });
  }
  const token = nmToken();
  await upd('nailmind_accounts', `id=eq.${acct.id}`, { token });
  const credits = await nmWelcomeIfFirst(acct, s);
  res.json({ ok: true, otp: false, token, phone: acct.phone, name: acct.name, credits, packs: parsePacks(s), starter: await nmStarter(acct, s) });
}));

// Step 2: verify the SMS code → issue token (+ welcome credits on first verify).
app.post('/api/public/nailmind/verify', wrap(async (req, res) => {
  const { phone, code } = req.body || {};
  const acct = await nmAccount(phone);
  if (!acct || !acct.otp_code) return res.status(400).json({ error: 'Start over and request a new code.' });
  if (!acct.otp_expires || new Date(acct.otp_expires) < new Date()) {
    return res.status(400).json({ error: 'That code expired — request a new one.' });
  }
  if (String(code || '').trim() !== String(acct.otp_code)) {
    return res.status(400).json({ error: 'Wrong code, check the text and try again.' });
  }
  const s = await getSettings();
  const token = nmToken();
  await upd('nailmind_accounts', `id=eq.${acct.id}`, { token, otp_code: null, otp_expires: null });
  const credits = await nmWelcomeIfFirst(acct, s);
  res.json({ ok: true, token, phone: acct.phone, name: acct.name, credits, packs: parsePacks(s), starter: await nmStarter(acct, s) });
}));

// Balance check — token required (no public phone→balance oracle).
app.get('/api/public/nailmind/account', wrap(async (req, res) => {
  const acct = await nmAuthed(req.query.phone, req.query.token);
  if (!acct) return res.json({ found: false });
  const s = await getSettings();
  res.json({ found: true, phone: acct.phone, name: acct.name, credits: Number(acct.credits), packs: parsePacks(s), starter: await nmStarter(acct, s) });
}));

// ---------- My Designs: cloud-saved generations ----------
// The client compresses each generated photo (~720px jpeg) and posts it here;
// designs live on the account, so members keep them across phones.
app.get('/api/public/nailmind/designs', wrap(async (req, res) => {
  const acct = await nmAuthed(req.query.phone, req.query.token);
  if (!acct) return res.status(401).json({ error: 'Sign in to see your designs' });
  res.json(await q('nailmind_designs', `account_id=eq.${acct.id}&order=created_at.desc&limit=260&select=id,url,prompt,fav,kind,created_at`));
}));

app.post('/api/public/nailmind/designs', wrap(async (req, res) => {
  const { phone, token, image, prompt = '', kind = 'generated' } = req.body || {};
  const acct = await nmAuthed(phone, token);
  if (!acct) return res.status(401).json({ error: 'Sign in to save designs' });
  const m = String(image || '').match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Bad image' });
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 600 * 1024) return res.status(413).json({ error: 'Image too large' });
  const theKind = kind === 'upload' ? 'upload' : 'generated';
  const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg';
  const url = await uploadBinary('inspo-photos', `designs/${acct.id}/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`, bytes, m[1]);
  const [row] = await ins('nailmind_designs', [{ account_id: acct.id, url, kind: theKind, prompt: String(prompt).slice(0, 140) || null }]);
  // per-album caps: 60 generated, 200 uploaded work photos
  const cap = theKind === 'upload' ? 200 : 60;
  const extra = await q('nailmind_designs', `account_id=eq.${acct.id}&kind=eq.${theKind}&order=created_at.desc&offset=${cap}&select=id`);
  if (extra.length) await del('nailmind_designs', `id=in.(${extra.map(r => r.id).join(',')})`);
  res.json({ id: row.id, url: row.url, kind: theKind });
}));

app.delete('/api/public/nailmind/designs/:id', wrap(async (req, res) => {
  const acct = await nmAuthed(req.query.phone, req.query.token);
  if (!acct) return res.status(401).json({ error: 'Sign in first' });
  await del('nailmind_designs', `id=eq.${Number(req.params.id)}&account_id=eq.${acct.id}`);
  res.json({ ok: true });
}));

app.post('/api/public/nailmind/designs/:id/fav', wrap(async (req, res) => {
  const { phone, token, fav } = req.body || {};
  const acct = await nmAuthed(phone, token);
  if (!acct) return res.status(401).json({ error: 'Sign in first' });
  await upd('nailmind_designs', `id=eq.${Number(req.params.id)}&account_id=eq.${acct.id}`, { fav: !!fav });
  res.json({ ok: true });
}));

// Front desk sells or adjusts credits (PIN protected). Negative delta = correction.
app.post('/api/nailmind/credits/grant', requirePin, wrap(async (req, res) => {
  const { phone, credits, note = '' } = req.body || {};
  const delta = Number(credits);
  if (!delta) return res.status(400).json({ error: 'Enter how many credits' });
  const norm = strictPhone(phone);
  if (!norm) return res.status(400).json({ error: 'Enter the client\'s full 10-digit phone number' });
  let acct = await nmAccount(norm);
  if (!acct) [acct] = await ins('nailmind_accounts', [{ phone: norm }]);
  try {
    const balance = await nmAdjust(acct.id, delta, delta > 0 ? 'front-desk sale' : 'correction', String(note).slice(0, 120) || null);
    res.json({ ok: true, phone: acct.phone, credits: balance });
  } catch (e) {
    if (e.code === 'INSUFFICIENT') return res.status(400).json({ error: 'That would take the balance below zero.' });
    throw e;
  }
}));

app.get('/api/nailmind/accounts', requirePin, wrap(async (req, res) => {
  // strip PostgREST logic-tree grammar characters before building the filter
  const search = String(req.query.search || '').replace(/[(),.*"\\]/g, ' ').trim();
  const parts = ['select=id,phone,name,credits,created_at', 'order=created_at.desc', 'limit=50'];
  if (search) {
    const like = encodeURIComponent(`%${search}%`);
    parts.push(`or=(phone.ilike.${like},name.ilike.${like})`);
  }
  res.json(await q('nailmind_accounts', parts.join('&')));
}));

// Refund a NailMind purchase: money back through Stripe, credits clawed back.
// A refund is always cheaper than a chargeback, so this path exists to be used
// generously — the point is that an unhappy customer never has to call the bank.
app.post('/api/nailmind/refund', requirePin, wrap(async (req, res) => {
  const { ledger_id, reason = 'requested_by_customer' } = req.body || {};
  const id = Number(ledger_id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Which purchase? A ledger entry is required.' });
  const s = await getSettings();
  const sk = (s.stripe_secret_key || '').trim();

  const [entry] = await q('nailmind_ledger', `id=eq.${id}&select=*&limit=1`);
  if (!entry) return res.status(404).json({ error: 'That purchase was not found.' });
  if (Number(entry.delta) <= 0) return res.status(400).json({ error: 'That entry is not a purchase.' });

  const isStripe = entry.reason === 'stripe purchase';
  const sessionId = String(entry.ref || '');
  if (isStripe && !sk) return res.status(503).json({ error: 'Stripe key missing — cannot refund online purchases.' });

  // Already refunded? The ledger is the source of truth.
  const prior = await q('nailmind_ledger',
    `account_id=eq.${entry.account_id}&reason=eq.refund&ref=eq.${encodeURIComponent(sessionId || ('ledger:' + entry.id))}&select=id&limit=1`);
  if (prior.length) return res.status(409).json({ error: 'This purchase was already refunded.' });

  let refundId = null, amount = null;
  if (isStripe) {
    // Look the session up rather than trusting stored data, then refund its payment.
    const sess = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${sk}` } });
    if (!sess.ok) return res.status(400).json({ error: 'Could not find that payment in Stripe.' });
    const session = await sess.json();
    const pi = session.payment_intent;
    if (!pi) return res.status(400).json({ error: 'That checkout has no payment to refund.' });
    const r = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(sk + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ payment_intent: pi, reason }).toString()
    });
    const refund = await r.json();
    if (!r.ok) {
      console.error('Stripe refund failed:', refund.error && refund.error.message);
      return res.status(502).json({ error: (refund.error && refund.error.message) || 'Stripe refused the refund.' });
    }
    refundId = refund.id;
    amount = refund.amount;
  }

  // Take back what's left. If they already spent some, we still return the money —
  // clawing a balance negative would just break the next purchase.
  const [acct] = await q('nailmind_accounts', `id=eq.${entry.account_id}&select=*&limit=1`);
  const clawback = Math.min(Number(entry.delta), Number(acct ? acct.credits : 0));
  let balance = acct ? Number(acct.credits) : 0;
  if (clawback > 0) balance = await nmAdjust(entry.account_id, -clawback, 'refund', sessionId || ('ledger:' + entry.id));
  else await ins('nailmind_ledger', [{ account_id: entry.account_id, delta: 0, reason: 'refund', ref: sessionId || ('ledger:' + entry.id) }]);

  res.json({
    ok: true,
    refunded_dollars: amount !== null ? amount / 100 : null,
    credits_removed: clawback,
    credits_left: balance,
    stripe_refund: refundId,
    note: clawback < Number(entry.delta)
      ? 'Money refunded in full. Some credits were already spent, so only the unused ones were removed.'
      : 'Money refunded and all credits removed.'
  });
}));

app.get('/api/nailmind/accounts/:id/ledger', requirePin, wrap(async (req, res) => {
  res.json(await q('nailmind_ledger', `account_id=eq.${Number(req.params.id)}&order=created_at.desc&limit=100&select=*`));
}));

// Stripe fulfillment (activates once stripe_secret_key is saved in Settings).
// Create one Payment Link per pack in the Stripe dashboard with metadata
// {credits: N} and a required "phone" custom field. The payload is never
// trusted: the session is re-fetched from Stripe with the salon's own key,
// the pack must match a configured pack (credits AND price), and the
// nailmind_stripe_events primary key makes crediting once-per-session.
// Everything Stripe can sell, in one table — checkout creates sessions from it
// and the webhook validates against it, so pack/price/credits can't drift apart.
function nmStripePacks(s) {
  return {
    starter: { price_id: (s.stripe_price_starter || '').trim(), credits: Number(s.nailmind_starter_credits || 8), cents: Math.round(Number(s.nailmind_starter_price || 2.99) * 100) },
    pack10: { price_id: (s.stripe_price_10 || '').trim(), credits: 10, cents: 499 },
    pack25: { price_id: (s.stripe_price_25 || '').trim(), credits: 25, cents: 999 },
    pack60: { price_id: (s.stripe_price_60 || '').trim(), credits: 60, cents: 1999 },
  };
}

// Signed-in checkout: the server creates the Stripe Checkout Session, so the
// pack, amount and phone can never be tampered with client-side. Stripe's
// hosted page shows Apple Pay / Google Pay automatically.
app.post('/api/public/nailmind/checkout', wrap(async (req, res) => {
  const s = await getSettings();
  const sk = (s.stripe_secret_key || '').trim();
  if (!sk) return res.status(503).json({ error: 'Online checkout is coming soon — credits are available at the front desk.' });
  const { phone, token, pack } = req.body || {};
  const acct = await nmAuthed(phone, token);
  if (!acct) return res.status(401).json({ error: 'Sign in first to buy credits.' });
  const chosen = nmStripePacks(s)[String(pack)];
  if (!chosen || !chosen.price_id) return res.status(400).json({ error: 'Pick a credit pack.' });
  if (pack === 'starter' && !(await nmStarter(acct, s))) {
    return res.status(400).json({ error: 'The first-pack deal is no longer available on this account.' });
  }
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': chosen.price_id,
    'line_items[0][quantity]': '1',
    success_url: 'https://nailmind.app/app?paid=1',
    cancel_url: 'https://nailmind.app/app?paid=0',
    'metadata[phone]': acct.phone,
    'metadata[credits]': String(chosen.credits),
    'metadata[pack]': String(pack),
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(sk + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const sess = await r.json();
  if (!r.ok || !sess.url) {
    console.error('Stripe session create failed:', sess.error && sess.error.message);
    return res.status(502).json({ error: 'Could not start checkout — try again in a moment.' });
  }
  res.json({ url: sess.url });
}));

app.post('/api/public/nailmind/stripe-webhook', wrap(async (req, res) => {
  const s = await getSettings();
  const secret = (s.stripe_secret_key || '').trim();
  if (!secret) return res.status(503).json({ error: 'Stripe not configured' });
  const event = req.body || {};
  if (event.type !== 'checkout.session.completed') return res.json({ received: true });
  const sessionId = String(((event.data && event.data.object) || {}).id || '');
  if (!/^cs_[a-zA-Z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: 'Bad session id' });

  const check = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  if (!check.ok) return res.status(400).json({ error: 'Could not verify session' });
  const verified = await check.json();
  if (verified.payment_status !== 'paid') return res.json({ received: true });

  const meta = verified.metadata || {};
  const credits = Number(meta.credits || 0);
  // Sessions our checkout endpoint created carry the pack key — validate the
  // amount and credits against the server-side table, never the payload alone.
  const table = nmStripePacks(s);
  const pack = table[String(meta.pack)] ||
    Object.values(table).find(p => p.credits === credits) || null;
  const paidOk = pack && credits === pack.credits &&
    (!verified.amount_total || Number(verified.amount_total) === pack.cents);
  const phoneField = (verified.custom_fields || []).find(f => f.key === 'phone');
  const phone = strictPhone(meta.phone ||
    (phoneField && phoneField.text && phoneField.text.value) ||
    (verified.customer_details && verified.customer_details.phone) || '');
  if (!credits || !pack || !paidOk || !phone) {
    console.error('Stripe webhook skipped:', { sessionId, credits, pack: !!pack, paidOk, phone: !!phone });
    return res.json({ received: true, skipped: true });
  }

  // Claim the session id FIRST — the primary key makes double-crediting impossible.
  const claimed = await ins('nailmind_stripe_events', [{ session_id: verified.id }],
    { onConflict: 'session_id', ignoreDuplicates: true });
  if (!claimed || !claimed.length) return res.json({ received: true, duplicate: true });

  let acct = await nmAccount(phone);
  if (!acct) [acct] = await ins('nailmind_accounts', [{ phone }]);
  try {
    await nmAdjust(acct.id, credits, 'stripe purchase', verified.id);
  } catch (e) {
    // release the claim so Stripe's retry can try again
    await del('nailmind_stripe_events', `session_id=eq.${encodeURIComponent(verified.id)}`).catch(() => {});
    throw e;
  }
  res.json({ received: true, credited: credits });
}));

// The API rejects an unknown aspect ratio with a 400, so a typo in the admin
// settings would take generation down entirely. Anything unrecognised falls
// back to the default instead.
const ASPECT_RATIOS = new Set(['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1',
  '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']);
const DEFAULT_ASPECT = '4:5';

function safeAspect(value) {
  const v = String(value || '').trim();
  return ASPECT_RATIOS.has(v) ? v : DEFAULT_ASPECT;
}

async function geminiImage(key, prompt, aspect) {
  const models = ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'];
  let lastErr = null;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          // Portrait by default: these are looked at on a phone and saved to a
          // camera roll. Left alone the model returns 1024x1024 squares.
          imageConfig: { aspectRatio: safeAspect(aspect) }
        }
      })
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 404) { lastErr = 'model not found'; continue; }
    if (!r.ok) throw new Error((d.error && d.error.message) || `Image API error ${r.status}`);
    const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
    const img = parts.find(p => p.inlineData && p.inlineData.data);
    if (img) return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
    lastErr = 'no image in response';
  }
  throw new Error(lastErr || 'no image generated');
}

// Who is this guest, roughly? Enough to stop one person eating the whole free
// tier, not enough to identify anyone: the IP and browser are hashed together
// and only the hash is stored, so the database never holds a raw IP address.
// It is deliberately beatable — a determined visitor can switch networks and
// get another free design. That is a fine trade for never blocking a real one.
function guestFingerprint(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket.remoteAddress || 'unknown';
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  return require('crypto').createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 32);
}

app.post('/api/public/nailmind-generate', wrap(async (req, res) => {
  const s = await getSettings();
  const key = (s.gemini_api_key || '').trim();
  if (!key) return res.json({ needsKey: true });

  const userPrompt = String((req.body || {}).prompt || '').slice(0, 500).trim();
  if (!userPrompt) return res.status(400).json({ error: 'Describe your dream nails first' });
  const shape = String((req.body || {}).shape || '').slice(0, 30);
  const length = String((req.body || {}).length || '').slice(0, 30);

  // Signed-in members (phone + token) spend 1 credit per generation, charged
  // atomically BEFORE the images run (refunded if generation fails). Guests
  // get a free taste counted against their own device — not against everyone
  // else's — with a global ceiling behind it that exists only to cap spend.
  let acct = null;
  const n = Math.min(6, Math.max(1, Number(s.nailmind_images_per_generate || 3)));
  const limit = Number(s.nailmind_daily_limit || 400);
  const perPerson = Number(s.nailmind_guest_daily_images || 2);
  let used = null, creditsLeft = null, guestFp = null;

  const phone = (req.body || {}).phone;
  if (phone) {
    acct = await nmAuthed(phone, (req.body || {}).token);
    if (!acct) return res.status(401).json({ error: 'ACCOUNT_NOT_FOUND', message: 'Sign in again to keep designing.' });
    try {
      creditsLeft = await nmAdjust(acct.id, -1, 'generate', `${n} images`);
    } catch (e) {
      if (e.code === 'INSUFFICIENT') {
        return res.status(402).json({ error: 'NO_CREDITS', message: 'You are out of design credits.', credits: 0, packs: parsePacks(s) });
      }
      throw e;
    }
  } else {
    guestFp = guestFingerprint(req);
    const gate = await rpc('nm_guest_reserve', { p_fp: guestFp, p_n: n, p_per_person: perPerson, p_global: limit });
    used = gate && gate.global_used;
    if (!gate || !gate.allowed) {
      // Two very different situations, and the visitor deserves to know which.
      // "You've had your free one" is an invitation. "We're at capacity" is our
      // problem, not theirs — saying so is what keeps it from reading as a
      // broken app they never come back to.
      if (gate && gate.why === 'global') {
        return res.status(429).json({
          error: 'STUDIO_BUSY',
          message: 'The free studio is packed right now — so many people designing today! Credits still work instantly, or come back tomorrow when free designs reset.'
        });
      }
      return res.status(429).json({
        error: 'GUEST_LIMIT',
        message: 'That was your free design for today. Sign in with your number to keep going — the first credit is on us.'
      });
    }
  }

  // Written as a photograph, not a keyword list — Google's guidance is that
  // these models reward describing a scene over listing tags. Three things
  // in here earn their keep:
  // the fingers are described as separate and fully visible (occlusion, not
  // counting, is what produces fused and extra fingers); skin is given real
  // texture (plastic skin is the giveaway that an image is generated); and the
  // manicure is pinned to what a tech could actually execute in one
  // appointment, stated as craft facts rather than as a list of bans.
  const base = `A photorealistic close-up beauty photograph of a single relaxed right hand, fingers gently fanned and softly curved so the four fingernails and the thumbnail are each clearly separate and fully visible, resting on a warm neutral matte surface. Natural skin with fine pores, soft knuckle creases and neat cuticles. The ${length || 'medium'} ${shape || 'almond'} nails wear this design: ${userPrompt}. It is a manicure a real nail technician could complete in one appointment with ordinary salon products — even free-edge lengths across all five nails, a crisp cuticle line with the product stopping at the skin, and every detail painted, embedded or cured flush under a glossy gel topcoat rather than floating above the nail. One large softbox to camera left with a white bounce card filling the shadows leaves a single soft highlight running down each nail. Shot on a 100mm macro lens at f/8, slightly elevated three-quarter angle; all five nails sharp, the plain unmarked background softly defocused.`;

  // Every variation moves the CAMERA, never the design. The old set changed the
  // accent finger and the colour between images, which is why a pair of results
  // could look like two different manicures instead of two photos of one.
  const twists = [
    '',
    ' The same hand, same manicure, same lighting and same background, seen from a slightly different angle with the fingers a touch more curled.',
    ' The same hand and the same manicure, same lighting and background, tilted so the nail tips catch the light.',
    ' The same hand and the same manicure, same lighting and background, framed a little closer with the fingers relaxed.'
  ];
  const aspect = safeAspect(s.nailmind_aspect_ratio);
  const jobs = Array.from({ length: n }, (_, i) => geminiImage(key, base + twists[i % twists.length], aspect));
  const settled = await Promise.allSettled(jobs);
  const images = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!images.length) {
    const firstErr = settled.find(x => x.status === 'rejected');
    const raw = (firstErr && firstErr.reason && firstErr.reason.message) || 'unknown';
    console.error('NailMind generation failed:', raw);
    // Failed generations are free — give the pre-charged credit back
    if (acct) creditsLeft = await nmAdjust(acct.id, 1, 'refund: generation failed').catch(() => null);
    // ...and a guest whose one free design failed should not be locked out
    // for the rest of the day over an image that never arrived.
    if (guestFp) await rpc('nm_guest_release', { p_fp: guestFp, p_n: n }).catch(() => {});
    // Clients see friendly copy, never raw provider errors
    let friendly = 'The design studio is warming up. Please try again in a moment.';
    if (/quota|billing|exceeded/i.test(raw)) friendly = 'The design studio is resting right now. Please ask the front desk, or try again later.';
    if (/api key|invalid|unauthorized|permission/i.test(raw)) friendly = 'The design studio is not set up yet. Please ask the front desk.';
    return res.status(502).json({ error: friendly, credits: creditsLeft });
  }

  // A credit buys `n` images. If only some of them came back — one variation
  // tripped a safety filter, one call timed out — the customer paid in full for
  // a part order. Hand back the credit and let them keep what did arrive. It
  // costs a few cents on a rare event and it is the answer that keeps someone
  // from feeling cheated by a machine.
  let shortfall = false;
  if (images.length < n) {
    shortfall = true;
    console.error(`NailMind partial generation: ${images.length}/${n} images`);
    if (acct) creditsLeft = await nmAdjust(acct.id, 1, 'refund: partial generation', `${images.length}/${n}`).catch(() => creditsLeft);
    if (guestFp) await rpc('nm_guest_release', { p_fp: guestFp, p_n: n }).catch(() => {});
  }

  res.json({ images, used, limit, credits: creditsLeft, shortfall });
}));

// ---------- dashboard ----------
app.get('/api/dashboard', requirePin, wrap(async (req, res) => {
  const s = await getSettings();
  const stats = await rpc('dashboard_stats', { atrisk_days: Number(s.atrisk_days) });
  res.json({ ...stats, settings: redactSettings(s) });
}));

// ---------- customers ----------
app.get('/api/customers', requirePin, wrap(async (req, res) => {
  const { search = '', cls = '', sort = 'recent', limit = 50, offset = 0 } = req.query;
  const parts = ['status=neq.DELETED', `limit=${Number(limit)}`, `offset=${Number(offset)}`, 'select=*'];
  if (search) {
    const like = encodeURIComponent(`%${search}%`);
    parts.push(`or=(first_name.ilike.${like},last_name.ilike.${like},mobile.ilike.${like},email.ilike.${like})`);
  }
  if (cls) parts.push(`class=eq.${cls}`);
  const sorts = {
    recent: 'order=last_visit_date.desc.nullslast',
    name: 'order=first_name.asc',
    spend: 'order=lifetime_spend.desc',
    visits: 'order=visits.desc',
    away: 'order=last_visit_date.asc.nullslast'
  };
  parts.push(sorts[sort] || sorts.recent);
  const { rows, total } = await q('customers', parts.join('&'), { count: true });
  const today = todayISO();
  for (const r of rows) {
    r.days_away = r.last_visit_date
      ? Math.floor((new Date(today) - new Date(r.last_visit_date)) / 86400000)
      : null;
  }
  res.json({ total, rows });
}));

app.get('/api/customers/:id', requirePin, wrap(async (req, res) => {
  const [c] = await q('customers', `id=eq.${Number(req.params.id)}&select=*&limit=1`);
  if (!c) return res.status(404).json({ error: 'not found' });
  const tickets = await q('tickets',
    `customer_id=eq.${c.id}&order=created_at.desc&limit=50&select=*,ticket_items(name)`);
  for (const t of tickets) {
    t.items = (t.ticket_items || []).map(i => i.name).join(', ');
    delete t.ticket_items;
  }
  const s = await getSettings();
  res.json({
    ...c, tickets,
    points_balance: Number(c.points_earned) - Number(c.points_redeemed),
    point_value: Number(s.point_value_dollars)
  });
}));

app.post('/api/customers', requirePin, wrap(async (req, res) => {
  const { first_name = '', last_name = '', mobile = '', email = '', birthday = '', notes = '' } = req.body || {};
  if (!String(first_name).trim()) return res.status(400).json({ error: 'Name is required' });
  const norm = normalizeMobile(mobile);
  if (norm) {
    const dup = await q('customers', `mobile=eq.${encodeURIComponent(norm)}&select=id&limit=1`);
    if (dup.length) return res.status(409).json({ error: 'A customer with this phone already exists', id: dup[0].id });
  }
  const [c] = await ins('customers', [{
    first_name: String(first_name).trim(), last_name: String(last_name).trim(),
    mobile: norm, email: String(email).trim(), birthday: String(birthday).trim(), notes: String(notes).trim()
  }]);
  res.json(c);
}));

app.put('/api/customers/:id', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [c] = await q('customers', `id=eq.${id}&select=*&limit=1`);
  if (!c) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const f of ['first_name', 'last_name', 'email', 'birthday', 'notes', 'status']) {
    if (req.body[f] !== undefined) patch[f] = String(req.body[f]).trim();
  }
  if (req.body.mobile !== undefined) {
    const norm = normalizeMobile(req.body.mobile);
    if (norm) {
      const dup = await q('customers', `mobile=eq.${encodeURIComponent(norm)}&id=neq.${id}&select=id&limit=1`);
      if (dup.length) return res.status(409).json({ error: 'Another customer already has this phone' });
    }
    patch.mobile = norm;
  }
  const [saved] = await upd('customers', `id=eq.${id}`, patch);
  res.json(saved);
}));

// ---------- techs ----------
// Every tech either does everything (all_services) or has explicit rows in tech_services.
// NailDesk (POS tech picker) and NailBook (booking artist filter) both read this one source.
async function attachSkills(list) {
  const links = await q('tech_services', 'select=tech_id,service_id');
  const by = {};
  for (const l of links) (by[l.tech_id] = by[l.tech_id] || []).push(l.service_id);
  for (const t of list) t.service_ids = t.all_services ? [] : (by[t.id] || []);
  return list;
}

async function saveSkills(techId, allServices, serviceIds) {
  await del('tech_services', `tech_id=eq.${techId}`);
  const ids = [...new Set((serviceIds || []).map(Number).filter(Boolean))];
  if (!allServices && ids.length) {
    await ins('tech_services', ids.map(sid => ({ tech_id: techId, service_id: sid })));
  }
}

app.get('/api/techs', requirePin, wrap(async (req, res) => {
  res.json(await attachSkills(await q('techs', 'order=active.desc,name.asc&select=*')));
}));
app.post('/api/techs', requirePin, wrap(async (req, res) => {
  const { name, phone = '', all_services = true, service_ids = [] } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const [t] = await ins('techs', [{ name: String(name).trim(), phone: String(phone).trim(), all_services: !!all_services }]);
  await saveSkills(t.id, !!all_services, service_ids);
  res.json(t);
}));
app.put('/api/techs/:id', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const patch = {};
  if (req.body.name !== undefined && String(req.body.name).trim()) patch.name = String(req.body.name).trim();
  if (req.body.phone !== undefined) patch.phone = String(req.body.phone);
  if (req.body.active !== undefined) patch.active = !!req.body.active;
  if (req.body.all_services !== undefined) patch.all_services = !!req.body.all_services;
  const [t] = Object.keys(patch).length
    ? await upd('techs', `id=eq.${id}`, patch)
    : await q('techs', `id=eq.${id}&select=*&limit=1`);
  if (req.body.service_ids !== undefined || req.body.all_services !== undefined) {
    await saveSkills(id, t.all_services, req.body.service_ids);
  }
  res.json(t);
}));

// ---------- services ----------
app.get('/api/services', requirePin, wrap(async (req, res) => {
  res.json(await q('services', 'order=active.desc,category.asc,name.asc&select=*'));
}));
app.post('/api/services', requirePin, wrap(async (req, res) => {
  const { name, category = 'General', price = 0, duration_min = 30, description = '' } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const [svc] = await ins('services', [{
    name: String(name).trim(), category: String(category).trim() || 'General',
    price: Number(price) || 0, duration_min: Number(duration_min) || 30,
    description: String(description).trim()
  }]);
  res.json(svc);
}));
app.put('/api/services/:id', requirePin, wrap(async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
  if (req.body.category !== undefined) patch.category = String(req.body.category).trim();
  if (req.body.price !== undefined) patch.price = Number(req.body.price) || 0;
  if (req.body.duration_min !== undefined) patch.duration_min = Number(req.body.duration_min) || 30;
  if (req.body.active !== undefined) patch.active = !!req.body.active;
  if (req.body.description !== undefined) patch.description = String(req.body.description).trim();
  const [svc] = await upd('services', `id=eq.${Number(req.params.id)}`, patch);
  res.json(svc);
}));

// ---------- tickets ----------
app.get('/api/tickets', requirePin, wrap(async (req, res) => {
  const date = String(req.query.date || todayISO());
  res.json(await rpc('day_tickets', { p_date: date }));
}));

app.get('/api/tickets/:id', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await q('tickets', `id=eq.${id}&select=*,customers(first_name,mobile,class,points_earned,points_redeemed)&limit=1`);
  if (!t) return res.status(404).json({ error: 'not found' });
  const c = t.customers;
  delete t.customers;
  t.customer_name = c ? c.first_name : null;
  t.customer_mobile = c ? c.mobile : null;
  t.customer_class = c ? c.class : null;
  t.customer_points = c ? Number(c.points_earned) - Number(c.points_redeemed) : 0;
  t.items = await q('ticket_items', `ticket_id=eq.${id}&select=*,techs(name)&order=id.asc`);
  for (const i of t.items) { i.tech_name = i.techs ? i.techs.name : null; delete i.techs; }
  res.json(t);
}));

app.post('/api/tickets', requirePin, wrap(async (req, res) => {
  const [t] = await ins('tickets', [{ customer_id: req.body.customer_id || null }]);
  res.json({ id: t.id });
}));

async function recalcTicket(id) {
  const items = await q('ticket_items', `ticket_id=eq.${id}&select=price`);
  const sub = items.reduce((a, b) => a + Number(b.price), 0);
  const [t] = await q('tickets', `id=eq.${id}&select=discount,tip&limit=1`);
  const total = Math.max(0, sub - Number(t.discount)) + Number(t.tip);
  await upd('tickets', `id=eq.${id}`, { subtotal: sub, total });
}

app.post('/api/tickets/:id/items', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await q('tickets', `id=eq.${id}&status=eq.open&select=id&limit=1`);
  if (!t) return res.status(404).json({ error: 'Ticket not open' });
  let { service_id = null, name, price, tech_id = null } = req.body || {};
  let itemName = name, itemPrice = Number(price);
  if (service_id) {
    const [svc] = await q('services', `id=eq.${Number(service_id)}&select=name,price&limit=1`);
    if (svc) { itemName = itemName || svc.name; if (isNaN(itemPrice)) itemPrice = Number(svc.price); }
  }
  if (!itemName) return res.status(400).json({ error: 'Item name required' });
  await ins('ticket_items', [{ ticket_id: id, service_id, name: itemName, price: itemPrice || 0, tech_id }]);
  await recalcTicket(id);
  res.json({ ok: true });
}));

app.delete('/api/tickets/:id/items/:itemId', requirePin, wrap(async (req, res) => {
  await del('ticket_items', `id=eq.${Number(req.params.itemId)}&ticket_id=eq.${Number(req.params.id)}`);
  await recalcTicket(Number(req.params.id));
  res.json({ ok: true });
}));

app.put('/api/tickets/:id', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await q('tickets', `id=eq.${id}&status=eq.open&select=*&limit=1`);
  if (!t) return res.status(404).json({ error: 'Ticket not open' });
  const patch = {};
  if (req.body.customer_id !== undefined) patch.customer_id = req.body.customer_id;
  if (req.body.discount !== undefined) patch.discount = Number(req.body.discount) || 0;
  if (req.body.tip !== undefined) patch.tip = Number(req.body.tip) || 0;
  if (req.body.notes !== undefined) patch.notes = String(req.body.notes);
  await upd('tickets', `id=eq.${id}`, patch);
  await recalcTicket(id);
  const [fresh] = await q('tickets', `id=eq.${id}&select=*&limit=1`);
  res.json(fresh);
}));

app.post('/api/tickets/:id/checkout', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await q('tickets', `id=eq.${id}&status=eq.open&select=*&limit=1`);
  if (!t) return res.status(404).json({ error: 'Ticket not open' });
  const { payment_method = 'cash', tip = 0, discount = 0, redeem_points = 0 } = req.body || {};
  const s = await getSettings();

  const items = await q('ticket_items', `ticket_id=eq.${id}&select=price`);
  const sub = items.reduce((a, b) => a + Number(b.price), 0);
  if (sub <= 0 && !req.body.force) return res.status(400).json({ error: 'Ticket has no items' });

  let pointsUsed = 0, pointsDiscount = 0;
  const cust = t.customer_id
    ? (await q('customers', `id=eq.${t.customer_id}&select=*&limit=1`))[0]
    : null;
  if (cust && Number(redeem_points) > 0) {
    const balance = Number(cust.points_earned) - Number(cust.points_redeemed);
    const maxDiscount = sub * (Number(s.redeem_max_ticket_pct || 50) / 100);
    const maxPoints = Math.floor(maxDiscount / Number(s.point_value_dollars));
    pointsUsed = Math.min(Number(redeem_points), balance, maxPoints);
    pointsDiscount = pointsUsed * Number(s.point_value_dollars);
  }
  const disc = (Number(discount) || 0) + pointsDiscount;
  const serviceTotal = Math.max(0, sub - disc);
  const total = serviceTotal + (Number(tip) || 0);

  // Loyalty: base points on what was actually paid for services (no tips, after discounts),
  // plus milestone bonuses (5th/10th completed paid visit) and referral awards.
  let earned = 0, bonus = 0, milestone = null, referral = null;
  const bonusReasons = [];
  if (cust) {
    earned = Math.floor(serviceTotal * Number(s.points_per_dollar));
    const newVisits = cust.visits + 1;
    if (newVisits === 5 && Number(s.visit5_bonus_points) > 0) {
      bonus += Number(s.visit5_bonus_points);
      bonusReasons.push('5th visit bonus');
      milestone = { visit: 5, points: Number(s.visit5_bonus_points) };
    }
    if (newVisits === 10 && Number(s.visit10_bonus_points) > 0) {
      bonus += Number(s.visit10_bonus_points);
      bonusReasons.push('10th visit bonus');
      milestone = { visit: 10, points: Number(s.visit10_bonus_points) };
    }
    // Referral pays out on the referred client's FIRST paid visit — never on signup alone
    const refs = await q('referrals', `referred_id=eq.${cust.id}&awarded=eq.false&select=id,referrer_id&limit=1`);
    if (refs.length) {
      const welcome = Number(s.referral_welcome_points || 0);
      const refBonus = Number(s.referral_bonus_points || 0);
      if (welcome > 0) { bonus += welcome; bonusReasons.push('referral welcome'); }
      const [referrer] = await q('customers', `id=eq.${refs[0].referrer_id}&select=id,first_name,points_earned&limit=1`);
      if (referrer && refBonus > 0) {
        await upd('customers', `id=eq.${referrer.id}`, { points_earned: Number(referrer.points_earned) + refBonus });
      }
      await upd('referrals', `id=eq.${refs[0].id}`, { awarded: true, awarded_at: new Date().toISOString() });
      referral = { referrer_name: referrer ? referrer.first_name : null, referrer_points: refBonus, welcome_points: welcome };
    }
  }

  await upd('tickets', `id=eq.${id}`, {
    status: 'paid', closed_at: new Date().toISOString(),
    subtotal: sub, discount: disc, tip: Number(tip) || 0, total,
    payment_method, points_used: pointsUsed,
    bonus_points: bonus, bonus_reason: bonusReasons.join(', ') || null
  });
  if (cust) {
    const nextCust = {
      visits: cust.visits + 1,
      lifetime_spend: Number(cust.lifetime_spend) + serviceTotal,
      last_visit_date: todayISO(),
      last_visit_amount: serviceTotal,
      points_earned: Number(cust.points_earned) + earned + bonus,
      points_redeemed: Number(cust.points_redeemed) + pointsUsed
    };
    nextCust.class = classify(nextCust, s);
    await upd('customers', `id=eq.${cust.id}`, nextCust);
  }
  const [done] = await q('tickets', `id=eq.${id}&select=*&limit=1`);
  res.json({ ...done, points_earned_now: earned + bonus, milestone, referral });
}));

// Refund a paid ticket: reverses revenue, the visit, and every point it granted
app.post('/api/tickets/:id/refund', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await q('tickets', `id=eq.${id}&status=eq.paid&select=*&limit=1`);
  if (!t) return res.status(404).json({ error: 'Only paid tickets can be refunded' });
  const s = await getSettings();
  await upd('tickets', `id=eq.${id}`, { status: 'refunded' });
  if (t.customer_id) {
    const [c] = await q('customers', `id=eq.${t.customer_id}&select=*&limit=1`);
    if (c) {
      const serviceTotal = Math.max(0, Number(t.subtotal) - Number(t.discount));
      const earned = Math.floor(serviceTotal * Number(s.points_per_dollar)) + Number(t.bonus_points || 0);
      const next = {
        visits: Math.max(0, c.visits - 1),
        lifetime_spend: Math.max(0, Number(c.lifetime_spend) - serviceTotal),
        points_earned: Math.max(0, Number(c.points_earned) - earned),
        points_redeemed: Math.max(0, Number(c.points_redeemed) - Number(t.points_used || 0))
      };
      next.class = classify(next, s);
      await upd('customers', `id=eq.${c.id}`, next);
    }
  }
  res.json({ ok: true });
}));

app.post('/api/tickets/:id/void', requirePin, wrap(async (req, res) => {
  await upd('tickets', `id=eq.${Number(req.params.id)}&status=eq.open`, {
    status: 'void', closed_at: new Date().toISOString()
  });
  res.json({ ok: true });
}));

// ---------- appointments (admin) ----------
app.get('/api/appointments', requirePin, wrap(async (req, res) => {
  const date = req.query.date;
  const status = req.query.status;
  const parts = ['select=*', 'order=booking_date.asc,booking_time.asc', 'limit=200'];
  if (date) parts.push(`booking_date=eq.${date}`);
  else parts.push(`booking_date=gte.${todayISO()}`);
  if (status) parts.push(`status=eq.${status}`);
  res.json(await q('appointments', parts.join('&')));
}));

app.put('/api/appointments/:id', requirePin, wrap(async (req, res) => {
  const patch = {};
  if (req.body.status !== undefined) patch.status = String(req.body.status);
  if (req.body.notes !== undefined) patch.notes = String(req.body.notes);
  const [a] = await upd('appointments', `id=eq.${Number(req.params.id)}`, patch);
  res.json(a);
}));

// Turn an appointment into an open ticket (creates/links the customer by phone)
app.post('/api/appointments/:id/start-ticket', requirePin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [a] = await q('appointments', `id=eq.${id}&select=*&limit=1`);
  if (!a) return res.status(404).json({ error: 'not found' });
  let customer_id = a.customer_id;
  if (!customer_id) {
    const norm = normalizeMobile(a.client_phone);
    if (norm) {
      const found = await q('customers', `mobile=eq.${encodeURIComponent(norm)}&select=id&limit=1`);
      if (found.length) customer_id = found[0].id;
      else {
        const [c] = await ins('customers', [{ first_name: a.client_name, mobile: norm, email: a.client_email || '' }]);
        customer_id = c.id;
      }
    }
  }
  const [t] = await ins('tickets', [{ customer_id, notes: `Appointment #${a.id}: ${a.service}` }]);
  await upd('appointments', `id=eq.${id}`, { status: 'confirmed', ticket_id: t.id, customer_id });
  res.json({ ticket_id: t.id });
}));

// ---------- import (Zota xlsx as base64 JSON) ----------
app.post('/api/import', requirePin, wrap(async (req, res) => {
  const { data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'No file data' });
  const wb = XLSX.read(Buffer.from(data, 'base64'), { raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Zota writes a stale <dimension>; recompute the range from actual cells
  let range = { s: { r: Infinity, c: Infinity }, e: { r: 0, c: 0 } };
  for (const addr of Object.keys(sheet)) {
    if (addr[0] === '!') continue;
    const cell = XLSX.utils.decode_cell(addr);
    range.s.r = Math.min(range.s.r, cell.r); range.s.c = Math.min(range.s.c, cell.c);
    range.e.r = Math.max(range.e.r, cell.r); range.e.c = Math.max(range.e.c, cell.c);
  }
  if (range.s.r <= range.e.r) sheet['!ref'] = XLSX.utils.encode_range(range);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const headerIdx = rows.findIndex(r => r.some(c => String(c).trim().toLowerCase().startsWith('cust. first')));
  if (headerIdx === -1) return res.status(400).json({ error: 'Not a Zota customer report: header row not found' });
  const header = rows[headerIdx].map(c => String(c).trim().toLowerCase());
  const col = name => header.findIndex(h => h.startsWith(name));
  const C = {
    first: col('cust. first'), mobile: col('cust. mobile'), birthday: col('birthday'),
    cls: col('class'), lastDate: col('last serv. date'), lastAmt: col('last serv. amount'),
    visits: col('no. of visit'), spend: col('up-to-date'),
    ptsEarned: col('point earned'), ptsRedeemed: col('point redeemed'),
    email: col('email'), remarks: col('remarks')
  };
  const usDateToISO = d => {
    const m = String(d || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
  };

  const s = await getSettings();
  const rank = { NEW: 0, LOYAL: 1, VIP: 2 };
  let added = 0, updated = 0, skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const name = String(r[C.first] || '').trim();
    const mobile = normalizeMobile(r[C.mobile]);
    if (!name && !mobile) continue;
    if (!mobile) { skipped++; continue; }
    const rec = {
      first_name: name, mobile,
      email: String(r[C.email] || '').trim(),
      birthday: String(r[C.birthday] || '').trim(),
      notes: String(r[C.remarks] || '').trim(),
      visits: Math.round(Number(r[C.visits]) || 0),
      lifetime_spend: Number(r[C.spend]) || 0,
      last_visit_date: usDateToISO(r[C.lastDate]),
      last_visit_amount: Number(r[C.lastAmt]) || 0,
      points_earned: Number(r[C.ptsEarned]) || 0,
      points_redeemed: Number(r[C.ptsRedeemed]) || 0
    };
    const zotaClass = String(r[C.cls] || '').trim().toUpperCase();
    const computed = classify(rec, s);
    rec.class = (rank[zotaClass] || 0) > rank[computed] ? zotaClass : computed;

    const existing = await q('customers', `mobile=eq.${encodeURIComponent(mobile)}&select=id,email,birthday&limit=1`);
    if (existing.length) {
      const patch = { ...rec };
      if (!patch.email) delete patch.email;
      if (!patch.birthday) delete patch.birthday;
      delete patch.mobile;
      await upd('customers', `id=eq.${existing[0].id}`, patch);
      updated++;
    } else {
      await ins('customers', [rec]);
      added++;
    }
  }
  res.json({ added, updated, skipped });
}));

// ---------- reports ----------
app.get('/api/reports/revenue', requirePin, wrap(async (req, res) => {
  const from = String(req.query.from || new Date(Date.now() - 29 * 86400000).toLocaleDateString('sv-SE', { timeZone: LA }));
  const to = String(req.query.to || todayISO());
  const rep = await rpc('revenue_report', { p_from: from, p_to: to });
  res.json({ from, to, ...rep });
}));

app.get('/api/reports/customers.csv', requirePin, wrap(async (req, res) => {
  const rows = await q('customers', 'status=neq.DELETED&order=lifetime_spend.desc&select=first_name,last_name,mobile,email,birthday,class,status,visits,lifetime_spend,last_visit_date,last_visit_amount,points_earned,points_redeemed,notes&limit=5000');
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = 'First Name,Last Name,Mobile,Email,Birthday,Class,Status,Visits,Lifetime Spend,Last Visit,Last Amount,Points Earned,Points Redeemed,Notes';
  const csv = [header, ...rows.map(r => [r.first_name, r.last_name, r.mobile, r.email, r.birthday, r.class, r.status,
    r.visits, r.lifetime_spend, r.last_visit_date, r.last_visit_amount, r.points_earned, r.points_redeemed, r.notes].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="customer_report.csv"');
  res.send(csv);
}));

// ---------- settings ----------
app.get('/api/settings', requirePin, wrap(async (req, res) => res.json(redactSettings(await getSettings(true)))));

app.put('/api/settings', requirePin, wrap(async (req, res) => {
  // '__SET__' is what a redacted secret looks like coming back from the admin
  // form — it means "unchanged", so drop it rather than overwriting the real key.
  const entries = Object.entries(req.body || {})
    .filter(([, value]) => String(value) !== '__SET__')
    .map(([key, value]) => ({ key, value: String(value) }));
  if (entries.length) await ins('settings', entries, { onConflict: 'key', merge: true });
  res.json(redactSettings(await getSettings(true)));
}));

app.post('/api/settings/test-text', requirePin, wrap(async (req, res) => {
  const s = await getSettings(true);
  const sent = await textOwner(s, `Test from ${s.salon_name || 'your POS'} — text alerts are working!`);
  res.json({ sent });
}));

app.post('/api/settings/reclassify', requirePin, wrap(async (req, res) => {
  const s = await getSettings();
  const out = await rpc('reclassify_customers', {
    p_vip_visits: Number(s.vip_min_visits),
    p_vip_spend: Number(s.vip_min_spend),
    p_loyal_visits: Number(s.loyal_min_visits)
  });
  res.json(out);
}));

module.exports = app;
