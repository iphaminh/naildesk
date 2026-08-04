/* Nail POS — single-page app */
const $main = document.getElementById('main');
const $modal = document.getElementById('modal-root');

const fmt$ = n => '$' + (Number(n) || 0).toFixed(2);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opts = {}) {
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json', ...opts.headers };
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, opts);
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
  const cls = Object.fromEntries(d.classes.map(c => [c.class, c.n]));
  const maxDay = Math.max(1, ...d.last30.map(x => x.total));
  $main.innerHTML = `
    <h1>Dashboard</h1>
    <div class="sub">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
    <div class="cards">
      <div class="card"><div class="label">Today's Revenue</div><div class="value">${fmt$(d.today.total)}</div><div class="hint">${d.today.n} tickets · ${fmt$(d.today.tip)} tips</div></div>
      <div class="card"><div class="label">This Month</div><div class="value">${fmt$(d.thisMonth.total)}</div><div class="hint">${d.thisMonth.n} tickets</div></div>
      <div class="card"><div class="label">Open Tickets</div><div class="value">${d.openTickets}</div><div class="hint"><a class="link" href="#checkin">go to check-in</a></div></div>
      <div class="card"><div class="label">Customers</div><div class="value">${d.totalCustomers}</div>
        <div class="hint"><span class="badge VIP">VIP ${cls.VIP || 0}</span> <span class="badge LOYAL">LOYAL ${cls.LOYAL || 0}</span> <span class="badge NEW">NEW ${cls.NEW || 0}</span></div></div>
    </div>
    <div class="panel">
      <div class="panel-title">Revenue — last 30 days</div>
      ${d.last30.length ? `<div class="bars">${d.last30.map(x =>
        `<div class="bar" style="height:${Math.round(x.total / maxDay * 100)}%" data-tip="${x.d}: ${fmt$(x.total)} (${x.n})"></div>`).join('')}</div>`
      : `<div class="empty">No paid tickets yet — revenue will show here after your first checkout.</div>`}
    </div>
    <div class="grid2">
      <div class="panel">
        <div class="panel-title">⚠️ At-risk regulars <span class="muted" style="font-weight:400">VIP/Loyal away &gt; ${d.settings.atrisk_days} days</span></div>
        ${d.atRisk.length ? `<table><thead><tr><th>Customer</th><th>Class</th><th class="num">Days away</th><th class="num">Lifetime</th></tr></thead><tbody>
          ${d.atRisk.map(c => `<tr class="clickable" onclick="location.hash='#customers/${c.id}'">
            <td>${esc(c.first_name)}<br><span class="muted">${esc(c.mobile || '')}</span></td>
            <td><span class="badge ${c.class}">${c.class}</span></td>
            <td class="num"><span class="badge risk">${c.days_away}</span></td>
            <td class="num">${fmt$(c.lifetime_spend)}</td></tr>`).join('')}</tbody></table>
          <p class="muted" style="margin-top:10px;font-size:.8rem">💡 These are your best customers who stopped coming. A quick text ("we miss you — 10% off this week") wins them back.</p>`
        : `<div class="empty">No at-risk regulars 🎉</div>`}
      </div>
      <div class="panel">
        <div class="panel-title">🎂 Birthdays this month</div>
        ${d.birthdays.length ? `<table><thead><tr><th>Customer</th><th>Birthday</th><th>Class</th></tr></thead><tbody>
          ${d.birthdays.map(c => `<tr class="clickable" onclick="location.hash='#customers/${c.id}'">
            <td>${esc(c.first_name)}<br><span class="muted">${esc(c.mobile || '')}</span></td>
            <td>${esc(c.birthday)}</td><td><span class="badge ${c.class}">${c.class}</span></td></tr>`).join('')}</tbody></table>`
        : `<div class="empty">No birthdays on file this month.</div>`}
      </div>
    </div>`;
};

/* ---------- check-in / sale ---------- */
let currentTicketId = null;
pages.checkin = async () => {
  const [tickets, services, techs] = await Promise.all([api('/api/tickets'), api('/api/services'), api('/api/techs')]);
  const open = tickets.filter(t => t.status === 'open');
  const done = tickets.filter(t => t.status !== 'open');
  if (currentTicketId && !open.find(t => t.id === currentTicketId)) currentTicketId = null;
  if (!currentTicketId && open.length) currentTicketId = open[0].id;

  $main.innerHTML = `
    <h1>Check-In / Sale</h1>
    <div class="sub">Start a ticket, add services, check out. Customer stats & points update automatically.</div>
    <div class="toolbar">
      <button class="primary" id="btnNewTicket">＋ New Ticket</button>
      ${open.map(t => `<button class="${t.id === currentTicketId ? 'primary' : ''}" data-tid="${t.id}">
        #${t.id} ${esc(t.customer_name || 'Walk-in')} · ${fmt$(t.subtotal)}</button>`).join('')}
    </div>
    <div id="ticketArea"></div>
    <h2>Today's closed tickets</h2>
    <div class="panel">${done.length ? `<table><thead><tr><th>#</th><th>Customer</th><th>Services</th><th class="num">Total</th><th>Paid by</th><th>Status</th></tr></thead><tbody>
      ${done.map(t => `<tr><td>${t.id}</td><td>${esc(t.customer_name || 'Walk-in')}</td><td class="muted">${esc(t.items || '')}</td>
        <td class="num">${fmt$(t.total)}</td><td>${esc(t.payment_method || '')}</td><td><span class="badge ${t.status}">${t.status}</span></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No closed tickets today yet.</div>`}</div>`;

  document.getElementById('btnNewTicket').onclick = () => pickCustomerThen(async cust => {
    const t = await api('/api/tickets', { method: 'POST', body: { customer_id: cust ? cust.id : null } });
    currentTicketId = t.id;
    pages.checkin();
  });
  $main.querySelectorAll('[data-tid]').forEach(b => b.onclick = () => { currentTicketId = Number(b.dataset.tid); pages.checkin(); });

  if (currentTicketId) renderTicket(currentTicketId, services, techs);
};

async function renderTicket(id, services, techs) {
  const t = await api(`/api/tickets/${id}`);
  const area = document.getElementById('ticketArea');
  if (!area) return;
  const activeTechs = techs.filter(x => x.active);
  const byCat = {};
  services.filter(s => s.active).forEach(s => (byCat[s.category] = byCat[s.category] || []).push(s));

  area.innerHTML = `
    <div class="split">
      <div class="panel">
        <div class="panel-title">Add services
          <span>Tech: <select id="selTech"><option value="">— pick tech —</option>
            ${activeTechs.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></span>
        </div>
        ${Object.entries(byCat).map(([cat, list]) => `
          <div class="muted" style="font-size:.75rem;text-transform:uppercase;margin:10px 0 6px">${esc(cat)}</div>
          <div class="svc-grid">${list.map(s => `<button class="svc-btn" data-sid="${s.id}">${esc(s.name)}<div class="p">${fmt$(s.price)}</div></button>`).join('')}</div>`).join('')}
        <div class="row" style="margin-top:14px">
          <div class="field"><label>Custom item</label><input id="customName" placeholder="e.g. Design add-on"></div>
          <div class="field" style="max-width:110px"><label>Price</label><input id="customPrice" type="number" step="0.01" min="0"></div>
          <button id="btnCustom">Add</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">Ticket #${t.id}
          <span>${t.customer_name ? `${esc(t.customer_name)} <span class="badge ${t.customer_class}">${t.customer_class}</span>` : `<a class="link" id="linkAttach">attach customer</a>`}</span>
        </div>
        ${t.customer_name ? `<div class="muted" style="margin-bottom:8px;font-size:.82rem">${esc(t.customer_mobile || '')} · ${Number(t.customer_points || 0).toFixed(0)} pts available</div>` : ''}
        <div id="lines">${t.items.length ? t.items.map(i => `
          <div class="ticket-line"><span>${esc(i.name)}${i.tech_name ? ` <span class="muted">· ${esc(i.tech_name)}</span>` : ''}</span>
          <span>${fmt$(i.price)} <span class="x" data-del="${i.id}">✕</span></span></div>`).join('')
        : `<div class="empty">Tap services on the left to add them.</div>`}</div>
        <div style="margin-top:12px">
          <div class="row">
            <div class="field"><label>Discount $</label><input id="inDiscount" type="number" step="0.01" min="0" value="0"></div>
            <div class="field"><label>Tip $</label><input id="inTip" type="number" step="0.01" min="0" value="0"></div>
            ${t.customer_id ? `<div class="field"><label>Redeem points</label><input id="inPoints" type="number" step="1" min="0" max="${Math.max(0, t.customer_points || 0)}" value="0"></div>` : ''}
          </div>
          <div style="margin-top:10px">
            <div class="totals-line"><span>Subtotal</span><span id="tSub">${fmt$(t.subtotal)}</span></div>
            <div class="totals-line grand"><span>Total</span><span id="tTotal">${fmt$(t.subtotal)}</span></div>
          </div>
          <div class="row" style="margin-top:12px">
            <div class="field"><label>Payment</label>
              <select id="selPay"><option>cash</option><option>card</option><option>venmo</option><option>zelle</option><option>other</option></select></div>
            <button class="primary" id="btnCheckout">💳 Checkout</button>
            <button class="danger" id="btnVoid">Void</button>
          </div>
        </div>
      </div>
    </div>`;

  const recalc = async () => {
    const fresh = await api(`/api/tickets/${id}`);
    const disc = Number(area.querySelector('#inDiscount').value) || 0;
    const tip = Number(area.querySelector('#inTip').value) || 0;
    const ptsEl = area.querySelector('#inPoints');
    const ptsVal = ptsEl ? (Number(ptsEl.value) || 0) * 0.05 : 0; // display estimate; server enforces real value
    area.querySelector('#tSub').textContent = fmt$(fresh.subtotal);
    area.querySelector('#tTotal').textContent = fmt$(Math.max(0, fresh.subtotal - disc - ptsVal) + tip);
  };
  ['inDiscount', 'inTip', 'inPoints'].forEach(x => { const el = area.querySelector('#' + x); if (el) el.oninput = recalc; });

  area.querySelectorAll('[data-sid]').forEach(b => b.onclick = async () => {
    const tech_id = area.querySelector('#selTech').value || null;
    await api(`/api/tickets/${id}/items`, { method: 'POST', body: { service_id: Number(b.dataset.sid), tech_id: tech_id ? Number(tech_id) : null } });
    pages.checkin();
  });
  area.querySelector('#btnCustom').onclick = async () => {
    const name = area.querySelector('#customName').value.trim();
    const price = Number(area.querySelector('#customPrice').value);
    if (!name) return toast('Enter item name', true);
    const tech_id = area.querySelector('#selTech').value || null;
    await api(`/api/tickets/${id}/items`, { method: 'POST', body: { name, price, tech_id: tech_id ? Number(tech_id) : null } });
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
  area.querySelector('#btnCheckout').onclick = async () => {
    try {
      const body = {
        payment_method: area.querySelector('#selPay').value,
        discount: Number(area.querySelector('#inDiscount').value) || 0,
        tip: Number(area.querySelector('#inTip').value) || 0
      };
      const ptsEl = area.querySelector('#inPoints');
      if (ptsEl) body.redeem_points = Number(ptsEl.value) || 0;
      const done = await api(`/api/tickets/${id}/checkout`, { method: 'POST', body });
      toast(`Ticket #${id} paid — ${fmt$(done.total)}`);
      currentTicketId = null;
      pages.checkin();
    } catch (e) { toast(e.message, true); }
  };
  area.querySelector('#btnVoid').onclick = async () => {
    if (!confirm('Void this ticket?')) return;
    await api(`/api/tickets/${id}/void`, { method: 'POST' });
    currentTicketId = null;
    pages.checkin();
  };
}

/* customer picker used by check-in */
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
    const q = search.value.trim();
    const d = await api(`/api/customers?search=${encodeURIComponent(q)}&limit=15&sort=${q ? 'name' : 'recent'}`);
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
      <a href="/api/reports/customers.csv"><button>⬇ Export CSV</button></a>
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
        <td class="num">${(c.points_earned - c.points_redeemed).toFixed(0)}</td></tr>`).join('')}</tbody></table>
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
      <div class="card"><div class="label">Points</div><div class="value">${c.points_balance.toFixed(0)}</div><div class="hint">≈ ${fmt$(c.points_balance * c.point_value)} value</div></div>
    </div>
    ${c.notes ? `<div class="panel"><div class="panel-title">Notes</div>${esc(c.notes)}</div>` : ''}
    <div class="panel">
      <div class="panel-title">Visit history (in this system)</div>
      ${c.tickets.length ? `<table><thead><tr><th>Date</th><th>Services</th><th class="num">Total</th><th>Paid by</th><th>Status</th></tr></thead><tbody>
        ${c.tickets.map(t => `<tr><td>${(t.closed_at || t.created_at).slice(0, 16)}</td><td class="muted">${esc(t.items || '')}</td>
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
    <div class="sub">Your menu — these show as quick buttons on the check-in screen.</div>
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
      <div class="actions"><button onclick="document.getElementById('modal-root').innerHTML=''">Cancel</button>
        <button class="primary" id="svSave">Save</button></div>`);
    m.querySelector('#svSave').onclick = async () => {
      const body = { name: m.querySelector('#svName').value, category: m.querySelector('#svCat').value,
        price: m.querySelector('#svPrice').value, duration_min: m.querySelector('#svMin').value };
      try {
        if (s) await api(`/api/services/${s.id}`, { method: 'PUT', body: { ...s, ...body } });
        else await api('/api/services', { method: 'POST', body });
        closeModal(); pages.services();
      } catch (e) { toast(e.message, true); }
    };
  };
  document.getElementById('sAdd').onclick = () => form(null);
  $main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(list.find(x => x.id === Number(b.dataset.edit))));
  $main.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => {
    const s = list.find(x => x.id === Number(b.dataset.tog));
    await api(`/api/services/${s.id}`, { method: 'PUT', body: { ...s, active: s.active ? 0 : 1 } });
    pages.services();
  });
};

/* ---------- techs ---------- */
pages.techs = async () => {
  const list = await api('/api/techs');
  $main.innerHTML = `
    <h1>Techs</h1>
    <div class="sub">Your team — assign them on tickets to see who earned what in Reports.</div>
    <div class="toolbar">
      <div class="row"><div class="field"><label>Name</label><input id="tName"></div>
      <div class="field"><label>Phone</label><input id="tPhone"></div>
      <button class="primary" id="tAdd">＋ Add tech</button></div>
    </div>
    <div class="panel">${list.length ? `<table><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.phone || '')}</td>
        <td>${t.active ? '<span class="badge paid">active</span>' : '<span class="badge void">inactive</span>'}</td>
        <td class="num"><button class="small" data-tog="${t.id}">${t.active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">No techs yet — add your team above.</div>`}</div>`;
  document.getElementById('tAdd').onclick = async () => {
    const name = document.getElementById('tName').value.trim();
    if (!name) return toast('Enter a name', true);
    await api('/api/techs', { method: 'POST', body: { name, phone: document.getElementById('tPhone').value } });
    pages.techs();
  };
  $main.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => {
    const t = list.find(x => x.id === Number(b.dataset.tog));
    await api(`/api/techs/${t.id}`, { method: 'PUT', body: { ...t, active: t.active ? 0 : 1 } });
    pages.techs();
  });
};

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
      <a href="/api/reports/customers.csv"><button>⬇ Customer report CSV</button></a>
    </div>
    <div id="rOut"></div>`;
  const run = async () => {
    const f = document.getElementById('rFrom').value, t = document.getElementById('rTo').value;
    const d = await api(`/api/reports/revenue?from=${f}&to=${t}`);
    const maxDay = Math.max(1, ...d.byDay.map(x => x.total));
    document.getElementById('rOut').innerHTML = `
      <div class="cards">
        <div class="card"><div class="label">Revenue</div><div class="value">${fmt$(d.totals.total)}</div></div>
        <div class="card"><div class="label">Tips</div><div class="value">${fmt$(d.totals.tip)}</div></div>
        <div class="card"><div class="label">Tickets</div><div class="value">${d.totals.n}</div></div>
        <div class="card"><div class="label">Avg ticket</div><div class="value">${fmt$(d.totals.n ? d.totals.total / d.totals.n : 0)}</div></div>
      </div>
      <div class="panel"><div class="panel-title">By day</div>
        ${d.byDay.length ? `<div class="bars">${d.byDay.map(x => `<div class="bar" style="height:${Math.round(x.total / maxDay * 100)}%" data-tip="${x.d}: ${fmt$(x.total)}"></div>`).join('')}</div>` : '<div class="empty">No paid tickets in range.</div>'}</div>
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
    </div>
    <div class="panel">
      <div class="panel-title">How it maps</div>
      <table>
        <tr><td class="muted">Cust. First / Mobile / Birthday / Email</td><td>→ customer profile</td></tr>
        <tr><td class="muted">No. Of Visit / Up-To-Date Spendings</td><td>→ visits & lifetime spend</td></tr>
        <tr><td class="muted">Last Serv. Date / Amount</td><td>→ last visit</td></tr>
        <tr><td class="muted">Point Earned / Redeemed</td><td>→ points balance</td></tr>
        <tr><td class="muted">Class. (VIP / LOYAL / NEW)</td><td>→ kept, then auto-managed by your rules in Settings</td></tr>
      </table>
    </div>`;
  const send = async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    document.getElementById('impOut').innerHTML = '<span class="muted">Importing…</span>';
    try {
      const r = await api('/api/import', { method: 'POST', body: fd });
      document.getElementById('impOut').innerHTML =
        `<b>✅ Done:</b> ${r.added} added, ${r.updated} updated, ${r.skipped} skipped (no phone). <a class="link" href="#customers">View customers</a>`;
    } catch (e) {
      document.getElementById('impOut').innerHTML = `<span style="color:var(--red)">❌ ${esc(e.message)}</span>`;
    }
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
    <div class="sub">Rules for classification and points — you control the levers.</div>
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
      <div class="actions" style="justify-content:flex-start">
        <button class="primary" id="stSave">Save settings</button>
        <button id="stReclass">Re-apply classes to all customers</button>
      </div>
    </div>`;
  document.getElementById('stSave').onclick = async () => {
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
      atrisk_days: document.getElementById('stRisk').value
    } });
    toast('Settings saved');
    document.getElementById('salonName').textContent = document.getElementById('stName').value;
  };
  document.getElementById('stReclass').onclick = async () => {
    const r = await api('/api/settings/reclassify', { method: 'POST' });
    toast(`Reclassified — ${r.changed} of ${r.total} customers changed`);
  };
};

navigate();
