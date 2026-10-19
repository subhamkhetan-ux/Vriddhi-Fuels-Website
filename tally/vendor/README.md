# Report export assets

These public, local assets support PDF downloads without sending reports to a conversion service.

- `fontkit.umd.min.js`: unmodified `@pdf-lib/fontkit` 1.1.1 npm bundle (`package/dist/fontkit.umd.min.js`). MIT; see `FONTKIT-LICENSE.md`. Package tarball SHA-1 published by npm: `f18473892b65e3253eb73f4569785abd2c03b1e0`.
- `NotoSans-Regular.ttf`: unmodified hinted Noto Sans from [notofonts/noto-fonts](https://github.com/notofonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf). SIL Open Font License; see `NOTO-LICENSE.txt`. Includes the Indian rupee sign. A report with characters outside this font's coverage offers browser Print / Save PDF rather than silently substituting glyphs.

The exporter also reuses the already vendored PDF library and SheetJS in `pdf/vendor/`; their versions/licenses are documented in `pdf/README.md`. Excel is generated from explicit text cells, never from uploaded workbooks or formulas.
