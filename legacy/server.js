const express = require('express');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { db, getSettings, classify } = require('./db');
const { importZotaFile, normalizeMobile } = require('./lib/importZota');

const app = express();
const PORT = process.env.PORT || 3789;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: os.tmpdir() });

// ---------- helpers ----------
const todayISO = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000);
}

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const s = getSettings();
  const today = todayISO();
  const rev = db.prepare(`SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(tip),0) tip, COUNT(*) n
    FROM tickets WHERE status='paid' AND date(closed_at)=?`).get(today);
  const openTickets = db.prepare(`SELECT COUNT(*) n FROM tickets WHERE status='open'`).get().n;
  const classes = db.prepare(`SELECT class, COUNT(*) n FROM customers WHERE status='ACTIVE' GROUP BY class`).all();
  const totalCustomers = db.prepare(`SELECT COUNT(*) n FROM customers WHERE status='ACTIVE'`).get().n;

  const atriskDays = Number(s.atrisk_days);
  const atRisk = db.prepare(`
    SELECT id, first_name, mobile, class, last_visit_date, visits, lifetime_spend,
           CAST(julianday('now','localtime') - julianday(last_visit_date) AS INTEGER) AS days_away
    FROM customers
    WHERE status='ACTIVE' AND class IN ('VIP','LOYAL') AND last_visit_date != ''
      AND julianday('now','localtime') - julianday(last_visit_date) > ?
    ORDER BY lifetime_spend DESC LIMIT 12`).all(atriskDays);

  const last30 = db.prepare(`
    SELECT date(closed_at) d, SUM(total) total, COUNT(*) n
    FROM tickets WHERE status='paid' AND closed_at >= date('now','localtime','-30 days')
    GROUP BY date(closed_at) ORDER BY d`).all();

  const thisMonth = db.prepare(`SELECT COALESCE(SUM(total),0) total, COUNT(*) n
    FROM tickets WHERE status='paid' AND strftime('%Y-%m', closed_at) = strftime('%Y-%m','now','localtime')`).get();

  const mmdd = new Date().toISOString(); // birthdays this month
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const birthdays = db.prepare(`SELECT id, first_name, mobile, birthday, class FROM customers
    WHERE status='ACTIVE' AND birthday LIKE ? ORDER BY birthday LIMIT 20`).all(month + '/%');

  res.json({ today: rev, openTickets, classes, totalCustomers, atRisk, last30, thisMonth, birthdays, settings: s });
});

// ---------- customers ----------
app.get('/api/customers', (req, res) => {
  const { search = '', cls = '', sort = 'recent', limit = 100, offset = 0 } = req.query;
  let where = `WHERE status != 'DELETED'`;
  const params = [];
  if (search) {
    where += ` AND (first_name LIKE ? OR mobile LIKE ? OR email LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (cls) { where += ` AND class = ?`; params.push(cls); }
  const sorts = {
    recent: 'last_visit_date DESC',
    name: 'first_name COLLATE NOCASE ASC',
    spend: 'lifetime_spend DESC',
    visits: 'visits DESC',
    away: `(CASE WHEN last_visit_date='' THEN -1 ELSE julianday('now')-julianday(last_visit_date) END) DESC`
  };
  const orderBy = sorts[sort] || sorts.recent;
  const total = db.prepare(`SELECT COUNT(*) n FROM customers ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT *,
      CASE WHEN last_visit_date='' THEN NULL
           ELSE CAST(julianday('now','localtime') - julianday(last_visit_date) AS INTEGER) END AS days_away
    FROM customers ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, Number(limit), Number(offset));
  res.json({ total, rows });
});

app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const tickets = db.prepare(`SELECT t.*,
      (SELECT GROUP_CONCAT(name, ', ') FROM ticket_items WHERE ticket_id=t.id) items
    FROM tickets t WHERE customer_id=? ORDER BY created_at DESC LIMIT 50`).all(c.id);
  const s = getSettings();
  const pointsBalance = c.points_earned - c.points_redeemed;
  res.json({ ...c, tickets, points_balance: pointsBalance, point_value: Number(s.point_value_dollars) });
});

app.post('/api/customers', (req, res) => {
  const { first_name = '', last_name = '', mobile = '', email = '', birthday = '', notes = '' } = req.body;
  const norm = normalizeMobile(mobile);
  if (!first_name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (norm) {
    const dup = db.prepare('SELECT id FROM customers WHERE mobile=?').get(norm);
    if (dup) return res.status(409).json({ error: 'A customer with this phone already exists', id: dup.id });
  }
  const info = db.prepare(`INSERT INTO customers (first_name,last_name,mobile,email,birthday,notes)
    VALUES (?,?,?,?,?,?)`).run(first_name.trim(), last_name.trim(), norm, email.trim(), birthday.trim(), notes.trim());
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid));
});

app.put('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const fields = ['first_name', 'last_name', 'email', 'birthday', 'notes', 'status'];
  const next = { ...c };
  for (const f of fields) if (req.body[f] !== undefined) next[f] = String(req.body[f]).trim();
  if (req.body.mobile !== undefined) {
    const norm = normalizeMobile(req.body.mobile);
    if (norm) {
      const dup = db.prepare('SELECT id FROM customers WHERE mobile=? AND id != ?').get(norm, c.id);
      if (dup) return res.status(409).json({ error: 'Another customer already has this phone' });
    }
    next.mobile = norm;
  }
  db.prepare(`UPDATE customers SET first_name=?,last_name=?,mobile=?,email=?,birthday=?,notes=?,status=? WHERE id=?`)
    .run(next.first_name, next.last_name, next.mobile, next.email, next.birthday, next.notes, next.status, c.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(c.id));
});

// ---------- techs ----------
app.get('/api/techs', (req, res) => res.json(db.prepare('SELECT * FROM techs ORDER BY active DESC, name').all()));
app.post('/api/techs', (req, res) => {
  const { name, phone = '' } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO techs (name, phone) VALUES (?,?)').run(name.trim(), phone.trim());
  res.json(db.prepare('SELECT * FROM techs WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/techs/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM techs WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const next = { ...t, ...req.body };
  db.prepare('UPDATE techs SET name=?, phone=?, active=? WHERE id=?')
    .run(String(next.name).trim(), String(next.phone || ''), next.active ? 1 : 0, t.id);
  res.json(db.prepare('SELECT * FROM techs WHERE id=?').get(t.id));
});

// ---------- services ----------
app.get('/api/services', (req, res) => res.json(db.prepare('SELECT * FROM services ORDER BY active DESC, category, name').all()));
app.post('/api/services', (req, res) => {
  const { name, category = 'General', price = 0, duration_min = 30 } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const info = db.prepare('INSERT INTO services (name, category, price, duration_min) VALUES (?,?,?,?)')
    .run(name.trim(), category.trim() || 'General', Number(price) || 0, Number(duration_min) || 30);
  res.json(db.prepare('SELECT * FROM services WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/services/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const next = { ...s, ...req.body };
  db.prepare('UPDATE services SET name=?, category=?, price=?, duration_min=?, active=? WHERE id=?')
    .run(String(next.name).trim(), String(next.category).trim(), Number(next.price) || 0,
      Number(next.duration_min) || 30, next.active ? 1 : 0, s.id);
  res.json(db.prepare('SELECT * FROM services WHERE id=?').get(s.id));
});

// ---------- tickets ----------
app.get('/api/tickets', (req, res) => {
  const date = req.query.date || todayISO();
  const rows = db.prepare(`
    SELECT t.*, c.first_name AS customer_name, c.mobile AS customer_mobile, c.class AS customer_class,
      (SELECT GROUP_CONCAT(ti.name || CASE WHEN te.name IS NULL THEN '' ELSE ' ('||te.name||')' END, ', ')
         FROM ticket_items ti LEFT JOIN techs te ON te.id = ti.tech_id WHERE ti.ticket_id = t.id) AS items
    FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.status='open' OR date(COALESCE(t.closed_at, t.created_at)) = ?
    ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.created_at DESC`).all(date);
  res.json(rows);
});

app.get('/api/tickets/:id', (req, res) => {
  const t = db.prepare(`SELECT t.*, c.first_name AS customer_name, c.mobile AS customer_mobile,
      c.class AS customer_class, c.points_earned - c.points_redeemed AS customer_points
    FROM tickets t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  t.items = db.prepare(`SELECT ti.*, te.name AS tech_name FROM ticket_items ti
    LEFT JOIN techs te ON te.id=ti.tech_id WHERE ticket_id=?`).all(t.id);
  res.json(t);
});

app.post('/api/tickets', (req, res) => {
  const { customer_id = null } = req.body;
  const info = db.prepare('INSERT INTO tickets (customer_id) VALUES (?)').run(customer_id);
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/tickets/:id/items', (req, res) => {
  const t = db.prepare(`SELECT * FROM tickets WHERE id=? AND status='open'`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not open' });
  const { service_id = null, name, price, tech_id = null } = req.body;
  let itemName = name, itemPrice = Number(price);
  if (service_id) {
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(service_id);
    if (svc) { itemName = itemName || svc.name; if (isNaN(itemPrice)) itemPrice = svc.price; }
  }
  if (!itemName) return res.status(400).json({ error: 'Item name required' });
  db.prepare('INSERT INTO ticket_items (ticket_id, service_id, name, price, tech_id) VALUES (?,?,?,?,?)')
    .run(t.id, service_id, itemName, itemPrice || 0, tech_id);
  recalcTicket(t.id);
  res.json({ ok: true });
});

app.delete('/api/tickets/:id/items/:itemId', (req, res) => {
  db.prepare(`DELETE FROM ticket_items WHERE id=? AND ticket_id IN (SELECT id FROM tickets WHERE id=? AND status='open')`)
    .run(req.params.itemId, req.params.id);
  recalcTicket(req.params.id);
  res.json({ ok: true });
});

function recalcTicket(id) {
  const sub = db.prepare('SELECT COALESCE(SUM(price),0) s FROM ticket_items WHERE ticket_id=?').get(id).s;
  const t = db.prepare('SELECT discount, tip FROM tickets WHERE id=?').get(id);
  const total = Math.max(0, sub - (t ? t.discount : 0)) + (t ? t.tip : 0);
  db.prepare('UPDATE tickets SET subtotal=?, total=? WHERE id=?').run(sub, total, id);
}

app.put('/api/tickets/:id', (req, res) => {
  const t = db.prepare(`SELECT * FROM tickets WHERE id=? AND status='open'`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not open' });
  const { customer_id, discount, tip, notes } = req.body;
  db.prepare('UPDATE tickets SET customer_id=?, discount=?, tip=?, notes=? WHERE id=?').run(
    customer_id !== undefined ? customer_id : t.customer_id,
    discount !== undefined ? Number(discount) || 0 : t.discount,
    tip !== undefined ? Number(tip) || 0 : t.tip,
    notes !== undefined ? String(notes) : t.notes, t.id);
  recalcTicket(t.id);
  res.json(db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id));
});

app.post('/api/tickets/:id/checkout', (req, res) => {
  const t = db.prepare(`SELECT * FROM tickets WHERE id=? AND status='open'`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not open' });
  const { payment_method = 'cash', tip = 0, discount = 0, redeem_points = 0 } = req.body;
  const s = getSettings();

  const sub = db.prepare('SELECT COALESCE(SUM(price),0) s FROM ticket_items WHERE ticket_id=?').get(t.id).s;
  if (sub <= 0 && !req.body.force) return res.status(400).json({ error: 'Ticket has no items' });

  let pointsUsed = 0, pointsDiscount = 0;
  const cust = t.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(t.customer_id) : null;
  if (cust && Number(redeem_points) > 0) {
    const balance = cust.points_earned - cust.points_redeemed;
    // points may cover at most redeem_max_ticket_pct% of the ticket
    const maxDiscount = sub * (Number(s.redeem_max_ticket_pct || 50) / 100);
    const maxPoints = Math.floor(maxDiscount / Number(s.point_value_dollars));
    pointsUsed = Math.min(Number(redeem_points), balance, maxPoints);
    pointsDiscount = pointsUsed * Number(s.point_value_dollars);
  }
  const disc = (Number(discount) || 0) + pointsDiscount;
  const serviceTotal = Math.max(0, sub - disc);
  const total = serviceTotal + (Number(tip) || 0);

  const doCheckout = db.transaction(() => {
    db.prepare(`UPDATE tickets SET status='paid', closed_at=datetime('now','localtime'),
      subtotal=?, discount=?, tip=?, total=?, payment_method=?, points_used=? WHERE id=?`)
      .run(sub, disc, Number(tip) || 0, total, payment_method, pointsUsed, t.id);
    if (cust) {
      const earned = Math.floor(serviceTotal * Number(s.points_per_dollar));
      const nextCust = {
        visits: cust.visits + 1,
        lifetime_spend: cust.lifetime_spend + serviceTotal,
        points_earned: cust.points_earned + earned,
        points_redeemed: cust.points_redeemed + pointsUsed
      };
      const newClass = classify({ visits: nextCust.visits, lifetime_spend: nextCust.lifetime_spend }, s);
      db.prepare(`UPDATE customers SET visits=?, lifetime_spend=?, last_visit_date=?, last_visit_amount=?,
        points_earned=?, points_redeemed=?, class=? WHERE id=?`)
        .run(nextCust.visits, nextCust.lifetime_spend, todayISO(), serviceTotal,
          nextCust.points_earned, nextCust.points_redeemed, newClass, cust.id);
    }
  });
  doCheckout();
  res.json(db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id));
});

app.post('/api/tickets/:id/void', (req, res) => {
  const t = db.prepare(`SELECT * FROM tickets WHERE id=? AND status='open'`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Ticket not open' });
  db.prepare(`UPDATE tickets SET status='void', closed_at=datetime('now','localtime') WHERE id=?`).run(t.id);
  res.json({ ok: true });
});

// ---------- import ----------
app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = importZotaFile(req.file.path);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- reports ----------
app.get('/api/reports/revenue', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 29 * 86400000).toLocaleDateString('sv-SE');
  const to = req.query.to || todayISO();
  const byDay = db.prepare(`SELECT date(closed_at) d, SUM(total) total, SUM(tip) tip, COUNT(*) n
    FROM tickets WHERE status='paid' AND date(closed_at) BETWEEN ? AND ?
    GROUP BY date(closed_at) ORDER BY d`).all(from, to);
  const byTech = db.prepare(`SELECT COALESCE(te.name,'(unassigned)') tech, SUM(ti.price) revenue, COUNT(DISTINCT ti.ticket_id) tickets
    FROM ticket_items ti JOIN tickets t ON t.id=ti.ticket_id LEFT JOIN techs te ON te.id=ti.tech_id
    WHERE t.status='paid' AND date(t.closed_at) BETWEEN ? AND ?
    GROUP BY te.id ORDER BY revenue DESC`).all(from, to);
  const byService = db.prepare(`SELECT ti.name, COUNT(*) n, SUM(ti.price) revenue
    FROM ticket_items ti JOIN tickets t ON t.id=ti.ticket_id
    WHERE t.status='paid' AND date(t.closed_at) BETWEEN ? AND ?
    GROUP BY ti.name ORDER BY revenue DESC LIMIT 20`).all(from, to);
  const totals = db.prepare(`SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(tip),0) tip, COUNT(*) n
    FROM tickets WHERE status='paid' AND date(closed_at) BETWEEN ? AND ?`).get(from, to);
  res.json({ from, to, byDay, byTech, byService, totals });
});

app.get('/api/reports/customers.csv', (req, res) => {
  const rows = db.prepare(`SELECT first_name, mobile, email, birthday, class, status, visits,
    lifetime_spend, last_visit_date, last_visit_amount, points_earned, points_redeemed, notes
    FROM customers WHERE status != 'DELETED' ORDER BY lifetime_spend DESC`).all();
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = 'Name,Mobile,Email,Birthday,Class,Status,Visits,Lifetime Spend,Last Visit,Last Amount,Points Earned,Points Redeemed,Notes';
  const csv = [header, ...rows.map(r => [r.first_name, r.mobile, r.email, r.birthday, r.class, r.status,
    r.visits, r.lifetime_spend, r.last_visit_date, r.last_visit_amount, r.points_earned, r.points_redeemed, r.notes].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="customer_report.csv"');
  res.send(csv);
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(req.body)) upd.run(k, String(v));
  });
  tx();
  res.json(getSettings());
});

// Recompute every customer's class from current rules
app.post('/api/settings/reclassify', (req, res) => {
  const s = getSettings();
  const all = db.prepare(`SELECT id, visits, lifetime_spend, class FROM customers WHERE status='ACTIVE'`).all();
  const upd = db.prepare('UPDATE customers SET class=? WHERE id=?');
  let changed = 0;
  const tx = db.transaction(() => {
    for (const c of all) {
      const next = classify(c, s);
      if (next !== c.class) { upd.run(next, c.id); changed++; }
    }
  });
  tx();
  res.json({ changed, total: all.length });
});

app.listen(PORT, () => console.log(`Nail POS running at http://localhost:${PORT}`));
