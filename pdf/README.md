# PDF Toolkit

A complete PDF toolbox that runs **entirely in the browser**. Files are never
uploaded: every tool works on the device, so there are no file-size caps, page
caps, daily task limits or accounts. It's a static app that lives under `/pdf/`,
separate from the other apps in this repo, and installs as a PWA that works
offline once loaded.

## Tools

| Category | Tools |
| --- | --- |
| Organize | Merge (PDFs + images, drag to order) · Split (ranges, every N pages, by max file size, single pages) · Remove pages · Extract pages · Organize (visual drag-reorder, rotate, delete, duplicate, insert blank, combine several PDFs) · Scan to PDF (camera, document enhance, optional OCR) |
| Optimize | Compress (3 levels, image recompression, grayscale, flatten-to-image, strip metadata; never returns a bigger file) · Repair (rebuilds structure, falls back to re-rendering) · OCR (30+ languages, invisible text layer over the original page) |
| Convert to PDF | JPG/PNG/WebP/GIF → PDF · Word (DOCX) · PowerPoint (PPTX) · Excel (XLSX/XLS/ODS/CSV) · HTML (file, pasted HTML, or URL when the site allows CORS) |
| Convert from PDF | PDF → JPG/PNG/WebP (or extract embedded images) · Word (editable text, optional OCR, or exact page images) · PowerPoint · Excel (table detection) · PDF/A (1b/2b/3b) · Text |
| Edit | Edit PDF (text, images, rectangles, ellipses, lines, freehand, white-out, highlight) · Rotate · Page numbers · Watermark (text/image, tiled, under/over content) · Crop (incl. auto-trim) · Fill & flatten forms · Metadata · Grayscale |
| Security | Unlock (with the password) · Protect (AES-256/128 + print/copy/edit permissions) · Sign (draw / type / upload, initials, date, name; saved on the device) · Redact (boxes or search, incl. regex and presets; affected pages are flattened so hidden text can't be recovered) · Compare (word-level text diff + visual pixel overlay) |
| Advanced | Workflows (chain PDF→PDF tools, presets and saved workflows, run on many files) · Flatten |

Every tool that takes one PDF and produces one PDF also works in **batch**
(drop in as many files as you like; results come back as a zip). After a
result, “Continue with…” passes it straight into another tool.

## How it works

- `index.html`, `app.css` — shell and styles.
- `js/app.js` — hash router, tool grid and the generic *files → options → process → download* page.
- `js/tools.js` — the tool registry. Each tool declares its options and one of
  `transform` (PDF bytes → PDF bytes; used by batch and workflows), `perFile`,
  `run`, or an `interactive` module.
- `js/convert.js` — Office/HTML ↔ PDF conversions. HTML-based sources (Word via
  mammoth, Excel via SheetJS, HTML) are laid out by the browser, rasterized page
  by page, and given an invisible text layer from the browser's own word
  positions, so output looks exact and stays searchable. PPTX slides are drawn
  from the slide XML.
- `js/editor.js` (edit / sign / redact / crop), `js/organize.js`, `js/forms.js`,
  `js/compare.js`, `js/workflow.js` — interactive tools.
- `js/lib.js` — shared helpers (lazy library loading, rendering, ranges,
  rotation-aware drawing, OCR, text layers).
- `sw.js` — offline cache. Bump `CACHE` when shipping changes.

### Libraries (vendored in `vendor/`)

| Library | Version | Licence | Used for |
| --- | --- | --- | --- |
| @cantoo/pdf-lib | 2.11.1 | MIT | PDF editing, encryption/decryption |
| pdfjs-dist | 4.10.38 | Apache-2.0 | rendering, text extraction |
| tesseract.js | 5.1.1 | Apache-2.0 | OCR (engine + language data load from jsDelivr on first use, then cached) |
| mammoth | 1.13.0 | BSD-2-Clause | DOCX → HTML |
| xlsx (SheetJS CE) | 0.18.5 | Apache-2.0 | spreadsheets |
| pptxgenjs | 4.0.1 | MIT | PDF → PPTX |
| html2canvas | 1.4.1 | MIT | HTML rasterizing |
| jszip | 3.10.2 | MIT | zips, DOCX/PPTX packaging |

## Limits worth knowing

- **PDF/A** output adds the sRGB output intent, XMP conformance metadata and a
  file ID, and removes JavaScript and embedded files. “Rebuild pages as images”
  is the strictest mode. For legal archiving, validate with veraPDF.
- **Office → PDF** is a faithful browser rendering, not Microsoft Office: complex
  Word layouts (columns, floating shapes) and PPTX features (charts, SmartArt,
  gradients) are simplified.
- **Selectable text** added to rendered or OCR'd pages uses a standard font, so
  non-Latin scripts render correctly on the page but their text layer is
  limited.
- **Sign PDF** stamps visible signatures. Certificate-based (PKCS#7) digital
  signatures aren't included.
- AI features (summarize, translate) are not included.

## Deploying

It's plain static files. `.github/workflows/pages.yml` copies `pdf/` into the
GitHub Pages site, so it's served at `/pdf/`.
