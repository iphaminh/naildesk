# NailDesk — notes for Claude

The salon platform that runs **Dream Nails & Spa** (Vacaville, CA) at
**dreamnails.phaminh.com**: the client booking page (marketed as NailBook), a
check-in kiosk, and the front-desk POS and customer system (marketed as
NailDesk). **Real clients book through this every week — treat it as
production.**

**Start every task by reading the top of `PROJECT.md`** ("Where we are" and
"Next").

## Working with Minh

Minh is a working nail technician, not a developer. Explain what each step
does and why, name exact places (URL, menu path, file path), and don't skip
steps. If Minh pastes an API key, token or password into the chat, don't use
it: say it is exposed, how to revoke it, and where secrets belong
(`cloud/lib/secrets.json` or the `settings` table).

## Layout

```
cloud/                   the live app — Node + Express on Hostinger
  server.js              entry: static files, /kiosk, /admin, and
                         /nailmind → 302 to https://nailmind.app/app
  api/index.js           every route: public booking + kiosk, POS admin,
                         reports, Zota import, settings
  lib/supa.js            Supabase REST client
  lib/secrets.json       database key — gitignored; never commit, never print
  public/index.html      client booking page at /  (the NailBook product)
  public/kiosk.html      check-in kiosk at /kiosk
  public/admin/          POS admin at /admin (PIN): dashboard, appointments,
                         check-in/sale, customers, services, techs, reports,
                         import, settings
  migrations/            SQL applied to Supabase
landing/                 NailDesk marketing page (static; not served by cloud/)
legacy/                  the original local SQLite POS, superseded by cloud/
```

## Run it

```bash
cd cloud && npm ci
SUPABASE_URL=https://maqsptfpfdgcxielnnrz.supabase.co SUPABASE_KEY=… PORT=3100 node server.js
```

Booking page at `/`, kiosk at `/kiosk`, admin at `/admin`. Point a local run at
a copy of the data, not production, before trying anything that writes.

## Facts the code doesn't make obvious

- **Database:** Supabase project `dream-nails-pos` (`maqsptfpfdgcxielnnrz`).
  NailMind has its own project and its own repo (`iphaminh/nailmind`). This
  database still holds dormant `nailmind_*` tables from before 6 August 2026 —
  test data only, nothing reads them now.
- **Single salon:** no tenant or salon id anywhere — one deployment and one
  database per salon. Selling NailDesk or NailBook to another salon means a new
  deployment and database, or adding multi-tenancy first.
- **Booking ↔ POS are one system:** bookings land in `appointments`; an
  appointment becomes a ticket from the admin (`start-ticket`). Both read the
  same `customers`, `techs`, `services` and `tech_services`.
- **Settings table** holds the salon name, class thresholds (VIP/LOYAL/NEW),
  loyalty points rules, booking hours and slot capacity, Twilio keys and the
  admin PIN. Secrets are redacted from every response; the admin form sends
  `__SET__` to mean "unchanged".
- **Booking alerts:** each new booking texts the owner through Twilio
  (`textOwner`); a failed text never blocks the booking.
- **Admin PIN:** header only (`x-admin-pin`); 5 wrong tries lock that IP out
  for 15 minutes.
- **Import:** `/api/import` takes a Zota customer report (.xlsx, base64). It is
  how the 810 customers arrived.

## Rules

- Production data. Run nothing that deletes or rewrites rows without Minh's
  explicit go-ahead, and never against the live database to "test".
- Never commit `cloud/lib/secrets.json`, never print secret values.
- The booking page is the part clients use — after any change to booking
  routes, check `/`, `/api/public/slots` and `/api/public/book` still work.
- Never claim something is deployed or verified without checking it.

## Related repositories

Split out of `iphaminh/nail-pos-system` in October 2026.

- `iphaminh/nailmind` — the AI design studio, its own product and database.
- `iphaminh/nailbook` — landing page and notes for the booking product; its
  engine is `cloud/public/index.html` + `/api/public/*` here.
