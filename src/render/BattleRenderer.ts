/**
 * BattleRenderer — the world pass of the isometric battlefield.
 *
 * The HUD is DOM (see app/BattleHud.ts), so this draws exactly one thing: the
 * ground plane and everything standing on it, with no bars and no fixed
 * sub-rectangle.
 *
 * Draw order, and why it is this order
 * -----------------------------------
 *  1. The **surround**: sky, haze and glow behind everything, in screen space.
 *  2. The **ground and flat features**: drawn *through the camera*, with the
 *     isometric basis applied, so the artwork is authored in world coordinates
 *     (tiles, roads, trench lines, mine belts) and lands correctly projected.
 *  3. The **uprights**: bases, props, corpses, troops, shots, debris. These are
 *     drawn in screen space at a projected anchor, sorted back-to-front by
 *     `x + y` — the painter's algorithm for this projection — so a soldier
 *     standing behind a building is drawn behind it.
 *  4. The **weather and light**, over the whole viewport.
 *  5. Feedback: the damage vignette and the pause veil.
 *
 * The screen shake is applied to the ground pass as a canvas translate and to
 * every projected anchor as an offset, so ground and troops never separate
 * during a barrage.
 */

import { environmentRules } from '../game/environment';
import { MUZZLE_FLASH_TIME } from '../game/constants';
import type { BaseState, TugState } from '../game/tugTypes';
import { unitStats } from '../game/units';
import { visibleWorldRect, worldToScreen, type Camera } from '../platform/Viewport';
import { applyIso } from './iso/iso';
import { drawAtmosphere, paintSurround } from './iso/atmosphere';
import { drawHealthBar } from './iso/common';
import {
  drawBlastScorch,
  drawMuzzleFlash,
  drawParticle,
  drawShell,
  drawTracer,
  screenDirection,
} from './iso/effects';
import { drawCorpse, drawUnit } from './iso/figures';
import { drawGroundFeatures } from './iso/groundFeatures';
import { drawProp } from './iso/props';
import type { ScatterProp } from './iso/scatter';
import { drawStructure } from './iso/structures';
import { drawGround } from './iso/terrain';
import type { WorldView } from './iso/contracts';

export interface BattleRenderOptions {
  /** The player's currently selected launch pad, if any. */
  readonly selectedBaseId: number | null;
  /** The hostile position the next launch is aimed at, if any. */
  readonly targetBaseId: number | null;
  /** Static scatter laid out for this node. */
  readonly scatter: readonly ScatterProp[];
  readonly paused: boolean;
}

/** What a queued draw entry is: `index` indexes into that source array. */
type EntryKind = 'base' | 'prop' | 'corpse' | 'sandbags' | 'unit' | 'shot' | 'particle';

interface Entry {
  key: number;
  kind: EntryKind;
  index: number;
}

/** Reused every frame: a battle queues on the order of a hundred entries. */
const queue: Entry[] = [];

function pushEntry(key: number, kind: EntryKind, index: number): void {
  queue.push({ key, kind, index });
}

export class BattleRenderer {
  draw(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    camera: Camera,
    ratio: number,
    options: BattleRenderOptions,
  ): void {
    const { cssWidth, cssHeight } = camera;
    const scale = camera.zoom;
    const rules = environmentRules(state.environment);

    // 1. Buffer -> CSS pixels. Re-applied every frame: resetting to identity in
    //    order to clear is what used to draw the game at 1/dpr scale.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const atmosphere = {
      camera,
      rules,
      time: state.time,
      searchlights: state.searchlights,
    };
    paintSurround(ctx, atmosphere);

    const shakeX = Math.sin(state.time * 91) * state.shake * 0.6;
    const shakeY = Math.cos(state.time * 77) * state.shake * 0.4;

    // 2. Ground and flat features, through the camera.
    const rect = visibleWorldRect(camera);
    const worldView: WorldView = {
      minX: rect.minX,
      maxX: rect.maxX,
      minY: rect.minY,
      maxY: rect.maxY,
      environment: state.environment,
      time: state.time,
      seed: state.seed,
    };
    ctx.save();
    ctx.translate(cssWidth / 2 + shakeX, cssHeight / 2 + shakeY);
    ctx.scale(scale, scale);
    ctx.translate(-camera.focusProjectedX, -camera.focusProjectedY);
    ctx.save();
    applyIso(ctx);
    drawGround(ctx, worldView);
    ctx.restore();
    drawGroundFeatures(ctx, worldView, state.features);
    ctx.restore();

    // 3. Uprights, in screen space at projected anchors.
    const project = (x: number, y: number, z = 0): { x: number; y: number } => {
      const screen = worldToScreen(camera, x, y, z);
      return { x: screen.x + shakeX, y: screen.y + shakeY };
    };
    const visible = (x: number, y: number): boolean =>
      x >= worldView.minX && x <= worldView.maxX && y >= worldView.minY && y <= worldView.maxY;

    queue.length = 0;
    for (let index = 0; index < state.bases.length; index += 1) {
      const base = state.bases[index];
      if (base && visible(base.x, base.y)) pushEntry(base.x + base.y - 1, 'base', index);
    }
    for (let index = 0; index < options.scatter.length; index += 1) {
      const prop = options.scatter[index];
      if (prop && visible(prop.x, prop.y)) pushEntry(prop.x + prop.y, 'prop', index);
    }
    for (let index = 0; index < state.corpses.length; index += 1) {
      const corpse = state.corpses[index];
      if (corpse && visible(corpse.x, corpse.y)) pushEntry(corpse.x + corpse.y - 0.5, 'corpse', index);
    }
    for (let index = 0; index < state.sandbags.length; index += 1) {
      const bag = state.sandbags[index];
      if (bag && visible(bag.x, bag.y)) pushEntry(bag.x + bag.y - 0.5, 'sandbags', index);
    }
    for (let index = 0; index < state.units.length; index += 1) {
      const unit = state.units[index];
      if (unit && visible(unit.x, unit.y)) pushEntry(unit.x + unit.y, 'unit', index);
    }
    for (let index = 0; index < state.projectiles.length; index += 1) {
      const shot = state.projectiles[index];
      if (shot && visible(shot.x, shot.y)) pushEntry(shot.x + shot.y + 0.5, 'shot', index);
    }
    for (let index = 0; index < state.particles.length; index += 1) {
      const particle = state.particles[index];
      if (!particle) continue;
      // Smoke hangs behind the fighting; dirt, brass and flame belong in it.
      const bias = particle.kind === 'smoke' ? -40 : particle.kind === 'flash' ? 2 : 0;
      if (visible(particle.x, particle.y)) pushEntry(particle.x + particle.y + bias, 'particle', index);
    }

    queue.sort((a, b) => a.key - b.key);

    // Scorch marks go down before anything stands on them: they are ground
    // decals, not objects, and drawing them in the sorted queue would let a
    // mark near the camera cover a soldier standing in front of it.
    for (const particle of state.particles) {
      if (particle.kind !== 'dust') continue;
      const age = particle.maxLife - particle.life;
      if (age <= 1.2 || particle.size < 5) continue;
      const at = project(particle.x, particle.y);
      drawBlastScorch(ctx, {
        x: at.x,
        y: at.y,
        scale,
        radius: particle.size * 4.6,
        alpha: Math.max(0, particle.life / particle.maxLife),
      });
    }

    for (const entry of queue) {
      switch (entry.kind) {
        case 'base': {
          const base = state.bases[entry.index];
          if (base) this.drawBase(ctx, state, base, project, scale, options);
          break;
        }
        case 'prop': {
          const prop = options.scatter[entry.index];
          if (!prop) break;
          const at = project(prop.x, prop.y);
          drawProp(ctx, {
            x: at.x,
            y: at.y,
            scale,
            time: state.time,
            environment: state.environment,
            kind: prop.kind,
            variant: prop.variant,
            scaleHint: prop.scaleHint,
          });
          break;
        }
        case 'corpse': {
          const corpse = state.corpses[entry.index];
          if (!corpse) break;
          const at = project(corpse.x, corpse.y);
          drawCorpse(ctx, {
            x: at.x,
            y: at.y,
            scale,
            time: state.time,
            environment: state.environment,
            kind: corpse.kind,
            faction: corpse.side === 'player' ? state.playerFaction : state.enemyFaction,
            tier: state.tier,
            topple: corpse.topple,
            fallen: Math.min(1, (corpse.maxLife - corpse.life) / 0.5),
            fade: Math.max(0, corpse.life / corpse.maxLife),
          });
          break;
        }
        case 'sandbags': {
          const bag = state.sandbags[entry.index];
          if (!bag) break;
          const at = project(bag.x, bag.y);
          drawProp(ctx, {
            x: at.x,
            y: at.y,
            scale,
            time: state.time,
            environment: state.environment,
            kind: 'sandbags',
            variant: (bag.x % 7) / 7,
            scaleHint: 1,
          });
          break;
        }
        case 'unit': {
          const unit = state.units[entry.index];
          if (unit) this.drawUnit(ctx, state, unit, project, scale);
          break;
        }
        case 'shot': {
          const shot = state.projectiles[entry.index];
          if (!shot) break;
          const at = project(shot.x, shot.y, shot.z);
          const direction = screenDirection(shot.vx, shot.vy);
          if (shot.kind === 'shell') {
            drawShell(ctx, {
              x: at.x,
              y: at.y,
              dx: direction.dx,
              dy: direction.dy,
              scale,
              ascending: shot.vz > 0,
            });
          } else {
            drawTracer(ctx, { x: at.x, y: at.y, dx: direction.dx, dy: direction.dy, scale });
          }
          break;
        }
        case 'particle': {
          const particle = state.particles[entry.index];
          if (!particle) break;
          const at = project(particle.x, particle.y, particle.z);
          drawParticle(ctx, { particle, x: at.x, y: at.y, scale });
          break;
        }
      }
    }

    // 4. Weather and light over the whole viewport.
    drawAtmosphere(ctx, atmosphere);

    // 5. Feedback: a red pulse at the edge when a friendly position is hit, and
    //    the pause veil. Context state is restored so nothing bleeds a frame on.
    const friendlyHit = state.bases.some((base) => base.side === 'player' && base.hit > 0);
    if (friendlyHit) {
      const strength = Math.min(0.5, 0.3);
      const gradient = ctx.createRadialGradient(
        cssWidth / 2,
        cssHeight / 2,
        Math.min(cssWidth, cssHeight) * 0.32,
        cssWidth / 2,
        cssHeight / 2,
        Math.max(cssWidth, cssHeight) * 0.62,
      );
      gradient.addColorStop(0, 'rgba(120, 20, 16, 0)');
      gradient.addColorStop(1, `rgba(120, 20, 16, ${strength.toFixed(3)})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, cssWidth, cssHeight);
    }
    if (options.paused) {
      ctx.fillStyle = 'rgba(6, 9, 7, 0.5)';
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      ctx.fillStyle = '#e6ecdd';
      ctx.font = '700 22px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSED', cssWidth / 2, cssHeight * 0.42);
      ctx.textAlign = 'left';
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** A position: the building itself, then its gun flash and health bar. */
  private drawBase(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    base: BaseState,
    project: (x: number, y: number, z?: number) => { x: number; y: number },
    scale: number,
    options: BattleRenderOptions,
  ): void {
    const at = project(base.x, base.y);
    const muzzle = drawStructure(ctx, {
      x: at.x,
      y: at.y,
      scale,
      time: state.time,
      environment: state.environment,
      kind: base.kind,
      faction: base.side === 'player' ? state.playerFaction : state.enemyFaction,
      tier: state.tier,
      hpFraction: base.maxHp > 0 ? Math.max(0, base.hp / base.maxHp) : 0,
      destroyed: base.destroyed,
      flash: base.flash,
      hit: base.hit,
      smoke: base.smoke,
      selected: options.selectedBaseId === base.id,
      targeted: options.targetBaseId === base.id,
    });

    if (base.flash > 0) {
      const direction = screenDirection(Math.cos(base.aim), Math.sin(base.aim));
      drawMuzzleFlash(ctx, {
        x: muzzle.muzzleX,
        y: muzzle.muzzleY,
        dx: direction.dx,
        dy: direction.dy,
        scale,
        flash: base.flash,
        duration: MUZZLE_FLASH_TIME,
        heavy: true,
      });
    }

    // The position's own health bar, floating above the roof: a five-position
    // battle needs the player to be able to read all five at a glance.
    drawHealthBar(ctx, {
      x: at.x,
      y: at.y - 78 * scale,
      width: 46 * scale,
      height: Math.max(2, 3.4 * scale),
      fraction: base.maxHp > 0 ? Math.max(0, base.hp / base.maxHp) : 0,
      colour: base.side === 'player' ? '#8dc86a' : '#d4614f',
      outline: true,
    });
  }

  /** A figure or vehicle, plus the flash at the muzzle it just fired from. */
  private drawUnit(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    unit: TugState['units'][number],
    project: (x: number, y: number, z?: number) => { x: number; y: number },
    scale: number,
  ): void {
    const at = project(unit.x, unit.y);
    const headingX = Math.cos(unit.heading);
    const headingY = Math.sin(unit.heading);
    const muzzle = drawUnit(ctx, {
      x: at.x,
      y: at.y,
      scale,
      time: state.time,
      environment: state.environment,
      kind: unit.kind,
      faction: unit.side === 'player' ? state.playerFaction : state.enemyFaction,
      tier: state.tier,
      facing: unit.facing,
      headingX,
      headingY,
      phase: unit.stride,
      stride: unit.stride,
      moving: unit.state === 'advance',
      dugIn: unit.dugIn,
      hpFraction: unit.maxHp > 0 ? Math.max(0, unit.hp / unit.maxHp) : 0,
      spawn: unit.spawn,
      recoil: unit.recoil,
      shoved: unit.shoved,
      illuminated: unit.illuminated,
      suppressed: unit.suppressed > 0,
      staggering: unit.stagger > 0,
      shadow: true,
    });

    if (unit.flash > 0) {
      const direction = screenDirection(headingX, headingY);
      drawMuzzleFlash(ctx, {
        x: muzzle.muzzleX,
        y: muzzle.muzzleY,
        dx: direction.dx,
        dy: direction.dy,
        scale,
        flash: unit.flash,
        duration: MUZZLE_FLASH_TIME,
        heavy: unitStats(unit.kind).projectile === 'shell',
      });
    }
  }
}
