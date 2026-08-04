# Nail POS — your own salon system

Self-hosted POS + customer management for the salon. No subscription, no vendor lock-in — all data lives in one file on your machine (`data/salon.db`).

## Run it

```bash
npm install
npm start
```

Open http://localhost:3789

## Import your Zota data

Two ways:
- In the app: **Import** page → drop the `customer_report ... .xlsx` file
- Terminal: `npm run import -- "/path/to/customer_report.xlsx"`

Customers are matched by phone number, so re-importing a newer export is safe — it updates instead of duplicating.

## What it does

| Page | What |
|------|------|
| Dashboard | Today/month revenue, customer mix, **at-risk regulars** (VIP/Loyal who stopped coming), birthdays this month |
| Check-In / Sale | Open a ticket → tap services → assign tech → checkout (cash/card/venmo/zelle). Updates visits, spend, points, and VIP/Loyal class automatically |
| Customers | Search 800+ customers, full profile + visit history, notes, CSV export |
| Services | Your price menu (shows as buttons on check-in) |
| Techs | Your team; reports show revenue per tech |
| Reports | Revenue by day / tech / service for any date range |
| Settings | You control the rules: what makes a VIP, points rates, at-risk threshold |

## Classification rules (defaults, editable in Settings)

Reverse-engineered from the Zota report:
- **VIP** — 10+ visits or $400+ lifetime spend
- **LOYAL** — 3+ visits
- **NEW** — everyone else

Change the thresholds in Settings, then hit "Re-apply classes to all customers".

## Backup

Copy `data/salon.db` somewhere safe (it's one file). That's your whole business.
