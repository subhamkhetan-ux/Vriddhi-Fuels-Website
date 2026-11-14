// A paper page filling a printed sheet — no empty band at the side or the
// bottom. The page is first scaled to the sheet's width (so its print is as
// big as it can be), then its rows are made taller or shorter until it is
// exactly as tall as the sheet. Cells get a little less padding at the sides
// (.fit-page) so a wide page (the DSR) prints bigger.
//
// paper: a .paper element on screen; W × H: the sheet's printable size in CSS
// px (or W = 0: keep the page's own width and fit H / W as the sheet's shape,
// given as `ratio`). Returns the zoom to print at.

export function fitPaperToPage(paper, W, H, ratio = 0, maxZoom = 1.5) {
  paper.classList.add('fit-page');
  paper.style.zoom = '1';
  paper.style.removeProperty('--rowh');
  const width = paper.offsetWidth;
  let z = W ? Math.min(maxZoom, W / width) : 1;
  const target = W ? H / z : width * ratio;                 // the page's height that fills the sheet
  const setRow = (h) => { paper.style.setProperty('--rowh', `${h}px`); return paper.offsetHeight; };
  let lo = 12;
  let hi = 90;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (setRow(mid) > target) hi = mid; else lo = mid;
  }
  const h = setRow(lo);
  if (h > target + 0.5) z *= target / h;                    // even the shortest rows don't fit: smaller all round
  return z;
}
