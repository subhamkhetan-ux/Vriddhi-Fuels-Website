// The pipe change, acted out in the decanting picture. When a chamber is
// empty, an IndianOil attendant (navy uniform, orange trim, white helmet)
// walks up to it and the picture zooms in on him. He checks its sight glass,
// turns its valve shut, unhooks the hose and carries it to the tank's next
// chamber. He couples it (a click), opens that valve, gives a thumbs-up as
// the fuel runs again, and walks off while the picture zooms out.
//
// All of it is worked out from the time: the move's window in the drain
// timeline (core.js), which is Settings' pipe time, 0:45. So a phone opening
// the screen half-way through sees him half-way through. The steps keep their
// share of a shorter or longer pipe time; under 12 s there's no one to show.
// No DOM except applyPose(); tested under Node.

export const GROUND = 115;                               // the road (scene.js)
export const OUTLET_Y = 101;                             // the truck's valves (scene.js)
export const LEVER = 7;                                   // a valve's handle: along the pipe = open, up = closed
export const ZOOM = 2.4;
export const SIZE = 1.3;                                  // him against the truck: about 1.7 m to its 3.3

// The steps, in seconds of a 45 s move (their share is kept for other times).
export const STEPS = { in: [0, 6], look: [6, 8], close: [8, 13], unhook: [13, 18], carry: [18, 25], couple: [25, 32], open: [32, 40], stand: [40, 45] };
export const EXIT = 8;                                    // walking off, s after the fuel runs again
const ENTER_X = -30;                                      // just off the left edge
const STAND = 8;                                          // he works this far left of a valve
const CARRY = { x: 7.5, y: -15.5 };                       // where he holds the hose (his units, from his feet)

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// a lever's tip: open (0°) points along the pipe (+x), closed (-90°) straight up
export const leverTip = (x, angle) => ({ x: x + LEVER * Math.cos(rad(angle)), y: OUTLET_Y + LEVER * Math.sin(rad(angle)) });

// ---------------------------------------------------------------------------
// The body: joints from angles (a small skeleton), in his own units with his
// feet at 0,0, facing +x, y down; drawn SIZE times over. Angles in degrees,
// "from straight down, + forward".
// ---------------------------------------------------------------------------

const THIGH = 7.2;
const SHIN = 6.8;
const BOOT = 2.5;
const UPPER = 6;
const FORE = 6.7;                                         // forearm and glove

const down = (L, a) => ({ x: L * Math.sin(rad(a)), y: L * Math.cos(rad(a)) });
// a vector turned clockwise by the torso's lean (SVG rotate)
const turn = (v, a) => ({ x: v.x * Math.cos(rad(a)) - v.y * Math.sin(rad(a)), y: v.x * Math.sin(rad(a)) + v.y * Math.cos(rad(a)) });
const add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });

// Two-link arm from the shoulder S to the hand's target P: the upper arm's
// and the forearm's angles, the elbow bent back and down.
function reach(S, P) {
  let dx = P.x - S.x;
  let dy = P.y - S.y;
  let d = Math.hypot(dx, dy);
  const max = UPPER + FORE - 0.01;
  if (d > max) { dx *= max / d; dy *= max / d; d = max; }
  d = Math.max(d, Math.abs(UPPER - FORE) + 0.01);
  const base = Math.atan2(dx, dy);                       // from straight down, + forward
  const bend = Math.acos(Math.min(1, Math.max(-1, (UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d))));
  const up = base - bend;                                // elbow out behind the line to the hand
  const elbow = add(S, down(UPPER, deg(up)));
  return { up: deg(up), fore: deg(Math.atan2(S.x + dx - elbow.x, S.y + dy - elbow.y)) };
}

// A pose -> every joint: feet on the ground whatever the legs do.
// p: {bend, tilt, legs: {f: [thigh, knee], b: [thigh, knee]}, hands: {f, b}}
// where a hand is {to: {x, y}} (a target) or {swing: [upper, fore]}.
export function skeleton(p) {
  const foot = ([thigh, knee]) => add(add(down(THIGH, thigh), down(SHIN, thigh - knee)), { x: 0, y: BOOT });
  const ff = foot(p.legs.f);
  const fb = foot(p.legs.b);
  const hip = { x: 0, y: -Math.max(ff.y, fb.y) };        // the lower foot stands on the ground
  const shoulder = add(hip, turn({ x: 0.4, y: -10.5 }, p.bend));
  const neck = add(hip, turn({ x: 0.9, y: -11.6 }, p.bend));
  const arm = (h) => (h.to ? reach(shoulder, h.to) : { up: h.swing[0], fore: h.swing[1] });
  const arms = { f: arm(p.hands.f), b: arm(p.hands.b) };
  const hand = (a) => add(add(shoulder, down(UPPER, a.up)), down(FORE, a.fore));
  return {
    hip, shoulder, neck, bend: p.bend, tilt: p.tilt || 0, legs: p.legs, arms,
    feet: { f: add(hip, ff), b: add(hip, fb) }, hands: { f: hand(arms.f), b: hand(arms.b) },
  };
}

// ---------------------------------------------------------------------------
// The move, step by step
// ---------------------------------------------------------------------------

// m: {t0, t1 (ms: the move's window), xa, xb (the two valves' x)}.
// -> null when he isn't on, else {x, face, pose, step, levers: {a, b}
// (degrees), hose: {x, y} (the hose's end), zoom: 0…1, focus: {x, y}, drip,
// lock (0…1: the click's ring), thumb}. Positions in the picture's units.
export function moveScene(m, now) {
  const D = (m.t1 - m.t0) / 1000;
  const s = (now - m.t0) / 1000;
  if (!(D >= 12) || s < 0 || s > D + EXIT) return null;
  const f = D / 45;
  const at = (name, a = 0, b = 1) => {                    // progress through a step (or a part of it)
    const [s0, s1] = STEPS[name];
    const t0 = (s0 + (s1 - s0) * a) * f;
    const t1 = (s0 + (s1 - s0) * b) * f;
    return clamp01((s - t0) / (t1 - t0));
  };
  const before = (name) => s < STEPS[name][1] * f;
  const step = s >= D ? 'exit' : Object.keys(STEPS).find(before) || 'stand';
  const sa = m.xa - STAND;
  const sb = m.xb - STAND;
  const local = (x, pt) => ({ x: (pt.x - x) / SIZE, y: (pt.y - GROUND) / SIZE });
  const world = (x, pt) => ({ x: x + pt.x * SIZE, y: GROUND + pt.y * SIZE });
  // walking: legs and arms swing with the distance covered (no sliding feet),
  // settling to a stand at either end of the walk
  const walk = (phase, amp, stride = 24) => ({
    f: [amp * stride * Math.sin(phase), amp * 26 * Math.max(0, Math.sin(phase + 1.1))],
    b: [-amp * stride * Math.sin(phase), amp * 26 * Math.max(0, Math.sin(phase + 1.1 + Math.PI))],
  });
  const swing = (phase, amp) => ({ f: { swing: [-18 * amp * Math.sin(phase), 20 - 18 * amp * Math.sin(phase)] }, b: { swing: [18 * amp * Math.sin(phase), 20 + 18 * amp * Math.sin(phase)] } });
  const settle = (t) => Math.min(1, t / 0.12, (1 - t) / 0.12);
  const stand = { f: [2, 3], b: [-2, 3] };
  const crouch = { f: [60, 100], b: [0, 75] };
  const legsTo = (t) => ({ f: [lerp(2, 60, t), lerp(3, 100, t)], b: [lerp(-2, 0, t), lerp(3, 75, t)] });
  const onKnee = { to: { x: 5, y: -8 } };                // the other hand on his knee as he crouches
  const hang = { f: { swing: [3, 14] }, b: { swing: [-3, 10] } };
  const both = (h) => ({ f: { to: h }, b: { to: { x: h.x - 1.8, y: h.y + 1 } } });   // both hands on the hose
  const toward = (from, to, t) => ({ x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) });

  let x = sa;
  let face = 1;
  let pose;
  let hose = { x: m.xa, y: OUTLET_Y };
  let la = 0;                                            // A's valve open…
  let lb = -90;                                          // …B's closed
  let drip = null;
  let lock = 0;
  let thumb = false;
  const dripAt = (p, fade = 1) => ({ x: p.x, y: p.y + 2 + 9 * ((s * 1.6) % 1), o: fade * (1 - ((s * 1.6) % 1)) });

  if (before('in')) {                                     // walks up to the emptied chamber
    const t = at('in');
    x = lerp(ENTER_X, sa, ease(t));
    const phase = (x - ENTER_X) / (4.3 * SIZE);
    pose = { bend: 3, legs: walk(phase, settle(t)), hands: swing(phase, settle(t)) };
  } else if (before('look')) {                            // points up at its sight glass: empty
    const r = Math.sin(Math.PI * at('look'));
    pose = { bend: 0, tilt: -16 * r, legs: stand, hands: { f: { swing: [lerp(3, 112, r), lerp(14, 120, r)] }, b: hang.b } };
  } else if (before('close')) {                           // crouches and turns its valve shut
    la = lerp(0, -90, ease(at('close', 0.45, 0.8)));
    const down1 = ease(at('close', 0, 0.3));
    const r = ease(at('close', 0.15, 0.4));               // the hand to the handle
    const rest = skeleton({ bend: 30, legs: crouch, hands: hang }).hands.f;
    pose = { bend: lerp(0, 30, down1), tilt: 12 * down1, legs: legsTo(down1),
      hands: { f: { to: toward(rest, local(x, leverTip(m.xa, la)), r) }, b: onKnee } };
  } else if (before('unhook')) {                          // unhooks the hose from it
    la = -90;
    const r = ease(at('unhook', 0, 0.2));                 // the hand from the handle to the coupling
    const pull = ease(at('unhook', 0.35, 0.75));
    const up = ease(at('unhook', 0.6, 1));
    const wiggle = 0.5 * Math.sin(at('unhook', 0.2, 0.35) * Math.PI * 4);   // working the coupling's catch
    const carryAt = world(x, CARRY);
    hose = { x: lerp(m.xa, carryAt.x, pull) + wiggle, y: lerp(OUTLET_Y, carryAt.y, pull) };
    if (pull > 0.1) drip = dripAt(hose);
    const h = r < 1 ? toward(local(x, leverTip(m.xa, -90)), local(x, hose), r) : local(x, hose);
    pose = { bend: lerp(30, 14, up), tilt: 12 * (1 - up) + 4 * up,
      legs: { f: [lerp(60, 8, up), lerp(100, 10, up)], b: [lerp(0, -4, up), lerp(75, 8, up)] },
      hands: r < 1 ? { f: { to: h }, b: onKnee } : both(h) };
  } else if (before('carry')) {                           // carries it to the next chamber
    la = -90;
    const t = at('carry');
    x = lerp(sa, sb, ease(t));
    const phase = (x - sa) / (2.9 * SIZE);                // short, careful steps
    const c = world(x, CARRY);
    hose = { x: c.x, y: c.y + 0.6 * Math.abs(Math.sin(phase)) };
    if (t < 0.35) drip = dripAt(hose, 1 - t / 0.35);
    pose = { bend: 14, tilt: 4, legs: walk(phase, settle(t), 16), hands: both(local(x, hose)) };
  } else if (before('couple')) {                          // couples it onto the next valve: click
    la = -90;
    x = sb;
    const down1 = ease(at('couple', 0, 0.25));
    const put = ease(at('couple', 0.15, 0.6));
    const push = at('couple', 0.6, 0.8);
    const click = at('couple', 0.8, 1);
    lock = click > 0 && click < 1 ? click : 0;
    const c = world(x, CARRY);
    hose = { x: lerp(c.x, m.xb, put) + 0.7 * Math.sin(push * Math.PI * 2), y: lerp(c.y, OUTLET_Y, put) };
    pose = { bend: lerp(14, 30, down1), tilt: lerp(4, 12, down1),
      legs: { f: [lerp(8, 60, down1), lerp(10, 100, down1)], b: [lerp(-4, 0, down1), lerp(8, 75, down1)] }, hands: both(local(x, hose)) };
  } else if (before('open')) {                            // opens it: the fuel can run
    la = -90;
    x = sb;
    hose = { x: m.xb, y: OUTLET_Y };
    lb = lerp(-90, 0, ease(at('open', 0.25, 0.7)));
    const r = ease(at('open', 0, 0.2));                   // the hand from the coupling to the handle
    const away = ease(at('open', 0.7, 0.85));
    const up = ease(at('open', 0.8, 1));
    const tip = local(x, leverTip(m.xb, lb));
    const low = skeleton({ bend: 30, legs: crouch, hands: hang }).hands.f;
    const high = skeleton({ bend: 0, legs: stand, hands: hang }).hands.f;
    const h = away > 0 ? toward(tip, low, away) : toward(local(x, hose), tip, r);
    pose = { bend: lerp(30, 0, up), tilt: 12 * (1 - up), legs: legsTo(1 - up),
      hands: up > 0 ? { f: { to: toward(h, high, up) }, b: hang.b } : { f: { to: h }, b: onKnee } };
  } else if (s < D) {                                     // stands back: a thumbs-up as it runs
    la = -90;
    lb = 0;
    x = sb;
    hose = { x: m.xb, y: OUTLET_Y };
    const t = at('stand');
    const r = ease(Math.min(1, t / 0.3, (1 - t) / 0.25));
    thumb = r > 0.6;
    pose = { bend: 0, legs: stand, hands: { f: { swing: [lerp(3, 92, r), lerp(14, 140, r)] }, b: hang.b } };
  } else {                                                // walks off, back the way he came
    la = -90;
    lb = 0;
    hose = { x: m.xb, y: OUTLET_Y };
    const t = clamp01((s - D) / EXIT);
    x = lerp(sb, ENTER_X, ease(t));
    face = -1;
    const phase = (sb - x) / (4.3 * SIZE);
    pose = { bend: 3, legs: walk(phase, settle(t)), hands: swing(phase, settle(t)) };
  }

  const zin = ease(clamp01((s - 3 * f) / (5 * f)));
  const zout = ease(clamp01((s - D) / 4));
  return {
    x, face, pose, step, hose, drip, lock, thumb,
    levers: { a: la, b: lb },
    zoom: zin * (1 - zout),
    focus: { x: (sa + m.xb) / 2 + 3, y: 92 },
  };
}

// ---------------------------------------------------------------------------
// The figure (SVG, his own units) and putting a pose on it
// ---------------------------------------------------------------------------

// gradients for the figure, once per picture (id: the picture's id): lit from
// the front, round limbs (light across the middle, shade at the edges)
export function workerDefs(id) {
  const across = (name, ...stops) => `<linearGradient id="${id}${name}" x1="0" y1="0" x2="1" y2="0">${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>`;
  return [
    across('wN', '#101d4a', '#2c50b4', '#3a63cf', '#1a2f78'),   // navy uniform
    across('wNb', '#0a1433', '#1b3478', '#223f8c', '#101f4e'),  // the far limbs, in shade
    across('wG', '#b86c0c', '#ffc94f', '#e9a02a'),               // gloves
    `<linearGradient id="${id}wB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3a42"/><stop offset="1" stop-color="#0b0b0d"/></linearGradient>`,   // boots
    `<radialGradient id="${id}wS" cx=".62" cy=".38" r=".75"><stop offset="0" stop-color="#e2a57c"/><stop offset="1" stop-color="#8e5a3c"/></radialGradient>`,   // skin
    `<radialGradient id="${id}wH" cx=".6" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#e7e9ec"/><stop offset="1" stop-color="#aab0b8"/></radialGradient>`,   // helmet
  ].join('');
}

// a leg: thigh, then the shin at the knee, then the boot kept flat on the ground
function leg(id, key, far) {
  const n = far ? 'wNb' : 'wN';
  return `<g data-k="${key}">
    <rect x="-1.95" y="-0.4" width="3.9" height="${THIGH + 0.8}" rx="1.7" fill="url(#${id}${n})"/>
    <g data-k="${key}k" transform="translate(0 ${THIGH})">
      <rect x="-1.75" y="-0.3" width="3.5" height="${SHIN + 0.6}" rx="1.5" fill="url(#${id}${n})"/>
      <rect x="-1.75" y="${SHIN * 0.45}" width="3.5" height="1.05" fill="#dfe4ea" opacity="${far ? 0.55 : 0.92}"/>
      <g data-k="${key}f" transform="translate(0 ${SHIN})"><path d="M-2 -0.2 h4.2 q2.6 0 2.9 1.4 q.2 1.3 -.9 1.3 H-2 Z" fill="url(#${id}wB)"/></g>
    </g>
  </g>`;
}

// an arm: the upper arm with its orange band, then the forearm and glove (the
// near hand can give a thumbs-up)
function arm(id, key, far) {
  const n = far ? 'wNb' : 'wN';
  return `<g data-k="${key}">
    <rect x="-1.65" y="-0.8" width="3.3" height="${UPPER + 1.1}" rx="1.55" fill="url(#${id}${n})"/>
    <rect x="-1.65" y="0.3" width="3.3" height="1.2" rx=".5" fill="#f37021" opacity="${far ? 0.6 : 1}"/>
    <g data-k="${key}k" transform="translate(0 ${UPPER})">
      <rect x="-1.45" y="-0.4" width="2.9" height="${FORE - 1.2}" rx="1.35" fill="url(#${id}${n})"/>
      ${far ? '' : `<rect data-k="${key}t" x="-0.2" y="${FORE - 1}" width="1.3" height="2.6" rx=".65" fill="url(#${id}wG)" display="none"/>`}
      <circle cx="0" cy="${FORE - 1.2}" r="1.55" fill="url(#${id}wG)"/>
    </g>
  </g>`;
}

// The attendant: navy coverall with an orange yoke and reflective bands, the
// company roundel on his chest, white helmet with an orange stripe, gloves.
export function workerSvg(id, key) {
  return `<g class="worker" data-k="${key}" display="none">
    <ellipse cx="0" cy="0.6" rx="7.5" ry="1.5" fill="#000" opacity=".4"/>
    <g data-k="${key}b">${leg(id, `${key}lb`, true)}${arm(id, `${key}ab`, true)}</g>
    <g data-k="${key}t">
      <path d="M-3.3 0.6 L-3.5 -9.6 Q-3.4 -11.6 -1.2 -11.9 L2.6 -11.9 Q4.3 -11.6 4.2 -9.4 L3.7 0.6 Z" fill="url(#${id}wN)"/>
      <path d="M-3.45 -9.1 Q-3.4 -11.6 -1.2 -11.9 L2.6 -11.9 Q4.3 -11.6 4.25 -9.1 Z" fill="#f37021"/>
      <rect x="-3.45" y="-5.9" width="7.5" height="1.25" fill="#dfe4ea" opacity=".92"/>
      <rect x="-3.35" y="-1.1" width="7.1" height="1.2" fill="#0b132e"/>
      <circle cx="2.35" cy="-7.55" r="1.05" fill="#f37021" stroke="#fff" stroke-width=".3"/>
      <path d="M1.35 -7.55 h2" stroke="#1d3a8f" stroke-width=".55"/>
      <path d="M3.7 -11.2 L4.15 0.4" stroke="#7d9cf0" stroke-width=".45" opacity=".55"/>
    </g>
    <g data-k="${key}h">
      <rect x="-0.9" y="-1.9" width="2.2" height="2.4" rx=".8" fill="#9a6444"/>
      <circle cx="0.5" cy="-4.4" r="3.3" fill="url(#${id}wS)"/>
      <ellipse cx="3.65" cy="-4.2" rx=".75" ry=".6" fill="#b8784f"/>
      <circle cx="2.35" cy="-5" r=".36" fill="#1a1210"/>
      <path d="M2.2 -3.05 q.8 .45 1.7 .05" stroke="#2a1a14" stroke-width=".5" fill="none" stroke-linecap="round"/>
      <ellipse cx="-0.6" cy="-4.3" rx=".7" ry="1" fill="#a86a47"/>
      <path d="M-3.1 -5.3 Q-3.2 -9.4 0.6 -9.5 Q4.2 -9.4 4.1 -5.3 Z" fill="url(#${id}wH)"/>
      <path d="M3.3 -5.35 L5.6 -5.1 Q5.7 -4.75 5.2 -4.7 L3.2 -4.75 Z" fill="#d4d8dd"/>
      <path d="M-3.05 -6.7 Q0.5 -7.4 4.05 -6.7 L4.1 -5.9 Q0.5 -6.6 -3.1 -5.9 Z" fill="#f37021"/>
      <ellipse cx="1.8" cy="-8.3" rx="1.3" ry=".5" fill="#fff" opacity=".8"/>
    </g>
    <g data-k="${key}f">${leg(id, `${key}lf`, false)}${arm(id, `${key}af`, false)}</g>
  </g>`;
}

const tf = (p, a) => `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) rotate(${(-a).toFixed(1)})`;

// Put him where the step has him: g is his <g class="worker">. find and set
// can come from the picture (its parts looked up once, only changes written).
const setAttr = (n, name, v) => { if (!n) return; if (v === '') n.removeAttribute(name); else n.setAttribute(name, v); };
export function applyPose(g, key, sc, find = (k) => g.querySelector(`[data-k="${k}"]`), set = setAttr) {
  const k = (s) => find(`${key}${s}`);
  const sk = skeleton(sc.pose);
  set(g, 'transform', `translate(${sc.x.toFixed(2)} ${GROUND}) scale(${sc.face * SIZE} ${SIZE})`);
  for (const side of ['f', 'b']) {
    const [thigh, knee] = sk.legs[side];
    set(k(`l${side}`), 'transform', tf(sk.hip, thigh));
    set(k(`l${side}k`), 'transform', `translate(0 ${THIGH}) rotate(${knee.toFixed(1)})`);
    set(k(`l${side}f`), 'transform', `translate(0 ${SHIN}) rotate(${(thigh - knee).toFixed(1)})`);   // flat
    const a = sk.arms[side];
    set(k(`a${side}`), 'transform', tf(sk.shoulder, a.up));
    set(k(`a${side}k`), 'transform', `translate(0 ${UPPER}) rotate(${(-(a.fore - a.up)).toFixed(1)})`);
  }
  set(k('aft'), 'display', sc.thumb ? '' : 'none');
  set(k('t'), 'transform', `translate(${sk.hip.x.toFixed(2)} ${sk.hip.y.toFixed(2)}) rotate(${sk.bend.toFixed(1)})`);
  set(k('h'), 'transform', `translate(${sk.neck.x.toFixed(2)} ${sk.neck.y.toFixed(2)}) rotate(${(sk.bend + sk.tilt).toFixed(1)})`);
}
