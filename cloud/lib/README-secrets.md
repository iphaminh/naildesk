# cloud/lib/secrets.json — NOT in git

The deployment needs this file next to `supa.js`, pointing at the salon's own
database. Build the deploy archive with it in place.

```json
{ "SUPABASE_URL": "https://maqsptfpfdgcxielnnrz.supabase.co", "SUPABASE_KEY": "sb_secret_…" }
```

The key lives in the Supabase dashboard under Project Settings → API Keys.
Never commit this file; never send it to a browser. The Twilio keys are not
here — they live in the `settings` table and the API redacts them.
