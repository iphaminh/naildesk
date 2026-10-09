# NailDesk

The salon platform behind **Dream Nails & Spa** (Vacaville, CA) at
dreamnails.phaminh.com: online booking for clients, a check-in kiosk, and the
front-desk POS and customer system for staff.

**Where the project stands and what's next: [`PROJECT.md`](PROJECT.md).**

| Page | Who uses it | What it is |
|---|---|---|
| `/` | Clients | Online booking — service, tech, time, optional inspo photo (sold as **NailBook**) |
| `/kiosk` | Clients | Check-in at the counter |
| `/admin` | Staff (PIN) | Dashboard, appointments, checkout, customers, services, techs, reports, import, settings |
| `/nailmind` | — | Redirects to the NailMind studio at nailmind.app |

## Layout

```
cloud/      the live app — Node + Express, deployed to Hostinger
landing/    NailDesk marketing page (static)
legacy/     the original local SQLite POS, superseded by cloud/
```

## Running locally

```bash
cd cloud
npm ci
SUPABASE_URL=https://maqsptfpfdgcxielnnrz.supabase.co SUPABASE_KEY=… PORT=3100 node server.js
```

Open `http://localhost:3100`. This is the salon's real database — anything you
save locally is saved for real. The key can also go in `cloud/lib/secrets.json`
(see `cloud/lib/README-secrets.md`).

## Deploying

Hostinger Node.js hosting. Upload the contents of `cloud/` (without
`node_modules/`) to the app, keeping the `lib/secrets.json` already on the
server — git never has it. Clients book through this site every week: after a
deploy, open `/` and make one test booking.

*To do: write the exact Hostinger steps here the next time you deploy.*

## Services

- **Supabase** — Postgres, project `dream-nails-pos`. The server authenticates
  with the secret key, which bypasses row level security; no policy grants the
  anon key anything (see `migrations/lock_down_rls.sql`).
- **Twilio** — texts the owner when a booking comes in.

## Secrets

Nothing live belongs in this repo. The database key lives in
`cloud/lib/secrets.json` (gitignored); the Twilio keys and the admin PIN live in
the `settings` table and are redacted out of every API response.

## Related

Split out of `iphaminh/nail-pos-system` in October 2026, with its history.

- **[nailmind](https://github.com/iphaminh/nailmind)** — the AI nail-design
  studio, its own product and database.
- **[nailbook](https://github.com/iphaminh/nailbook)** — the booking product's
  landing page and notes. The booking engine itself is here.
