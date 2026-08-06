# Payment Entry — cloud sync setup (optional)

Cloud sync keeps the **exported-entries history** and the **customer list**
consistent across all your devices in real time, and makes duplicate exports
impossible across devices (not just on one phone). It's optional — without it
the app runs entirely on-device.

You'll need a free [Supabase](https://supabase.com) project. It can be the same
project the other Vriddhi apps use or a new one — the pay app uses its own two
tables (`pay_entries`, `pay_masters`) and won't touch anything else.

## 1. Run the schema

In the Supabase dashboard open **SQL Editor**, paste the contents of
[`supabase/pay-schema.sql`](../supabase/pay-schema.sql), and **Run**. It creates:

- `pay_entries` — the shared exported-payment history (unique `entry_key`, so the
  same payment can only exist once, on any device),
- `pay_masters` — the shared customer-list snapshot,
- `pay_purge_old()` — deletes history rows older than 7 days,
- RLS policies + realtime so every device stays in sync.

It's safe to re-run.

## 2. Add your keys to `config.js`

From **Project Settings → API** copy the **Project URL** and the **anon public**
key, and paste them into [`pay/config.js`](./config.js):

```js
window.VRIDDHI_PAY_CONFIG = {
  SUPABASE_URL: "https://YOURPROJECT.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...your anon key...",
  DATA_URL: "…",   // unchanged
};
```

The anon key is meant to be public; access is limited to these two tables by the
RLS policies in the schema. Never put the `service_role` / `sb_secret_` key here.

That's it. Reload the app — the header shows **☁ synced**. Export on one device
and it appears (and is blocked) on the others within a moment.

## Notes

- **No login.** This is a personal owner tool, so the schema lets the anon key
  read/write the two pay tables. If you'd rather lock it to signed-in users,
  change `to anon, authenticated` to `to authenticated` in the schema and add
  Supabase Auth to the app.
- **7-day auto-clear** happens three ways: the client prunes on load, filters
  reads to the last 7 days, and calls `pay_purge_old()`. To also purge nightly
  regardless of use, enable `pg_cron` and uncomment the `cron.schedule(...)` line
  at the bottom of the schema.
- **Offline** still works: the app uses its on-device copy and reconciles with
  the cloud when it reconnects.
