/**
 * Effects drawing — drop shadows, muzzle flashes, and the particle system.
 *
 * The particles themselves are simulation data (`state.particles`); this module
 * only decides how each kind looks. Every draw is a pure function of the state
 * it is handed, so nothing here needs to remember anything between frames.
 */

import type { Particle } from '../game/tugTypes';
import { SCENE } from './palette';

/** Soft oval drop-shadow under a figure or vehicle. */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  width: number,
  alpha = 0.32,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#0a0c0a';
  ctx.beginPath();
  ctx.ellipse(x, groundY + 2, width * 0.5, Math.max(2, width * 0.16), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Muzzle flash: a bright core with two side petals, scaled by how long ago the
 * shot happened so it pops and vanishes in ~70 ms.
 */
export function drawMuzzleFlash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  facing: 1 | -1,
  strength: number,
): void {
  if (strength <= 0) return;
  const scale = 0.6 + strength * 0.9;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing * scale, scale);
  ctx.globalAlpha = Math.min(1, strength * 1.4);

  ctx.fillStyle = '#fff4c4';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(16, -5);
  ctx.lineTo(22, 0);
  ctx.lineTo(16, 5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 194, 92, 0.85)';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(11, -9);
  ctx.lineTo(14, 0);
  ctx.lineTo(11, 9);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.beginPath();
  ctx.arc(3, 0, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A puff of propellant smoke hanging at the muzzle after a shot. */
export function drawMuzzleSmoke(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  facing: 1 | -1,
  strength: number,
): void {
  if (strength <= 0) return;
  ctx.save();
  ctx.globalAlpha = 0.3 * strength;
  ctx.fillStyle = '#b9b3a4';
  ctx.beginPath();
  ctx.ellipse(x + facing * 12, y - 2, 10 * strength, 6 * strength, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSpark(ctx: CanvasRenderingContext2D, particle: Particle): void {
  const life = particle.life / particle.maxLife;
  const length = 4 + particle.size * 3 * life;
  const speed = Math.hypot(particle.vx, particle.vy) || 1;
  const nx = particle.vx / speed;
  const ny = particle.vy / speed;
  ctx.globalAlpha = Math.min(1, life * 1.6);
  ctx.strokeStyle = SCENE.spark;
  ctx.lineWidth = particle.size * 0.9;
  ctx.beginPath();
  ctx.moveTo(particle.x, particle.y);
  ctx.lineTo(particle.x - nx * length, particle.y - ny * length);
  ctx.stroke();
}

function drawDust(ctx: CanvasRenderingContext2D, particle: Particle): void {
  const life = particle.life / particle.maxLife;
  ctx.globalAlpha = 0.5 * life;
  ctx.fillStyle = '#8d8264';
  ctx.beginPath();
  ctx.arc(particle.x, particle.y, particle.size * (1.4 - life * 0.4), 0, Math.PI * 2);
  ctx.fill();
}

function drawSmoke(ctx: CanvasRenderingContext2D, particle: Particle): void {
  const life = particle.life / particle.maxLife;
  ctx.globalAlpha = 0.34 * Math.min(1, life * 1.5);
  ctx.fillStyle = life > 0.6 ? '#6f6a60' : '#4d4a44';
  ctx.beginPath();
  ctx.arc(particle.x, particle.y, particle.size * (1.8 - life * 0.8), 0, Math.PI * 2);
  ctx.fill();
}

function drawCasing(ctx: CanvasRenderingContext2D, particle: Particle): void {
  ctx.save();
  ctx.globalAlpha = Math.min(1, particle.life * 2.2);
  ctx.translate(particle.x, particle.y);
  ctx.rotate(particle.spin * (1 - particle.life));
  ctx.fillStyle = SCENE.brass;
  ctx.fillRect(-2, -1, 4, 2);
  ctx.restore();
}

function drawDebris(ctx: CanvasRenderingContext2D, particle: Particle): void {
  ctx.save();
  ctx.globalAlpha = Math.min(1, particle.life * 2);
  ctx.translate(particle.x, particle.y);
  ctx.rotate(particle.spin * (1 - particle.life) * 2);
  ctx.fillStyle = '#3b3529';
  ctx.beginPath();
  ctx.moveTo(-particle.size, -particle.size * 0.6);
  ctx.lineTo(particle.size, -particle.size * 0.2);
  ctx.lineTo(particle.size * 0.4, particle.size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBlood(ctx: CanvasRenderingContext2D, particle: Particle): void {
  ctx.globalAlpha = 0.5 * (particle.life / particle.maxLife);
  ctx.fillStyle = '#6d2a24';
  ctx.beginPath();
  ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
  ctx.fill();
}

/** A dropped war-bond token: a spinning brass disc that glints as it falls. */
function drawBond(ctx: CanvasRenderingContext2D, particle: Particle): void {
  const life = particle.life / particle.maxLife;
  const spin = Math.abs(Math.cos(particle.spin + (1 - life) * 6));
  ctx.save();
  ctx.globalAlpha = Math.min(1, life * 2.4);
  ctx.translate(particle.x, particle.y);
  ctx.fillStyle = SCENE.bond;
  ctx.beginPath();
  ctx.ellipse(0, 0, particle.size * (0.35 + spin * 0.65), particle.size, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#8a6f22';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/** Draw one particle, dispatching on its kind. */
export function drawParticle(ctx: CanvasRenderingContext2D, particle: Particle): void {
  ctx.save();
  switch (particle.kind) {
    case 'spark':
      drawSpark(ctx, particle);
      break;
    case 'dust':
      drawDust(ctx, particle);
      break;
    case 'smoke':
      drawSmoke(ctx, particle);
      break;
    case 'casing':
      drawCasing(ctx, particle);
      break;
    case 'debris':
      drawDebris(ctx, particle);
      break;
    case 'blood':
      drawBlood(ctx, particle);
      break;
    case 'bond':
      drawBond(ctx, particle);
      break;
  }
  ctx.restore();
}

/**
 * Particles split into two passes: smoke hangs *behind* the troops, everything
 * else reads as being in front of them.
 */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: readonly Particle[],
  pass: 'behind' | 'front',
): void {
  for (const particle of particles) {
    const isSmoke = particle.kind === 'smoke';
    if (pass === 'behind' ? !isSmoke : isSmoke) continue;
    drawParticle(ctx, particle);
  }
}
