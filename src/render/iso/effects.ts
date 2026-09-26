/**
 * Transient combat effects, drawn in screen space.
 *
 * Every function here takes an already-projected position and the camera scale,
 * so the renderer keeps ownership of the projection and these stay pure drawing
 * routines. Art is SVG path data painted with `paintShape`, which keeps the
 * muzzle flashes and tracers in the same visual language as the figures.
 *
 * Two rules keep a busy battle readable:
 *  - **Additive for light, normal for matter.** Sparks, tracer glows, muzzle
 *    flashes and bond tokens use `lighter` so they bloom; dust, smoke, casings
 *    and debris are opaque-ish shapes that occlude what is behind them.
 *  - **Everything fades on its own clock.** Each effect is handed a 0..1 life
 *    fraction and scales its own opacity from it, so nothing pops out of
 *    existence mid-frame.
 */

import { paintShape, sh, type Palette, type Shape } from './paint';
import type { Particle } from '../../game/tugTypes';

/** Nothing fancy: effects use literal colours, not faction palettes. */
const PALETTE: Palette = {};

const TRACER: readonly Shape[] = [
  // The hot core, then a wider soft sheath around it.
  sh('M0 0L14 0Z', 'rgba(255, 244, 214, 0.95)', { stroke: 'rgba(255, 238, 186, 0.95)', strokeWidth: 1.4, lineCap: 'round' }),
  sh('M0 0L14 0Z', 'rgba(255, 186, 92, 0.34)', { stroke: 'rgba(255, 176, 76, 0.34)', strokeWidth: 3.4, lineCap: 'round' }),
];

const SHELL_BODY: readonly Shape[] = [
  sh('M-4 -2.6C-1 -3.4 2.2 -3 4.4 -1.6L7 0L4.4 1.6C2.2 3 -1 3.4 -4 2.6C-5.4 1.8 -5.4 -1.8 -4 -2.6Z', '@steel'),
  sh('M-3 -1.6C-0.6 -2.2 1.8 -1.8 3.4 -0.8L4.6 0L3.4 0.8C1.8 1.8 -0.6 2.2 -3 1.6Z', 'rgba(255, 240, 200, 0.22)'),
  sh('M-4 -2.6L-6.4 -2.9L-6.4 2.9L-4 2.6Z', '@steelDark'),
];

const CASING: readonly Shape[] = [
  sh('M-1.6 -1.2L1.6 -1.2L1.6 1.2L-1.6 1.2Z', '#c8a24a'),
  sh('M1.6 -1.2L2.6 -1.2L2.6 1.2L1.6 1.2Z', '#8d6f2c'),
];

const BOND_TOKEN: readonly Shape[] = [
  // A struck star, because the currency is a war bond and the drop should read
  // as loot at a glance even in the middle of a firefight.
  sh(
    'M0 -5L1.3 -1.7L4.8 -1.6L2 -0.4L3 3L0 1.1L-3 3L-2 -0.4L-4.8 -1.6L-1.3 -1.7Z',
    '#f2d477',
    { stroke: 'rgba(120, 90, 20, 0.85)', strokeWidth: 0.8 },
  ),
];

export interface TracerOptions {
  /** Screen position of the round. */
  readonly x: number;
  readonly y: number;
  /** Unit screen-space direction of travel. */
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
}

/** A rifle round: a short hot streak that stays legible against any ground. */
export function drawTracer(ctx: CanvasRenderingContext2D, o: TracerOptions): void {
  const angle = Math.atan2(o.dy, o.dx);
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(angle);
  ctx.globalCompositeOperation = 'lighter';
  for (const shape of TRACER) paintShape(ctx, shape, PALETTE, { scaleX: o.scale, scaleY: o.scale });
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

export interface ShellOptions {
  readonly x: number;
  readonly y: number;
  /** Direction of travel in screen space, for the spin and the trail. */
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
  /** True while the shell is still climbing — the trail then points down. */
  readonly ascending: boolean;
}

/** A tank shell in flight, with a thin propellant trail behind it. */
export function drawShell(ctx: CanvasRenderingContext2D, o: ShellOptions): void {
  const angle = Math.atan2(o.dy, o.dx);
  const trailAngle = angle + (o.ascending ? 0 : Math.PI);
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(trailAngle);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = 'rgba(198, 196, 186, 0.5)';
  for (let i = 1; i <= 4; i += 1) {
    const radius = (2 + i * 1.6) * o.scale;
    ctx.globalAlpha = 0.32 / i;
    ctx.beginPath();
    ctx.arc(-i * 4 * o.scale, 0, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(angle);
  for (const shape of SHELL_BODY) paintShape(ctx, shape, { ...PALETTE, steel: '#4c5347', steelDark: '#2c312a' }, { scaleX: o.scale, scaleY: o.scale });
  ctx.restore();
}

export interface MuzzleOptions {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
  /** 0..1 flash timer, straight from the simulation. */
  readonly flash: number;
  /** Full flash duration, so the flash can shrink as it dies. */
  readonly duration: number;
  readonly heavy: boolean;
}

/** The flash at the muzzle: a bright core, a star burst and a puff of light. */
export function drawMuzzleFlash(ctx: CanvasRenderingContext2D, o: MuzzleOptions): void {
  if (o.flash <= 0) return;
  const t = Math.max(0, Math.min(1, o.flash / Math.max(0.001, o.duration)));
  const size = (o.heavy ? 13 : 8) * o.scale * (0.6 + 0.4 * t);
  const angle = Math.atan2(o.dy, o.dx);
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate(angle);
  ctx.globalCompositeOperation = 'lighter';
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 1.6);
  gradient.addColorStop(0, `rgba(255, 250, 226, ${(0.9 * t).toFixed(3)})`);
  gradient.addColorStop(0.45, `rgba(255, 200, 110, ${(0.5 * t).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(255, 170, 60, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, size * 1.6, 0, Math.PI * 2);
  ctx.fill();
  // A four-point star, stretched along the barrel line.
  ctx.fillStyle = `rgba(255, 246, 214, ${(0.85 * t).toFixed(3)})`;
  ctx.beginPath();
  ctx.moveTo(size * 1.5, 0);
  ctx.lineTo(size * 0.3, size * 0.3);
  ctx.lineTo(-size * 0.5, 0);
  ctx.lineTo(size * 0.3, -size * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

export interface ParticleOptions {
  readonly particle: Particle;
  /** Screen position of the particle (already lifted by its height). */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** One simulation particle, drawn according to what it is made of. */
export function drawParticle(ctx: CanvasRenderingContext2D, o: ParticleOptions): void {
  const { particle } = o;
  const life = Math.max(0, particle.life / Math.max(0.001, particle.maxLife));
  const size = particle.size * o.scale;
  switch (particle.kind) {
    case 'spark':
      drawSpark(ctx, o.x, o.y, size, life);
      return;
    case 'smoke':
      drawSmoke(ctx, o.x, o.y, size, life, particle.spin);
      return;
    case 'dust':
      drawDust(ctx, o.x, o.y, size, life);
      return;
    case 'casing':
      drawCasing(ctx, o.x, o.y, size, life, particle.spin);
      return;
    case 'debris':
      drawDebris(ctx, o.x, o.y, size, life, particle.spin);
      return;
    case 'blood':
      drawBlood(ctx, o.x, o.y, size, life);
      return;
    case 'bond':
      drawBond(ctx, o.x, o.y, size, life, particle.spin);
      return;
    case 'flash':
      // A blast is one bright frame: the core plus the shockwave ring, both
      // expanding as they fade.
      drawBlastRing(ctx, o.x, o.y, 1, size * 2, life);
      drawBlastFlash(ctx, o.x, o.y, 1, size * 2, life);
      return;
    default:
      return;
  }
}

function drawSpark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, life: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, size * 2.4);
  gradient.addColorStop(0, `rgba(255, 250, 224, ${(life * 0.95).toFixed(3)})`);
  gradient.addColorStop(0.4, `rgba(255, 190, 88, ${(life * 0.6).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(255, 140, 40, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, size * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSmoke(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, life: number, spin: number): void {
  // Smoke grows and thins as it rises: the puff is drawn at a size that
  // increases as the particle ages, because a rising cloud that stayed the same
  // size reads as a floating ball.
  const age = 1 - life;
  const radius = size * (0.7 + age * 1.5);
  const alpha = Math.min(0.42, life * 0.5);
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  const tone = 92 + Math.round(spin * 6);
  gradient.addColorStop(0, `rgba(${tone}, ${tone - 2}, ${tone - 8}, ${alpha.toFixed(3)})`);
  gradient.addColorStop(0.6, `rgba(${tone - 22}, ${tone - 24}, ${tone - 28}, ${(alpha * 0.6).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(40, 40, 38, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawDust(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, life: number): void {
  const age = 1 - life;
  const radius = size * (0.8 + age * 1.2);
  ctx.save();
  ctx.globalAlpha = Math.min(0.5, life * 0.6);
  ctx.fillStyle = '#9d8d6c';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCasing(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, life: number, spin: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(spin);
  ctx.globalAlpha = Math.min(1, life * 1.6);
  for (const shape of CASING) paintShape(ctx, shape, PALETTE, { scaleX: size * 0.6, scaleY: size * 0.6 });
  ctx.restore();
}

function drawDebris(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, life: number, spin: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(spin);
  ctx.globalAlpha = Math.min(1, life * 2);
  ctx.fillStyle = '#5c5344';
  ctx.fillRect(-size / 2, -size / 4, size, size / 2);
  ctx.restore();
}

function drawBlood(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, life: number): void {
  ctx.save();
  ctx.globalAlpha = Math.min(0.85, life * 1.4);
  ctx.fillStyle = '#6d1f1a';
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBond(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, life: number, spin: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(spin) * 0.4);
  ctx.globalCompositeOperation = 'lighter';
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 3.4);
  glow.addColorStop(0, `rgba(255, 226, 138, ${(life * 0.5).toFixed(3)})`);
  glow.addColorStop(1, 'rgba(255, 200, 80, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, size * 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = Math.min(1, life * 1.8);
  for (const shape of BOND_TOKEN) paintShape(ctx, shape, PALETTE, { scaleX: size * 0.8, scaleY: size * 0.8 });
  ctx.restore();
}

export interface ScorchOptions {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  /** World-unit radius of the blast. */
  readonly radius: number;
  /** 0..1, fading with the mark's life. */
  readonly alpha: number;
}

/** A scorch mark burnt into the ground where a shell landed. */
export function drawBlastScorch(ctx: CanvasRenderingContext2D, o: ScorchOptions): void {
  const radius = o.radius * o.scale;
  if (radius < 1) return;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(1, 0.5);
  const gradient = ctx.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius);
  gradient.addColorStop(0, `rgba(22, 18, 14, ${(0.62 * o.alpha).toFixed(3)})`);
  gradient.addColorStop(0.65, `rgba(38, 32, 24, ${(0.34 * o.alpha).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(40, 34, 26, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The expanding shockwave ring of a blast, drawn for the first moments. */
export function drawBlastRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  radius: number,
  strength: number,
): void {
  if (strength <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.5);
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = `rgba(255, 214, 150, ${(strength * 0.5).toFixed(3)})`;
  ctx.lineWidth = 2 + strength * 3;
  ctx.beginPath();
  ctx.arc(0, 0, radius * scale * (1 + (1 - strength) * 0.6), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** The flash core of a fresh explosion. */
export function drawBlastFlash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  radius: number,
  strength: number,
): void {
  if (strength <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const size = radius * scale * (0.9 + (1 - strength) * 0.9);
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
  gradient.addColorStop(0, `rgba(255, 250, 226, ${(strength * 0.9).toFixed(3)})`);
  gradient.addColorStop(0.35, `rgba(255, 206, 118, ${(strength * 0.6).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(210, 120, 40, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** Project a projectile's velocity into screen-space direction. */
export function screenDirection(vx: number, vy: number): { dx: number; dy: number } {
  const dx = vx - vy;
  const dy = (vx + vy) * 0.5;
  const length = Math.hypot(dx, dy) || 1;
  return { dx: dx / length, dy: dy / length };
}
