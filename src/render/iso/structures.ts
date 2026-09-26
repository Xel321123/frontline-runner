/**
 * Isometric structure artwork — every base and building on the battlefield.
 *
 * Approach
 * --------
 * Each base is authored as **true isometric massing** rather than a flat
 * billboard: the footprint sits on the ground plane as a 90 x 90 world-unit plot
 * (2.5x the 36-unit collision radius, so the built-up yard is a little wider than
 * the volume soldiers actually collide with), the anchor `(o.x, o.y)` is the
 * plot's front corner — the corner nearest the camera, where the building meets
 * the ground — and every box is projected with `isoBox()` then shifted by
 * `-isoPoint(ANCHOR_U, ANCHOR_V)` so it lands in the local billboard frame. One
 * world unit is one CSS px at camera scale 1, so all numbers below are world
 * units: a 34-unit soldier next to a 40-unit wall reads at the right ratio, and
 * the whole sprite is painted under `translate(o.x, o.y); scale(o.scale, o.scale)`.
 *
 * Static art lives in **sprites built once** per (kind, tier bracket, wreck/whole)
 * and memoised in `MEMO` below; `pathOf()` caches the `Path2D` for every path
 * string. Per-frame work is therefore: one or two `paintSprite` calls, the damage
 * overlays that the current hit points call for, plus a handful of hand-built
 * canvas paths for the things that *must* animate — the muzzle flash, the smoke
 * plume, the embers and the faction flag. Those effects are drawn with direct
 * canvas calls on purpose: regenerating path data for them 60 times a second
 * would allocate in the hot path for no visual gain.
 *
 * Damage states (continuously visible, never binary)
 * -------------------------------------------------
 * | hp                | drawn on top of the standing sprite                       |
 * |-------------------|---------------------------------------------------------|
 * | `>= 0.72`         | nothing — a fresh position                              |
 * | `< 0.72`          | `hurt`: cracked render, blown roof tiles, ground debris |
 * | `< 0.45`          | `battered`: caved wall section, holes, soot streaks,    |
 * |                   | exposed beams, a rubble heap at the wall foot           |
 * | `< 0.22`          | `critical`: fallen roof span, burning interior glow,    |
 * |                   | heavy soot wash, a heaped rubble line, a leaning wall   |
 *
 * `destroyed: true` swaps the standing sprite for the **wreck** sprite — collapsed
 * massing, blackened by the wreck palette, burnt timbers, a bare flag pole — and
 * adds animated embers and a heavy plume. The plume is also driven by `smoke`
 * (size and opacity grow with it) before the position is destroyed, and `hit`
 * whitens the whole massing by filling its silhouette hull.
 *
 * Palettes
 * --------
 * `StructPalette` is a flat bag of 51 **material tokens** (`@wallB`,
 * `@roofLine`, `@sandbag`, ...). Shapes only ever reference tokens, so a single
 * path set serves both factions — the drawing code is entirely palette-blind.
 * Four baselines exist (allied/axis x early/late tier bracket); the two wreck
 * palettes are derived once at module level by `charred()` darkening everything
 * except embers, lamps, snow and the flag. The tokens split into families:
 * masonry and render (`wallA/B/Trim`, `render`, `quoin`, `brick`), roofing
 * (`roofA` lit slope, `roofB` shaded slope, `roofLine` courses, `eave`),
 * timber (`plank`, `plankDark`, `beam`), joinery (`glass`, `glassLit`, `frame`,
 * `door`), ground and stone (`stone`, `stoneDark`, `yard`), concrete
 * (`concA/B/Dark/Lit`, `soffit`), field kit (`sandbag*`, `steel`, `steelDark`,
 * `wire`, `tyre`, `canvas`, `canvasDark`, `tarp`), supply (`crate`, `crateDark`,
 * `ammo`, `drum`, `drumDark`), camouflage (`camo`, `camoDark`), fire damage
 * (`soot`, `rubble`, `ember`, `burn`) and signage/weather (`flag`, `flagDark`,
 * `lamp`, `snow`).
 *
 * Determinism: no `Math.random()`. Scatter (cracks, rubble, chips) comes from the
 * `hash()` integer mix seeded with a per-kind constant, so a base looks the same
 * in every frame and in every replay of the same battle.
 */

import { BASE_FOOTPRINT } from '../../game/constants';
import type { Faction } from '../../core/types';
import type { BaseKind } from '../../game/units';
import { drawGroundRing, drawObjectiveMarker, drawShadow, mix } from './common';
import type { StructureDrawOptions } from './contracts';
import { isoBox, isoPoint, poly } from './iso';
import type { Point } from './iso';
import { line, paintSprite, pathOf, sh } from './paint';
import type { Paint, Shape, Sprite } from './paint';

// --- frame ------------------------------------------------------------------

/**
 * Plot side in world units. The art is authored inside a 90 x 90 plot so the
 * selection ring, the drop shadow and every building share one ground diamond.
 */
const PLOT = Math.round(BASE_FOOTPRINT * 2.5);
/** The plot's front corner (nearest the camera) — the point that is the anchor. */
const ANCHOR: Point = isoPoint(PLOT, PLOT);
const SHIFT_X = -ANCHOR.x;
const SHIFT_Y = -ANCHOR.y;
const TAU = Math.PI * 2;

/**
 * Marker colours. Kept local on purpose: the three cues below are the only
 * colours this module emits that the renderer *reads* rather than draws, so
 * keeping them here means the structures art survives any rearrangement of the
 * shared scene palette without drifting from it (these are the same green, red
 * and amber the rest of the battle scene uses).
 */
const RING_FRIENDLY = '#7fbf6a';
const RING_TARGET = '#d9705f';
const MARKER_TARGET = '#e8c15a';

/** Screen direction of `+u` (world +x, toward the enemy) — where barrels point. */
const DIR_U: Point = { x: 0.894, y: 0.447 };

function r1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Re-origin a `poly()` path string on the plot's front corner. Only ever called
 * on paths `isoBox()` produced, whose coordinates are all `"x y"` pairs separated
 * by single spaces, so a straight numeric shift is exact.
 */
function shiftPath(d: string): string {
  if (SHIFT_X === 0 && SHIFT_Y === 0) return d;
  return d.replace(
    /(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g,
    (_all, ax: string, ay: string) => `${r1(Number(ax) + SHIFT_X)} ${r1(Number(ay) + SHIFT_Y)}`,
  );
}

function off(p: Point): Point {
  return { x: p.x + SHIFT_X, y: p.y + SHIFT_Y };
}

/** Ground-plane world point → local billboard point. */
function lp(u: number, v: number): Point {
  const p = isoPoint(u, v);
  return { x: p.x + SHIFT_X, y: p.y + SHIFT_Y };
}

/** World point lifted to height `h` → local billboard point. */
function lph(u: number, v: number, h: number): Point {
  const p = lp(u, v);
  return { x: p.x, y: p.y - h };
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function quadPath(a: Point, b: Point, c: Point, d: Point): string {
  return poly([a, b, c, d]);
}

function triPath(a: Point, b: Point, c: Point): string {
  return poly([a, b, c]);
}

function segPath(a: Point, b: Point): string {
  return `M${r1(a.x)} ${r1(a.y)}L${r1(b.x)} ${r1(b.y)}`;
}

function rectPath(x: number, y: number, w: number, h: number): string {
  return `M${r1(x)} ${r1(y)}H${r1(x + w)}V${r1(y + h)}H${r1(x)}Z`;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${r1(cx - rx)} ${r1(cy)}A${r1(rx)} ${r1(ry)} 0 1 0 ${r1(cx + rx)} ${r1(cy)}` +
    `A${r1(rx)} ${r1(ry)} 0 1 0 ${r1(cx - rx)} ${r1(cy)}Z`
  );
}

/** Deterministic 0..1 from one integer — the only source of "randomness" here. */
function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// --- massing primitives -----------------------------------------------------

interface BoxPaths {
  /** Roof quad at height `h`. */
  readonly top: string;
  /** Wall facing screen-left (the `v1` wall, which `isoBox` calls `right`). */
  readonly faceL: string;
  /** Wall facing screen-right (the `u1` wall, which `isoBox` calls `left`). */
  readonly faceR: string;
  readonly topPts: readonly Point[];
  readonly basePts: readonly Point[];
}

function boxPaths(u0: number, v0: number, u1: number, v1: number, h: number): BoxPaths {
  const b = isoBox(u0, v0, u1, v1, h);
  return {
    top: shiftPath(b.top),
    faceL: shiftPath(b.right),
    faceR: shiftPath(b.left),
    topPts: b.topCorners.map(off),
    basePts: b.baseCorners.map(off),
  };
}

interface BoxPaint {
  readonly top: Paint;
  readonly side: Paint;
  readonly face: Paint;
}

/** Emit the three visible faces of a box, in the order they must be painted. */
function mass(
  out: Shape[],
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  h: number,
  p: BoxPaint,
): BoxPaths {
  const b = boxPaths(u0, v0, u1, v1, h);
  out.push(sh(b.faceL, p.side));
  out.push(sh(b.faceR, p.face));
  out.push(sh(b.top, p.top));
  return b;
}

/** A flat slab's top face only, for platforms, aprons and roof caps. */
function plate(out: Shape[], u0: number, v0: number, u1: number, v1: number, h: number, fill: Paint): void {
  out.push(sh(boxPaths(u0, v0, u1, v1, h).top, fill));
}

/** A horizontal band across both visible walls between two heights. */
function wallBand(
  out: Shape[],
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  ha: number,
  hb: number,
  fill: Paint,
  opacity?: number,
): void {
  const extra = opacity !== undefined ? { opacity } : undefined;
  out.push(sh(quadPath(lph(u0, v1, ha), lph(u1, v1, ha), lph(u1, v1, hb), lph(u0, v1, hb)), fill, extra));
  out.push(sh(quadPath(lph(u1, v0, ha), lph(u1, v1, ha), lph(u1, v1, hb), lph(u1, v0, hb)), fill, extra));
}

/**
 * A battered (sloped) mass: the footprint at ground level, inset by `batter` at
 * the top. This is what makes concrete feel cast and heavy rather than boxy, and
 * it is why the embrasures are placed with `batterU()`/`batterV()` below.
 */
function battered(
  out: Shape[],
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  h: number,
  batter: number,
  p: BoxPaint,
): void {
  out.push(
    sh(quadPath(lph(u0, v1, 0), lph(u1, v1, 0), lph(u1 - batter, v1 - batter, h), lph(u0 + batter, v1 - batter, h)), p.side),
  );
  out.push(
    sh(quadPath(lph(u1, v0, 0), lph(u1, v1, 0), lph(u1 - batter, v1 - batter, h), lph(u1 - batter, v0 + batter, h)), p.face),
  );
  out.push(
    sh(
      quadPath(
        lph(u0 + batter, v0 + batter, h),
        lph(u1 - batter, v0 + batter, h),
        lph(u1 - batter, v1 - batter, h),
        lph(u0 + batter, v1 - batter, h),
      ),
      p.top,
    ),
  );
}

/** Where the `u1` face of a battered mass sits at height `h`. */
function batterU(u1: number, batter: number, h: number, hMax: number): number {
  return u1 - batter * (h / hMax);
}

// --- roofs ------------------------------------------------------------------

interface RoofTones {
  readonly lit: Paint;
  readonly shade: Paint;
  readonly lines: Paint;
}

/**
 * A hipped or gabled roof. `hip` is how far the ridge is pulled in from each end,
 * so `hip = 0` gives a plain gable and anything larger gives a hip; `alongU`
 * picks which axis the ridge runs down. Only the two slopes the camera can see
 * are emitted — the far pair is hidden by the ridge, exactly as in a real
 * isometric drawing.
 */
function roof(
  out: Shape[],
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  eaveH: number,
  ridgeH: number,
  hip: number,
  alongU: boolean,
  tones: RoofTones,
  courses: number,
  ribs: number,
): void {
  if (alongU) {
    const vm = (v0 + v1) / 2;
    const a = lph(u0, v1, eaveH);
    const b = lph(u1, v1, eaveH);
    const c = lph(u1 - hip, vm, ridgeH);
    const d = lph(u0 + hip, vm, ridgeH);
    out.push(sh(quadPath(a, b, c, d), tones.lit));
    out.push(sh(triPath(lph(u1, v0, eaveH), lph(u1, v1, eaveH), lph(u1 - hip, vm, ridgeH)), tones.shade));
    for (let i = 1; i <= courses; i += 1) {
      const t = i / (courses + 1);
      out.push(line(segPath(lerp(a, d, t), lerp(b, c, t)), tones.lines, 0.7));
    }
    for (let i = 1; i <= ribs; i += 1) {
      const s = i / (ribs + 1);
      out.push(line(segPath(lerp(a, b, s), lerp(d, c, s)), tones.lines, 0.55));
    }
    out.push(line(segPath(d, c), tones.lines, 1));
  } else {
    const um = (u0 + u1) / 2;
    const a = lph(u1, v0, eaveH);
    const b = lph(u1, v1, eaveH);
    const c = lph(um, v1 - hip, ridgeH);
    const d = lph(um, v0 + hip, ridgeH);
    out.push(sh(quadPath(a, b, c, d), tones.lit));
    out.push(sh(triPath(lph(u0, v1, eaveH), lph(u1, v1, eaveH), lph(um, v1 - hip, ridgeH)), tones.shade));
    for (let i = 1; i <= courses; i += 1) {
      const t = i / (courses + 1);
      out.push(line(segPath(lerp(a, d, t), lerp(b, c, t)), tones.lines, 0.7));
    }
    for (let i = 1; i <= ribs; i += 1) {
      const s = i / (ribs + 1);
      out.push(line(segPath(lerp(a, b, s), lerp(d, c, s)), tones.lines, 0.55));
    }
    out.push(line(segPath(d, c), tones.lines, 1));
  }
}

// --- joinery ----------------------------------------------------------------

/** A framed window on the screen-right wall (the `u1` face). */
function windowRight(
  out: Shape[],
  u: number,
  va: number,
  vb: number,
  ha: number,
  hb: number,
  lights: string[],
): void {
  out.push(sh(quadPath(lph(u, va, ha), lph(u, vb, ha), lph(u, vb, hb), lph(u, va, hb)), '@frame'));
  const glass = quadPath(lph(u, va + 0.9, ha + 0.9), lph(u, vb - 0.9, ha + 0.9), lph(u, vb - 0.9, hb - 0.9), lph(u, va + 0.9, hb - 0.9));
  out.push(sh(glass, '@glass'));
  lights.push(glass);
  const vm = (va + vb) / 2;
  const hm = (ha + hb) / 2;
  out.push(line(segPath(lph(u, vm, ha), lph(u, vm, hb)), '@frame', 0.7));
  out.push(line(segPath(lph(u, va, hm), lph(u, vb, hm)), '@frame', 0.7));
  // Sill: a thin ledge under the opening, which is what sells "window" at 60 px.
  out.push(line(segPath(lph(u, va - 0.8, ha), lph(u, vb + 0.8, ha)), '@wallTrim', 1.4));
}

/** A framed window on the screen-left wall (the `v1` face). */
function windowLeft(
  out: Shape[],
  v: number,
  ua: number,
  ub: number,
  ha: number,
  hb: number,
  lights: string[],
): void {
  out.push(sh(quadPath(lph(ua, v, ha), lph(ub, v, ha), lph(ub, v, hb), lph(ua, v, hb)), '@frame'));
  const glass = quadPath(lph(ua + 0.9, v, ha + 0.9), lph(ub - 0.9, v, ha + 0.9), lph(ub - 0.9, v, hb - 0.9), lph(ua + 0.9, v, hb - 0.9));
  out.push(sh(glass, '@glass', { opacity: 0.88 }));
  lights.push(glass);
  const um = (ua + ub) / 2;
  const hm = (ha + hb) / 2;
  out.push(line(segPath(lph(um, v, ha), lph(um, v, hb)), '@frame', 0.7));
  out.push(line(segPath(lph(ua, v, hm), lph(ub, v, hm)), '@frame', 0.7));
}

/** Corner quoins: alternating stone blocks up the most visible vertical edge. */
function quoins(out: Shape[], u: number, v: number, h: number, count: number, step: number): void {
  for (let i = 0; i < count; i += 1) {
    const ha = 1.5 + i * step;
    const hb = ha + step * 0.6;
    if (hb > h - 1) break;
    const stagger = i % 2 === 0 ? 0 : 2.4;
    out.push(sh(quadPath(lph(u - 6 - stagger, v, ha), lph(u - stagger, v, ha), lph(u - stagger, v, hb), lph(u - 6 - stagger, v, hb)), '@quoin'));
    out.push(
      sh(quadPath(lph(u, v - 6 - stagger, ha), lph(u, v - stagger, ha), lph(u, v - stagger, hb), lph(u, v - 6 - stagger, hb)), '@quoin', {
        opacity: 0.72,
      }),
    );
  }
}

/** A plank door with a stone step, on the screen-right wall. */
function doorRight(out: Shape[], u: number, va: number, vb: number, h: number): void {
  out.push(sh(quadPath(lph(u, va - 0.9, 0), lph(u, vb + 0.9, 0), lph(u, vb + 0.9, h + 1.6), lph(u, va - 0.9, h + 1.6)), '@frame'));
  out.push(sh(quadPath(lph(u, va, 0), lph(u, vb, 0), lph(u, vb, h), lph(u, va, h)), '@door'));
  const planks = 3;
  for (let i = 1; i < planks; i += 1) {
    const t = i / planks;
    const v = va + (vb - va) * t;
    out.push(line(segPath(lph(u, v, 0.4), lph(u, v, h - 0.4)), '@burn', 0.5));
  }
  out.push(sh(ellipsePath(lph(u, vb - 1.8, h * 0.45).x, lph(u, vb - 1.8, h * 0.45).y, 1, 1), '@steel'));
  mass(out, u, va - 2.4, u + 4.5, vb + 2.4, 2, { top: '@stone', side: '@stoneDark', face: '@stone' });
}

/** A steel blast door, on the screen-left wall. */
function steelDoor(out: Shape[], v: number, ua: number, ub: number, h: number): void {
  out.push(sh(quadPath(lph(ua - 1.2, v, 0), lph(ub + 1.2, v, 0), lph(ub + 1.2, v, h + 1.4), lph(ua - 1.2, v, h + 1.4)), '@frame'));
  out.push(sh(quadPath(lph(ua, v, 0), lph(ub, v, 0), lph(ub, v, h), lph(ua, v, h)), '@steelDark'));
  out.push(line(segPath(lph(ua + 1.5, v, h * 0.5), lph(ub - 1.5, v, h * 0.5)), '@steel', 0.6));
  const vm = ua + (ub - ua) * 0.2;
  out.push(sh(ellipsePath(lph(vm, v, h * 0.45).x, lph(vm, v, h * 0.45).y, 1.2, 1.2), '@steel'));
}

/** An open embrasure: a shadowed slit with a frame lip, cut into the `u1` wall. */
function embrasure(out: Shape[], u: number, va: number, vb: number, ha: number, hb: number, lights: string[]): void {
  const open = quadPath(lph(u, va, ha), lph(u, vb, ha), lph(u, vb, hb), lph(u, va, hb));
  out.push(sh(open, '@soot'));
  out.push(line(segPath(lph(u, va, hb), lph(u, vb, hb)), '@concLit', 1.2));
  out.push(line(segPath(lph(u, va, ha), lph(u, vb, ha)), '@concDark', 1));
  lights.push(open);
}

// --- kit --------------------------------------------------------------------

const BAG_RX = 4.6;
const BAG_RY = 3;
const BAG_RISE = 3.2;

/**
 * A run of sandbags between two ground points. Bags are laid at even intervals
 * along the projected segment (projection is affine, so even in world space is
 * even on screen) and each higher layer steps by `lean` — walls of bags lean
 * back against the ground they were dug from.
 */
function sandbagRow(
  out: Shape[],
  ua: number,
  va: number,
  ub: number,
  vb: number,
  baseH: number,
  layers: number,
  leanX: number,
  leanY: number,
  seed: number,
): void {
  const a = lph(ua, va, baseH);
  const b = lph(ub, vb, baseH);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return;
  const count = Math.max(2, Math.min(16, Math.round(len / (BAG_RX * 1.55))));
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  for (let layer = 0; layer < layers; layer += 1) {
    const stagger = layer % 2 === 0 ? 0 : 0.5;
    for (let i = 0; i < count; i += 1) {
      const t = (i + 0.5 + stagger) / count;
      const p = lerp(a, b, t);
      const cx = p.x + leanX * layer;
      const cy = p.y + leanY * layer - layer * BAG_RISE;
      const shade = hash(seed + i * 7 + layer * 31) > 0.62;
      out.push(
        sh(ellipsePath(cx, cy, BAG_RX, BAG_RY), shade ? '@sandbagDark' : '@sandbag', {
          transform: { rotate: angle, pivotX: cx, pivotY: cy },
        }),
      );
      // A lit sliver along the top of the bag is what makes the stack read as
      // filled sacks rather than a row of pebbles.
      out.push(
        sh(ellipsePath(cx - 0.6, cy - 0.8, BAG_RX * 0.62, BAG_RY * 0.42), shade ? '@sandbag' : '@sandbagLit', {
          transform: { rotate: angle, pivotX: cx, pivotY: cy },
          opacity: 0.5,
        }),
      );
    }
  }
}

/** A sandbag parapet wrapped right round a point — a gun pit. */
function sandbagRing(out: Shape[], cu: number, cv: number, radius: number, layers: number, seed: number): void {
  const sides = 14;
  for (let layer = 0; layer < layers; layer += 1) {
    const r = radius - layer * 1.2;
    for (let i = 0; i < sides; i += 1) {
      const angle = (i / sides) * TAU;
      const p = lph(cu + Math.cos(angle) * r, cv + Math.sin(angle) * r, layer * BAG_RISE);
      const shade = hash(seed + i * 11 + layer * 5) > 0.6;
      out.push(sh(ellipsePath(p.x, p.y, BAG_RX, BAG_RY), shade ? '@sandbagDark' : '@sandbag', { opacity: 0.96 }));
      out.push(sh(ellipsePath(p.x - 0.6, p.y - 0.8, BAG_RX * 0.6, BAG_RY * 0.4), '@sandbagLit', { opacity: 0.4 }));
    }
  }
}

/** A crate or ammunition box, with slats and a lid line. */
function crate(out: Shape[], u: number, v: number, w: number, d: number, h: number, ammo: boolean): void {
  mass(out, u, v, u + w, v + d, h, {
    top: ammo ? '@ammo' : '@crate',
    side: '@crateDark',
    face: ammo ? '@ammo' : '@crate',
  });
  out.push(line(segPath(lph(u + w, v, h * 0.5), lph(u + w, v + d, h * 0.5)), '@crateDark', 0.5));
  out.push(line(segPath(lph(u, v + d, h * 0.5), lph(u + w, v + d, h * 0.5)), '@crateDark', 0.5));
  out.push(line(segPath(lph(u, v + d, h - 0.7), lph(u + w, v + d, h - 0.7)), '@burn', 0.5));
}

/** A fuel drum: squat body, rounded lid and two rolling hoops. */
function drum(out: Shape[], u: number, v: number, r: number, h: number): void {
  mass(out, u - r, v - r, u + r, v + r, h, { top: '@drum', side: '@drumDark', face: '@drum' });
  const top = lp(u, v);
  out.push(sh(ellipsePath(top.x, top.y - h, r * 1.4, r * 0.7), '@drum'));
  out.push(line(segPath(lph(u - r, v, h * 0.66), lph(u + r, v, h * 0.66)), '@drumDark', 0.7));
  out.push(line(segPath(lph(u, v - r, h * 0.33), lph(u, v + r, h * 0.33)), '@drumDark', 0.7));
}

/** A ridge tent: two slopes, a hip at the near end and guy lines to pegs. */
function ridgeTent(out: Shape[], u0: number, v0: number, u1: number, v1: number, apex: number, collapsed: boolean): void {
  const eave = collapsed ? apex * 0.25 : apex * 0.34;
  const peak = collapsed ? apex * 0.5 : apex;
  const vm = (v0 + v1) / 2;
  out.push(
    sh(
      quadPath(lph(u0, v1, eave), lph(u1, v1, eave), lph(u1, vm, peak), lph(u0, vm, peak)),
      '@canvas',
    ),
  );
  out.push(sh(triPath(lph(u1, v0, eave), lph(u1, v1, eave), lph(u1, vm, peak)), '@canvasDark'));
  out.push(line(segPath(lph(u0, vm, peak), lph(u1, vm, peak)), '@canvasDark', 0.8));
  if (!collapsed) {
    // Entrance: a dark gape with a rolled flap either side of it.
    const flapA = (v1 - v0) * 0.3;
    out.push(sh(triPath(lph(u1, vm - flapA, eave * 0.4), lph(u1, vm + flapA, eave * 0.4), lph(u1, vm, peak * 0.82)), '@canvasDark'));
    out.push(line(segPath(lph(u0, vm, peak), lph(u0 - 5, vm - 6, 0)), '@canvasDark', 0.6));
    out.push(line(segPath(lph(u0, vm, peak), lph(u0 - 5, vm + 6, 0)), '@canvasDark', 0.6));
    out.push(line(segPath(lph(u1, vm, peak), lph(u1 + 5, vm - 6, 0)), '@canvasDark', 0.6));
    out.push(line(segPath(lph(u1, vm, peak), lph(u1 + 5, vm + 6, 0)), '@canvasDark', 0.6));
    out.push(line(segPath(lph(u0, vm, peak), lph(u0, vm, peak + 3)), '@steelDark', 0.9));
  }
}

/** A tarpaulin over a stack: a lumpy cover with tie-down ropes. */
function tarpStack(out: Shape[], u0: number, v0: number, u1: number, v1: number, h: number): void {
  mass(out, u0, v0, u1, v1, h * 0.72, { top: '@tarp', side: '@canvasDark', face: '@tarp' });
  const um = (u0 + u1) / 2;
  const vm = (v0 + v1) / 2;
  out.push(
    sh(
      poly([lph(u0, v0, h * 0.72), lph(u1, v0, h * 0.72), lph(u1, vm, h), lph(um, v1, h * 0.86), lph(u0, v1, h * 0.72)]),
      '@tarp',
    ),
  );
  out.push(line(segPath(lph(u0, v0, h * 0.72), lph(u1, vm, h)), '@canvasDark', 0.6));
  out.push(line(segPath(lph(um, v1, h * 0.86), lph(u1, v0, h * 0.72)), '@canvasDark', 0.6));
  out.push(line(segPath(lph(u0, v1, h * 0.4), lph(u0 - 3, v1 + 4, 0)), '@canvasDark', 0.6));
}

/** Barbed wire: overlapping coils threaded on a picket line, on short posts. */
function wireCoil(out: Shape[], ua: number, va: number, ub: number, vb: number, seed: number): void {
  const a = lp(ua, va);
  const b = lp(ub, vb);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 2) return;
  // The wire the coils are threaded on. Without it a belt reads as a row of
  // loose rings lying on the grass rather than one strand of wire.
  out.push(line(segPath({ x: a.x, y: a.y - 3.4 }, { x: b.x, y: b.y - 3.4 }), '@wire', 0.8));
  out.push(line(segPath({ x: a.x, y: a.y - 5.6 }, { x: b.x, y: b.y - 5.6 }), '@wire', 0.6));
  const count = Math.max(2, Math.round(len / 5.5));
  for (let i = 0; i < count; i += 1) {
    const t = (i + 0.5) / count;
    const p = lerp(a, b, t);
    const y = p.y - (3.4 + hash(seed + i) * 2.2);
    out.push(sh(ellipsePath(p.x, y, 4.2, 3.1), undefined, { stroke: '@wire', strokeWidth: 0.9 }));
    out.push(line(segPath({ x: p.x - 3.2, y: y - 2.5 }, { x: p.x + 3.2, y: y + 2.5 }), '@wire', 0.6));
    if (i % 2 === 0) out.push(line(segPath({ x: p.x, y: p.y }, { x: p.x, y: y - 4.2 }), '@steelDark', 1));
  }
}

/** Camouflage netting draped over part of a roof. */
function camoNet(out: Shape[], u0: number, v0: number, u1: number, v1: number, h: number): void {
  const um = (u0 + u1) / 2;
  const vm = (v0 + v1) / 2;
  out.push(
    sh(
      poly([
        lph(u0, v0, h),
        lph(u1, v0, h),
        lph(u1, vm, h - 2.6),
        lph(u1, v1, h - 1.2),
        lph(um, v1, h - 3.4),
        lph(u0, v1, h - 1.4),
        lph(u0, vm, h - 2.2),
      ]),
      '@camo',
      { opacity: 0.88 },
    ),
  );
  out.push(line(segPath(lph(u0, v0, h), lph(u1, vm, h - 2.6)), '@camoDark', 0.8));
  out.push(line(segPath(lph(u1, v0, h), lph(u0, vm, h - 2.2)), '@camoDark', 0.8));
  out.push(line(segPath(lph(um, v1, h - 3.4), lph(um, v0, h + 0.4)), '@camoDark', 0.6));
}

/** A light gantry crane: two uprights, a beam, a trolley and a slung hook. */
function gantry(out: Shape[], ua: number, ub: number, v: number, h: number, collapsed: boolean): void {
  const legs = collapsed ? h * 0.55 : h;
  mass(out, ua, v - 1.4, ua + 3, v + 1.4, legs, { top: '@steel', side: '@steelDark', face: '@steel' });
  mass(out, ub - 3, v - 1.4, ub, v + 1.4, legs, { top: '@steel', side: '@steelDark', face: '@steel' });
  if (collapsed) {
    // The beam has come down on one side and lies across the yard.
    out.push(sh(quadPath(lph(ua, v, legs), lph(ub, v, legs * 0.55), lph(ub, v + 3, legs * 0.55), lph(ua, v + 3, legs)), '@steelDark'));
    return;
  }
  out.push(sh(quadPath(lph(ua, v - 1.4, h), lph(ub, v - 1.4, h), lph(ub, v + 1.4, h), lph(ua, v + 1.4, h)), '@steel'));
  out.push(sh(quadPath(lph(ua, v + 1.4, h), lph(ub, v + 1.4, h), lph(ub, v + 1.4, h - 2), lph(ua, v + 1.4, h - 2)), '@steelDark'));
  const tu = ua + (ub - ua) * 0.62;
  out.push(sh(rectPath(lp(tu, v).x - 2, lp(tu, v).y - h - 2, 4, 3), '@steelDark'));
  out.push(line(segPath(lph(tu, v, h - 2), lph(tu, v, 9)), '@wire', 0.7));
  out.push(sh(ellipsePath(lp(tu, v).x, lp(tu, v).y - 9, 2, 1.6), undefined, { stroke: '@steel', strokeWidth: 1.1 }));
  out.push(line(segPath(lph(ua + 1.5, v, legs * 0.4), lph(ub - 1.5, v, legs * 0.4)), '@steelDark', 0.7));
}

/** A light truck backed onto a loading bay, axis-aligned along `u`. */
function truck(out: Shape[], u: number, v: number, length: number, d: number, burnt: boolean): void {
  const body = burnt ? '@burn' : '@vehicle';
  const bodyDark = burnt ? '@soot' : '@vehicleDark';
  mass(out, u + length * 0.28, v, u + length, v + d, 7.4, { top: bodyDark, side: bodyDark, face: body });
  mass(out, u, v, u + length * 0.28, v + d, 5.2, { top: bodyDark, side: bodyDark, face: body });
  // Cab glazing, then the canopy over the load bed.
  out.push(sh(quadPath(lph(u + length * 0.28, v, 5.2), lph(u + length * 0.28, v + d, 5.2), lph(u + length * 0.28, v + d, 7.2), lph(u + length * 0.28, v, 7.2)), '@glass'));
  out.push(sh(quadPath(lph(u + length * 0.34, v, 7.4), lph(u + length, v, 7.4), lph(u + length, v + d, 7.4), lph(u + length * 0.34, v + d, 7.4)), burnt ? '@soot' : '@canvasDark'));
  const wheels: readonly number[] = [length * 0.16, length * 0.78];
  for (const w of wheels) {
    out.push(sh(ellipsePath(lp(u + w, v + d * 0.5).x + 4, lp(u + w, v + d * 0.5).y - 2.2, 4.2, 2.6), '@tyre'));
    out.push(sh(ellipsePath(lp(u + w, v + d * 0.5).x + 4, lp(u + w, v + d * 0.5).y - 2.2, 1.6, 1), '@steelDark'));
  }
}

/** A watchtower: four legs, braces, a platform, a roof and a ladder. */
function watchtower(out: Shape[], u0: number, v0: number, u1: number, v1: number, legH: number, toppled: boolean): void {
  const lean = toppled ? -6 : 0;
  const legs: readonly (readonly [number, number])[] = [
    [u0, v0],
    [u1, v0],
    [u0, v1],
    [u1, v1],
  ];
  for (const [u, v] of legs) {
    const top = lph(u, v, legH);
    out.push(sh(quadPath(lp(u, v), lph(u, v, legH), { x: top.x + 2.6, y: top.y + lean }, { x: lp(u, v).x + 2.6, y: lp(u, v).y }), '@plank'));
    out.push(line(segPath(lp(u, v), { x: top.x, y: top.y + lean }), '@plankDark', 0.6));
  }
  if (!toppled) {
    out.push(line(segPath(lph(u0, v1, legH * 0.2), lph(u1, v1, legH * 0.75)), '@plankDark', 1));
    out.push(line(segPath(lph(u1, v1, legH * 0.2), lph(u0, v1, legH * 0.75)), '@plankDark', 1));
    // Platform: a top plate with a fascia band, deliberately NOT a `mass()` —
    // a mass would wall in the full height from the ground and the watchtower
    // would read as a shed on stilts rather than an open-legged tower.
    plate(out, u0 - 1.5, v0 - 1.5, u1 + 1.5, v1 + 1.5, legH + 2, '@plank');
    out.push(
      sh(quadPath(lph(u0 - 1.5, v1 + 1.5, legH - 1), lph(u1 + 1.5, v1 + 1.5, legH - 1), lph(u1 + 1.5, v1 + 1.5, legH + 2), lph(u0 - 1.5, v1 + 1.5, legH + 2)), '@plankDark'),
    );
    out.push(
      sh(quadPath(lph(u1 + 1.5, v0 - 1.5, legH - 1), lph(u1 + 1.5, v1 + 1.5, legH - 1), lph(u1 + 1.5, v1 + 1.5, legH + 2), lph(u1 + 1.5, v0 - 1.5, legH + 2)), '@plank'),
    );
    for (let i = 1; i <= 3; i += 1) {
      const t = i / 4;
      const ru = u0 + (u1 - u0) * t;
      const rv = v0 + (v1 - v0) * t;
      out.push(line(segPath(lph(ru, v1, legH + 2), lph(ru, v1, legH + 8)), '@plankDark', 0.7));
      out.push(line(segPath(lph(u1, rv, legH + 2), lph(u1, rv, legH + 8)), '@plankDark', 0.7));
    }
    out.push(line(segPath(lph(u0, v1, legH + 8), lph(u1, v1, legH + 8)), '@plank', 1.2));
    out.push(line(segPath(lph(u1, v0, legH + 8), lph(u1, v1, legH + 8)), '@plank', 1.2));
    roof(out, u0 - 4, v0 - 4, u1 + 4, v1 + 4, legH + 12, legH + 22, 4, false, { lit: '@roofB', shade: '@roofDark', lines: '@plankDark' }, 1, 3);
    // Ladder rungs up the screen-right face.
    const rails = [0.3, 0.7];
    for (const t of rails) {
      out.push(line(segPath(lph(u1, v0 + (v1 - v0) * t, 1), lph(u1, v0 + (v1 - v0) * t, legH + 1)), '@plank', 0.8));
    }
    out.push(line(segPath(lph(u1, v0, legH + 1), lph(u1, v1, legH + 1)), '@plank', 0.8));
    for (let i = 1; i < 6; i += 1) {
      const h = (i / 6) * legH;
      out.push(line(segPath(lph(u1, v0 + (v1 - v0) * 0.3, h), lph(u1, v0 + (v1 - v0) * 0.7, h)), '@plank', 0.9));
    }
  } else {
    // Collapsed: the platform has dropped onto the ground at an angle.
    out.push(
      sh(
        poly([lph(u0 - 2, v0 - 2, 3), lph(u1 + 2, v0 - 2, 9), lph(u1 + 2, v1 + 2, 7), lph(u0 - 2, v1 + 2, 1)]),
        '@plank',
      ),
    );
    out.push(line(segPath(lph(u0, v1, 3), lph(u1, v1, 11)), '@plankDark', 1.2));
  }
}

/** A periscope: a stalk and a hooded head. */
function periscope(out: Shape[], u: number, v: number, baseH: number, h: number): void {
  const p = lp(u, v);
  out.push(sh(rectPath(p.x - 0.7, p.y - baseH - h, 1.5, h), '@steelDark'));
  out.push(sh(rectPath(p.x - 2, p.y - baseH - h - 2.4, 4.4, 2.6), '@steel'));
  out.push(sh(ellipsePath(p.x + 1.6, p.y - baseH - h - 1.2, 1.1, 0.9), '@glassLit'));
}

/** A signal lamp on a post, with a hooded lens. */
function signalLamp(out: Shape[], u: number, v: number, h: number): void {
  const p = lp(u, v);
  out.push(line(segPath(p, { x: p.x, y: p.y - h }), '@steelDark', 1.1));
  out.push(sh(rectPath(p.x - 2.2, p.y - h - 3.4, 4.6, 3.6), '@steel'));
  out.push(sh(ellipsePath(p.x + 2.2, p.y - h - 1.6, 1.4, 1.6), '@lamp'));
  out.push(line(segPath({ x: p.x - 2.2, y: p.y - h }, { x: p.x - 4.6, y: p.y - h + 1.4 }), '@steelDark', 0.8));
}

/** A signpost: two arm boards on a post. No text — the HUD owns words. */
function signpost(out: Shape[], u: number, v: number, h: number): void {
  const p = lp(u, v);
  out.push(line(segPath(p, { x: p.x, y: p.y - h }), '@plank', 1.4));
  out.push(sh(quadPath(lph(u, v, h * 0.86), lph(u + 8, v, h * 0.86), lph(u + 8, v, h * 0.86 + 3), lph(u, v, h * 0.86 + 3)), '@plankDark'));
  out.push(sh(quadPath(lph(u, v, h * 0.6), lph(u - 7, v, h * 0.6), lph(u - 7, v, h * 0.6 + 3), lph(u, v, h * 0.6 + 3)), '@plankDark'));
  out.push(sh(rectPath(p.x - 1.6, p.y - h - 1.4, 3.2, 1.6), '@plankDark'));
}

/**
 * The base's own defensive gun: an MG on a tripod, barrel toward `+u` (the
 * enemy). Returns the muzzle in local coordinates so the renderer's tracer
 * starts exactly where the barrel ends.
 */
function baseGun(out: Shape[], u: number, v: number, h: number, len: number): Point {
  const g = lph(u, v, h);
  out.push(line(segPath(g, lp(u - 4, v + 1)), '@steelDark', 0.9));
  out.push(line(segPath(g, lp(u + 1, v - 4)), '@steelDark', 0.9));
  out.push(line(segPath(g, lp(u + 1, v + 4.5)), '@steelDark', 0.9));
  out.push(sh(rectPath(g.x - 3.6, g.y - 4.6, 7.6, 4.8), '@steelDark'));
  out.push(sh(rectPath(g.x - 3.6, g.y - 4.6, 7.6, 1.4), '@steel'));
  const tip = lph(u + len, v, h + 0.5);
  const start = { x: g.x + 3, y: g.y - 2.6 };
  out.push(line(segPath(start, tip), '@steel', 1.7));
  out.push(line(segPath(start, tip), '@steelDark', 0.5));
  out.push(line(segPath({ x: tip.x - 1.4, y: tip.y - 1.6 }, { x: tip.x + 1.6, y: tip.y + 0.8 }), '@steelDark', 2));
  return { x: tip.x + 1.2, y: tip.y - 0.2 };
}

// --- damage -----------------------------------------------------------------

interface WoundBox {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** Wall height the cracks and holes are drawn across. */
  readonly h: number;
  /** Roof apex height, for the fallen-span and soot-wash overlays. */
  readonly roofH: number;
}

/**
 * A deterministic heap of rubble: each chip sits on its own patch of shadow so
 * the heap has weight on the ground instead of looking like beans scattered on
 * a table. Counts are deliberately low — twelve chips round a wall foot read as
 * debris, forty read as gravel.
 */
function rubblePile(out: Shape[], u: number, v: number, spread: number, count: number, seed: number): void {
  for (let i = 0; i < count; i += 1) {
    const a = hash(seed + i * 13) * TAU;
    const r = spread * (0.3 + hash(seed + i * 29) * 0.7);
    const p = lp(u + Math.cos(a) * r, v + Math.sin(a) * r);
    const w = 1.7 + hash(seed + i * 17) * 2.4;
    out.push(sh(ellipsePath(p.x, p.y, w * 1.5, w * 0.78), '@soot', { opacity: 0.45 }));
    out.push(sh(ellipsePath(p.x, p.y - 0.9, w, w * 0.5), '@rubble', { opacity: 0.82 }));
    if (i % 2 === 0) {
      out.push(
        sh(triPath({ x: p.x - w, y: p.y - 0.4 }, { x: p.x + w, y: p.y - 1.2 }, { x: p.x + w * 0.3, y: p.y - 2.2 - w * 0.5 }), '@rubble', {
          opacity: 0.9,
        }),
      );
    }
  }
}

/** Jagged crack strokes across the visible walls, deterministic from `seed`. */
function cracks(out: Shape[], w: WoundBox, count: number, seed: number): void {
  for (let i = 0; i < count; i += 1) {
    const onRight = i % 2 === 0;
    const t = (i + 0.5) / count;
    const hTop = w.h * (0.42 + hash(seed + i * 3) * 0.5);
    const start = onRight
      ? lph(w.u1, w.v0 + (w.v1 - w.v0) * t, hTop)
      : lph(w.u0 + (w.u1 - w.u0) * t, w.v1, hTop);
    const p1 = { x: start.x + (hash(seed + i * 5) - 0.5) * 9, y: start.y + 5 + hash(seed + i * 7) * 6 };
    const p2 = { x: p1.x + (hash(seed + i * 11) - 0.5) * 7, y: p1.y + 5 + hash(seed + i * 13) * 5 };
    out.push(line(`M${r1(start.x)} ${r1(start.y)}L${r1(p1.x)} ${r1(p1.y)}L${r1(p2.x)} ${r1(p2.y)}`, '@soot', 0.9, ));
  }
}

/**
 * The three progressive damage overlays for one massing. They stack: a position
 * at 0.2 draws all three, so the silhouette degrades continuously rather than
 * switching state at a threshold.
 */
function buildDamage(w: WoundBox, seed: number): { hurt: Sprite; battered: Sprite; critical: Sprite } {
  // --- hurt: surface damage only -------------------------------------------
  const hurt: Shape[] = [];
  cracks(hurt, w, 6, seed);
  // Blown roof tiles: slates knocked off along the eave line.
  for (let i = 0; i < 3; i += 1) {
    const t = 0.25 + i * 0.24;
    const um = w.u0 + (w.u1 - w.u0) * t;
    const drop = lp(um + 3, w.v1 + 4 + hash(seed + i) * 5);
    hurt.push(sh(ellipsePath(drop.x, drop.y - 1, 2.6, 1.2), '@roofDark', { opacity: 0.85 }));
  }
  rubblePile(hurt, (w.u0 + w.u1) / 2 + 6, w.v1 + 6, 7, 3, seed + 101);
  // Soot smudges where rounds have struck and burnt the render.
  for (let i = 0; i < 2; i += 1) {
    const p = lph(w.u0 + (w.u1 - w.u0) * (0.3 + i * 0.4), w.v1, w.h * (0.6 + i * 0.15));
    hurt.push(sh(ellipsePath(p.x, p.y, 4.4 + i, 5.4 + i), '@soot', { opacity: 0.32 }));
  }

  // --- battered: structure opened up ---------------------------------------
  const battered: Shape[] = [];
  // A caved wall section on the screen-right face.
  const gapA = lph(w.u1, w.v0 + (w.v1 - w.v0) * 0.42, w.h * 0.52);
  const gapB = lph(w.u1, w.v0 + (w.v1 - w.v0) * 0.72, w.h * 0.22);
  battered.push(
    sh(
      poly([
        { x: gapA.x, y: gapA.y },
        { x: gapB.x, y: gapB.y },
        { x: gapB.x + 3.2, y: gapB.y + 1.6 },
        { x: gapA.x + 3.2, y: gapA.y + 1.6 },
      ]),
      '@soot',
    ),
  );
  battered.push(sh(ellipsePath(gapB.x + 1.4, gapB.y + 1, 2.8, 2), '@ember', { opacity: 0.35 }));
  // Exposed beams poking out of the breach.
  for (let i = 0; i < 3; i += 1) {
    const p = lph(w.u1, w.v0 + (w.v1 - w.v0) * (0.46 + i * 0.1), w.h * (0.58 - i * 0.06));
    battered.push(line(segPath(p, { x: p.x + 5, y: p.y - 3 - i * 2 }), '@beam', 1.5));
  }
  // Holes punched through the screen-left face.
  for (let i = 0; i < 3; i += 1) {
    const p = lph(w.u0 + (w.u1 - w.u0) * (0.24 + i * 0.26), w.v1, w.h * (0.36 + (i % 2) * 0.22));
    battered.push(sh(ellipsePath(p.x, p.y, 3 + i * 0.6, 2.4 + i * 0.4), '@soot', { opacity: 0.94 }));
  }
  // Soot streaking up from the windows and the breach.
  battered.push(
    sh(
      poly([
        lph(w.u1, w.v0 + (w.v1 - w.v0) * 0.4, w.h),
        lph(w.u1, w.v0 + (w.v1 - w.v0) * 0.8, w.h),
        lph(w.u1, w.v0 + (w.v1 - w.v0) * 0.8, w.h * 0.3),
        lph(w.u1, w.v0 + (w.v1 - w.v0) * 0.4, w.h * 0.42),
      ]),
      '@burn',
      { opacity: 0.3 },
    ),
  );
  if (w.roofH > w.h) {
    // A hole through the roof deck, seen from above.
    const p = lph(w.u0 + (w.u1 - w.u0) * 0.34, w.v0 + (w.v1 - w.v0) * 0.4, (w.h + w.roofH) / 2);
    battered.push(sh(poly([{ x: p.x - 5, y: p.y }, { x: p.x + 4, y: p.y - 2 }, { x: p.x + 2, y: p.y + 4 }, { x: p.x - 3, y: p.y + 4 }]), '@soot', { opacity: 0.8 }));
  }
  rubblePile(battered, w.u1 + 6, w.v1 + 4, 10, 5, seed + 211);
  rubblePile(battered, w.u0 - 5, w.v1 + 2, 8, 4, seed + 307);

  // --- critical: about to come down ---------------------------------------
  const critical: Shape[] = [];
  // Heavy soot wash over the upper massing and the whole roof.
  critical.push(
    sh(
      poly([
        lph(w.u0, w.v1, w.h),
        lph(w.u1, w.v1, w.h),
        lph(w.u1, w.v1, w.h * 0.42),
        lph(w.u0, w.v1, w.h * 0.5),
      ]),
      '@burn',
      { opacity: 0.5 },
    ),
  );
  critical.push(
    sh(
      poly([
        lph(w.u0, w.v0, w.h),
        lph(w.u1, w.v0, w.h),
        lph(w.u1, w.v1, w.h),
        lph(w.u0, w.v1, w.h),
      ]),
      '@soot',
      { opacity: 0.3 },
    ),
  );
  // A roof span has come down across the front of the building.
  const spanA = lph(w.u0 + (w.u1 - w.u0) * 0.3, w.v0 + (w.v1 - w.v0) * 0.3, w.roofH);
  const spanB = lph(w.u1 + 6, w.v1 + 2, 6);
  const px = -0.6;
  critical.push(
    sh(
      poly([
        { x: spanA.x, y: spanA.y },
        { x: spanA.x + 12, y: spanA.y + 6 },
        { x: spanB.x, y: spanB.y },
        { x: spanB.x - 11, y: spanB.y - 4 },
      ]),
      '@beam',
      { opacity: 0.94 },
    ),
  );
  critical.push(line(segPath({ x: spanA.x, y: spanA.y }, { x: spanB.x, y: spanB.y }), '@soot', 1.4));
  // Interior fire, glowing through the breach.
  const glow = lph(w.u1 - 1.4, w.v0 + (w.v1 - w.v0) * 0.55, w.h * 0.32);
  critical.push(sh(ellipsePath(glow.x, glow.y, 5.4, 3.4), '@ember', { opacity: 0.5 }));
  critical.push(sh(ellipsePath(glow.x, glow.y, 2.4, 1.5), '@lamp', { opacity: 0.75 }));
  // Burnt timbers and heaps of rubble all round the base.
  for (let i = 0; i < 4; i += 1) {
    const a = hash(seed + i * 37) * TAU;
    const r = 16 + hash(seed + i * 41) * 10;
    const p = lp((w.u0 + w.u1) / 2 + Math.cos(a) * r, (w.v0 + w.v1) / 2 + Math.sin(a) * r);
    critical.push(line(segPath(p, { x: p.x + 7 - i * 2, y: p.y - 2 + i }), '@beam', 1.6));
  }
  rubblePile(critical, (w.u0 + w.u1) / 2 + 8, w.v1 + 8, 13, 7, seed + 401);
  rubblePile(critical, (w.u0 + w.u1) / 2 - 10, w.v1 + 4, 10, 6, seed + 503);

  return {
    hurt: { shapes: hurt },
    battered: { shapes: battered },
    critical: { shapes: critical },
  };
  void px;
}

/** The whitening hull for the `hit` flinch: a hexagon round the whole massing. */
function hullFor(w: WoundBox, apex: number): string {
  const front = lp(w.u1, w.v1);
  const left = lp(w.u0, w.v1);
  const right = lp(w.u1, w.v0);
  const leftTop = lph(w.u0, w.v1, Math.max(w.h, apex * 0.5));
  const rightTop = lph(w.u1, w.v0, Math.max(w.h, apex * 0.5));
  const peak = lph((w.u0 + w.u1) / 2, (w.v0 + w.v1) / 2, apex);
  return poly([front, left, leftTop, peak, rightTop, right]);
}

// --- palettes ---------------------------------------------------------------

/**
 * Every colour a structure can ask for, as a material token. A type alias (not
 * an interface) so it stays assignable to the painter's `Record<string, string>`
 * palette bag.
 */
type StructPalette = {
  readonly wallA: string;
  readonly wallB: string;
  readonly wallTrim: string;
  readonly render: string;
  readonly quoin: string;
  readonly brick: string;
  readonly brickDark: string;
  readonly roofA: string;
  readonly roofB: string;
  readonly roofDark: string;
  readonly roofLine: string;
  readonly eave: string;
  readonly plank: string;
  readonly plankDark: string;
  readonly beam: string;
  readonly glass: string;
  readonly glassLit: string;
  readonly frame: string;
  readonly door: string;
  readonly stone: string;
  readonly stoneDark: string;
  readonly yard: string;
  readonly concA: string;
  readonly concB: string;
  readonly concDark: string;
  readonly concLit: string;
  readonly soffit: string;
  readonly sandbag: string;
  readonly sandbagDark: string;
  readonly sandbagLit: string;
  readonly steel: string;
  readonly steelDark: string;
  readonly wire: string;
  readonly tyre: string;
  readonly vehicle: string;
  readonly vehicleDark: string;
  readonly canvas: string;
  readonly canvasDark: string;
  readonly tarp: string;
  readonly crate: string;
  readonly crateDark: string;
  readonly ammo: string;
  readonly drum: string;
  readonly drumDark: string;
  readonly camo: string;
  readonly camoDark: string;
  readonly soot: string;
  readonly rubble: string;
  readonly ember: string;
  readonly burn: string;
  readonly flag: string;
  readonly flagDark: string;
  readonly lamp: string;
  readonly snow: string;
};

/** Allied early war: khaki render, weathered plank, muted brick, olive drab. */
const ALLIED_EARLY: StructPalette = {
  wallA: '#6d6849',
  wallB: '#8d8663',
  wallTrim: '#a79a72',
  render: '#9c9270',
  quoin: '#b3ab90',
  brick: '#8a5a45',
  brickDark: '#6b4030',
  roofA: '#7a5240',
  roofB: '#5c3c2e',
  roofDark: '#4a2f24',
  roofLine: '#8d6249',
  eave: '#6b5a44',
  plank: '#7d6743',
  plankDark: '#5e4c31',
  beam: '#6a5335',
  glass: '#243029',
  glassLit: '#556b53',
  frame: '#c3b894',
  door: '#6b5433',
  stone: '#8e8a78',
  stoneDark: '#6f6b5c',
  yard: '#6d6446',
  concA: '#8f8b7c',
  concB: '#a5a190',
  concDark: '#726e60',
  concLit: '#b0ab98',
  soffit: '#5f5b4f',
  sandbag: '#8d8160',
  sandbagDark: '#6e6450',
  sandbagLit: '#a1966f',
  steel: '#4a4f43',
  steelDark: '#333730',
  wire: '#3b4038',
  tyre: '#22201b',
  vehicle: '#5a6435',
  vehicleDark: '#3c4422',
  canvas: '#9a9276',
  canvasDark: '#7a735c',
  tarp: '#6f6a4e',
  crate: '#8a7346',
  crateDark: '#6a5834',
  ammo: '#7a7340',
  drum: '#4e5741',
  drumDark: '#3a4132',
  camo: '#5c6140',
  camoDark: '#454a31',
  soot: '#2a2724',
  rubble: '#8a8272',
  ember: '#ff9a3c',
  burn: '#3a332c',
  flag: '#cfd6b0',
  flagDark: '#8f9873',
  lamp: '#ffe08a',
  snow: '#e8eef2',
};

/** Allied late war: olive drab over grey concrete, plain tile, more steel. */
const ALLIED_LATE: StructPalette = {
  ...ALLIED_EARLY,
  wallA: '#5f6440',
  wallB: '#7f8452',
  wallTrim: '#969a63',
  render: '#8b8a5e',
  quoin: '#9aa07a',
  roofA: '#5a5748',
  roofB: '#424033',
  roofDark: '#34322a',
  roofLine: '#6c6959',
  eave: '#54523f',
  plank: '#726b40',
  plankDark: '#544e2e',
  beam: '#5c5533',
  frame: '#a7ad8a',
  door: '#4f5334',
  stone: '#8a8a80',
  stoneDark: '#6b6b62',
  yard: '#63603f',
  concA: '#8b8f83',
  concB: '#a1a598',
  concDark: '#6e7267',
  concLit: '#adb1a2',
  soffit: '#5b5f55',
  sandbag: '#8a8a62',
  sandbagDark: '#6c6c4e',
  sandbagLit: '#9e9e73',
  camo: '#55603a',
  camoDark: '#3e4729',
  flag: '#b9c7a0',
  flagDark: '#7f8f6c',
};

/** Axis early war: feldgrau walls, dark slate, grey concrete, red-brown tile. */
const AXIS_EARLY: StructPalette = {
  wallA: '#4f5a4c',
  wallB: '#66715f',
  wallTrim: '#7c8776',
  render: '#7b8272',
  quoin: '#8b9184',
  brick: '#6b4f45',
  brickDark: '#4f3931',
  roofA: '#6d4434',
  roofB: '#503023',
  roofDark: '#3e2419',
  roofLine: '#7d5340',
  eave: '#4d4a40',
  plank: '#5e5c48',
  plankDark: '#474531',
  beam: '#4c4433',
  glass: '#1f2723',
  glassLit: '#46564a',
  frame: '#8f9484',
  door: '#43483c',
  stone: '#7e7f77',
  stoneDark: '#61635c',
  yard: '#575444',
  concA: '#7e8079',
  concB: '#95978e',
  concDark: '#63655f',
  concLit: '#a3a59b',
  soffit: '#52544f',
  sandbag: '#78765c',
  sandbagDark: '#5d5c48',
  sandbagLit: '#8b8a67',
  steel: '#3f443f',
  steelDark: '#2b302c',
  wire: '#333832',
  tyre: '#201f1c',
  vehicle: '#4a5548',
  vehicleDark: '#333c34',
  canvas: '#7c7b65',
  canvasDark: '#5f5f4d',
  tarp: '#5b5a45',
  crate: '#6f6242',
  crateDark: '#544a30',
  ammo: '#5f5c3a',
  drum: '#4a4f42',
  drumDark: '#373b31',
  camo: '#4b5238',
  camoDark: '#39402b',
  soot: '#26241f',
  rubble: '#7c7a70',
  ember: '#ff9a3c',
  burn: '#35302a',
  flag: '#9aa88f',
  flagDark: '#6d7a63',
  lamp: '#ffe08a',
  snow: '#e8eef2',
};

/** Axis late war: darker slate, colder concrete, blacker steel. */
const AXIS_LATE: StructPalette = {
  ...AXIS_EARLY,
  wallA: '#485349',
  wallB: '#5e6a5c',
  wallTrim: '#727d70',
  render: '#6f766a',
  quoin: '#7f867b',
  roofA: '#46514e',
  roofB: '#333c3b',
  roofDark: '#262d2c',
  roofLine: '#57625f',
  eave: '#414440',
  plank: '#555340',
  plankDark: '#3f3e2c',
  beam: '#443d2e',
  frame: '#7f8577',
  door: '#3a3f35',
  stone: '#73746d',
  stoneDark: '#585a54',
  yard: '#4e4b3c',
  concA: '#767871',
  concB: '#8c8e85',
  concDark: '#5c5e58',
  concLit: '#9a9c92',
  soffit: '#4b4d48',
  sandbag: '#6f6d54',
  sandbagDark: '#565541',
  sandbagLit: '#81805f',
  camo: '#434a32',
  camoDark: '#323826',
  flag: '#8b9a82',
  flagDark: '#61705a',
};

/** Embers, lamps, snow and the flag keep their colour in the wreck palette. */
const WARM_TOKENS: readonly (keyof StructPalette)[] = ['ember', 'lamp', 'snow', 'burn', 'soot', 'flag', 'flagDark'];

/** Burnt-out palette: everything else is pulled towards charcoal. */
function charred(p: StructPalette): StructPalette {
  const out: Record<string, string> = {};
  for (const key of Object.keys(p) as (keyof StructPalette)[]) {
    out[key] = WARM_TOKENS.includes(key) ? p[key] : mix(p[key], '#241f1a', 0.52);
  }
  return out as unknown as StructPalette;
}

const WRECK_ALLIED = charred(ALLIED_LATE);
const WRECK_AXIS = charred(AXIS_LATE);

function paletteFor(faction: Faction, late: boolean, wrecked: boolean): StructPalette {
  if (faction === 'axis') return wrecked ? WRECK_AXIS : late ? AXIS_LATE : AXIS_EARLY;
  return wrecked ? WRECK_ALLIED : late ? ALLIED_LATE : ALLIED_EARLY;
}

// --- builders ---------------------------------------------------------------

interface Kit {
  readonly late: boolean;
  readonly wreck: boolean;
}

/** What one pass of a kind's builder produces. */
interface Drawn {
  readonly shapes: readonly Shape[];
  readonly wound: WoundBox;
  readonly muzzle: Point;
  readonly flag: Point | null;
  readonly topY: number;
  readonly lights: readonly string[];
  readonly eaves: readonly string[];
  readonly embers: readonly Point[];
}

/**
 * Player field headquarters: a two-storey command post with a hipped tile roof,
 * chimney, sandbag ring, radio mast, tent annex and a jeep in the yard. Late
 * tiers add a second annex, wall reinforcement and a camo net over the tent.
 */
function buildHq(k: Kit): Drawn {
  const out: Shape[] = [];
  const wreck = k.wreck;
  const late = k.late;
  const lights: string[] = [];
  const eaves: string[] = [];
  const embers: Point[] = [];
  const blockH = wreck ? 21 : 40;
  const wound: WoundBox = { u0: 16, v0: 14, u1: 66, v1: 58, h: blockH, roofH: wreck ? blockH + 4 : 56 };

  // Pressed-earth apron: the whole yard, one unit proud of the ground.
  mass(out, 8, 6, 86, 82, 1.6, { top: '@yard', side: '@stoneDark', face: '@stoneDark' });

  if (late && !wreck) {
    // Second annex, rear-left: a timber store that only the late-war HQ rates.
    mass(out, 4, 6, 28, 26, 15, { top: '@plankDark', side: '@plankDark', face: '@plank' });
    roof(out, 2, 4, 30, 28, 15, 24, 1, false, { lit: '@roofA', shade: '@roofB', lines: '@roofLine' }, 1, 4);
  }

  // Rear store: a plank lean-to against the back of the command block.
  const storeH = wreck ? 12 : 20;
  mass(out, 30, 4, 74, 30, storeH, { top: '@plankDark', side: '@plankDark', face: '@plank' });
  out.push(
    sh(
      quadPath(lph(30, 4, storeH + 6), lph(30, 30, storeH + 6), lph(74, 30, storeH + 1), lph(74, 4, storeH + 1)),
      '@roofA',
    ),
  );
  // The wedge of fascia closing the gap between the flat wall head and the tilted
  // roof edge — without it the lean-to looks like it is floating.
  out.push(
    sh(quadPath(lph(30, 30, storeH), lph(74, 30, storeH), lph(74, 30, storeH + 1), lph(30, 30, storeH + 6)), '@plankDark'),
  );
  for (let i = 1; i <= 4; i += 1) {
    const t = i / 5;
    out.push(line(segPath(lph(30 + 44 * t, 30, storeH + 1), lph(30 + 44 * t, 4, storeH + 6)), '@plankDark', 0.5));
  }

  // Command block: two storeys, quoins, string course, windows and a door.
  mass(out, 16, 14, 66, 58, blockH, { top: '@wallTrim', side: '@wallA', face: '@wallB' });
  wallBand(out, 16, 14, 66, 58, 0, 3, '@stoneDark');
  eaves.push(quadPath(lph(16, 58, blockH - 0.8), lph(66, 58, blockH - 0.8), lph(66, 58, blockH + 0.4), lph(16, 58, blockH + 0.4)));
  eaves.push(quadPath(lph(66, 14, blockH - 0.8), lph(66, 58, blockH - 0.8), lph(66, 58, blockH + 0.4), lph(66, 14, blockH + 0.4)));
  quoins(out, 66, 58, blockH, 6, 6.2);
  if (!wreck) {
    wallBand(out, 16, 14, 66, 58, 19.2, 20.8, '@wallTrim');
    windowRight(out, 66, 20, 29, 25, 35, lights);
    windowRight(out, 66, 47, 56, 25, 35, lights);
    windowRight(out, 66, 22, 31, 6, 15, lights);
    windowLeft(out, 58, 24, 32, 25, 35, lights);
    windowLeft(out, 58, 46, 54, 25, 35, lights);
  } else {
    // The upper storey has come down: what is left is a stub with a jagged top.
    out.push(
      sh(
        poly([
          lph(16, 58, 21),
          lph(40, 58, 21),
          lph(38, 58, 30),
          lph(30, 58, 25),
          lph(22, 58, 31),
          lph(16, 58, 26),
        ]),
        '@wallA',
      ),
    );
    rubblePile(out, 34, 62, 16, 9, 907);
  }
  doorRight(out, 66, 34, 45, 17);

  // Hipped tile roof (gone in the wreck beyond a couple of fallen spans).
  if (!wreck) {
    roof(out, 14, 12, 68, 60, blockH, blockH + 16, 10, true, { lit: '@roofA', shade: '@roofB', lines: '@roofLine' }, 3, 6);
    eaves.push(quadPath(lph(14, 60, blockH), lph(68, 60, blockH), lph(68, 60, blockH + 2.4), lph(14, 60, blockH + 2.4)));
    // Chimney: a slender brick stack under a capping slab. The cap is a top
    // plate plus a short edge band, NOT a `mass()` — a mass always rises from
    // the ground, so using one for a cap would box the whole stack in stone.
    mass(out, 46.5, 20.5, 52.5, 26.5, blockH + 15, { top: '@brick', side: '@brickDark', face: '@brick' });
    plate(out, 45, 19, 54, 28, blockH + 16.6, '@stone');
    out.push(
      sh(quadPath(lph(45, 28, blockH + 14.6), lph(54, 28, blockH + 14.6), lph(54, 28, blockH + 16.6), lph(45, 28, blockH + 16.6)), '@stoneDark'),
    );
    out.push(
      sh(quadPath(lph(54, 19, blockH + 14.6), lph(54, 28, blockH + 14.6), lph(54, 28, blockH + 16.6), lph(54, 19, blockH + 16.6)), '@stone'),
    );
    out.push(sh(triPath(lph(45, 19, blockH + 18), lph(55, 19, blockH + 18), lph(50, 17, blockH + 24)), '@soot', { opacity: 0.28 }));
  } else {
    // Two roof spans down: one still propped on the wall head, one on the ground.
    out.push(
      sh(
        poly([lph(16, 20, 34), lph(66, 16, 38), lph(66, 40, 30), lph(16, 44, 26)]),
        '@beam',
        { opacity: 0.95 },
      ),
    );
    out.push(
      sh(poly([lph(20, 46, 24), lph(52, 46, 30), lph(58, 70, 11), lph(26, 72, 8)]), '@roofDark', { opacity: 0.95 }),
    );
    out.push(line(segPath(lph(20, 46, 24), lph(58, 70, 11)), '@soot', 1.4));
    for (let i = 0; i < 4; i += 1) {
      embers.push(lph(30 + i * 8, 50 + i * 3, 22 + hash(i * 17) * 12));
    }
  }

  // Radio mast with guy wires, cross arms and a wire aerial to the chimney.
  const mastU = 80;
  const mastV = 8;
  const mastH = wreck ? 26 : 74;
  out.push(line(segPath(lp(mastU, mastV), lph(mastU, mastV, mastH)), '@steelDark', 1.5));
  if (!wreck) {
    out.push(line(segPath(lph(74, mastV, 62), lph(86, mastV, 62)), '@steel', 1));
    out.push(line(segPath(lph(74, mastV, 68), lph(86, mastV, 68)), '@steel', 1));
    out.push(line(segPath(lph(mastU, mastV, 70), lph(86, 4, 1.5)), '@wire', 0.5));
    out.push(line(segPath(lph(mastU, mastV, 70), lph(72, 2, 1.5)), '@wire', 0.5));
    out.push(line(segPath(lph(mastU, mastV, 66), lph(78, 26, storeH + 6)), '@wire', 0.5));
    out.push(line(segPath(lph(mastU, mastV, 72), lph(52, 23, blockH + 21)), '@wire', 0.5));
  } else {
    // The mast is down: a bent stub and the top section lying across the yard.
    out.push(line(segPath(lp(mastU, mastV), lph(mastU - 6, mastV + 4, mastH)), '@steelDark', 1.4));
    out.push(line(segPath(lph(70, 16, 4), lph(90, 30, 1)), '@steelDark', 1.3));
    out.push(line(segPath(lph(72, 18, 3.4), lph(88, 28, 1)), '@steel', 0.7));
  }

  // Flag pole on the wall head, with the faction flag (drawn per frame).
  const poleU = 24;
  const poleV = 22;
  const poleTop = wreck ? blockH + 14 : 78;
  out.push(line(segPath(lph(poleU, poleV, wreck ? blockH - 4 : blockH), lph(poleU, poleV, poleTop)), '@steelDark', 1.6));
  out.push(sh(ellipsePath(lph(poleU, poleV, poleTop).x, lph(poleU, poleV, poleTop).y, 1.3, 1.3), '@steel'));

  // Tent annex on the left flank, with a camo net once the kit is late war.
  ridgeTent(out, 2, 28, 22, 48, wreck ? 9 : 18, wreck);
  if (late && !wreck) camoNet(out, 0, 26, 24, 50, 20);

  // Sandbag ring and the base's own defensive gun, in front of the door.
  const pitU = 80;
  const pitV = 44;
  sandbagRow(out, 70, 30, 70, 58, 0, 2, -1.8, -0.9, 31);
  sandbagRow(out, 70, 58, 88, 58, 0, 2, -1.8, 0.9, 37);
  sandbagRow(out, 88, 58, 88, 30, 0, 2, 1.8, -0.9, 41);
  sandbagRow(out, 88, 30, 70, 30, 0, 2, 1.8, 0.9, 43);
  if (late && !wreck) {
    // Reinforced revetment along the wall feet, and a second bag layer on the pit.
    sandbagRow(out, 70, 24, 70, 60, 0, 1, 0, 0, 53);
    sandbagRow(out, 88, 58, 88, 30, 1, 1, 0, 0, 59);
  }
  const muzzle = baseGun(out, pitU, pitV, 8, 13);

  // Yard kit: crates, fuel dump, jeep and a motorcycle lean-to.
  crate(out, 78, 62, 9, 8, 7, false);
  crate(out, 79, 63, 7, 6, 13, true);
  crate(out, 62, 74, 8, 7, 6, false);
  drum(out, 58, 80, 3.2, 8);
  drum(out, 64, 82, 3.2, 8);
  drum(out, 60, 86, 3.2, 8);
  truck(out, 6, 56, 20, 9, wreck);

  return {
    shapes: out,
    wound,
    muzzle,
    flag: lph(poleU, poleV, poleTop - 3),
    topY: wreck ? -30 : -60,
    lights,
    eaves,
    embers,
  };
}

/**
 * Enemy strongpoint: a thick battered concrete emplacement under an overhanging
 * slab, with a firing embrasure, steel door, trench ramp, sandbag parapet, wire
 * and a camouflage net over the rear of the roof.
 */
function buildStronghold(k: Kit): Drawn {
  const out: Shape[] = [];
  const wreck = k.wreck;
  const late = k.late;
  const lights: string[] = [];
  const eaves: string[] = [];
  const embers: Point[] = [];
  const hMax = wreck ? 12 : 22;
  const batter = 3;
  const wound: WoundBox = { u0: 12, v0: 12, u1: 70, v1: 66, h: hMax, roofH: wreck ? hMax + 3 : 25 };

  mass(out, 4, 4, 88, 84, 1.4, { top: '@yard', side: '@stoneDark', face: '@stoneDark' });

  // Rammed-up earth bank the emplacement is dug into.
  out.push(sh(poly([lp(2, 2), lp(88, 2), lp(84, 12), lp(6, 12)]), '@rubble', { opacity: 0.5 }));

  // Battered main mass. The wreck keeps only the outer shell, sheared over.
  battered(out, 12, 12, 70, 66, hMax, batter, { top: '@concB', side: '@concA', face: '@concB' });
  wallBand(out, 12, 12, 70, 66, 0, 2.4, '@concDark');
  if (!wreck) {
    // Overhanging roof slab: top face plus the visible edge band, which is what
    // reads as a soffit and makes the emplacement look poured rather than stacked.
    plate(out, 7, 7, 75, 71, 25, '@concB');
    // Expansion joints and a lit rim: a bare pale slab this size reads as an
    // empty lid on top of the position.
    out.push(line(segPath(lph(7, 39, 25), lph(75, 39, 25)), '@concDark', 0.7));
    out.push(line(segPath(lph(41, 7, 25), lph(41, 71, 25)), '@concDark', 0.7));
    out.push(sh(quadPath(lph(7, 71, 24.4), lph(75, 71, 24.4), lph(75, 71, 25), lph(7, 71, 25)), '@concLit', { opacity: 0.5 }));
    out.push(sh(quadPath(lph(7, 71, 21.6), lph(75, 71, 21.6), lph(75, 71, 25), lph(7, 71, 25)), '@soffit'));
    out.push(sh(quadPath(lph(75, 7, 21.6), lph(75, 71, 21.6), lph(75, 71, 25), lph(75, 7, 25)), '@concDark'));
    eaves.push(quadPath(lph(7, 71, 24), lph(75, 71, 24), lph(75, 71, 25.6), lph(7, 71, 25.6)));
    eaves.push(quadPath(lph(75, 7, 24), lph(75, 71, 24), lph(75, 71, 25.6), lph(75, 7, 25.6)));
  } else {
    // The slab has cracked across the middle and dropped onto the west wall.
    out.push(
      sh(poly([lph(6, 8, 15), lph(46, 6, 25), lph(50, 40, 22), lph(10, 44, 11)]), '@concB'),
    );
    out.push(sh(poly([lph(46, 6, 25), lph(76, 10, 20), lph(70, 66, 13), lph(50, 40, 22)]), '@concDark'));
    out.push(sh(poly([lph(14, 52, 24), lph(58, 60, 17), lph(62, 78, 3), lph(20, 74, 2)]), '@concA', { opacity: 0.96 }));
    out.push(line(segPath(lph(14, 52, 24), lph(62, 78, 3)), '@soot', 1.4));
  }

  // Firing embrasure in the screen-right face, with the MG protruding.
  const embH = wreck ? 6.5 : 12;
  const embU = batterU(70, batter, embH, hMax);
  embrasure(out, embU, 26, 52, wreck ? 3.4 : 9.5, embH + (wreck ? 2.6 : 3.2), lights);
  const muzzle = baseGun(out, embU - 4, 39, wreck ? 5 : 10.4, 15);

  // Steel door and blast wall on the screen-left face.
  steelDoor(out, 66, 24, 34, wreck ? 7 : 12);
  mass(out, 20, 62, 40, 68, wreck ? 5 : 9, { top: '@concDark', side: '@concDark', face: '@concB' });

  // Trench entrance ramp down to the door, with revetments.
  out.push(
    sh(
      poly([lph(24, 68, 0), lph(41, 68, 0), lph(41, 80, 0), lph(24, 80, 0)]),
      '@soot',
      { opacity: 0.55 },
    ),
  );
  out.push(line(segPath(lph(24, 68, 1), lph(24, 80, 0)), '@rubble', 1.6));
  out.push(line(segPath(lph(41, 68, 1), lph(41, 80, 0)), '@rubble', 1.6));

  // Sandbag parapet wrapping the front, oil drums beside the door.
  sandbagRow(out, 72, 14, 72, 62, 0, 2, -1.8, 0.9, 61);
  sandbagRow(out, 72, 62, 56, 70, 0, 2, 0.9, -1.8, 67);
  sandbagRow(out, 16, 70, 40, 70, 0, 2, -0.9, -1.8, 71);
  drum(out, 46, 74, 3.4, 8.4);
  drum(out, 53, 76, 3.4, 8.4);
  drum(out, 49, 81, 3.4, 8.4);

  // Wire belts and broken concrete out front.
  wireCoil(out, 8, 78, 66, 78, 73);
  if (late && !wreck) wireCoil(out, 12, 84, 60, 84, 79);
  rubblePile(out, 30, 82, 13, 8, 83);
  rubblePile(out, 66, 70, 10, 6, 89);
  out.push(sh(poly([lp(74, 76), lp(86, 74), lp(88, 80), lp(76, 84)]), '@concA', { opacity: 0.9 }));
  out.push(sh(poly([lp(74, 76), lp(86, 74), lp(84, 70), lp(72, 72)]), '@concDark', { opacity: 0.9 }));

  // Camouflage netting over the rear half of the slab.
  if (!wreck) camoNet(out, 10, 10, 72, 40, 25.4);
  if (late && !wreck) {
    // Observation cupola and an extra bag layer: the late-war pattern.
    out.push(sh(ellipsePath(lp(58, 26).x, lp(58, 26).y - 27.5, 7, 3.6), '@concLit'));
    out.push(sh(quadPath(lph(52, 20, 25), lph(64, 20, 25), lph(64, 32, 25), lph(52, 32, 25)), '@concB'));
    out.push(line(segPath(lph(52, 32, 25), lph(64, 32, 27.6)), '@concLit', 1));
    sandbagRow(out, 72, 14, 72, 62, 4, 1, 0, 0, 97);
    periscope(out, 34, 30, 25, 7);
  }

  if (wreck) {
    for (let i = 0; i < 5; i += 1) embers.push(lph(20 + i * 10, 40 + i * 4, 10 + hash(i * 13) * 10));
    rubblePile(out, 40, 44, 20, 12, 103);
  }

  return {
    shapes: out,
    wound,
    muzzle,
    flag: null,
    topY: wreck ? -26 : -34,
    lights,
    eaves,
    embers,
  };
}

/**
 * Supply depot: two or three corrugated sheds round a working yard of crates,
 * drum rows, a tarpaulin stack, a gantry crane, a truck at the loading bay and
 * a tally board.
 */
function buildDepot(k: Kit): Drawn {
  const out: Shape[] = [];
  const wreck = k.wreck;
  const late = k.late;
  const lights: string[] = [];
  const eaves: string[] = [];
  const embers: Point[] = [];
  const wound: WoundBox = { u0: 4, v0: 12, u1: 50, v1: 46, h: wreck ? 10 : 18, roofH: wreck ? 12 : 30 };

  mass(out, 2, 2, 88, 88, 1.4, { top: '@yard', side: '@stoneDark', face: '@stoneDark' });
  // Plank road through the yard, so the sheds read as sited rather than floated.
  out.push(sh(poly([lp(2, 52), lp(88, 52), lp(88, 60), lp(2, 60)]), '@plankDark', { opacity: 0.4 }));

  // Shed A: the big store, gable run along u.
  mass(out, 4, 12, 50, 46, wreck ? 10 : 18, { top: '@plankDark', side: '@plankDark', face: '@plank' });
  wallBand(out, 4, 12, 50, 46, 0, 2, '@stoneDark');
  if (!wreck) {
    roof(out, 2, 10, 52, 48, 18, 30, 0, true, { lit: '@roofA', shade: '@roofB', lines: '@roofLine' }, 2, 7);
    eaves.push(quadPath(lph(2, 48, 17), lph(52, 48, 17), lph(52, 48, 18.6), lph(2, 48, 18.6)));
  } else {
    // Half the roof has slid off and lies against the west wall.
    out.push(sh(quadPath(lph(2, 48, 22), lph(52, 48, 22), lph(52, 48, 12), lph(2, 48, 12)), '@roofB'));
    out.push(line(segPath(lph(2, 48, 22), lph(52, 48, 22)), '@roofDark', 1));
    out.push(sh(poly([lph(2, 50, 8), lph(52, 50, 3), lph(58, 74, 2), lph(6, 72, 2)]), '@roofDark', { opacity: 0.95 }));
    for (let i = 0; i < 3; i += 1) embers.push(lph(12 + i * 12, 30 + i * 5, 8 + hash(i * 7) * 8));
  }
  out.push(line(segPath(lph(4, 46, 8), lph(50, 46, 8)), '@plankDark', 0.7));

  // Shed B: smaller, gable run along v, so the two silhouettes cross.
  const shedBH = wreck ? 8 : 15;
  mass(out, 56, 8, 86, 36, shedBH, { top: '@plankDark', side: '@plankDark', face: '@plank' });
  if (!wreck) {
    roof(out, 54, 6, 88, 38, shedBH, 24, 2, false, { lit: '@roofA', shade: '@roofB', lines: '@roofLine' }, 2, 6);
    eaves.push(quadPath(lph(88, 6, 14), lph(88, 38, 14), lph(88, 38, 15.6), lph(88, 6, 15.6)));
  } else {
    out.push(sh(poly([lph(54, 6, 12), lph(88, 6, 12), lph(88, 38, 6), lph(54, 38, 6)]), '@roofDark', { opacity: 0.9 }));
  }

  // Late war: a third shed on the front-left, more stock on the ground.
  if (late) {
    mass(out, 6, 56, 34, 82, wreck ? 6 : 14, { top: '@plankDark', side: '@plankDark', face: '@plank' });
    if (!wreck) roof(out, 4, 54, 36, 84, 14, 23, 2, true, { lit: '@roofA', shade: '@roofB', lines: '@roofLine' }, 2, 5);
    else out.push(sh(poly([lph(6, 56, 8), lph(34, 56, 4), lph(34, 82, 2), lph(6, 82, 2)]), '@roofDark', { opacity: 0.9 }));
  }

  // Stacked crates and ammunition boxes between the sheds.
  crate(out, 48, 16, 9, 8, 8, false);
  crate(out, 49, 17, 7, 6, 14, true);
  crate(out, 32, 8, 8, 7, 7, false);
  crate(out, 20, 50, 9, 8, wreck ? 7 : 10, false);
  crate(out, 21, 51, 7, 6, 17, true);
  if (late) {
    crate(out, 60, 44, 9, 8, 8, false);
    crate(out, 61, 45, 7, 6, 14, true);
  }

  // Drum rows in front of shed B.
  for (let i = 0; i < 4; i += 1) {
    drum(out, 60 + i * 7, 44, 3.2, 8);
    if (late) drum(out, 60 + i * 7, 52, 3.2, 8);
  }
  if (wreck) {
    // Drums burst and scattered by the shelling.
    drum(out, 74, 62, 3.2, 5);
    out.push(line(segPath(lp(66, 58), lp(72, 62)), '@soot', 2));
  }

  // Tarpaulin-covered stack on the apron.
  tarpStack(out, 30, 54, 46, 68, wreck ? 6 : 12);

  // Gantry crane over the loading bay, with the truck backed up to it.
  gantry(out, 44, 62, 40, 26, wreck);
  truck(out, 46, 62, 18, 10, wreck);
  truck(out, 12, 70, 22, 10, wreck && late);

  // Tally board and a wire fence stub along the front.
  signpost(out, 74, 74, 17);
  out.push(sh(quadPath(lph(70, 74, 6), lph(82, 74, 6), lph(82, 74, 15), lph(70, 74, 15)), '@crateDark'));
  out.push(line(segPath(lph(72, 74, 9.5), lph(80, 74, 9.5)), '@ammo', 1));
  out.push(line(segPath(lph(72, 74, 12), lph(80, 74, 12)), '@ammo', 1));
  wireCoil(out, 4, 88, 52, 88, 107);

  return {
    shapes: out,
    wound,
    muzzle: lph(56, 40, 12),
    flag: null,
    topY: wreck ? -22 : -34,
    lights,
    eaves,
    embers,
  };
}

/**
 * Low concrete pillbox: squat battered massing, a wide embrasure, camouflage
 * paint, sandbags on the roof, a periscope and a blast wall over the entrance.
 */
function buildBunker(k: Kit): Drawn {
  const out: Shape[] = [];
  const wreck = k.wreck;
  const late = k.late;
  const lights: string[] = [];
  const eaves: string[] = [];
  const embers: Point[] = [];
  const h = wreck ? 9 : 15;
  const batter = 2.4;
  const wound: WoundBox = { u0: 22, v0: 22, u1: 70, v1: 70, h, roofH: h + 1 };

  mass(out, 12, 12, 80, 80, 1.2, { top: '@yard', side: '@stoneDark', face: '@stoneDark' });
  battered(out, 22, 22, 70, 70, h, batter, { top: '@concB', side: '@concA', face: '@concB' });
  wallBand(out, 22, 22, 70, 70, 0, 2, '@concDark');

  // Wide embrasure plus the barrel.
  embrasure(out, batterU(70, batter, 8, h), 30, 62, wreck ? 2.6 : 5.6, wreck ? 6.4 : 9.4, lights);
  const muzzle = baseGun(out, batterU(70, batter, 8, h) - 5, 46, wreck ? 4 : 7.4, 16);

  // Camouflage paint: irregular blotches, deterministic from the seed.
  for (let i = 0; i < 5; i += 1) {
    const u = 26 + hash(211 + i * 7) * 40;
    const v = 24 + hash(223 + i * 11) * 42;
    const p = lph(u, v, 1.5 + hash(229 + i * 3) * (h - 3));
    out.push(sh(ellipsePath(p.x, p.y, 4 + hash(233 + i) * 3, 3 + hash(239 + i) * 2), '@camo', { opacity: 0.72 }));
  }

  // Sandbags on the roof — the classic pillow-bunker reinforcing.
  sandbagRow(out, 26, 26, 26, 66, h + 0.4, 2, 1.4, 0.7, 109);
  sandbagRow(out, 26, 26, 66, 26, h + 0.4, 2, 0.7, 1.4, 113);
  sandbagRow(out, 66, 66, 30, 66, h + 0.4, 1, -0.7, -1.4, 127);
  if (late && !wreck) sandbagRow(out, 66, 66, 66, 26, h + 0.4, 1, -1.4, -0.7, 131);

  // Periscope and vents on the roof.
  periscope(out, 34, 34, h, 8);
  out.push(sh(ellipsePath(lp(56, 30).x, lp(56, 30).y - h - 1, 3.4, 1.8), '@steelDark'));
  out.push(sh(ellipsePath(lp(50, 62).x, lp(50, 62).y - h - 0.8, 2.6, 1.4), '@concDark'));

  // Blast wall over the entrance, with a steel door behind it.
  steelDoor(out, 70, 44, 58, wreck ? 5 : 9);
  mass(out, 40, 72, 64, 76, wreck ? 5 : 10, { top: '@concDark', side: '@concDark', face: '@concB' });
  out.push(sh(poly([lp(38, 70), lp(66, 70), lp(64, 78), lp(40, 78)]), '@soot', { opacity: 0.4 }));

  // Camouflage netting over part of the roof once the position is a late one.
  if (late && !wreck) camoNet(out, 26, 40, 68, 68, h + 1.6);

  if (wreck) {
    // One corner blown away: a sheared stump, blackened and open to the sky.
    out.push(sh(poly([lph(60, 60, 9), lph(70, 60, 6), lph(70, 70, 4), lph(58, 70, 1)]), '@concA'));
    out.push(sh(poly([lph(58, 58, 9), lph(66, 58, 7), lph(64, 64, 4), lph(56, 64, 5)]), '@concDark'));
    rubblePile(out, 62, 66, 15, 10, 137);
    for (let i = 0; i < 4; i += 1) embers.push(lph(32 + i * 9, 40 + i * 6, 6 + hash(i * 19) * 7));
  }

  return {
    shapes: out,
    wound,
    muzzle,
    flag: null,
    topY: wreck ? -18 : -24,
    lights,
    eaves,
    embers,
  };
}

/**
 * Small outpost: a sandbagged gun pit round a light MG, a bell tent, a
 * watchtower with a ladder, a signal lamp, a wire stub and a signpost.
 */
function buildOutpost(k: Kit): Drawn {
  const out: Shape[] = [];
  const wreck = k.wreck;
  const late = k.late;
  const lights: string[] = [];
  const eaves: string[] = [];
  const embers: Point[] = [];
  const wound: WoundBox = { u0: 26, v0: 26, u1: 72, v1: 70, h: wreck ? 8 : 14, roofH: 18 };

  mass(out, 14, 14, 82, 82, 1.2, { top: '@yard', side: '@stoneDark', face: '@stoneDark' });

  // Bell tent (a ridge tent read from the front) behind the pit.
  ridgeTent(out, 24, 22, 44, 42, wreck ? 8 : 19, wreck);
  if (late && !wreck) camoNet(out, 22, 20, 46, 44, 20.6);

  // Gun pit: a sandbag ring with the MG on its tripod inside.
  sandbagRing(out, 46, 58, 13, wreck ? 1 : 2, 139);
  const muzzle = baseGun(out, 46, 58, wreck ? 3 : 7, 14);
  if (late && !wreck) sandbagRing(out, 46, 58, 16, 1, 149);

  // Watchtower on the right flank.
  watchtower(out, 60, 30, 74, 46, wreck ? 8 : 30, wreck);

  // Signal lamp and a crate of belts beside the pit.
  signalLamp(out, 56, 62, wreck ? 8 : 22);
  crate(out, 34, 66, 8, 7, wreck ? 3 : 7, true);
  if (late) crate(out, 34, 74, 8, 7, wreck ? 3 : 7, true);

  // A short belt of wire and a signpost out front.
  wireCoil(out, 16, 74, 56, 74, 151);
  signpost(out, 66, 72, wreck ? 8 : 16);

  if (wreck) {
    rubblePile(out, 46, 58, 14, 7, 157);
    for (let i = 0; i < 3; i += 1) embers.push(lph(38 + i * 8, 50 + i * 5, 5 + hash(i * 23) * 6));
  }

  return {
    shapes: out,
    wound,
    muzzle,
    flag: null,
    topY: wreck ? -16 : -46,
    lights,
    eaves,
    embers,
  };
}

// --- memo -------------------------------------------------------------------

interface Built {
  readonly standing: Sprite;
  readonly wreck: Sprite;
  readonly hurt: Sprite;
  readonly battered: Sprite;
  readonly critical: Sprite;
  readonly silhouette: string;
  readonly eaves: readonly string[];
  readonly lights: readonly string[];
  /** Muzzle of the base's own gun, local world units. */
  readonly muzzle: Point;
  /** Pole-top local point for the flag, or null where a kind has no pole. */
  readonly flag: Point | null;
  /** Roof apex height in local units (negative y is up) — marker and smoke use. */
  readonly topY: number;
  readonly embers: readonly Point[];
}

const MEMO = new Map<string, Built>();

const DAMAGE_SEED: Readonly<Record<BaseKind, number>> = {
  hq: 17,
  stronghold: 29,
  depot: 41,
  bunker: 53,
  outpost: 67,
};

function buildKind(kind: BaseKind, k: Kit): Drawn {
  switch (kind) {
    case 'hq':
      return buildHq(k);
    case 'stronghold':
      return buildStronghold(k);
    case 'depot':
      return buildDepot(k);
    case 'bunker':
      return buildBunker(k);
    default:
      return buildOutpost(k);
  }
}

/** Build (once) and cache everything a kind needs at one tier bracket. */
function builtFor(kind: BaseKind, late: boolean): Built {
  const key = `${kind}|${late ? 'late' : 'early'}`;
  const hit = MEMO.get(key);
  if (hit) return hit;
  const whole = buildKind(kind, { late, wreck: false });
  const ruined = buildKind(kind, { late, wreck: true });
  const overlay = buildDamage(whole.wound, DAMAGE_SEED[kind]);
  const built: Built = {
    standing: { shapes: whole.shapes },
    wreck: { shapes: ruined.shapes },
    hurt: overlay.hurt,
    battered: overlay.battered,
    critical: overlay.critical,
    silhouette: hullFor(whole.wound, -whole.topY),
    eaves: whole.eaves,
    lights: whole.lights,
    muzzle: whole.muzzle,
    flag: whole.flag,
    topY: whole.topY,
    embers: ruined.embers,
  };
  MEMO.set(key, built);
  return built;
}

// --- per-frame effects ------------------------------------------------------

/** Propellant flash out of the barrel: a bright cone plus a soft bloom. */
function drawFlash(ctx: CanvasRenderingContext2D, m: Point, flash: number): void {
  const len = 8 + flash * 14;
  const w = 2.6 + flash * 3.4;
  const tipX = m.x + DIR_U.x * len;
  const tipY = m.y + DIR_U.y * len;
  const px = -DIR_U.y;
  const py = DIR_U.x;
  ctx.fillStyle = `rgba(255, 236, 168, ${(0.5 + flash * 0.45).toFixed(3)})`;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(m.x + px * w, m.y + py * w);
  ctx.lineTo(m.x - px * w, m.y - py * w);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(255, 248, 214, ${(0.22 + flash * 0.3).toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(m.x, m.y, 4 + flash * 6, 0, TAU);
  ctx.fill();
}

/**
 * A smoke plume of billboard puffs. `amount` grows the puffs and darkens them;
 * the wreck state runs the same code with a heavier amount, so a knocked-out
 * base keeps a tall column going for as long as it is on the field.
 */
function drawPlume(ctx: CanvasRenderingContext2D, x: number, y: number, amount: number, time: number, drift: number): void {
  const puffs = amount > 0.6 ? 7 : 5;
  const height = 34 + amount * 46;
  const size = 4 + amount * 9;
  for (let i = 0; i < puffs; i += 1) {
    const t = ((time * (0.34 + amount * 0.2) + i / puffs) % 1);
    const py = y - t * height;
    const px = x + Math.sin(t * 3.1 + i * 1.7) * (3 + t * 7) + t * drift;
    const r = size * (0.5 + t * 1.25);
    const alpha = Math.min(0.5, amount * (1 - t) * 0.62);
    ctx.fillStyle = `rgba(58, 54, 48, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(120, 114, 104, ${(alpha * 0.42).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px - r * 0.25, py - r * 0.2, r * 0.62, 0, TAU);
    ctx.fill();
  }
}

/** Waving faction flag from the pole head, or a limp scrap once it is a wreck. */
function drawFlag(ctx: CanvasRenderingContext2D, pole: Point, time: number, destroyed: boolean): void {
  const wave = Math.sin(time * 2.3) * 2.1;
  const wave2 = Math.sin(time * 2.3 + 1.2) * 2.1;
  if (destroyed) {
    // Shot away to a rag: a short, dark, slack triangle.
    ctx.fillStyle = 'rgba(52, 46, 38, 0.92)';
    ctx.beginPath();
    ctx.moveTo(pole.x, pole.y);
    ctx.lineTo(pole.x + 9, pole.y + 4 + wave * 0.4);
    ctx.lineTo(pole.x + 4, pole.y + 11);
    ctx.lineTo(pole.x, pole.y + 7);
    ctx.closePath();
    ctx.fill();
    return;
  }
  const w = 17;
  ctx.fillStyle = '#000000';
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  ctx.moveTo(pole.x, pole.y);
  ctx.lineTo(pole.x + w * 0.55, pole.y + 1.4 + wave * 0.7);
  ctx.lineTo(pole.x + w * 0.55, pole.y + 10 + wave2 * 0.7);
  ctx.lineTo(pole.x, pole.y + 11);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = currentFlagFill;
  ctx.beginPath();
  ctx.moveTo(pole.x, pole.y);
  ctx.lineTo(pole.x + w, pole.y + wave);
  ctx.lineTo(pole.x + w, pole.y + 10 + wave2);
  ctx.lineTo(pole.x, pole.y + 11);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(18, 20, 14, 0.22)';
  ctx.beginPath();
  ctx.moveTo(pole.x + 1, pole.y + 7.4);
  ctx.lineTo(pole.x + w - 1, pole.y + 6.6 + wave2 * 0.6);
  ctx.lineTo(pole.x + w, pole.y + 10 + wave2);
  ctx.lineTo(pole.x, pole.y + 11);
  ctx.closePath();
  ctx.fill();
}

/** Set by `drawStructure` just before the flag is painted (avoids re-resolving). */
let currentFlagFill = '#cccccc';

/** Embers rising off a wreck: few, cheap, deterministic, driven by `time`. */
function drawEmbers(ctx: CanvasRenderingContext2D, points: readonly Point[], time: number): void {
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (!p) continue;
    const t = (time * 0.5 + i * 0.23) % 1;
    const x = p.x + Math.sin(time * 0.9 + i) * 3;
    const y = p.y - t * 16;
    ctx.fillStyle = `rgba(255, 156, 60, ${(0.75 * (1 - t)).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.5 - t * 0.7, 0, TAU);
    ctx.fill();
  }
}

// --- public API -------------------------------------------------------------

/**
 * Draw one base at `(o.x, o.y)` and return where its own gun fires from, in the
 * same CSS px frame. Everything is drawn in the local billboard frame described
 * in the module docstring.
 */
export function drawStructure(
  ctx: CanvasRenderingContext2D,
  o: StructureDrawOptions,
): { muzzleX: number; muzzleY: number } {
  const late = o.tier >= 6;
  const built = builtFor(o.kind, late);
  const palette = paletteFor(o.faction, late, o.destroyed);
  const hp = Math.max(0, Math.min(1, o.hpFraction));
  const wrecked = o.destroyed;
  const scale = o.scale;

  // Ground ring first, then the shadow, so both sit under the massing.
  if (o.selected) {
    drawGroundRing(ctx, {
      x: o.x,
      y: o.y - PLOT * 0.5 * scale,
      rx: PLOT * scale,
      ry: PLOT * 0.5 * scale,
      colour: RING_FRIENDLY,
      time: o.time,
    });
  }
  drawShadow(ctx, {
    x: o.x,
    y: o.y - PLOT * 0.5 * scale,
    rx: PLOT * 0.86 * scale,
    ry: PLOT * 0.44 * scale,
    alpha: wrecked ? 0.3 : 0.36,
  });
  if (o.targeted) {
    // The ring is the friendly "launch from here" cue; a targeted base gets the
    // hostile objective ring as well so the two states are never confusable.
    drawGroundRing(ctx, {
      x: o.x,
      y: o.y - PLOT * 0.5 * scale,
      rx: PLOT * 1.04 * scale,
      ry: PLOT * 0.52 * scale,
      colour: RING_TARGET,
      time: o.time,
      period: 1.2,
    });
  }

  // A hit leans the whole structure very slightly and keeps the muzzle aligned.
  const lean = o.hit * 1.3;

  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(scale, scale);
  ctx.translate(lean, -lean * 0.4);

  paintSprite(ctx, wrecked ? built.wreck : built.standing, palette);
  if (!wrecked) {
    // Overlays stack: 0.2 hp draws all three, so the decline reads continuously.
    if (hp < 0.72) paintSprite(ctx, built.hurt, palette);
    if (hp < 0.45) paintSprite(ctx, built.battered, palette);
    if (hp < 0.22) paintSprite(ctx, built.critical, palette);
  }

  // Weather: a snow ledge on every eave and lamp-light in the openings at night.
  if (o.environment === 'snow' && built.eaves.length > 0) {
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = palette.snow;
    for (const d of built.eaves) ctx.fill(pathOf(d));
    ctx.globalAlpha = 1;
  }
  if (o.environment === 'night' && built.lights.length > 0) {
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = palette.lamp;
    for (const d of built.lights) ctx.fill(pathOf(d));
    ctx.globalAlpha = 1;
  }

  if (o.hit > 0.01) {
    ctx.globalAlpha = Math.min(0.5, o.hit * 0.55);
    ctx.fillStyle = palette.snow;
    ctx.fill(pathOf(built.silhouette));
    ctx.globalAlpha = 1;
  }

  if (o.flash > 0.01) drawFlash(ctx, built.muzzle, o.flash);
  if (built.flag) {
    currentFlagFill = palette.flag;
    drawFlag(ctx, built.flag, o.time, wrecked);
  }

  const plume = wrecked ? Math.max(0.62, o.smoke) : o.smoke;
  // Smoke leaves through the roof at the centre of the plot, not from the
  // muzzle: a burning building vents upwards whatever kind it is.
  if (plume > 0.02) drawPlume(ctx, 0, built.topY + 8, Math.min(1, plume), o.time, -2);
  if (wrecked && built.embers.length > 0) drawEmbers(ctx, built.embers, o.time);

  ctx.restore();

  // Tracers need the same lean the gun was drawn with.
  const muzzleX = o.x + (built.muzzle.x + lean) * scale;
  const muzzleY = o.y + (built.muzzle.y - lean * 0.4) * scale;
  if (o.targeted) {
    drawObjectiveMarker(ctx, {
      x: o.x,
      y: o.y,
      colour: MARKER_TARGET,
      time: o.time,
      lift: (-built.topY + 16) * scale,
    });
  }
  return { muzzleX, muzzleY };
}

// --- HUD icons --------------------------------------------------------------

const ICON_UNITS = 58;

const ICON_MEMO = new Map<string, Sprite>();

function iconRec(x: number, y: number, w: number, h: number, fill: Paint, opacity?: number): Shape {
  return sh(rectPath(x, y, w, h), fill, opacity !== undefined ? { opacity } : undefined);
}

function iconPoly(points: readonly Point[], fill: Paint, opacity?: number): Shape {
  return sh(poly(points), fill, opacity !== undefined ? { opacity } : undefined);
}

/** The five front-on silhouettes, authored inside a 58-unit tall box. */
function buildIcon(kind: BaseKind, late: boolean): Sprite {
  const shapes: Shape[] = [];
  switch (kind) {
    case 'hq': {
      // Massing: front wall, receding side wall, hipped roof, chimney, flag.
      shapes.push(iconRec(-19, -30, 27, 30, '@wallB'));
      shapes.push(iconPoly([{ x: 8, y: -30 }, { x: 21, y: -36 }, { x: 21, y: -6 }, { x: 8, y: 0 }], '@wallA'));
      shapes.push(iconPoly([{ x: -21, y: -30 }, { x: 10, y: -30 }, { x: 5, y: -42 }, { x: -9, y: -42 }], '@roofA'));
      shapes.push(iconPoly([{ x: 10, y: -30 }, { x: 23, y: -36 }, { x: 6, y: -42 }], '@roofB'));
      shapes.push(iconRec(2, -52, 5, 12, '@brick'));
      shapes.push(iconRec(1, -54, 7, 3, '@stoneDark'));
      shapes.push(iconRec(-17, -26, 8, 8, '@frame'));
      shapes.push(iconRec(-16, -25, 6, 6, '@glass'));
      shapes.push(iconRec(-4, -26, 8, 8, '@frame'));
      shapes.push(iconRec(-3, -25, 6, 6, '@glass'));
      shapes.push(iconRec(-10, -15, 10, 15, '@frame'));
      shapes.push(iconRec(-9, -14, 8, 14, '@door'));
      shapes.push(iconRec(-2, -1, 16, 2, '@stone'));
      shapes.push(line('M20 -36L20 -54', '@steelDark', 1.4));
      shapes.push(iconPoly([{ x: 20, y: -54 }, { x: 32, y: -52 }, { x: 32, y: -47 }, { x: 20, y: -49 }], '@flag'));
      if (late) {
        shapes.push(iconRec(-30, -18, 12, 18, '@plank'));
        shapes.push(iconPoly([{ x: -32, y: -18 }, { x: -16, y: -18 }, { x: -23, y: -28 }], '@roofB'));
        for (let i = 0; i < 5; i += 1) shapes.push(iconRec(-24 + i * 11, -4, 8, 4, '@sandbag'));
      } else {
        for (let i = 0; i < 4; i += 1) shapes.push(iconRec(-20 + i * 11, -4, 9, 4, '@sandbag'));
      }
      break;
    }
    case 'stronghold': {
      // Front wall and the overhanging slab, then the embrasure cut into the
      // wall — the slit plus the protruding barrel is what stops this reading
      // as a plain slab of concrete at chip size.
      shapes.push(iconRec(-22, -22, 36, 22, '@concA'));
      shapes.push(iconRec(-3, -22, 17, 22, '@concDark'));
      shapes.push(iconPoly([{ x: 14, y: -22 }, { x: 25, y: -27 }, { x: 25, y: -6 }, { x: 14, y: 0 }], '@concA'));
      shapes.push(iconPoly([{ x: -26, y: -24 }, { x: 14, y: -24 }, { x: 25, y: -29 }, { x: -15, y: -29 }], '@concLit'));
      shapes.push(iconPoly([{ x: -26, y: -24 }, { x: 14, y: -24 }, { x: 14, y: -20 }, { x: -26, y: -20 }], '@soffit'));
      shapes.push(iconRec(-17, -14, 26, 9, '@soot'));
      shapes.push(iconRec(-16, -13.2, 24, 7.4, '@concDark', 0.35));
      shapes.push(iconRec(9, -14, 17, 4, '@steelDark'));
      shapes.push(iconRec(-17, -14, 26, 1.6, '@concLit', 0.55));
      shapes.push(iconPoly([{ x: -18, y: -29 }, { x: 0, y: -29 }, { x: 3, y: -25 }, { x: -16, y: -25 }], '@camo', 0.9));
      for (let i = 0; i < 5; i += 1) shapes.push(iconRec(-24 + i * 10.5, -4.5, 9, 4.5, '@sandbag'));
      for (let i = 0; i < 4; i += 1) shapes.push(iconRec(-19 + i * 10.5, -8, 9, 4, '@sandbagDark'));
      shapes.push(line('M-28 3L20 3', '@wire', 0.8));
      shapes.push(line('M-28 3A 5 3 0 1 0 -18 3', '@wire', 1));
      shapes.push(line('M-2 3A 5 3 0 1 0 8 3', '@wire', 1));
      break;
    }
    case 'depot': {
      // Two sheds of different pitch, so the chip reads as "stores" not "house".
      shapes.push(iconRec(-25, -20, 25, 20, '@plank'));
      shapes.push(iconPoly([{ x: -27, y: -20 }, { x: 1, y: -20 }, { x: -13, y: -32 }], '@roofA'));
      shapes.push(iconPoly([{ x: 1, y: -20 }, { x: 11, y: -25 }, { x: -4, y: -35 }, { x: -13, y: -32 }], '@roofB'));
      shapes.push(iconRec(5, -13, 16, 13, '@plank'));
      shapes.push(iconPoly([{ x: 3, y: -13 }, { x: 22, y: -13 }, { x: 14, y: -21 }], '@roofB'));
      shapes.push(iconRec(-22, -24, 10, 4, '@roofLine', 0.5));
      shapes.push(iconRec(8, -18, 10, 4, '@roofLine', 0.5));
      for (let i = 0; i < 3; i += 1) shapes.push(iconRec(-12 + i * 9, -7, 7, 7, '@drum'));
      shapes.push(iconRec(-27, -7, 9, 7, '@crate'));
      shapes.push(iconRec(-26, -13, 7, 6, '@ammo'));
      shapes.push(line('M24 -2L24 -34', '@steelDark', 1.4));
      shapes.push(line('M24 -34L3 -34', '@steel', 1.4));
      shapes.push(line('M8 -34L8 -26', '@wire', 0.8));
      shapes.push(iconPoly([{ x: 6, y: -26 }, { x: 10, y: -26 }, { x: 10, y: -23 }], '@steel'));
      shapes.push(iconRec(-4, -1, 20, 2, '@stoneDark'));
      break;
    }
    case 'bunker': {
      // Squat, wide, and read from the top: camouflage netting over a concrete
      // lid, sandbags stacked round the rim, one wide slit and a periscope.
      shapes.push(iconRec(-27, -14, 48, 14, '@concB'));
      shapes.push(iconPoly([{ x: 21, y: -14 }, { x: 32, y: -19 }, { x: 32, y: -5 }, { x: 21, y: 0 }], '@concA'));
      shapes.push(iconPoly([{ x: -29, y: -15 }, { x: 21, y: -15 }, { x: 33, y: -20 }, { x: -17, y: -20 }], '@concLit'));
      shapes.push(iconPoly([{ x: -24, y: -20 }, { x: 18, y: -20 }, { x: 28, y: -24 }, { x: -14, y: -24 }], '@camo'));
      shapes.push(iconRec(-19, -9, 26, 6, '@soot'));
      shapes.push(iconRec(14, -9, 14, 3, '@steelDark'));
      shapes.push(iconPoly([{ x: -19, y: -12 }, { x: -2, y: -12 }, { x: 0, y: -8 }, { x: -17, y: -8 }], '@camoDark', 0.8));
      for (let i = 0; i < 5; i += 1) shapes.push(iconRec(-22 + i * 10, -26, 8.5, 4, '@sandbag'));
      for (let i = 0; i < 3; i += 1) shapes.push(iconRec(-18 + i * 10, -30, 8.5, 4, '@sandbagDark'));
      shapes.push(line('M10 -24L10 -33', '@steelDark', 1.2));
      shapes.push(iconRec(8, -36, 5, 3, '@steel'));
      shapes.push(iconRec(-32, -11, 8, 11, '@concB'));
      break;
    }
    default: {
      // Outpost: bell tent, sandbag pit, watchtower and a wire stub.
      shapes.push(iconPoly([{ x: -22, y: 0 }, { x: 2, y: 0 }, { x: -10, y: -24 }], '@canvas'));
      shapes.push(iconPoly([{ x: -10, y: 0 }, { x: 2, y: 0 }, { x: -10, y: -24 }], '@canvasDark'));
      shapes.push(line('M-10 -24L-10 -30', '@steelDark', 1.2));
      for (let i = 0; i < 5; i += 1) shapes.push(iconRec(4 + i * 9, -5, 8, 5, '@sandbag'));
      shapes.push(iconRec(4, -9, 42, 4, '@sandbagDark'));
      shapes.push(line('M18 0L20 -30', '@plank', 2));
      shapes.push(line('M40 0L38 -30', '@plank', 2));
      shapes.push(line('M19 -10L39 -18', '@plankDark', 1));
      shapes.push(line('M39 -10L19 -18', '@plankDark', 1));
      shapes.push(iconRec(14, -34, 30, 4, '@plank'));
      shapes.push(iconPoly([{ x: 12, y: -34 }, { x: 46, y: -34 }, { x: 29, y: -46 }], '@roofB'));
      shapes.push(line('M-30 0L-30 10', '@plank', 1.4));
      shapes.push(line('M-34 4L-26 4', '@plankDark', 1));
      shapes.push(line('M-34 8L-26 8', '@plankDark', 1));
      shapes.push(line('M-30 2A 5 3 0 1 0 -20 2', '@wire', 1));
      if (late) {
        shapes.push(iconRec(46, -12, 10, 12, '@plank'));
        shapes.push(iconPoly([{ x: 44, y: -12 }, { x: 58, y: -12 }, { x: 51, y: -20 }], '@roofB'));
      }
      break;
    }
  }
  return { shapes };
}

/**
 * A simplified, static, front-on silhouette of the same building, fitted to
 * `height` px and sitting on `baselineY`, for the battle HUD's launch-pad chips.
 * No damage, no animation: a chip has to be legible at 40 px.
 */
export function drawStructureIcon(
  ctx: CanvasRenderingContext2D,
  kind: BaseKind,
  faction: Faction,
  tier: number,
  x: number,
  baselineY: number,
  height: number,
): void {
  const late = tier >= 6;
  const key = `${kind}|${late ? 'late' : 'early'}`;
  let sprite = ICON_MEMO.get(key);
  if (!sprite) {
    sprite = buildIcon(kind, late);
    ICON_MEMO.set(key, sprite);
  }
  const s = height / ICON_UNITS;
  paintSprite(ctx, sprite, paletteFor(faction, late, false), { scaleX: s, scaleY: s, tx: x, ty: baselineY });
}
