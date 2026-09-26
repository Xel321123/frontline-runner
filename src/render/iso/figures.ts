/**
 * Rigged figures — SVG isometric infantry and armour, posed every frame.
 *
 * The rig
 * -------
 * Every figure is a set of separate SVG path parts (thigh, shin, boot, torso,
 * head, helmet, upper arm, forearm, weapon, pack) drawn with a rotation about a
 * named joint, in this order: back limbs, pack, torso, front limbs, head,
 * helmet, weapon. The parts are authored around their joint, so "pose the knee"
 * is one `rotate` and nothing has to be recomputed.
 *
 * Animation is driven by simulation state, not by a timer:
 *  - `stride` (0..1 across one step, advanced by *distance travelled*) drives the
 *    walk cycle, so a unit that stops mid-step stops mid-step instead of
 *    moon-walking;
 *  - `headingX/headingY` tilt the whole figure by up to ±18° toward its direction
 *    of travel, which is what makes movement read on a 2.5-D plane;
 *  - `recoil`, `shoved`, `suppressed`, `dugIn`, `illuminated`, `spawn` and
 *    `hpFraction` each adjust the pose or the paint.
 *
 * Two armies, one path set: fills are `@token`s resolved through a palette keyed
 * by faction and tier, and the *helmet silhouette* (Brodie brim, Stahlhelm
 * skirt, M1 dome) is what tells them apart at 34 px.
 *
 * Vehicles are drawn as real isometric prisms through `toIso`, with the hull
 * aligned to whichever world axis the tank is travelling along and a turret that
 * rotates to the heading, so armour reads as armour from any direction.
 */

import type { Faction } from '../../core/types';
import type { Environment } from '../../data/campaignData';
import { UNIT_STATS, unitStats, type UnitKind } from '../../game/units';
import type { CorpseDrawOptions, UnitDrawOptions } from './contracts';
import { drawHealthBar, drawShadow, mix } from './common';
import { paintSprite, sh, type Palette, type Shape, type Sprite } from './paint';

// ---------------------------------------------------------------- palettes

interface FigurePalette extends Palette {
  readonly helmetKind: 'brodie' | 'm1' | 'stahl' | 'stahlCamo';
}

/** Allied kit: olive drab webbing, khaki pack, weathered leather boots. */
const ALLIED: FigurePalette = {
  helmetKind: 'brodie',
  cloth: '#6d7245',
  clothDark: '#4e5330',
  clothLight: '#7f8654',
  kit: '#8a7d57',
  kitDark: '#655c3e',
  steel: '#434a44',
  steelDark: '#2b312c',
  wood: '#5d4a2f',
  skin: '#c1976d',
  boot: '#2f2a22',
  pack: '#7a6f4e',
  accent: '#c9e06a',
  ink: '#1b1f1a',
};

const AXIS: FigurePalette = {
  helmetKind: 'stahl',
  cloth: '#5f6459',
  clothDark: '#444940',
  clothLight: '#6f7568',
  kit: '#4c4c3e',
  kitDark: '#38382d',
  steel: '#3c3f3d',
  steelDark: '#262929',
  wood: '#4a3a26',
  skin: '#c1976d',
  boot: '#241f1a',
  pack: '#54503f',
  accent: '#d9a45c',
  ink: '#171a17',
};

/** Late-war kit: the M1 dome and axis camouflage covers, plus field-grey kit. */
const ALLIED_LATE: FigurePalette = { ...ALLIED, helmetKind: 'm1', cloth: '#6a6f46' };
const AXIS_LATE: FigurePalette = { ...AXIS, helmetKind: 'stahlCamo' };

function paletteFor(faction: Faction, tier: number): FigurePalette {
  const late = tier >= 6;
  if (faction === 'allied') return late ? ALLIED_LATE : ALLIED;
  return late ? AXIS_LATE : AXIS;
}

// ------------------------------------------------------------------ matrix

/** 2×3 affine transform: the little bit of maths the rig needs. */
interface Xf {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** `m` first, then `n`. */
function mul(m: Xf, n: Xf): Xf {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function translate(x: number, y: number): Xf {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

function rotate(angle: number): Xf {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

function scale(sx: number, sy: number): Xf {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

function apply(m: Xf, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// ------------------------------------------------------------------- parts

/**
 * Body-space skeleton, in world units with the origin between the feet and -y
 * up: the waist is 13 above the ground, the shoulders 25, the head 27.
 */
const HIP_Y = -13;
const SHOULDER_Y = -25;
const HEAD_Y = -29;

const THIGH: readonly Shape[] = [
  sh('M-2.9 0L2.9 0L2.4 7L-2.4 7Z', '@cloth'),
  sh('M-2.4 5.4L2.4 5.4L2.4 7L-2.4 7Z', '@clothDark'),
];
const SHIN: readonly Shape[] = [
  sh('M-2.2 0L2.2 0L1.8 4.6L-1.8 4.6Z', '@cloth'),
  // Boots point forward, which is what stops a walking figure reading as a
  // pair of sticks: the foot is the only part that ever touches the ground.
  sh('M-2.2 4.4L2.6 4.4L4.6 6L4.8 7.6L-2.2 7.6Z', '@boot'),
];
const UPPER_ARM: readonly Shape[] = [
  sh('M-1.8 0L1.8 0L1.6 6L-1.6 6Z', '@clothLight'),
];
const FOREARM: readonly Shape[] = [
  sh('M-1.5 0L1.5 0L1.3 5.4L-1.3 5.4Z', '@clothLight'),
  sh('M-1.6 5.2L1.6 5.2L1.6 7L-1.6 7Z', '@skin'),
];
const TORSO: readonly Shape[] = [
  // Authored around the waist, extending up to the shoulders.
  sh('M-4.6 0L4.6 0L5 -6L4.6 -12L-4.6 -12L-5 -6Z', '@cloth'),
  sh('M-4.6 -12L4.6 -12L3.4 -13.6L-3.4 -13.6Z', '@clothDark'),
  // Webbing and belt: the small kit detail that says "soldier", not "man".
  sh('M-4.8 -3.2L4.8 -3.2L4.8 -1.6L-4.8 -1.6Z', '@kitDark'),
  sh('M-1.2 -12L1.2 -12L1.2 -1.6L-1.2 -1.6Z', '@kitDark'),
  sh('M-4.2 0L4.2 0L4.2 1.4L-4.2 1.4Z', '@ink', { opacity: 0.5 }),
];
const PACK: readonly Shape[] = [
  sh('M-3.8 -11.4L3.8 -11.4L3.4 -2.6L-3.4 -2.6Z', '@pack'),
  sh('M-3.8 -11.4L3.8 -11.4L3.8 -9.6L-3.8 -9.6Z', '@kitDark'),
  sh('M-2.6 -8.6L2.6 -8.6L2.6 -6.6L-2.6 -6.6Z', '@kitDark', { opacity: 0.7 }),
];
const HEAD: readonly Shape[] = [
  sh('M-2.8 -3L2.8 -3C3.4 -2 3.4 0.4 2.6 1.6L0.6 3.4L-1.4 3.2C-2.8 2.2 -3.4 0 -2.8 -3Z', '@skin'),
  sh('M-1.2 1.6L1.2 1.6L0.8 3.2L-0.8 3.2Z', '@skin'),
];
const HELMETS: Readonly<Record<'brodie' | 'm1' | 'stahl' | 'stahlCamo', readonly Shape[]>> = {
  // Brodie: a broad flat brim over a shallow crown — the WW1 pattern the
  // British and Commonwealth armies still wore into 1939-42.
  brodie: [
    sh('M-6 -3.6C-6.2 -5.6 -4.4 -7.4 -0.2 -7.4C4 -7.4 6 -5.6 5.8 -3.6Z', '@steel'),
    sh('M-6.6 -3.6C-6.8 -2.2 -5.4 -1.2 -4.4 -1.6L4.4 -1.6C5.4 -1.2 6.8 -2.2 6.6 -3.6Z', '@steelDark'),
    sh('M-5 -5.4C-3.4 -6.4 2 -6.6 4.6 -5.6L4.6 -5C2 -5.8 -3.4 -5.6 -5 -4.8Z', '@steel', { opacity: 0.5 }),
  ],
  // M1: dome with a slighter rim, and a chin strap once it is properly worn.
  m1: [
    sh('M-5.6 -3.4C-6 -6.4 -3.6 -8 -0.2 -8C3.2 -8 5.8 -6.2 5.6 -3.4Z', '@steel'),
    sh('M-5.8 -3.4L5.8 -3.4L5.4 -2.2L-5.4 -2.2Z', '@steelDark'),
    sh('M-2.6 1.4L2.6 1.4L2.4 2.6L-2.4 2.6Z', '@kitDark', { opacity: 0.6 }),
  ],
  // Stahlhelm: dome with a pronounced flared skirt and neck guard.
  stahl: [
    sh('M-6.2 -4.4C-6.6 -7 -4 -8.4 -0.2 -8.4C3.6 -8.4 6.2 -7 5.8 -4.4L5.4 -1.4L3.6 0.4L-4 0.4L-5.6 -1.4Z', '@steel'),
    sh('M-6.4 -4.6L6 -4.6L5.8 -3.2L-6.2 -3.2Z', '@steelDark'),
    sh('M-4 -6.4C-2 -7.4 2.4 -7.4 4.4 -6.4L4.4 -5.6C2.4 -6.4 -2 -6.4 -4 -5.6Z', '@steel', { opacity: 0.45 }),
  ],
  stahlCamo: [
    sh('M-6.2 -4.4C-6.6 -7 -4 -8.4 -0.2 -8.4C3.6 -8.4 6.2 -7 5.8 -4.4L5.4 -1.4L3.6 0.4L-4 0.4L-5.6 -1.4Z', '@steel'),
    sh('M-6.4 -4.6L6 -4.6L5.8 -3.2L-6.2 -3.2Z', '@steelDark'),
    // Camouflage cover: blotches of cloth and mud over the shell.
    sh('M-4.4 -6.6L-1.2 -7.4L-0.8 -5L-3.6 -4.4Z', '@cloth', { opacity: 0.85 }),
    sh('M1 -7.2L4.4 -6.2L4 -4.2L0.4 -5.2Z', '@kit', { opacity: 0.8 }),
    sh('M-3 -5.6L0.6 -5.8L1 -4.2L-2.6 -4Z', '@ink', { opacity: 0.35 }),
  ],
};

/** Rifles, SMGs and machine guns, authored around the firing hand (+x forward). */
const RIFLE: readonly Shape[] = [
  sh('M-5 -0.6L6.4 -0.6L6.4 1.4L-5 1.4Z', '@wood'),
  sh('M-5 1L-2.6 1L-3.6 3.6L-5.2 3.4Z', '@wood'),
  sh('M6.4 -1.4L14.6 -1.4L14.6 0.2L6.4 0.2Z', '@steel'),
  sh('M8.4 -2.6L10.4 -2.6L10 -1.4L8.6 -1.4Z', '@steelDark'),
  sh('M1 1.4L3 1.4L3 4.4L1 4.4Z', '@steelDark'),
];
const SMG: readonly Shape[] = [
  sh('M-3.4 -0.6L5.4 -0.6L5.4 1.4L-3.4 1.4Z', '@steel'),
  sh('M5.4 -1.2L10.4 -1.2L10.4 0L5.4 0Z', '@steelDark'),
  sh('M1.4 1.4L3.2 1.4L3.2 6L1.4 6Z', '@steelDark'),
  sh('M-3.4 -0.6L-5.4 0.2L-5.4 2L-3.4 1.8Z', '@wood'),
  sh('M2.6 -2.2L4 -2.2L4 -0.8L2.6 -0.8Z', '@ink', { opacity: 0.6 }),
];
const MG: readonly Shape[] = [
  sh('M-4 -0.8L8.6 -0.8L8.6 1.6L-4 1.6Z', '@steel'),
  sh('M8.6 -1.6L17 -1.6L17 0L8.6 0Z', '@steelDark'),
  sh('M5 -3.6L9 -3.6L9 -2L5 -2Z', '@steelDark'),
  // Bipod: down when the gun is on its position, folded when carried.
  sh('M9.6 1.6L10.8 1.6L8.4 7.4L7.2 7L9.6 1.6Z', '@steelDark'),
  sh('M9.6 1.6L10.8 1.6L13 7.4L11.8 7.8L9.6 1.6Z', '@steelDark'),
];

const AMMO_BOX: readonly Shape[] = [
  sh('M-2.6 -3L2.6 -3L2.6 1.4L-2.6 1.4Z', '@kitDark'),
  sh('M-2.6 -3L2.6 -3L2.6 -1.8L-2.6 -1.8Z', '@kit', { opacity: 0.7 }),
];

// -------------------------------------------------------------- pose & draw

interface Pose {
  readonly stride: number;
  readonly moving: boolean;
  readonly recoil: number;
  readonly shoved: number;
  readonly suppressed: boolean;
  readonly dugIn: boolean;
  readonly staggering: boolean;
  readonly kind: UnitKind;
  readonly time: number;
}

interface LimbAngles {
  readonly thighBack: number;
  readonly kneeBack: number;
  readonly thighFront: number;
  readonly kneeFront: number;
  readonly armBack: number;
  readonly armFront: number;
  readonly elbowBack: number;
  readonly elbowFront: number;
  readonly weapon: number;
  readonly bob: number;
  readonly lean: number;
  readonly crouch: number;
}

/**
 * Turn the simulation's animation state into joint angles. Everything is a
 * function of `stride` and the pose flags, so a battle replays identically and
 * the headless harness could assert a pose if it ever needed to.
 */
function anglesFor(pose: Pose): LimbAngles {
  const phase = pose.stride * Math.PI * 2;
  const swing = pose.moving ? 0.46 : 0.06;
  const idle = Math.sin(pose.time * 1.7) * 0.02;
  const crouch = pose.dugIn ? 5.6 : pose.suppressed ? 2.6 : 0;

  // A dig-in is a kneeling position rather than a standing one: the leading
  // knee drops and the trailing leg tucks under, which is what makes an MG
  // behind its bipod read as "in position" instead of "standing still".
  if (pose.dugIn) {
    return {
      thighBack: -0.5,
      kneeBack: 1.9,
      thighFront: -1.15,
      kneeFront: 1.55,
      armBack: 0.5,
      armFront: -0.2,
      elbowBack: -0.9,
      elbowFront: -1.15,
      weapon: -0.12,
      bob: 0,
      lean: 0.06,
      crouch,
    };
  }

  return {
    thighBack: Math.sin(phase) * swing + idle,
    kneeBack: Math.max(0, Math.sin(phase + 1.1)) * 0.55 * (pose.moving ? 1 : 0.2),
    thighFront: Math.sin(phase + Math.PI) * swing + idle,
    kneeFront: Math.max(0, Math.sin(phase + Math.PI + 1.1)) * 0.55 * (pose.moving ? 1 : 0.2),
    armBack: -Math.sin(phase) * swing * 0.7,
    // The weapon arm is the exception: it stays on the weapon, so the front arm
    // only takes a fraction of the swing and none of the shoulder roll.
    armFront: -Math.sin(phase + Math.PI) * swing * 0.16,
    elbowBack: -0.35 - pose.recoil * 0.22,
    elbowFront: -0.95 - pose.recoil * 0.35,
    weapon: -0.06 + pose.recoil * 0.1,
    bob: Math.sin(phase * 2) * (pose.moving ? 0.9 : 0.25),
    lean: (pose.moving ? 0.1 : 0) + pose.shoved * 0.28 + (pose.staggering ? 0.22 : 0),
    crouch,
  };
}

/** Draw one part at a joint, rotated about it. */
function part(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite | readonly Shape[],
  palette: Palette,
  jointX: number,
  jointY: number,
  angle: number,
  extra?: Xf,
): void {
  ctx.save();
  ctx.translate(jointX, jointY);
  if (angle !== 0) ctx.rotate(angle);
  if (extra) ctx.transform(extra.a, extra.b, extra.c, extra.d, extra.e, extra.f);
  paintSprite(ctx, { shapes: sprite as readonly Shape[] }, palette);
  ctx.restore();
}

function armFor(kind: UnitKind): readonly Shape[] {
  if (kind === 'smg') return SMG;
  if (kind === 'mg') return MG;
  return RIFLE;
}

/** The tank's vertical stack, in world units: tracks, hull, deck, turret. */
const HULL_HEIGHT = 9;
const DECK_HEIGHT = 3;
const TURRET_HEIGHT = 7;

/** World-plane point → local isometric screen offset (2:1), axis-swappable. */
function toIso(u: number, v: number, alignY: boolean): { x: number; y: number } {
  return alignY ? { x: v - u, y: (v + u) * 0.5 } : { x: u - v, y: (u + v) * 0.5 };
}

function isoQuad(u0: number, v0: number, u1: number, v1: number, alignY: boolean): string {
  const a = toIso(u0, v0, alignY);
  const b = toIso(u1, v0, alignY);
  const c = toIso(u1, v1, alignY);
  const d = toIso(u0, v1, alignY);
  return `M${round(a.x)} ${round(a.y)}L${round(b.x)} ${round(b.y)}L${round(c.x)} ${round(c.y)}L${round(d.x)} ${round(d.y)}Z`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * An extruded isometric box: the top face at `h`, plus the two side faces that
 * are actually visible in this projection. Only the visible pair is drawn, which
 * is what keeps a stack of boxes from turning into soup.
 */
function prism(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  h: number,
  alignY: boolean,
  top: string,
  sideA: string,
  sideB: string,
): readonly Shape[] {
  const corners = [
    toIso(u0, v0, alignY),
    toIso(u1, v0, alignY),
    toIso(u1, v1, alignY),
    toIso(u0, v1, alignY),
  ];
  const lifted = corners.map((corner) => ({ x: corner.x, y: corner.y - h }));
  const path = (points: readonly { x: number; y: number }[]): string =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`).join('') + 'Z';

  return [
    sh(path(lifted), top),
    // The +x face and the +y face are the visible pair. With the box turned to
    // run along y, they swap.
    sh(path([corners[1]!, corners[2]!, lifted[2]!, lifted[1]!]), alignY ? sideB : sideA),
    sh(path([corners[2]!, corners[3]!, lifted[3]!, lifted[2]!]), alignY ? sideA : sideB),
  ];
}

// ------------------------------------------------------------------ vehicles

/** Track run: a prism with road wheels that turn as the tank advances. */
function track(
  sideU: number,
  stride: number,
  alignY: boolean,
  hullLight: string,
): readonly Shape[] {
  const shapes: Shape[] = [
    ...prism(sideU - 3.4, -15, sideU + 3.4, 15, 8, alignY, '#2b2f2b', '#23261f', '#1b1e1a'),
  ];
  // Road wheels: rotating them with the stride is the cheapest possible way to
  // say "this thing is moving" for a vehicle with no legs to swing.
  for (let i = -2; i <= 2; i += 1) {
    const angle = stride * Math.PI * 2 + i * 0.7;
    const centre = toIso(sideU, i * 6, alignY);
    shapes.push(
      sh(
        `M${round(centre.x - 2.4)} ${round(centre.y - 1.2)}A2.6 2.6 0 1 1 ${round(centre.x + 2.4)} ${round(centre.y - 1.2)}Z`,
        '#3a3d38',
      ),
      sh(`M${round(centre.x)} ${round(centre.y - 1.2)}L${round(centre.x + Math.cos(angle) * 2.2)} ${round(centre.y - 1.2 + Math.sin(angle) * 1.1)}Z`, hullLight, {
        stroke: hullLight,
        strokeWidth: 1.2,
        lineCap: 'round',
      }),
    );
  }
  return shapes;
}

// ------------------------------------------------------------------- public

/** The muzzle of a figure's weapon, in the same screen space as `o.x/o.y`. */
function infantryMuzzle(
  body: Xf,
  o: UnitDrawOptions,
  angles: LimbAngles,
  shoulderForward: number,
): { muzzleX: number; muzzleY: number } {
  // Walk the chain shoulder → elbow → hand → muzzle with the same matrices the
  // drawing uses, so the flash always lands on the barrel even mid-stride.
  const shoulderX = shoulderForward + 3.4;
  const chain = mul(
    mul(
      mul(mul(body, translate(shoulderX, SHOULDER_Y + 6.4 + angles.crouch)), rotate(angles.armFront)),
      translate(0, 4.6),
    ),
    rotate(angles.weapon),
  );
  const stats = unitStats(o.kind);
  const reach = stats.projectile === 'shell' ? 17 : o.kind === 'smg' ? 10.4 : 14.6;
  const point = apply(chain, reach, -0.7);
  return { muzzleX: point.x, muzzleY: point.y };
}

/**
 * Draw one figure or vehicle. Returns the muzzle position so the renderer can
 * put the flash and the tracer exactly where the barrel is.
 */
export function drawUnit(
  ctx: CanvasRenderingContext2D,
  o: UnitDrawOptions,
): { muzzleX: number; muzzleY: number } {
  const palette = paletteFor(o.faction, o.tier);
  // A figure with an unknown kind must not take the whole frame down with it:
  // the renderer feeds this straight from the simulation's unit list.
  const stats = unitStats(o.kind) ?? UNIT_STATS.rifleman;
  const spawn = Math.max(0.35, Math.min(1, o.spawn));
  const shadowAlpha = o.environment === 'night' ? 0.22 : 0.34;
  const height = stats.height * 0.62;

  if (o.shadow) {
    drawShadow(ctx, {
      x: o.x,
      y: o.y - 1,
      rx: (stats.radius + 5) * o.scale * spawn,
      ry: (stats.radius + 2) * 0.5 * o.scale * spawn,
      alpha: shadowAlpha,
    });
  }

  // The whole figure tilts toward its heading: a figure walking into the screen
  // leans away from the camera, one walking out leans toward it.
  const projected = { x: o.headingX - o.headingY, y: (o.headingX + o.headingY) * 0.5 };
  const headingAngle = Math.atan2(projected.y, Math.abs(projected.x) || 1e-6);
  const tilt = Math.max(-0.32, Math.min(0.32, -headingAngle * 0.34 * o.facing));

  const outer = mul(mul(translate(o.x, o.y), rotate(tilt)), scale(o.scale * spawn, o.scale * spawn));

  if (o.kind === 'tank') {
    drawTank(ctx, outer, o, palette);
    return tankMuzzle(outer, o);
  }

  const body = mul(outer, scale(o.facing, 1));
  const angles = anglesFor({
    stride: o.stride,
    moving: o.moving,
    recoil: o.recoil,
    shoved: o.shoved,
    suppressed: o.suppressed,
    dugIn: o.dugIn,
    staggering: o.staggering,
    kind: o.kind,
    time: o.time,
  });

  const hip = HIP_Y - angles.crouch * 0.35;
  const shoulder = SHOULDER_Y + angles.crouch * 0.6 + angles.bob;
  const bob = angles.bob;

  // Apply the composed body transform to the canvas, then draw in body units.
  ctx.save();
  const mirrorX = o.facing === -1;
  if (mirrorX) {
    ctx.translate(o.x, o.y);
    ctx.scale(-1, 1);
    ctx.translate(-o.x, -o.y);
  }
  ctx.translate(o.x, o.y);
  ctx.rotate(tilt);
  ctx.scale(o.scale * spawn, o.scale * spawn);
  ctx.translate(0, 0);

  const hp = o.hpFraction;
  // Battle wear: figures get dirtier and darker as they take losses, so a
  // veteran squad is readable without a health bar.
  const wear = hp < 0.99 ? (1 - hp) * 0.4 : 0;

  // Lean into the direction of travel, and brace when suppressed.
  ctx.rotate(angles.lean * 0.35);

  // --- back limbs ---------------------------------------------------------
  part(ctx, SHIN, palette, -2.2 + Math.sin(angles.thighBack) * 7, hip + 7 + bob, angles.thighBack + angles.kneeBack);
  part(ctx, THIGH, palette, -2.2, hip + bob, angles.thighBack);

  if (o.kind === 'mg') {
    // Number two on the gun: a crouched figure a step back carrying the spare
    // barrel. It reads as a team, which is what an MG actually is.
    part(ctx, SHIN, palette, -9.4, hip + 5.4 + bob, -0.4 + angles.kneeBack * 0.5);
    part(ctx, THIGH, palette, -8.6, hip + 1.4 + bob, -0.75);
    part(ctx, TORSO, palette, -8.6, hip + 1.4 + bob, -0.12);
    part(ctx, HEAD, palette, -8.6, HEAD_Y + 1.6 + bob, 0);
    part(ctx, HELMETS[palette.helmetKind], palette, -8.6, HEAD_Y + 1.2 + bob, 0);
  }

  part(ctx, PACK, palette, 0, shoulder + 2.6 + bob, 0);
  part(ctx, AMMO_BOX, palette, -4.4, hip + 3.6 + bob, 0);
  part(ctx, TORSO, palette, 0, hip + bob, 0);

  // --- front limbs --------------------------------------------------------
  part(ctx, THIGH, palette, 2.2, hip + bob, angles.thighFront);
  part(ctx, SHIN, palette, 2.2 + Math.sin(angles.thighFront) * 7, hip + 7 + bob, angles.thighFront + angles.kneeFront);

  part(ctx, UPPER_ARM, palette, -3.2, shoulder + 0.6 + bob, angles.armBack);
  part(ctx, FOREARM, palette, -3.2 + Math.sin(angles.armBack) * 6, shoulder + 6.6 + bob, angles.armBack + angles.elbowBack);

  part(ctx, UPPER_ARM, palette, 3.4, shoulder + 0.6 + bob, angles.armFront);
  part(ctx, FOREARM, palette, 3.4 + Math.sin(angles.armFront) * 6, shoulder + 6.6 + bob, angles.armFront + angles.elbowFront);

  // --- head, helmet, weapon ----------------------------------------------
  part(ctx, HEAD, palette, 1.6, HEAD_Y + bob, o.recoil * -0.05);
  part(ctx, HELMETS[palette.helmetKind], palette, 1.6, HEAD_Y + bob - 0.4, 0);

  const weaponX = 3.4 + Math.sin(angles.armFront) * 6 + Math.sin(angles.armFront + angles.elbowFront) * 5;
  const weaponY = shoulder + 6.6 + bob + Math.cos(angles.armFront + angles.elbowFront) * 5;
  part(ctx, armFor(o.kind), palette, weaponX, weaponY, angles.weapon - angles.armFront * 0.2);

  // --- wear, damage and light --------------------------------------------
  if (wear > 0.01) {
    ctx.globalAlpha = wear * 0.55;
    ctx.fillStyle = '#2a2418';
    ctx.beginPath();
    ctx.arc(0, hip + bob + 2, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (hp < 0.35) {
    // A badly hurt figure slumps and stops swinging its arms.
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#6d1f1a';
    ctx.beginPath();
    ctx.arc(1.2, shoulder + 5 + bob, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (o.illuminated) {
    // A searchlight rim: bright, cool, and only on the top of the figure.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#cfe0ff';
    ctx.fillRect(-6, shoulder - 6 + bob, 12, 4);
    ctx.restore();
  }
  ctx.restore();

  // A health bar only appears once a figure is hurt: an untouched line of
  // troops stays clean, and a chewed-up one advertises it.
  if (hp < 0.995) {
    drawHealthBar(ctx, {
      x: o.x,
      y: o.y - (height + 9) * o.scale,
      width: 20 * o.scale,
      height: Math.max(1.6, 2.4 * o.scale),
      fraction: hp,
      outline: true,
    });
  }
  return infantryMuzzle(body, o, angles, 1.6);
}

/**
 * The tank: aligned to whichever world axis it is travelling along, with the
 * turret tracking the exact heading so armour can shoot one way and drive
 * another.
 */
function drawTank(
  ctx: CanvasRenderingContext2D,
  outer: Xf,
  o: UnitDrawOptions,
  palette: FigurePalette,
): void {
  const alignY = Math.abs(o.headingY) > Math.abs(o.headingX);
  const along = alignY ? o.headingY : o.headingX;
  const mirror = along >= 0 ? 1 : -1;

  const bodyPalette: Palette = {
    ...palette,
    hull: palette.clothDark,
    hullLight: mix(palette.cloth, '#ffffff', 0.22),
    hullDark: mix(palette.clothDark, '#000000', 0.35),
  };

  ctx.save();
  ctx.translate(o.x, o.y);
  const tilt = outer.b;
  if (tilt !== 0) ctx.rotate(Math.atan2(outer.b, outer.a));
  ctx.scale(o.scale * mirror, o.scale);

  // --- tracks and hull ----------------------------------------------------
  const trackShapes: Shape[] = [
    ...track(-11, o.stride, alignY, String(bodyPalette.hullLight)),
    ...track(11, o.stride, alignY, String(bodyPalette.hullLight)),
  ];
  const hull = prism(-17, -11, 15, 11, HULL_HEIGHT, alignY, '@hullLight', '@hull', '@hullDark');
  // The deck and turret are stacked ON the hull: a prism is drawn upwards from
  // the point it is translated to, so each layer has to be lifted by the height
  // of everything beneath it or the turret ends up floating in the air.
  const deck = prism(-12, -8, 8, 8, DECK_HEIGHT, alignY, '@hullLight', '@hull', '@hullDark');

  for (const shape of trackShapes) paintSprite(ctx, { shapes: [shape] }, bodyPalette);
  for (const shape of hull) paintSprite(ctx, { shapes: [shape] }, bodyPalette);
  ctx.save();
  ctx.translate(0, -HULL_HEIGHT);
  for (const shape of deck) paintSprite(ctx, { shapes: [shape] }, bodyPalette);
  ctx.restore();

  // Glacis plate, tow hooks and a stowed spade: the clutter that makes a hull
  // read as a machine rather than a box.
  const glacis = toIso(15, 0, alignY);
  ctx.save();
  ctx.translate(0, -HULL_HEIGHT * 0.45);
  paintSprite(
    ctx,
    {
      shapes: [
        sh(isoQuad(11, -9, 15.4, 9, alignY), '@hullDark'),
        sh(`M${round(glacis.x)} ${round(glacis.y - 9)}L${round(glacis.x)} ${round(glacis.y - 4)}`, '@steel', {
          stroke: '#8c9186',
          strokeWidth: 1,
          lineCap: 'round',
        }),
      ],
    },
    bodyPalette,
  );
  ctx.restore();

  // --- turret (rotates with the heading) ----------------------------------
  const forwardScreen = { x: o.headingX - o.headingY, y: (o.headingX + o.headingY) * 0.5 };
  const axisScreen = alignY ? { x: -1, y: 0.5 } : { x: 1, y: 0.5 };
  const turretAngle =
    (Math.atan2(forwardScreen.y, forwardScreen.x) - Math.atan2(axisScreen.y, axisScreen.x)) * mirror;

  const turretCentre = toIso(alignY ? 0 : -2, alignY ? -2 : 0, alignY);
  ctx.save();
  ctx.translate(turretCentre.x, turretCentre.y - (HULL_HEIGHT + DECK_HEIGHT));
  ctx.save();
  ctx.rotate(turretAngle);
  // Barrel first so it sits behind the turret face that covers its breech.
  paintSprite(
    ctx,
    {
      shapes: [
        sh('M4 -1.4L22 -1.4L22 0.8L4 0.8Z', '@steelDark'),
        sh('M4 -2.6L9 -2.6L9 2L4 2Z', '@steel'),
        // Recoil travel: the barrel slides back when the gun fires.
        sh('M21 -2L25 -2L25 1.4L21 1.4Z', '@steel'),
      ],
    },
    bodyPalette,
    { tx: -o.recoil * 2.2 },
  );
  paintSprite(ctx, { shapes: prism(alignY ? -6 : -9, alignY ? -9 : -6, alignY ? 6 : 7, alignY ? 7 : 6, TURRET_HEIGHT, alignY, '@hullLight', '@hull', '@hullDark') }, bodyPalette);
  paintSprite(
    ctx,
    {
      shapes: [
        // Commander's hatch, periscope and an antenna, plus spare track links.
        sh(isoQuad(-5, -3, 1, 3, alignY), '@hullDark'),
        sh('M-4 -8.6L-4 -13.6', '@steel', { stroke: '#9aa094', strokeWidth: 0.9, lineCap: 'round' }),
        sh(isoQuad(2, -6, 6, -2, alignY), '@steel', { opacity: 0.7 }),
      ],
    },
    bodyPalette,
  );
  ctx.restore();

  // --- stowage and wear ---------------------------------------------------
  ctx.restore();

  // Exhaust smoke thickens as the tank is worn down: a visual cue that a
  // battered vehicle is a liability, without a single extra HUD element.
  const smoke = (1 - Math.max(0.25, o.hpFraction)) * 0.9;
  if (smoke > 0.05) {
    const vent = toIso(alignY ? 0 : -14, alignY ? -14 : 0, alignY);
    for (let i = 0; i < 3; i += 1) {
      const phase = (o.time * 0.7 + i * 0.34) % 1;
      ctx.save();
      ctx.globalAlpha = (1 - phase) * 0.34 * smoke;
      ctx.fillStyle = '#5b5b56';
      ctx.beginPath();
      ctx.arc(vent.x + phase * 3, vent.y - 12 - phase * 16, 2.4 + phase * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

/** Where a tank's muzzle is, in screen space. */
function tankMuzzle(
  outer: Xf,
  o: UnitDrawOptions,
): { muzzleX: number; muzzleY: number } {
  const alignY = Math.abs(o.headingY) > Math.abs(o.headingX);
  const along = alignY ? o.headingY : o.headingX;
  const mirror = along >= 0 ? 1 : -1;
  const forwardScreen = { x: o.headingX - o.headingY, y: (o.headingX + o.headingY) * 0.5 };
  const axisScreen = alignY ? { x: -1, y: 0.5 } : { x: 1, y: 0.5 };
  const turretAngle =
    (Math.atan2(forwardScreen.y, forwardScreen.x) - Math.atan2(axisScreen.y, axisScreen.x)) * mirror;
  const centre = toIso(alignY ? 0 : -2, alignY ? -2 : 0, alignY);

  const chain = mul(
    mul(
      mul(translate(o.x, o.y), rotate(Math.atan2(outer.b, outer.a))),
      scale(o.scale * mirror, o.scale),
    ),
    // The barrel sits at the middle of the turret box, which itself sits on the
    // hull and the deck — the same stack the drawing uses.
    mul(
      translate(centre.x, centre.y - (HULL_HEIGHT + DECK_HEIGHT + TURRET_HEIGHT * 0.55)),
      rotate(turretAngle),
    ),
  );
  const point = apply(chain, 25 - o.recoil * 2.2, -0.3);
  return { muzzleX: point.x, muzzleY: point.y };
}

/** A body where it fell: the same rig, toppled and fading. */
export function drawCorpse(ctx: CanvasRenderingContext2D, o: CorpseDrawOptions): void {
  const palette = paletteFor(o.faction, o.tier);
  const stats = unitStats(o.kind);
  const fade = Math.max(0, Math.min(1, o.fade));

  drawShadow(ctx, {
    x: o.x,
    y: o.y,
    rx: (stats.radius + 6) * o.scale,
    ry: (stats.radius + 3) * 0.5 * o.scale,
    alpha: 0.26 * fade,
  });

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(o.x, o.y);
  ctx.scale(o.scale, o.scale);
  // The body rotates about the point where it was standing, so it topples away
  // from the impact rather than sliding.
  ctx.translate(0, -stats.height * 0.28);
  ctx.rotate((Math.PI / 2) * o.fallen * o.topple * -1);
  ctx.translate(0, stats.height * 0.28);
  ctx.scale(o.topple, 1);

  const palette2: Palette = palette;
  // Splayed limbs: an arm thrown forward, a leg bent under, weapon dropped.
  paintSprite(ctx, { shapes: [sh('M-3 0L3 0L2.6 12L-2.6 12Z', '@cloth')] }, palette2, { rotate: -0.4, pivotX: 0, pivotY: 0 });
  paintSprite(ctx, { shapes: [sh('M-3 0L3 0L2.6 13L-2.6 13Z', '@cloth')] }, palette2, { rotate: 0.6, pivotX: 0, pivotY: 0 });
  paintSprite(ctx, { shapes: [sh('M-4.6 -12L4.6 -12L5 -4L4.6 1L-4.6 1L-5 -4Z', '@cloth')] }, palette2, { tx: -2, rotate: 0.3, pivotX: 0, pivotY: 0 });
  paintSprite(ctx, { shapes: [sh('M-2.6 -13.4L2.6 -13.4L1.4 -9L-1.4 -9Z', '@clothDark')] }, palette2, { tx: 5, ty: -2, rotate: 1.1, pivotX: 0, pivotY: -12 });
  paintSprite(ctx, { shapes: HELMETS[palette.helmetKind] }, palette2, { tx: 11, ty: 2.6, rotate: 1.4 });
  // The weapon lies where it was dropped.
  paintSprite(ctx, { shapes: armFor(o.kind) }, palette2, { tx: -12, ty: 1.4, rotate: 0.18, scaleX: 0.95, scaleY: 0.95 });
  ctx.restore();
}

/**
 * HUD icon: the same rig in a fixed mid-stride pose, scaled to `height` px.
 * Reusing `drawUnit` means an icon can never drift from the battlefield figure.
 */
export function drawUnitIcon(
  ctx: CanvasRenderingContext2D,
  kind: UnitKind,
  faction: Faction,
  tier: number,
  x: number,
  baselineY: number,
  height: number,
): void {
  const scale = height / unitStats(kind).height;
  drawUnit(ctx, {
    x,
    y: baselineY,
    scale,
    time: 0,
    environment: 'standard' as Environment,
    kind,
    faction,
    tier,
    facing: 1,
    headingX: 1,
    headingY: 0,
    phase: 0.3,
    stride: 0.3,
    moving: true,
    dugIn: false,
    hpFraction: 1,
    spawn: 1,
    recoil: 0,
    shoved: 0,
    illuminated: false,
    suppressed: false,
    staggering: false,
    shadow: true,
  });
}

