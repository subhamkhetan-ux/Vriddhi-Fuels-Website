# Vriddhi Fuels — Tanker Loading Log

A dead-simple, installable PWA for employees to fill diesel tankers in many small
loadings and keep a running account of each tanker's fill level. Built for a
low-literacy user: big buttons, big numbers, an animated tanker graphic, and a number-pad
keyboard for every quantity. English only.

> This is a **fourth, separate app** in this repo — independent of the Master
> Ledger at `/index.html`, the Indent PWA at `/app/`, and the Tally app at
> `/tally/`. It lives entirely under `/loading/` and is 100% static.

## Two modes

The app auto-detects its mode from [`config.js`](./config.js):

- **Cloud mode (recommended for multiple employees)** — fill in your Supabase
  URL + anon key and every employee signs in with a username + password. All
  phones share **one live set of tankers**: a save on one phone updates every
  other phone **instantly** (Supabase realtime), so everyone sees the same fill
  levels. History is **kept for the last 7 days only**. Each record stores **who
  did it**, and records use the **server's clock**, not the phone's.
- **Single-device mode (zero setup)** — leave `config.js` as its placeholders
  and the app runs with **no server and no login**, storing records in that one
  phone's browser storage (kept until you clear it). Fine for one shared phone.

## How it works (the fill model)

A tanker is filled in **many small loadings**, and each tanker keeps a **running
fill level that accumulates** across those loadings. It does **not** reset when a
chamber becomes full. When the whole tanker is full it is **sent for sale**; that
empties the tanker's gauge, and when it comes back it starts filling from empty
again.

1. **Home shows a card per tanker** drawn as an actual **tanker graphic**: the
   tank is split into its **numbered chambers** (widths scaled to each chamber's
   capacity) and each one **fills with diesel from the bottom**, animating up as
   the level changes. A tanker that is **being loaded right now** gets a **fuel
   nozzle** that drops in over the chamber last filled and **pours a live stream
   of diesel into it**, with that chamber outlined. It goes back to the plain
   graphic once **an hour passes with no loading** on that tanker (or it fills
   up, or it is sent for sale — the loading is over either way).
   Alongside it: the current litres (e.g. `5,485 / 11,955 L`),
   how much is **left to fill**, and per-chamber remaining. A full tanker glows
   green with a **FULL ✓** badge.
2. **Tap a tanker → Add diesel.** The same tanker graphic sits at the top of the
   screen and **fills live as you type** — the chamber you're typing into is
   outlined, the **nozzle swings over it and starts pouring** as soon as there
   are litres in the box, and the litres you're adding show as a brighter layer
   on top of what is already in that chamber. Below, each chamber shows what is
   **already in it**
   (`1,500 / 3,985 L`) with a two-tone bar — the darker part is what's already
   there, the brighter part is what you're **adding now**. The **Add litres** box
   is always blank; type the litres you're loading and **Left to fill** for that
   chamber updates live. A sticky summary shows the tanker total after this save
   and the litres left to fill. The home card also lists **left to fill per
   chamber** and for the **whole tanker**, so it's clear at a glance.
3. **Save** → a check-and-confirm screen → the tanker's fill goes up by that
   amount. Do this as many times as you like; it keeps adding.
4. **When the tanker is full, tap “🚚 Sent for sale”** (a bold green button on a
   full tanker; a quiet link on a partly-filled one). A box asks **whom it was
   sold to** — you **pick the customer from the list** (see *Customers & RTD*);
   confirm, and the tanker empties back to `0` — ready for the next round. The
   customer is saved on the record, shown in History and the Excel report, and
   counted as one **trip** in the trip report.

Every loading (`+ litres`) and every dispatch (`🚚 Sent for sale`) is kept in
**History** and the export, so the full account of what went into each tanker and
when it was sent out is preserved.

## Vehicles & chambers (fixed in the app)

| Vehicle | Chambers | Capacity each |
|---|---|---|
| **OD23A3710** | C1, C2, C3 | 3,985 L |
| **OR15R1110** | C1, C2, C3 | 3,985 L |
| **OR15R5510** | C1, C2, C3 | 3,985 L |
| **OR15R9360** | C1, C2, C3, C4 | 4,485 L |

These are just the **seed defaults**. Tankers are now managed in-app (see below),
so you add or remove vehicles without touching any code. In cloud mode the tanker
list is shared across all employees.

## Manage tankers & data (⚙)

The **⚙ Manage tankers & data** link at the bottom of the home screen opens a
small admin screen:

- **Tankers** — lists every tanker with its chambers and full capacity, each with
  a ✎ to **edit its chambers** and a 🗑 to remove it (with a confirm; past records
  stay in History).
- **✎ Edit chambers** — change a tanker's **chamber capacities without deleting
  it**: set each chamber's litres individually, use **Set all to** to apply one
  size to every chamber, or change the **chamber count** (− / +). Each row shows
  how much that chamber currently holds. Saving keeps the tanker's **current
  fill, all-time totals and history** untouched — only the sizes change. Two
  guards: a chamber that still holds diesel **cannot be removed** (empty or sell
  it first), and shrinking a chamber below what it already holds asks for
  confirmation (it will read as over-full until sold).
- **Add a new tanker** — type the vehicle number, pick the number of **chambers**
  (− / +) and the **litres per chamber**, then **Add tanker**. It appears
  immediately as a new card on the home screen (and, in cloud mode, on every
  employee's phone).
- **Danger zone → Clear all records** — deletes **all** loading & sale records
  (which also empties every tanker); the tankers themselves are kept. Requires
  typing `CLEAR` to confirm. In cloud mode this clears the shared data for
  everyone.

## Cloud setup (one time)

1. Create a **new** Supabase project (free tier) — do **not** reuse the indent
   or tally project.
2. In its **SQL Editor**, run [`../supabase/loading-schema.sql`](../supabase/loading-schema.sql)
   (safe to re-run). It creates the `loading_events` and `loading_vehicles`
   tables (seeded with the four tankers), the read policy that only exposes the
   last 7 days of records, the write functions (add / delete / clear / add-vehicle
   / remove-vehicle), realtime, and — if `pg_cron` is available — an hourly purge.
   Re-run it after pulling updates; it is written to be safe to re-run.
3. **Authentication → Users → Add user** for each employee: email
   `<username>@vriddhi.local` (e.g. `ramesh@vriddhi.local`), a 6+ char password,
   tick *Auto Confirm User*. Employees sign in with just the username + password.
4. Paste the project's **URL** and **anon/publishable key**
   (Project Settings → API) into [`config.js`](./config.js) and deploy.
5. On each phone: open `/loading/`, sign in, Add to Home Screen.

Every signed-in employee has equal rights (add / delete / export). The anon key
alone can read or write nothing — access is gated by sign-in and Row Level
Security, and all writes go through server functions.

## Admin & staff logins

Every login is either **Admin** or **Staff**. The database enforces it — a staff
phone can't get round it by any button or by calling the server directly.

| | Staff | Admin |
|---|---|---|
| Add diesel (loadings), 🚚 Sent for sale | ✓ | ✓ |
| ⛽ Diesel forecast: own diesel & refill verdict on each tanker and at sale | ✓ | ✓ |
| History — last 7 days, view only | ✓ | ✓ (+ delete) |
| End Day (5:30–7:30 AM) | ✓ | ✓ |
| 🔔 Push notifications on their phone | — | ✓ |
| Reports & Excel, chamber log, 🚚 Trips per tanker, ⛽ Mileage, 📈 Trends | — | ✓ |
| Edit / delete anything: records, tankers, chambers, customers, settings, Clear all | — | ✓ |
| Staff logins: change passwords, add logins, make admin, log out all staff | — | ✓ |

Any login not marked admin is staff. A staff phone shows only the tankers and
Recent / History (no ⚙ page, no notifications); the signed-in line shows
**Admin** or **Staff**.

### One-time setup (Supabase dashboard of the loading project)

1. **SQL Editor** → run [`../supabase/loading-schema.sql`](../supabase/loading-schema.sql) (safe to re-run).
2. **Make yourself admin** — in the SQL Editor run, with your own username:

   ```sql
   insert into public.loading_roles (email, role)
   values ('yourusername@vriddhi.local', 'admin')
   on conflict (email) do update set role = 'admin';
   ```

   Capital letters don't matter (`SKhetan@…` and `skhetan@…` are the same
   login). Until an admin exists, everyone is treated as staff and the home screen says
   *“No admin login is set up yet”*.
3. **Edge Functions → Deploy a new function** named `loading-admin`, pasting
   [`../supabase/functions/loading-admin/index.ts`](../supabase/functions/loading-admin/index.ts)
   (or `supabase functions deploy loading-admin`). No secrets needed. This is
   what lets the app change passwords and add logins.
4. Sign out and back in on your phone — you'll see **Admin** next to your name.

### Changing the logins (in the app, as admin)

**⚙ Manage tankers & data → Staff logins** lists every login with its role and
last sign-in.

- **Change a password** — tap **🔑 Password** next to the login, type the new
  password twice (6+ characters). You're then asked whether to **also log out
  all staff phones** — say OK so nobody stays signed in with the old password.
- **Log out all staff devices** — the red button. Every staff phone drops to the
  sign-in screen straight away (*“You were signed out by the admin”*) and must
  sign in again. Admin phones stay signed in.
- **Add a login** — username + password + Staff/Admin → **Add login**. Staff
  sign in with just the username and password.
- **Make admin / Make staff** — switch a login's access (you can't remove your
  own admin access).
- **Remove a login completely** — Supabase dashboard → **Authentication →
  Users** → delete the user (then press *Log out all staff devices*).

Changing a password alone doesn't end sessions that are already signed in —
that's why the app offers to log out all staff at the same time.

How the logout works: the admin's button stamps a *staff sign-out time*
(`loading_auth_state`). Any staff session that signed in before it is refused
by every read and write, and each phone notices instantly (realtime) and shows
the sign-in screen.

> Before step 1 is done the app behaves exactly as before (everyone can do
> everything); the roles start applying the moment the schema is updated.

## Notifications (optional)

**Admin phones only.** An admin can get a push alert **on their own phone**
when a tanker changes state — whether a staff member or another admin pressed
the button — **except on the device that pressed it**, which already knows.
Staff logins never register for or receive notifications (the database
refuses them), but what staff do still alerts the admins:

| Alert | When |
|---|---|
| 🛢️ **`<tanker>` — loading started** | the first diesel goes into an empty tanker |
| 🔄 **`<tanker>` — loading resumed** *after Nh idle* | a loading lands on a part-filled tanker whose previous loading was **3+ hours** ago |
| ✅ **`<tanker>` — tanker full** | a loading fills the last of it |
| 🚚 **`<tanker>` — sent for sale** | it is dispatched (includes the sold-to note) |

**One save sends at most one alert**, in that order of importance: *full*
beats *started* beats *resumed*. So a tanker filled in one go is announced
once (as *full*), and the first diesel into an empty tanker is a *start* even
if it stood idle for days — a *resume* is specifically a part-filled tanker
being picked up again.

The litres are read from the database by the server, so the text can't be
faked by a phone, and the idle time on a *resumed* alert is measured from the
database's own clock (the gap between the last two loadings), not sent by the
phone. Turn it on per phone under **⚙ Manage tankers &
data → Notifications → 🔔 Turn on notifications**; signing out of a phone
detaches it again.

Alerts go to every admin phone **except the device that raised them** — by
device, not by account, so two phones on one admin login still notify each
other. Any phone, staff or admin, **still triggers alerts on the admins'**
phones; it just doesn't receive any itself unless it is an admin's phone with
notifications turned on. If a login is changed from admin to staff, its
phones are detached automatically.

> **iPhone:** web push needs **iOS 16.4+** and the app **added to the Home
> Screen** — Apple does not deliver push to a page open in a Safari tab. The
> permission prompt only appears on a real tap, which is why it's a button.
> Android/Chrome works either way.

### Checking it works

Once a phone is switched on, **⚙ → Notifications → Send a test notification**
sends one to *that same phone* and reports what came back, so a single person
can prove the whole chain end to end. The toast tells you which part failed:

| Toast | What it means |
|---|---|
| *Test sent ✓* | Everything works. The notification should appear shortly. |
| *This phone isn't registered* | The subscription didn't save — turn notifications off and on again. |
| *Push rejected: 403…* | The VAPID keys don't match. The `VAPID_PUBLIC_KEY` in `config.js` and the `VAPID_PRIVATE_KEY` secret must be from the **same** generated pair. |
| *Server error: VAPID keys not set* | The function's secrets are missing or misnamed. |

The `loading-notify` function's **Logs** tab also prints one line per call —
`event=… recipients=N` then `sent=… failed=…` — so you can see whether anyone
was found to notify and whether the send itself failed.

Leave `VAPID_PUBLIC_KEY` in [`config.js`](./config.js) as its placeholder and
the app simply runs **without** notifications — everything else is unchanged.

### Turning it on (one time, all in the Supabase dashboard)

1. **Generate a VAPID key pair** — e.g. `npx web-push generate-vapid-keys`.
   The **public** key goes in `config.js`; the **private** key never leaves
   Supabase.
2. **Re-run** [`../supabase/loading-schema.sql`](../supabase/loading-schema.sql)
   in the SQL Editor (safe to re-run). It adds the `loading_push_subs` table and
   the register/forget functions.
3. **Edge Functions → Deploy a new function** named `loading-notify`, pasting
   [`../supabase/functions/loading-notify/index.ts`](../supabase/functions/loading-notify/index.ts).
   (Or `supabase functions deploy loading-notify` with the CLI.)
4. **Set its secrets** — `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
   `VAPID_SUBJECT` (e.g. `mailto:you@example.com`).
5. Paste the **public** key into `config.js` as `VAPID_PUBLIC_KEY` and deploy.
6. On each phone: open `/loading/`, sign in, **⚙ → 🔔 Turn on notifications**.

### What's kept vs. what's trimmed after 7 days

Only the **detailed transaction rows** (the chamber-log / per-loading history) are
trimmed to the **last 7 days** — that's what would otherwise pile up. Enforced
three ways: the read policy only exposes the last 7 days, every save deletes older
rows, and (if `pg_cron` is present) an hourly purge.

**What is kept permanently** (and takes almost no space):

- **Each tanker's current fill** — stored as persistent state on the tanker row
  (`loading_vehicles.fill`), updated on every load and sale. So a tanker that was
  loaded but **not yet sold does not reset to 0** when its detailed load rows age
  out of the 7-day window. (This was the bug — the fill used to be re-derived
  from the events and collapsed to 0 once they were purged.)
- **All-time litres loaded and litres sold** per tanker (`total_loaded`,
  `total_sold`), shown under **Reports → All-time totals** and in the Excel.

So you keep the running fill and the lifetime totals forever, and only lose the
line-by-line detail older than a week.

**Kept for good:** the **trips** — every "Sent for sale" with its *Sold to*,
litres and who (trip report, and **Every sale** below).

**Kept for 6 months** — enough to see the trends: the **refills / stock
checks** (mileage, trends). Older ones are dropped automatically, except each tanker's newest entry with a known stock and
everything after it, so the *diesel in its tank* estimate never loses its
starting point.

> A tanker's current fill is computed from its loadings since its last
> **dispatch**, all within this 7-day window — which is fine because a fill →
> sale cycle takes far less than a week. (If a tanker were left partly filled for
> more than 7 days, the oldest loadings would age out of the window.)

## Records & backup

- Every record stores the **date, time, vehicle, type (Load / Sent for sale),
  per-chamber litres, total**, and (cloud mode) **who did it**.
- **History** (“View all”) groups records by day and shows each loading as
  `+ litres` and each dispatch as `🚚 Sent for sale`, with a per-day loaded
  total. You can delete a wrong entry (with a confirm); the tanker's fill
  recalculates automatically.

## Business day & “End Day”

The financial day does **not** end at midnight — a business day runs from the
**morning shift change (~7:30 AM) to the next morning's**. So a record's business
date is the date of the shift it was loaded in, and the whole night belongs to
the day that started that morning.

- The home screen shows the **current business day** (e.g. *Current business day —
  30 Jul 2026*) and its open total. The boundary is **7:30 AM**: a record loaded
  before 7:30 AM counts under the **previous** day; from 7:30 AM onward it counts
  under that day. (So the transactions from ~7 AM on the 30th through the early
  hours of the 31st all fall under **30 Jul**.)
- **End Day button — only in the 5:30–7:30 AM window.** During the morning
  shift-change window staff can hand over early by pressing **🔒 End Day**, which
  closes the day that's ending and **starts the new one from that moment**
  (records loaded after the press go to the new day). Outside 5:30–7:30 AM the
  button is hidden — you can't accidentally end the day in the afternoon. It's
  **final** and **once per day** (a second press, even from another phone, is
  refused). Times are **IST**.
- **Automatic fallback:** if nobody presses End Day, the day ends **automatically
  at 7:30 AM**. The auto-close is timestamped at exactly 7:30 AM (the deadline),
  so business dates are identical no matter when it actually runs — when the app
  is next opened, on its timer, or (optionally) an hourly `pg_cron` job on the
  server. Opening the app after a gap catches up any missed days automatically.
- History, the chamber log, reports and the Excel all group by this **business
  date**. Open records are grouped under **“Current day — open · <date>”** and
  flagged **Open** in the export's *Day ended?* column; the Excel date column is
  the **Business date**.

## Reports (📊) — data-rich Excel

**Reports** (button on the home screen and in History) shows headline figures
for a chosen **date range** (From/To, with **Today / 7 days / All** presets):
litres loaded, loadings, litres sold, tankers sold, and a per-tanker breakdown
with each tanker's current fill.

**View chamber log (detailed)** opens an on-screen log for the chosen range —
one row per **chamber per transaction** (chamber, vehicle, time, `+`litres loaded
or `−`litres emptied on a sale, with the sold-to name), newest first and grouped
by day. It's the same breakdown as the Excel "Chamber log" sheet, right in the app.

**Download Excel report** produces a multi-sheet `.xlsx`
(`Vriddhi_Tanker_Report_<from>_to_<to>.xlsx`) built with
[SheetJS](https://sheetjs.com) — it **falls back to a CSV** of the transactions
if the device is offline. Sheets:

| Sheet | What's in it |
|---|---|
| **Summary** | Report metadata + headline totals + current fill per tanker |
| **Transactions** | The full statement — one row per event: *Date · Time · Vehicle · Type · C1–C4 · Total · **Tanker after** (running fill) · **Remarks / Sold to** · By*, with an auto-filter |
| **Chamber log** | One row **per chamber per transaction** — *Date · Time · Vehicle · Chamber · Litres · Type · Remarks · By* — the easiest layout to reconcile chamber by chamber |
| **By tanker** | Per-vehicle: capacity, loadings, litres loaded, tankers sold, litres sold, current fill, status |
| **By day** | Per-day loadings / litres loaded / tankers sold / litres sold |

Litres columns are thousands-formatted and columns are pre-sized. Since cloud
data only spans 7 days, download a report weekly to keep a longer archive.

> In **single-device mode** the records live in that phone's browser storage;
> clearing the browser's site data or uninstalling erases them, so the periodic
> CSV export is the backup. In **cloud mode** the data lives in Supabase and is
> intentionally trimmed to the last 7 days.

## Trips per tanker (🚚)

**Trips per tanker** on the home screen counts how many times each tanker was
**sent for sale** in a date range — **one sale = one trip**. It opens on the
**current month**; ‹ › step a month at a time, or set your own From / To dates.
Dates are business days (7:30 AM → 7:30 AM), the same as everywhere else.

- Tiles: total trips, total **RTD km** and litres sold.
- One card per tanker: its trips and RTD km, broken down by customer
  (`Shyam Metalics — 3 × 36 km = 108 km`). **Show trips** lists each trip with
  a ✎ to correct the customer if the wrong one was picked.
- A sale whose customer isn't in the list (e.g. an old free-text remark) is
  flagged ⚠ and counts 0 km until a customer is picked with ✎.
- **OD15AF5510 is not counted** in this report (`TRIP_EXCLUDE` in `index.html`).
- **Download trip report (Excel)** — sheets *Trips by tanker* (tanker ×
  customer matrix with totals), *Trip list* and *Customers (RTD)*.

Trips are stored **for good** in their own table (`loading_trips`), so the
monthly report works even though the detailed loading history is trimmed to 7
days. Deleting a sale from History (within those 7 days) removes its trip too.

**🗂️ Every sale — all tankers, all dates** (under the trip report) downloads
every sale on record as Excel — *All sales* (business date, time, vehicle,
**Sold to**, RTD, litres, who) and *By tanker & customer* (trips and litres) —
including OD15AF5510. The record starts when `loading_trips` was set up in
Supabase (4 Oct 2026, back-filled with the 7 days before): earlier sales were
only in the 7-day loading history and are gone, unless they are in an Excel
report downloaded at the time (*Transactions* → *Remarks / Sold to*).

## Customers & RTD (⚙)

The **Sold to** choices are the customer list under **⚙ Manage tankers & data →
Customers & RTD**, seeded from the RTD master sheet. Picking one is required for
every tanker except **OD15AF5510**: its mileage goes by the dispenser meter (the
litres sold), not by km, so its customer is optional — tap a picked customer
again to clear it. It is not in the trip report either.



| Customer | RTD km / trip |
|---|---|
| Shyam Metalics | 36 |
| SMC Unit 1 | 16 |
| SMC Unit 2 | 20 |
| Orissa Metaliks | 30 |
| Lakhanpur Group Companies | 70 |
| DBL - Siarmal | 140 |
| Aryan Ispat & Power Private Ltd. | 30 |

RTD = round-trip km per trip. Add a customer with its own RTD, or pick
**Group company of** an existing customer: it joins that group and takes the
group's RTD. **Group companies always share one RTD** — changing the RTD (✎) of
any of them changes the whole group. In cloud mode the list is shared by all
phones (`loading_destinations`).

## Mileage calculator (⛽)

**The screen, top to bottom:**

- **Fleet now** — every tanker on one card: its mileage now (km/L, or L/L for
  OD15AF5510), a bar of the diesel in its own tank, when it was last dipped, and
  a badge (✓ steady · ⚠/⛔ mileage drop · ✎ check · settling). Above the list,
  the few things worth knowing first: mileage drops in the last 30 days (with
  the % and the extra litres), tankers to refill before / after their next
  trip, entries to check, and tankers not dipped for 7+ days. Tap a tanker to
  open its details.
- **The tanker's details** — its own alerts, then four tiles (mileage now,
  last stretch vs normal, own diesel now with the refill verdict, last entry)
  and a chart of its mileage per stretch over the last 6 months.
- Folding sections: **➕ Add a refill or stock check** (opens by itself for a
  tanker with nothing saved yet), **🧾 Refills & stock checks** (the latest 2 as
  cards, each with **✎ Edit** and 🗑; every earlier entry in a table below —
  date, reading, dip, litres filled and **≈ in tank after** = dip + filled, a
  stock check showing *check*; read-only), **🗓️ Period summary** and
  **ℹ️ How it's worked out**.
- **✎ Edit** corrects one of a tanker's **latest 2** entries in place — date &
  time, reading, litres filled, dip (Anguls or litres) and note — and the
  mileage is worked out again; 🗑 deletes one. Older entries are settled history
  and can't be changed or deleted (the database refuses it too). An edit can't
  turn an entry into a copy of another, and more than the tank holds asks first.
- **How much is kept:** 6 months of refills / stock checks, and every trip for
  good. That is well under 1 MB a year for the whole fleet (about 250 bytes per
  entry), far inside Supabase's free 500 MB.
- 📈 Trends & alerts and 🛢️ Fuel in tank now sit side by side under the fleet card.

**Start here — 🛢️ Fuel in tank now (all tankers).** Enter, for every tanker, its
reading right now (odometer, or the dispenser meter for OD15AF5510) and the
fuel in its tank (Anguls or litres; litres only for OD15AF5510). Each is saved
as a **stock check** — no diesel added — and the next fill is measured from it:
diesel used = stock entered − dip at that fill. Use it any time you want a
fresh, exact starting point.

Every tanker is run to almost dry and then refilled. At each refill enter:

- **Previous refill** — date & time, the reading and the litres filled then (and
  the dip then). It is filled in automatically from the last saved refill;
  for the very first use type it in (e.g. yesterday's fill). If you change it,
  it is saved as an extra refill record so the chain carries on.
- **Now** — date & time, the reading now, the **dip** before refilling and the
  litres filled now.

The dip has two linked boxes — **Anguls** and **Litres in tank** — type either
and the other follows. **1 Angul = 16 L** by default; tap **✎ change** next to
it to set your dip stick's figure (shared by all phones; the litres are stored
with each refill, so changing it later never rewrites past mileage).

Once the odometer is typed, the dip boxes are **pre-filled with the stock the
tank should have** if the tanker ran at its normal mileage (previous litres +
previous stock − km run ÷ normal km/L). Change them to the actual dip; the app
then shows how far the dip is from what was expected (**↺ use expected** puts
the estimate back).

**Diesel used** = litres filled at the previous refill + stock left then − stock
left now (no dip = taken as dry).

| Tanker | Reading | Mileage |
|---|---|---|
| All tankers except OD15AF5510 | **Odometer** (km) | km run ÷ diesel used = **km/L** |
| **OD15AF5510** (engine mostly on, dispenses with its own pump) | **Fuel-dispenser meter** (litres) | litres dispensed ÷ diesel used = **L dispensed per L**, plus diesel per 1,000 L dispensed |

For odometer tankers the calculator also shows the **trips** in between and
their **RTD km**, and **Extra km** = km run − RTD km (running beyond the
delivery trips), with the diesel that extra running took. The **Period summary**
(month by default) gives the same figures from the opening to the closing
refill of the period, and **Refills** lists every saved refill with its mileage
(🗑 to delete a wrong one, flagged ones marked ⚠ / ⛔). Refills are kept
permanently (`loading_fuel_logs`).

## Mileage trends & alerts (📈)

**📈 Trends & alerts** at the top of the Mileage screen (it shows how many refills
were flagged in the last 30 days) opens a report for 3 / 6 / 12 months, all, or
any From / To:

- **Tiles** — stretches measured, mileage drops (sharp), fleet km/L, extra
  diesel burnt in the drops, and extra km beyond trips.
- **⚠ Mileage drops** — every stretch between two fills where the tanker burnt
  more diesel than usual for the distance (or, for OD15AF5510, for the fuel it
  dispensed): a possible **engine fault or diesel theft**. Worst first, with
  the drop %, the extra litres and the numbers behind it.
- **✎ Check the readings** — figures that can't be right (reading not going
  up, diesel used ≤ 0, mileage far above normal). These are entry mistakes to
  correct, not suspicion.
- **Mileage by tanker** — km/L of each odometer tanker against the fleet
  average; OD15AF5510 has its own L dispensed / L tile.
- **Tanker detail** (pick a tanker) — mileage per refill with the tanker's
  normal band shaded and flagged refills marked; diesel used above / below
  normal per refill; km per refill split into trip (RTD) km and extra km.
  Hover or tap any chart for the figures.
- **Monthly mileage** — month × tanker table with ▲▼ change vs the month before.
- **Download mileage analysis (Excel)** — *Alerts*, *Refill analysis* (every
  computed figure and the reason for each flag) and *Monthly* sheets.

**How mileage is worked out (robust).** A refill records the dip taken
**before** filling plus the litres filled; a stock check is a dip alone. Every
entry with a dip is a *measuring point* (OD15AF5510: a refill counts as run
dry); a refill saved without its dip still adds its litres but isn't a point.
Between any two points, diesel used = litres filled in between + stock at the
first − stock at the second.

- **Current mileage** — over the newest 12 points, every pair of points gives a
  mileage; pairs that are physically impossible (outside 0.5–10 km/L, or 2–2,000
  L dispensed per litre for OD15AF5510: typing slips, an odometer gone back)
  are thrown out, and the rest give a **distance-weighted median**. Long spans
  weigh most, so a dip that is an Angul out barely moves it, and one bad entry
  is outvoted. It firms up with every refill and stock check and follows the
  tanker as it changes. Shown as *steady* or *still settling*; nothing is shown
  until there's at least 100 km (3,000 L) and 25 L of sound data.
- **Mileage drops** — the points are joined into stretches of at least 150 km
  (5,000 L dispensed); each is compared with the mileage from the points
  before it. A drop is reported only if the extra diesel is also more than the
  readings could be off by — 2 Anguls (32 L) for a ⚠ drop, 3 Anguls for ⛔
  (OD15AF5510: 18 L / 25 L — it's a Bolero with a ~50 L tank, refilled near
  dry, and "near dry" can leave up to ~10 L in it).
- **Check the readings** — impossible stretches (litres typed ×10, an odometer
  with an extra digit or going back, diesel used ≤ 0) are listed separately and
  never counted as drops.
  Each step between two neighbouring entries is also checked on its own:
  more than a full tank (365 L; OD15AF5510 50 L) gone beyond what the km could
  burn, or stock rising with nothing filled, is listed with the arithmetic
  (*X L in tank on … + Y L filled since − Z L on …*) and the stretch restarts
  after it, so one wrong entry spoils only itself.
- **A stock check that already includes a refill** — a *Fuel in tank now*
  entered after a refill, but dated before it (same odometer, its stock =
  that refill's dip + litres, or more than the tank with it), would count the
  refill's litres twice. It is recognised and not used as a point (the entry
  list says so — check its time), in the app and in the database alike.
- **An entry saved twice** (same reading, litres and dip within a day — a
  double save, two phones) is counted once and listed to delete; otherwise its
  litres would look like a theft. Saving the same entry again is refused.
- **More than the tank holds** — dip + litres over the tank (365 L; OD15AF5510
  50 L; with 10 % and the dip tolerance to spare) can't be right. The entry is
  listed, isn't used to measure, and no drop is judged across it; saving one
  asks first, and the calculator says so while typing.
- **Dips follow the Angul size.** A dip read in Anguls is always Anguls × the
  current litres per Angul, so correcting that setting re-reads every dip (the
  list shows "saved as … L at an earlier Angul size"). A figure typed in litres
  is kept in litres.
- **Correcting the previous refill** (same reading, same kind of entry, within
  a day) *replaces* the saved one instead of adding a second copy.
- **The pre-filled expected stock** is the app's estimate, not a reading:
  saving it unchanged asks *"does the dip stick really show this?"* first.
- **Diesel in the tank now** never shows more than the tank holds, and a
  re-saved entry doesn't hide the trips sold since the original.

Tested in `tests/loading_web` (`node --test tests/loading_web/*.test.mjs`):
simulated tankers dipped in whole Anguls, with daily stock checks, typos, a
missing dip, a backdated entry and an 80 L theft — mileage within 5% of the
truth in all 160 random runs, no false drops, every theft caught; the database
gives the same figures as the app.

| | ⚠ Mileage drop | ⛔ Sharp drop |
|---|---|---|
| Mileage below the tanker's normal | by more than the alert % (15% by default) **and** ≥ 2 Anguls extra | by more than twice the alert % **and** ≥ 3 Anguls extra |

Extra km beyond the trips' RTD is shown in the tiles and the km chart, but is not
an alert.

The alert % is set under **Alert settings** at the bottom of the report
(shared by all phones, `loading_settings`).

## Diesel forecast at the pump (⛽)

When a tanker is marked **🚚 Sent for sale** (as it leaves the pump), the sale
sheet shows — as soon as the customer is picked — what the trip will burn from
the tanker's **own** diesel tank and whether to refill:

- **✓ Enough diesel** — and roughly how many more trips like this it can do.
- **⚠ Refill when it returns** — less than the reserve would be left after.
- **⛔ Refill before dispatch** — the tank can't cover this trip.

How it is worked out (in the database, so staff see only the answer):

- **mileage** = the tanker's current mileage (above; for OD15AF5510 litres
  dispensed per litre),
- **in its tank now** = the stock at its last dipped entry + every litre filled
  since − the distance since ÷ mileage − what the trips sold since the last
  entry burn (their customers' RTD km ÷ mileage),
- **this trip** = the customer's RTD km ÷ mileage (OD15AF5510: litres sold ÷
  dispensed-per-litre),
- the **reserve** is set by admin under Trends → Alert settings, separately
  for the **big tankers** (365 L tanks, 40 L by default) and for
  **OD15AF5510** (~50 L tank, 10 L by default).

Every tanker card on the home screen also shows **⛽ Own diesel ≈ … L**, and
says when the tanker needs its own tank filled — wherever it goes next, so it
is judged against the **longest trip in the customer list** (DBL - Siarmal,
140 km; OD15AF5510: its typical sale — the median litres of its last 10
sales, as a full 15,000 L load would need several of its 50 L tanks):

- **⛔ refill before this trip** — the tank can't cover it
- **⚠ refill after this trip** — less than the reserve would be left
- nothing extra — enough diesel for the next trip

Staff see both the card line and the sale sheet (never the mileage data
behind them). The line shows **from the tanker's first refill on** — it
doesn't wait for a settled mileage:

- with a settled mileage (two dipped entries ≥ 100 km apart) it goes by that;
- until then, by the **fleet's mileage** — the median of the other big tankers'
  settled mileage (never for OD15AF5510). A tanker's own first figure is far
  less sure: over a short stretch one Angul of dip error moves it a lot, and a
  refill saved without its dip counts as dry, so whatever was really left
  makes it read too high (= "enough diesel" when it isn't);
- with no fleet figure either, by its own **first figure** — as the calculator
  works it out (a refill without its dip counted as dry) — once it spans
  300 km and 100 L;
- with no mileage at all, the tank is still shown while nothing has been burnt
  since the last entry (dip + litres, no km on the odometer, no trip sold);
- with no dipped entry yet, the tank is counted from the last refill as run
  dry (its litres).

An estimate without the tanker's own settled mileage says **· rough** on the
card (and on the sale sheet / Mileage screen), until the tanker's own mileage
settles. The settled mileage itself, the drops and the checks are unchanged.
Saving, correcting or deleting a refill / stock check updates the home cards at
once. Sales whose customer isn't in the list count 0 km (the forecast says so).

> **Cloud mode:** re-run [`../supabase/loading-schema.sql`](../supabase/loading-schema.sql)
> once for the early estimate (the home cards come from the database).

## Look

**Light or dark.** The ◐ button in the header and **⚙ Manage tankers & data →
Look on this phone** (Auto / Light / Dark) pick the look. **Auto**, the default,
follows the phone's own light / dark setting and switches live when it changes
(e.g. at sunset). A tap on the header button always changes what's on screen:
Auto → the other look → the phone's look → Auto. The choice is this phone's own
(not shared), and is set before the first paint, so there's no flash. The
orange header, the tanker livery and the number plates are the same in both;
the charts redraw in the dark palette.

**Tankers** are drawn in the Decanting app's livery — navy band with
*VRIDDHI FUELS · capacity*, white body, orange band with a yellow pinstripe and
the chamber numbers, navy cab — and each chamber is a large **sight glass**
whose diesel (HSD green, the same green as the nozzle's jet) rises with the fill. **Tanker numbers** are shown as
Indian HSRP plates (white plate, black rim, blue IND strip, "OR 15 R 1110").

The app uses the Decanting app's frosted-glass language in light mode —
translucent cards over a warm, orange-lit background and an orange glass header
with a **Live / Offline** pill — and the Decanting app's typefaces (**Sora** for
headings and figures, **IBM Plex Mono** for number plates, the phone's own font
for body text), laid out with iOS patterns: large screen titles, grouped lists
with hairline separators, segmented date presets and bottom sheets. Motion is limited to a light press effect and the sheet
sliding up; per-card blur was dropped (invisible over the smooth backdrop but
costly on budget phones).

> **Cloud mode:** re-run [`../supabase/loading-schema.sql`](../supabase/loading-schema.sql)
> in the SQL Editor once to create the customer, trip, fuel-log and settings tables (safe
> to re-run; it also back-fills trips from the sales still in the 7-day window).
> Until then the app works exactly as before — the sale box uses the built-in
> customer list and the two new screens say the database needs the update.

## Install on the phone

It's static — host the `/loading/` folder anywhere (it deploys with the rest of
this repo on GitHub Pages, at `/loading/`). On the phone, open it in
Chrome/Safari and **Add to Home Screen**. After that it opens full-screen like a
normal app. Single-device mode works fully offline; cloud mode needs internet to
sign in and sync.

## Notes

- In cloud mode, times use the **server's clock**; in single-device mode, the
  phone's clock.
- Quantities accept **decimals up to 2 places** (e.g. `600.75`) via a decimal
  keypad; values are rounded to 2 dp. If a chamber's already-in amount plus what
  you're adding would exceed its capacity, the bar turns red with an “⚠ Over full”
  warning, but it still lets you save (in case of a genuine top-up).
- The **🚚 Sent for sale** button appears once a tanker has any diesel in it —
  bold and green when the tanker is full, a quiet link when it's only partly
  filled. It always asks for confirmation before emptying the tanker.
