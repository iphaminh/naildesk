const XLSX = require('xlsx');
const { db, getSettings, classify } = require('../db');

// Parses a Zota "customer_report" export (.xlsx or .csv) and upserts customers by mobile.
// Zota layout: title/summary block on rows 1-5, header on row 6, data from row 7.
function normalizeMobile(m) {
  const digits = String(m || '').replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits || null;
}

function usDateToISO(d) {
  // "MM/DD/YYYY" -> "YYYY-MM-DD"
  const m = String(d || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function importZotaFile(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // Zota writes a stale <dimension> (e.g. A1:Z25) — recompute the real range from actual cells
  let range = { s: { r: Infinity, c: Infinity }, e: { r: 0, c: 0 } };
  for (const addr of Object.keys(sheet)) {
    if (addr[0] === '!') continue;
    const cell = XLSX.utils.decode_cell(addr);
    range.s.r = Math.min(range.s.r, cell.r); range.s.c = Math.min(range.s.c, cell.c);
    range.e.r = Math.max(range.e.r, cell.r); range.e.c = Math.max(range.e.c, cell.c);
  }
  if (range.s.r <= range.e.r) sheet['!ref'] = XLSX.utils.encode_range(range);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  // Find the header row (the one containing "Cust. First")
  let headerIdx = rows.findIndex(r => r.some(c => String(c).trim().toLowerCase().startsWith('cust. first')));
  if (headerIdx === -1) throw new Error('Not a Zota customer report: header row "Cust. First" not found');
  const header = rows[headerIdx].map(c => String(c).trim().toLowerCase());
  const col = name => header.findIndex(h => h.startsWith(name));
  const C = {
    first: col('cust. first'), mobile: col('cust. mobile'), birthday: col('birthday'),
    cls: col('class'), lastDate: col('last serv. date'), lastAmt: col('last serv. amount'),
    visits: col('no. of visit'), status: col('status'), spend: col('up-to-date'),
    unreturned: col('no. of days'), ptsEarned: col('point earned'), ptsRedeemed: col('point redeemed'),
    email: col('email'), remarks: col('remarks')
  };

  const settings = getSettings();
  const findByMobile = db.prepare('SELECT id FROM customers WHERE mobile = ?');
  const insert = db.prepare(`INSERT INTO customers
    (first_name, mobile, email, birthday, class, status, notes, visits, lifetime_spend,
     last_visit_date, last_visit_amount, points_earned, points_redeemed)
    VALUES (@first_name, @mobile, @email, @birthday, @class, @status, @notes, @visits, @lifetime_spend,
     @last_visit_date, @last_visit_amount, @points_earned, @points_redeemed)`);
  const update = db.prepare(`UPDATE customers SET
    first_name = @first_name, email = CASE WHEN @email != '' THEN @email ELSE email END,
    birthday = CASE WHEN @birthday != '' THEN @birthday ELSE birthday END,
    class = @class, visits = @visits, lifetime_spend = @lifetime_spend,
    last_visit_date = @last_visit_date, last_visit_amount = @last_visit_amount,
    points_earned = @points_earned, points_redeemed = @points_redeemed
    WHERE id = @id`);

  let added = 0, updated = 0, skipped = 0;
  const run = db.transaction(() => {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const name = String(r[C.first] || '').trim();
      const mobile = normalizeMobile(r[C.mobile]);
      if (!name && !mobile) { continue; }
      if (!mobile) { skipped++; continue; }

      const rec = {
        first_name: name,
        mobile,
        email: String(r[C.email] || '').trim(),
        birthday: String(r[C.birthday] || '').trim(),
        status: 'ACTIVE',
        notes: String(r[C.remarks] || '').trim(),
        visits: Math.round(Number(r[C.visits]) || 0),
        lifetime_spend: Number(r[C.spend]) || 0,
        last_visit_date: usDateToISO(r[C.lastDate]),
        last_visit_amount: Number(r[C.lastAmt]) || 0,
        points_earned: Number(r[C.ptsEarned]) || 0,
        points_redeemed: Number(r[C.ptsRedeemed]) || 0
      };
      // Keep Zota's class if ours would demote (their VIP may reflect history we can't see)
      const zotaClass = String(r[C.cls] || '').trim().toUpperCase();
      const computed = classify(rec, settings);
      const rank = { NEW: 0, LOYAL: 1, VIP: 2 };
      rec.class = (rank[zotaClass] || 0) > rank[computed] ? zotaClass : computed;

      const existing = findByMobile.get(mobile);
      if (existing) { rec.id = existing.id; update.run(rec); updated++; }
      else { insert.run(rec); added++; }
    }
  });
  run();
  return { added, updated, skipped };
}

module.exports = { importZotaFile, normalizeMobile };
