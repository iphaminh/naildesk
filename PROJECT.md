# NailDesk — project notes

The running log for the Dream Nails salon platform: where it stands, what comes
next, why, and how it got here. Update it at the end of every working session
(the `/wrap-up` skill does this).

**Notion:** https://app.notion.com/p/3f493414a32c816caf0fcec991d9eb84 — the same notes, under Projects. This file is the source of truth.

---

## Where we are — 12 October 2026

The platform runs Dream Nails & Spa at **dreamnails.phaminh.com**, on its own
Supabase database (`dream-nails-pos`, `maqsptfpfdgcxielnnrz`).

**🔴 The database is paused, so online booking is down.** Minh paused it on
9 October to free a slot for NailMind's database: Supabase allows each person
only 2 awake free projects. While it is paused, the booking page, the kiosk and
the admin can't load or save anything. No data is lost. Waking it is step 1
below.

**Live data, checked 9 October (counts only)**

| | | What it tells us |
|---|---|---|
| Customers | 810 | Imported from the old Zota POS |
| Techs / services | 8 / 61 | Fully set up |
| Online bookings | 8, latest **8 Oct** | **The booking page is in real use** |
| POS tickets | **0** | The front desk has never rung up a sale here — checkout still happens on the old system |
| Kiosk check-ins | 1, on 18 Jul | A test; the kiosk isn't in use |
| Referrals | 0 | |

So of the three pieces, **booking is the one clients actually use**. The POS
and kiosk are built and loaded with real customers but not adopted yet.

**Verified on 9 October**

- The code now lives in its own repository (`iphaminh/naildesk`), split out of
  `nail-pos-system` with its commit history.
- Checked route by route against the old combined server: every salon API
  route — booking, kiosk, POS, reports, import, settings — returns the same
  status and response and makes the same database calls as before.
- The salon database still holds dormant NailMind test tables (1 test account,
  8 test credits, last used 6 Aug, before NailMind moved to its own database).
  No real customer is affected by NailMind leaving this app.
- **Another app also writes to this database.** Tables that no code in this
  repository touches hold live rows: `tom_rewards` (3, newest 8 Oct),
  `tom_referrals` (1, 17 Sep) and `staff_hours` (46). `turn_events`,
  `time_clock`, `time_off`, `ticket_tip_splits` and `staff_hours_overrides` are
  empty, and triggers on `appointments` fill `appointment_status_history`.
  Find out which app owns them before changing or dropping anything here.

---

## Next

In order, each with why.

1. **Wake the database — clients can't book online until then.** First free
   one of the 2 free slots. The other awake project is **growth-engine**, in a
   separate Supabase organization (identified 26 October). Pause it if it isn't
   needed, or move a project to a paid plan. Then supabase.com/dashboard → organization
   **Nailbyminh** → **dream-nails-pos** → **Resume project**. Possible for 90
   days after 9 October, so until about 7 January 2027.
2. **Deploy from this repository only after a quick check.** The split changes
   two things on the salon site: `/nailmind` now redirects to
   `https://nailmind.app/app`, and the admin no longer shows NailMind pages
   (which the salon domain already hid). Booking is unchanged, but it's the
   part clients use — after deploying, make one test booking.
3. **Decide whether the front desk will switch to the POS.** Everything is
   loaded (810 customers, services, techs). The open question is adoption, not
   code: try one full day of checkout here, then decide.
4. **Decide what NailDesk and NailBook are as products.** Both landing pages
   collect "early access" emails, but the code serves one salon per deployment.
   Selling to other salons needs either a deployment per salon or
   multi-tenancy — a real project to scope before promising anyone.
5. **Drop the dormant `nailmind_*` tables** from this database when convenient.
   Nothing reads them; they're leftovers from before 6 August.
6. **Write down the exact Hostinger deploy steps** in `README.md` the next time
   you deploy.

---

## Decisions, and why

- **Booking stays in this repository** (Oct 2026). Booking, kiosk and POS share
  customers, techs and services, and a booking turns into a POS ticket. Split
  apart, they'd need duplicated tables or a fragile link between two apps.
  NailBook is sold as the booking-only slice of this same system.
- **NailMind left this app** (Oct 2026). It already had its own domain and
  database; only the code was shared. The salon's old studio link now
  redirects to nailmind.app, so printed QR codes and bookmarks keep working.
- **The old SQLite POS is kept in `legacy/`**, not deleted — it's the original
  local version and still the reference for the Zota import.

---

## How it's built

One Node + Express app on Hostinger, talking to Supabase Postgres.

- **Clients:** the booking page at `/` (service, tech, time, optional inspo
  photo; capacity per time slot) and the check-in kiosk at `/kiosk`.
- **Staff:** the admin at `/admin` behind a PIN — dashboard, appointments,
  check-in and checkout (tips, points, refunds, voids), customers with VIP /
  LOYAL / NEW classes and at-risk tracking, services, techs with per-service
  skills, revenue reports, customer CSV export, Zota import, settings.
- **Loyalty:** points per dollar, daily check-in bonus, birthday bonus, 5th and
  10th visit bonuses, referral rewards — every rule a setting.
- **Alerts:** each new booking texts the owner through Twilio.

### Where the accounts live

| What | Where |
|---|---|
| Hosting | Hostinger, dreamnails.phaminh.com |
| Database | Supabase project `dream-nails-pos` (`maqsptfpfdgcxielnnrz`, us-west-1) |
| Texts | Twilio (the same account as the older nails-by-minh booking site) |
| Landing page | `landing/` — where it's hosted isn't recorded; early-access buttons email nailbyminh@gmail.com |

---

## History

**First — the local POS.** A self-hosted SQLite version (now in `legacy/`) with
a Zota customer import.

**Mid-July — the cloud platform.** The Supabase database was created on 17
July and the 810 customers came over from Zota; the kiosk was first tried on
18 July.

**4 August — into git.** The first commit is a snapshot of work already built:
salon POS, booking and NailMind together on one server, with a host gate
deciding which product answered on which domain.

**5–6 August — hardening.** Closed an account-takeover hole and stopped secrets
leaking over the API; moved to the Supabase secret key and locked the database
down. NailMind moved to its own database, leaving the salon's data on its own.

**August–October — in use.** Clients booking online, most recently on 8
October.

**9 October — split into its own repository.** NailMind's code removed, the
admin trimmed to salon pages, `/nailmind` redirected to nailmind.app.

**9 October — database paused.** Minh paused it to free a slot for NailMind's
database under Supabase's limit of 2 awake free projects. Online booking is
down until it's woken.

The commit history (`git log --stat`) has the detail. Commits before 9 October
mention NailMind because the files were shared; those NailMind changes now live
in `iphaminh/nailmind`. Everything before the split is also in the old
`iphaminh/nail-pos-system` repository.
