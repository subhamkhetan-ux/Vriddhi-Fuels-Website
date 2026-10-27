"""Read-only check: does FuelTrans know a nozzle's preset, and when? (run on the server)

    python3 infra/fueltrans/ftpreset.py [http://127.0.0.1:13000] [seconds]

Prints where FuelTrans' page code uses "preset", its Preset Mismatch report,
today's transactions' fields, and every field of its live pump data for a few
minutes (whole packets when a nozzle is lifted or authorised). It only
reads: no socket.io event is ever sent (FuelTrans' pump controls go that way).
"""
import datetime, json, re, sys, time, urllib.request
B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:13000"
SECS = int(sys.argv[2]) if len(sys.argv) > 2 else 180
def get(p, t=30):
    try: return urllib.request.urlopen(B + p, timeout=t).read().decode("utf-8", "replace")
    except Exception as e: return f"<{type(e).__name__}: {e}>"
d = datetime.date.today(); w = d - datetime.timedelta(days=7)
day, week = f"{d.year}-{d.month}-{d.day}", f"{w.year}-{w.month}-{w.day}"
print("== 1. where FuelTrans' page code uses 'preset'")
idx = get("/")
names = re.findall(r'(?:main|runtime)\.[0-9a-f]{16}\.js', idx)
rt = next((n for n in names if n.startswith("runtime")), "")
files = [n for n in names if n.startswith("main")] + [f"{n}.{h}.js" for n, h in re.findall(r'(\d+):"([0-9a-f]{16})"', get("/" + rt))]
for f in files:
    js, n, after = get("/" + f), 0, -1
    for m in re.finditer(r'[Pp]reset', js):
        if m.start() < after or n >= 8: continue
        after, n = m.start() + 150, n + 1
        print(f"-- {f}: ...{js[max(0, m.start() - 90): m.end() + 110]}...")
print("\n== 2. Preset Mismatch report, last 7 days")
print(get(f"/getPresetMismatch/{week}/{day}")[:2500])
print("\n== 3. today's transactions: their fields")
raw = get(f"/getTransactionsForRangeWithoutTime/{day}/{day}")
try:
    rows = json.loads(raw); rows = rows if isinstance(rows, list) else rows.get("data", [])
    print(f"{len(rows)} rows; fields: {sorted(rows[0]) if rows else []}")
    for r in rows[-3:]: print(json.dumps(r)[:600])
except Exception: print(raw[:1200])
print(f"\n== 4. live data for {SECS} s: every pump field, whole packets when a nozzle is lifted or authorised, every other event")
def packets(data):
    i = 0
    while i < len(data):
        j = data.find(":", i)
        if j < 0: return
        try: n = int(data[i:j])
        except ValueError: return
        yield data[j + 1:j + 1 + n]; i = j + 1 + n
opened = get("/socket.io/?EIO=3&transport=polling", 20)
sid = re.search(r'"sid"\s*:\s*"([^"]+)"', opened)
if not sid: print("no live connection:", opened[:200]); sys.exit()
url, keys, shown, end, ping = f"/socket.io/?EIO=3&transport=polling&sid={sid.group(1)}", set(), {}, time.time() + SECS, time.time() + 20
while time.time() < end:
    if time.time() > ping:
        urllib.request.urlopen(urllib.request.Request(B + url, data=b"1:2", method="POST"), timeout=10).read(); ping = time.time() + 20
    for p in packets(get(url, 40)):
        if not p.startswith("42"): continue
        name, *args = json.loads(p[2:])
        a = args[0] if args and isinstance(args[0], dict) else {}
        if name not in ("pumpStatusPkt", "tankStatusPkt", "upsStatusPkt", "DeviceStatus"):
            print(f"   event {name}: {json.dumps(args)[:400]}")        # (anything else: whatever it brings)
        if name != "pumpStatusPkt": continue
        new = set(a) - keys; keys |= set(a)
        if new: print("fields:", sorted(keys))
        st = a.get("status")
        if st in (3, 4) and shown.get(a.get("PumpId")) != st or new - {"PumpId", "status"} and len(keys) > len(new):
            shown[a.get("PumpId")] = st; print("  ", json.dumps(a))
print("done; all fields seen:", sorted(keys))
