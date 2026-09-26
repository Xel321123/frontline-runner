/**
 * Isometric ground: the flat terrain pass.
 *
 * Layering contract
 * -----------------
 * `drawGround` is called with the camera transform **and** `applyIso(ctx)`
 * already applied, so everything in this module is authored in **world-plane
 * coordinates** (0..960 x, 0..560 y) and flat ground-plane art comes out
 * correctly projected. Nothing here may have height: a "vertical" line under the
 * iso basis is not vertical on screen, so posts, parapets, railings and any
 * other upright belong to `groundFeatures.ts`, which draws in projected px and
 * lifts a point off the plane itself. Both passes run once per frame, back to
 * front, before any upright entity is drawn, and the renderer paints a dark void
 * around the plane — so this pass must cover exactly the world plane and no more.
 *
 * How the ground is built
 * -----------------------
 * - The plane is covered by `TILE` x `TILE` tiles, swept in back-to-front order
 *   (increasing `tx + ty`) so a tile's texture composites over the tiles behind
 *   it and its own base colour over the texture of its neighbours behind it.
 * - Per-tile variation comes from one smooth two-octave value-noise field
 *   sampled at tile centres, so neighbouring tiles share lattice corners and the
 *   tone reads as continuous ground rather than as a checkerboard. A second
 *   field picks out "mown"/patch tones, and the wear of worn ground blends the
 *   tone toward dirt.
 * - Texture work (stones, tufts, drifts, clods, pebbles) is *batched* into a
 *   Path2D per tile, built once and cached: one fill can carry forty marks, so
 *   the visual detail is bounded by memory rather than by fill count. Detail
 *   tiers (LOD) follow the on-screen size of a tile, so a zoomed-out camera
 *   paints two fills per tile and a close camera four.
 * - Depth cues (a soft vignette darkening the far edges, a cool-to-warm split)
 *   are two big translucent fills using gradients built once per environment.
 *
 * `drawTile` is the single tile implementation; `drawGround` only walks the
 * plane and calls it.
 */

import type { Environment } from '../../data/campaignData';
import { environmentRules } from '../../game/environment';
import { TILE, WORLD_H, WORLD_W } from '../../game/constants';
import { mulberry32 } from '../../game/rng';
import { mix } from './common';
import type { TerrainTileOptions, WorldView } from './contracts';
import { TILES_X, TILES_Y } from './iso';
import { pathOf } from './paint';

const TAU = Math.PI * 2;
const TILE_HALF = TILE / 2;

/** LOD of the tile texture cache, and the ramp resolution of the tone table. */
const TONE_STEPS = 16;
const WEAR_STEPS = 4;

// --- deterministic noise ----------------------------------------------------

/**
 * 32-bit integer hash of a tile index. Avalanched hard enough that adjacent
 * tiles are uncorrelated, which is what stops the scatter reading as a pattern.
 */
function tileHash(seed: number, tx: number, ty: number): number {
  let h = (seed ^ Math.imul(tx, 0x9e3779b1) ^ Math.imul(ty, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/** Hash → [0, 1). */
function unit(hash: number): number {
  return hash / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function clampTo(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Bilinear value noise on a unit lattice. Sampling *between* lattice corners is
 * the whole point: two tiles that share a corner share its value, so the tone
 * field is continuous across tile borders while never visibly repeating.
 */
function lattice(seed: number, u: number, v: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = smoothstep(u - x0);
  const fy = smoothstep(v - y0);
  const a = unit(tileHash(seed, x0, y0));
  const b = unit(tileHash(seed, x0 + 1, y0));
  const c = unit(tileHash(seed, x0, y0 + 1));
  const d = unit(tileHash(seed, x0 + 1, y0 + 1));
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

/** Two octaves of value noise at a tile centre: broad tone plus fine breakup. */
function field(seed: number, tx: number, ty: number): number {
  const broad = lattice(seed, tx + 0.5, ty + 0.5);
  const fine = lattice(seed ^ 0x1d2f5b7d, tx * 2 + 0.5, ty * 2 + 0.5);
  return clampTo(broad * 0.68 + fine * 0.32, 0, 1);
}

interface TonePick {
  /** Ramp index, 0 (deepest) .. TONE_STEPS - 1 (crown). */
  readonly level: number;
  /** 1 when this tile is part of a mown/drier patch. */
  readonly worn: number;
}

/**
 * Which tone this tile takes. The patch field is smooth, so a "mown" patch is a
 * cluster of tiles that reads as a mown strip rather than as speckle.
 */
function tonePick(seed: number, tx: number, ty: number): TonePick {
  const base = field(seed, tx, ty);
  const patch = field(seed ^ 0x2f1b89a3, tx, ty);
  const level = Math.round((base + (patch - 0.5) * 0.34) * (TONE_STEPS - 1));
  return {
    level: Math.max(0, Math.min(TONE_STEPS - 1, level)),
    worn: patch > 0.62 ? 1 : 0,
  };
}

function wearBucket(wear: number): number {
  return Math.max(0, Math.min(WEAR_STEPS - 1, Math.floor(wear * WEAR_STEPS)));
}

// --- the five environment looks ---------------------------------------------

/**
 * A look is the whole art direction of one environment: the tone ladder, the
 * colours of the texture batches, how much texture there is, and the strength of
 * the depth cues. The scatter code is shared, so a season change is a palette
 * change plus a mark mix — the same rule the scene palette itself follows.
 */
interface Look {
  /** 16-step base tone ladder, deepest shadow → sunlit crown. */
  readonly ramp: readonly string[];
  /** Mown/drier variant of the ladder, for patch variation. */
  readonly rampWorn: readonly string[];
  /** Flattened tone table: [worn][wear][level]. */
  readonly tones: readonly string[];
  /** Marks that sit in the hollows — shade. */
  readonly shade: string;
  /** Marks on the crowns, where the light lands. */
  readonly light: string;
  /** Exposed earth, gravel or scoured stone. */
  readonly raw: string;
  /** Lighter earth, used for the field's bank and drifted material. */
  readonly rawLight: string;
  readonly track: string;
  readonly trackEdge: string;
  /** Marks per tile before the LOD gate. */
  readonly shadeMarks: number;
  readonly lightMarks: number;
  /** Chance a tile shows an exposed-earth patch. */
  readonly rawChance: number;
  /** Extra darkening at the far (south/east) rim. */
  readonly vignette: number;
  readonly cool: string;
  readonly warm: string;
  /** Bare earth the ground opens up to, for the feature pass to reuse. */
  readonly earth: string;
  readonly earthDark: string;
  readonly earthLight: string;
  /** The sky this environment has, so water in it reflects the right light. */
  readonly sky: string;
  readonly skyHaze: string;
}

interface LookSpec {
  readonly stops: readonly string[];
  readonly shade: string;
  readonly light: string;
  readonly raw: string;
  readonly rawLight: string;
  readonly track: string;
  readonly trackEdge: string;
  readonly shadeMarks: number;
  readonly lightMarks: number;
  readonly rawChance: number;
  readonly vignette: number;
  readonly cool: string;
  readonly warm: string;
}

/** Interpolate a stop list into a full ladder. */
function rampOf(stops: readonly string[], steps: number): string[] {
  const out: string[] = [];
  const last = stops.length - 1;
  for (let i = 0; i < steps; i += 1) {
    const t = (i / (steps - 1)) * last;
    const a = Math.min(last - 1, Math.floor(t));
    out.push(mix(stops[a], stops[a + 1], t - a));
  }
  return out;
}

/**
 * The tone table is precomputed because a tile's colour is picked every frame:
 * quantising to 16 tones x 4 wear levels x 2 ladders means no string is built
 * during the pass at all.
 */
function toneTable(
  ramp: readonly string[],
  rampWorn: readonly string[],
  track: string,
): readonly string[] {
  const table: string[] = [];
  for (let worn = 0; worn < 2; worn += 1) {
    const ladder = worn === 0 ? ramp : rampWorn;
    for (let w = 0; w < WEAR_STEPS; w += 1) {
      const blend = (w / (WEAR_STEPS - 1)) * 0.62;
      for (let level = 0; level < TONE_STEPS; level += 1) {
        table.push(mix(ladder[level], track, blend));
      }
    }
  }
  return table;
}

/** Multiply a hex colour's brightness, for the environment's ambient level. */
function scaleColour(colour: string, k: number): string {
  if (k === 1 || colour.charCodeAt(0) !== 35) return colour;
  const value = parseInt(colour.slice(1), 16);
  if (Number.isNaN(value)) return colour;
  const channel = (shift: number): string =>
    Math.max(0, Math.min(255, Math.round(((value >> shift) & 255) * k)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * How far this environment's ambient light moves the ground. The renderer lays
 * its own tint over the finished frame, so this leans on `ambient` gently:
 * applying it at full strength produces night ground that the tint then crushes
 * to flat black, and a snowfield that blows out.
 */
function ambientScale(env: Environment): number {
  return 0.55 + 0.45 * environmentRules(env).look.ambient;
}

function buildLook(env: Environment, spec: LookSpec): Look {
  const ambient = ambientScale(env);
  const sky = environmentRules(env).look;
  const ramp = rampOf(
    spec.stops.map((stop) => scaleColour(stop, ambient)),
    TONE_STEPS,
  );
  // Mown ground is shorter and drier: the same ladder pulled toward the raw
  // earth colour, which is the cue players read as "this was cut or grazed".
  const rampWorn = rampOf(
    spec.stops.map((stop) =>
      mix(scaleColour(stop, ambient), scaleColour(spec.rawLight, ambient), 0.3),
    ),
    TONE_STEPS,
  );
  return {
    ramp,
    rampWorn,
    tones: toneTable(ramp, rampWorn, scaleColour(spec.track, ambient)),
    shade: scaleColour(spec.shade, ambient),
    light: scaleColour(spec.light, ambient),
    raw: scaleColour(spec.raw, ambient),
    rawLight: scaleColour(spec.rawLight, ambient),
    track: scaleColour(spec.track, ambient),
    trackEdge: scaleColour(spec.trackEdge, ambient),
    shadeMarks: spec.shadeMarks,
    lightMarks: spec.lightMarks,
    rawChance: spec.rawChance,
    vignette: spec.vignette,
    cool: spec.cool,
    warm: spec.warm,
    earth: mix(scaleColour(spec.raw, ambient), scaleColour(spec.rawLight, ambient), 0.3),
    earthDark: ramp[1],
    earthLight: ramp[13],
    sky: sky.skyMid,
    skyHaze: sky.skyHorizon,
  };
}

/**
 * Temperate grass. Olive-khaki rather than emerald: the scene it sits under is a
 * muted 1940s palette, and the ground has to belong to the same photograph.
 */
const TEMPERATE: LookSpec = {
  stops: ['#2f3a1b', '#414d23', '#56632e', '#6c7a3c', '#87924e'],
  shade: '#37421d',
  light: '#93a05a',
  raw: '#6d5a3c',
  rawLight: '#8b7550',
  track: '#6b5637',
  trackEdge: '#836c47',
  shadeMarks: 22,
  lightMarks: 14,
  rawChance: 0.22,
  vignette: 0.3,
  cool: 'rgba(96, 112, 138, 0.09)',
  warm: 'rgba(158, 124, 68, 0.07)',
};

/** Snow: pale blue-white drifts, and almost no colour left in the light. */
const SNOW: LookSpec = {
  stops: ['#96a3b6', '#b0bccb', '#c9d2dd', '#dfe5ec', '#f4f7fa'],
  shade: '#9aa9c0',
  light: '#fdfeff',
  raw: '#8e9299',
  rawLight: '#a9adb3',
  track: '#bcc6d4',
  trackEdge: '#a3aebe',
  shadeMarks: 24,
  lightMarks: 18,
  // Gravel and dead grass poke through often enough that the field is never a
  // single unbroken white sheet.
  rawChance: 0.7,
  vignette: 0.2,
  cool: 'rgba(120, 146, 186, 0.1)',
  warm: 'rgba(210, 200, 190, 0.05)',
};

/** Desert: ochre and bleached sand, ripples from a single prevailing wind. */
const DESERT: LookSpec = {
  stops: ['#9c7c48', '#b08f57', '#c6a86e', '#d9bd86', '#eed9a6'],
  shade: '#a8874f',
  light: '#f0dda9',
  raw: '#cbb489',
  rawLight: '#e3d3ac',
  track: '#b3945f',
  trackEdge: '#c7a973',
  shadeMarks: 26,
  lightMarks: 16,
  rawChance: 0.3,
  vignette: 0.24,
  cool: 'rgba(108, 124, 152, 0.08)',
  warm: 'rgba(190, 146, 72, 0.1)',
};

/** Mud: dark churned brown, drowning in reflected sky. */
const MUD: LookSpec = {
  stops: ['#241c13', '#33281b', '#453626', '#574430', '#6b563d'],
  shade: '#1d160e',
  light: '#7d6748',
  raw: '#6f5a3c',
  rawLight: '#8a7250',
  track: '#33281b',
  trackEdge: '#4a3a28',
  shadeMarks: 26,
  lightMarks: 12,
  rawChance: 0.18,
  vignette: 0.34,
  cool: 'rgba(78, 96, 112, 0.1)',
  warm: 'rgba(96, 74, 44, 0.06)',
};

/**
 * Night re-lights the temperate ground: same shapes, a desaturated blue-grey
 * ladder, deep shadow in the hollows and moonlight on the crowns. It must read
 * as dark on its own — the renderer only tints the other four.
 */
const NIGHT: LookSpec = {
  stops: ['#0f131a', '#181e27', '#232b36', '#323c49', '#46525f'],
  shade: '#0a0d12',
  light: '#5c6776',
  raw: '#2c2b28',
  rawLight: '#3d3c37',
  track: '#2a2a24',
  trackEdge: '#38372e',
  shadeMarks: 24,
  lightMarks: 16,
  rawChance: 0.16,
  vignette: 0.4,
  cool: 'rgba(70, 96, 132, 0.1)',
  warm: 'rgba(60, 54, 40, 0.05)',
};

const LOOKS: Readonly<Record<Environment, Look>> = {
  standard: buildLook('standard', TEMPERATE),
  snow: buildLook('snow', SNOW),
  desert: buildLook('desert', DESERT),
  mud: buildLook('mud', MUD),
  night: buildLook('night', NIGHT),
};

/**
 * The colours the feature pass needs from the ground it sits on: bare earth, the
 * shade and the lit tone, and the sky the environment actually has. Exported so
 * trenches and rivers are painted from one colour table rather than a second one
 * that drifts out of step with this one.
 */
export interface GroundAnchors {
  readonly earth: string;
  readonly earthDark: string;
  readonly earthLight: string;
  readonly sky: string;
  readonly skyHaze: string;
}

export function groundAnchors(env: Environment): GroundAnchors {
  const look = LOOKS[env];
  return {
    earth: look.earth,
    earthDark: look.earthDark,
    earthLight: look.earthLight,
    sky: look.sky,
    skyHaze: look.skyHaze,
  };
}

/** Springy water, the only thing on the mud map that reflects the sky. */
const POOL = {
  soak: '#1a1510',
  kerb: '#3a2d1d',
  water: '#65767f',
  sheen: '#9fb2bb',
} as const;

/** Wind angles in the world plane, in degrees, shared by every drift. */
const WIND_DEG = -28;
const DUNE_DEG = 22;

// --- stamp shapes -----------------------------------------------------------

/**
 * Ground marks in world units, authored once as SVG path data and compiled
 * through `pathOf`, so a thousand tufts on screen cost one path compile. They
 * are deliberately low-point: at this scale a five-point blade of grass is not
 * distinguishable from a forty-point one, but it is a lot cheaper to stamp.
 */
const STAMP = {
  tuft: 'M0 0L-1.9 -4.2L-0.6 -0.9L-0.4 -5.1L0.5 -0.8L2.1 -3.9L0.8 0.5Z',
  blade: 'M0 0Q0.9 -2.6 2.6 -3.9Q1.6 -1.7 0.8 0.2Z',
  lens: 'M-4 0Q-2 -2.4 0 -2.4Q2 -2.4 4 0Q2 1.1 0 1.1Q-2 1.1 -4 0Z',
  ripple: 'M-9 0Q-4.5 -1.5 0 -1.5Q4.5 -1.5 9 0Q4.5 0.7 0 0.7Q-4.5 0.7 -9 0Z',
  stone: 'M-1.9 0.5L-0.8 -1.5L1.2 -1.1L2 0.3L0.5 1.4Z',
  clod: 'M-2.4 -0.7L-1.1 -2L1.3 -1.7L2.6 -0.2L1.5 1.5L-0.9 1.7Z',
  earth: 'M-6.4 -1.1L-3.2 -5.4L1.2 -6.2L5.4 -3.7L6.3 0.6L3.1 4.3L-2.2 4.7L-5.8 2.1Z',
  crack: 'M-8 0L-4 1.3L0 0.3L4 1.6L8 0.6L8 1.1L4 2.2L0 1L-4 2.1L-8 0.6Z',
  sparkle: 'M0 -2.6L0.55 -0.55L2.6 0L0.55 0.55L0 2.6L-0.55 0.55L-2.6 0L-0.55 -0.55Z',
  hole: 'M-1.7 0L-1 -1.6L1 -1.7L1.8 0L1 1.5L-1 1.4Z',
} as const;

function stamp(
  batch: Path2D,
  d: string,
  x: number,
  y: number,
  scale: number,
  degrees: number,
): void {
  const m = new DOMMatrix();
  m.translateSelf(x, y);
  if (degrees !== 0) m.rotateSelf(degrees);
  if (scale !== 1) m.scaleSelf(scale, scale);
  batch.addPath(pathOf(d), m);
}

function dotAt(batch: Path2D, s: Scatter, spread: number, radius: number): void {
  dot(batch, s.cx + (s.rng() * 2 - 1) * spread, s.cy + (s.rng() * 2 - 1) * spread, radius);
}

function dot(batch: Path2D, x: number, y: number, radius: number): void {
  batch.moveTo(x + radius, y);
  batch.arc(x, y, radius, 0, TAU);
}

interface Scatter {
  readonly shade: Path2D;
  readonly light: Path2D;
  readonly raw: Path2D;
  readonly rng: () => number;
  readonly cx: number;
  readonly cy: number;
  readonly shades: number;
  readonly lights: number;
  /** How many marks landed in the raw batch. */
  rawMarks: number;
}

function place(
  batch: Path2D,
  d: string,
  s: Scatter,
  spread: number,
  scale: number,
  degrees: number,
): void {
  stamp(
    batch,
    d,
    s.cx + (s.rng() * 2 - 1) * spread,
    s.cy + (s.rng() * 2 - 1) * spread,
    scale,
    degrees,
  );
}

// --- per-environment texture ------------------------------------------------

/**
 * Temperate scatter. Grass clumps are the body of the texture; stones and the
 * dark hollows between clumps stop it reading as a uniform fuzz. Night shares
 * this pass entirely — only its palette differs.
 */
function scatterTemperate(s: Scatter, glints: boolean): void {
  for (let i = 0; i < s.shades; i += 1) {
    const pick = s.rng();
    if (pick < 0.46) {
      place(s.shade, STAMP.tuft, s, TILE_HALF - 3, 0.7 + s.rng() * 0.7, s.rng() * 360);
    } else if (pick < 0.7) {
      place(s.shade, STAMP.stone, s, TILE_HALF - 4, 0.6 + s.rng() * 0.8, s.rng() * 360);
      dotAt(s.shade, s, TILE_HALF - 4, 0.6);
    } else if (pick < 0.88) {
      place(s.shade, STAMP.lens, s, TILE_HALF - 6, 1.6 + s.rng() * 1.5, s.rng() * 180);
    } else {
      place(s.shade, STAMP.blade, s, TILE_HALF - 3, 0.8 + s.rng() * 0.6, 90 + s.rng() * 180);
    }
  }
  for (let i = 0; i < s.lights; i += 1) {
    const pick = s.rng();
    if (pick < 0.55) {
      place(s.light, STAMP.blade, s, TILE_HALF - 3, 0.9 + s.rng() * 0.7, s.rng() * 360);
    } else if (pick < 0.86) {
      // A wide, flat highlight: the mown streak the tone ladder already hints at.
      place(s.light, STAMP.lens, s, TILE_HALF - 5, 1.8 + s.rng() * 1.4, s.rng() * 180);
    } else {
      place(s.light, STAMP.tuft, s, TILE_HALF - 4, 0.55 + s.rng() * 0.4, s.rng() * 360);
    }
  }
  if (glints) {
    // Dew and wet stone catching the moon: two or three points per tile is
    // enough to say "it is night and the light is coming from one direction".
    for (let i = 0; i < 3; i += 1) {
      place(s.light, STAMP.sparkle, s, TILE_HALF - 6, 0.3 + s.rng() * 0.3, 0);
    }
  }
}

/** Snow: drifts laid along one wind, with hollows on their lee side. */
function scatterSnow(s: Scatter): void {
  for (let i = 0; i < s.shades; i += 1) {
    const pick = s.rng();
    if (pick < 0.62) {
      place(s.shade, STAMP.lens, s, TILE_HALF - 4, 1.9 + s.rng() * 1.5, WIND_DEG + s.rng() * 16 - 8);
    } else if (pick < 0.86) {
      place(s.shade, STAMP.ripple, s, TILE_HALF - 3, 0.75 + s.rng() * 0.5, WIND_DEG + s.rng() * 10 - 5);
    } else {
      dotAt(s.shade, s, TILE_HALF - 5, 1 + s.rng() * 1.6);
    }
  }
  for (let i = 0; i < s.lights; i += 1) {
    const pick = s.rng();
    if (pick < 0.7) {
      // One step off the hollow, so each drift has a lit side and a shaded side.
      place(s.light, STAMP.lens, s, TILE_HALF - 5, 1.6 + s.rng() * 1.4, WIND_DEG + s.rng() * 12 - 6);
    } else if (pick < 0.9) {
      place(s.light, STAMP.tuft, s, TILE_HALF - 5, 0.5 + s.rng() * 0.4, s.rng() * 360);
    } else {
      place(s.light, STAMP.sparkle, s, TILE_HALF - 6, 0.3 + s.rng() * 0.35, 0);
    }
  }
}

/** Desert: ripples, gravel fields and a thin scatter of bleached grit. */
function scatterDesert(s: Scatter): void {
  for (let i = 0; i < s.shades; i += 1) {
    const pick = s.rng();
    if (pick < 0.5) {
      place(s.shade, STAMP.ripple, s, TILE_HALF - 2, 0.8 + s.rng() * 0.6, DUNE_DEG + s.rng() * 12 - 6);
    } else if (pick < 0.78) {
      dotAt(s.shade, s, TILE_HALF - 4, 0.5 + s.rng() * 0.8);
    } else {
      place(s.shade, STAMP.stone, s, TILE_HALF - 4, 0.45 + s.rng() * 0.5, s.rng() * 360);
    }
  }
  for (let i = 0; i < s.lights; i += 1) {
    const pick = s.rng();
    if (pick < 0.72) {
      place(s.light, STAMP.ripple, s, TILE_HALF - 3, 0.7 + s.rng() * 0.5, DUNE_DEG + s.rng() * 12 - 6);
    } else {
      place(s.light, STAMP.lens, s, TILE_HALF - 6, 1.4 + s.rng() * 1.2, DUNE_DEG + s.rng() * 20);
    }
  }
}

/** Mud: clods, boot holes and the deep shine where water stands in the ruts. */
function scatterMud(s: Scatter): void {
  for (let i = 0; i < s.shades; i += 1) {
    const pick = s.rng();
    if (pick < 0.4) {
      dotAt(s.shade, s, TILE_HALF - 2, 0.5 + s.rng() * 1.1);
    } else if (pick < 0.72) {
      place(s.shade, STAMP.clod, s, TILE_HALF - 4, 0.6 + s.rng() * 0.8, s.rng() * 360);
    } else {
      place(s.shade, STAMP.hole, s, TILE_HALF - 3, 0.6 + s.rng() * 0.7, s.rng() * 360);
    }
  }
  for (let i = 0; i < s.lights; i += 1) {
    if (s.rng() < 0.6) {
      place(s.light, STAMP.clod, s, TILE_HALF - 5, 0.4 + s.rng() * 0.5, s.rng() * 360);
    } else {
      place(s.light, STAMP.lens, s, TILE_HALF - 5, 1.2 + s.rng() * 1.1, s.rng() * 180);
    }
  }
}

/** Exposed ground the boots, the wind or the sun has opened up. */
function addRaw(env: Environment, s: Scatter): number {
  switch (env) {
    case 'snow': {
      place(s.raw, STAMP.earth, s, TILE_HALF - 7, 0.5 + s.rng() * 0.7, s.rng() * 360);
      for (let i = 0; i < 3; i += 1) {
        // Dead grass standing through the snow is the cue that this is a field
        // under snow rather than a plain white surface.
        place(s.raw, STAMP.blade, s, TILE_HALF - 4, 0.5 + s.rng() * 0.5, s.rng() * 360);
      }
      return 4;
    }
    case 'desert': {
      place(s.raw, STAMP.crack, s, TILE_HALF - 5, 0.7 + s.rng() * 0.7, DUNE_DEG + s.rng() * 40);
      place(s.raw, STAMP.crack, s, TILE_HALF - 5, 0.5 + s.rng() * 0.5, DUNE_DEG + 90 + s.rng() * 40);
      for (let i = 0; i < 4; i += 1) dotAt(s.raw, s, TILE_HALF - 3, 0.4 + s.rng() * 0.7);
      return 6;
    }
    case 'mud': {
      place(s.raw, STAMP.earth, s, TILE_HALF - 7, 0.6 + s.rng() * 0.7, s.rng() * 360);
      for (let i = 0; i < 3; i += 1) dotAt(s.raw, s, TILE_HALF - 3, 0.6 + s.rng() * 0.9);
      return 4;
    }
    default: {
      place(s.raw, STAMP.earth, s, TILE_HALF - 7, 0.55 + s.rng() * 0.75, s.rng() * 360);
      for (let i = 0; i < 3; i += 1) dotAt(s.raw, s, TILE_HALF - 5, 0.5 + s.rng() * 0.6);
      return 4;
    }
  }
}

// --- tile texture cache -----------------------------------------------------

interface TileTexture {
  readonly shade: Path2D;
  readonly light: Path2D;
  readonly raw: Path2D;
  readonly rawMarks: number;
}

/** Built on first use: a module-level `new Path2D()` would break a DOM-free import. */
let emptyTexture: TileTexture | null = null;

function noTexture(): TileTexture {
  if (!emptyTexture) {
    emptyTexture = { shade: new Path2D(), light: new Path2D(), raw: new Path2D(), rawMarks: 0 };
  }
  return emptyTexture;
}

const textures = new Map<string, TileTexture>();

/** Seed of the level being drawn; `drawTile` can also be called standalone. */
let currentSeed = 0x5f1b2c3d;

/**
 * Texture for one tile, built once and kept: the marks are a pure function of
 * (environment, seed, tile, LOD), so a frame that does not change the camera
 * rebuilds nothing. The cache is cleared wholesale rather than evicted one by
 * one — a level change makes every entry worthless at the same moment.
 */
function textureFor(
  env: Environment,
  tx: number,
  ty: number,
  lod: number,
  worn: number,
  churned: boolean,
): TileTexture {
  if (lod === 0) return noTexture();
  const key = `${env}|${currentSeed}|${tx}|${ty}|${lod}|${worn}|${churned ? 1 : 0}`;
  const hit = textures.get(key);
  if (hit) return hit;

  const look = LOOKS[env];
  const rng = mulberry32((tileHash(currentSeed, tx, ty) ^ 0x51ed270b) >>> 0);
  const s: Scatter = {
    shade: new Path2D(),
    light: new Path2D(),
    raw: new Path2D(),
    rng,
    cx: tx * TILE + TILE_HALF,
    cy: ty * TILE + TILE_HALF,
    shades: marksFor(look.shadeMarks, lod),
    lights: marksFor(look.lightMarks, lod),
    rawMarks: 0,
  };

  switch (env) {
    case 'snow':
      scatterSnow(s);
      break;
    case 'desert':
      scatterDesert(s);
      break;
    case 'mud':
      scatterMud(s);
      break;
    default:
      // Night is the temperate ground re-lit, exactly as the scene palette does
      // for sky and hills, so the two share one scatter pass.
      scatterTemperate(s, env === 'night');
      break;
  }

  // Worn tiles and tiles beside the track show more bare earth: the ground only
  // opens up where something has been walking.
  const rawChance = look.rawChance + (worn ? 0.18 : 0) + (churned ? 0.25 : 0);
  if (rng() < rawChance) s.rawMarks = addRaw(env, s);

  const texture: TileTexture = { shade: s.shade, light: s.light, raw: s.raw, rawMarks: s.rawMarks };
  if (textures.size > 6000) textures.clear();
  textures.set(key, texture);
  return texture;
}

function marksFor(base: number, lod: number): number {
  const scale = lod >= 3 ? 1 : lod >= 2 ? 0.72 : 0.45;
  return Math.max(2, Math.round(base * scale));
}

// --- the worn track ---------------------------------------------------------

interface Spur {
  /** Start on the lane centreline, in world units. */
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly cx: number;
  readonly cy: number;
}

interface Lane {
  readonly phase: number;
  readonly half: number;
  readonly spurs: readonly Spur[];
}

/**
 * The corridor the road runs along. `y ≈ 280` is mid-depth, which is where the
 * fighting is, so the worn ground also reads as the place the armies have been
 * walking: two spurs branch off toward each rear area for exactly that reason.
 */
function laneY(x: number, phase: number): number {
  return 280 + Math.sin(x * 0.0075 + phase) * 16 + Math.sin(x * 0.019 + 1.7) * 5;
}

function laneGeometry(seed: number): Lane {
  const phase = unit(tileHash(seed, 7, 11)) * TAU;
  const half = 32;
  const rear = 168;
  const playerX = Math.min(320, WORLD_W * 0.33);
  const enemyX = Math.max(660, WORLD_W * 0.67);
  const p0 = laneY(34, phase);
  const e0 = laneY(WORLD_W - 34, phase);
  return {
    phase,
    half,
    spurs: [
      {
        ax: playerX,
        ay: laneY(playerX, phase),
        bx: 150,
        by: rear,
        cx: playerX * 0.5,
        cy: rear + (p0 - rear) * 0.35,
      },
      {
        ax: enemyX,
        ay: laneY(enemyX, phase),
        bx: 810,
        by: rear,
        cx: enemyX + (810 - enemyX) * 0.5,
        cy: rear + (e0 - rear) * 0.35,
      },
    ],
  };
}

/** Roughly how worn the ground is here: 1 on the lane, fading over the verges. */
function wearAt(x: number, y: number, lane: Lane): number {
  let wear = 1 - Math.min(1, Math.abs(y - laneY(x, lane.phase)) / (lane.half + 44));
  for (let i = 0; i < lane.spurs.length; i += 1) {
    const spur = lane.spurs[i];
    let best = Infinity;
    for (let t = 0; t <= 4; t += 1) {
      const k = t / 4;
      const inv = 1 - k;
      const px = inv * inv * spur.ax + 2 * inv * k * spur.cx + k * k * spur.bx;
      const py = inv * inv * spur.ay + 2 * inv * k * spur.cy + k * k * spur.by;
      const d = Math.hypot(px - x, py - y);
      if (d < best) best = d;
    }
    wear = Math.max(wear, 1 - Math.min(1, best / 46));
  }
  return clampTo(wear, 0, 1);
}

interface LaneArt {
  readonly verge: string;
  readonly band: string;
  readonly ruts: string;
  readonly holes: string;
  readonly scuffs: string;
  readonly spurs: string;
  readonly drift: string;
}

const laneArts = new Map<string, LaneArt>();

/** A closed band following the lane, `offset` world units off the centreline. */
function laneBand(
  lane: Lane,
  halfWidth: number,
  offset: number,
  step = 24,
): string {
  const top: string[] = [];
  const bottom: string[] = [];
  for (let x = -30; x <= WORLD_W + 30; x += step) {
    const y = laneY(x, lane.phase) + offset;
    top.push(`${Math.round(x)} ${Math.round(y - halfWidth)}`);
    bottom.push(`${Math.round(x)} ${Math.round(y + halfWidth)}`);
  }
  bottom.reverse();
  const points = top.concat(bottom).map((pair) => pair.split(' '));
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i += 1) d += `L${points[i][0]} ${points[i][1]}`;
  return `${d}Z`;
}

/** A broken band: the same profile, but drawn in dashes so it can be drifted over. */
function laneDashes(lane: Lane, halfWidth: number, offset: number, length: number): string {
  let d = '';
  for (let x = -20; x < WORLD_W + 20; x += 96) {
    const y = laneY(x, lane.phase) + offset;
    d += `M${Math.round(x)} ${Math.round(y - halfWidth)}L${Math.round(x + length)} ${Math.round(y - halfWidth)}`;
    d += `L${Math.round(x + length)} ${Math.round(y + halfWidth)}L${Math.round(x)} ${Math.round(y + halfWidth)}Z`;
  }
  return d;
}

function laneScatter(lane: Lane, seed: number, spread: number, radius: number, count: number): string {
  const rng = mulberry32((tileHash(seed, 991, 401) ^ 0x2b7f13c5) >>> 0);
  let d = '';
  for (let i = 0; i < count; i += 1) {
    const x = rng() * WORLD_W;
    const y = laneY(x, lane.phase) + (rng() * 2 - 1) * spread;
    // Two half arcs, not one full arc: SVG (and so Path2D) drops an elliptical
    // arc whose ends coincide, which would silently erase every speck here.
    const r = radius * (0.5 + rng());
    const rr = Math.round(r * 10) / 10;
    d += `M${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
    d += `m${rr} 0a${rr} ${rr} 0 0 0 ${-2 * rr} 0a${rr} ${rr} 0 0 0 ${2 * rr} 0Z`;
  }
  return d;
}

function laneArt(env: Environment, seed: number, lane: Lane): LaneArt {
  const key = `${env}|${seed}`;
  const hit = laneArts.get(key);
  if (hit) return hit;

  const wide = env === 'mud' ? 22 : env === 'desert' ? 17 : 18;
  const rutOffset = wide * 0.55;
  const rutHalf = env === 'mud' ? 2.8 : 1.9;

  const spurs = lane.spurs
    .map((spur) => {
      // A quadratic strip along the spur: the road to each rear area is a
      // narrower, fainter version of the lane itself.
      const samples: string[] = [];
      const back: string[] = [];
      for (let t = 0; t <= 6; t += 1) {
        const k = t / 6;
        const inv = 1 - k;
        const x = inv * inv * spur.ax + 2 * inv * k * spur.cx + k * k * spur.bx;
        const y = inv * inv * spur.ay + 2 * inv * k * spur.cy + k * k * spur.by;
        const w = 7 + (1 - k) * 5;
        samples.push(`${Math.round(x)} ${Math.round(y - w)}`);
        back.push(`${Math.round(x)} ${Math.round(y + w)}`);
      }
      back.reverse();
      const all = samples.concat(back).map((pair) => pair.split(' '));
      let d = `M${all[0][0]} ${all[0][1]}`;
      for (let i = 1; i < all.length; i += 1) d += `L${all[i][0]} ${all[i][1]}`;
      return `${d}Z`;
    })
    .join('');

  const art: LaneArt = {
    verge: laneBand(lane, wide + 13, 0, 40),
    band: laneBand(lane, wide, 0),
    ruts: laneBand(lane, rutHalf, -rutOffset) + laneBand(lane, rutHalf, rutOffset),
    holes: laneScatter(lane, seed, 12, 3.4, 26),
    scuffs: laneScatter(lane, seed ^ 0x77c1, wide + 9, 2.6, 30),
    spurs,
    drift: laneDashes(lane, wide, 0, env === 'snow' ? 46 : 58),
  };
  if (laneArts.size > 24) laneArts.clear();
  laneArts.set(key, art);
  return art;
}

// --- pools (mud only) -------------------------------------------------------

interface PoolArt {
  readonly soak: string;
  readonly kerb: string;
  readonly water: string;
  readonly sheen: string;
}

const poolArts = new Map<number, PoolArt>();

/** An organic closed blob: a circle of radius `r` with noise wobbled onto it. */
function blob(rng: () => number, cx: number, cy: number, r: number, wobble: number): string {
  const steps = 12;
  const outer: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * TAU;
    const wob = 1 + (rng() * 2 - 1) * wobble;
    outer.push(`${Math.round((cx + Math.cos(angle) * r * wob) * 10) / 10} ${Math.round((cy + Math.sin(angle) * r * wob) * 10) / 10}`);
  }
  // Start mid-edge so the closing line does not always sit on the same vertex.
  let d = `M${outer[0]}`;
  for (let i = 1; i < outer.length; i += 1) d += `L${outer[i]}`;
  return `${d}Z`;
}

/**
 * Standing water on the mud map: four nested shapes (soak, bank, water, sheen)
 * rather than a single ellipse, because the soft edge is what sells it as water
 * lying in the ground rather than a blue shape painted onto it.
 */
function poolArt(seed: number): PoolArt {
  const hit = poolArts.get(seed);
  if (hit) return hit;
  const rng = mulberry32((tileHash(seed, 313, 517) ^ 0x31a5d0f1) >>> 0);
  let soak = '';
  let kerb = '';
  let water = '';
  let sheen = '';
  for (let i = 0; i < 5; i += 1) {
    const cx = 90 + rng() * (WORLD_W - 180);
    const cy = 110 + rng() * (WORLD_H - 220);
    const r = 9 + rng() * 12;
    soak += blob(rng, cx, cy, r * 1.5, 0.22);
    kerb += blob(rng, cx, cy, r * 1.16, 0.2);
    water += blob(rng, cx, cy, r, 0.18);
    // The sheen sits on the far side of each pool, where the sky is seen.
    sheen += blob(rng, cx - r * 0.3, cy - r * 0.28, r * 0.45, 0.3);
  }
  const art: PoolArt = { soak, kerb, water, sheen };
  if (poolArts.size > 8) poolArts.clear();
  poolArts.set(seed, art);
  return art;
}

// --- frame composition ------------------------------------------------------

/** Detail tiers by the on-screen size of a tile, in device px. */
function lodOf(size: number): number {
  if (size >= 84) return 3;
  if (size >= 46) return 2;
  if (size >= 24) return 1;
  return 0;
}

/**
 * The camera is a plain scale and translate, so the matrix's x axis gives the
 * current px per world unit (device px included) — the only way to know how much
 * detail a tile can carry without the renderer passing a zoom in `WorldView`.
 */
function tileScreenSize(ctx: CanvasRenderingContext2D): number {
  // Guarded because the pass also runs under test doubles and headless canvas
  // shims that implement only the drawing surface.
  if (typeof ctx.getTransform !== 'function') return TILE;
  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b);
  return TILE * (scale > 0 ? scale : 1);
}

/** The plane's own bank along its two front (screen-bottom) edges. */
function drawBank(
  ctx: CanvasRenderingContext2D,
  look: Look,
  x0: number,
  y0: number,
  w: number,
  h: number,
  south: boolean,
  east: boolean,
): void {
  const lip = 5;
  ctx.fillStyle = look.rawLight;
  if (south) ctx.fillRect(x0, y0 + h - lip, w, lip);
  if (east) ctx.fillRect(x0 + w - lip, y0, lip, h);
  ctx.fillStyle = look.ramp[2];
  if (south) ctx.fillRect(x0, y0 + h - 1.4, w, 1.4);
  if (east) ctx.fillRect(x0 + w - 1.4, y0, 1.4, h);
}

function drawLane(
  ctx: CanvasRenderingContext2D,
  env: Environment,
  look: Look,
  seed: number,
  lane: Lane,
  lod: number,
): void {
  const art = laneArt(env, seed, lane);
  if (lod >= 1) {
    // The verge first: ground trampled wide of the road, then the road itself.
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = look.raw;
    ctx.fill(pathOf(art.verge));
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = look.track;
  ctx.globalAlpha = env === 'snow' ? 0.55 : 0.9;
  ctx.fill(pathOf(art.band));
  ctx.globalAlpha = 1;

  if (env === 'desert' && lod >= 2) {
    // Sand blows across the road: the tyre tracks only show through in patches,
    // which is exactly how a desert track reads in a photograph.
    ctx.fillStyle = look.ramp[11];
    ctx.globalAlpha = 0.75;
    ctx.fill(pathOf(art.drift));
    ctx.globalAlpha = 1;
  }
  if (env === 'snow' && lod >= 1) {
    ctx.fillStyle = look.ramp[13];
    ctx.globalAlpha = 0.4;
    ctx.fill(pathOf(art.drift));
    ctx.globalAlpha = 1;
  }

  // The ruts. Cart wheels in the temperate and night looks, tyres in the desert,
  // deep and water-filled in the mud.
  ctx.fillStyle = env === 'mud' ? look.ramp[1] : mix(look.track, '#141009', 0.4);
  ctx.globalAlpha = env === 'mud' ? 0.9 : 0.6;
  ctx.fill(pathOf(art.ruts));
  ctx.globalAlpha = 1;

  if (lod >= 1) {
    ctx.fillStyle = look.trackEdge;
    ctx.fill(pathOf(art.scuffs));
  }
  if (lod >= 2) {
    // Potholes and stones kicked out of the road.
    ctx.fillStyle = mix(look.track, '#100c07', 0.5);
    ctx.fill(pathOf(art.holes));
    ctx.fillStyle = look.rawLight;
    ctx.fill(pathOf(art.spurs));
  }
}

function drawPools(ctx: CanvasRenderingContext2D, seed: number): void {
  const art = poolArt(seed);
  ctx.fillStyle = POOL.soak;
  ctx.globalAlpha = 0.5;
  ctx.fill(pathOf(art.soak));
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = POOL.kerb;
  ctx.fill(pathOf(art.kerb));
  ctx.globalAlpha = 1;
  ctx.fillStyle = POOL.water;
  ctx.fill(pathOf(art.water));
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = POOL.sheen;
  ctx.fill(pathOf(art.sheen));
  ctx.globalAlpha = 1;
}

interface Overlays {
  readonly vignette: CanvasGradient;
  readonly split: CanvasGradient;
}

let overlayCtx: CanvasRenderingContext2D | null = null;
let overlayEnv: Environment | null = null;
let overlayValue: Overlays | null = null;

/**
 * The two depth cues, built once per environment. Canvas gradients are resolved
 * in the user space at *paint* time, so a gradient built in world-plane
 * coordinates stays correct as the camera pans — which is what makes caching it
 * legitimate rather than a bug waiting for the first camera move.
 */
function overlays(ctx: CanvasRenderingContext2D, env: Environment, look: Look): Overlays {
  if (overlayCtx === ctx && overlayEnv === env && overlayValue) return overlayValue;
  const vignette = ctx.createRadialGradient(
    WORLD_W * 0.18,
    WORLD_H * 0.1,
    240,
    WORLD_W * 0.18,
    WORLD_H * 0.1,
    1080,
  );
  vignette.addColorStop(0, 'rgba(8, 9, 12, 0)');
  vignette.addColorStop(0.5, 'rgba(8, 9, 12, 0)');
  vignette.addColorStop(1, `rgba(8, 9, 12, ${look.vignette.toFixed(3)})`);

  // Far ground is cool and hazy, near ground is warm: the oldest trick in
  // landscape painting, and it is what stops a tiled plane reading as flat.
  const split = ctx.createLinearGradient(0, 0, WORLD_W, WORLD_H);
  split.addColorStop(0, look.cool);
  split.addColorStop(0.55, 'rgba(0, 0, 0, 0)');
  split.addColorStop(1, look.warm);

  overlayCtx = ctx;
  overlayEnv = env;
  overlayValue = { vignette, split };
  return overlayValue;
}

// --- public API -------------------------------------------------------------

/**
 * One tile of ground, in world-plane coordinates. The caller must have applied
 * `applyIso` (as `drawGround` has). `cx`/`cy`/`size` are the tile's centre and
 * side in projected px and are used only to pick the detail tier — the art is
 * placed from `tx`/`ty` so it stays exactly on the plane.
 */
export function drawTile(ctx: CanvasRenderingContext2D, o: TerrainTileOptions): void {
  const look = LOOKS[o.environment];
  const x0 = o.tx * TILE;
  const y0 = o.ty * TILE;
  const w = Math.min(TILE, WORLD_W - x0);
  const h = Math.min(TILE, WORLD_H - y0);
  if (w <= 0 || h <= 0) return;

  const pick = tonePick(currentSeed, o.tx, o.ty);
  const wear = wearBucket(o.wear);
  ctx.fillStyle = look.tones[(pick.worn * WEAR_STEPS + wear) * TONE_STEPS + pick.level];
  ctx.fillRect(x0, y0, w, h);

  const lod = lodOf(o.size);
  const texture = textureFor(o.environment, o.tx, o.ty, lod, pick.worn, o.wear > 0.55);
  if (lod >= 1) {
    ctx.fillStyle = look.shade;
    ctx.fill(texture.shade);
  }
  if (lod >= 2) {
    ctx.fillStyle = look.light;
    ctx.fill(texture.light);
    if (texture.rawMarks > 0) {
      ctx.fillStyle = look.raw;
      ctx.fill(texture.raw);
    }
  }

  if (lod >= 1 && (o.edge === 'south' || o.edge === 'east' || o.edge === 'corner')) {
    drawBank(ctx, look, x0, y0, w, h, o.edge !== 'east', o.edge !== 'south');
  }
}

/** Reused across tiles so the pass allocates nothing in the loop. */
const tileOptions: { -readonly [K in keyof TerrainTileOptions]: TerrainTileOptions[K] } = {
  x: 0,
  y: 0,
  scale: 1,
  time: 0,
  environment: 'standard',
  tx: 0,
  ty: 0,
  cx: 0,
  cy: 0,
  size: TILE,
  variant: 0,
  wear: 0,
  edge: 'inner',
};

function edgeFor(tx: number, ty: number): TerrainTileOptions['edge'] {
  const south = ty === TILES_Y - 1;
  const east = tx === TILES_X - 1;
  if (south && east) return 'corner';
  if (south) return 'south';
  if (east) return 'east';
  if (tx === 0) return 'west';
  if (ty === 0) return 'north';
  return 'inner';
}

/**
 * Paint the whole ground plane. Under `applyIso`, so world-plane coordinates;
 * tiles are swept in increasing `tx + ty` so each tile's base colour lands over
 * the texture of the tiles behind it and under the texture of the tiles in front.
 */
export function drawGround(ctx: CanvasRenderingContext2D, view: WorldView): void {
  if (view.maxX <= view.minX || view.maxY <= view.minY) return;
  const env = view.environment;
  const look = LOOKS[env];
  currentSeed = view.seed >>> 0;
  const lane = laneGeometry(currentSeed);
  const size = tileScreenSize(ctx);
  const lod = lodOf(size);

  // One tile of margin so detail that bleeds over a border is not cut off, then
  // clamped to the plane — clipped below so nothing can be painted into the void.
  const tx0 = Math.max(0, Math.floor(view.minX / TILE) - 1);
  const tx1 = Math.min(TILES_X - 1, Math.floor(view.maxX / TILE) + 1);
  const ty0 = Math.max(0, Math.floor(view.minY / TILE) - 1);
  const ty1 = Math.min(TILES_Y - 1, Math.floor(view.maxY / TILE) + 1);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, WORLD_W, WORLD_H);
  ctx.clip();

  // A single wash of the middle tone first: one fill that guarantees the plane
  // is opaque even if a tile is skipped by the view rect.
  ctx.fillStyle = look.ramp[8];
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  tileOptions.environment = env;
  tileOptions.time = view.time;
  // `size` is what `drawTile` budgets detail from: a tile 40 px across can carry
  // far less texture than one 90 px across, and the camera is the only thing
  // that decides which of those it is.
  tileOptions.size = size;
  tileOptions.scale = size / TILE;
  const base = tx0 + ty0;
  const end = tx1 + ty1;
  for (let s = base; s <= end; s += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) {
      const ty = s - tx;
      if (ty < ty0 || ty > ty1) continue;
      tileOptions.tx = tx;
      tileOptions.ty = ty;
      tileOptions.variant = unit(tileHash(currentSeed, tx, ty + 4096));
      tileOptions.wear = wearAt(tx * TILE + TILE_HALF, ty * TILE + TILE_HALF, lane);
      tileOptions.edge = edgeFor(tx, ty);
      drawTile(ctx, tileOptions);
    }
  }

  // The worn corridor crosses tile borders, so it is painted over the tiles as
  // one piece rather than per tile — a road made of per-tile segments reads as a
  // dotted line, however carefully each segment is drawn.
  drawLane(ctx, env, look, currentSeed, lane, lod);

  if (env === 'mud' && lod >= 2) drawPools(ctx, currentSeed);

  const depth = overlays(ctx, env, look);
  ctx.fillStyle = depth.vignette;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.fillStyle = depth.split;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  ctx.restore();
}
