/**
 * Weather and light drawn over the battlefield.
 *
 * Everything here is a pure function of (environment, time): snowflakes and
 * sand streaks are placed from a hash of their index, and the searchlights are
 * the same sweep the simulation uses, so the beam that lights a soldier up on
 * screen is exactly the beam that is making him take 50% more damage.
 */

import type { Environment } from '../data/campaignData';
import { GROUND_Y } from '../game/constants';
import { SEARCHLIGHT_HALF_WIDTH, type EnvironmentRules } from '../game/environment';

function hash1(n: number): number {
  let h = Math.imul(n | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Falling snow: a drifting field of flakes that wraps as it descends. */
function drawSnowfall(
  ctx: CanvasRenderingContext2D,
  time: number,
  VIEW_WIDTH: number,
  VIEW_HEIGHT: number,
): void {
  const flakes = 170;
  for (let i = 0; i < flakes; i += 1) {
    const speed = 34 + hash1(i * 7 + 1) * 74;
    const drift = 10 + hash1(i * 13 + 5) * 26;
    const baseX = hash1(i * 3 + 2) * (VIEW_WIDTH + 120) - 60;
    const startY = hash1(i * 11 + 9) * VIEW_HEIGHT;
    const y = (startY + time * speed) % (VIEW_HEIGHT + 40);
    const x = baseX + Math.sin(time * 0.6 + i) * drift - time * 8;
    const wrappedX = ((x % (VIEW_WIDTH + 120)) + VIEW_WIDTH + 120) % (VIEW_WIDTH + 120) - 60;
    const size = 1 + hash1(i * 17 + 3) * 1.8;
    ctx.globalAlpha = 0.35 + hash1(i * 19 + 4) * 0.5;
    ctx.fillStyle = '#f2f6fa';
    ctx.beginPath();
    ctx.arc(wrappedX, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Blowing sand: horizontal streaks with a hot haze that kills contrast. */
function drawSandstorm(ctx: CanvasRenderingContext2D, time: number, VIEW_WIDTH: number, VIEW_HEIGHT: number): void {
  const streaks = 90;
  for (let i = 0; i < streaks; i += 1) {
    const speed = 220 + hash1(i * 5 + 1) * 320;
    const y = hash1(i * 3 + 7) * VIEW_HEIGHT;
    const length = 40 + hash1(i * 11 + 2) * 150;
    const x = VIEW_WIDTH + 200 - ((time * speed + hash1(i * 13) * 2000) % (VIEW_WIDTH + 500));
    ctx.globalAlpha = 0.05 + hash1(i * 17 + 6) * 0.1;
    ctx.strokeStyle = '#e6d6ac';
    ctx.lineWidth = 1 + hash1(i * 19 + 8) * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + length, y + hash1(i * 23) * 6 - 3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Haze band: the far half of the field is barely visible in a sandstorm.
  const haze = ctx.createLinearGradient(0, 0, 0, GROUND_Y + 40);
  haze.addColorStop(0, 'rgba(226, 206, 158, 0.10)');
  haze.addColorStop(0.65, 'rgba(226, 206, 158, 0.22)');
  haze.addColorStop(1, 'rgba(206, 182, 132, 0.30)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, VIEW_WIDTH, GROUND_Y + 40);
}

/** Ground mist rising off standing water in the mud. */
function drawMist(ctx: CanvasRenderingContext2D, time: number, VIEW_WIDTH: number): void {
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = '#cfc6b0';
  for (let i = 0; i < 6; i += 1) {
    const drift = Math.sin(time * 0.25 + i * 1.7) * 60;
    const y = GROUND_Y - 6 - i * 5;
    ctx.beginPath();
    ctx.ellipse(VIEW_WIDTH * (0.1 + i * 0.16) + drift, y, 200, 14, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Darkness, plus the beams that make it dangerous to be caught in the open. */
function drawNight(
  ctx: CanvasRenderingContext2D,
  beams: readonly number[],
  time: number,
  VIEW_WIDTH: number,
  VIEW_HEIGHT: number,
): void {
  ctx.fillStyle = 'rgba(4, 8, 16, 0.52)';
  ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

  for (let i = 0; i < beams.length; i += 1) {
    const target = beams[i] ?? 0;
    // Apex sits high off to one side, so the cone reads as a beam from a tower.
    const apexX = target * 0.35 + (i % 2 === 0 ? 120 : VIEW_WIDTH - 120);
    const apexY = -180;

    const cone = ctx.createLinearGradient(apexX, apexY, target, GROUND_Y);
    cone.addColorStop(0, 'rgba(226, 236, 255, 0.02)');
    cone.addColorStop(0.55, 'rgba(226, 236, 255, 0.10)');
    cone.addColorStop(1, 'rgba(240, 246, 255, 0.20)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(apexX, apexY);
    ctx.lineTo(target - SEARCHLIGHT_HALF_WIDTH * 0.35, GROUND_Y);
    ctx.lineTo(target + SEARCHLIGHT_HALF_WIDTH * 0.35, GROUND_Y);
    ctx.closePath();
    ctx.fill();

    // The pool of light on the ground is where the mechanic actually applies.
    const flicker = 0.86 + Math.sin(time * 7 + i) * 0.06;
    const pool = ctx.createRadialGradient(
      target,
      GROUND_Y + 6,
      4,
      target,
      GROUND_Y + 6,
      SEARCHLIGHT_HALF_WIDTH * 1.5,
    );
    pool.addColorStop(0, `rgba(255, 250, 226, ${0.30 * flicker})`);
    pool.addColorStop(0.5, `rgba(255, 246, 210, ${0.14 * flicker})`);
    pool.addColorStop(1, 'rgba(255, 246, 210, 0)');
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.ellipse(target, GROUND_Y + 6, SEARCHLIGHT_HALF_WIDTH * 1.5, 26, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

export interface AtmosphereOptions {
  readonly environment: Environment;
  readonly rules: EnvironmentRules;
  readonly time: number;
  /** Searchlight pools already mapped to screen x. */
  readonly searchlights: readonly number[];
  /** Canvas size in CSS pixels — the overlay covers the whole window. */
  readonly cssWidth: number;
  readonly cssHeight: number;
}

/** Draw the weather over the finished battlefield. */
export function drawAtmosphere(
  ctx: CanvasRenderingContext2D,
  options: AtmosphereOptions,
): void {
  const { rules, time, searchlights } = options;
  const VIEW_WIDTH = Math.max(1, options.cssWidth);
  const VIEW_HEIGHT = Math.max(1, options.cssHeight);
  if (rules.snowfall) drawSnowfall(ctx, time, VIEW_WIDTH, VIEW_HEIGHT);
  if (rules.sandstorm) drawSandstorm(ctx, time, VIEW_WIDTH, VIEW_HEIGHT);
  if (options.environment === 'mud') drawMist(ctx, time, VIEW_WIDTH);
  if (rules.searchlights) drawNight(ctx, searchlights, time, VIEW_WIDTH, VIEW_HEIGHT);

  // The lighting layer paints large bright shapes (searchlight cones, lit
  // ground pools). Leave the context exactly as it was found so an additive
  // blend can never leak into the HUD or flood a later frame.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}
