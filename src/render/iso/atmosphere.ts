/**
 * The world around the battlefield, and the weather in front of it.
 *
 * Two passes:
 *  - `paintSurround` runs *before* the world, filling the viewport with the
 *    environment's sky and haze. The ground plane is painted on top of it, so
 *    the diamond of the field sits in a believable landscape instead of floating
 *    on black — which is what makes the isometric camera read as a camera.
 *  - `drawAtmosphere` runs *after* the world, in screen space: precipitation,
 *    the darkness of a night battle, sweeping searchlight beams and the corner
 *    vignette. Doing it here is what keeps the weather covering the whole
 *    viewport at any zoom instead of only the ground.
 *
 * Everything is seeded from `time`, so the weather is the same on every client
 * for the same moment of the same battle.
 */

import type { EnvironmentRules, SearchlightPool } from '../../game/environment';
import { SEARCHLIGHT_RADIUS } from '../../game/environment';
import { WORLD_H, WORLD_W } from '../../game/constants';
import type { Camera } from '../../platform/Viewport';
import { worldToScreen } from '../../platform/Viewport';

export interface AtmosphereOptions {
  readonly camera: Camera;
  readonly rules: EnvironmentRules;
  readonly time: number;
  readonly searchlights: readonly SearchlightPool[];
}

/** Sky, haze and haze band, painted behind the ground plane. */
export function paintSurround(ctx: CanvasRenderingContext2D, o: AtmosphereOptions): void {
  const { camera, rules } = o;
  const look = rules.look;
  const sky = ctx.createLinearGradient(0, 0, 0, camera.cssHeight);
  sky.addColorStop(0, look.skyTop);
  sky.addColorStop(0.34, look.skyMid);
  sky.addColorStop(0.58, look.skyHorizon);
  sky.addColorStop(1, look.surround);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);

  // A low sun / moon glow on the horizon, which gives the haze a direction
  // instead of a flat wash.
  const sunY = camera.cssHeight * 0.52;
  const sunX = camera.cssWidth * (rules.id === 'night' ? 0.74 : 0.24);
  const glow = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, camera.cssWidth * 0.42);
  glow.addColorStop(0, rules.id === 'night' ? 'rgba(150, 175, 220, 0.22)' : 'rgba(255, 232, 178, 0.3)');
  glow.addColorStop(1, 'rgba(255, 232, 178, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);
}

/** Weather, darkness, beams and vignette, over the finished world pass. */
export function drawAtmosphere(ctx: CanvasRenderingContext2D, o: AtmosphereOptions): void {
  const { camera, rules, time } = o;
  const look = rules.look;

  switch (look.weather) {
    case 'snow':
      drawSnow(ctx, camera, time);
      break;
    case 'sand':
      drawSand(ctx, camera, time);
      break;
    case 'rain':
      drawRain(ctx, camera, time);
      break;
    default:
      break;
  }

  // The haze band: a soft wash that makes distance read, strongest where the
  // ground meets the sky.
  if (look.haze !== 'rgba(0, 0, 0, 0)') {
    const haze = ctx.createLinearGradient(0, camera.cssHeight * 0.18, 0, camera.cssHeight * 0.78);
    haze.addColorStop(0, look.haze.replace(/[\d.]+\)$/, '0)'));
    haze.addColorStop(0.5, look.haze);
    haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);
  }

  if (look.tint) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = look.tint;
    ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);
    ctx.restore();
  }

  if (look.searchlights && o.searchlights.length > 0) {
    drawSearchlights(ctx, camera, o.searchlights, time);
  }

  drawVignette(ctx, camera);
}

/**
 * Snow: three depth bands of flakes at different sizes and speeds. The wind is
 * one diagonal for the whole scene, so a snowstorm has a direction.
 */
function drawSnow(ctx: CanvasRenderingContext2D, camera: Camera, time: number): void {
  const bands = [
    { count: 90, size: 1.1, speed: 34, alpha: 0.5 },
    { count: 55, size: 1.9, speed: 62, alpha: 0.7 },
    { count: 22, size: 3, speed: 104, alpha: 0.85 },
  ];
  const windX = 28;
  ctx.save();
  for (const band of bands) {
    for (let i = 0; i < band.count; i += 1) {
      const seed = i * 97.31;
      const x0 = (seed % camera.cssWidth) + Math.sin(seed) * 40;
      const drift = (band.speed * time) % (camera.cssHeight + 60);
      const y = (seed * 1.7 + drift) % (camera.cssHeight + 60) - 30;
      // A slow sway, because a flake falling in a straight line reads as rain.
      const x = x0 + Math.sin(time * 0.6 + seed) * 14 + (y / camera.cssHeight) * windX;
      ctx.globalAlpha = band.alpha;
      ctx.fillStyle = '#f4f9ff';
      ctx.beginPath();
      ctx.arc(((x % camera.cssWidth) + camera.cssWidth) % camera.cssWidth, y, band.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** A sandstorm: drifting horizontal grains plus a warm veil. */
function drawSand(ctx: CanvasRenderingContext2D, camera: Camera, time: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(236, 214, 166, 0.4)';
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';
  for (let i = 0; i < 150; i += 1) {
    const seed = i * 51.7;
    const drift = (seed + time * 190) % (camera.cssWidth + 240);
    const y = ((seed * 3.1) % camera.cssHeight) + Math.sin(time * 0.5 + seed) * 9;
    const x = drift - 120;
    const length = 16 + (seed % 26);
    ctx.globalAlpha = 0.22 + (seed % 10) / 40;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + length, y + 2);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#e8cf9d';
  ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);
  ctx.restore();
}

/** Rain: steep slanted streaks with a cold veil over everything. */
function drawRain(ctx: CanvasRenderingContext2D, camera: Camera, time: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(198, 214, 226, 0.34)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 130; i += 1) {
    const seed = i * 73.9;
    const drift = (seed + time * 640) % (camera.cssHeight + 200);
    const x = (seed * 2.3) % camera.cssWidth;
    const y = drift - 100;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 5, y + 26);
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#9fb2bd';
  ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);
  ctx.restore();
}

/**
 * Night: the darkness itself, then the beams. The beams are drawn additively so
 * they light the ground and whatever stands in the pool, which is what makes a
 * searchlight read as a searchlight rather than a painted circle.
 */
function drawSearchlights(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  pools: readonly SearchlightPool[],
  time: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(20, 30, 52, 0.55)';
  ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);
  ctx.globalCompositeOperation = 'source-over';

  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pools.length; i += 1) {
    const pool = pools[i];
    if (!pool) continue;
    const centre = worldToScreen(camera, pool.x, pool.y);
    const radius = SEARCHLIGHT_RADIUS * camera.zoom;
    // Beam: a long quad from above the frame down to the pool, with the source
    // alternating side to side so the two beams visibly sweep independently.
    const sourceX = camera.cssWidth * (i % 2 === 0 ? 0.18 : 0.82) + Math.sin(time * 0.4 + i) * 40;
    const beam = ctx.createLinearGradient(sourceX, -80, centre.x, centre.y);
    beam.addColorStop(0, 'rgba(196, 216, 255, 0.12)');
    beam.addColorStop(0.6, 'rgba(206, 224, 255, 0.07)');
    beam.addColorStop(1, 'rgba(214, 230, 255, 0.02)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(sourceX - 26, -80);
    ctx.lineTo(sourceX + 26, -80);
    ctx.lineTo(centre.x + radius * 0.5, centre.y);
    ctx.lineTo(centre.x - radius * 0.5, centre.y);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.translate(centre.x, centre.y);
    ctx.scale(1, 0.5);
    const pool2 = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    pool2.addColorStop(0, 'rgba(216, 232, 255, 0.34)');
    pool2.addColorStop(0.55, 'rgba(190, 210, 250, 0.18)');
    pool2.addColorStop(1, 'rgba(160, 190, 240, 0)');
    ctx.fillStyle = pool2;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** Corner vignette, so the eye stays on the middle of the field. */
function drawVignette(ctx: CanvasRenderingContext2D, camera: Camera): void {
  const gradient = ctx.createRadialGradient(
    camera.cssWidth / 2,
    camera.cssHeight / 2,
    Math.min(camera.cssWidth, camera.cssHeight) * 0.34,
    camera.cssWidth / 2,
    camera.cssHeight / 2,
    Math.max(camera.cssWidth, camera.cssHeight) * 0.72,
  );
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, 'rgba(6, 8, 6, 0.42)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);
}

/** Corners of the ground plane on screen, for the renderer's surround pass. */
export function groundPlaneCorners(camera: Camera): readonly { x: number; y: number }[] {
  return [
    worldToScreen(camera, 0, 0),
    worldToScreen(camera, WORLD_W, 0),
    worldToScreen(camera, WORLD_W, WORLD_H),
    worldToScreen(camera, 0, WORLD_H),
  ];
}
