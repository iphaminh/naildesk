const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'salon.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  mobile TEXT UNIQUE,
  email TEXT DEFAULT '',
  birthday TEXT DEFAULT '',           -- MM/DD
  class TEXT NOT NULL DEFAULT 'NEW',  -- NEW | LOYAL | VIP
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  notes TEXT DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 0,
  lifetime_spend REAL NOT NULL DEFAULT 0,
  last_visit_date TEXT DEFAULT '',    -- YYYY-MM-DD
  last_visit_amount REAL NOT NULL DEFAULT 0,
  points_earned REAL NOT NULL DEFAULT 0,
  points_redeemed REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS techs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  price REAL NOT NULL DEFAULT 0,
  duration_min INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'open',  -- open | paid | void
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  tip REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_method TEXT DEFAULT '',
  points_used REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ticket_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id),
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  tech_id INTEGER REFERENCES techs(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(mobile);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_items_ticket ON ticket_items(ticket_id);
`);

const DEFAULT_SETTINGS = {
  salon_name: 'My Nail Salon',
  loyal_min_visits: '3',
  vip_min_visits: '10',
  vip_min_spend: '400',
  points_per_dollar: '1',       // $1 spent = 1 point
  point_value_dollars: '0.05',  // 100 points = $5 off
  redeem_max_ticket_pct: '50',  // points can cover at most half a ticket
  checkin_bonus_points: '10',   // daily QR/kiosk check-in bonus, once per day
  birthday_bonus_points: '50',  // awarded once during birthday month (kiosk feature)
  atrisk_days: '45'             // VIP/LOYAL not seen in this many days = at risk
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

// Seed a starter service menu + techs only on a brand-new database
const svcCount = db.prepare('SELECT COUNT(*) n FROM services').get().n;
if (svcCount === 0) {
  const ins = db.prepare('INSERT INTO services (name, category, price, duration_min) VALUES (?, ?, ?, ?)');
  const seed = [
    ['Manicure', 'Nails', 25, 30],
    ['Gel Manicure', 'Nails', 40, 45],
    ['Pedicure', 'Nails', 35, 45],
    ['Deluxe Pedicure', 'Nails', 50, 60],
    ['Full Set Acrylic', 'Nails', 55, 60],
    ['Fill', 'Nails', 40, 45],
    ['Dip Powder', 'Nails', 45, 45],
    ['Nail Art (per nail)', 'Add-ons', 5, 10],
    ['Polish Change', 'Add-ons', 15, 15],
    ['Gel Removal', 'Add-ons', 10, 15],
    ['Eyebrow Wax', 'Waxing', 12, 15],
    ['Lip Wax', 'Waxing', 8, 10]
  ];
  for (const s of seed) ins.run(...s);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Classification rules (reverse-engineered from the Zota report, thresholds editable in Settings)
function classify(customer, s) {
  s = s || getSettings();
  if (customer.visits >= Number(s.vip_min_visits) || customer.lifetime_spend >= Number(s.vip_min_spend)) return 'VIP';
  if (customer.visits >= Number(s.loyal_min_visits)) return 'LOYAL';
  return 'NEW';
}

module.exports = { db, getSettings, classify };
