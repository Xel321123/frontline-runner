/**
 * Procedural figures — soldiers, tanks, strongpoints, sandbags and the fallen.
 *
 * No sprite sheets and no image loading: every unit is drawn from Canvas 2D
 * paths, which is what lets a 34 px soldier still read as a soldier. Silhouette
 * is doing the work — the uniform colours and the helmet shape (Brodie / M1 for
 * the Allies, Stahlhelm for the Axis) are what separate the two armies.
 *
 * Figures are drawn in a local space whose origin is the unit's feet, with
 * `facing` applied as a mirror, so every routine is written facing right.
 */

import type { UnitKind } from '../game/units';
import type { Corpse, Side } from '../game/tugTypes';
import { GROUND_Y } from '../game/constants';
import { drawShadow } from './effects';
import { SCENE, type FactionPalette, type HelmetShape } from './palette';

/** Deterministic 0..1 from two integers — stable "randomness" for cracks etc. */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/**
 * Figures are authored at roughly 34 px tall and then scaled up: on a 1280-wide
 * field that is the difference between "there are tiny specks fighting" and
 * "that is an infantry section". Collision radii and formation spacing in
 * `units.ts` are tuned to match this factor.
 */
export const FIGURE_SCALE = 1.3;

export interface SoldierOptions {
  readonly x: number;
  readonly kind: UnitKind;
  readonly palette: FactionPalette;
  readonly helmet: HelmetShape;
  readonly facing: 1 | -1;
  readonly time: number;
  /** Walk-cycle phase owner, so soldiers do not march in lockstep. */
  readonly phase: number;
  readonly walking: boolean;
  readonly dugIn: boolean;
  readonly hpFraction: number;
  readonly spawn: number;
  readonly recoil: number;
  readonly suppressed: boolean;
}

function drawHelmet(
  ctx: CanvasRenderingContext2D,
  shape: HelmetShape,
  palette: FactionPalette,
): void {
  // Head is centred on x = 0, crown at y = -34.
  ctx.fillStyle = palette.skin;
  ctx.beginPath();
  ctx.arc(0, -30, 3.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = palette.helmet;
  if (shape === 'brodie') {
    // Wide flat brim with a shallow dome sitting on it.
    ctx.beginPath();
    ctx.ellipse(0, -32.4, 7.6, 1.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, -32.6, 4.6, Math.PI, 0);
    ctx.fill();
  } else if (shape === 'm1') {
    // Round dome with a thin, all-round lip.
    ctx.beginPath();
    ctx.arc(0, -31.4, 4.9, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    ctx.fillRect(-5.4, -31.6, 10.8, 1.4);
  } else {
    // Stahlhelm: dome with a flared skirt that drops down the back.
    ctx.beginPath();
    ctx.arc(0, -31.6, 5.2, Math.PI, 0);
    ctx.lineTo(6.2, -27.4);
    ctx.lineTo(4.4, -28.6);
    ctx.lineTo(-4.4, -28.6);
    ctx.lineTo(-6.2, -27.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = palette.helmetDark;
    ctx.fillRect(-6.2, -29.6, 12.4, 1.4);
  }

  ctx.fillStyle = palette.helmetDark;
  ctx.fillRect(-4.4, -33.4, 8.8, 1);
}

/** Weapon silhouettes, drawn from the shoulder pivot at (0, -24). */
function drawWeapon(
  ctx: CanvasRenderingContext2D,
  kind: UnitKind,
  recoil: number,
): { muzzleX: number; muzzleY: number } {
  const kick = -recoil * 2;
  ctx.save();
  ctx.translate(kick, 0);

  if (kind === 'rifleman') {
    ctx.fillStyle = '#3a2a1c';
    ctx.beginPath();
    ctx.moveTo(-3, -21);
    ctx.lineTo(4, -22.2);
    ctx.lineTo(4, -18.6);
    ctx.lineTo(-3, -19.6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#26241f';
    ctx.fillRect(4, -21.6, 15, 1.8);
    ctx.fillRect(12, -20.4, 2.4, 3);
    ctx.restore();
    return { muzzleX: 19, muzzleY: -21 };
  }

  if (kind === 'smg') {
    ctx.fillStyle = '#2b2924';
    ctx.fillRect(-1, -23, 13, 2.4);
    ctx.fillStyle = '#1f1e1a';
    ctx.fillRect(3, -20.6, 2.6, 6); // box magazine
    ctx.fillRect(-4, -22.4, 5, 1.6); // wire stock
    ctx.restore();
    return { muzzleX: 12, muzzleY: -21.8 };
  }

  // MG: heavier barrel, bipod, ammunition belt.
  ctx.fillStyle = '#23221e';
  ctx.fillRect(2, -24.4, 18, 3);
  ctx.fillStyle = '#2f2d27';
  ctx.fillRect(16, -25, 4, 4); // flash hider
  ctx.strokeStyle = '#2f2d27';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(9, -21.4);
  ctx.lineTo(6, -14);
  ctx.moveTo(9, -21.4);
  ctx.lineTo(12, -14);
  ctx.stroke();
  ctx.fillStyle = SCENE.brass;
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(2 + i * 2.4, -19.8, 1.4, 1.2);
  }
  ctx.restore();
  return { muzzleX: 20, muzzleY: -22.9 };
}

export function drawSoldier(
  ctx: CanvasRenderingContext2D,
  options: SoldierOptions,
): { muzzleX: number; muzzleY: number } {
  const { palette, facing, kind } = options;
  const scale = (0.65 + options.spawn * 0.35) * FIGURE_SCALE;

  drawShadow(ctx, options.x, GROUND_Y, (15 + options.spawn * 3) * FIGURE_SCALE, 0.3 * options.spawn);

  ctx.save();
  ctx.translate(options.x, GROUND_Y);
  ctx.scale(facing * scale, scale);
  ctx.globalAlpha = Math.min(1, options.spawn * 1.6);

  // Legs: a walk cycle while advancing, braced when firing.
  const swing = options.walking ? Math.sin(options.time * 9 + options.phase) * 4 : 0;
  ctx.fillStyle = palette.uniformDark;
  ctx.fillRect(-4 + swing * 0.5, -15, 4.4, 15);
  ctx.fillRect(0.4 - swing * 0.5, -15, 4.4, 15);
  ctx.fillStyle = '#2a2620';
  ctx.fillRect(-4.6 + swing * 0.5, -2.6, 5.4, 2.6);
  ctx.fillRect(0 - swing * 0.5, -2.6, 5.4, 2.6);

  // Pack and torso.
  ctx.fillStyle = palette.uniformDark;
  ctx.beginPath();
  ctx.roundRect(-8.4, -27, 5, 9, 1.6);
  ctx.fill();

  ctx.fillStyle = palette.uniform;
  ctx.beginPath();
  ctx.roundRect(-6, -28, 12, 14, 2.4);
  ctx.fill();

  // Webbing straps.
  ctx.strokeStyle = palette.webbing;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-4, -27.4);
  ctx.lineTo(1, -15.6);
  ctx.moveTo(3, -27.4);
  ctx.lineTo(3.4, -15.6);
  ctx.stroke();

  // The head sits above the collar.
  drawHelmet(ctx, options.helmet, palette);

  // Arms: leading arm supports the weapon, the other is tucked in.
  const weapon = drawWeapon(ctx, kind, options.recoil);
  ctx.strokeStyle = palette.uniformLight;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(1, -25.4);
  ctx.lineTo(6.4, -23);
  ctx.stroke();

  if (options.dugIn) {
    // Sandbag parapet in front of a dug-in gunner.
    ctx.fillStyle = '#7a6f4f';
    ctx.beginPath();
    ctx.roundRect(6, -12, 16, 5, 2);
    ctx.roundRect(7, -7, 15, 5, 2);
    ctx.fill();
  }

  ctx.restore();

  return {
    muzzleX: options.x + facing * weapon.muzzleX * scale,
    muzzleY: GROUND_Y + weapon.muzzleY * scale,
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
  readonly rolling: boolean;
}

export function drawTank(
  ctx: CanvasRenderingContext2D,
  options: TankOptions,
): { muzzleX: number; muzzleY: number } {
  const { palette, facing } = options;
  const scale = (0.7 + options.spawn * 0.3) * FIGURE_SCALE;

  drawShadow(ctx, options.x, GROUND_Y, 62 * scale, 0.36 * options.spawn);

  ctx.save();
  ctx.translate(options.x, GROUND_Y);
  ctx.scale(facing * scale, scale);
  ctx.globalAlpha = Math.min(1, options.spawn * 1.6);

  // Tracks with road wheels.
  ctx.fillStyle = palette.track;
  ctx.beginPath();
  ctx.roundRect(-30, -15, 60, 15, 5);
  ctx.fill();
  ctx.fillStyle = '#4a453c';
  for (let i = 0; i < 5; i += 1) {
    const wheelPhase = options.rolling ? Math.sin(options.time * 6 + i) * 0.4 : 0;
    ctx.beginPath();
    ctx.arc(-22 + i * 11, -8 + wheelPhase, 4.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(20, 18, 14, 0.8)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 9; i += 1) {
    ctx.beginPath();
    ctx.moveTo(-28 + i * 7, -15);
    ctx.lineTo(-28 + i * 7, -1);
    ctx.stroke();
  }

  // Hull with a sloped glacis plate at the front.
  ctx.fillStyle = palette.vehicle;
  ctx.beginPath();
  ctx.moveTo(-30, -15);
  ctx.lineTo(-30, -30);
  ctx.lineTo(20, -30);
  ctx.lineTo(30, -19);
  ctx.lineTo(30, -15);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = palette.vehicleDark;
  ctx.beginPath();
  ctx.moveTo(20, -30);
  ctx.lineTo(30, -19);
  ctx.lineTo(30, -15);
  ctx.lineTo(24, -15);
  ctx.closePath();
  ctx.fill();

  // Neutral recognition band on the hull.
  ctx.fillStyle = palette.accent;
  ctx.globalAlpha *= 0.55;
  ctx.fillRect(-14, -27, 12, 2.6);
  ctx.globalAlpha = Math.min(1, options.spawn * 1.6);

  // Turret, mantlet and gun.
  ctx.fillStyle = palette.vehicleDark;
  ctx.beginPath();
  ctx.roundRect(-14, -42, 26, 13, 3);
  ctx.fill();
  ctx.fillStyle = palette.vehicle;
  ctx.beginPath();
  ctx.roundRect(-12, -41, 22, 9, 3);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-6, -44, 3.4, Math.PI, 0);
  ctx.fill();

  const kick = -options.recoil * 3;
  ctx.save();
  ctx.translate(kick, 0);
  ctx.rotate(-0.04);
  ctx.fillStyle = '#26241f';
  ctx.fillRect(10, -37.4, 24, 3.2);
  ctx.fillRect(30, -38.4, 4.6, 5.2);
  ctx.restore();

  // Battle damage: scorch patches and a sooty exhaust once the hull is opened up.
  if (options.hpFraction < 0.75) {
    const severity = 1 - options.hpFraction;
    ctx.save();
    ctx.globalAlpha = 0.35 * severity;
    ctx.fillStyle = '#1d1a16';
    ctx.beginPath();
    ctx.arc(-18 + hash2(options.x | 0, 3) * 26, -26, 6 + severity * 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (severity > 0.35) {
      ctx.save();
      ctx.globalAlpha = 0.2 + severity * 0.3;
      ctx.fillStyle = '#494640';
      for (let i = 0; i < 3; i += 1) {
        const rise = ((options.time * 22 + i * 26) % 46) + 4;
        ctx.beginPath();
        ctx.arc(-26 + Math.sin(options.time + i) * 4, -32 - rise, 5 + severity * 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // Radio antenna.
  ctx.strokeStyle = 'rgba(30, 28, 24, 0.9)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(-12, -42);
  ctx.quadraticCurveTo(-18, -54, -14, -62);
  ctx.stroke();

  ctx.restore();

  return {
    muzzleX: options.x + facing * 34 * scale,
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
  readonly smoke: number;
  readonly hit: number;
  readonly label: string;
}

/** A fortified strongpoint: concrete slab, embrasure, sandbags and a flag. */
export function drawStrongpoint(
  ctx: CanvasRenderingContext2D,
  options: StrongpointOptions,
): void {
  const { palette, side } = options;
  const facing: 1 | -1 = side === 'player' ? 1 : -1;
  const damaged = 1 - options.hpFraction;

  drawShadow(ctx, options.x, GROUND_Y, 108, 0.34);

  ctx.save();
  ctx.translate(options.x, GROUND_Y);
  ctx.scale(facing, 1);

  // Rubble skirt at the base.
  ctx.fillStyle = '#3a352c';
  ctx.beginPath();
  ctx.moveTo(-56, 0);
  ctx.lineTo(-44, -8);
  ctx.lineTo(46, -8);
  ctx.lineTo(56, 0);
  ctx.closePath();
  ctx.fill();

  // Main bunker mass with an overhanging roof slab.
  ctx.fillStyle = '#5c5a51';
  ctx.beginPath();
  ctx.moveTo(-46, -8);
  ctx.lineTo(-40, -58);
  ctx.lineTo(38, -58);
  ctx.lineTo(46, -8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6a675c';
  ctx.beginPath();
  ctx.roundRect(-48, -64, 92, 8, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(24, 22, 18, 0.35)';
  ctx.beginPath();
  ctx.moveTo(-40, -58);
  ctx.lineTo(38, -58);
  ctx.lineTo(38, -54);
  ctx.lineTo(-40, -54);
  ctx.closePath();
  ctx.fill();

  // Embrasure with the defensive gun poking out toward the field.
  ctx.fillStyle = '#181713';
  ctx.fillRect(10, -44, 26, 9);
  ctx.fillStyle = '#26241f';
  ctx.fillRect(30, -42.4, 22, 4.4);
  ctx.fillStyle = '#33302a';
  ctx.fillRect(-38, -50, 14, 6);

  // Sandbag parapet, stacked in overlapping rows.
  ctx.fillStyle = '#7a6f4f';
  for (let row = 0; row < 3; row += 1) {
    const rowY = -10 - row * 5.5;
    const inset = row * 2;
    for (let i = 0; i < 6; i += 1) {
      ctx.beginPath();
      ctx.roundRect(-52 + inset + i * 17, rowY, 15, 6, 2.6);
      ctx.fill();
    }
  }
  ctx.fillStyle = 'rgba(30, 26, 18, 0.25)';
  for (let i = 0; i < 6; i += 1) {
    ctx.fillRect(-52 + i * 17, -11, 15, 2);
  }

  // Damage: cracks appear and lengthen as the structure is shelled.
  const crackCount = Math.round(damaged * 7);
  ctx.strokeStyle = 'rgba(20, 18, 15, 0.7)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < crackCount; i += 1) {
    const seedX = hash2(options.x | 0, i * 31);
    const seedY = hash2(i * 17, options.x | 0);
    const startX = -36 + seedX * 70;
    const startY = -56 + seedY * 40;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(startX + (hash2(i, 7) - 0.5) * 16, startY + 6 + hash2(i, 3) * 14);
    ctx.lineTo(startX + (hash2(i, 11) - 0.5) * 22, startY + 14 + hash2(i, 5) * 18);
    ctx.stroke();
  }

  // Flag on a pole, waving with time.
  ctx.strokeStyle = '#2f2c26';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-30, -64);
  ctx.lineTo(-30, -100);
  ctx.stroke();
  ctx.fillStyle = palette.accent;
  const wave = Math.sin(options.time * 2.4) * 2.2;
  ctx.beginPath();
  ctx.moveTo(-30, -99);
  ctx.quadraticCurveTo(-16, -97 + wave, -4, -95 - wave);
  ctx.lineTo(-4, -86);
  ctx.quadraticCurveTo(-16, -88 - wave, -30, -86);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  // Muzzle flash from the embrasure, and roof smoke as it burns.
  if (options.flash > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, options.flash * 12);
    ctx.fillStyle = '#fff0c0';
    ctx.beginPath();
    ctx.moveTo(options.x + facing * 52, GROUND_Y - 40);
    ctx.lineTo(options.x + facing * 70, GROUND_Y - 45);
    ctx.lineTo(options.x + facing * 70, GROUND_Y - 34);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  if (options.smoke > 0.02) {
    ctx.save();
    ctx.globalAlpha = 0.22 + options.smoke * 0.3;
    ctx.fillStyle = '#4a4741';
    for (let i = 0; i < 4; i += 1) {
      const drift = Math.sin(options.time * 0.7 + i) * 9;
      const rise = ((options.time * 16 + i * 34) % 130) + 8;
      ctx.beginPath();
      ctx.arc(-10 + drift + i * 7, GROUND_Y - 66 - rise, 8 + options.smoke * 10, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Scorch tint right after a hit.
  if (options.hit > 0) {
    ctx.save();
    ctx.globalAlpha = options.hit * 0.5;
    ctx.fillStyle = '#ffd9a0';
    ctx.fillRect(options.x - 52, GROUND_Y - 64, 104, 64);
    ctx.restore();
  }

  // A compact field health bar so the objective reads without the HUD.
  const barW = 92;
  const barX = options.x - barW / 2;
  const barY = GROUND_Y - 116;
  ctx.fillStyle = 'rgba(12, 14, 12, 0.72)';
  ctx.fillRect(barX - 1, barY - 1, barW + 2, 8);
  const fraction = Math.max(0, Math.min(1, options.hpFraction));
  ctx.fillStyle = side === 'player' ? SCENE.playerHp : SCENE.enemyHp;
  ctx.fillRect(barX, barY, barW * fraction, 6);

  ctx.font = '600 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = SCENE.hud;
  ctx.fillText(options.label, options.x, barY - 6);
  ctx.textAlign = 'left';
}

/** A stack of sandbags left where a gunner dug in. */
export function drawSandbags(
  ctx: CanvasRenderingContext2D,
  x: number,
  palette: FactionPalette,
): void {
  ctx.save();
  drawShadow(ctx, x, GROUND_Y, 34, 0.26);
  ctx.fillStyle = palette.webbing;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.roundRect(x - 16, GROUND_Y - 12, 14, 6, 2.6);
  ctx.roundRect(x - 2, GROUND_Y - 12, 14, 6, 2.6);
  ctx.roundRect(x - 9, GROUND_Y - 6, 15, 6, 2.6);
  ctx.fill();
  ctx.restore();
}

/** A fallen figure: a dark silhouette that fades where it dropped. */
export function drawCorpse(
  ctx: CanvasRenderingContext2D,
  corpse: Corpse,
  palette: FactionPalette,
): void {
  const fade = Math.max(0, corpse.life / corpse.maxLife);
  ctx.save();
  ctx.globalAlpha = 0.55 * fade;
  ctx.translate(corpse.x, GROUND_Y);
  ctx.scale(corpse.facing, 1);

  ctx.fillStyle = 'rgba(58, 30, 26, 0.5)';
  ctx.beginPath();
  ctx.ellipse(0, 1, 13, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = palette.uniformDark;
  ctx.beginPath();
  ctx.roundRect(-11, -5, 22, 5, 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(-6, -8, 9, 4, 1.6);
  ctx.fill();
  ctx.fillStyle = palette.helmetDark;
  ctx.beginPath();
  ctx.arc(6, -8.6, 3.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * A small portrait of a unit for the deployment bar. Reuses the battlefield
 * drawing routines at a reduced scale, so the button shows the actual unit
 * rather than a generic glyph.
 */
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
  // The figure routines draw around GROUND_Y; shift them onto the slot.
  ctx.translate(centerX, baseY - GROUND_Y);
  ctx.scale(scale, scale);
  if (kind === 'tank') {
    drawTank(ctx, {
      x: 0,
      palette,
      facing: 1,
      time: 0,
      hpFraction: 1,
      spawn: 1,
      recoil: 0,
      rolling: false,
    });
  } else {
    drawSoldier(ctx, {
      x: 0,
      kind,
      palette,
      helmet,
      facing: 1,
      time: 0,
      phase: 0,
      walking: false,
      dugIn: kind === 'mg',
      hpFraction: 1,
      spawn: 1,
      recoil: 0,
      suppressed: false,
    });
  }
  ctx.restore();
}
