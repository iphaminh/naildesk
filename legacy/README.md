# legacy/ — the original local POS

The first version of the Dream Nails POS: a single-machine Node app with a
SQLite database in `legacy/data/salon.db`. It has been **superseded by
`cloud/`**, which is what runs the salon today. Kept for reference — in
particular `lib/importZota.js`, the original Zota customer import.

```bash
cd legacy && npm ci && node server.js   # http://localhost:3789
```

Nothing deploys from this folder.
