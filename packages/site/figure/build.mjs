// The footer figure: "silk reel" as machined letters on a film bench. Run `node figure/build.mjs` from packages/site.
// It writes src/components/FooterFigure.astro and src/motion/figure-data.ts. `--page` also writes check pages to /tmp/silk-fig,
// `--audit` runs the kit audit, and `--fast` skips the depth settle while iterating.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import * as A from "./kit/audit.mjs";
import { create } from "fontkitten";
import * as D from "../src/motion/figure-draw.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");
const ARGS = process.argv.slice(2);
const FAST = ARGS.includes("--fast");

// ---------- the truth the figure shows ----------
const FILM = { frames: 336, fps: 30, drawings: 168 };
const CRANK = 24; // frames per second the bench is cranked at in the idle loop: real film speed

// ---------- camera ----------
// The word runs along u (screen right), v points to the back of the bench, z up. The kit's world is [x, y, z] = [-v, -u, z].
// A low azimuth (16°) looks at the letters' faces nearly square, so the word reads at a glance, and still shows the bench in depth.
const AZIMUTH = 14;
const ELEVATION = 30;
const WIDTH = 1200;
const W = (u, v, z) => [-v, -u, z];
const plan = (u, v, w, d, r = 0) => ({ x: -(v + d), y: -(u + w), w: d, d: w, r });

// ---------- layout (world units: one unit is ten font units) ----------
const CELL = 60;
const WORD = "silk reel";
const cellU = (i) => -240 + CELL * i;
const PLINTH = { w: 38, d: 18, h: 14 };
const RAIL = { h: 2, d: 16 };
const LETTER = { front: -6, depth: 12, base: RAIL.h + PLINTH.h };
const FZ = [2.6, 12.6]; // the film's edges, below every letter
const PITCH = (2 * Math.PI * 4.5) / 6; // one frame: a roller of 4.2 plus half the film carries six
const BASE = { u: -400, v: -78, w: 800, d: 144, r: 10, h: 12 };
const SYNC = { u: -34, v: -40, w: 68, d: 39 }; // the synchronizer's sub-plate in the word gap
const SYNC_H = 1.2;

// the picture: a Steenbeck-style screen on a column in the word gap, its window 16:9 like the film it shows
const SCREEN = { u: -116, w: 232, v: -6, d: 38, z: 108, bezel: 11, hood: 14 };
SCREEN.win = { u0: SCREEN.u + SCREEN.bezel, u1: SCREEN.u + SCREEN.w - SCREEN.bezel, z0: SCREEN.z + SCREEN.bezel };
SCREEN.win.z1 = SCREEN.win.z0 + ((SCREEN.win.u1 - SCREEN.win.u0) * 9) / 16;
SCREEN.h = SCREEN.win.z1 - SCREEN.z + SCREEN.bezel;
const extent = [...k.boxCorners(plan(BASE.u, BASE.v, BASE.w, BASE.d), -BASE.h - 6, 0), W(cellU(2) - 27, 6, LETTER.base + 74), W(cellU(8) - 27, 6, LETTER.base + 74), W(cellU(1), 6, LETTER.base + 78), ...k.boxCorners(plan(SCREEN.u, SCREEN.v - SCREEN.hood, SCREEN.w, SCREEN.d + SCREEN.hood), SCREEN.z, SCREEN.z + SCREEN.h + 8)];
const unitP = { origin: [0, 0], scale: 1, azimuth: AZIMUTH, elevation: ELEVATION };
const flatExtent = extent.map((p) => k.iso(p, unitP));
const spanX = Math.max(...flatExtent.map((p) => p[0])) - Math.min(...flatExtent.map((p) => p[0]));
const spanY = Math.max(...flatExtent.map((p) => p[1])) - Math.min(...flatExtent.map((p) => p[1]));
const PAD = 4;
const HEIGHT = Math.round(((WIDTH - PAD * 2) * spanY) / spanX + PAD * 2);
const P = k.fitProjection(extent, WIDTH, HEIGHT, { pad: PAD, azimuth: AZIMUTH, elevation: ELEVATION });
const V = G.viewOf(P);
const L = G.lightOf(P);
const at = (u, v, z) => k.iso(W(u, v, z), P);

// ---------- the recorder: every drawn item and the shape it really is ----------
const STAGGER = [];
const SPRING = { stagger: 0.03, stiffness: 64, damping: 16, substeps: 4 };
const R = A.recorder(P, { order: STAGGER, spring: SPRING });
const MOVES = {};
const piece = (name, move) => {
  if (!MOVES[name]) {
    MOVES[name] = move;
    STAGGER.push(name);
  }
  return name;
};
const put = (name, centre, svg, shapes, { bias = 0, part = "", live } = {}) =>
  R.put({ name: R.nameFor(name), at: centre, bias, piece: part, move: MOVES[part] ?? [0, 0, 0], svg, live, shapes: shapes.map((s) => R.solid({ ...s, name: s.name ?? name })) });
const ground = (shape, name) => R.solid({ ...shape, name: `stand.${name}` });

// ---------- drawing helpers ----------
const S = (paths, style) => k.solidSvg(paths, style);
const Ln = (d, style) => (d ? k.lineSvg(d, style) : "");
const Dt = (points, style) => k.dotsSvg(points, style);
const cylAt = (u, v, r, z, h, steps) => k.cylinder(-v, -u, r, z, h, P, steps ?? Math.max(24, Math.round(r * 6)));
const shapeCyl = (u, v, r, z, h, name) => A.cylinder(-v, -u, r, z, h, name ? { name } : {});
const ringAt = (u, v, r, z, steps = 40) => k.ring(-v, -u, r, z, P, steps);
const arcFront = (u, v, r, z, steps = 24) => k.sideArc(-v, -u, r, z, P, steps);
const onTop = (pts, z, closed = false) => k.onTop(pts.map(([u, v]) => [-v, -u]), z, P, closed);
const slab = (u, v, w, d, r, z, h, steps = 3, bevel = 0) => k.slabOf(plan(u, v, w, d, r), z, h, P, steps, bevel);
const shapeSlab = (u, v, w, d, r, z, h, steps = 3) => A.slab(plan(u, v, w, d, r), z, h, {}, steps);
const seam = (u, v, w, d, r, z, steps = 3) => Ln(k.sideSeam(plan(u, v, w, d, r), z, P, steps), { tone: "faint" });
const path = (pts, closed = false) => k.pathOf(pts, closed);
const signed = (pts) => pts.reduce((sum, [x, y], i) => {
  const [nx, ny] = pts[(i + 1) % pts.length];
  return sum + x * ny - nx * y;
}, 0);
const orient = (pts, positive = true) => ((signed(pts) > 0) === positive ? pts : [...pts].reverse());
const unit2 = ([x, y]) => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};
// a matrix that lays flat drawing (x along `ex`, y along `ey`, both world directions) onto a face at world point `o`
function faceMatrix(o, ex, ey) {
  const p0 = k.iso(o, P);
  const px = k.iso(G.add3(o, ex), P);
  const py = k.iso(G.add3(o, ey), P);
  const f = (x) => Math.round(x * 1000) / 1000;
  return `matrix(${f(px[0] - p0[0])} ${f(px[1] - p0[1])} ${f(py[0] - p0[0])} ${f(py[1] - p0[1])} ${f(p0[0])} ${f(p0[1])})`;
}

// ---------- the letters: JetBrains Mono 600, the site's own face, extruded back along v ----------
// Painted like the kit's extrude with the front face as the cap: walls by run, far to near, each with its far edge,
// then the front face over them, then its own edges. Concave outlines and counters keep their true edges.
function frontPrism(rings, v0, depth) {
  const fill = [];
  const runs = [];
  const faces = [];
  const frontEdge = [];
  for (const { ring, hole } of rings) {
    const n = ring.length;
    const front = ring.map(([u, z]) => at(u, v0, z));
    const back = ring.map(([u, z]) => at(u, v0 + depth, z));
    const normals = ring.map(([u0, z0], i) => {
      const [u1, z1] = ring[(i + 1) % n];
      const len = Math.hypot(u1 - u0, z1 - z0) || 1;
      return [0, -(z1 - z0) / len, -(u1 - u0) / len];
    });
    const facing = normals.map((normal) => G.dot3(normal, V) > 1e-9);
    faces.push(path(orient(front, !hole), true));
    fill.push(path(orient(front, !hole), true), path(orient(back, !hole), true));
    const start = facing.findIndex((f) => !f);
    const order = start < 0 ? [...Array(n).keys()] : Array.from({ length: n }, (_, i) => (start + 1 + i) % n);
    let run = null;
    const close = () => {
      if (run) runs.push(run);
      run = null;
    };
    for (const i of order) {
      if (!facing[i]) {
        close();
        frontEdge.push(path([front[i], front[(i + 1) % n]]));
        continue;
      }
      if (!run) run = { edges: [], depth: 0, open: facing[(i + n - 1) % n] === false };
      run.edges.push(i);
      const quad = orient([front[i], front[(i + 1) % n], back[(i + 1) % n], back[i]]);
      fill.push(path(quad, true));
      run.ring = { front, back, normals, n };
    }
    close();
    for (const r of runs.filter((r) => r.ring && r.ring.front === front)) {
      const first = r.edges[0];
      const last = r.edges[r.edges.length - 1];
      r.depth = r.edges.reduce((sum, i) => sum + k.depthOf(W(ring[i][0], v0 + depth / 2, ring[i][1]), P), 0) / r.edges.length;
      r.tones = [[], [], [], [], []];
      for (const i of r.edges) {
        const tone = Math.min(4, G.bandOf(G.dot3(r.ring.normals[i], L)));
        r.tones[tone].push(path(orient([front[i], front[(i + 1) % n], back[(i + 1) % n], back[i]]), true));
      }
      r.back = path([...r.edges.map((i) => back[i]), back[(last + 1) % n]]);
      r.ends = [path([front[first], back[first]]), path([front[(last + 1) % n], back[(last + 1) % n]])];
      r.crease = path([...r.edges.map((i) => front[i]), front[(last + 1) % n]]);
    }
  }
  runs.sort((a, b) => a.depth - b.depth);
  const frontTone = Math.min(3, G.bandOf(G.dot3([1, 0, 0], L)));
  const parts = [`<path class="iso-fill" d="${fill.join("")}"/>`];
  for (const r of runs) {
    r.tones.forEach((list, tone) => list.length && parts.push(tone === 4 ? `<path class="iso-top" d="${list.join("")}"/>` : `<path class="iso-shade" data-shade="${tone}" d="${list.join("")}"/>`));
    parts.push(`<path class="iso-line iso-edge" data-tone="hi" d="${r.back}${r.ends.join("")}"/>`);
  }
  parts.push(`<path class="iso-shade sr-face" data-shade="${frontTone}" d="${faces.join("")}"/>`);
  parts.push(`<path class="iso-line" data-tone="faint" d="${rings.map(({ ring }) => path(inset(ring, 0.9).map(([u, z]) => at(u, v0, z)), true)).join("")}"/>`);
  parts.push(`<path class="iso-line iso-crease" data-tone="lo" d="${runs.map((r) => r.crease).join("")}"/>`);
  parts.push(`<path class="iso-line iso-edge" data-tone="hi" d="${frontEdge.join("")}"/>`);
  return `<g class="iso-solid sr-glyph">${parts.join("")}</g>`;
}

// a chamfer's inner edge: the ring moved into the metal (material lies to the left of every edge)
function inset(ring, by) {
  const n = ring.length;
  return ring.map(([u, z], i) => {
    const [pu, pz] = ring[(i + n - 1) % n];
    const [nu, nz] = ring[(i + 1) % n];
    const a = unit2([u - pu, z - pz]);
    const b = unit2([nu - u, nz - z]);
    const m = unit2([-(a[1] + b[1]), a[0] + b[0]]);
    const cos = Math.max(0.45, m[0] * -b[1] + m[1] * b[0]);
    return [u + (m[0] * by) / cos, z + (m[1] * by) / cos];
  });
}
const FONT = create(readFileSync(join(SITE, "public/fonts/jetbrains-mono-600-normal.woff2")));
// the r's ink trap is drawn as a contour that doubles back into its stem; a machined letter has a plain shoulder there
function fixInkTrap(ch, commands) {
  if (ch !== "r") return commands;
  return commands
    .filter(({ command, args }) => !(command === "lineTo" && args[0] === 220 && args[1] === 445))
    .map(({ command, args }) => {
      if (command === "lineTo" && args[0] === 199) return { command, args: [201, args[1]] };
      if (command === "lineTo" && args[0] === 191 && args[1] === 380) return { command, args: [201, 445] };
      if (command === "quadraticCurveTo" && args[0] === 191 && args[1] === 469) return { command, args: [201, 482, args[2], args[3]] };
      return { command, args };
    });
}
function glyphRings(ch) {
  const rings = [];
  let ring = null;
  let last = null;
  const flush = () => {
    if (ring && ring.length > 2) rings.push(ring);
    ring = null;
  };
  for (const { command, args } of fixInkTrap(ch, FONT.glyphForCodePoint(ch.codePointAt(0)).path.commands)) {
    if (command === "moveTo") {
      flush();
      ring = [[args[0], args[1]]];
      last = [args[0], args[1]];
    } else if (command === "lineTo") {
      ring.push([args[0], args[1]]);
      last = [args[0], args[1]];
    } else if (command === "quadraticCurveTo") {
      const [cx, cy, x, y] = args;
      const steps = Math.max(2, Math.ceil(Math.sqrt(Math.hypot(x - last[0], y - last[1]) / 6)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const a = (1 - t) * (1 - t);
        const b = 2 * (1 - t) * t;
        const c = t * t;
        ring.push([a * last[0] + b * cx + c * x, a * last[1] + b * cy + c * y]);
      }
      last = [x, y];
    } else if (command === "closePath") flush();
  }
  flush();
  return rings
    .map((points) => clipBaseline(points.filter((p, i) => {
      const q = points[(i + 1) % points.length];
      return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5;
    })))
    .filter((r) => r.length > 2);
}
// round letters stand on a flat machined foot at the baseline
function clipBaseline(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a[1] >= 0) out.push(a);
    if (a[1] >= 0 !== b[1] >= 0) out.push([a[0] + ((b[0] - a[0]) * a[1]) / (a[1] - b[1]), 0]);
  }
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05;
  });
}
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function letterParts(ch, i) {
  const left = cellU(i) - CELL / 2;
  const rings = glyphRings(ch).map((ring) => ring.map(([x, y]) => [left + x / 10, LETTER.base + y / 10]));
  const holes = rings.map((ring, index) => rings.some((other, j) => j !== index && inside(ring[0], other)));
  return rings
    .filter((_, index) => !holes[index])
    .map((outer) => ({
      outer: signed(outer) > 0 ? outer : [...outer].reverse(),
      counters: rings.filter((ring, index) => holes[index] && inside(ring[0], outer)).map((c) => (signed(c) < 0 ? c : [...c].reverse())),
    }))
    .sort((a, b) => Math.min(...a.outer.map((p) => p[1])) - Math.min(...b.outer.map((p) => p[1])));
}

// ---------- the bench ----------
function bench() {
  const p = plan(BASE.u, BASE.v, BASE.w, BASE.d, BASE.r);
  ground(A.slab(p, -BASE.h, BASE.h, {}, 8), "plate");
  const out = [`<path class="iso-halo" d="${k.haloOf(p, -BASE.h - 6, BASE.h, P)}"/>`];
  const feet = [[BASE.u + 30, BASE.v + 22], [BASE.u + BASE.w - 30, BASE.v + 22], [BASE.u + 30, BASE.v + BASE.d - 22], [BASE.u + BASE.w - 30, BASE.v + BASE.d - 22]];
  feet.sort((a, b) => k.depthOf(W(a[0], a[1], 0), P) - k.depthOf(W(b[0], b[1], 0), P));
  for (const [u, v] of feet) {
    out.push(S(cylAt(u, v, 9, -BASE.h - 6, 1.8, 48), { tone: "lo" }));
    out.push(S(cylAt(u, v, 7, -BASE.h - 4.2, 4.2, 40), { tone: "mid" }) + Ln(arcFront(u, v, 7, -BASE.h - 2.2, 24), { tone: "faint" }));
  }
  out.push(S(k.slabOf(p, -BASE.h, BASE.h, P, 8, 1.6), { tone: "mid", inner: Ln(k.sideSeam(p, -BASE.h + 4, P, 8), { tone: "faint" }) }));
  out.push(Ln(k.planOutline(k.insetPlan(p, 5), 0, P), { tone: "lo" }));
  const screws = [[BASE.u + 11, BASE.v + 11], [BASE.u + BASE.w - 11, BASE.v + 11], [BASE.u + 11, BASE.v + BASE.d - 11], [BASE.u + BASE.w - 11, BASE.v + BASE.d - 11]];
  out.push(Ln(screws.map(([u, v]) => ringAt(u, v, 2.6, 0, 18)).join(""), { tone: "lo" }));
  out.push(Dt(screws.map(([u, v]) => at(u, v, 0)), { size: 0.55 }));
  // a T-slot runs the length of the bench behind the word
  const slot = { u: BASE.u + 20, v: 30, w: BASE.w - 40, d: 3.4, r: 1.7 };
  out.push(Ln(k.planOutline(plan(slot.u, slot.v, slot.w, slot.d, slot.r), 0, P, 6), { tone: "lo" }));
  // the ruler strip along the front edge, ticks every 5, a major every 25
  const strip = { u: -250, v: -73, w: 290, d: 6, r: 0.8 };
  out.push(S(slab(strip.u, strip.v, strip.w, strip.d, strip.r, 0, 0.6, 3), { tone: "lo", crease: "none" }));
  ground(shapeSlab(strip.u, strip.v, strip.w, strip.d, strip.r, 0, 0.6), "ruler");
  const ticks = k.topTicks(-strip.u - strip.w + 4, -strip.u - 4, 5, 5, -(strip.v + strip.d) + 0.2, 0.6, [2, 3.8], P, "y");
  out.push(Ln(ticks.minor, { tone: "lo" }), Ln(ticks.major, { tone: "mid" }));
  out.push(Ln(onTop([[0, strip.v + strip.d - 0.2], [0, strip.v + 0.4]], 0.6), { tone: "hi" }));
  out.push(Dt([at(strip.u + 2, strip.v + strip.d / 2, 0.6), at(strip.u + strip.w - 2, strip.v + strip.d / 2, 0.6)], { size: 0.45 }));
  // the label plate
  const tag = { u: 294, v: -45, w: 62, d: 13, r: 1.4 };
  out.push(S(slab(tag.u, tag.v, tag.w, tag.d, tag.r, 0, 0.8, 4), { tone: "lo", crease: "none" }));
  ground(shapeSlab(tag.u, tag.v, tag.w, tag.d, tag.r, 0, 0.8), "label");
  out.push(Ln(k.planOutline(plan(tag.u + 1.6, tag.v + 1.6, tag.w - 3.2, tag.d - 3.2, 0.6), 0.8, P, 3), { tone: "faint" }));
  out.push(Ln(onTop([[tag.u + 6, tag.v + 4.4], [tag.u + 40, tag.v + 4.4]], 0.8) + onTop([[tag.u + 6, tag.v + 3.0], [tag.u + 28, tag.v + 3.0]], 0.8), { tone: "lo", free: true }));
  out.push(Dt([at(tag.u + 3.4, tag.v + tag.d / 2, 0.8), at(tag.u + tag.w - 3.4, tag.v + tag.d / 2, 0.8)], { size: 0.45 }));
  return out.join("");
}

// ---------- the film path: rollers and packs in plan, the film tangent between them ----------
const RF = 0.3; // half the film's thickness
const ROLLER = 4.2;
const DRUM = (11 * PITCH) / (2 * Math.PI) - RF;
const PACK = 32;
const FRONT_V = -14.5;
const BACK_V = 12.5;
const PACK_AT = 340;
const PATH = [
  { name: "feed", u: -PACK_AT, v: 16, r: PACK + RF, dir: 1, pack: true },
  { name: "dancer", u: -300, v: -30, r: ROLLER + RF, dir: 1, z0: 1.0 },
  { name: "guide", u: -270, v: FRONT_V - ROLLER - RF, r: ROLLER + RF, dir: -1 },
  { name: "drum", u: -16, v: FRONT_V + DRUM + RF, r: DRUM + RF, dir: 1, z0: SYNC_H },
  { name: "cross", u: 30, v: BACK_V - ROLLER - RF, r: ROLLER + RF, dir: -1 },
  { name: "corner", u: 290, v: BACK_V - ROLLER - RF, r: ROLLER + RF, dir: -1 },
  { name: "return", u: 290 + (ROLLER + RF) * 2, v: 16 - PACK - RF + ROLLER + RF, r: ROLLER + RF, dir: 1 },
  { name: "takeup", u: PACK_AT, v: 16, r: PACK + RF, dir: 1, pack: true },
];
function tangent(a, b) {
  const D = [b.u - a.u, b.v - a.v];
  const kk = b.dir * b.r - a.dir * a.r;
  const t = Math.sqrt(D[0] * D[0] + D[1] * D[1] - kk * kk);
  const theta = Math.atan2(D[1], D[0]) - Math.atan2(kk, t);
  const d = [Math.cos(theta), Math.sin(theta)];
  const left = [-d[1], d[0]];
  return { from: [a.u - a.dir * a.r * left[0], a.v - a.dir * a.r * left[1]], to: [b.u - b.dir * b.r * left[0], b.v - b.dir * b.r * left[1]] };
}
function filmPath() {
  const segs = [];
  const lines = PATH.slice(1).map((b, i) => tangent(PATH[i], b));
  let s = 0;
  lines.forEach((line, i) => {
    const length = Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]);
    segs.push({ kind: "line", a: line.from, b: line.to, s0: s, s1: s + length });
    s += length;
    const c = PATH[i + 1];
    const next = lines[i + 1];
    if (!next) return;
    const a0 = Math.atan2(line.to[1] - c.v, line.to[0] - c.u);
    const a1 = Math.atan2(next.from[1] - c.v, next.from[0] - c.u);
    let sweep = (a1 - a0) * c.dir;
    while (sweep < 0) sweep += Math.PI * 2;
    segs.push({ kind: "arc", c: [c.u, c.v], r: c.r, a0, sweep: sweep * c.dir, s0: s, s1: s + sweep * c.r, roller: c.name });
    s += sweep * c.r;
  });
  return { segs, length: s };
}
const FILM_PATH = filmPath();
const CAM = { origin: P.origin, k: G.scaleOf(P), sinA: Math.sin((AZIMUTH * Math.PI) / 180), cosA: Math.cos((AZIMUTH * Math.PI) / 180), sinE: Math.sin((ELEVATION * Math.PI) / 180), cosE: Math.cos((ELEVATION * Math.PI) / 180) };
const FILM_DATA = { pitch: PITCH, z: FZ, length: FILM_PATH.length, segs: FILM_PATH.segs, perf: { w: 1.3, h: 0.95, inset: 0.7 }, frame: { gap: 0.9, inset: 2.1 } };
function pointAt(s) {
  const seg = FILM_PATH.segs.find((g) => s <= g.s1 + 1e-9) ?? FILM_PATH.segs[FILM_PATH.segs.length - 1];
  const t = (s - seg.s0) / (seg.s1 - seg.s0 || 1);
  if (seg.kind === "line") return { p: [seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t], d: unit2([seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]]) };
  const a = seg.a0 + seg.sweep * t;
  const sgn = Math.sign(seg.sweep);
  return { p: [seg.c[0] + seg.r * Math.cos(a), seg.c[1] + seg.r * Math.sin(a)], d: [-Math.sin(a) * sgn, Math.cos(a) * sgn] };
}

// ---------- rollers: bushing, flange, toothed drum, keeper flange and cap ----------
function roller(c) {
  const r = c.r - RF;
  const flange = r + 1.8;
  const z0 = c.z0 ?? 0;
  const drum = c.name === "drum";
  const name = `roller.${c.name}`;
  const top = FZ[1] + 0.2;
  // the dancer's cap carries the spring, so it stays on
  const keeper = c.name === "dancer" ? "" : piece(`${name}.keeper`, [0, 0, drum ? 30 : 22]);
  const teeth = drum ? 11 : 6;
  const seg = FILM_PATH.segs.find((g) => g.roller === c.name);
  const data = { name: c.name, u: c.u, v: c.v, r: c.r, dir: c.dir, teeth, z: [FZ[0] + 0.3, FZ[1] - 0.3], cap: top + 3.4, slot: r * 0.5, phase: seg.a0 - (c.dir * seg.s0) / c.r, crank: drum ? { r: flange - 2.6, z: top + 3.6 } : null };
  const angle = D.rollerAngle({ ...data, r: c.r }, REST_S);
  const parts = [];
  if (!z0) parts.push(["bush", S(cylAt(c.u, c.v, flange - 0.6, 0, 1.0), { tone: "lo" }), shapeCyl(c.u, c.v, flange - 0.6, 0, 1.0)]);
  const fz = z0 || 1.0;
  parts.push(["flange", S(cylAt(c.u, c.v, flange, fz, FZ[0] - 0.2 - fz, 48), { tone: "mid" }), shapeCyl(c.u, c.v, flange, fz, FZ[0] - 0.2 - fz)]);
  parts.push(["drum", S(cylAt(c.u, c.v, r, FZ[0] - 0.2, top - FZ[0] + 0.2, 48), { tone: drum ? "hi" : "mid", crease: "none" }) + `<path class="iso-line sr-teeth" data-tone="mid" data-roller="${c.name}" d="${D.teeth(CAM, { ...data, r }, angle)}"/>`, shapeCyl(c.u, c.v, r, FZ[0] - 0.2, top - FZ[0] + 0.2)]);
  parts.push(["top", S(cylAt(c.u, c.v, flange, top, 1.4, 48), { tone: "mid" }), shapeCyl(c.u, c.v, flange, top, 1.4), keeper]);
  if (drum) {
    // the synchronizer's hand wheel and crank: the reader can count the turns against the counter
    parts.push(["wheel", S(cylAt(c.u, c.v, flange + 1.2, top + 1.4, 2.2, 64), { tone: "hi" }) + Ln(k.knurl(-c.v, -c.u, flange + 1.2, top + 1.4, top + 3.6, 64, P), { tone: "faint" }) + Ln(ringAt(c.u, c.v, flange - 1.4, top + 3.6, 64), { tone: "lo" }) + Dt([at(c.u, c.v, top + 3.6)], { size: 0.6, tone: "hi" }), shapeCyl(c.u, c.v, flange + 1.2, top + 1.4, 2.2), keeper]);
    const off = D.crankOffset(CAM, data, angle);
    parts.push(["crank", `<g data-crank="${c.name}" transform="translate(${off[0].toFixed(2)} ${off[1].toFixed(2)})">${S(cylAt(c.u + flange - 2.6, c.v, 1.5, top + 3.6, 6, 24), { tone: "mid" })}${S(cylAt(c.u + flange - 2.6, c.v, 2.1, top + 9.6, 2.4, 24), { tone: "hi" })}</g>`, shapeCyl(c.u + flange - 2.6, c.v, 2.1, top + 3.6, 8.4), keeper]);
  } else {
    parts.push(["cap", S(cylAt(c.u, c.v, r * 0.72, top + 1.4, 2.0, 32), { tone: "mid" }) + `<path class="iso-line sr-slot" data-tone="lo" data-roller="${c.name}" d="${D.slot(CAM, data, angle)}"/>`, shapeCyl(c.u, c.v, r * 0.72, top + 1.4, 2.0), keeper]);
  }
  for (const [label, svg, shape, part] of parts) put(`${name}.${label}`, W(c.u, c.v, label === "drum" ? (FZ[0] + FZ[1]) / 2 : label === "flange" || label === "bush" ? 1 : top + 2), svg, [shape], { part: part ?? "" });
  return data;
}

// ---------- packs: the film wound on a core, on a platter with three lightening holes ----------
function platter(c) {
  const name = `pack.${c.name}`;
  const pr = PACK + 10;
  const data = { name: c.name, u: c.u, v: c.v, r: c.r, dir: c.dir, holes: { r: PACK + 5.2, size: 2.6, z: FZ[0] - 0.2 }, keys: { r: 12, z: FZ[1] + 1.2 } };
  const angle = D.packAngle(data, REST_S);
  ground(shapeCyl(c.u, c.v, 15, 0, 1.0), `${name}.bearing`);
  put(`${name}.bearing`, W(c.u, c.v, 0.5), S(cylAt(c.u, c.v, 15, 0, 1.0, 64), { tone: "lo" }), [shapeCyl(c.u, c.v, 15, 0, 1.0)]);
  put(`${name}.platter`, W(c.u, c.v, 1.8), S(cylAt(c.u, c.v, pr, 1.0, FZ[0] - 1.2, 120), { tone: "mid", inner: Ln(arcFront(c.u, c.v, pr, 1.7, 64), { tone: "faint" }) }) + Ln(ringAt(c.u, c.v, pr - 2.2, FZ[0] - 0.2, 120), { tone: "faint" }) + `<path class="iso-line sr-holes" data-tone="lo" data-pack="${c.name}" d="${D.holes(CAM, data, angle)}"/>`, [shapeCyl(c.u, c.v, pr, 1.0, FZ[0] - 1.2)]);
  const rings = [];
  for (let r = 13.6; r < PACK - 0.6; r += 1.5) rings.push(ringAt(c.u, c.v, r, FZ[1] - 0.2, 96));
  put(`${name}.film`, W(c.u, c.v, 7), `<g class="sr-stock">${S(cylAt(c.u, c.v, PACK, FZ[0] - 0.2, FZ[1] - FZ[0], 120), { tone: "hi", inner: Ln(arcFront(c.u, c.v, PACK, FZ[0] + 0.6, 64) + arcFront(c.u, c.v, PACK, FZ[1] - 0.8, 64), { tone: "mid" }) })}${Ln(rings.join(""), { tone: "lo" })}</g>`, [shapeCyl(c.u, c.v, PACK, FZ[0] - 0.2, FZ[1] - FZ[0])]);
  put(`${name}.core`, W(c.u, c.v, 13), S(cylAt(c.u, c.v, 12, FZ[1] - 0.2, 1.4, 64), { tone: "mid" }) + `<path class="iso-line sr-keys" data-tone="lo" data-pack="${c.name}" d="${D.keys(CAM, data, angle)}"/>`, [shapeCyl(c.u, c.v, 12, FZ[1] - 0.2, 1.4)]);
  const knob = piece(`${name}.knob`, [0, 0, 30]);
  const kz = FZ[1] + 1.2;
  put(`${knob}.collar`, W(c.u, c.v, kz + 0.6), S(cylAt(c.u, c.v, 8.4, kz, 1.4, 48), { tone: "mid" }), [shapeCyl(c.u, c.v, 8.4, kz, 1.4)], { part: knob });
  put(`${knob}.body`, W(c.u, c.v, kz + 4), S(cylAt(c.u, c.v, 6.6, kz + 1.4, 5.6, 48), { tone: "hi" }) + Ln(k.knurl(-c.v, -c.u, 6.6, kz + 1.4, kz + 7, 44, P), { tone: "lo" }) + Ln(ringAt(c.u, c.v, 3.2, kz + 7, 24), { tone: "lo" }) + Dt([at(c.u, c.v, kz + 7)], { size: 0.55, tone: "hi" }), [shapeCyl(c.u, c.v, 6.6, kz + 1.4, 5.6)], { part: knob });
  return data;
}

// ---------- letters on plinths, plinths on a type rail per word ----------
function rails() {
  for (const [u0, u1] of [[cellU(0) - 24, cellU(3) + 22], [cellU(5) - 22, cellU(8) + 24]]) {
    const v0 = -RAIL.d / 2;
    const ends = [[u0 + 3.4, 0], [u1 - 3.4, 0]];
    put("rail", W((u0 + u1) / 2, 0, RAIL.h / 2), S(slab(u0, v0, u1 - u0, RAIL.d, 1.4, 0, RAIL.h, 3, 0.5), { tone: "lo" }) + Ln(ends.map(([u, v]) => ringAt(u, v, 1.6, RAIL.h, 16)).join(""), { tone: "lo" }) + Dt(ends.map(([u, v]) => at(u, v, RAIL.h)), { size: 0.45 }), [shapeSlab(u0, v0, u1 - u0, RAIL.d, 1.4, 0, RAIL.h)]);
  }
}
function letters() {
  [...WORD].forEach((ch, i) => {
    if (ch === " ") return;
    const cu = cellU(i);
    const pu = cu - PLINTH.w / 2;
    const pv = -PLINTH.d / 2;
    const screws = [[pu + 3.4, pv + 3], [pu + PLINTH.w - 3.4, pv + 3]];
    const pz = RAIL.h;
    const ph = PLINTH.h;
    put(`plinth.${i}`, W(cu, 0, pz + ph / 2), S(slab(pu, pv, PLINTH.w, PLINTH.d, 1.6, pz, ph, 3, 0.6), { tone: "mid", inner: seam(pu, pv, PLINTH.w, PLINTH.d, 1.6, pz + 2.4) }) + Ln(screws.map(([u, v]) => ringAt(u, v, 1.3, pz + ph, 14)).join(""), { tone: "lo" }) + Dt(screws.map(([u, v]) => at(u, v, pz + ph)), { size: 0.42 }), [shapeSlab(pu, pv, PLINTH.w, PLINTH.d, 1.6, pz, ph)]);
    const parts = letterParts(ch, i);
    // the dot leaves before its letter and comes home after it, so the stem never passes through it
    if (parts.length > 1) piece(`letter.${i}.dot`, [0, 0, 58]);
    parts.forEach((part, j) => {
      const id = piece(`letter.${i}${j ? ".dot" : ""}`, [0, 0, j ? 58 : 40]);
      const rings = [{ ring: part.outer, hole: false }, ...part.counters.map((ring) => ({ ring, hole: true }))];
      const F = { o: W(0, LETTER.front, 0), a: [1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] };
      const shape = A.prism(F, part.outer, -LETTER.depth, 0, { ...(part.counters.length ? { cut: part.counters.map((c) => A.prism(F, c, -LETTER.depth - 1, 1)) } : {}) });
      const zs = part.outer.map((p) => p[1]);
      const us = part.outer.map((p) => p[0]);
      let svg = frontPrism(rings, LETTER.front, LETTER.depth);
      const shapes = [shape];
      if (j) {
        // the dot of the i stands on a dowel from the stem
        const du = (Math.min(...us) + Math.max(...us)) / 2;
        const z0 = LETTER.base + 55;
        const z1 = Math.min(...zs);
        svg = S(cylAt(du, 0, 1.5, z0, z1 - z0, 20), { tone: "mid" }) + svg;
        shapes.push(shapeCyl(du, 0, 1.5, z0, z1 - z0));
      }
      put(id, W(cu, 0, (Math.min(...zs) + Math.max(...zs)) / 2), svg, shapes, { part: id });
    });
  });
}

// ---------- the gate: an aperture plate in front of the film, a pressure shoe behind it ----------
const GATE = { u: -136, w: 26 };
function gate() {
  const { u, w } = GATE;
  const base = [u - 3, -26, w + 6, 16.4];
  put("gate.base", W(u + w / 2, -18, 0.7), S(slab(...base, 1.2, 0, 1.4, 3, 0.4), { tone: "lo" }) + Dt([at(u - 1, -24, 1.4), at(u + w + 1, -24, 1.4)], { size: 0.42 }), [shapeSlab(...base, 1.2, 0, 1.4)]);
  put("gate.shoe", W(u + w / 2, -12.2, 8), S(slab(u + 2, FRONT_V + RF + 0.2, w - 4, 3.2, 0.6, 1.4, FZ[1] + 1.6, 3), { tone: "mid" }), [shapeSlab(u + 2, FRONT_V + RF + 0.2, w - 4, 3.2, 0.6, 1.4, FZ[1] + 1.6)]);
  const door = piece("gate.door", W(0, -16, 0));
  const pv = FRONT_V - RF - 0.6 - 6.4;
  const face = pv;
  const win = { u0: u + 8, u1: u + w - 8, z0: FZ[0] + 1.6, z1: FZ[1] - 1.6 };
  const winPts = [[win.u0, win.z0], [win.u1, win.z0], [win.u1, win.z1], [win.u0, win.z1]].map(([wu, wz]) => at(wu, face, wz));
  const svg = S(slab(u, pv, w, 6.4, 1.2, 1.4, FZ[1] + 2.2, 3, 0.5), { tone: "mid", inner: seam(u, pv, w, 6.4, 1.2, 4.4) })
    + `<path class="sr-window" d="${path(winPts, true)}"/>`
    + `<path class="iso-line sr-gate" data-tone="lit" d="${path(winPts, true)}"/>`
    + Dt([at(u + 3, face, FZ[1]), at(u + w - 3, face, FZ[1]), at(u + 3, face, FZ[0] + 0.6), at(u + w - 3, face, FZ[0] + 0.6)], { size: 0.42 })
    + S(cylAt(u + w / 2, pv + 3.2, 2.6, FZ[1] + 3.6, 3.6, 28), { tone: "hi" }) + Ln(k.knurl(-(pv + 3.2), -(u + w / 2), 2.6, FZ[1] + 3.6, FZ[1] + 7.2, 22, P), { tone: "lo" });
  put("gate.door", W(u + w / 2, pv + 3.2, 8), svg, [shapeSlab(u, pv, w, 6.4, 1.2, 1.4, FZ[1] + 2.2), shapeCyl(u + w / 2, pv + 3.2, 2.6, FZ[1] + 3.6, 3.6)], { part: door });
}

// ---------- the tension arm: a dancer roller on a pivoting arm, held by a coil spring ----------
function tensionArm() {
  const d = PATH[1];
  const pivot = [-324, -40];
  const ring = G.stadium(4.2, 4.2, Math.hypot(d.u - pivot[0], d.v - pivot[1]));
  const ang = Math.atan2(d.v - pivot[1], d.u - pivot[0]);
  const armRing = ring.map(([x, y]) => [pivot[0] + x * Math.cos(ang) - y * Math.sin(ang), pivot[1] + x * Math.sin(ang) + y * Math.cos(ang)]);
  const worldRing = armRing.map(([u, v]) => [-v, -u]);
  put("arm.lever", W((pivot[0] + d.u) / 2, (pivot[1] + d.v) / 2, 0.5), S(k.extrude(worldRing, 0, 1.0, P, { convex: true, bevel: 0.3 }), { tone: "mid" }), [A.extruded(worldRing, 0, 1.0)]);
  put("arm.pivot", W(...pivot, 2.5), S(cylAt(...pivot, 2.6, 1.0, 3.0, 24), { tone: "hi" }) + Dt([at(...pivot, 4.0)], { size: 0.5, tone: "hi" }), [shapeCyl(...pivot, 2.6, 1.0, 3.0)]);
  const post = [d.u, -44];
  const top = 18;
  put("arm.post", W(...post, 9), S(cylAt(...post, 3.2, 0, 1.6, 28), { tone: "lo" }) + S(cylAt(...post, 1.9, 1.6, top - 1.6, 24), { tone: "mid", crease: "none" }) + S(cylAt(...post, 2.4, top, 1.4, 24), { tone: "mid" }), [shapeCyl(...post, 1.9, 1.6, top - 1.6), shapeCyl(...post, 3.2, 0, 1.6)]);
  const cz = FZ[1] + 0.2 + 1.4 + 1.4;
  const from = -(post[1] + 1.9);
  const to = -(d.v - ROLLER * 0.72);
  const coil = k.coil(from, to, [-d.u, cz], 1.0, 9, "x", P);
  put("arm.spring", W(d.u, (post[1] + d.v) / 2, cz), Ln(coil.back, { tone: "lo" }) + Ln(k.segment([from, -d.u, cz], [to, -d.u, cz], P), { tone: "faint" }) + Ln(coil.front, { tone: "mid" }), [A.tube([W(d.u, post[1] + 1.9, cz), W(d.u, d.v - ROLLER * 0.72, cz)], 1.0)]);
}

// ---------- the counter: three number wheels behind a window, driven from the sprocket drum ----------
const COUNTER = { u: -2, v: -37, w: 34, d: 16, h: 18 };
function counter() {
  const { u, v, w, d, h } = COUNTER;
  const z0 = SYNC_H;
  put("sync.plate", W(SYNC.u + SYNC.w / 2, SYNC.v + SYNC.d / 2, 0.6), S(slab(SYNC.u, SYNC.v, SYNC.w, SYNC.d, 2, 0, SYNC_H, 4, 0.4), { tone: "lo" }) + Ln([[SYNC.u + 3, SYNC.v + 3], [SYNC.u + SYNC.w - 3, SYNC.v + 3], [SYNC.u + 3, SYNC.v + SYNC.d - 3]].map(([a, b]) => ringAt(a, b, 1.4, SYNC_H, 14)).join(""), { tone: "lo" }) + Dt([[SYNC.u + 3, SYNC.v + 3], [SYNC.u + SYNC.w - 3, SYNC.v + 3], [SYNC.u + 3, SYNC.v + SYNC.d - 3]].map(([a, b]) => at(a, b, SYNC_H)), { size: 0.42 }), [shapeSlab(SYNC.u, SYNC.v, SYNC.w, SYNC.d, 2, 0, SYNC_H)]);
  const face = v;
  const win = { u0: u + 6, u1: u + w - 6, z0: z0 + 6.2, z1: z0 + 13.4 };
  const cols = 3;
  const colW = (win.u1 - win.u0) / cols;
  const fm = (wu, wz) => faceMatrix(W(wu, face, wz), W(1, 0, 0), W(0, 0, -1));
  const winPath = path([[win.u0, win.z0], [win.u1, win.z0], [win.u1, win.z1], [win.u0, win.z1]].map(([a, b]) => at(a, face, b)), true);
  const DIGIT = 7.4;
  const wheels = Array.from({ length: cols }, (_, c) => {
    const cx = win.u0 + colW * (c + 0.5);
    const digits = Array.from({ length: 11 }, (_, n) => `<text x="0" y="${(n * DIGIT + 2.4).toFixed(2)}" text-anchor="middle">${n % 10}</text>`).join("");
    const pos = D.wheels(REST_FRAME, FILM.frames, cols)[c];
    return `<g transform="${fm(cx, (win.z0 + win.z1) / 2)}"><g data-wheel="${c}" transform="translate(0 ${(-pos * DIGIT).toFixed(2)})">${digits}</g></g>`;
  }).join("");
  const dividers = Array.from({ length: cols - 1 }, (_, c) => win.u0 + colW * (c + 1)).map((x) => path([at(x, face, win.z0), at(x, face, win.z1)])).join("");
  const body = S(slab(u, v, w, d, 1.6, z0, h, 4, 0.6), { tone: "mid", inner: seam(u, v, w, d, 1.6, z0 + 2.2, 4) })
    + `<clipPath id="sr-counter-window"><path d="${winPath}"/></clipPath>`
    + `<path class="sr-wheels" d="${winPath}"/>`
    + `<g class="sr-digits" clip-path="url(#sr-counter-window)">${wheels}</g>`
    + Ln(dividers, { tone: "lo" })
    + `<path class="iso-line" data-tone="hi" d="${winPath}"/>`
    + Ln(path([at(win.u0 - 1.6, face, win.z0 - 1.6), at(win.u1 + 1.6, face, win.z0 - 1.6), at(win.u1 + 1.6, face, win.z1 + 1.6), at(win.u0 - 1.6, face, win.z1 + 1.6)], true), { tone: "lo" })
    + Dt([at(u + 2.6, face, z0 + 2.6), at(u + w - 2.6, face, z0 + 2.6), at(u + 2.6, face, z0 + h - 2.6), at(u + w - 2.6, face, z0 + h - 2.6)], { size: 0.42 });
  put("counter.body", W(u + w / 2, v + d / 2, z0 + h / 2), body, [shapeSlab(u, v, w, d, 1.6, z0, h)]);
  // the reset knob on the left face
  const KF = G.frameAlong(W(u, v + d / 2, z0 + h / 2), W(-1, 0, 0));
  const knob = G.disc(0, 3.2, 3.4, KF, P);
  const ribs = G.ribsOf(KF, 0.3, 2.9, 3.4, 28, P, { fade: [0.1, 0.55] });
  put("counter.knob", W(u - 1.6, v + d / 2, z0 + h / 2), S(knob, { tone: "hi" }) + k.fadedSvg(ribs, { tone: "lo" }) + Ln(G.circleOf(KF, 3.2, 1.4, P, 20), { tone: "lo" }), [A.disc(KF, 0, 3.2, 3.4)]);
  const lid = piece("counter.lid", [0, 0, 16]);
  const lv = [u - 0.8, v - 0.8, w + 1.6, d + 1.6];
  put("counter.lid", W(u + w / 2, v + d / 2, z0 + h + 1), S(slab(...lv, 2, z0 + h, 2.2, 4, 0.6), { tone: "mid" }) + Ln(k.planOutline(plan(u + 3, v + 3, w - 6, d - 6, 1), z0 + h + 2.2, P, 3), { tone: "faint" }) + Dt([at(u + 1.6, v + 1.6, z0 + h + 2.2), at(u + w - 1.6, v + 1.6, z0 + h + 2.2), at(u + 1.6, v + d - 1.6, z0 + h + 2.2), at(u + w - 1.6, v + d - 1.6, z0 + h + 2.2)], { size: 0.45 }), [shapeSlab(...lv, 2, z0 + h, 2.2)], { part: lid });
  return { digit: DIGIT, cols };
}

// ---------- a film splicer: a platen with registration pins, a hinged cutter arm ----------
function splicer() {
  const sp = { u: -252, v: -37, w: 56, d: 15 };
  const h = 3;
  const screws = [[sp.u + 2.6, sp.v + 2.4], [sp.u + sp.w - 2.6, sp.v + 2.4], [sp.u + 2.6, sp.v + sp.d - 2.4], [sp.u + sp.w - 2.6, sp.v + sp.d - 2.4]];
  const channel = [sp.v + 4.6, sp.v + 10.4].map((v) => onTop([[sp.u, v], [sp.u + sp.w, v]], h)).join("");
  const pins = Array.from({ length: 9 }, (_, i) => [sp.u + 9 + i * PITCH, sp.v + 7.5]);
  put("splicer.base", W(sp.u + sp.w / 2, sp.v + sp.d / 2, h / 2), S(slab(sp.u, sp.v, sp.w, sp.d, 1.4, 0, h, 3, 0.5), { tone: "mid", inner: seam(sp.u, sp.v, sp.w, sp.d, 1.4, 1.2) }) + Ln(channel, { tone: "faint" }) + Ln(pins.map(([u, v]) => ringAt(u, v, 0.7, h, 12)).join(""), { tone: "mid" }) + Dt(pins.map(([u, v]) => at(u, v, h)), { size: 0.32, tone: "hi" }) + Dt(screws.map(([u, v]) => at(u, v, h)), { size: 0.4 }), [shapeSlab(sp.u, sp.v, sp.w, sp.d, 1.4, 0, h)]);
  const arm = piece("splicer.arm", [0, 0, 14]);
  const hinge = [sp.u + 3, sp.v + sp.d - 4, 5.8, 3.2];
  put("splicer.arm", W(sp.u + sp.w / 2, sp.v + sp.d - 2.5, h + 1.2), S(slab(...hinge, 0.8, h, 3.4, 2, 0.3), { tone: "mid" }) + S(slab(sp.u + 9, sp.v + sp.d - 3.6, sp.w - 15, 2.4, 1.0, h, 1.6, 3, 0.3), { tone: "hi" }) + Ln(onTop([[sp.u + 9, sp.v + sp.d - 2.4], [sp.u + sp.w - 7, sp.v + sp.d - 2.4]], h + 1.6), { tone: "faint" }) + S(cylAt(sp.u + sp.w - 4.2, sp.v + sp.d - 2.4, 2.0, h, 3.0, 24), { tone: "hi" }) + Ln(k.knurl(-(sp.v + sp.d - 2.4), -(sp.u + sp.w - 4.2), 2.0, h, h + 3.0, 18, P), { tone: "lo" }) + Dt([at(hinge[0] + 3, hinge[1] + 1.6, h + 3.4)], { size: 0.45, tone: "hi" }), [shapeSlab(...hinge, 0.8, h, 3.4), shapeSlab(sp.u + 9, sp.v + sp.d - 3.6, sp.w - 15, 2.4, 1.0, h, 1.6), shapeCyl(sp.u + sp.w - 4.2, sp.v + sp.d - 2.4, 2.0, h, 3.0)], { part: arm });
}

// ---------- a spare core on a peg, waiting for the next reel ----------
function spareCore() {
  const c = [196, -28];
  put("core.base", W(...c, 0.5), S(cylAt(...c, 7.4, 0, 1.0, 48), { tone: "lo" }) + Dt([at(c[0] - 5.6, c[1], 1.0), at(c[0] + 5.6, c[1], 1.0)], { size: 0.4 }) + S(cylAt(...c, 1.8, 1.0, 10, 20), { tone: "mid", crease: "none" }), [shapeCyl(...c, 7.4, 0, 1.0)]);
  const core = piece("core.spare", [0, 0, 20]);
  const coreData = { u: c[0], v: c[1], keys: { r: 9.2, z: 11 } };
  put("core.spare", W(...c, 6), S(cylAt(...c, 9.6, 1.0, 10, 64), { tone: "hi", inner: Ln(arcFront(...c, 9.6, 6, 40), { tone: "faint" }) }) + Ln(ringAt(...c, 2.9, 11, 24), { tone: "faint" }) + Ln(D.keys(CAM, coreData, 0.4), { tone: "lo" }), [shapeCyl(...c, 9.6, 1.0, 10)], { part: core });
}

// ---------- two film cans stacked at the front left, the top one open with its lid leaning on the stack ----------
function cans() {
  const c = [-358, -50];
  const R = 19;
  ground(shapeCyl(c[0], c[1], R, 0, 5.2), "cans.bottom");
  put("cans.bottom", W(c[0], c[1], 2.6), S(cylAt(c[0], c[1], R, 0, 5.2, 96), { tone: "mid", inner: Ln(arcFront(c[0], c[1], R, 1.4, 48), { tone: "faint" }) }) + Ln(ringAt(c[0], c[1], R - 1.6, 5.2, 96) + ringAt(c[0], c[1], R - 8, 5.2, 72), { tone: "lo" }) + Ln(ringAt(c[0], c[1], 4, 5.2, 24), { tone: "faint" }), [shapeCyl(c[0], c[1], R, 0, 5.2)]);
  const lid = piece("cans.top", [0, 0, 22]);
  put("cans.top", W(c[0], c[1], 7.8), S(cylAt(c[0], c[1], R + 0.6, 5.2, 5.2, 96), { tone: "hi", inner: Ln(arcFront(c[0], c[1], R + 0.6, 6.6, 48), { tone: "faint" }) }) + Ln(ringAt(c[0], c[1], R - 1.2, 10.4, 96) + ringAt(c[0], c[1], R - 5, 10.4, 72) + ringAt(c[0], c[1], R - 9, 10.4, 72), { tone: "lo" }) + Ln(ringAt(c[0], c[1], 3.2, 10.4, 24), { tone: "lo" }) + Dt([at(c[0], c[1], 10.4)], { size: 0.5, tone: "hi" }), [shapeCyl(c[0], c[1], R + 0.6, 5.2, 5.2)], { part: lid });
  // the can's label: a tape strip across the lid with three rule lines
  const tape = { u: c[0] - 10, v: c[1] - 3.5, w: 20, d: 7 };
  put("cans.tape", W(c[0], c[1], 10.6), S(slab(tape.u, tape.v, tape.w, tape.d, 0.4, 10.4, 0.3, 2), { tone: "hi", crease: "none" }) + Ln(onTop([[tape.u + 2, tape.v + 5], [tape.u + 14, tape.v + 5]], 10.7) + onTop([[tape.u + 2, tape.v + 3.5], [tape.u + 18, tape.v + 3.5]], 10.7) + onTop([[tape.u + 2, tape.v + 2], [tape.u + 10, tape.v + 2]], 10.7), { tone: "lo", free: true }), [shapeSlab(tape.u, tape.v, tape.w, tape.d, 0.4, 10.4, 0.3)], { part: lid });
}

// ---------- the board the film is made from: the iCEBreaker's own top copper, on four standoffs ----------
// figure/board.json comes from figure/board.mts (parsed from fixtures/boards/icebreaker.kicad_pcb). U4 lights while the film holds on it.
const PCB = JSON.parse(readFileSync(join(HERE, "board.json"), "utf8"));
const BOARD = { u: 54, v: -72, s: 1.3, t: 1.9, z: 3.4 };
function pcb() {
  const { u, v, s, t, z } = BOARD;
  const { min, max } = PCB.bbox;
  const bw = (max.x - min.x) * s;
  const bd = (max.y - min.y) * s;
  const top = z + t;
  const map = ([x, y]) => [u + (x - min.x) * s, v + (max.y - y) * s];
  const flat = (pts) => path(pts.map(([x, y]) => { const [a, b] = map([x, y]); return at(a, b, top); }));
  const legs = [[3.2, 3.2], [bw - 3.2, 3.2], [3.2, bd - 3.2], [bw - 3.2, bd - 3.2]].map(([a, b]) => [u + a, v + b]);
  for (const [a, b] of legs) {
    ground(shapeCyl(a, b, 1.9, 0, z), "pcb.standoff");
    put("pcb.standoff", W(a, b, z / 2), S(cylAt(a, b, 1.9, 0, z, 6), { tone: "mid" }), [shapeCyl(a, b, 1.9, 0, z)]);
  }
  const board = piece("pcb", [0, 0, 26]);
  const traces = PCB.traces.map((tr) => flat(tr.p)).join("");
  const pad = (p) => {
    const c = Math.cos((p.rot * Math.PI) / 180);
    const n = Math.sin((p.rot * Math.PI) / 180);
    const hw = p.w / 2;
    const hh = p.h / 2;
    const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => [p.x + a * c - b * n, p.y + a * n + b * c]);
    return path(pts.map((q) => { const [a, b] = map(q); return at(a, b, top); }), true);
  };
  const pads = PCB.pads.filter((p) => p.ref !== "U4").map(pad).join("");
  const hero = PCB.pads.filter((p) => p.ref === "U4").map(pad).join("");
  const vias = Dt(PCB.vias.map(([x, y]) => { const [a, b] = map([x, y]); return at(a, b, top); }), { size: 0.32 });
  const edges = PCB.outline.map((o) => flat(o)).join("");
  const holes = legs.map(([a, b]) => ringAt(a, b, 1.3, top, 16)).join("");
  const svg = `<g class="sr-pcb">${S(slab(u, v, bw, bd, 1.2, z, t, 3, 0.3), { tone: "mid", crease: "none" })}`
    + `<path class="sr-pcb__cu" d="${traces}"/><path class="sr-pcb__pad" d="${pads}"/><path class="sr-pcb__hero${REST_FRAME >= 220 && REST_FRAME <= 255 ? " is-on" : ""}" data-hero d="${hero}"/>`
    + `<g class="sr-pcb__via">${vias}</g><path class="sr-pcb__edge" d="${edges}${holes}"/></g>`;
  put("pcb", W(u + bw / 2, v + bd / 2, z + t / 2), svg, [shapeSlab(u, v, bw, bd, 1.2, z, t)], { part: board });
}

// ---------- the picture: a column in the word gap carries the screen housing, hood and lamp fins ----------
// The screen shows the frame in the gate; the page draws the film's real frame into it as the bench turns.
function viewer() {
  const { u, w, v, d, z, h, hood, win } = SCREEN;
  const top = z + h;
  const foot = { u: -17, v: 15, w: 34, d: 22 };
  const footScrews = [[foot.u + 3, foot.v + 3], [foot.u + foot.w - 3, foot.v + 3], [foot.u + 3, foot.v + foot.d - 3], [foot.u + foot.w - 3, foot.v + foot.d - 3]];
  ground(shapeSlab(foot.u, foot.v, foot.w, foot.d, 2, 0, 2.4), "viewer.foot");
  put("viewer.foot", W(0, foot.v + foot.d / 2, 1.2), S(slab(foot.u, foot.v, foot.w, foot.d, 2, 0, 2.4, 4, 0.5), { tone: "lo" }) + Ln(footScrews.map(([a, b]) => ringAt(a, b, 1.4, 2.4, 14)).join(""), { tone: "lo" }) + Dt(footScrews.map(([a, b]) => at(a, b, 2.4)), { size: 0.42 }), [shapeSlab(foot.u, foot.v, foot.w, foot.d, 2, 0, 2.4)]);
  const col = { u: -7, v: 20, w: 14, d: 12 };
  const colTop = z - 3;
  const ticks = k.sideTicks(-(col.v + col.d), -col.v, 4, 5, -(col.u + col.w), 0, [1.2, 2.4], P, "x");
  put("viewer.column", W(0, col.v + col.d / 2, (2.4 + colTop) / 2), S(slab(col.u, col.v, col.w, col.d, 1.2, 2.4, colTop - 2.4, 3, 0.4), { tone: "mid", crease: "none" }), [shapeSlab(col.u, col.v, col.w, col.d, 1.2, 2.4, colTop - 2.4)]);
  void ticks;
  // a clamp block on the column's front face, with a locking knob, sets the height
  const cz = 46;
  const cb = { u: col.u - 1.5, v: col.v - 3.2, w: col.w + 3, d: 3.2 };
  put("viewer.collar", W(0, cb.v + cb.d / 2, cz + 4), S(slab(cb.u, cb.v, cb.w, cb.d, 0.8, cz, 8, 3, 0.4), { tone: "hi" }) + Dt([at(cb.u + 1.8, cb.v, cz + 6.4), at(cb.u + cb.w - 1.8, cb.v, cz + 6.4)], { size: 0.4 }), [shapeSlab(cb.u, cb.v, cb.w, cb.d, 0.8, cz, 8)]);
  const LF = G.frameAlong(W(0, cb.v, cz + 4), W(0, -1, 0));
  put("viewer.lock", W(0, cb.v - 2.5, cz + 4), S(G.disc(0, 1.2, 1.4, LF, P), { tone: "mid" }) + S(G.disc(1.2, 4.2, 3.2, LF, P), { tone: "hi" }) + k.fadedSvg(G.ribsOf(LF, 1.4, 4.0, 3.2, 26, P, { fade: [0.1, 0.55] }), { tone: "lo" }), [A.disc(LF, 0, 1.2, 1.4), A.disc(LF, 1.2, 4.2, 3.2)]);
  // the tilt yoke: two cheeks either side of the column, a pivot and a wing knob
  const head = "viewer.head";
  const yz = z - 16;
  const cheeks = [[col.u - 2.6, col.v - 1], [col.u + col.w, col.v - 1]];
  for (const [cu, cv] of cheeks) put("viewer.yoke", W(cu + 1.3, cv + 6, yz + 8), S(slab(cu, cv, 2.6, 12, 0.8, yz, 16, 3, 0.3), { tone: "mid" }), [shapeSlab(cu, cv, 2.6, 12, 0.8, yz, 16)], { part: head });
  const PF = G.frameAlong(W(col.u + col.w + 2.6, col.v + 5, z - 7), W(1, 0, 0));
  put("viewer.pivot", W(col.u + col.w + 5, col.v + 5, z - 7), S(G.disc(0, 1.0, 1.8, PF, P), { tone: "mid" }) + S(G.disc(1.0, 3.6, 4.2, PF, P), { tone: "hi" }) + k.fadedSvg(G.ribsOf(PF, 1.1, 3.4, 4.2, 30, P, { fade: [0.1, 0.55] }), { tone: "lo" }) + Ln(G.circleOf(PF, 3.6, 1.8, P, 20), { tone: "lo" }), [A.disc(PF, 0, 1.0, 1.8), A.disc(PF, 1.0, 3.6, 4.2)], { part: head });
  // the housing: a box with a rear seam, the screen in its front face behind a bezel
  const face = v;
  const fm = faceMatrix(W(win.u0, face, win.z1), W(1, 0, 0), W(0, 0, -1));
  const winPts = [[win.u0, win.z0], [win.u1, win.z0], [win.u1, win.z1], [win.u0, win.z1]].map(([a, b]) => at(a, face, b));
  const bezel = [[win.u0 - 2.4, win.z0 - 2.4], [win.u1 + 2.4, win.z0 - 2.4], [win.u1 + 2.4, win.z1 + 2.4], [win.u0 - 2.4, win.z1 + 2.4]].map(([a, b]) => at(a, face, b));
  const corners = [[u + 4.4, z + 4.4], [u + w - 4.4, z + 4.4], [u + 4.4, top - 4.4], [u + w - 4.4, top - 4.4]];
  const W2 = win.u1 - win.u0;
  const H2 = win.z1 - win.z0;
  const housing = S(slab(u, v, w, d, 2.4, z, h, 4, 0.8), { tone: "mid", inner: seam(u, v, w, d, 2.4, z + 4) + seam(u, v, w, d, 2.4, top - 5) })
    + Ln(path(bezel, true), { tone: "lo" })
    + `<path class="sr-window" d="${path(winPts, true)}"/>`
    + `<image class="sr-pic" data-pic href="/img/screen-240.webp" x="0" y="0" width="${W2.toFixed(2)}" height="${H2.toFixed(2)}" preserveAspectRatio="none" transform="${fm}"/>`
    + `<path class="sr-glass" d="${path([[win.u0 + W2 * 0.52, win.z1], [win.u0 + W2 * 0.7, win.z1], [win.u0 + W2 * 0.46, win.z0], [win.u0 + W2 * 0.28, win.z0]].map(([a, b]) => at(a, face, b)), true)}"/>`
    + `<path class="iso-line" data-tone="hi" d="${path(winPts, true)}"/>`
    + Dt(corners.map(([a, b]) => at(a, face, b)), { size: 0.45 });
  put("viewer.housing", W(0, v + d / 2, z + h / 2), housing, [shapeSlab(u, v, w, d, 2.4, z, h)], { part: head });
  // the hood: two cheeks and a visor keep the room's light off the screen
  const ch = [[u, "l"], [u + w - 2.2, "r"]];
  for (const [hu] of ch) put("viewer.hood", W(hu + 1.1, v - hood / 2, (z + top - 2.2) / 2), S(slab(hu, v - hood, 2.2, hood, 0.6, z + 3, h - 5.2, 3, 0.3), { tone: "mid" }), [shapeSlab(hu, v - hood, 2.2, hood, 0.6, z + 3, h - 5.2)], { part: head });
  put("viewer.visor", W(0, v - hood / 2, top - 1.1), S(slab(u, v - hood, w, hood, 0.8, top - 2.2, 2.2, 3, 0.4), { tone: "hi" }), [shapeSlab(u, v - hood, w, hood, 0.8, top - 2.2, 2.2)], { part: head });
  // the lamp's cooling fins along the back of the lid
  const fins = Array.from({ length: 23 }, (_, i) => u + 28 + i * 8);
  put("viewer.fins", W(0, v + d - 10, top + 3), fins.map((fu) => S(slab(fu, v + 12, 1.6, d - 16, 0.4, top, 3.2, 2, 0.2), { tone: "mid" })).join(""), fins.map((fu) => shapeSlab(fu, v + 12, 1.6, d - 16, 0.4, top, 3.2)), { part: head });
  // the focus knob on the right cheek of the housing
  const KF = G.frameAlong(W(u + w, v + d - 9, z + h / 2), W(1, 0, 0));
  put("viewer.focus", W(u + w + 3, v + d - 9, z + h / 2), S(G.disc(0, 1.4, 3.0, KF, P), { tone: "mid" }) + S(G.disc(1.4, 6.0, 5.4, KF, P), { tone: "hi" }) + k.fadedSvg(G.ribsOf(KF, 1.6, 5.8, 5.4, 34, P, { fade: [0.1, 0.55] }), { tone: "lo" }) + Ln(G.circleOf(KF, 6.0, 2.6, P, 24), { tone: "lo" }), [A.disc(KF, 0, 1.4, 3.0), A.disc(KF, 1.4, 6.0, 5.4)], { part: head });
  return { w: W2, h: H2 };
}

// ---------- the film: chunks that sort at their own depth; perforations are written live ----------
function filmChunks() {
  const chunks = [];
  for (const seg of FILM_PATH.segs) {
    const length = seg.s1 - seg.s0;
    const count = Math.max(1, Math.ceil(length / (seg.kind === "line" ? 20 : 3.2)));
    for (let i = 0; i < count; i++) chunks.push({ s0: seg.s0 + (length * i) / count, s1: seg.s0 + (length * (i + 1)) / count });
  }
  return chunks;
}
const PERF = { w: 1.3, h: 0.95, inset: 0.7 };
const FRAME = { gap: 0.9, inset: 2.1 };
const REST_FRAME = 240.5; // the still frame: the gate holds frame 240, as the site's own gate does under reduced motion
const REST_S = REST_FRAME * PITCH;
function film() {
  for (const chunk of filmChunks()) {
    const n = Math.max(2, Math.ceil((chunk.s1 - chunk.s0) / 1.2));
    const pts = Array.from({ length: n + 1 }, (_, i) => pointAt(chunk.s0 + ((chunk.s1 - chunk.s0) * i) / n).p);
    const low = pts.map(([u, v]) => at(u, v, FZ[0]));
    const high = pts.map(([u, v]) => at(u, v, FZ[1]));
    const body = path([...low, ...[...high].reverse()], true);
    const mid = pts[Math.floor(pts.length / 2)];
    const shapes = [];
    const step = Math.max(1, Math.ceil((pts.length - 1) / 3));
    for (let i = 0; i < pts.length - 1; i += step) {
      const a = pts[i];
      const b = pts[Math.min(pts.length - 1, i + step)];
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const dd = unit2([b[0] - a[0], b[1] - a[1]]);
      shapes.push(A.orientedBox(W(c[0], c[1], (FZ[0] + FZ[1]) / 2), [W(dd[0], dd[1], 0), W(-dd[1], dd[0], 0), [0, 0, 1]], [Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, 0.3), RF, (FZ[1] - FZ[0]) / 2]));
    }
    put("film", W(mid[0], mid[1], (FZ[0] + FZ[1]) / 2), `<g class="sr-film" data-s0="${chunk.s0.toFixed(3)}" data-s1="${chunk.s1.toFixed(3)}"><path class="sr-film__body" d="${body}"/><path class="sr-film__frames" d="${D.frames(CAM, FILM_DATA, chunk.s0, chunk.s1, REST_S % PITCH)}"/><path class="sr-film__perf" d="${D.perfs(CAM, FILM_DATA, chunk.s0, chunk.s1, REST_S % PITCH)}"/>${Ln(path(low) + path(high), { tone: "hi", className: "sr-film__edge" })}</g>`, shapes);
  }
}

// ---------- assemble ----------
// the screen head is the first out and the last home, so the letters rise beneath it
piece("viewer.head", [0, 0, 60]);
const STATIC = bench();
rails();
letters();
gate();
tensionArm();
splicer();
spareCore();
viewer();
pcb();
cans();
const COUNTER_DATA = counter();
const ROLLERS = [];
const PACKS = [];
for (const c of PATH) {
  if (c.pack) PACKS.push(platter(c));
  else ROLLERS.push(roller(c));
}
film();

if (!FAST) A.settle(R, P);
R.items.sort((a, b) => a.key - b.key);
A.auditOrExit(R, P);

// ---------- output ----------
const lift = (item) => G.dot3(item.move ?? [0, 0, 0], V);
const screenOf = (move) => k.axisVector(P, move).map((x) => Math.round(x * 100) / 100);
const items = R.items.map((item) => `<g data-k="${item.key.toFixed(3)}"${item.piece ? ` data-p="${STAGGER.indexOf(item.piece)}" data-l="${lift(item).toFixed(3)}"` : ""}>${item.svg}</g>`);
const body = [STATIC, `<g class="sr-items">${items.join("")}</g>`].join("");
const svg = `<svg class="iso-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true" focusable="false">${body}</svg>`;

const TOKENS = `--anatomy-paper:#ecede9;--anatomy-face:#f6f6f3;--anatomy-top:#f7f7f4;--anatomy-shade-0:#d5d6d2;--anatomy-shade-1:#dddeda;--anatomy-shade-2:#e4e5e1;--anatomy-shade-3:#ebece8;--anatomy-lit-top:#f7f7f4;--anatomy-lit-shade:#e4e5e1;--anatomy-hi:#1a1a1a;--anatomy-mid:#77786f;--anatomy-lo:#a5a69f;--anatomy-faint:#c8c9c3;--anatomy-lit:#d7261e;--anatomy-halo:#6f7068;--anatomy-halo-opacity:.3;--anatomy-dot:#262626;--anatomy-weight:.6px`;
const FIGURE_CSS = `
.sr-stock{--anatomy-paper:#161616;--anatomy-face:#1e1e1e;--anatomy-top:#2a2a2a;--anatomy-shade-0:#121212;--anatomy-shade-1:#161616;--anatomy-shade-2:#1b1b1b;--anatomy-shade-3:#202020;--anatomy-hi:#0b0b0b;--anatomy-mid:#45453f;--anatomy-lo:#38382f;--anatomy-faint:#2a2a26}
.sr-film__body{fill:#171717}
.sr-film__frames{fill:#262624}
.sr-film__perf{fill:#ecede9}
.sr-film .iso-line{stroke:#0b0b0b}
.sr-window{fill:#171717}
.sr-bore{fill:var(--anatomy-shade-0)}
.sr-wheels{fill:#f7f7f4}
.sr-digits text{fill:#1a1a1a;font:600 6.2px/1 var(--f-mono,ui-monospace,monospace)}
.sr-gate{stroke-width:1.1px}
.sr-pcb{--anatomy-paper:#161616;--anatomy-face:#1c1c1b;--anatomy-top:#1f1f1e;--anatomy-shade-0:#101010;--anatomy-shade-1:#141414;--anatomy-shade-2:#181818;--anatomy-shade-3:#1c1c1b;--anatomy-hi:#0b0b0b;--anatomy-mid:#2c2c29;--anatomy-lo:#2c2c29;--anatomy-faint:#2a2a26;--anatomy-dot:#8d8d84}
.sr-glass{fill:#fff;opacity:.05;pointer-events:none}
.sr-pcb__cu{fill:none;stroke:#6a6a61;stroke-width:.32px;stroke-linecap:round;stroke-linejoin:round}
.sr-pcb__pad{fill:#b9b9b0}
.sr-pcb__hero{fill:#b9b9b0;transition:fill .25s}
.sr-pcb__hero.is-on{fill:#ff4a3d}
.sr-pcb__edge{fill:none;stroke:#4a4a44;stroke-width:.3px}
`;
const DATA = {
  cam: CAM,
  film: { ...FILM, crank: CRANK, rest: REST_FRAME, pitch: PITCH, z: FZ, perf: PERF, frame: FRAME, length: FILM_PATH.length, segs: FILM_PATH.segs.map((s) => (s.kind === "line" ? { kind: "line", a: s.a, b: s.b, s0: s.s0, s1: s.s1 } : { kind: "arc", c: s.c, r: s.r, a0: s.a0, sweep: s.sweep, s0: s.s0, s1: s.s1 })) },
  rollers: ROLLERS,
  packs: PACKS,
  counter: COUNTER_DATA,
  hero: [220, 254],
  explode: { pieces: STAGGER, moves: STAGGER.map((name) => screenOf(MOVES[name])) },
};
const round = (key, value) => (typeof value === "number" ? Math.round(value * 1e4) / 1e4 : value);
writeFileSync(join(SITE, "src/motion/figure-data.ts"), `// generated by figure/build.mjs; do not edit\nexport const FIGURE = ${JSON.stringify(DATA, round)} as const\n`);

mkdirSync(join(SITE, "public/figure"), { recursive: true });
writeFileSync(join(SITE, "public/figure/bench.svg"), svg.replace('<svg class="iso-svg"', '<svg xmlns="http://www.w3.org/2000/svg" class="iso-svg"'));
const astro = `---
// generated by figure/build.mjs; do not edit. The footer's figure: "silk reel" as machined letters on a film bench.
---
<div class="ft__fig iso" data-theme="light" aria-hidden="true"></div>
<style is:global>
${scoped(k.ISO_CSS.replace(/\.iso\[data-theme="light"\]\{[^}]*\}/, "").replace(/\.iso\{[^}]*\}/, ""))}
.ft__fig{aspect-ratio:1200/527;${TOKENS};grid-column:1/-1;margin-top:clamp(64px,12vh,140px);min-width:0}
.ft__fig .iso-svg{overflow:visible}
.ft__fig{cursor:grab;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.ft__fig.is-held{cursor:grabbing}
@media (max-width:860px){.ft__fig{margin-top:48px}}
@media (max-width:600px){.ft__fig{margin-inline:-16px}}
${scoped(FIGURE_CSS)}
</style>
`;
function scoped(css) {
  // every rule is prefixed with .ft__fig so nothing reaches the rest of the site; page furniture the figure never uses is dropped
  const keep = [];
  for (const block of css.match(/[^{}]+\{[^{}]*\}/g) ?? []) {
    const [selectors, rule] = block.split("{");
    const list = selectors.trim().split(",").map((s) => s.trim()).filter((s) => !/iso-(plate|figure|legend|keys|key|swatch|page)|data-(flow|pulse)|^(to|from|\d+%)$|@keyframes/.test(s));
    if (!list.length) continue;
    keep.push(`${list.map((s) => (s.startsWith("@") ? s : `.ft__fig ${s}`)).join(",")}{${rule}`);
  }
  return keep.join("\n");
}
writeFileSync(join(SITE, "src/components/FooterFigure.astro"), astro);

if (ARGS.includes("--page")) {
  mkdirSync("/tmp/silk-fig/shots", { recursive: true });
  const page = (name, share) => {
    const order = R.items.map((item, index) => ({ item, index, key: item.key + (item.piece ? lift(item) * share(item.piece) : 0) })).sort((a, b) => a.key - b.key);
    const moved = order.map(({ item }) => {
      const s = item.piece ? share(item.piece) : 0;
      const m = s ? screenOf(G.mul3(MOVES[item.piece], s)) : null;
      return `<g${m ? ` transform="translate(${m[0]} ${m[1]})"` : ""}>${item.svg}</g>`;
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#ecede9;font-family:ui-monospace,monospace}.iso-plate{padding:150px 40px 40px}${scoped(k.ISO_CSS)}.ft__fig{${TOKENS}}${scoped(FIGURE_CSS)}</style></head><body><div class="ft__fig iso" data-theme="light"><div class="iso-plate"><svg class="iso-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">${STATIC}${moved.join("")}</svg></div></div></body></html>`;
    writeFileSync(`/tmp/silk-fig/${name}.html`, html);
  };
  page("rest", () => 0);
  page("apart", () => 1);
  page("mid", (name) => Math.max(0, Math.min(1, 1.6 * 0.5 - (STAGGER.indexOf(name) / STAGGER.length) * 0.6)));
  console.log(`pages written · ${R.items.length} items · ${R.solids.length} solids · ${(svg.length / 1024).toFixed(0)} KB · film ${FILM_PATH.length.toFixed(0)} · ${WIDTH}x${HEIGHT}`);
}
