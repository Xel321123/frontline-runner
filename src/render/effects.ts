/**
 * Effects — muzzle flashes, tracers, impacts and debris.
 *
 * The particles themselves are simulation data (`state.particles`); this module
 * only decides how each kind looks. Two things matter at mobile zoom: rounds
 * have to read as *fire* (a luminous tracer with a short trail rather than a
 * dot), and hits have to read as *impact* (sparks and a dirt puff, not a
 * disappearing pixel).
 */

import type { Particle, Projectile } from '../game/tugTypes';
import { GROUND_Y } from '../game/constants';

/** How much trail a tracer carries, as a fraction of a second of travel. */
const TRACER_TRAIL = 0.05;

/** Bright tracer: a warm glow line with a short fading tail and a hot core. */
export function drawTracer(ctx: CanvasRenderingContext2D, shot: Projectile): void {
  const tailX = shot.x - shot.vx * TRACER_TRAIL;
  const tailY = shot.y - shot.vy * TRACER_TRAIL;

  ctx.save();
  ctx.lineCap = 'round';
  // Outer glow.
  ctx.strokeStyle = 'rgba(255, 198, 92, 0.35)';
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(shot.x, shot.y);
  ctx.stroke();
  // Hot core.
  ctx.strokeStyle = 'rgba(255, 246, 210, 0.95)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(shot.x, shot.y);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255, 252, 236, 1)';
  ctx.beginPath();
  ctx.arc(shot.x, shot.y, 1.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A shell in flight: a dark body with a tracer-lit tail and a faint smoke trail. */
export function drawShell(ctx: CanvasRenderingContext2D, shot: Projectile): void {
  const tailX = shot.x - shot.vx * 0.035;
  const tailY = shot.y - shot.vy * 0.035;
  ctx.save();
  ctx.strokeStyle = 'rgba(240, 190, 120, 0.3)';
  ctx.lineWidth = 4.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(shot.x, shot.y);
  ctx.stroke();
  ctx.fillStyle = '#2b2925';
  ctx.beginPath();
  ctx.ellipse(shot.x, shot.y, 3.2, 2.2, Math.atan2(shot.vy, shot.vx), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Muzzle flash: a star of spikes plus a brief smoke puff at the muzzle, drawn
 * at the barrel's exit rather than the unit's centre.
 */
export function drawMuzzleFlash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  facing: 1 | -1,
  strength: number,
  time: number,
): void {
  if (strength <= 0) return;
  const power = Math.min(1, strength);
  const length = (10 + power * 20) * FIGURE_REF;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);
  ctx.fillStyle = `rgba(255, 232, 168, ${0.85 * power})`;
  ctx.beginPath();
  ctx.moveTo(0, -3.4 * power);
  ctx.lineTo(length, -1.2 * power);
  ctx.lineTo(length * 1.25, 0);
  ctx.lineTo(length, 1.4 * power);
  ctx.lineTo(0, 3.6 * power);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(255, 252, 226, ${0.95 * power})`;
  ctx.beginPath();
  ctx.moveTo(0, -1.8 * power);
  ctx.lineTo(length * 0.6, 0);
  ctx.lineTo(0, 1.9 * power);
  ctx.closePath();
  ctx.fill();
  // Propellant smoke, drifting up and forward.
  ctx.fillStyle = `rgba(180, 176, 166, ${0.3 * power})`;
  for (let i = 0; i < 3; i += 1) {
    const t = (time * 3 + i * 0.3) % 1;
    ctx.beginPath();
    ctx.arc(length * 0.4 + t * 10, -t * 9, (2 + t * 5) * FIGURE_REF, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Matches the figure scale so effects stay in proportion to the troops. */
const FIGURE_REF = 1.3;

export function drawParticle(ctx: CanvasRenderingContext2D, particle: Particle): void {
  const life = particle.maxLife > 0 ? particle.life / particle.maxLife : 0;
  if (life <= 0) return;
  const scale = FIGURE_REF;

  switch (particle.kind) {
    case 'spark': {
      // A hot streak along its direction of travel.
      const len = 5 + 7 * life;
      const angle = Math.atan2(particle.vy, particle.vx);
      ctx.save();
      ctx.globalAlpha = Math.min(1, life * 1.6);
      ctx.strokeStyle = 'rgba(255, 226, 150, 0.95)';
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.moveTo(particle.x, particle.y);
      ctx.lineTo(particle.x - Math.cos(angle) * len * scale, particle.y - Math.sin(angle) * len * scale);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 252, 232, 1)';
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, 1.4 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'dust': {
      // Dirt kicked up on impact.
      ctx.save();
      ctx.globalAlpha = Math.min(0.75, life * 0.9);
      ctx.fillStyle = 'rgba(124, 104, 74, 0.9)';
      const radius = (3 + (1 - life) * 9) * scale;
      ctx.beginPath();
      ctx.ellipse(particle.x, particle.y, radius, radius * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'smoke': {
      ctx.save();
      ctx.globalAlpha = Math.min(0.6, life * 0.7);
      ctx.fillStyle = 'rgba(58, 56, 52, 0.85)';
      const radius = (5 + (1 - life) * 20) * scale;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'casing': {
      ctx.save();
      ctx.globalAlpha = Math.min(1, life * 1.4);
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.life * 14);
      ctx.fillStyle = '#c9a54a';
      ctx.fillRect(-1.1 * scale, -2 * scale, 2.2 * scale, 4 * scale);
      ctx.fillStyle = '#e8d48a';
      ctx.fillRect(-1.1 * scale, -2 * scale, 1 * scale, 4 * scale);
      ctx.restore();
      break;
    }
    case 'debris': {
      ctx.save();
      ctx.globalAlpha = Math.min(1, life * 1.3);
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.life * 9);
      ctx.fillStyle = '#3c382f';
      ctx.fillRect(-1.8 * scale, -1.8 * scale, 3.6 * scale, 3.6 * scale);
      ctx.restore();
      break;
    }
    case 'blood': {
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, life * 0.6);
      ctx.fillStyle = 'rgba(96, 32, 28, 0.85)';
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, (2 + (1 - life) * 3) * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'bond': {
      // A war-bond token spinning down: readable as currency, not confetti.
      ctx.save();
      ctx.globalAlpha = Math.min(1, life * 1.5);
      ctx.translate(particle.x, particle.y);
      const squash = Math.abs(Math.cos(particle.life * 9));
      ctx.fillStyle = '#c9a54a';
      ctx.beginPath();
      ctx.ellipse(0, 0, 3.6 * scale * (0.35 + squash * 0.65), 3.6 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 244, 200, 0.9)';
      ctx.beginPath();
      ctx.ellipse(-0.8 * scale, -0.8 * scale, 1.5 * scale, 1.5 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
  }
}

/** Ring of dirt and debris where a shell lands. */
export function drawBlastScorch(
  ctx: CanvasRenderingContext2D,
  x: number,
  radius: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(0.5, alpha);
  ctx.fillStyle = '#16140f';
  ctx.beginPath();
  ctx.ellipse(x, GROUND_Y, radius * 0.8, radius * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
