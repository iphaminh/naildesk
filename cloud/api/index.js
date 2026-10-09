// NailDesk — the Dream Nails salon platform in one Express app: the client
// booking page (sold as NailBook), the check-in kiosk and the front-desk POS.
// server.js serves it on Hostinger.
const express = require('express');
const XLSX = require('xlsx');
const { q, ins, upd, del, rpc, uploadBinary } = require('../lib/supa');

const app = express();

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
