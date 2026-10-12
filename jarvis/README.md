# Jarvis — one assistant for every Vriddhi app (`/jarvis/`)

Talk or type to Jarvis, in English or Hinglish, and it reads and works every app for you. Your settings and recent conversation follow your Jarvis login to every device.

**No AI service is needed.** Jarvis's built-in brain understands complex questions on its own, with no subscription, no API key and no cost. A Claude brain is an optional extra that is off by default (see [the end of this file](#optional-the-claude-ai-brain)).

## What you can ask and do

| App | Ask / say | Does |
|---|---|---|
| **Across apps** | *Good morning* / *how's business* | Brief from every app: yesterday's sales, outstanding, tank stock, trucks, payments, credits to review, indents, fleet, tankers |
| | *Tell me everything about SMC* (or just *SMC*) | The customer in every app: outstanding card, this month's business, POs, payments, indents |
| **Ledger** | *Outstanding list* · *outstanding of SMC* | The Ledger app's own pictures, with Share (WhatsApp) / Download |
| | *Which bulk customers owe more than 5 lakh and haven't paid in 30 days?* | Filter and rank every customer: outstanding, sales, litres, earnings, payments; retail / bulk; above / below; no payment for N days; bulk bills older than N days; *who hasn't bought this month* |
| | *Top 5 customers by diesel litres this FY*, then *top 10*, *retail only* | Rankings (and changes to the last one) |
| | *Compare diesel sales this month vs last month* | Any two periods, with the split by product |
| | *How much petrol did SMC take in September?*, then *and diesel?* | One customer's business in a period |
| | *Statement of Keshav*, *his statement* | Their ledger as pictures |
| | *Pending bills older than 30 days* (or *… for SMC*) | Bulk pending bills, matched the Ledger app's way, with ageing |
| | *POs running low* · *add PO 4500/12 for SMC 20 KL* | PO litres left; add a PO (asks for anything missing) |
| | *Sales yesterday* · *bills on 5 Oct* · *rates this month* | Day / period sales, each bill, RSP changes |
| | *Daily screenshots* | Yesterday's ledger and bill pictures and the daily summaries, ready for WhatsApp |
| | 📎 the Tally DayBook (.xlsx) | Imports it like the Import tab |
| | *Payments not in the ledger* → *log them* | The Payments tab's "Log payments" |
| | *Which customers need a ledger name* · *ledger name for X is Y* · *is the ledger updated* | Customers and import status |
| **Decant** | *Tank stock* · *can I order 12 KL diesel?* · *trucks to decant* · *decant report* | Stock, room (and what to sell first), trucks waiting, variation |
| | 📎 the tank screen + *update stock* · *tank 2 stock 11630* · *tank 3 dip 120 cm* | Saved to Decant with **the Decant app's own reader**, after you confirm |
| | 📎 an IndianOil invoice PDF · *hide OD23U8210, not ours* | Adds the truck / hides an invoice |
| **Indents** | *Pending indents* · *place an indent for Keshav, diesel 500 litres* · *deliver IND-0012* · *cancel IND-0013* | The board; place on a customer's behalf; deliver (full or partial); cancel |
| | *Today's prices* · *set diesel price to 89.62* | Prices |
| **Payments** | *Payments* · *payments that need review* → *800 is from Keshav* | Recent credits; review and match a credit |
| | *Record payment 25000 from Keshav by cheque* · *log payments to Excel* | A manual entry; "Log to Excel" |
| **Fleet** | *Fleet status* · *how is 1003 doing* · *diesel recon* · *trips last month* · *SSFC balance* | Bulkers, one bulker, diesel allotted vs taken, trips, the SSFC account |
| **Loading** | *Tanker status* · *add 2000 L to OR15R1110* · *3710 sent for sale to Keshav* · *tanker trips* | Fill levels, record a loading, sent for sale |
| **Tally** | *Tally vouchers today* | Vouchers by series, not exported yet |
| **Any app** | *Open decant app* | A button to open it |

**Talking naturally:**
- **Follow-ups:** *and diesel?*, *last month*, *and Keshav?*, *top 10*, *his statement*, *stop it*.
- **Several things at once:** *tank stock and sales today*.
- **Missing details:** when something is missing, Jarvis asks for it.
- **Choosing:** when a name fits several customers, Jarvis asks which one; say *the second one* or the name.
- **Spelling slips:** *tankk stok* is understood.
- **Confirmations:** every change is shown first and saved only after you tap to confirm.

**Voice:** tap 🎤, and Jarvis reads its answers aloud in a calm British man's voice: the best one the device has, picked automatically. Turn on *Hands-free* in ⚙ Settings and it listens again after each answer. This uses the device's own voices, so it's free and needs no internet service.
- **Best voice:** on iPhone / Mac, download **Daniel (Premium)** under Settings → Accessibility → Spoken Content → Voices → English (UK). On Windows / Android, open Jarvis in **Edge** for **Ryan (Natural)**.
- **Another voice:** ⚙ Settings → *Jarvis's voice*. Tap **Test** to hear it.

## Setup

1. **Open Jarvis:** `https://subhamkhetan-ux.github.io/Vriddhi-Fuels-Website/jarvis/` → *Add to Home Screen*. To look around first, use `…/jarvis/?demo` (made-up data, nothing real changes).
2. **Create your Jarvis login:** ⚙ Settings → *Your Jarvis login* → email + password → **Create my Jarvis login**.
   - Supabase emails you a confirmation link. Tap it, then sign in.
   - **The first login becomes Jarvis's owner,** so do this first.
   - On every other device, just sign in with the same login. Your settings and conversation come along.
3. **Sign in to the apps** you want Jarvis to use (⚙ Settings → *The apps' logins*): Ledger, Fleet, Loading, Indents, Tally. These are the same logins as the apps. If you're already signed in to an app on that phone, Jarvis is too.
4. Recommended, after step 2: in the **vriddhi-jarvis** Supabase project, go to Authentication → Sign In / Providers and switch off **Allow new users to sign up**.
   - Other logins can't see anything anyway: only members get in, and you are the only member.
   - To add someone: create their login under Authentication → Users, then in the SQL Editor run `select jarvis_add_member('their email');`.

### Where things live

- **The apps' data stays in each app's own Supabase project.** Jarvis reads and writes it directly, through each app's own code and logins. Anything done in Jarvis shows in the app on every device, and the other way round.
- **Jarvis's own project, vriddhi-jarvis** (in the Shree Shyam Logistics organisation; schema in [`supabase/jarvis-schema.sql`](../supabase/jarvis-schema.sql)), holds only Jarvis's own things:
  - the members list
  - per login: settings (never an API key), the last 40 lines of conversation, and the built-in brain's memory of it

  Tables are closed. Everything goes through `jarvis_*` functions that check membership.

## The Mac side (switched off)

XtraPower monitoring and Mac scripts are **off**. Those commands and the "Mac" status are hidden, and if you ask, Jarvis says the Mac side is off. The code stays (`bridge/`, `js/conn/mac.js`, [`supabase/jarvis-mac-schema.sql`](../supabase/jarvis-mac-schema.sql)).

To switch it back on:
1. Run `jarvis-mac-schema.sql` in the vriddhi-jarvis project.
2. Set `MAC: true` in [`config.js`](./config.js).
3. On the Mac, run `./jarvis/bridge/bridge-mac.sh setup`, put a Jarvis member's login in `jarvis/bridge/config.json`, then run `./jarvis/bridge/bridge-mac.sh test` and `./jarvis/bridge/bridge-mac.sh autostart on`.

The bridge runs only its own XtraPower actions and the scripts you list in that file.

## How it works

```
 sentence ─▶ nlu.js (amounts, dates, products, your names…) ─▶ intents.js (which operation, with what)
          ─▶ engine.js (asks / carries over / pronouns / several at once) ─▶ tools.js ─▶ conn/*.js
                                                                                     (each app's own code)
```

- **Two shared pieces.** Jarvis imports each app's own modules, so its figures and pictures match the apps. Two pieces were made shareable for this: `ledger/js/outstanding.js` and `readingFrom()` in `decant/js/core.js`.
- **Logins.** The apps' logins are shared with the apps on the same website (`js/session.js`).

## Optional: the Claude AI brain

Use this only if you also want free-form questions answered by AI. It needs an Anthropic API key, which is pay-per-use and separate from any Claude plan. If it is ever unavailable, the built-in brain answers.

- **Key on one device:** ⚙ Settings → Brain → *key on this device*.
- **Key kept in Supabase:** deploy the function, set the secret, then choose *cloud key*:
  ```bash
  supabase functions deploy jarvis-brain --project-ref otazjsvffvfortrmdred
  supabase secrets set ANTHROPIC_API_KEY=sk-ant-… --project-ref otazjsvffvfortrmdred
  ```

## Files

| File | What |
|---|---|
| `index.html`, `config.js`, `manifest.webmanifest`, `icon.png` | The page; loads every app's `config.js` |
| `js/app.js` | Screens: chat, tables, pictures, confirmations, settings, sync |
| `js/nlu.js` · `js/intents.js` · `js/engine.js` · `js/quick.js` · `js/match.js` | The built-in brain |
| `js/tools.js` · `js/conn/*.js` | The operations: ledger, ledger-ops, decant, fleet, loading, indents, money (payments + Tally), more, cross, mac |
| `js/sync.js` · `js/session.js` · `js/lexicon.js` | Cross-device state, logins, your names |
| `js/brain.js` · `js/voice.js` | Optional Claude brain; speech in and out |
| `bridge/` | The Mac bridge (off) |

## Tests

```bash
node --test 'tests/jarvis_web/*.test.mjs'                                   # brain + every operation on demo data
python -m pytest tests/test_jarvis_schema.py tests/test_jarvis_bridge.py -q # schemas on a local Postgres; the bridge
```
