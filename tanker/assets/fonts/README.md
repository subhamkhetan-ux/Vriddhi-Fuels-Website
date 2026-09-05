# Bill fonts

The tanker bill is drawn in **Times New Roman**, the same font the Excel bill
uses, so the output matches your export glyph-for-glyph.

How the app picks the font (in order):

1. **Your machine's real Times New Roman** — used automatically via
   `local("Times New Roman")`. Windows and Macs with MS Office already have it,
   so on the computer you actually bill from, the PDF is an exact match with
   nothing to install.
2. **A licensed Times New Roman you drop in here** — see below. This makes it
   exact on devices that don't ship the font (e.g. some Android phones) and in
   shared preview links.
3. **`BillSerif-*.ttf`** (Liberation Serif, bundled) — an open, metric-compatible
   stand-in used only when neither of the above is available. Same layout and
   spacing; glyph shapes ~99% identical.

## To embed the exact font (optional)

You are licensed to use Times New Roman on machines that have MS Office/Windows.
Copy these three files from such a machine into this folder, keeping the names:

| From | Copy here as |
|---|---|
| `times.ttf` (Times New Roman) | `times.ttf` |
| `timesbd.ttf` (Bold) | `timesbd.ttf` |
| `timesi.ttf` (Italic) | `timesi.ttf` |

- **Windows:** `C:\Windows\Fonts\times.ttf`, `timesbd.ttf`, `timesi.ttf`.
- **macOS:** Font Book → Times New Roman → Regular/Bold/Italic → *Show in Finder*.

Commit them and the app uses the real font everywhere. Nothing else to change.
(These are Microsoft-licensed fonts, so they are intentionally **not** shipped
in this repo — add your own copy.)
