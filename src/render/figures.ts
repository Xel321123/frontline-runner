/**
 * Procedural figures — soldiers, tanks, strongpoints, sandbags and the fallen.
 *
 * Still no sprite sheets: every figure is Canvas 2D paths. What changed for the
 * mobile build is the *animation*, because at 1.8x zoom a sliding chess piece is
 * obvious:
 *
 * - troops walk with a two-frame stride (legs split, body bob) rather than
 *   gliding, and the stride is derived from world position so feet stay planted
 *   against the ground instead of moon-walking;
 * - weapons kick back on firing, the muzzle throwing a flash and smoke;
 * - tanks rock back on their tracks when the main gun fires;
 * - the dead topple backwards, their helmet is knocked off and arcs away, and
 *   what is left is a silhouette fading on the ground;
 * - strongpoints are drawn as real fortifications, with a flag that lowers as
 *   their garrison is worn down.
 */

import type { Corpse, Side } from '../game/tugTypes';
import { GROUND_Y } from '../game/constants';
import { CORPSE_FALL_TIME } from '../game/constants';
import type { UnitKind } from '../game/units';
import { UNIT_STATS } from '../game/units';
import type { FactionPalette, HelmetShape } from './palette';

export interface SoldierOptions {
  readonly x: number;
  readonly palette: FactionPalette;
  readonly helmet: HelmetShape;
  readonly kind: UnitKind;
  readonly facing: 1 | -1;
  readonly time: number;
  /** Stride phase offset so a line of troops is not in lockstep. */
  readonly phase: number;
  readonly walking: boolean;
  readonly dugIn: boolean;
  readonly hpFraction: number;
  readonly spawn: number;
  readonly recoil: number;
  readonly illuminated: boolean;
  /** Blast stagger: the figure is reeling. */
  readonly stagger: number;
}

export interface Muzzle {
  readonly muzzleX: number;
  readonly muzzleY: number;
}

/** Draw scale for figures: the whole point of the mobile pass. */
export const FIGURE_SCALE = 1.3;

/** Deterministic 0..1 from an integer — stable "randomness" for cracks etc. */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Oval contact shadow beneath a figure. */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(0.5, alpha);
  ctx.fillStyle = '#0b0f0b';
  ctx.beginPath();
  ctx.ellipse(x, y + 1, width * 0.5, Math.max(1.6, width * 0.12), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Helmet silhouettes: Brodie brim, US M1 dome, or the flared Stahlhelm. */
function drawHelmet(
  ctx: CanvasRenderingContext2D,
  shape: HelmetShape,
  palette: FactionPalette,
): void {
  ctx.fillStyle = palette.helmet;
  if (shape === 'brodie') {
    ctx.beginPath();
    ctx.ellipse(0, -37.4, 8.2, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -38.6, 5.2, Math.PI, Math.PI * 2);
    ctx.fill();
  } else if (shape === 'm1') {
    ctx.beginPath();
    ctx.arc(0, -38.4, 5.6, Math.PI * 1.02, Math.PI * 2.02);
    ctx.fill();
    ctx.fillRect(-6.4, -39, 12.8, 2);
  } else {
    // Stahlhelm: dome plus the flared neck/ear skirt.
    ctx.beginPath();
    ctx.arc(0, -38.4, 5.8, Math.PI * 0.98, Math.PI * 2.04);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-6.6, -38.2);
    ctx.lineTo(6.6, -38.2);
    ctx.lineTo(7.6, -34.6);
    ctx.lineTo(-7.6, -34.6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = palette.helmetDark;
  ctx.fillRect(-5.4, -39.6, 10.8, 1.3);
}

/** Weapon silhouettes, drawn from the shoulder pivot at (0, -24). */
function drawWeapon(
  ctx: CanvasRenderingContext2D,
  kind: UnitKind,
  recoil: number,
): Muzzle {
  const kick = recoil * 2.6;
  ctx.fillStyle = '#241d14';
  if (kind === 'rifleman') {
    ctx.fillRect(-3.5 + kick, -25.5, 19, 2.2);
    ctx.fillStyle = '#4a3524';
    ctx.fillRect(-5.5 + kick, -26, 8, 3.4);
    ctx.fillStyle = '#3a2c1c';
    ctx.fillRect(2 + kick, -23.6, 3.4, 5);
    return { muzzleX: 16 + kick, muzzleY: -24.4 };
  }
  if (kind === 'smg') {
    ctx.fillRect(-2.5 + kick, -25.2, 12.5, 2.6);
    ctx.fillStyle = '#3a2c1c';
    ctx.fillRect(-1 + kick, -23, 3.2, 7.2);
    ctx.fillStyle = '#241d14';
    ctx.fillRect(-5.5 + kick, -25.6, 4.5, 2);
    return { muzzleX: 10.5 + kick, muzzleY: -24 };
  }
  // MG: fatter barrel, ammo belt, bipod legs when it is not dug in.
  ctx.fillRect(-4 + kick, -25.8, 20, 3.2);
  ctx.fillStyle = '#4a3524';
  ctx.fillRect(-6.5 + kick, -26.4, 6, 4.2);
  ctx.fillStyle = '#6b5a2c';
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(-2 + i * 2.6 + kick, -22.4, 1.5, 2.2);
  }
  ctx.fillStyle = '#2c2c28';
  ctx.fillRect(9 + kick, -22.6, 1.4, 6);
  ctx.fillRect(13 + kick, -22.6, 1.4, 6);
  return { muzzleX: 16 + kick, muzzleY: -24.6 };
}

export function drawSoldier(ctx: CanvasRenderingContext2D, options: SoldierOptions): Muzzle {
  const { palette, facing, kind } = options;
  const scale = (0.65 + options.spawn * 0.35) * FIGURE_SCALE;
  const hp = Math.max(0, Math.min(1, options.hpFraction));

  drawShadow(ctx, options.x, GROUND_Y, (16 + options.spawn * 3) * FIGURE_SCALE, 0.32 * options.spawn);

  ctx.save();
  ctx.translate(options.x, GROUND_Y);
  ctx.scale(facing * scale, scale);
  ctx.globalAlpha = Math.min(1, 0.35 + options.spawn * 0.65);

  // A reeling figure leans back and its whole body shifts against the shove.
  const reel = Math.min(1, options.stagger * 2.2) * 3.2;
  ctx.rotate((-reel * Math.PI) / 180 * 0.5);

  // Two-frame stride: legs split and the pelvis bobs. Phase comes from world
  // position so the feet stay planted on the ground.
  const stride = options.walking
    ? Math.sin(options.x * 0.24 + options.phase + options.time * 7.2)
    : 0;
  const bob = options.walking ? Math.abs(Math.cos(options.x * 0.24 + options.phase + options.time * 7.2)) * 1.1 : 0;

  // Legs.
  ctx.fillStyle = palette.uniformDark;
  const front = stride * 3.4;
  ctx.save();
  ctx.translate(front, -bob);
  ctx.beginPath();
  ctx.roundRect(-2.6, -13, 4.4, 13, 1.4);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(-front, -bob);
  ctx.beginPath();
  ctx.roundRect(-2.2, -13, 4.2, 13, 1.4);
  ctx.fill();
  ctx.restore();
  // Boots.
  ctx.fillStyle = '#1d1a15';
  ctx.fillRect(-3.2 + front, -1.6 - bob, 5.4, 2);
  ctx.fillRect(-2.8 - front, -1.6 - bob, 5.2, 2);

  ctx.translate(0, -bob);

  // Torso, webbing, pack.
  ctx.fillStyle = palette.uniform;
  ctx.beginPath();
  ctx.roundRect(-5.4, -30, 11, 17.6, 2.4);
  ctx.fill();
  ctx.fillStyle = palette.uniformLight;
  ctx.fillRect(-5.4, -30, 3.4, 17.6);
  ctx.fillStyle = palette.webbing;
  ctx.fillRect(-5, -25.4, 10, 1.7);
  ctx.fillRect(-5, -21.4, 10, 1.5);
  if (kind !== 'tank') {
    ctx.fillStyle = palette.uniformDark;
    ctx.beginPath();
    ctx.roundRect(-8.2, -28.4, 3.6, 8.4, 1.4);
    ctx.fill();
  }

  // Head + helmet.
  ctx.fillStyle = palette.skin;
  ctx.beginPath();
  ctx.arc(0.4, -33.6, 3.9, 0, Math.PI * 2);
  ctx.fill();
  drawHelmet(ctx, options.helmet, palette);
  ctx.fillStyle = '#0f0d0a';
  ctx.fillRect(2.4, -34.2, 2, 1.1);

  // Arms + weapon.
  const muzzle = drawWeapon(ctx, kind, options.recoil);
  ctx.fillStyle = palette.uniform;
  ctx.beginPath();
  ctx.roundRect(0.4 + options.recoil * 2.2, -26.6, 3.2, 8, 1.4);
  ctx.fill();

  // Dug-in gunner: sandbag parapet in front of the position.
  if (options.dugIn) {
    ctx.fillStyle = '#7a6f4f';
    for (let row = 0; row < 2; row += 1) {
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.ellipse(5 + (row % 2) * 3 + i * 6.4, -6.5 - row * 4.4, 3.6, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();

  // Damage bar: only while the unit is actually hurt.
  if (hp < 0.999) {
    const width = 22 * FIGURE_SCALE;
    const top = GROUND_Y - UNIT_STATS[kind].height * FIGURE_SCALE - 8;
    ctx.save();
    ctx.fillStyle = 'rgba(8, 10, 8, 0.65)';
    ctx.fillRect(options.x - width / 2, top, width, 3);
    ctx.fillStyle = hp > 0.55 ? palette.uniformLight : hp > 0.28 ? '#d9a441' : '#c9483a';
    ctx.fillRect(options.x - width / 2, top, width * hp, 3);
    ctx.restore();
  }

  return {
    muzzleX: options.x + muzzle.muzzleX * facing * scale,
    muzzleY: GROUND_Y - 24 + muzzle.muzzleY - (-24) * 0 - bob * scale,
  };
}

export interface TankOptions {
  readonly x: number;
  readonly palette: FactionPalette;
  readonly facing: 1 | -1;
  readonly time: number;
  readonly hpFraction: number;
  readonly spawn: number;
  readonly recoil: number;
  readonly illuminated: boolean;
}

export function drawTank(ctx: CanvasRenderingContext2D, options: TankOptions): Muzzle {
  const { palette, facing } = options;
  const scale = (0.7 + options.spawn * 0.3) * FIGURE_SCALE;

  drawShadow(ctx, options.x, GROUND_Y, 62 * scale, 0.36 * options.spawn);

  ctx.save();
  ctx.translate(options.x, GROUND_Y);
  ctx.scale(facing * scale, scale);
  ctx.globalAlpha = Math.min(1, 0.4 + options.spawn * 0.6);

  // The whole chassis rocks back on its tracks when the gun fires.
  const rock = options.recoil * 2.2;
  ctx.translate(-rock, rock * 0.4);

  // Tracks: outline, links, road wheels, drive sprockets.
  ctx.fillStyle = '#20201c';
  ctx.beginPath();
  ctx.roundRect(-31, -15, 62, 15, 6);
  ctx.fill();
  ctx.fillStyle = '#3a3a33';
  ctx.fillRect(-30, -4.5, 60, 3);
  ctx.strokeStyle = '#15150f';
  ctx.lineWidth = 1;
  for (let i = -28; i <= 28; i += 5.2) {
    ctx.beginPath();
    ctx.moveTo(i, -14.5);
    ctx.lineTo(i, -0.5);
    ctx.stroke();
  }
  ctx.fillStyle = '#4d4d44';
  for (let i = -22; i <= 22; i += 11) {
    ctx.beginPath();
    ctx.arc(i, -7.5, 4.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hull + sloped glacis.
  ctx.fillStyle = palette.uniform;
  ctx.beginPath();
  ctx.moveTo(-27, -14);
  ctx.lineTo(24, -14);
  ctx.lineTo(30, -24);
  ctx.lineTo(-27, -24);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = palette.uniformLight;
  ctx.beginPath();
  ctx.moveTo(-27, -24);
  ctx.lineTo(10, -24);
  ctx.lineTo(8, -27.6);
  ctx.lineTo(-27, -27.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = palette.uniformDark;
  ctx.fillRect(-27, -16.5, 57, 2.6);

  // Turret, mantlet, commander's hatch, antenna.
  ctx.fillStyle = palette.uniform;
  ctx.beginPath();
  ctx.roundRect(-12, -38, 26, 11, 3);
  ctx.fill();
  ctx.fillStyle = palette.uniformLight;
  ctx.fillRect(-12, -38, 26, 3);
  ctx.fillStyle = palette.helmetDark;
  ctx.beginPath();
  ctx.arc(-4, -32, 3.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = palette.helmetDark;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-11, -38.5);
  ctx.lineTo(-15, -50);
  ctx.stroke();

  // Main gun with a muzzle brake, elevated slightly.
  ctx.fillStyle = '#33332c';
  ctx.fillRect(10, -37.4, 24 - options.recoil * 3, 3.2);
  ctx.fillStyle = '#2a2a24';
  ctx.fillRect(30 - options.recoil * 3, -38.4, 4.6, 5.2);

  ctx.restore();

  // Damage: soot, scorch and a failing exhaust plume.
  if (options.hpFraction < 0.7) {
    ctx.save();
    ctx.globalAlpha = (0.7 - options.hpFraction) * 1.4;
    ctx.fillStyle = '#141410';
    ctx.beginPath();
    ctx.ellipse(options.x + facing * 8 * scale, GROUND_Y - 26 * scale, 12 * scale, 6 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = (0.7 - options.hpFraction) * 0.9;
    ctx.fillStyle = 'rgba(40, 38, 34, 0.9)';
    for (let i = 0; i < 4; i += 1) {
      const t = (options.time * 0.8 + i * 0.25) % 1;
      ctx.beginPath();
      ctx.arc(
        options.x - facing * (26 + t * 22) * scale,
        GROUND_Y - (20 + t * 22) * scale,
        (3 + t * 6) * scale,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  return {
    muzzleX: options.x + facing * 32 * scale,
    muzzleY: GROUND_Y - 36 * scale,
  };
}

export interface StrongpointOptions {
  readonly x: number;
  readonly side: Side;
  readonly palette: FactionPalette;
  readonly hpFraction: number;
  readonly time: number;
  readonly flash: number;
  readonly hit: number;
  readonly label: string;
  /** 'enemy' draws the historical stronghold, 'player' the field HQ. */
  readonly variant: 'hq' | 'stronghold';
}

/** Bunker, pillbox or HQ, with a flag that lowers as the position is worn down. */
export function drawStrongpoint(ctx: CanvasRenderingContext2D, options: StrongpointOptions): void {
  const { x, palette, variant } = options;
  const facing: 1 | -1 = options.side === 'player' ? 1 : -1;
  const hp = Math.max(0, Math.min(1, options.hpFraction));
  const scale = FIGURE_SCALE;

  drawShadow(ctx, x, GROUND_Y, 108 * scale, 0.4);

  ctx.save();
  ctx.translate(x, GROUND_Y);
  ctx.scale(facing, 1);

  // Rubble skirt and apron.
  ctx.fillStyle = 'rgba(28, 26, 22, 0.5)';
  ctx.beginPath();
  ctx.ellipse(0, 2, 56 * scale, 7 * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  // Main concrete mass.
  ctx.fillStyle = '#585549';
  ctx.beginPath();
  ctx.moveTo(-46 * scale, 0);
  ctx.lineTo(-42 * scale, -54 * scale);
  ctx.lineTo(34 * scale, -54 * scale);
  ctx.lineTo(46 * scale, -34 * scale);
  ctx.lineTo(46 * scale, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b6757';
  ctx.beginPath();
  ctx.moveTo(-42 * scale, -54 * scale);
  ctx.lineTo(34 * scale, -54 * scale);
  ctx.lineTo(30 * scale, -60 * scale);
  ctx.lineTo(-38 * scale, -60 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#454236';
  ctx.fillRect(-42 * scale, -6 * scale, 88 * scale, 5 * scale);

  if (variant === 'stronghold') {
    // Pillbox: a second embrasure and a steel cupola.
    ctx.fillStyle = '#3a382f';
    ctx.fillRect(-6 * scale, -40 * scale, 30 * scale, 7 * scale);
    ctx.fillStyle = '#6f6a58';
    ctx.beginPath();
    ctx.arc(-16 * scale, -54 * scale, 9 * scale, Math.PI, Math.PI * 2);
    ctx.fill();
  } else {
    // HQ: timber revetment and a signals mast.
    ctx.fillStyle = '#5a4a30';
    for (let i = -40; i <= 30; i += 12) {
      ctx.fillRect(i * scale, -34 * scale, 3.4 * scale, 28 * scale);
    }
    ctx.fillStyle = '#2f2c25';
    ctx.fillRect(20 * scale, -78 * scale, 2.4 * scale, 26 * scale);
  }

  // Firing slit with the emplacement gun.
  ctx.fillStyle = '#17160f';
  ctx.fillRect(14 * scale, -36 * scale, 26 * scale, 7 * scale);
  const kick = options.flash > 0 ? 3 : 0;
  ctx.fillStyle = '#33332c';
  ctx.fillRect(24 * scale - kick, -35 * scale, 22 * scale, 3.4 * scale);
  if (options.flash > 0) {
    ctx.fillStyle = 'rgba(255, 226, 150, 0.95)';
    ctx.beginPath();
    ctx.moveTo(44 * scale - kick, -33.4 * scale);
    ctx.lineTo((52 + options.flash * 90) * scale, -38 * scale);
    ctx.lineTo((52 + options.flash * 90) * scale, -29 * scale);
    ctx.closePath();
    ctx.fill();
  }

  // Battle damage: cracks that spread as the position is reduced.
  const cracks = Math.round((1 - hp) * 5);
  ctx.strokeStyle = 'rgba(20, 18, 14, 0.75)';
  ctx.lineWidth = 1.1;
  for (let i = 0; i < cracks; i += 1) {
    const seed = Math.round(x * 0.37) + i * 13;
    const sx = (-34 + hash2(seed, 3) * 70) * scale;
    const sy = (-52 + hash2(seed, 7) * 44) * scale;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (hash2(seed, 11) - 0.5) * 16 * scale, sy + 9 * scale);
    ctx.lineTo(sx + (hash2(seed, 17) - 0.5) * 22 * scale, sy + 17 * scale);
    ctx.stroke();
  }

  // Smoke once the position is badly hit.
  if (hp < 0.6) {
    ctx.globalAlpha = (0.6 - hp) * 1.3;
    ctx.fillStyle = 'rgba(52, 50, 46, 0.85)';
    for (let i = 0; i < 5; i += 1) {
      const t = (options.time * 0.5 + i * 0.2) % 1;
      ctx.beginPath();
      ctx.arc(
        (-10 + i * 12) * scale,
        (-58 - t * 34) * scale,
        (5 + t * 12) * scale,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // --- flag: it is lowered as the garrison is worn down ---------------------
  const poleX = x - facing * 46 * scale;
  const poleTop = GROUND_Y - 96 * scale;
  const poleBottom = GROUND_Y - 14 * scale;
  ctx.save();
  ctx.strokeStyle = '#3a352c';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(poleX, poleBottom);
  ctx.lineTo(poleX, poleTop);
  ctx.stroke();
  // The fly end drops with hit points, so the state of a sector is readable
  // from the skyline alone.
  const flagHeight = 20 * scale;
  const flagTop = poleTop + (1 - hp) * (poleBottom - poleTop - flagHeight);
  const wave = Math.sin(options.time * 2.4) * 1.6;
  ctx.fillStyle = options.hit > 0 ? '#f0e6c8' : palette.accent;
  ctx.beginPath();
  ctx.moveTo(poleX, flagTop);
  ctx.lineTo(poleX + facing * (30 * scale + wave), flagTop + 5 * scale);
  ctx.lineTo(poleX, flagTop + flagHeight);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A stack of sandbags left where a gunner dug in. */
export function drawSandbags(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  _side: Side,
  palette: FactionPalette,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(20, 18, 14, 0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 2, 15, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette.webbing;
  for (let row = 0; row < 3; row += 1) {
    for (let i = 0; i < 3 - row; i += 1) {
      ctx.beginPath();
      ctx.ellipse((i - (2 - row) / 2) * 9, -3 - row * 5, 5.2, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * The fallen: the body topples backwards, the helmet is knocked off and arcs
 * away, and a silhouette stays on the ground and fades.
 */
export function drawCorpse(
  ctx: CanvasRenderingContext2D,
  corpse: Corpse,
  palette: FactionPalette,
  secondsSinceDeath: number,
): void {
  const fall = Math.min(1, secondsSinceDeath / CORPSE_FALL_TIME);
  const life = corpse.life / corpse.maxLife;
  const scale = FIGURE_SCALE;

  // Helmet: a simple ballistic arc from where the head was.
  const t = secondsSinceDeath;
  const helmetX = corpse.helmetX + corpse.helmetVx * t;
  const helmetY = corpse.helmetY + corpse.helmetVy * t + 190 * t * t;
  const helmetRest = GROUND_Y - 3;
  const landed = helmetY >= helmetRest;
  const hx = landed ? helmetX + corpse.helmetVx * 0.04 : helmetX;
  const hy = landed ? helmetRest : helmetY;

  drawShadow(ctx, corpse.x + corpse.topple * 10 * scale, GROUND_Y, 20 * scale, 0.24 * life);
  drawShadow(ctx, hx, GROUND_Y, 9 * scale, 0.2 * life);

  // Helmet, spinning as it goes.
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(landed ? Math.PI * 0.5 * 0 + t * 5 : t * 6);
  ctx.scale(scale, scale);
  ctx.globalAlpha = Math.min(1, life * 1.4);
  drawHelmet(ctx, 'brodie', palette);
  ctx.restore();

  // Body: rotate about the boots so it falls backwards.
  ctx.save();
  ctx.translate(corpse.x, GROUND_Y);
  ctx.rotate(corpse.topple * fall * (Math.PI / 2) * 0.94);
  ctx.scale(corpse.facing * scale, scale);
  ctx.globalAlpha = Math.min(1, life * 1.5);
  ctx.fillStyle = '#1d1a15';
  ctx.fillRect(-3, -1.6, 6, 2);
  ctx.fillStyle = palette.uniformDark;
  ctx.beginPath();
  ctx.roundRect(-5.2, -13, 10.4, 13, 1.6);
  ctx.fill();
  ctx.fillStyle = palette.uniform;
  ctx.beginPath();
  ctx.roundRect(-5.4, -29, 11, 17, 2.4);
  ctx.fill();
  ctx.fillStyle = palette.skin;
  ctx.beginPath();
  ctx.arc(0.4, -33.6, 3.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Once it has fallen, what remains on the ground is a silhouette.
  if (fall >= 1) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(0.5, life * 0.5));
    ctx.fillStyle = '#191710';
    ctx.beginPath();
    ctx.ellipse(
      corpse.x + corpse.topple * 13 * scale,
      GROUND_Y - 1.4,
      17 * scale,
      3.2 * scale,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.fillRect(corpse.x + corpse.topple * 12 * scale, GROUND_Y - 3.4, 4 * scale, 2.4);
    ctx.restore();
  }
}

/** A bold portrait for a deployment card: helmet-and-rifle, SMG, MG, tank. */
export function drawUnitIcon(
  ctx: CanvasRenderingContext2D,
  kind: UnitKind,
  palette: FactionPalette,
  helmet: HelmetShape,
  centerX: number,
  baseY: number,
  scale: number,
): void {
  ctx.save();
  // The figure routines draw around GROUND_Y, and that translate happens inside
  // the scaled space — so the offset here has to be scaled too, or the portrait
  // lands off the bottom of the card.
  ctx.translate(centerX, baseY - GROUND_Y * scale);
  ctx.scale(scale, scale);
  if (kind === 'tank') {
    // Chassis only: tracks, hull, turret and gun, so the silhouette reads.
    //
    // The chassis is drawn around (0,0) upward, whereas drawSoldier puts itself
    // on the ground line first — so the baseline translate has to happen here
    // too. Without it the portrait lands a whole GROUND_Y above the card.
    ctx.translate(0, GROUND_Y);
    ctx.translate(0, -8);
    ctx.scale(1.45, 1.45);
    drawShadow(ctx, 0, 0, 56, 0.22);
    ctx.fillStyle = '#20201c';
    ctx.beginPath();
    ctx.roundRect(-28, -14, 56, 14, 5);
    ctx.fill();
    ctx.fillStyle = '#4d4d44';
    for (let i = -18; i <= 18; i += 12) {
      ctx.beginPath();
      ctx.arc(i, -7, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = palette.uniform;
    ctx.beginPath();
    ctx.moveTo(-26, -14);
    ctx.lineTo(22, -14);
    ctx.lineTo(28, -24);
    ctx.lineTo(-26, -24);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(-11, -36, 24, 11, 3);
    ctx.fill();
    ctx.fillStyle = '#33332c';
    ctx.fillRect(9, -35, 22, 3.2);
  } else {
    drawSoldier(ctx, {
      x: 0,
      palette,
      helmet,
      kind,
      facing: 1,
      time: 0,
      phase: 0,
      walking: false,
      dugIn: false,
      hpFraction: 1,
      spawn: 1,
      recoil: 0,
      illuminated: false,
      stagger: 0,
    });
    if (kind === 'mg') {
      // Sandbag pile beside the gunner to signal "digs in".
      ctx.fillStyle = palette.webbing;
      for (let row = 0; row < 2; row += 1) {
        for (let i = 0; i < 3 - row; i += 1) {
          ctx.beginPath();
          ctx.ellipse(-14 + (i - (2 - row) / 2) * 9, -4 - row * 5, 5, 3.1, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.restore();
}
