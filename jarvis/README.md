# Jarvis — one assistant for every Vriddhi app (`/jarvis/`)

Talk or type to Jarvis and it works the other apps for you. You can ask for:

| Say (or type) | Jarvis does |
|---|---|
| *Outstanding list* / *get me the outstanding balance for all* | Everyone who owes, largest first. You get the **Ledger app's own picture**, with Share (WhatsApp) and Download buttons. |
| *Outstanding of SMC* / *SMC ka baki kitna hai* | That customer's outstanding card (the same picture as the Ledger's *Share outstanding*): balance, pending bills, PO-wise |
| *Statement of Keshav* / then *his statement*, *and Demo Power?* | Their ledger as A4 pictures |
| *Sales today*, then *and yesterday?*, *last month* | Sales, litres, earnings, collections |
| 📎 a screenshot of the tank screen + *update stock* | Reads it with **the Decant app's own screenshot reader**, shows you each tank's stock, and saves it in Decant **after you tap Save** |
| *Tank 2 stock 11630* / *tank 3 dip 120 cm* | Saves one tank's stock in Decant (after you confirm) |
| *Tank stock* · *trucks to decant* · *decant report* | From the Decant app |
| *Monitor XtraPower account Ember Coal* / *stop it* | On the Mac: switches that account on (or off) in the XtraPower monitor, opens its Chrome window if it's closed, and starts the monitor (or stops it once no account is watched) |
| *XtraPower status* · *stop XtraPower monitoring* · *XtraPower logs* | The monitor on the Mac |
| *Fleet status* · *tankers* · *payments* | Fleet, Loading and Payments apps |
| *Open decant app* | A button to open any app |

You can also ask for several things at once (*tank stock and sales today*). When a name could mean more than one customer or account, Jarvis asks which one; tap it or say *the second one*. It understands English and Hinglish, and spelling slips in command words (*tankk stok*).

**Voice:** tap the 🎤 to speak, and Jarvis reads its answers aloud. Turn on *Hands-free* in ⚙ Settings and it listens again after each answer. This uses the phone's own speech features (Chrome or Safari) and needs no other service.

## No AI needed

Jarvis's **built-in brain** (`js/engine.js`) runs it all on its own. It is the default. It needs no AI service, no subscription and no API key. It costs nothing, and nothing leaves your own apps' databases.

A Claude AI brain (`js/brain.js`) is an **optional extra** for free-form questions. It is **off** unless you switch it on in ⚙ Settings → Brain. It uses the Anthropic API, which is pay-per-use and separate from any Claude plan. If it is ever unavailable (no credit, no internet, not set up), Jarvis answers with the built-in brain instead and says so. Setup is at the end of this file.

## How it works

```
 Phone / computer (/jarvis/)                       Mac (jarvis/bridge/)
 ───────────────────────────                       ────────────────────
 chat + voice                                      bridge-mac.sh start
   │                                                 │  every 3 s: anything for me?
 built-in brain (or Claude, if on)                   │
   │ picks a tool                                    │
   ├─ Ledger  ─ ledger/js/* (its own rules + pictures) ─▶ ledger Supabase
   ├─ Decant  ─ decant/js/* (its store, its reader)    ─▶ decant Supabase
   ├─ Fleet / Loading / Payments ─ their own code      ─▶ their Supabase
   └─ XtraPower / Mac scripts ─▶ jarvis_commands (ledger Supabase) ─▶ bridge runs
                                    ▲                    xtrapower.manage + monitor-mac.sh
                                    └──── result ◀───────┘
```

- **Same code as the apps.** Jarvis imports each app's own modules, so its figures and pictures always match the app. Two pieces were moved so they could be shared: `ledger/js/outstanding.js` (the outstanding cards) and `readingFrom()` in `decant/js/core.js` (a tank reading).
- **Same logins.** Jarvis is on the same website as the other apps, so signing in to the Ledger (or Fleet) app on a phone also signs you in to Jarvis there, and the other way round. Your Jarvis login is your **Ledger login**.
- **Writes are confirmed.** Before anything is saved (tank stock) or run on the Mac (a script), Jarvis shows what it will do and waits for your tap.
- **The Mac runs only what it knows.** Jarvis queues a request; the bridge runs it only if it is one of its actions (XtraPower) or a script **you** listed in `jarvis/bridge/config.json` on the Mac. Nothing sent from the cloud is ever run as a command.

## One-time setup

1. **Open Jarvis:** `https://subhamkhetan-ux.github.io/Vriddhi-Fuels-Website/jarvis/` → *Add to Home Screen*. If you want to look around first, open `…/jarvis/?demo`: made-up data, nothing real is changed.
2. **Sign in** with your Ledger login (⚙ Settings → Logins). Sign in to Fleet and Loading there too if you want their answers.

That is enough for the Ledger, Decant, Fleet, Loading and Payments commands. For the Mac (XtraPower):

3. **The command queue:** in the **ledger** Supabase project, open SQL Editor, paste [`supabase/jarvis-schema.sql`](../supabase/jarvis-schema.sql) and Run. It is safe to run again, and only ledger members can use it.
4. **The Mac bridge:** in Terminal on the Mac:
   ```bash
   cd ~/Vriddhi-Fuels-Website
   git pull
   ./jarvis/bridge/bridge-mac.sh setup        # makes jarvis/bridge/config.json
   open -e jarvis/bridge/config.json          # put in a ledger member's email + password
   ./jarvis/bridge/bridge-mac.sh test         # ✓ Connected.
   ./jarvis/bridge/bridge-mac.sh autostart on # runs at every login, restarts if it stops
   ```
   - Best practice: give the bridge its **own** login. Add a user in the ledger project (Authentication → Users), then `select ledger_add_member('that email');`.
   - `config.json` is git-ignored and readable only by you. It also lists the **scripts** Jarvis may run on the Mac (payment agent status, Tally apps, …). Add or remove entries there; only these can ever run.
   - XtraPower itself must be set up as before (`./xtrapower/setup-mac.sh`, `xtrapower/config.json`).
   - The other commands: `start`, `stop`, `status`, `logs`, `autostart off`.

Jarvis's header shows **Mac online / offline**. If the Mac is off or asleep, Jarvis says so instead of waiting.

## Optional: the Claude AI brain

Only if you want free-form questions answered by AI. You need an Anthropic API key from console.anthropic.com. It is billed per use and is not part of a Claude Pro plan.

- **Simplest:** ⚙ Settings → Brain → *Claude AI — key on this device*, then paste the key. It is kept only in that browser.
- **Key kept in Supabase:** this works on every phone without pasting the key into each one. Deploy the Edge Function to the ledger project:
  ```bash
  supabase functions deploy jarvis-brain --project-ref <ledger project ref>
  supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref <ledger project ref>
  ```
  Then choose *Claude AI — cloud key*. Only signed-in ledger members can use it (`supabase/functions/jarvis-brain/index.ts`).

It uses Claude Opus 5.5, with Anthropic's automatic fallback model turned on (`fallbacks: "default"`) if a request is declined. *How hard to think* in Settings trades speed for depth.

## Files

| File | What |
|---|---|
| `index.html`, `config.js`, `manifest.webmanifest`, `icon.png` | The page. It loads the other apps' `config.js` files. |
| `js/app.js` | The screens: chat, pictures, confirmations, settings |
| `js/engine.js` | **The built-in brain:** follow-ups, choices, several requests, spelling |
| `js/quick.js` | Phrases → tools (English / Hinglish) |
| `js/match.js` | Finding the customer / account / app that was meant |
| `js/tools.js` | Every tool in one list |
| `js/conn/ledger.js` · `decant.js` · `mac.js` · `more.js` | The tools, using each app's own code |
| `js/brain.js` | The optional Claude brain (manual tool loop) |
| `js/voice.js` | Speech in and out |
| `js/session.js` | Logins shared with the apps |
| `bridge/` | The Mac bridge: `bridge.py` (loop), `actions.py` (the only things it runs), `supa.py`, `bridge-mac.sh` |
| `../supabase/jarvis-schema.sql` | The command queue (ledger project) |
| `../supabase/functions/jarvis-brain/` | The optional Claude proxy |

## Tests

```bash
node --test 'tests/jarvis_web/*.test.mjs'                 # brain, phrases, names, every tool on demo data, the Claude loop (faked)
python -m pytest tests/test_jarvis_bridge.py tests/test_jarvis_schema.py -q   # Mac bridge; queue on a local Postgres
```
