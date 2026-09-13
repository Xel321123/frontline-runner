/**
 * Procedural battlefield terrain.
 *
 * Four depth layers, each drawn from Canvas 2D paths with content that is
 * deterministic per tile index (so nothing pops as the camera drifts):
 *
 *   1. horizon    — sky gradient, low sun, drifting cloud bands
 *   2. distance   — rolling hills and treeline silhouettes
 *   3. middle     — ruined buildings, church towers, burning columns of smoke
 *   4. foreground — the ground plane the units walk on: road, craters, grass,
 *                   barbed wire, rubble and scattered materiel
 *
 * Parallax comes from the battle's focus point: layers further away move less,
 * so as the front line swings toward one base the depth reads immediately.
 * Plumes, smoke and the sun are animated from `time` alone, which keeps the
 * renderer a pure function of the simulation state.
 */

import { createRng } from '../game/rng';
import { GROUND_Y, VIEW_HEIGHT, VIEW_WIDTH } from '../game/constants';
import type { Environment } from '../data/campaignData';
import { SCENE_LOOKS, sceneLook, type SceneLook } from './palette';

const HORIZON_Y = 430;

/** Layer depths — multiplier applied to the camera's focus offset. */
const DEPTH = {
  hills: 0.08,
  ruins: 0.2,
  middle: 0.42,
  ground: 1,
} as const;

interface Plume {
  readonly x: number;
  readonly scale: number;
  readonly speed: number;
}

/** Fixed burning columns of smoke on the horizon. */
const PLUMES: readonly Plume[] = [
  { x: 140, scale: 1, speed: 0.8 },
  { x: 520, scale: 0.7, speed: 1.1 },
  { x: 760, scale: 1.3, speed: 0.65 },
  { x: 1120, scale: 0.85, speed: 0.95 },
];

function paintSky(ctx: CanvasRenderingContext2D, look: SceneLook, time: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON_Y + 40);
  sky.addColorStop(0, look.skyTop);
  sky.addColorStop(0.55, look.skyMid);
  sky.addColorStop(1, look.skyHaze);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VIEW_WIDTH, HORIZON_Y + 40);

  // Low sun behind the haze, just above the horizon.
  const sunX = 300;
  const sunY = HORIZON_Y - 60;
  const glow = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, 190);
  glow.addColorStop(0, 'rgba(255, 226, 170, 0.42)');
  glow.addColorStop(1, 'rgba(255, 214, 150, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sunX - 200, sunY - 200, 400, 400);
  ctx.fillStyle = 'rgba(246, 224, 176, 0.55)';
  ctx.beginPath();
  ctx.arc(sunX, sunY, 22, 0, Math.PI * 2);
  ctx.fill();

  // Cloud bands drifting slowly sideways.
  ctx.fillStyle = look.cloud;
  for (let i = 0; i < 5; i += 1) {
    const drift = ((time * 3 + i * 260) % (VIEW_WIDTH + 400)) - 200;
    const y = 60 + i * 46;
    ctx.beginPath();
    ctx.ellipse(drift, y, 150 + i * 18, 12 + i * 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintHills(
  ctx: CanvasRenderingContext2D,
  look: SceneLook,
  offset: number,
): void {
  const rng = createRng('hills');
  ctx.fillStyle = look.hillFar;
  ctx.beginPath();
  ctx.moveTo(-40, HORIZON_Y + 10);
  let x = -40;
  while (x < VIEW_WIDTH + 60) {
    const width = rng.range(90, 190);
    const height = rng.range(22, 54);
    ctx.quadraticCurveTo(x + width * 0.5 + offset * 0.12, HORIZON_Y - height, x + width, HORIZON_Y + 4);
    x += width;
  }
  ctx.lineTo(VIEW_WIDTH + 60, HORIZON_Y + 40);
  ctx.lineTo(-40, HORIZON_Y + 40);
  ctx.closePath();
  ctx.fill();

  // A nearer, darker ridge over the top.
  const rng2 = createRng('ridge');
  ctx.fillStyle = look.hillNear;
  ctx.beginPath();
  ctx.moveTo(-40, HORIZON_Y + 26);
  x = -40;
  while (x < VIEW_WIDTH + 60) {
    const width = rng2.range(140, 260);
    const height = rng2.range(14, 34);
    ctx.quadraticCurveTo(x + width * 0.5 + offset * 0.2, HORIZON_Y - height + 8, x + width, HORIZON_Y + 20);
    x += width;
  }
  ctx.lineTo(VIEW_WIDTH + 60, HORIZON_Y + 60);
  ctx.lineTo(-40, HORIZON_Y + 60);
  ctx.closePath();
  ctx.fill();
}

/** Ruined buildings and church towers along the distant skyline. */
function paintRuins(ctx: CanvasRenderingContext2D, look: SceneLook, offset: number): void {
  const rng = createRng('ruins');
  const baseY = HORIZON_Y + 34;

  for (let i = 0; i < 9; i += 1) {
    const width = rng.range(34, 76);
    const height = rng.range(28, 88);
    const x = -80 + i * 168 + rng.range(-24, 24) - offset * DEPTH.ruins;
    const broken = rng.chance(0.55);

    ctx.fillStyle = i % 2 === 0 ? look.ruinFar : look.ruinNear;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x, baseY - height);
    // Ragged roofline: shelled buildings lose their top corner.
    if (broken) {
      ctx.lineTo(x + width * 0.45, baseY - height * 0.72);
      ctx.lineTo(x + width * 0.6, baseY - height);
    }
    ctx.lineTo(x + width, baseY - height);
    ctx.lineTo(x + width, baseY);
    ctx.closePath();
    ctx.fill();

    // A few window slits.
    ctx.fillStyle = 'rgba(18, 18, 16, 0.5)';
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 2; col += 1) {
        if (rng.chance(0.25)) continue;
        ctx.fillRect(
          x + 8 + col * (width * 0.42),
          baseY - height + 12 + row * 20,
          width * 0.16,
          8,
        );
      }
    }
  }

  // Church tower with a broken spire on the right of the field.
  const towerX = VIEW_WIDTH - 210 - offset * DEPTH.ruins;
  ctx.fillStyle = look.ruinNear;
  ctx.fillRect(towerX, baseY - 116, 34, 116);
  ctx.beginPath();
  ctx.moveTo(towerX - 4, baseY - 116);
  ctx.lineTo(towerX + 17, baseY - 158);
  ctx.lineTo(towerX + 22, baseY - 128);
  ctx.lineTo(towerX + 38, baseY - 116);
  ctx.closePath();
  ctx.fill();
}

/** Burning smoke columns rising from the distant battlefield. */
function paintSmokeColumns(ctx: CanvasRenderingContext2D, look: SceneLook, time: number): void {
  for (const plume of PLUMES) {
    const baseX = plume.x;
    const scale = plume.scale;
    for (let i = 0; i < 9; i += 1) {
      const t = (time * plume.speed * 0.35 + i / 9) % 1;
      const rise = t * 190;
      const spread = 10 + t * 30 * scale;
      const drift = Math.sin(time * 0.5 + i) * 10 * t;
      const alpha = 0.26 * (1 - t) * scale;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = t < 0.25 ? '#3c3a34' : look.smokeFar;
      ctx.beginPath();
      ctx.arc(baseX + drift, HORIZON_Y + 26 - rise, spread, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Mid-ground: broken walls, dead trees and hedgerow clumps. */
function paintMiddle(ctx: CanvasRenderingContext2D, look: SceneLook, offset: number): void {
  const rng = createRng('middle');
  const baseY = GROUND_Y - 6;

  for (let i = 0; i < 7; i += 1) {
    const x = -60 + i * 208 + rng.range(-30, 30) - offset * DEPTH.middle;
    if (rng.chance(0.5)) {
      // Shell-damaged wall: a low block with a jagged top.
      const width = rng.range(70, 130);
      const height = rng.range(18, 34);
      ctx.fillStyle = look.ruinNear;
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x, baseY - height);
      ctx.lineTo(x + width * 0.3, baseY - height * 0.7);
      ctx.lineTo(x + width * 0.6, baseY - height);
      ctx.lineTo(x + width, baseY - height * 0.8);
      ctx.lineTo(x + width, baseY);
      ctx.closePath();
      ctx.fill();
    } else {
      // Dead tree: bare trunk with broken limbs.
      const height = rng.range(46, 84);
      ctx.strokeStyle = '#2a2620';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x + 2, baseY - height);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 2, baseY - height * 0.62);
      ctx.lineTo(x - 14, baseY - height * 0.84);
      ctx.moveTo(x + 2, baseY - height * 0.74);
      ctx.lineTo(x + 18, baseY - height * 0.92);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** The ground the units walk on: road, craters, grass tufts and debris. */
function paintGround(
  ctx: CanvasRenderingContext2D,
  look: SceneLook,
  offset: number,
  time: number,
): void {
  const top = HORIZON_Y + 30;

  const ground = ctx.createLinearGradient(0, top, 0, VIEW_HEIGHT);
  ground.addColorStop(0, look.groundFar);
  ground.addColorStop(0.55, look.groundMid);
  ground.addColorStop(1, look.groundNear);
  ctx.fillStyle = ground;
  ctx.fillRect(0, top, VIEW_WIDTH, VIEW_HEIGHT - top);

  // Worn track the troops advance along.
  ctx.fillStyle = look.road;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y - 12);
  ctx.lineTo(VIEW_WIDTH, GROUND_Y - 16);
  ctx.lineTo(VIEW_WIDTH, GROUND_Y + 16);
  ctx.lineTo(0, GROUND_Y + 12);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(30, 28, 22, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 13);
  ctx.lineTo(VIEW_WIDTH, GROUND_Y + 17);
  ctx.stroke();

  // Deterministic ground detail, tiled so it scrolls with the camera.
  const tile = 160;
  const baseIndex = Math.floor(offset / tile);
  for (let i = -1; i <= Math.ceil(VIEW_WIDTH / tile) + 1; i += 1) {
    const tileIndex = baseIndex + i;
    const x = i * tile - (offset - baseIndex * tile);
    const rng = createRng(`ground:${tileIndex}`);

    // Craters.
    const craters = rng.int(0, 2);
    for (let c = 0; c < craters; c += 1) {
      const cx = x + rng.range(10, tile - 10);
      const cy = GROUND_Y + rng.range(12, 74);
      const rx = rng.range(16, 38);
      ctx.fillStyle = look.crater;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, rx * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(90, 82, 62, 0.35)';
      ctx.beginPath();
      ctx.ellipse(cx, cy - 3, rx * 0.8, rx * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Grass tufts and stones.
    for (let g = 0; g < 12; g += 1) {
      const gx = x + rng.range(0, tile);
      const gy = GROUND_Y + rng.range(-14, 96);
      ctx.strokeStyle = rng.chance(0.5) ? look.grass : look.grassDark;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + rng.range(-2.5, 2.5), gy - rng.range(4, 9));
      ctx.stroke();
    }

    // Barbed-wire pickets in the near foreground.
    if (tileIndex % 3 === 0) {
      for (let w = 0; w < 5; w += 1) {
        const wx = x + 20 + w * 26;
        const wy = GROUND_Y + 76;
        ctx.strokeStyle = 'rgba(40, 38, 32, 0.8)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(wx, wy);
        ctx.lineTo(wx + 1.5, wy - 18);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(150, 146, 132, 0.4)';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(wx - 12, wy - 12);
        ctx.lineTo(wx + 16, wy - 14);
        ctx.moveTo(wx - 12, wy - 6);
        ctx.lineTo(wx + 16, wy - 8);
        ctx.stroke();
      }
    }

    // Spent equipment: crates, ammo tins and helmets on the ground.
    if (tileIndex % 4 === 1) {
      const bx = x + rng.range(20, tile - 40);
      const by = GROUND_Y + rng.range(24, 70);
      ctx.fillStyle = '#5a4b30';
      ctx.fillRect(bx, by, 16, 10);
      ctx.fillStyle = 'rgba(20, 18, 14, 0.5)';
      ctx.fillRect(bx, by + 3.4, 16, 1.6);
      ctx.fillStyle = '#4b5540';
      ctx.beginPath();
      ctx.arc(bx + 30, by + 8, 5, Math.PI, 0);
      ctx.fill();
    }
  }

  // Heat shimmer / dust haze over the field, animated from time alone.
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#c9b78d';
  for (let i = 0; i < 3; i += 1) {
    const drift = Math.sin(time * 0.4 + i * 2) * 40;
    ctx.beginPath();
    ctx.ellipse(VIEW_WIDTH * (0.2 + i * 0.3) + drift, GROUND_Y - 30 - i * 12, 260, 22, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export interface BattlefieldOptions {
  /** Camera focus in world px (the battle's centre of mass). */
  readonly focusX: number;
  readonly time: number;
}

export class Battlefield {
  private look: SceneLook = SCENE_LOOKS.standard;

  /**
   * Re-light the whole scene for this sector's weather. Cheap enough to call
   * every frame: it is one reference assignment.
   */
  setEnvironment(environment: Environment): void {
    this.look = sceneLook(environment);
  }

  /** Draw every depth layer, far to near. */
  draw(ctx: CanvasRenderingContext2D, options: BattlefieldOptions): void {
    const { focusX, time } = options;
    const offset = focusX - VIEW_WIDTH / 2;
    const look = this.look;

    paintSky(ctx, look, time);
    ctx.save();
    ctx.translate(-offset * DEPTH.hills, 0);
    paintHills(ctx, look, offset);
    ctx.restore();

    ctx.save();
    ctx.translate(-offset * DEPTH.ruins * 0.4, 0);
    paintRuins(ctx, look, offset);
    paintSmokeColumns(ctx, look, time);
    ctx.restore();

    paintMiddle(ctx, look, offset);
    paintGround(ctx, look, offset, time);
  }
}
