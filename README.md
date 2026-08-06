# Dream Nails + NailMind

Two products, one codebase, one Node server. Which one you get depends on the
domain you arrive on.

| Domain | What it serves | Who it's for |
|---|---|---|
| **nailmind.app** | Landing page at `/`, AI design studio at `/app` | The global consumer product |
| **dreamnails.phaminh.com** | Booking, POS admin, check-in kiosk, studio | Dream Nails & Spa, Vacaville |

A host gate at the top of `cloud/api/index.js` enforces the split: on
nailmind.app the salon's POS, booking and kiosk routes return 404, so the
product domain can never reach salon data.

## Layout

```
cloud/
  server.js          Node entry point (Hostinger)
  api/index.js       every route — host gate, salon POS, NailMind, Stripe
  lib/supa.js        database client
  lib/secrets.json   database key — GITIGNORED, ships only in the deploy archive
  public/
    index.html       salon booking (NailBook)
    kiosk.html       salon check-in
    admin/           salon POS + NailMind credit sales (PIN protected)
    nailmind.html    the AI studio
    landing/         nailmind.app marketing page (copy of nailmind-landing/)
    gallery/v3/      97 AI-generated gallery images
  migrations/        SQL applied to Supabase, newest last
nailmind-landing/    source of the marketing page
```

## Running locally

```bash
PORT=3100 node cloud/server.js
```

Then `http://localhost:3100` for the salon, and to see the product domain:

```bash
curl -H "Host: nailmind.app" http://localhost:3100/app
```

## Deploying

Both sites run the same archive. Build it from `cloud/` including
`lib/secrets.json` (which git ignores), then deploy to each domain via
Hostinger. Gallery images are served from `/gallery/v3/` — bump the version
folder when regenerating so the CDN can't serve stale images.

## Services

- **Supabase** — Postgres + Storage. The server authenticates with the secret
  key, which bypasses row level security; no policy grants the anon key
  anything (see `migrations/lock_down_rls.sql`).
- **Stripe** — server-created Checkout Sessions; the webhook re-verifies each
  session with Stripe before adding credits, and `nailmind_stripe_events`
  makes double-crediting impossible.
- **Google Gemini** — image generation. Key lives in the `settings` table and
  is never returned over the API.

## Credits

One credit buys one generation. Every movement — welcome grant, spend,
purchase, front-desk sale, refund — is one row in `nailmind_ledger`, written
by `nm_credit_adjust()`, which row-locks the account so concurrent changes
can't corrupt a balance.

## Secrets

Nothing live belongs in this repo. The database key lives in
`cloud/lib/secrets.json` (gitignored); Stripe, Google and Twilio keys live in
the `settings` table and are redacted out of every API response.
