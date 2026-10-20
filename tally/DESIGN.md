# Tally interface

Uses Emil Kowalski's [Apple design](../.agents/skills/apple-design/SKILL.md), [design-engineering](../.agents/skills/emil-design-eng/SKILL.md) and [mobile-native](../.agents/skills/mobile-native/SKILL.md) skills. The pinned upstream revision and MIT license are in [.agents/skills/EMIL-SOURCE.md](../.agents/skills/EMIL-SOURCE.md).

Keep the shared Vriddhi orange glass palette. Use orange for primary actions, product colours for fuel identity, quiet glass panels for grouping, and tabular numerals for financial values. Keep instructions in expandable help where they are not needed for every transaction. Preserve report source timestamps and offline states.

Daily navigation is instant. Pointer press feedback uses a 120 ms ease-out scale; keyboard and reduced-motion interactions have no movement. Hover styles require a fine pointer with hover support. Keep backdrop blur on floating chrome rather than every accounting row.

Report tabs have one tab stop, arrow/Home/End navigation and a labelled panel. Form labels target the actual controls. Main controls are at least 44 px tall; report inputs are at least 16 px to avoid phone input zoom. Do not disable browser zoom or text selection on financial content. Browser chrome follows the selected dark/light/system theme.

Validation: Chromium screenshots and overflow checks at 320, 390 and 1280 px in dark/light modes; home, voucher and report screens; existing report download/sign-out tests; keyboard tab, theme persistence and request-error recovery tests. These checks use synthetic data. Actual phone safe areas, input keyboard behaviour and touch feel still need device verification. Invoice/slip print layouts and accounting rules are separate from the app chrome.

Typography matches Decant: Sora for headings, primary buttons and key values, system sans for body text, with 700/800 weight for emphasis and tabular financial numerals. Sora is served locally from `vendor/Sora-Variable.ttf` and cached with the public shell, so the selected face remains available offline and does not rely on Google's font CDN. Its source revision and SIL OFL license are documented in `vendor/README.md`. Monospace is reserved for pairing codes. Keep printed invoice fonts and PDF report font embedding independent of UI typography. The neutral grouped background and translucent header retain Vriddhi orange as an accent. Honour reduced transparency and higher contrast preferences.
