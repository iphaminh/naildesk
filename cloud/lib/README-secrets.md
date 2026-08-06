# cloud/lib/secrets.json — NOT in git

Each deployment gets its own copy of this file, pointing at its own database.
Build the archive with the right one in place before deploying.

**nailmind.app** (the product)
```json
{ "SUPABASE_URL": "https://wtbfsmzupvqogmkmrwdb.supabase.co", "SUPABASE_KEY": "sb_secret_…" }
```

**dreamnails.phaminh.com** (the salon)
```json
{ "SUPABASE_URL": "https://maqsptfpfdgcxielnnrz.supabase.co", "SUPABASE_KEY": "sb_secret_…" }
```

Keys live in the Supabase dashboard under Project Settings → API Keys.
Never commit this file; never send it to a browser.
