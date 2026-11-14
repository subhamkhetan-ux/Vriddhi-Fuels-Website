// The Monthly PDFs' "Handwritten on paper" look (an option; the plain look
// stays the default): a sheet of real-looking paper — warm, grainy, a few
// fibres, soft shading at the edges, the ruling a little faded — and its
// figures written in a ballpoint hand: each digit leaning and sitting a
// little differently, the ink a little heavier or lighter. The same figures,
// only drawn differently.
//
// Browser only (canvas). Repeatable: the same page comes out the same way.

// a small, seeded random number source (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

// The paper: a tile of grain and fibres (a PNG data: URL), made once
let tile = null;
export function paperTexture() {
  if (tile) return tile;
  const n = 512;
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const g = c.getContext('2d');
  g.fillStyle = '#f6f1e3';
  g.fillRect(0, 0, n, n);
  const r = rng(20261114);
  const img = g.getImageData(0, 0, n, n);
  for (let i = 0; i < img.data.length; i += 4) {             // grain
    const v = (r() - 0.5) * 18;
    img.data[i] += v; img.data[i + 1] += v; img.data[i + 2] += v * 0.9;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 260; i++) {                            // fibres
    const x = r() * n;
    const y = r() * n;
    const len = 6 + r() * 26;
    const a = r() * Math.PI * 2;
    g.strokeStyle = `rgba(${120 + r() * 60},${105 + r() * 50},${80 + r() * 40},${0.05 + r() * 0.09})`;
    g.lineWidth = 0.4 + r() * 0.7;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a + 0.6) * len * 0.5, y + Math.sin(a + 0.6) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  for (let i = 0; i < 24; i++) {                             // faint, soft blotches
    const x = r() * n;
    const y = r() * n;
    const rad = 30 + r() * 70;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(150,128,85,${0.012 + r() * 0.014})`);
    gr.addColorStop(1, 'rgba(150,128,85,0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  tile = c.toDataURL('image/png');
  return tile;
}

// One page: the paper, and its figures in a hand
export function handwritePage(paper) {
  paper.classList.add('realistic');
  paper.style.backgroundImage = `radial-gradient(ellipse at 50% 45%, rgba(255,255,255,0) 55%, rgba(120,95,50,.16) 100%), url(${paperTexture()})`;
  paper.style.backgroundSize = 'cover, 512px 512px';
  const seed = hash(paper.textContent.slice(0, 400));
  const r = rng(seed);
  for (const td of paper.querySelectorAll('td.ink')) {
    if (td.querySelector('input')) continue;
    // this cell's writing: a lean, a sit and a pressure of its own
    const lean = (r() - 0.5) * 3.2;
    const sit = (r() - 0.5) * 2.2;
    const ink = r();
    td.style.setProperty('--ink', ink < 0.7 ? '#1f2f86' : ink < 0.9 ? '#253a9c' : '#1a2670');
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const ch of child.textContent) {
            if (ch === ' ') { frag.append(' '); continue; }
            const s = document.createElement('span');
            s.className = 'hw';
            s.textContent = ch;
            const rot = lean + (r() - 0.5) * 7;
            const dy = sit + (r() - 0.5) * 1.6;
            const sc = 0.92 + r() * 0.16;
            s.style.transform = `translateY(${dy.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
            s.style.opacity = (0.82 + r() * 0.18).toFixed(2);
            s.style.marginRight = `${((r() - 0.4) * 0.8).toFixed(2)}px`;
            frag.append(s);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && !child.classList.contains('reg-flag')) {
          walk(child);
        }
      }
    };
    walk(td);
  }
}
