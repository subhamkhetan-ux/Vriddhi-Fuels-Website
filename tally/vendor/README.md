# Tally font and report assets

These public, local assets provide the app font and support PDF downloads without sending reports to a conversion service.

- `fontkit.umd.min.js`: unmodified `@pdf-lib/fontkit` 1.1.1 npm bundle (`package/dist/fontkit.umd.min.js`). MIT; see `FONTKIT-LICENSE.md`. Package tarball SHA-1 published by npm: `f18473892b65e3253eb73f4569785abd2c03b1e0`.
- `NotoSans-Regular.ttf`: unmodified hinted Noto Sans from [notofonts/noto-fonts](https://github.com/notofonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf). SIL Open Font License; see `NOTO-LICENSE.txt`. Includes the Indian rupee sign. A report with characters outside this font's coverage offers browser Print / Save PDF rather than silently substituting glyphs.

The exporter also reuses the already vendored PDF library and SheetJS in `pdf/vendor/`; their versions/licenses are documented in `pdf/README.md`. Excel is generated from explicit text cells, never from uploaded workbooks or formulas.

- `Sora-Variable.ttf`: unmodified Sora variable font (100–800), the same display family used by Decant. From [google/fonts](https://github.com/google/fonts/blob/a926665019d3f7f25c8b1212cecbfa871e70de82/ofl/sora/Sora%5Bwght%5D.ttf) at commit `a926665019d3f7f25c8b1212cecbfa871e70de82`. SIL Open Font License; see `SORA-LICENSE.txt`. Served locally and cached as a public app-shell asset for reliable typography.
