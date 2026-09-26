/**
 * Isometric ground features: trenches, mine belts and river crossings.
 *
 * Layering contract
 * -----------------
 * This pass runs with the camera transform applied but **without**
 * `applyIso(ctx)`: every point is placed through `isoPoint()`/`poly()` in
 * projected px. That separation from the flat terrain pass is deliberate — it is
 * the only way to draw anything upright, because a "vertical" line under the iso
 * basis does not come out vertical on screen. Here an upright is a quad between a
 * projected ground point and the same point lifted by a height in screen px,
 * which is how the parapets, revetment, warning posts, railings and bridge piles
 * are built. The parts of a feature that do lie flat on the ground (trench
 * floors, duckboards, spoil heaps, water) are still projected polygons, with a
 * small positive `sink` where they sit *below* the surface.
 *
 * Both ground passes run once per frame, after `drawGround` and before any
 * upright entity, so nothing here has to cover the field — only the rectangles
 * the simulation laid out on it. Nothing here draws outside them.
 *
 * Feature rectangles are centre + extents (`x`/`y` are the centre, `w`/`h` the
 * full extents), matching the simulation's own `PlaneRect`. A trench line is a
 * band across the direction of advance, so it is thin in x and deep in y, which
 * is what puts its parapet along the x lip and its spoil heap beyond it.
 */

import type { Environment } from '../../data/campaignData';
import { environmentRules } from '../../game/environment';
import { WORLD_H } from '../../game/constants';
import { mix } from './common';
import type { GroundFeaturesView, WorldView } from './contracts';
import { isoPoint, poly, type Point } from './iso';
import { pathOf } from './paint';
import { groundAnchors } from './terrain';

const TAU = Math.PI * 2;
const SQRT2 = Math.SQRT2;

/** Scene constants shared with the rest of the iso artwork. */
const BRASS = '#d9a441';
const BONE = '#d8d2c0';
const DANGER = '#c45c4a';
/** The colours a position takes when one side has stormed the other's ground. */
const SIDE_TINT = { player: '#7fbf6a', enemy: '#d9705f' } as const;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// --- projected-frame geometry -----------------------------------------------

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Deterministic 0..1 from two integers: features carry no seed of their own. */
function rand01(a: number, b: number): number {
  let h = (Math.imul(a | 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Projected corners of a world-plane rectangle. */
function corners(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [isoPoint(x0, y0), isoPoint(x1, y0), isoPoint(x1, y1), isoPoint(x0, y1)];
}

/** World-plane rectangle, projected, dropped `sink` px to sit below the surface. */
function planeD(x0: number, y0: number, x1: number, y1: number, sink = 0): string {
  const points = corners(x0, y0, x1, y1);
  if (sink === 0) return poly(points);
  return poly(points.map((p) => ({ x: p.x, y: p.y + sink })));
}

/**
 * The upright primitive: a quad between a ground edge (two world points) and the
 * same edge lifted `h` screen px. Every standing thing in this module is built
 * from it, so the whole pass shares one idea of "vertical".
 */
function uprightD(x0: number, y0: number, x1: number, y1: number, h: number, sink = 0): string {
  const a = isoPoint(x0, y0);
  const b = isoPoint(x1, y1);
  return poly([
    { x: a.x, y: a.y + sink },
    { x: b.x, y: b.y + sink },
    { x: b.x, y: b.y + sink - h },
    { x: a.x, y: a.y + sink - h },
  ]);
}

/** A flat ground rectangle standing `h` px above the plane (bag tops, boards). */
function liftedD(x0: number, y0: number, x1: number, y1: number, h: number): string {
  return poly(corners(x0, y0, x1, y1).map((p) => ({ x: p.x, y: p.y - h })));
}

/**
 * A circle of radius `r` on the plane projects to an *axis-aligned* ellipse: the
 * basis maps (r cosθ, r sinθ) to (√2 r cosφ, (√2 r / 2) sinφ). Knowing that is
 * what lets pits, craters and bag tops be ellipses instead of polygons.
 *
 * Written as two half arcs because SVG — and so Path2D path data — drops an
 * elliptical arc whose ends coincide, which would silently erase the shape.
 */
function ellipseD(x: number, y: number, r: number, lift = 0, sink = 0): string {
  const p = isoPoint(x, y);
  const rx = r * SQRT2;
  const ry = r / SQRT2;
  const cy = p.y - lift + sink;
  return `M${round1(p.x + rx)} ${round1(cy)}a${round1(rx)} ${round1(ry)} 0 0 0 ${round1(-2 * rx)} 0a${round1(rx)} ${round1(ry)} 0 0 0 ${round1(2 * rx)} 0Z`;
}

/** The same ellipse appended to a Path2D, for batched layers. */
function addEllipse(path: Path2D, x: number, y: number, r: number, lift = 0, sink = 0): void {
  const p = isoPoint(x, y);
  const rx = r * SQRT2;
  const ry = r / SQRT2;
  path.moveTo(p.x + rx, p.y - lift + sink);
  path.ellipse(p.x, p.y - lift + sink, rx, ry, 0, 0, TAU);
}

// --- feature palette --------------------------------------------------------

/**
 * Feature colours come from the ground the features were dug out of and the sky
 * the environment actually has, so a trench in snow throws a pale spoil heap and
 * a river reflects the light of the season it is in. Only timber is fixed, and
 * even that is blended toward the local earth.
 */
interface FeatureLook {
  readonly earth: string;
  readonly earthDark: string;
  readonly earthDeep: string;
  readonly earthLight: string;
  readonly spoil: string;
  readonly bag: string;
  readonly bagDark: string;
  readonly timber: string;
  readonly timberDark: string;
  readonly water: string;
  readonly waterDeep: string;
  readonly waterSheen: string;
}

const looks = new Map<Environment, FeatureLook>();

function featureLook(env: Environment): FeatureLook {
  const hit = looks.get(env);
  if (hit) return hit;
  const ground = groundAnchors(env);
  const sky = environmentRules(env).look;
  const look: FeatureLook = {
    earth: ground.earth,
    earthDark: ground.earthDark,
    earthDeep: mix(ground.earthDark, '#070605', 0.55),
    earthLight: ground.earthLight,
    // Freshly turned soil is lighter than the surface it came out of.
    spoil: mix(ground.earthLight, '#b09a72', 0.3),
    bag: mix('#7a6f4f', ground.earthLight, 0.35),
    bagDark: mix('#4a432c', ground.earthDark, 0.35),
    timber: mix('#4a3a26', ground.earth, 0.3),
    timberDark: mix('#2a2117', ground.earthDark, 0.35),
    // Water is a mirror first and a colour second: mostly sky, then darkened.
    water: mix(sky.skyMid, '#101c24', 0.55),
    waterDeep: mix(sky.skyMid, '#070d12', 0.78),
    waterSheen: mix(sky.skyHorizon, '#eaf4f8', 0.3),
  };
  looks.set(env, look);
  return look;
}

// --- trenches ---------------------------------------------------------------

interface TrenchArt {
  readonly apron: string;
  readonly spoil: string;
  readonly spoilCrest: string;
  readonly cut: readonly string[];
  readonly revetment: string;
  readonly fireStep: string;
  readonly duckboards: string;
  readonly duckSlats: string;
  readonly parapetWalls: string;
  readonly parapetTops: string;
  readonly parados: string;
  readonly innerShadow: string;
}

const trenchArts = new Map<string, TrenchArt>();

/**
 * The dug position, assembled from the outside in: thrown earth, the light spoil
 * heap on the enemy side (forward, which is where the spoil of an advance
 * position goes), the cut in three layers of depth, timber shoring the near
 * wall, a fire step under the enemy lip, and duckboards on the floor.
 */
function buildTrenchArt(r: Rect): TrenchArt {
  const x0 = r.x - r.w / 2;
  const x1 = r.x + r.w / 2;
  const y0 = r.y - r.h / 2;
  const y1 = r.y + r.h / 2;
  const cx0 = x0 + 7;
  const cx1 = x1 - 7;
  const cy0 = y0 + 14;
  const cy1 = y1 - 14;

  // Spoil heap: a lumpy ridge beyond the enemy lip, sampled so its edge wanders
  // rather than running as a straight bank.
  const heapOuter: string[] = [];
  const heapInner: string[] = [];
  for (let y = y0 + 4; y <= y1 - 4; y += 16) {
    heapOuter.push(`${round1(x1 + 8 + rand01(Math.round(r.x), Math.round(y)) * 9)} ${y}`);
    heapInner.push(`${x1 + 1} ${y}`);
  }
  heapInner.reverse();
  const heap = heapOuter.concat(heapInner);
  let spoil = `M${heap[0]}`;
  for (let i = 1; i < heap.length; i += 1) spoil += `L${heap[i]}`;
  spoil += 'Z';

  let spoilCrest = '';
  for (let y = y0 + 8; y <= y1 - 8; y += 16) {
    const x = x1 + 7 + rand01(Math.round(r.y), Math.round(y)) * 5;
    const p = isoPoint(x, y);
    spoilCrest += spoilCrest === '' ? `M${round1(p.x)} ${round1(p.y)}` : `L${round1(p.x)} ${round1(p.y)}`;
  }

  // The cut, three layers: each narrower and darker, which reads as depth.
  const cut = [
    planeD(cx0, cy0, cx1, cy1),
    planeD(cx0 + 4, cy0 + 4, cx1 - 4, cy1 - 4),
    planeD(cx0 + 8, cy0 + 8, cx1 - 8, cy1 - 8, 2),
  ];

  // Revetment: rough planks shoring the near wall, with a post at each end.
  let revetment = '';
  for (let y = cy0 + 2; y < cy1 - 8; y += 13) {
    revetment += uprightD(cx0 - 1, y, cx0 - 1, y + 10, 5);
  }
  revetment += uprightD(cx0 - 1, cy0 - 2, cx0 - 1, cy0 + 6, 7);
  revetment += uprightD(cx0 - 1, cy1 - 6, cx0 - 1, cy1 + 2, 7);

  // Fire step under the enemy lip, where the garrison stands to shoot.
  const fireStep = liftedD(cx1 - 14, cy0 + 6, cx1 - 3, cy1 - 6, 3);

  // Duckboards: boards laid across the floor, sunk into the cut.
  let duckboards = '';
  let duckSlats = '';
  for (let y = cy0 + 8; y < cy1 - 10; y += 22) {
    duckboards += planeD(cx0 + 7, y, cx1 - 9, y + 11, 3);
    for (let k = 1; k < 3; k += 1) {
      const a = isoPoint(cx0 + 7, y + k * 3.6);
      const b = isoPoint(cx1 - 9, y + k * 3.6);
      duckSlats += `M${round1(a.x)} ${round1(a.y + 3)}L${round1(b.x)} ${round1(b.y + 3)}`;
    }
  }

  // Parapet: two staggered rows of bags along the enemy lip. Each bag is a thick
  // round-capped stroke from its base to its top, so it reads as a filled bag
  // rather than a brick; its top face is then drawn as a lit ellipse.
  let parapetWalls = '';
  let parapetTops = '';
  for (let row = 0; row < 2; row += 1) {
    const bx = cx1 + 1 - row * 4;
    const height = row === 0 ? 7.5 : 5.5;
    for (let y = cy0 + 2; y < cy1 - 2; y += 9) {
      const by = y + rand01(Math.round(r.x) + row, Math.round(y)) * 1.6;
      const base = isoPoint(bx, by);
      parapetWalls += `M${round1(base.x)} ${round1(base.y)}L${round1(base.x)} ${round1(base.y - height)}`;
      parapetTops += ellipseD(bx, by, 3.4, height);
    }
  }

  // Parados: the earth ridge thrown back off the near lip, with a few bags laid
  // along it where the garrison is still digging in.
  let parados = planeD(x0 - 3, y0 + 2, x0 + 5, y1 - 2);
  for (let y = y0 + 14; y < y1 - 10; y += 26) {
    const a = isoPoint(x0 + 1, y);
    const b = isoPoint(x0 + 1, y + 4);
    parados += `M${round1(a.x)} ${round1(a.y)}L${round1(b.x)} ${round1(b.y)}`;
  }

  return {
    apron: planeD(x0 - 9, y0 - 7, x1 + 16, y1 + 7),
    spoil,
    spoilCrest,
    cut,
    revetment,
    fireStep,
    duckboards,
    duckSlats,
    parapetWalls,
    parapetTops,
    parados,
    innerShadow: planeD(cx1 - 9, cy0, cx1 - 1, cy1),
  };
}

function trenchArt(env: Environment, r: Rect): TrenchArt {
  const key = `${env}|${round1(r.x)},${round1(r.y)},${round1(r.w)},${round1(r.h)}`;
  const hit = trenchArts.get(key);
  if (hit) return hit;
  const art = buildTrenchArt(r);
  if (trenchArts.size > 32) trenchArts.clear();
  trenchArts.set(key, art);
  return art;
}

function drawTrench(
  ctx: CanvasRenderingContext2D,
  env: Environment,
  look: FeatureLook,
  r: Rect,
  overrunBy: 'player' | 'enemy' | null,
  index: number,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const art = trenchArt(env, r);
  const x0 = r.x - r.w / 2;
  const x1 = r.x + r.w / 2;
  const y0 = r.y - r.h / 2;
  const y1 = r.y + r.h / 2;

  // Verge of trodden earth around the whole position, then the spoil it threw up.
  ctx.fillStyle = look.earth;
  ctx.globalAlpha = 0.38;
  ctx.fill(pathOf(art.apron));
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = look.spoil;
  ctx.fill(pathOf(art.spoil));
  ctx.globalAlpha = 1;

  // The cut, darkest last so no light leaks into the bottom of it.
  ctx.fillStyle = look.earthDark;
  ctx.fill(pathOf(art.cut[0]));
  ctx.fillStyle = look.earthDeep;
  ctx.fill(pathOf(art.cut[1]));
  ctx.fillStyle = mix(look.earthDeep, '#000000', 0.45);
  ctx.fill(pathOf(art.cut[2]));
  ctx.fillStyle = mix(look.earthDeep, '#000000', 0.35);
  ctx.globalAlpha = 0.6;
  ctx.fill(pathOf(art.innerShadow));
  ctx.globalAlpha = 1;

  // Duckboards on the floor, with their seams catching a little light.
  ctx.fillStyle = mix(look.timber, '#000000', 0.25);
  ctx.globalAlpha = 0.8;
  ctx.fill(pathOf(art.duckboards));
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = mix(look.timberDark, '#000000', 0.2);
  ctx.lineWidth = 1;
  ctx.stroke(pathOf(art.duckSlats));
  ctx.globalAlpha = 1;

  // The fire step, which is the one part of the cut the light reaches.
  ctx.fillStyle = look.earthLight;
  ctx.globalAlpha = 0.55;
  ctx.fill(pathOf(art.fireStep));
  ctx.globalAlpha = 1;

  if (overrunBy === null) {
    // Intact and garrisoned: earth parados on the near lip, a full bag parapet on
    // the enemy lip, timber on both walls and the spoil crest catching the light.
    ctx.strokeStyle = look.earthLight;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.4;
    ctx.stroke(pathOf(art.spoilCrest));
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = look.spoil;
    ctx.fill(pathOf(art.parados));
    ctx.globalAlpha = 1;

    ctx.strokeStyle = look.bag;
    ctx.lineWidth = 7.4;
    ctx.lineCap = 'round';
    ctx.stroke(pathOf(art.parapetWalls));
    // Put the cap back: the renderer draws its own strokes after this pass and
    // must not inherit a style this module happened to need.
    ctx.lineCap = 'butt';
    ctx.fillStyle = mix(look.bag, '#ffffff', 0.18);
    ctx.fill(pathOf(art.parapetTops));
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = look.bagDark;
    ctx.lineWidth = 1.1;
    ctx.stroke(pathOf(art.parapetTops));
    ctx.globalAlpha = 1;

    ctx.fillStyle = look.timber;
    ctx.fill(pathOf(art.revetment));
    ctx.strokeStyle = look.timberDark;
    ctx.lineWidth = 0.9;
    ctx.stroke(pathOf(art.revetment));
    return;
  }

  // Stormed: the parapet is down, the floor is churned, and the lip has taken
  // the colour of whoever is standing in it.
  ctx.fillStyle = SIDE_TINT[overrunBy];
  ctx.globalAlpha = 0.13;
  ctx.fill(pathOf(planeD(x0 - 4, y0 - 3, x1 + 4, y1 + 3)));
  ctx.globalAlpha = 1;

  let fallen = '';
  for (let i = 0; i < 7; i += 1) {
    const bx = x0 + 6 + rand01(index + 1, i * 7 + 3) * (r.w - 12);
    const by = y0 + 10 + rand01(index + 9, i * 5 + 11) * (r.h - 20);
    fallen += ellipseD(bx, by, 3.6, 1.2, 2);
  }
  ctx.fillStyle = look.bag;
  ctx.fill(pathOf(fallen));
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = look.bagDark;
  ctx.lineWidth = 1;
  ctx.stroke(pathOf(fallen));
  ctx.globalAlpha = 1;

  // Churned ground: dark boot-torn clods, lighter dirt thrown clear of the cut.
  let torn = '';
  let thrown = '';
  for (let i = 0; i < 18; i += 1) {
    const bx = x0 - 4 + rand01(index + 3, i * 11 + 1) * (r.w + 8);
    const by = y0 + rand01(index + 5, i * 13 + 7) * r.h;
    torn += ellipseD(bx, by, 1.6 + rand01(index, i) * 1.6, 0, 1.5);
  }
  for (let i = 0; i < 10; i += 1) {
    const bx = x0 - 8 + rand01(index + 7, i * 17 + 5) * (r.w + 20);
    const by = y0 + rand01(index + 11, i * 3 + 2) * r.h;
    thrown += ellipseD(bx, by, 0.9 + rand01(index + 2, i + 4) * 1.1, 0, 0.6);
  }
  ctx.fillStyle = mix(look.earthDeep, '#000000', 0.3);
  ctx.globalAlpha = 0.7;
  ctx.fill(pathOf(torn));
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = look.earthLight;
  ctx.fill(pathOf(thrown));
  ctx.globalAlpha = 1;

  // Spent brass in the dirt where the position was fought over.
  let brass = '';
  for (let i = 0; i < 8; i += 1) {
    const bx = x0 + rand01(index + 13, i * 19 + 3) * r.w;
    const by = y0 + 6 + rand01(index + 17, i * 23 + 9) * (r.h - 12);
    brass += ellipseD(bx, by, 0.85, 0, 0.4);
  }
  ctx.fillStyle = BRASS;
  ctx.fill(pathOf(brass));
  ctx.strokeStyle = mix(BRASS, '#000000', 0.55);
  ctx.lineWidth = 0.8;
  ctx.stroke(pathOf(brass));

  // Broken timber along the lip where the revetment was kicked in.
  let broken = '';
  for (let i = 0; i < 4; i += 1) {
    const by = y0 + 16 + rand01(index + 23, i * 29 + 1) * (r.h - 32);
    const a = isoPoint(x0 + 2, by);
    broken += `M${round1(a.x)} ${round1(a.y)}L${round1(a.x + 9)} ${round1(a.y + 6)}`;
  }
  ctx.strokeStyle = look.timberDark;
  ctx.lineWidth = 2;
  ctx.stroke(pathOf(broken));
}

// --- minefields -------------------------------------------------------------

interface BeltArt {
  readonly belt: string;
  readonly lane: string;
  readonly speckle: string;
  readonly nearWire: string;
  readonly farWire: string;
  readonly stakes: string;
  readonly signs: string;
  readonly signStripe: string;
}

const beltArts = new Map<string, BeltArt>();

function beltArt(env: Environment, r: Rect): BeltArt {
  const key = `${env}|${round1(r.x)},${round1(r.y)},${round1(r.w)},${round1(r.h)}`;
  const hit = beltArts.get(key);
  if (hit) return hit;
  const x0 = r.x - r.w / 2;
  const x1 = r.x + r.w / 2;
  const y0 = r.y - r.h / 2;
  const y1 = r.y + r.h / 2;

  // Stakes and wire down both long edges: a belt is fenced on the frontage a unit
  // reaches first *and* behind, which is also what makes the sweep direction read.
  let stakes = '';
  let near = '';
  let far = '';
  let signs = '';
  let signStripe = '';
  let signCount = 0;
  for (let y = y0 + 4; y < y1 - 2; y += 24) {
    const endY = Math.min(y + 24, y1 - 2);
    for (let side = 0; side < 2; side += 1) {
      const sx = side === 0 ? x0 + 1 : x1 - 1;
      stakes += uprightD(sx, y, sx, y + 1.6, 15);
      const a = isoPoint(sx, y + 0.8);
      const b = isoPoint(sx, endY + 0.8);
      const midX = round1((a.x + b.x) / 2);
      const midY = round1((a.y + b.y) / 2);
      // Two strands, each sagging between stakes: wire under tension hangs, and
      // that sag is most of what says "barbed" at this scale.
      const strand = (h: number): string =>
        `M${round1(a.x)} ${round1(a.y - h)}Q${midX} ${round1(midY - h + 2.4)} ${round1(b.x)} ${round1(b.y - h)}`;
      if (side === 0) near += strand(14) + strand(9.5);
      else far += strand(14) + strand(9.5);
      if (signCount < 2 && y + 24 >= y1 - 2) {
        // A board on the end stake of each wire, so the belt is announced rather
        // than merely implied by the stakes.
        signs += uprightD(sx, y + 2, sx + 1.4, y + 9, 19);
        const top = isoPoint(sx + 0.7, y + 5);
        signStripe += `M${round1(top.x - 4)} ${round1(top.y - 16)}L${round1(top.x + 4)} ${round1(top.y - 13)}`;
        signCount += 1;
      }
    }
  }

  // Churned earth through the belt, so it reads as buried ground, not bare ground.
  let speckle = '';
  const count = Math.max(12, Math.round(r.h / 5));
  for (let i = 0; i < count; i += 1) {
    const bx = x0 + rand01(Math.round(r.x), i * 3 + 1) * r.w;
    const by = y0 + rand01(Math.round(r.y), i * 7 + 5) * r.h;
    speckle += ellipseD(bx, by, 0.8 + rand01(i, Math.round(r.x)) * 1.5, 0, 1);
  }

  const art: BeltArt = {
    belt: planeD(x0 - 5, y0 - 4, x1 + 5, y1 + 4),
    lane: planeD(x0 - 1, y0, x1 + 1, y1),
    speckle,
    nearWire: near,
    farWire: far,
    stakes,
    signs,
    signStripe,
  };
  if (beltArts.size > 16) beltArts.clear();
  beltArts.set(key, art);
  return art;
}

function drawMinefield(
  ctx: CanvasRenderingContext2D,
  env: Environment,
  look: FeatureLook,
  r: Rect,
  armed: number,
  mines: readonly { readonly x: number; readonly y: number; readonly exploded: boolean }[],
  index: number,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const x0 = r.x - r.w / 2;
  const y0 = r.y - r.h / 2;
  const art = beltArt(env, r);

  // The belt: disturbed earth the whole way across, with a trodden lane through it.
  ctx.fillStyle = look.earth;
  ctx.globalAlpha = 0.42;
  ctx.fill(pathOf(art.belt));
  ctx.fillStyle = mix(look.earthDark, look.earth, 0.4);
  ctx.globalAlpha = 0.5;
  ctx.fill(pathOf(art.lane));
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = mix(look.earthDeep, '#000000', 0.25);
  ctx.fill(pathOf(art.speckle));
  ctx.globalAlpha = 1;

  // Boundary wires, so the belt is legible as a marked obstacle from either side.
  ctx.strokeStyle = mix(BONE, '#6b6a60', 0.55);
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.stroke(pathOf(art.nearWire));
  ctx.stroke(pathOf(art.farWire));
  ctx.globalAlpha = 1;
  ctx.fillStyle = mix(look.timber, '#000000', 0.2);
  ctx.fill(pathOf(art.stakes));
  ctx.fillStyle = BONE;
  ctx.fill(pathOf(art.signs));
  ctx.strokeStyle = DANGER;
  ctx.lineWidth = 2.4;
  ctx.stroke(pathOf(art.signStripe));

  // Craters and buried mines, batched per layer: a belt of forty mines costs six
  // fills rather than a couple of hundred.
  const scorch = new Path2D();
  const rim = new Path2D();
  const bowl = new Path2D();
  const dirt = new Path2D();
  const patched = new Path2D();
  let exploded = 0;
  let buried = 0;
  for (let i = 0; i < mines.length; i += 1) {
    const mine = mines[i];
    if (mine.exploded) {
      exploded += 1;
      const spread = 8 + rand01(index + 31, i) * 5;
      addEllipse(scorch, mine.x, mine.y, spread);
      addEllipse(rim, mine.x, mine.y, spread * 0.72, 1.5);
      // The bowl is dropped into the ground, the rim is the earth thrown out of it.
      addEllipse(bowl, mine.x, mine.y, spread * 0.5, 0, 3);
      for (let k = 0; k < 5; k += 1) {
        const angle = rand01(index + 41, i * 7 + k) * TAU;
        const reach = spread * (0.8 + rand01(index + 43, i + k) * 0.9);
        addEllipse(dirt, mine.x + Math.cos(angle) * reach, mine.y + Math.sin(angle) * reach, 0.9);
      }
    } else {
      buried += 1;
      // Barely there on purpose: the player must be able to read the belt — and
      // the gap in it as it is swept — not count the mines.
      addEllipse(patched, mine.x, mine.y, 3.6);
    }
  }
  if (exploded > 0) {
    ctx.fillStyle = mix(look.earthDeep, '#000000', 0.35);
    ctx.globalAlpha = 0.42;
    ctx.fill(scorch);
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = look.earthLight;
    ctx.fill(rim);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = mix(look.earthDeep, '#000000', 0.6);
    ctx.fill(bowl);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = look.earthLight;
    ctx.fill(dirt);
    ctx.globalAlpha = 1;
  }
  if (buried > 0) {
    ctx.fillStyle = mix(look.earthDeep, '#000000', 0.2);
    ctx.globalAlpha = 0.16;
    ctx.fill(patched);
    ctx.globalAlpha = 1;
  }

  // One upright warning post per mine still in the ground, so sweeping the belt
  // visibly thins the markers instead of leaving a fence standing for good.
  if (armed <= 0) return;
  const posts: Point[] = [];
  const capLimit = Math.min(armed, 20);
  for (let i = 0; i < mines.length && posts.length < capLimit; i += 1) {
    const mine = mines[i];
    if (!mine.exploded) posts.push({ x: mine.x, y: mine.y });
  }
  // A belt whose mine list was not sent still gets its markers, spread evenly.
  for (let i = posts.length; i < capLimit; i += 1) {
    const t = (i + 0.5) / capLimit;
    posts.push({
      x: x0 + 6 + rand01(index + 53, i) * (r.w - 12),
      y: y0 + 6 + t * (r.h - 12),
    });
  }
  let postPath = '';
  const caps = new Path2D();
  for (let i = 0; i < posts.length; i += 1) {
    const post = posts[i];
    postPath += uprightD(post.x, post.y, post.x, post.y + 1.2, 11);
    const top = isoPoint(post.x, post.y + 0.6);
    caps.moveTo(top.x + 2.4, top.y - 10.5);
    caps.lineTo(top.x - 2.4, top.y - 11.1);
    caps.lineTo(top.x, top.y - 15);
    caps.closePath();
  }
  ctx.fillStyle = mix(look.timber, '#ffffff', 0.1);
  ctx.fill(pathOf(postPath));
  ctx.strokeStyle = mix(look.timber, '#000000', 0.4);
  ctx.lineWidth = 0.8;
  ctx.stroke(pathOf(postPath));
  ctx.fillStyle = DANGER;
  ctx.fill(caps);
}

// --- river crossings --------------------------------------------------------

interface BridgeArt {
  readonly river: string;
  readonly deepWater: string;
  readonly banks: string;
  readonly wetLine: string;
  readonly currents: string;
  readonly stones: string;
  readonly deck: string;
  readonly skirt: string;
  readonly planks: string;
  readonly gaps: string;
  readonly rails: string;
  readonly posts: string;
  readonly piles: string;
  readonly wear: string;
}

const bridgeArts = new Map<string, BridgeArt>();

/** Half-width of the water itself: a deck always overhangs its banks. */
function riverHalf(r: Rect): number {
  return Math.max(10, r.w / 2 - 12);
}

function buildBridgeArt(r: Rect): BridgeArt {
  const river = riverHalf(r);
  const x0 = r.x - r.w / 2;
  const x1 = r.x + r.w / 2;
  const y0 = r.y - r.h / 2;
  const y1 = r.y + r.h / 2;

  // The channel runs the whole depth of the field at this x, with banks that
  // wander so it reads as a cut river rather than a rectangle of water.
  const left: string[] = [];
  const right: string[] = [];
  for (let y = -20; y <= WORLD_H + 20; y += 28) {
    const wobble = Math.sin(y * 0.021) * 3.2 + Math.sin(y * 0.007 + 1.2) * 2.4;
    left.push(`${round1(r.x - river + wobble)} ${y}`);
    right.push(`${round1(r.x + river + wobble)} ${y}`);
  }
  right.reverse();
  const edge = left.concat(right);
  let riverD = `M${edge[0]}`;
  for (let i = 1; i < edge.length; i += 1) riverD += `L${edge[i]}`;
  riverD += 'Z';

  const bandAt = (offset: number): string => {
    const a = isoPoint(r.x + offset, -10);
    const b = isoPoint(r.x + offset, WORLD_H + 10);
    return `M${round1(a.x)} ${round1(a.y)}L${round1(b.x)} ${round1(b.y)}`;
  };

  let currents = '';
  for (let i = 0; i < 9; i += 1) {
    const x = r.x - river + 6 + i * ((river * 2 - 12) / 8);
    const a = isoPoint(x, -10);
    const b = isoPoint(x + Math.sin(i) * 3, WORLD_H + 10);
    currents += `M${round1(a.x)} ${round1(a.y)}L${round1(b.x)} ${round1(b.y)}`;
  }

  let stones = '';
  for (let i = 0; i < 26; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const x = r.x + side * (river + 2 + rand01(Math.round(r.x), i) * 6);
    const y = rand01(Math.round(r.y), i * 3 + 1) * WORLD_H;
    stones += ellipseD(x, y, 0.7 + rand01(i, 7) * 1.3, 0, 0.5);
  }

  // Deck: proud of the water, with a skirt so it reads as thick timber.
  const deck = liftedD(x0, y0, x1, y1, 4);
  const skirt = uprightD(x0, y1, x1, y1, 4) + uprightD(x0, y0, x0, y1, 4) + uprightD(x1, y0, x1, y1, 4);

  // Planks run across the water, so their seams run with the flow.
  let planks = '';
  for (let y = y0 + 4; y < y1; y += 6) {
    const a = isoPoint(x0, y);
    const b = isoPoint(x1, y);
    planks += `M${round1(a.x)} ${round1(a.y - 4)}L${round1(b.x)} ${round1(b.y - 4)}`;
  }
  let gaps = '';
  for (let i = 0; i < 2; i += 1) {
    const y = y0 + 8 + rand01(Math.round(r.x), i * 5 + 1) * (r.h - 22);
    gaps += liftedD(x0 + 4, y, x1 - 4, y + 4.5, 3.4);
  }

  // Hand rails on both edges: posts with two rails between them.
  let posts = '';
  let rails = '';
  for (let side = 0; side < 2; side += 1) {
    const ry = side === 0 ? y0 + 1.5 : y1 - 1.5;
    for (let x = x0 + 2; x <= x1 - 2; x += 12) {
      posts += uprightD(x, ry, x + 1.6, ry, 12);
    }
    const a = isoPoint(x0, ry);
    const b = isoPoint(x1, ry);
    rails += `M${round1(a.x)} ${round1(a.y - 12)}L${round1(b.x)} ${round1(b.y - 12)}`;
    rails += `M${round1(a.x)} ${round1(a.y - 7)}L${round1(b.x)} ${round1(b.y - 7)}`;
  }

  // Piles standing in the water at both ends of the span, sunk below the deck.
  let piles = '';
  for (let side = 0; side < 2; side += 1) {
    const px = side === 0 ? r.x - river + 3 : r.x + river - 3;
    for (let k = 0; k < 3; k += 1) {
      const py = y0 + 8 + k * ((r.h - 16) / 2);
      piles += uprightD(px, py, px + 2.6, py, 16, 2);
    }
  }

  // Traffic wear down the middle of the deck.
  let wear = '';
  for (let i = 0; i < 7; i += 1) {
    const y = y0 + 6 + rand01(Math.round(r.y) + 3, i) * (r.h - 12);
    const a = isoPoint(x0 + 6, y);
    wear += `M${round1(a.x)} ${round1(a.y - 4)}L${round1(a.x + 18)} ${round1(a.y - 4)}`;
  }

  return {
    river: riverD,
    deepWater: planeD(r.x - river, -20, r.x, WORLD_H + 20),
    banks: bandAt(-river - 9) + bandAt(river + 9) + bandAt(-river) + bandAt(river),
    wetLine: bandAt(-river) + bandAt(river),
    currents,
    stones,
    deck,
    skirt,
    planks,
    gaps,
    rails,
    posts,
    piles,
    wear,
  };
}

function bridgeArt(env: Environment, r: Rect): BridgeArt {
  const key = `${env}|${round1(r.x)},${round1(r.y)},${round1(r.w)},${round1(r.h)}`;
  const hit = bridgeArts.get(key);
  if (hit) return hit;
  const art = buildBridgeArt(r);
  if (bridgeArts.size > 16) bridgeArts.clear();
  bridgeArts.set(key, art);
  return art;
}

let waterCtx: CanvasRenderingContext2D | null = null;
let waterGradient: CanvasGradient | null = null;

/**
 * Sky reflection down the river. Built once: this pass has no camera transform
 * of its own, so the gradient is valid for every frame and every camera move.
 */
function waterFill(ctx: CanvasRenderingContext2D, look: FeatureLook): CanvasGradient {
  if (waterCtx !== ctx || !waterGradient) {
    const gradient = ctx.createLinearGradient(0, -200, 0, WORLD_H + 200);
    gradient.addColorStop(0, look.waterDeep);
    gradient.addColorStop(0.35, look.water);
    gradient.addColorStop(0.62, mix(look.water, look.waterSheen, 0.4));
    gradient.addColorStop(1, look.waterDeep);
    waterCtx = ctx;
    waterGradient = gradient;
  }
  return waterGradient;
}

/**
 * The water obstacle a span crosses: channel, depth shading, currents, muddy
 * banks, the wet line at the waterline and stones rolled into the mud.
 */
function drawRiver(
  ctx: CanvasRenderingContext2D,
  env: Environment,
  look: FeatureLook,
  r: Rect,
  time: number,
): void {
  if (riverHalf(r) <= 0 || r.h <= 0) return;
  const art = bridgeArt(env, r);

  ctx.fillStyle = waterFill(ctx, look);
  ctx.fill(pathOf(art.river));
  ctx.fillStyle = look.waterDeep;
  ctx.globalAlpha = 0.35;
  ctx.fill(pathOf(art.deepWater));
  ctx.globalAlpha = 0.24 + 0.06 * Math.sin(time * 1.3);
  ctx.strokeStyle = look.waterSheen;
  ctx.lineWidth = 1.1;
  // Barely moving, because the field's frame is a battlefield, not a river race.
  ctx.stroke(pathOf(art.currents));
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = look.earth;
  ctx.fill(pathOf(art.banks));
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = mix(look.earthDeep, '#000000', 0.25);
  ctx.lineWidth = 2.2;
  ctx.stroke(pathOf(art.wetLine));
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = mix(look.earthLight, '#ffffff', 0.15);
  ctx.fill(pathOf(art.stones));
  ctx.globalAlpha = 1;
}

/** The span itself: deck, rails, piles, wear, and the crowd at a full crossing. */
function drawSpan(
  ctx: CanvasRenderingContext2D,
  env: Environment,
  look: FeatureLook,
  r: Rect,
  capacity: number,
  occupants: { readonly player: number; readonly enemy: number },
  index: number,
): void {
  const x0 = r.x - r.w / 2;
  const x1 = r.x + r.w / 2;
  const y0 = r.y - r.h / 2;
  const y1 = r.y + r.h / 2;
  if (r.w <= 0 || r.h <= 0) return;
  const art = bridgeArt(env, r);

  // Skirt, deck, plank seams, missing planks, then traffic wear over the top.
  ctx.fillStyle = mix(look.timberDark, '#000000', 0.2);
  ctx.fill(pathOf(art.skirt));
  ctx.fillStyle = look.timber;
  ctx.fill(pathOf(art.deck));
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = mix(look.timberDark, '#000000', 0.15);
  ctx.lineWidth = 0.9;
  ctx.stroke(pathOf(art.planks));
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = mix(look.timberDark, '#000000', 0.4);
  ctx.fill(pathOf(art.gaps));
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = mix(look.timber, '#ffffff', 0.25);
  ctx.lineWidth = 1.4;
  ctx.stroke(pathOf(art.wear));
  ctx.globalAlpha = 1;

  // Piles stand in the water, then the railings above the deck.
  ctx.fillStyle = mix(look.timberDark, '#000000', 0.3);
  ctx.fill(pathOf(art.piles));
  ctx.fillStyle = look.timber;
  ctx.fill(pathOf(art.posts));
  ctx.strokeStyle = look.timberDark;
  ctx.lineWidth = 0.9;
  ctx.stroke(pathOf(art.posts));
  ctx.strokeStyle = mix(look.timber, '#ffffff', 0.14);
  ctx.lineWidth = 1.6;
  ctx.stroke(pathOf(art.rails));

  // Congestion. A span that is nearly full is the choke point of the sector, so
  // the ground either side of it is scribbled over with waiting, scraping boots —
  // the visual counterpart of the occupancy cap.
  const crowded: ('player' | 'enemy')[] = [];
  if (capacity > 0 && occupants.player >= capacity - 1) crowded.push('player');
  if (capacity > 0 && occupants.enemy >= capacity - 1) crowded.push('enemy');
  for (let i = 0; i < crowded.length; i += 1) {
    const side = crowded[i];
    ctx.fillStyle = SIDE_TINT[side];
    ctx.globalAlpha = 0.12;
    ctx.fill(pathOf(planeD(x0 - 46, y0, x0 - 4, y1) + planeD(x1 + 4, y0, x1 + 46, y1)));
    ctx.globalAlpha = 1;

    // Ground churned at both approaches, inside the band the span funnels into.
    let scuff = '';
    let churn = '';
    let steps = '';
    for (let k = 0; k < 22; k += 1) {
      const front = k % 2 === 0;
      const fx = front
        ? x0 - 44 + rand01(index + 61, k) * 40
        : x1 + 4 + rand01(index + 67, k) * 40;
      const fy = y0 + rand01(index + 71, k * 7) * r.h;
      const a = isoPoint(fx, fy);
      scuff += `M${round1(a.x)} ${round1(a.y)}L${round1(a.x + 5 + rand01(index, k + 9) * 5)} ${round1(a.y + 3)}`;
      churn += ellipseD(fx + 2, fy + 2, 1.1 + rand01(index + 1, k) * 1.3, 0, 1);
    }
    // Boot prints queued up to the span: what "at capacity" looks like on the ground.
    for (let k = 0; k < 9; k += 1) {
      const t = k / 9;
      const fx = x0 - 6 - t * 34;
      const fy = r.y - 6 + (k % 2 === 0 ? 0 : 3.4);
      steps += ellipseD(fx, fy, 1, 0, 0.6);
      steps += ellipseD(x1 + 6 + t * 34, fy + 1.6, 1, 0, 0.6);
    }
    ctx.strokeStyle = mix(look.earthDeep, '#000000', 0.35);
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.55;
    ctx.stroke(pathOf(scuff));
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = mix(look.earthDeep, '#000000', 0.45);
    ctx.fill(pathOf(churn));
    ctx.globalAlpha = 0.5;
    ctx.fill(pathOf(steps));
    ctx.globalAlpha = 1;
  }
}

// --- entry point ------------------------------------------------------------

/**
 * Paint every static ground feature. Rivers go down before everything else, so a
 * trench or belt that shares the crossing's x is never half-drowned by it; decks
 * go up last, because a bridge stands above the water it crosses.
 */
export function drawGroundFeatures(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  features: GroundFeaturesView,
): void {
  if (
    features.trenches.length === 0 &&
    features.minefields.length === 0 &&
    features.bridges.length === 0
  ) {
    return;
  }
  const env = view.environment;
  const look = featureLook(env);

  for (let i = 0; i < features.bridges.length; i += 1) {
    const bridge = features.bridges[i];
    drawRiver(ctx, env, look, { x: bridge.x, y: bridge.y, w: bridge.w, h: bridge.h }, view.time);
  }

  for (let i = 0; i < features.trenches.length; i += 1) {
    const trench = features.trenches[i];
    drawTrench(
      ctx,
      env,
      look,
      { x: trench.x, y: trench.y, w: trench.w, h: trench.h },
      trench.overrunBy,
      i,
    );
  }

  for (let i = 0; i < features.minefields.length; i += 1) {
    const belt = features.minefields[i];
    drawMinefield(
      ctx,
      env,
      look,
      { x: belt.x, y: belt.y, w: belt.w, h: belt.h },
      belt.armed,
      belt.mines,
      i,
    );
  }

  for (let i = 0; i < features.bridges.length; i += 1) {
    const bridge = features.bridges[i];
    drawSpan(
      ctx,
      env,
      look,
      { x: bridge.x, y: bridge.y, w: bridge.w, h: bridge.h },
      bridge.capacity,
      bridge.occupants,
      i,
    );
  }
}
