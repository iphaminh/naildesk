/* Dream Nails POS — admin SPA (cloud) */
const $main = document.getElementById('main');
const $modal = document.getElementById('modal-root');

const fmt$ = n => '$' + (Number(n) || 0).toFixed(2);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pin = () => localStorage.getItem('adminPin') || '';

async function api(url, opts = {}) {
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json', ...opts.headers };
    opts.body = JSON.stringify(opts.body);
  }
  opts.headers = { 'x-admin-pin': pin(), ...opts.headers };
  const r = await fetch(url, opts);
  if (r.status === 401) { showLock(); throw new Error('PIN required'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast-msg' + (err ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function modal(html) {
  $modal.innerHTML = `<div class="modal">${html}</div>`;
  $modal.onclick = e => { if (e.target === $modal) closeModal(); };
  return $modal.querySelector('.modal');
}
function closeModal() { $modal.innerHTML = ''; }


/* CSV download with the PIN in a header, never in the URL (URLs leak into
   history, referrers and proxy logs). */
async function downloadCsv(){
  try{
    const r = await fetch('/api/reports/customers.csv', { headers: { 'x-admin-pin': pin() } });
    if (!r.ok) return toast('Could not export — check your PIN', true);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'customer_report.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  }catch(e){ toast('Could not export', true); }
}


/* Secrets come back from the API as '__SET__' (never the real value). Show an
   empty box with a saved hint; leaving it empty keeps the stored key. */
const secretVal = v => (v === '__SET__' ? '' : (v || ''));
const secretPh = (v, ph) => (v === '__SET__' ? '•••••• saved — type to replace' : ph);

/* ---------- lock screen ---------- */
function showLock() {
  document.getElementById('lock').classList.remove('hidden');
  const inp = document.getElementById('pinInput');
  inp.value = '';
  inp.focus();
}
async function tryUnlock() {
  const val = document.getElementById('pinInput').value.trim();
  if (!val) return;
  try {
    const r = await fetch('/api/auth/check', { method: 'POST', headers: { 'x-admin-pin': val } });
    if (!r.ok) throw new Error();
    localStorage.setItem('adminPin', val);
    document.getElementById('lock').classList.add('hidden');
    navigate();
  } catch {
    document.getElementById('pinMsg').textContent = 'Wrong PIN, try again';
  }
}
document.getElementById('pinBtn').onclick = tryUnlock;
document.getElementById('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
document.getElementById('lockBtn').onclick = e => {
  e.preventDefault();
  localStorage.removeItem('adminPin');
  showLock();
};

/* ---------- router ---------- */
const pages = {};
function navigate() {
  const page = (location.hash || '#dashboard').slice(1).split('/')[0];
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  (pages[page] || pages.dashboard)();
}
window.addEventListener('hashchange', navigate);

/* ---------- dashboard ---------- */
pages.dashboard = async () => {
  const d = await api('/api/dashboard');
  document.getElementById('salonName').textContent = d.settings.salon_name || 'Nail POS';
  const cls = Object.fromEntries((d.classes || []).map(c => [c.class, c.n]));
  const maxDay = Math.max(1, ...(d.last30 || []).map(x => Number(x.total)));
  const appts = d.todayAppointments || [];
  $main.innerHTML = `
    <h1>Dashboard</h1>
    <div class="sub">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
    <div class="cards">
      <div class="card"><div class="label">Today's Revenue</div><div class="value">${fmt$(d.today.total)}</div><div class="hint">${d.today.n} tickets · ${fmt$(d.today.tip)} tips</div></div>
      <div class="card"><div class="label">This Month</div><div class="value">${fmt$(d.thisMonth.total)}</div><div class="hint">${d.thisMonth.n} tickets</div></div>
      <div class="card"><div class="label">Today's Appointments</div><div class="value">${appts.length}</div><div class="hint"><a class="link" href="#appointments">manage</a></div></div>
      <div class="card"><div class="label">Customers</div><div class="value">${d.totalCustomers}</div>
        <div class="hint"><span class="badge VIP">VIP ${cls.VIP || 0}</span> <span class="badge LOYAL">LOYAL ${cls.LOYAL || 0}</span> <span class="badge NEW">NEW ${cls.NEW || 0}</span></div></div>
    </div>
    ${appts.length ? `<div class="panel">
      <div class="panel-title">📅 Today's appointments</div>
      <table><thead><tr><th>Time</th><th>Client</th><th>Service</th><th>Status</th><th></th></tr></thead><tbody>
      ${appts.map(a => `<tr>
        <td><b>${esc(a.booking_time)}</b></td>
        <td>${esc(a.client_name)}<br><span class="muted">${esc(a.client_phone)}</span></td>
        <td class="muted">${esc(a.service)}</td>
        <td><span class="badge ${a.status === 'pending' ? 'open' : 'paid'}">${a.status}</span></td>
        <td class="num"><button class="small" data-start="${a.id}">Start ticket</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="panel">
      <div class="panel-title">Revenue — last 30 days</div>
      ${(d.last30 || []).length ? `<div class="bars">${d.last30.map(x =>
        `<div class="bar" style="height:${Math.round(Number(x.total) / maxDay * 100)}%" data-tip="${x.d}: ${fmt$(x.total)} (${x.n})"></div>`).join('')}</div>`
      : `<div class="empty">No paid tickets yet — revenue will show here after your first checkout.</div>`}
    </div>
    <div class="grid2">
      <div class="panel">
        <div class="panel-title">⚠️ At-risk regulars <span class="muted" style="font-weight:400">VIP/Loyal away &gt; ${d.settings.atrisk_days} days</span></div>
        ${(d.atRisk || []).length ? `<table><thead><tr><th>Customer</th><th>Class</th><th class="num">Days away</th><th class="num">Lifetime</th></tr></thead><tbody>
          ${d.atRisk.map(c => `<tr class="clickable" onclick="location.hash='#customers/${c.id}'">
            <td>${esc(c.first_name)}<br><span class="muted">${esc(c.mobile || '')}</span></td>
            <td><span class="badge ${c.class}">${c.class}</span></td>
            <td class="num"><span class="badge risk">${c.days_away}</span></td>
            <td class="num">${fmt$(c.lifetime_spend)}</td></tr>`).join('')}</tbody></table>
          <p class="muted" style="margin-top:10px;font-size:.8rem">💡 Your best customers who stopped coming. A quick text wins them back.</p>`
        : `<div class="empty">No at-risk regulars 🎉</div>`}
      </div>
      <div class="panel">
        <div class="panel-title">🎂 Birthdays this month</div>
        ${(d.birthdays || []).length ? `<table><thead><tr><th>Customer</th><th>Birthday</th><th>Class</th></tr></thead><tbody>
          ${d.birthdays.map(c => `<tr class="clickable" onclick="location.hash='#customers/${c.id}'">
            <td>${esc(c.first_name)}<br><span class="muted">${esc(c.mobile || '')}</span></td>
            <td>${esc(c.birthday)}</td><td><span class="badge ${c.class}">${c.class}</span></td></tr>`).join('')}</tbody></table>`
        : `<div class="empty">No birthdays on file this month.</div>`}
      </div>
    </div>`;
  $main.querySelectorAll('[data-start]').forEach(b => b.onclick = async () => {
    const r = await api(`/api/appointments/${b.dataset.start}/start-ticket`, { method: 'POST' });
    currentTicketId = r.ticket_id;
    location.hash = '#checkin';
  });
};

/* ---------- appointments ---------- */
pages.appointments = async () => {
  const date = (location.hash.split('/')[1] || '').trim();
  const list = await api('/api/appointments' + (date ? `?date=${date}` : ''));
  const byDate = {};
  for (const a of list) (byDate[a.booking_date] = byDate[a.booking_date] || []).push(a);
  $main.innerHTML = `
    <h1>Appointments</h1>
    <div class="sub">Bookings from your client page land here automatically. Confirm them, then start a ticket when the client arrives.</div>
    <div class="toolbar">
      <div class="field"><label>Jump to date</label><input type="date" id="apDate" value="${esc(date)}"></div>
      <button id="apAll">${date ? 'Show all upcoming' : 'Showing all upcoming'}</button>
      <a href="/" target="_blank"><button>Open booking page ↗</button></a>
    </div>
    ${Object.keys(byDate).length ? Object.entries(byDate).map(([day, appts]) => `
      <div class="panel">
        <div class="panel-title">${new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <table><thead><tr><th>Time</th><th>Client</th><th>Service</th><th>Notes</th><th>Status</th><th></th></tr></thead><tbody>
        ${appts.map(a => `<tr>
          <td><b>${esc(a.booking_time)}</b></td>
          <td>${esc(a.client_name)}<br><span class="muted">${esc(a.client_phone)}</span></td>
          <td class="muted">${esc(a.service)}${a.addons ? '<br>+ ' + esc(a.addons) : ''}${a.inspo_style ? '<br>🎨 ' + esc(a.inspo_style) : ''}</td>
          <td class="muted">${esc(a.notes || '')}${a.photo_url ? `<br><a class="link" href="${esc(a.photo_url)}" target="_blank">📷 inspo photo</a>` : ''}</td>
          <td><span class="badge ${a.status === 'pending' ? 'open' : a.status === 'cancelled' ? 'void' : 'paid'}">${a.status}</span></td>
          <td><div class="appt-actions">
            ${a.status === 'pending' ? `<button class="small" data-confirm="${a.id}">Confirm</button>` : ''}
            ${a.status !== 'cancelled' && a.status !== 'completed' ? `<button class="small" data-start="${a.id}">Start ticket</button>
            <button class="small danger" data-cancel="${a.id}">Cancel</button>` : ''}
          </div></td></tr>`).join('')}
        </tbody></table>
      </div>`).join('')
    : `<div class="panel"><div class="empty">No upcoming appointments yet. Share the booking page link with clients!</div></div>`}`;
  document.getElementById('apDate').onchange = e => { location.hash = '#appointments/' + e.target.value; };
  document.getElementById('apAll').onclick = () => { location.hash = '#appointments'; };
  $main.querySelectorAll('[data-confirm]').forEach(b => b.onclick = async () => {
    await api(`/api/appointments/${b.dataset.confirm}`, { method: 'PUT', body: { status: 'confirmed' } });
    pages.appointments();
  });
  $main.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel this appointment?')) return;
    await api(`/api/appointments/${b.dataset.cancel}`, { method: 'PUT', body: { status: 'cancelled' } });
    pages.appointments();
  });
  $main.querySelectorAll('[data-start]').forEach(b => b.onclick = async () => {
    const r = await api(`/api/appointments/${b.dataset.start}/start-ticket`, { method: 'POST' });
    currentTicketId = r.ticket_id;
    location.hash = '#checkin';
  });
};

/* ---------- check-in / sale (Square-style POS) ---------- */
let currentTicketId = null;
let posTechId = 0;   // tech chip currently "ringing up"
let posCat = null;   // active service category tab
let posSettings = null;

pages.checkin = async () => {
  const [tickets, services, techs, settings] = await Promise.all([
    api('/api/tickets'), api('/api/services'), api('/api/techs'), api('/api/settings')
  ]);
  posSettings = settings;
  const open = tickets.filter(t => t.status === 'open');
  const done = tickets.filter(t => t.status !== 'open');
  if (currentTicketId && !open.find(t => t.id === currentTicketId)) currentTicketId = null;
  if (!currentTicketId && open.length) currentTicketId = open[0].id;

  $main.innerHTML = `
    <h1>Check-In / Sale</h1>
    <div class="sub">Pick the tech, tap services, charge. Points, visits and rewards update automatically.</div>
    <div class="toolbar">
      <button class="gold" id="btnNewTicket">＋ New Ticket</button>
      ${open.map(t => `<button class="${t.id === currentTicketId ? 'primary' : ''}" data-tid="${t.id}">
        #${t.id} ${esc(t.customer_name || 'Walk-in')} · ${fmt$(t.subtotal)}</button>`).join('')}
    </div>
    <div id="ticketArea">${open.length ? '' : '<div class="panel"><div class="empty">No open tickets. Tap ＋ New Ticket to start a sale.</div></div>'}</div>
    <h2>Today's closed tickets</h2>
    <div class="panel">${done.length ? `<table><thead><tr><th>#</th><th>Customer</th><th>Services</th><th class="num">Total</th><th>Paid by</th><th>Status</th><th></th></tr></thead><tbody>
      ${done.map(t => `<tr><td>${t.id}</td><td>${esc(t.customer_name || 'Walk-in')}</td><td class="muted">${esc(t.items || '')}</td>
        <td class="num">${fmt$(t.total)}</td><td>${esc(t.payment_method || '')}</td><td><span class="badge ${t.status}">${t.status}</span></td>
        <td class="num">${t.status === 'paid' ? `<button class="small danger" data-refund="${t.id}">Refund</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No closed tickets today yet.</div>`}</div>`;

  document.getElementById('btnNewTicket').onclick = () => pickCustomerThen(async cust => {
    const t = await api('/api/tickets', { method: 'POST', body: { customer_id: cust ? cust.id : null } });
    currentTicketId = t.id;
    pages.checkin();
  });
  $main.querySelectorAll('[data-tid]').forEach(b => b.onclick = () => { currentTicketId = Number(b.dataset.tid); pages.checkin(); });
  $main.querySelectorAll('[data-refund]').forEach(b => b.onclick = async () => {
    if (!confirm(`Refund ticket #${b.dataset.refund}? This reverses the sale, the visit and all points it earned.`)) return;
    try {
      await api(`/api/tickets/${b.dataset.refund}/refund`, { method: 'POST' });
      toast(`Ticket #${b.dataset.refund} refunded`);
      pages.checkin();
    } catch (e) { toast(e.message, true); }
  });

  if (currentTicketId) renderTicket(currentTicketId, services, techs);
};

function techCanDo(tech, svc) {
  if (!tech) return true;
  return tech.all_services || (tech.service_ids || []).includes(svc.id);
}

async function renderTicket(id, services, techs) {
  const t = await api(`/api/tickets/${id}`);
  const area = document.getElementById('ticketArea');
  if (!area) return;
  const activeTechs = techs.filter(x => x.active);
  const activeSvcs = services.filter(s => s.active);
  const byCat = {};
  activeSvcs.forEach(s => (byCat[s.category] = byCat[s.category] || []).push(s));
  const cats = Object.keys(byCat);
  if (!posCat || !byCat[posCat]) posCat = cats[0];
  const curTech = activeTechs.find(x => x.id === posTechId) || null;
  if (posTechId && !curTech) posTechId = 0;

  area.innerHTML = `
    <div class="pos-grid">
      <div class="panel">
        <div class="tech-strip">
          <span class="lbl">Tech</span>
          <span class="tech-chip${!posTechId ? ' sel' : ''}" data-tech="0"><span class="ini">—</span>None</span>
          ${activeTechs.map(x => `<span class="tech-chip${x.id === posTechId ? ' sel' : ''}" data-tech="${x.id}">
            <span class="ini">${esc(x.name.slice(0, 2))}</span>${esc(x.name)}</span>`).join('')}
        </div>
        <div class="cat-tabs">
          ${cats.map(c => `<span class="cat-tab${c === posCat ? ' sel' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`).join('')}
        </div>
        <div class="tile-grid">
          ${byCat[posCat].map(s => {
            const ok = techCanDo(curTech, s);
            return `<button class="tile${ok ? '' : ' off'}" data-sid="${s.id}" ${ok ? '' : `data-off="${esc(curTech ? curTech.name : '')}"`}>
              <span>${esc(s.name)}</span><span class="tp">${fmt$(s.price)}</span></button>`;
          }).join('')}
        </div>
        <div class="row" style="margin-top:16px">
          <div class="field"><label>Custom item</label><input id="customName" placeholder="e.g. Design add-on"></div>
          <div class="field" style="max-width:110px"><label>Price</label><input id="customPrice" type="number" step="0.01" min="0"></div>
          <button id="btnCustom">Add</button>
        </div>
      </div>
      <div class="panel cart">
        <div class="panel-title">Ticket #${t.id}</div>
        <div class="cart-cust">
          ${t.customer_name
            ? `<span><b>${esc(t.customer_name)}</b> <span class="badge ${t.customer_class}">${t.customer_class}</span><br>
               <span class="muted" style="font-size:.78rem">${esc(t.customer_mobile || '')} · ${Number(t.customer_points || 0).toFixed(0)} pts</span></span>
               <a class="link" id="linkAttach" style="font-size:.8rem">change</a>`
            : `<span class="muted">Walk-in — no rewards</span><a class="link" id="linkAttach" style="font-size:.8rem">attach customer</a>`}
        </div>
        ${t.notes ? `<div class="muted" style="margin-bottom:8px;font-size:.82rem">📝 ${esc(t.notes)}</div>` : ''}
        <div id="lines">${t.items.length ? t.items.map(i => `
          <div class="cart-line"><span>${esc(i.name)}${i.tech_name ? `<span class="who"> · ${esc(i.tech_name)}</span>` : ''}</span>
          <span>${fmt$(i.price)} <span class="x" data-del="${i.id}">✕</span></span></div>`).join('')
        : `<div class="empty">Tap services to add them.</div>`}</div>
        <div style="margin-top:12px">
          <div class="row">
            <div class="field"><label>Discount $</label><input id="inDiscount" type="number" step="0.01" min="0" value="0"></div>
          </div>
          <div style="margin-top:10px">
            <div class="totals-line"><span>Subtotal</span><span id="tSub">${fmt$(t.subtotal)}</span></div>
            <div class="totals-line grand"><span>Total</span><span id="tTotal">${fmt$(t.subtotal)}</span></div>
          </div>
          <button class="charge-btn" id="btnCharge" ${t.items.length ? '' : 'disabled'}>Charge ${fmt$(t.subtotal)}</button>
          <div style="text-align:center;margin-top:10px"><a class="link" id="btnVoid" style="color:var(--red);font-size:.85rem">Void this ticket</a></div>
        </div>
      </div>
    </div>`;

  const recalc = () => {
    const disc = Number(area.querySelector('#inDiscount').value) || 0;
    const total = Math.max(0, Number(t.subtotal) - disc);
    area.querySelector('#tTotal').textContent = fmt$(total);
    const btn = area.querySelector('#btnCharge');
    btn.textContent = `Charge ${fmt$(total)}`;
  };
  area.querySelector('#inDiscount').oninput = recalc;

  area.querySelectorAll('[data-tech]').forEach(ch => ch.onclick = () => {
    posTechId = Number(ch.dataset.tech);
    renderTicket(id, services, techs);
  });
  area.querySelectorAll('[data-cat]').forEach(ch => ch.onclick = () => {
    posCat = ch.dataset.cat;
    renderTicket(id, services, techs);
  });
  area.querySelectorAll('[data-sid]').forEach(b => b.onclick = async () => {
    if (b.classList.contains('off')) {
      return toast(`${b.dataset.off} is not set up for this service — pick another tech`, true);
    }
    await api(`/api/tickets/${id}/items`, { method: 'POST', body: { service_id: Number(b.dataset.sid), tech_id: posTechId || null } });
    pages.checkin();
  });
  area.querySelector('#btnCustom').onclick = async () => {
    const name = area.querySelector('#customName').value.trim();
    const price = Number(area.querySelector('#customPrice').value);
    if (!name) return toast('Enter item name', true);
    await api(`/api/tickets/${id}/items`, { method: 'POST', body: { name, price, tech_id: posTechId || null } });
    pages.checkin();
  };
  area.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => {
    await api(`/api/tickets/${id}/items/${x.dataset.del}`, { method: 'DELETE' });
    pages.checkin();
  });
  const attach = area.querySelector('#linkAttach');
  if (attach) attach.onclick = () => pickCustomerThen(async cust => {
    if (cust) await api(`/api/tickets/${id}`, { method: 'PUT', body: { customer_id: cust.id } });
    pages.checkin();
  });
  area.querySelector('#btnCharge').onclick = () => {
    const disc = Number(area.querySelector('#inDiscount').value) || 0;
    chargeModal(t, disc);
  };
  area.querySelector('#btnVoid').onclick = async () => {
    if (!confirm('Void this ticket?')) return;
    await api(`/api/tickets/${t.id}/void`, { method: 'POST' });
    currentTicketId = null;
    pages.checkin();
  };
}

/* Square-style tender screen: tip → points → tap how they paid */
function chargeModal(t, discount) {
  const s = posSettings || {};
  const pointValue = Number(s.point_value_dollars || 0.05);
  const redeemCapPct = Number(s.redeem_max_ticket_pct || 50);
  const sub = Number(t.subtotal);
  const base = Math.max(0, sub - discount);
  const balance = Math.max(0, Math.floor(Number(t.customer_points || 0)));
  const maxByCap = Math.floor((base * redeemCapPct / 100) / pointValue);
  const maxRedeem = Math.min(balance, maxByCap);
  let tip = 0, tipSel = 'none', redeem = 0;

  const m = modal(`
    <h3>Charge — Ticket #${t.id}</h3>
    <div class="tender-total" id="chTotal"></div>
    <div class="tender-sub" id="chSub"></div>
    <label style="margin-top:6px">Tip</label>
    <div class="tip-row">
      <button class="tip-btn sel" data-tip="none">None</button>
      <button class="tip-btn" data-tip="15">15%<small>${fmt$(base * .15)}</small></button>
      <button class="tip-btn" data-tip="18">18%<small>${fmt$(base * .18)}</small></button>
      <button class="tip-btn" data-tip="20">20%<small>${fmt$(base * .20)}</small></button>
    </div>
    <div class="row"><div class="field"><label>Custom tip $</label><input id="chTipCustom" type="number" step="0.01" min="0" placeholder="0.00"></div></div>
    ${t.customer_id && maxRedeem > 0 ? `
      <div class="redeem-box">
        <label>Redeem points — ${balance} available (${fmt$(balance * pointValue)})</label>
        <div class="row">
          <div class="field" style="max-width:130px"><input id="chRedeem" type="number" step="1" min="0" max="${maxRedeem}" value="0"></div>
          <button class="small" id="chRedeemMax">Use max (${maxRedeem} pts = ${fmt$(maxRedeem * pointValue)})</button>
        </div>
      </div>` : ''}
    <label style="margin-top:14px">How did they pay?</label>
    <div class="tender-grid">
      <button class="tender-tile" data-pay="cash"><span>💵</span>Cash</button>
      <button class="tender-tile" data-pay="card"><span>💳</span>Card</button>
      <button class="tender-tile" data-pay="venmo"><span>📱</span>Venmo</button>
      <button class="tender-tile" data-pay="zelle"><span>🏦</span>Zelle</button>
    </div>
    <div class="actions"><button onclick="document.getElementById('modal-root').innerHTML=''">Cancel</button></div>`);

  const refresh = () => {
    const ptsOff = redeem * pointValue;
    const total = Math.max(0, base - ptsOff) + tip;
    m.querySelector('#chTotal').textContent = fmt$(total);
    m.querySelector('#chSub').textContent =
      `${fmt$(sub)} services` +
      (discount ? ` − ${fmt$(discount)} discount` : '') +
      (ptsOff ? ` − ${fmt$(ptsOff)} points (${redeem})` : '') +
      (tip ? ` + ${fmt$(tip)} tip` : '');
  };
  m.querySelectorAll('[data-tip]').forEach(b => b.onclick = () => {
    m.querySelectorAll('[data-tip]').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    tipSel = b.dataset.tip;
    m.querySelector('#chTipCustom').value = '';
    tip = tipSel === 'none' ? 0 : +(base * Number(tipSel) / 100).toFixed(2);
    refresh();
  });
  m.querySelector('#chTipCustom').oninput = e => {
    m.querySelectorAll('[data-tip]').forEach(x => x.classList.remove('sel'));
    tip = Number(e.target.value) || 0;
    refresh();
  };
  const red = m.querySelector('#chRedeem');
  if (red) {
    red.oninput = () => { redeem = Math.min(maxRedeem, Math.max(0, Math.floor(Number(red.value) || 0))); refresh(); };
    m.querySelector('#chRedeemMax').onclick = () => { red.value = maxRedeem; redeem = maxRedeem; refresh(); };
  }
  m.querySelectorAll('[data-pay]').forEach(b => b.onclick = async () => {
    try {
      m.querySelectorAll('[data-pay]').forEach(x => x.disabled = true);
      const done = await api(`/api/tickets/${t.id}/checkout`, {
        method: 'POST',
        body: { payment_method: b.dataset.pay, discount, tip, redeem_points: redeem }
      });
      closeModal();
      currentTicketId = null;
      toast(`Ticket #${t.id} paid — ${fmt$(done.total)}`);
      if (done.milestone || done.referral) celebrationModal(done);
      pages.checkin();
    } catch (e) {
      m.querySelectorAll('[data-pay]').forEach(x => x.disabled = false);
      toast(e.message, true);
    }
  });
  refresh();
}

function celebrationModal(done) {
  const bits = [];
  if (done.milestone) {
    bits.push(`<div class="big">🏆</div><h3>${done.milestone.visit}th visit!</h3>
      <p>+${done.milestone.points} bonus points added — tell them thank you for being a regular.</p>`);
  }
  if (done.referral) {
    bits.push(`<div class="big">🤝</div><h3>Referral reward</h3>
      <p>${done.referral.referrer_name ? esc(done.referral.referrer_name) + ' earned' : 'Their friend earned'} +${done.referral.referrer_points} points for the referral${done.referral.welcome_points ? `, and this client got +${done.referral.welcome_points} welcome points` : ''}.</p>`);
  }
  const m = modal(`<div class="celebrate">${bits.join('<hr style="border:none;border-top:1px solid var(--line);margin:14px 0">')}
    <div class="actions" style="justify-content:center"><button class="gold" onclick="document.getElementById('modal-root').innerHTML=''">Nice!</button></div></div>`);
}

/* customer picker */
function pickCustomerThen(cb) {
  const m = modal(`
    <h3>Who is this ticket for?</h3>
    <input type="search" id="pickSearch" placeholder="Search name or phone…" style="width:100%">
    <div id="pickResults" style="max-height:280px;overflow:auto;margin-top:10px"></div>
    <div class="actions">
      <button id="pickWalkin">Walk-in (no customer)</button>
      <button class="primary" id="pickNew">＋ New customer</button>
    </div>`);
  const results = m.querySelector('#pickResults');
  const search = m.querySelector('#pickSearch');
  let timer;
  const doSearch = async () => {
    const qq = search.value.trim();
    const d = await api(`/api/customers?search=${encodeURIComponent(qq)}&limit=15&sort=${qq ? 'name' : 'recent'}`);
    results.innerHTML = d.rows.length ? `<table><tbody>${d.rows.map(c => `
      <tr class="clickable" data-cid="${c.id}"><td>${esc(c.first_name)}<br><span class="muted">${esc(c.mobile || '')}</span></td>
      <td><span class="badge ${c.class}">${c.class}</span></td>
      <td class="num muted">${c.visits} visits</td></tr>`).join('')}</tbody></table>`
      : `<div class="empty">No matches.</div>`;
    results.querySelectorAll('[data-cid]').forEach(r => r.onclick = async () => {
      const c = d.rows.find(x => x.id === Number(r.dataset.cid));
      closeModal(); cb(c);
    });
  };
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 250); };
  doSearch();
  search.focus();
  m.querySelector('#pickWalkin').onclick = () => { closeModal(); cb(null); };
  m.querySelector('#pickNew').onclick = () => { closeModal(); customerForm(null, c => cb(c)); };
}

/* ---------- customers ---------- */
let custState = { search: '', cls: '', sort: 'recent', offset: 0 };
pages.customers = async () => {
  const detailId = (location.hash.split('/')[1] || '').trim();
  if (detailId) return customerDetail(detailId);
  const { search, cls, sort, offset } = custState;
  const d = await api(`/api/customers?search=${encodeURIComponent(search)}&cls=${cls}&sort=${sort}&limit=50&offset=${offset}`);
  $main.innerHTML = `
    <h1>Customers</h1>
    <div class="sub">${d.total} customers · click any row for full history</div>
    <div class="toolbar">
      <input type="search" id="cSearch" placeholder="Search name, phone, email…" value="${esc(search)}">
      <select id="cClass">
        <option value="">All classes</option>
        ${['VIP', 'LOYAL', 'NEW'].map(c => `<option ${cls === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <select id="cSort">
        <option value="recent" ${sort === 'recent' ? 'selected' : ''}>Recent visit</option>
        <option value="name" ${sort === 'name' ? 'selected' : ''}>Name</option>
        <option value="spend" ${sort === 'spend' ? 'selected' : ''}>Top spenders</option>
        <option value="visits" ${sort === 'visits' ? 'selected' : ''}>Most visits</option>
        <option value="away" ${sort === 'away' ? 'selected' : ''}>Longest away</option>
      </select>
      <button class="primary" id="cAdd">＋ Add customer</button>
      <button onclick="downloadCsv()">⬇ Export CSV</button>
    </div>
    <div class="panel">
      <table><thead><tr><th>Customer</th><th>Class</th><th class="num">Visits</th><th class="num">Lifetime</th><th>Last visit</th><th class="num">Days away</th><th class="num">Points</th></tr></thead>
      <tbody>${d.rows.map(c => `<tr class="clickable" onclick="location.hash='#customers/${c.id}'">
        <td>${esc(c.first_name)} ${esc(c.last_name)}<br><span class="muted">${esc(c.mobile || '')}</span></td>
        <td><span class="badge ${c.class}">${c.class}</span></td>
        <td class="num">${c.visits}</td>
        <td class="num">${fmt$(c.lifetime_spend)}</td>
        <td>${c.last_visit_date || '<span class="muted">—</span>'}</td>
        <td class="num">${c.days_away == null ? '<span class="muted">—</span>' : c.days_away}</td>
        <td class="num">${(Number(c.points_earned) - Number(c.points_redeemed)).toFixed(0)}</td></tr>`).join('')}</tbody></table>
      <div class="pager">
        <span>${offset + 1}–${Math.min(offset + 50, d.total)} of ${d.total}</span>
        <button class="small" id="pgPrev" ${offset === 0 ? 'disabled' : ''}>‹ Prev</button>
        <button class="small" id="pgNext" ${offset + 50 >= d.total ? 'disabled' : ''}>Next ›</button>
      </div>
    </div>`;
  let timer;
  document.getElementById('cSearch').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { custState.search = e.target.value; custState.offset = 0; pages.customers(); }, 300); };
  document.getElementById('cClass').onchange = e => { custState.cls = e.target.value; custState.offset = 0; pages.customers(); };
  document.getElementById('cSort').onchange = e => { custState.sort = e.target.value; custState.offset = 0; pages.customers(); };
  document.getElementById('cAdd').onclick = () => customerForm(null, () => pages.customers());
  document.getElementById('pgPrev').onclick = () => { custState.offset = Math.max(0, offset - 50); pages.customers(); };
  document.getElementById('pgNext').onclick = () => { custState.offset = offset + 50; pages.customers(); };
};

async function customerDetail(id) {
  const c = await api(`/api/customers/${id}`);
  $main.innerHTML = `
    <div class="toolbar"><button onclick="location.hash='#customers'">‹ All customers</button>
      <button class="primary" id="btnEdit">✏️ Edit</button>
      <button id="btnStartTicket">🛎️ Start ticket</button></div>
    <h1>${esc(c.first_name)} ${esc(c.last_name)} <span class="badge ${c.class}">${c.class}</span></h1>
    <div class="sub">${esc(c.mobile || 'no phone')} ${c.email ? '· ' + esc(c.email) : ''} ${c.birthday ? '· 🎂 ' + esc(c.birthday) : ''}</div>
    <div class="cards">
      <div class="card"><div class="label">Visits</div><div class="value">${c.visits}</div></div>
      <div class="card"><div class="label">Lifetime Spend</div><div class="value">${fmt$(c.lifetime_spend)}</div></div>
      <div class="card"><div class="label">Last Visit</div><div class="value" style="font-size:1.1rem">${c.last_visit_date || '—'}</div><div class="hint">${fmt$(c.last_visit_amount)}</div></div>
      <div class="card"><div class="label">Points</div><div class="value">${Number(c.points_balance).toFixed(0)}</div><div class="hint">≈ ${fmt$(c.points_balance * c.point_value)} value</div></div>
    </div>
    ${c.notes ? `<div class="panel"><div class="panel-title">Notes</div>${esc(c.notes)}</div>` : ''}
    <div class="panel">
      <div class="panel-title">Visit history (in this system)</div>
      ${c.tickets.length ? `<table><thead><tr><th>Date</th><th>Services</th><th class="num">Total</th><th>Paid by</th><th>Status</th></tr></thead><tbody>
        ${c.tickets.map(t => `<tr><td>${(t.closed_at || t.created_at).slice(0, 16).replace('T', ' ')}</td><td class="muted">${esc(t.items || '')}</td>
        <td class="num">${fmt$(t.total)}</td><td>${esc(t.payment_method || '')}</td><td><span class="badge ${t.status}">${t.status}</span></td></tr>`).join('')}</tbody></table>`
      : `<div class="empty">No tickets yet — history from Zota shows in the stats above; new visits appear here.</div>`}
    </div>`;
  document.getElementById('btnEdit').onclick = () => customerForm(c, () => customerDetail(id));
  document.getElementById('btnStartTicket').onclick = async () => {
    const t = await api('/api/tickets', { method: 'POST', body: { customer_id: c.id } });
    currentTicketId = t.id;
    location.hash = '#checkin';
  };
}

function customerForm(c, done) {
  const m = modal(`
    <h3>${c ? 'Edit customer' : 'New customer'}</h3>
    <div class="row" style="margin-bottom:12px">
      <div class="field"><label>First name *</label><input id="fFirst" value="${esc(c?.first_name || '')}"></div>
      <div class="field"><label>Last name</label><input id="fLast" value="${esc(c?.last_name || '')}"></div>
    </div>
    <div class="row" style="margin-bottom:12px">
      <div class="field"><label>Mobile</label><input id="fMobile" value="${esc(c?.mobile || '')}" placeholder="555-123-4567"></div>
      <div class="field"><label>Birthday (MM/DD)</label><input id="fBday" value="${esc(c?.birthday || '')}" placeholder="04/15"></div>
    </div>
    <div class="field"><label>Email</label><input id="fEmail" value="${esc(c?.email || '')}" style="width:100%"></div>
    <div class="field"><label>Notes (allergies, preferences, favorite colors…)</label><textarea id="fNotes" rows="3" style="width:100%">${esc(c?.notes || '')}</textarea></div>
    <div class="actions">
      <button onclick="document.getElementById('modal-root').innerHTML=''">Cancel</button>
      <button class="primary" id="fSave">Save</button>
    </div>`);
  m.querySelector('#fSave').onclick = async () => {
    const body = {
      first_name: m.querySelector('#fFirst').value, last_name: m.querySelector('#fLast').value,
      mobile: m.querySelector('#fMobile').value, birthday: m.querySelector('#fBday').value,
      email: m.querySelector('#fEmail').value, notes: m.querySelector('#fNotes').value
    };
    try {
      const saved = c
        ? await api(`/api/customers/${c.id}`, { method: 'PUT', body })
        : await api('/api/customers', { method: 'POST', body });
      closeModal();
      toast('Customer saved');
      done(saved);
    } catch (e) { toast(e.message, true); }
  };
  m.querySelector('#fFirst').focus();
}

/* ---------- services ---------- */
pages.services = async () => {
  const list = await api('/api/services');
  $main.innerHTML = `
    <h1>Services</h1>
    <div class="sub">Your menu — shows on the check-in screen and the client booking page.</div>
    <div class="toolbar"><button class="primary" id="sAdd">＋ Add service</button></div>
    <div class="panel"><table><thead><tr><th>Service</th><th>Category</th><th class="num">Price</th><th class="num">Minutes</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(s => `<tr>
      <td>${esc(s.name)}</td><td>${esc(s.category)}</td><td class="num">${fmt$(s.price)}</td><td class="num">${s.duration_min}</td>
      <td>${s.active ? '<span class="badge paid">active</span>' : '<span class="badge void">hidden</span>'}</td>
      <td class="num"><button class="small" data-edit="${s.id}">Edit</button>
          <button class="small" data-tog="${s.id}">${s.active ? 'Hide' : 'Show'}</button></td></tr>`).join('')}</tbody></table></div>`;
  const form = (s) => {
    const m = modal(`
      <h3>${s ? 'Edit service' : 'New service'}</h3>
      <div class="field"><label>Name *</label><input id="svName" value="${esc(s?.name || '')}" style="width:100%"></div>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Category</label><input id="svCat" value="${esc(s?.category || 'Nails')}"></div>
        <div class="field"><label>Price $</label><input id="svPrice" type="number" step="0.01" value="${s?.price ?? ''}"></div>
        <div class="field"><label>Minutes</label><input id="svMin" type="number" value="${s?.duration_min ?? 30}"></div>
      </div>
      <div class="field"><label>Short description (shows on the booking page)</label><input id="svDesc" value="${esc(s?.description || '')}" style="width:100%"></div>
      <div class="actions"><button onclick="document.getElementById('modal-root').innerHTML=''">Cancel</button>
        <button class="primary" id="svSave">Save</button></div>`);
    m.querySelector('#svSave').onclick = async () => {
      const body = { name: m.querySelector('#svName').value, category: m.querySelector('#svCat').value,
        price: m.querySelector('#svPrice').value, duration_min: m.querySelector('#svMin').value,
        description: m.querySelector('#svDesc').value };
      try {
        if (s) await api(`/api/services/${s.id}`, { method: 'PUT', body });
        else await api('/api/services', { method: 'POST', body });
        closeModal(); pages.services();
      } catch (e) { toast(e.message, true); }
    };
  };
  document.getElementById('sAdd').onclick = () => form(null);
  $main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(list.find(x => x.id === Number(b.dataset.edit))));
  $main.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => {
    const s = list.find(x => x.id === Number(b.dataset.tog));
    await api(`/api/services/${s.id}`, { method: 'PUT', body: { active: !s.active } });
    pages.services();
  });
};

/* ---------- techs (with per-service skills) ---------- */
pages.techs = async () => {
  const [list, services] = await Promise.all([api('/api/techs'), api('/api/services')]);
  const activeSvcCount = services.filter(s => s.active).length;
  const skillsLabel = t => {
    if (t.all_services) return '<span class="badge paid">all services</span>';
    const n = (t.service_ids || []).length;
    return `<span class="badge open">${n} of ${services.length} services</span>`;
  };
  $main.innerHTML = `
    <h1>Techs</h1>
    <div class="sub">Your team and what each person can do. NailBook only offers clients the techs qualified for the service they picked — the same rules apply on the check-in screen.</div>
    <div class="toolbar"><button class="gold" id="tAdd">＋ Add tech</button></div>
    <div class="panel">${list.length ? `<table><thead><tr><th>Name</th><th>Phone</th><th>Skills</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(t => `<tr>
        <td><b>${esc(t.name)}</b></td><td>${esc(t.phone || '')}</td>
        <td>${skillsLabel(t)}</td>
        <td>${t.active ? '<span class="badge paid">active</span>' : '<span class="badge void">inactive</span>'}</td>
        <td class="num">
          <button class="small" data-edit="${t.id}">Edit skills</button>
          <button class="small" data-tog="${t.id}">${t.active ? 'Deactivate' : 'Activate'}</button>
        </td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">No techs yet — add your team above.</div>`}</div>`;
  document.getElementById('tAdd').onclick = () => techForm(null, services, () => pages.techs());
  $main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () =>
    techForm(list.find(x => x.id === Number(b.dataset.edit)), services, () => pages.techs()));
  $main.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => {
    const t = list.find(x => x.id === Number(b.dataset.tog));
    await api(`/api/techs/${t.id}`, { method: 'PUT', body: { active: !t.active } });
    pages.techs();
  });
};

function techForm(t, services, done) {
  const byCat = {};
  services.forEach(s => (byCat[s.category] = byCat[s.category] || []).push(s));
  const selected = new Set(t && !t.all_services ? (t.service_ids || []) : []);
  const allSvc = t ? !!t.all_services : true;

  const m = modal(`
    <h3>${t ? `Edit ${esc(t.name)}` : 'New tech'}</h3>
    <div class="row" style="margin-bottom:12px">
      <div class="field"><label>Name *</label><input id="tfName" value="${esc(t?.name || '')}"></div>
      <div class="field"><label>Phone</label><input id="tfPhone" value="${esc(t?.phone || '')}"></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:.9rem;color:var(--ink);margin-bottom:10px;cursor:pointer">
      <input type="checkbox" id="tfAll" ${allSvc ? 'checked' : ''} style="width:17px;height:17px;accent-color:var(--gold-deep)">
      Can perform <b>every</b> service (current and future)
    </label>
    <div id="tfSkills" class="${allSvc ? 'hidden' : ''}">
      <p class="muted" style="font-size:.8rem;margin-bottom:8px">Check what this tech can do. Unchecked services never show for them in booking or check-in.</p>
      ${Object.entries(byCat).map(([cat, svcs]) => `
        <div class="skill-cat">
          <div class="skill-cat-head">
            <input type="checkbox" class="catAll" data-cat="${esc(cat)}">
            ${esc(cat)}
            <span class="count" data-count="${esc(cat)}"></span>
          </div>
          <div class="skill-list">
            ${svcs.map(s => `<label class="skill-item">
              <input type="checkbox" class="svcChk" data-cat="${esc(cat)}" value="${s.id}" ${selected.has(s.id) ? 'checked' : ''}>
              ${esc(s.name)}${s.active ? '' : ' <span class="muted">(hidden)</span>'}</label>`).join('')}
          </div>
        </div>`).join('')}
    </div>
    <div class="actions">
      <button onclick="document.getElementById('modal-root').innerHTML=''">Cancel</button>
      <button class="primary" id="tfSave">Save</button>
    </div>`);

  const syncHeads = () => {
    Object.keys(byCat).forEach(cat => {
      const boxes = [...m.querySelectorAll(`.svcChk[data-cat="${CSS.escape(cat)}"]`)];
      const on = boxes.filter(b => b.checked).length;
      const head = m.querySelector(`.catAll[data-cat="${CSS.escape(cat)}"]`);
      head.checked = on === boxes.length;
      head.indeterminate = on > 0 && on < boxes.length;
      m.querySelector(`[data-count="${CSS.escape(cat)}"]`).textContent = `${on}/${boxes.length}`;
    });
  };
  m.querySelector('#tfAll').onchange = e => {
    m.querySelector('#tfSkills').classList.toggle('hidden', e.target.checked);
  };
  m.querySelectorAll('.catAll').forEach(h => h.onchange = () => {
    m.querySelectorAll(`.svcChk[data-cat="${CSS.escape(h.dataset.cat)}"]`).forEach(b => { b.checked = h.checked; });
    syncHeads();
  });
  m.querySelectorAll('.svcChk').forEach(b => b.onchange = syncHeads);
  syncHeads();

  m.querySelector('#tfSave').onclick = async () => {
    const name = m.querySelector('#tfName').value.trim();
    if (!name) return toast('Enter a name', true);
    const all = m.querySelector('#tfAll').checked;
    const ids = all ? [] : [...m.querySelectorAll('.svcChk')].filter(b => b.checked).map(b => Number(b.value));
    if (!all && !ids.length) return toast('Pick at least one service, or check "every service"', true);
    const body = { name, phone: m.querySelector('#tfPhone').value, all_services: all, service_ids: ids };
    try {
      if (t) await api(`/api/techs/${t.id}`, { method: 'PUT', body });
      else await api('/api/techs', { method: 'POST', body });
      closeModal();
      toast(`${name} saved`);
      done();
    } catch (e) { toast(e.message, true); }
  };
  m.querySelector('#tfName').focus();
}

/* ---------- NailMind credits ---------- */
let nmSearch = '';
pages.nailmind = async () => {
  if (!posSettings) posSettings = await api('/api/settings').catch(() => null);
  const accounts = await api(`/api/nailmind/accounts?search=${encodeURIComponent(nmSearch)}`).catch(e => null);
  if (accounts === null) {
    $main.innerHTML = `<h1>NailMind credits</h1>
      <div class="panel"><div class="empty">Credit accounts are not set up yet — run the NailMind credits migration in Supabase first (cloud/migrations/nailmind_credits.sql).</div></div>`;
    return;
  }
  $main.innerHTML = `
    <h1>NailMind credits</h1>
    <div class="sub">Sell design credits at the front desk. 1 credit = 1 AI generation. Clients sign in on NailMind with their phone number.</div>
    <div class="toolbar">
      <input type="search" id="nmQ" placeholder="Search phone or name…" value="${esc(nmSearch)}">
      <button class="gold" id="nmSell">＋ Sell / grant credits</button>
    </div>
    <div class="panel">${accounts.length ? `<table><thead><tr><th>Phone</th><th>Name</th><th class="num">Credits</th><th>Member since</th><th></th></tr></thead>
      <tbody>${accounts.map(a => `<tr>
        <td><b>${esc(a.phone)}</b></td><td>${esc(a.name || '')}</td>
        <td class="num"><span class="badge ${Number(a.credits) > 0 ? 'paid' : 'open'}">${Number(a.credits)}</span></td>
        <td class="muted">${String(a.created_at).slice(0, 10)}</td>
        <td class="num">
          <button class="small" data-sell="${esc(a.phone)}">Sell credits</button>
          <button class="small" data-ledger="${a.id}" data-phone="${esc(a.phone)}">History</button>
        </td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">No NailMind members yet. When a client signs in on the NailMind page, they appear here.</div>`}</div>`;
  let timer;
  document.getElementById('nmQ').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { nmSearch = e.target.value; pages.nailmind(); }, 300); };
  document.getElementById('nmSell').onclick = () => nmSellForm('');
  $main.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => nmSellForm(b.dataset.sell));
  $main.querySelectorAll('[data-ledger]').forEach(b => b.onclick = async () => {
    const rows = await api(`/api/nailmind/accounts/${b.dataset.ledger}/ledger`);
    modal(`<h3>Credit history — ${esc(b.dataset.phone)}</h3>
      ${rows.length ? `<table><thead><tr><th>When</th><th>What</th><th class="num">Credits</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td class="muted">${String(r.created_at).slice(0, 16).replace('T', ' ')}</td>
          <td>${esc(r.reason)}${r.ref ? ` <span class="muted">· ${esc(r.ref)}</span>` : ''}</td>
          <td class="num" style="color:${Number(r.delta) >= 0 ? 'var(--green)' : 'var(--red)'}">${Number(r.delta) >= 0 ? '+' : ''}${Number(r.delta)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">No activity yet.</div>'}
      <div class="actions"><button onclick="document.getElementById('modal-root').innerHTML=''">Close</button></div>`);
  });
};

function nmSellForm(phone) {
  const packs = String(posSettings?.nailmind_packs || '10:5,25:10,60:20').split(',').map(p => p.split(':').map(Number));
  const m = modal(`
    <h3>Sell / grant NailMind credits</h3>
    <p class="muted" style="font-size:.85rem;margin-bottom:12px">Take payment in the POS as usual (custom item "NailMind credits"), then add the credits here.</p>
    <div class="row" style="margin-bottom:12px">
      <div class="field"><label>Client phone *</label><input id="nmsPhone" type="tel" value="${esc(phone)}" placeholder="707-555-1234"></div>
      <div class="field" style="max-width:120px"><label>Credits *</label><input id="nmsCredits" type="number" step="1"></div>
    </div>
    <div class="row" style="margin-bottom:12px">
      ${packs.map(([c, d]) => c > 0 ? `<button class="small" data-pk="${c}" data-pd="${d}">${c} for $${d}</button>` : '').join('')}
    </div>
    <div class="field"><label>Note (optional)</label><input id="nmsNote" placeholder="e.g. paid cash, ticket #12" style="width:100%"></div>
    <div class="actions">
      <button onclick="document.getElementById('modal-root').innerHTML=''">Cancel</button>
      <button class="primary" id="nmsGo">Add credits</button>
    </div>`);
  m.querySelectorAll('[data-pk]').forEach(b => b.onclick = () => {
    m.querySelector('#nmsCredits').value = b.dataset.pk;
    if (!m.querySelector('#nmsNote').value) m.querySelector('#nmsNote').value = `$${b.dataset.pd} pack`;
  });
  m.querySelector('#nmsGo').onclick = async () => {
    try {
      const r = await api('/api/nailmind/credits/grant', { method: 'POST', body: {
        phone: m.querySelector('#nmsPhone').value,
        credits: m.querySelector('#nmsCredits').value,
        note: m.querySelector('#nmsNote').value
      } });
      closeModal();
      toast(`${r.phone} now has ${r.credits} credits`);
      if (pages.nailmind) pages.nailmind();
    } catch (e) { toast(e.message, true); }
  };
  m.querySelector(phone ? '#nmsCredits' : '#nmsPhone').focus();
}

/* ---------- reports ---------- */
pages.reports = async () => {
  const to = new Date().toLocaleDateString('sv-SE');
  const from = new Date(Date.now() - 29 * 86400000).toLocaleDateString('sv-SE');
  $main.innerHTML = `
    <h1>Reports</h1>
    <div class="sub">Revenue, tech performance, and top services for any date range.</div>
    <div class="toolbar">
      <div class="field"><label>From</label><input type="date" id="rFrom" value="${from}"></div>
      <div class="field"><label>To</label><input type="date" id="rTo" value="${to}"></div>
      <button class="primary" id="rRun">Run</button>
      <button onclick="downloadCsv()">⬇ Customer report CSV</button>
    </div>
    <div id="rOut"></div>`;
  const run = async () => {
    const f = document.getElementById('rFrom').value, t = document.getElementById('rTo').value;
    const d = await api(`/api/reports/revenue?from=${f}&to=${t}`);
    const maxDay = Math.max(1, ...d.byDay.map(x => Number(x.total)));
    document.getElementById('rOut').innerHTML = `
      <div class="cards">
        <div class="card"><div class="label">Revenue</div><div class="value">${fmt$(d.totals.total)}</div></div>
        <div class="card"><div class="label">Tips</div><div class="value">${fmt$(d.totals.tip)}</div></div>
        <div class="card"><div class="label">Tickets</div><div class="value">${d.totals.n}</div></div>
        <div class="card"><div class="label">Avg ticket</div><div class="value">${fmt$(d.totals.n ? d.totals.total / d.totals.n : 0)}</div></div>
      </div>
      <div class="panel"><div class="panel-title">By day</div>
        ${d.byDay.length ? `<div class="bars">${d.byDay.map(x => `<div class="bar" style="height:${Math.round(Number(x.total) / maxDay * 100)}%" data-tip="${x.d}: ${fmt$(x.total)}"></div>`).join('')}</div>` : '<div class="empty">No paid tickets in range.</div>'}</div>
      <div class="grid2">
        <div class="panel"><div class="panel-title">By tech</div>
          ${d.byTech.length ? `<table><thead><tr><th>Tech</th><th class="num">Tickets</th><th class="num">Service revenue</th></tr></thead>
          <tbody>${d.byTech.map(x => `<tr><td>${esc(x.tech)}</td><td class="num">${x.tickets}</td><td class="num">${fmt$(x.revenue)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No data.</div>'}</div>
        <div class="panel"><div class="panel-title">Top services</div>
          ${d.byService.length ? `<table><thead><tr><th>Service</th><th class="num">Count</th><th class="num">Revenue</th></tr></thead>
          <tbody>${d.byService.map(x => `<tr><td>${esc(x.name)}</td><td class="num">${x.n}</td><td class="num">${fmt$(x.revenue)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No data.</div>'}</div>
      </div>`;
  };
  document.getElementById('rRun').onclick = run;
  run();
};

/* ---------- import ---------- */
pages.import = () => {
  $main.innerHTML = `
    <h1>Import from Zota</h1>
    <div class="sub">Upload the "customer report" export (.xlsx). Existing customers are matched by phone number and updated — safe to re-run anytime.</div>
    <div class="panel">
      <div class="drop" id="drop">
        <p style="font-size:2rem">📥</p>
        <p>Drag the Zota customer report here, or</p><br>
        <input type="file" id="file" accept=".xlsx,.xls,.csv">
      </div>
      <div id="impOut" style="margin-top:14px"></div>
    </div>`;
  const send = (file) => {
    const reader = new FileReader();
    document.getElementById('impOut').innerHTML = '<span class="muted">Importing… (large files can take a minute)</span>';
    reader.onload = async () => {
      try {
        const base64 = String(reader.result).split(',')[1];
        const r = await api('/api/import', { method: 'POST', body: { filename: file.name, data: base64 } });
        document.getElementById('impOut').innerHTML =
          `<b>✅ Done:</b> ${r.added} added, ${r.updated} updated, ${r.skipped} skipped (no phone). <a class="link" href="#customers">View customers</a>`;
      } catch (e) {
        document.getElementById('impOut').innerHTML = `<span style="color:var(--red)">❌ ${esc(e.message)}</span>`;
      }
    };
    reader.readAsDataURL(file);
  };
  document.getElementById('file').onchange = e => e.target.files[0] && send(e.target.files[0]);
  const drop = document.getElementById('drop');
  drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
  drop.ondragleave = () => drop.style.borderColor = '';
  drop.ondrop = e => { e.preventDefault(); drop.style.borderColor = ''; e.dataTransfer.files[0] && send(e.dataTransfer.files[0]); };
};

/* ---------- settings ---------- */
pages.settings = async () => {
  const s = await api('/api/settings');
  $main.innerHTML = `
    <h1>Settings</h1>
    <div class="sub">Rules for classification, points, booking hours and the owner PIN — you control the levers.</div>
    <div class="panel">
      <div class="field"><label>Salon name</label><input id="stName" value="${esc(s.salon_name)}" style="width:100%"></div>
      <h2>Customer classes</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>LOYAL at ≥ visits</label><input id="stLoyal" type="number" value="${esc(s.loyal_min_visits)}"></div>
        <div class="field"><label>VIP at ≥ visits</label><input id="stVipV" type="number" value="${esc(s.vip_min_visits)}"></div>
        <div class="field"><label>VIP at ≥ $ lifetime</label><input id="stVipS" type="number" value="${esc(s.vip_min_spend)}"></div>
      </div>
      <h2>Points</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Points per $1 spent</label><input id="stPpd" type="number" step="0.01" value="${esc(s.points_per_dollar)}"></div>
        <div class="field"><label>$ value per point</label><input id="stPv" type="number" step="0.01" value="${esc(s.point_value_dollars)}"></div>
        <div class="field"><label>Max % of ticket payable with points</label><input id="stCap" type="number" value="${esc(s.redeem_max_ticket_pct || 50)}"></div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Daily check-in bonus (pts)</label><input id="stCkb" type="number" value="${esc(s.checkin_bonus_points || 10)}"></div>
        <div class="field"><label>Birthday bonus (pts)</label><input id="stBdb" type="number" value="${esc(s.birthday_bonus_points || 50)}"></div>
        <div class="field"><label>At-risk after (days)</label><input id="stRisk" type="number" value="${esc(s.atrisk_days)}"></div>
      </div>
      <p class="muted" style="font-size:.8rem;margin-bottom:12px">Current program: $1 spent = ${esc(s.points_per_dollar)} pt · 100 pts = $${(100 * Number(s.point_value_dollars)).toFixed(0)} off · check-in bonus once per day.</p>
      <h2>Visit &amp; referral rewards</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>5th visit bonus (pts)</label><input id="stV5" type="number" value="${esc(s.visit5_bonus_points ?? 100)}"></div>
        <div class="field"><label>10th visit bonus (pts)</label><input id="stV10" type="number" value="${esc(s.visit10_bonus_points ?? 250)}"></div>
        <div class="field"><label>Referrer earns (pts)</label><input id="stRef" type="number" value="${esc(s.referral_bonus_points ?? 50)}"></div>
        <div class="field"><label>New friend earns (pts)</label><input id="stRefW" type="number" value="${esc(s.referral_welcome_points ?? 25)}"></div>
      </div>
      <p class="muted" style="font-size:.8rem;margin-bottom:12px">Visit bonuses land automatically on the 5th and 10th paid visit. Referral points pay out only after the new friend's first paid visit — sign-ups alone never award points.</p>
      <h2>Booking</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Open (HH:MM)</label><input id="stOpen" value="${esc(s.open_time || '09:00')}"></div>
        <div class="field"><label>Close (HH:MM)</label><input id="stClose" value="${esc(s.close_time || '19:00')}"></div>
        <div class="field"><label>Slot minutes</label><input id="stStep" type="number" value="${esc(s.slot_minutes || 30)}"></div>
        <div class="field"><label>Bookings per slot</label><input id="stCapS" type="number" value="${esc(s.slot_capacity || 3)}"></div>
      </div>
      <h2>NailMind AI images</h2>
      <p class="muted" style="font-size:.8rem;margin-bottom:10px">Paste a Google AI Studio key (aistudio.google.com — image generation needs billing enabled on the key). About 4 cents per image; the daily cap below is your spending brake for guest use.</p>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Google AI API key</label><input id="stGKey" type="password" value="${esc(secretVal(s.gemini_api_key))}" placeholder="${esc(secretPh(s.gemini_api_key, 'AIza...'))}"></div>
        <div class="field"><label>Images per tap</label><input id="stGN" type="number" min="1" max="6" value="${esc(s.nailmind_images_per_generate || 3)}"></div>
        <div class="field"><label>Guest daily image cap</label><input id="stGCap" type="number" value="${esc(s.nailmind_daily_limit || 60)}"></div>
      </div>
      <h2>NailMind credits</h2>
      <p class="muted" style="font-size:.8rem;margin-bottom:10px">Members sign in on NailMind with their phone. New members get welcome credits; after that they buy packs (sold at the front desk on the 💎 NailMind page, or online via Stripe Payment Links pasted below).</p>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Welcome credits (new member)</label><input id="stNmWelcome" type="number" value="${esc(s.nailmind_welcome_credits ?? 3)}"></div>
        <div class="field"><label>Packs (credits:$, comma-separated)</label><input id="stNmPacks" value="${esc(s.nailmind_packs || '10:5,25:10,60:20')}"></div>
      </div>
      <p class="muted" style="font-size:.78rem;margin-bottom:8px">Payment links are matched to packs by credit count — these three cover the 10 / 25 / 60 packs. If you change pack sizes above, tell Claude to re-map the links.</p>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Stripe link — 10-credit pack</label><input id="stNmL1" value="${esc(s.stripe_link_10 || '')}" placeholder="https://buy.stripe.com/…"></div>
        <div class="field"><label>Stripe link — 25-credit pack</label><input id="stNmL2" value="${esc(s.stripe_link_25 || '')}" placeholder="https://buy.stripe.com/…"></div>
        <div class="field"><label>Stripe link — 60-credit pack</label><input id="stNmL3" value="${esc(s.stripe_link_60 || '')}" placeholder="https://buy.stripe.com/…"></div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Stripe secret key (auto-credit online buys)</label><input id="stNmSk" type="password" value="${esc(secretVal(s.stripe_secret_key))}" placeholder="${esc(secretPh(s.stripe_secret_key, 'sk_live_…'))}"></div>
      </div>
      <h2>Text alerts (your existing Twilio account)</h2>
      <p class="muted" style="font-size:.8rem;margin-bottom:10px">Paste the same values from your nails-by-minh Vercel settings. Same account, same number, nothing new to buy. The system texts YOUR cell when a booking comes in.</p>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Twilio Account SID</label><input id="stTwSid" value="${esc(secretVal(s.twilio_sid))}" placeholder="${esc(secretPh(s.twilio_sid, 'AC...'))}"></div>
        <div class="field"><label>Twilio Auth Token</label><input id="stTwTok" type="password" value="${esc(secretVal(s.twilio_token))}" placeholder="${esc(secretPh(s.twilio_token, 'paste from Twilio Console'))}"></div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Twilio number (from)</label><input id="stTwFrom" value="${esc(s.twilio_from || '')}" placeholder="+16282586688"></div>
        <div class="field"><label>Your cell (to)</label><input id="stTwTo" value="${esc(s.owner_cell || '')}" placeholder="+1..."></div>
        <div class="field"><label>Alert on new booking</label>
          <select id="stTwOn"><option value="1" ${String(s.notify_on_booking || '1') === '1' ? 'selected' : ''}>On</option>
          <option value="0" ${String(s.notify_on_booking) === '0' ? 'selected' : ''}>Off</option></select></div>
      </div>
      <div class="actions" style="justify-content:flex-start;margin-bottom:16px">
        <button id="stTwTest">Send me a test text</button>
      </div>
      <h2>Security</h2>
      <div class="row" style="margin-bottom:12px">
        <div class="field"><label>Owner PIN</label><input id="stPin" type="password" value="" placeholder="•••••• saved — type a new PIN (8+ digits)"></div>
      </div>
      <div class="actions" style="justify-content:flex-start">
        <button class="primary" id="stSave">Save settings</button>
        <button id="stReclass">Re-apply classes to all customers</button>
      </div>
    </div>`;
  document.getElementById('stSave').onclick = async () => {
    const newPin = document.getElementById('stPin').value.trim(); /* blank = unchanged */
    await api('/api/settings', { method: 'PUT', body: {
      salon_name: document.getElementById('stName').value,
      loyal_min_visits: document.getElementById('stLoyal').value,
      vip_min_visits: document.getElementById('stVipV').value,
      vip_min_spend: document.getElementById('stVipS').value,
      points_per_dollar: document.getElementById('stPpd').value,
      point_value_dollars: document.getElementById('stPv').value,
      redeem_max_ticket_pct: document.getElementById('stCap').value,
      checkin_bonus_points: document.getElementById('stCkb').value,
      birthday_bonus_points: document.getElementById('stBdb').value,
      visit5_bonus_points: document.getElementById('stV5').value,
      visit10_bonus_points: document.getElementById('stV10').value,
      referral_bonus_points: document.getElementById('stRef').value,
      referral_welcome_points: document.getElementById('stRefW').value,
      atrisk_days: document.getElementById('stRisk').value,
      open_time: document.getElementById('stOpen').value,
      close_time: document.getElementById('stClose').value,
      slot_minutes: document.getElementById('stStep').value,
      slot_capacity: document.getElementById('stCapS').value,
      gemini_api_key: document.getElementById('stGKey').value.trim() || '__SET__',
      nailmind_images_per_generate: document.getElementById('stGN').value,
      nailmind_daily_limit: document.getElementById('stGCap').value,
      nailmind_welcome_credits: document.getElementById('stNmWelcome').value,
      nailmind_packs: document.getElementById('stNmPacks').value.trim(),
      stripe_link_10: document.getElementById('stNmL1').value.trim(),
      stripe_link_25: document.getElementById('stNmL2').value.trim(),
      stripe_link_60: document.getElementById('stNmL3').value.trim(),
      stripe_secret_key: document.getElementById('stNmSk').value.trim() || '__SET__',
      twilio_sid: document.getElementById('stTwSid').value.trim() || '__SET__',
      twilio_token: document.getElementById('stTwTok').value.trim() || '__SET__',
      twilio_from: document.getElementById('stTwFrom').value.trim(),
      owner_cell: document.getElementById('stTwTo').value.trim(),
      notify_on_booking: document.getElementById('stTwOn').value,
      admin_pin: newPin || '__SET__'
    } });
    if (newPin) localStorage.setItem('adminPin', newPin);
    toast('Settings saved');
    document.getElementById('salonName').textContent = document.getElementById('stName').value;
  };
  document.getElementById('stReclass').onclick = async () => {
    const r = await api('/api/settings/reclassify', { method: 'POST' });
    toast(`Reclassified — ${r.changed} of ${r.total} customers changed`);
  };
  document.getElementById('stTwTest').onclick = async () => {
    try {
      const r = await api('/api/settings/test-text', { method: 'POST' });
      toast(r.sent ? 'Test text sent — check your phone!' : 'Not sent — save your Twilio settings first', !r.sent);
    } catch (e) { toast(e.message, true); }
  };
};

/* ---------- boot ---------- */
(async () => {
  try {
    const r = await fetch('/api/auth/check', { method: 'POST', headers: { 'x-admin-pin': pin() } });
    if (!r.ok) return showLock();
    navigate();
  } catch {
    showLock();
  }
})();
