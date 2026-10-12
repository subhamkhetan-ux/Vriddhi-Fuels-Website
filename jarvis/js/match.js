// Finding the customer / account / app the owner means from a few spoken or
// typed words — "smc", "shyam metallics", "ember coal ka", "1005218882".
// Pure functions (tests/jarvis_web/match.test.mjs).

// words that never decide who is meant
const STOP = new Set([
  'm', 's', 'ms', 'mss', 'messrs', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'the', 'and', 'of', 'for',
  'account', 'acct', 'ac', 'a', 'customer', 'party', 'ji', 'sir', 'ka', 'ki', 'ke', 'ko', 'wala', 'wale', 'india',
]);

export const words = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter((w) => w && !STOP.has(w));

// edit distance, early exit past `max`
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// does query word q match name word n? exact, prefix (3+ letters), or a
// spelling/transcription slip on longer words ("metallics" / "metalics")
function wordHit(q, n) {
  if (q === n) return 1;
  if (q.length >= 3 && n.startsWith(q)) return 0.9;
  if (q.length >= 5 && n.length >= 5 && editDistance(q, n, q.length >= 8 ? 2 : 1) <= (q.length >= 8 ? 2 : 1)) return 0.8;
  return 0;
}

// 0..100: how well `query` names `name`
export function score(query, name) {
  const q = words(query);
  const n = words(name);
  if (!q.length || !n.length) return 0;
  const qs = q.join(' ');
  const ns = n.join(' ');
  if (qs === ns) return 100;
  const qj = q.join('');
  const nj = n.join('');
  if (qj === nj) return 98;
  // initials: "smc" -> Shyam Metalics Coal / "S M C Power"
  if (q.length === 1 && qj.length >= 2 && qj.length <= 5) {
    const ini = n.map((w) => w[0]).join('');
    if (ini === qj || ini.startsWith(qj) && qj.length >= 3) return 85;
    if (n[0] === qj) return 88;                                   // first word exactly
  }
  // every query word found in the name, in any order
  const hits = q.map((w) => Math.max(0, ...n.map((x) => wordHit(w, x))));
  const cover = hits.filter((h) => h > 0).length / q.length;
  const named = hits.filter((h) => h > 0).length / n.length;                  // how much of the name was said
  if (cover === 1) return Math.round(70 + 25 * Math.min(1, named) - 10 * (1 - Math.min(...hits)));
  if (nj.includes(qj) && qj.length >= 4) return 65;
  return Math.round(55 * cover * Math.min(1, 0.5 + named));
}

// The best match in a list: {best, candidates}. `best` only when it is
// clearly ahead (so "steel" with two steel customers asks which one).
export function bestMatch(query, items, nameOf = (x) => x.name, { min = 45 } = {}) {
  const scored = items.map((item) => {
    const names = [].concat(nameOf(item)).filter(Boolean);
    return { item, score: Math.max(0, ...names.map((nm) => score(query, nm))) };
  }).filter((x) => x.score >= min).sort((a, b) => b.score - a.score);
  if (!scored.length) return { best: null, candidates: [] };
  const [top, next] = scored;
  const clear = top.score >= 60 && (!next || next.score <= top.score - 12 || top.score >= 98 && next.score < 98);
  return { best: clear ? top.item : null, candidates: scored.slice(0, 6).map((x) => x.item) };
}
