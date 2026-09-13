/**
 * BattleRenderer — the world pass only.
 *
 * The HUD is DOM now (see app/BattleHud.ts), so this draws exactly one thing:
 * the battlefield, through the camera, with no bars and no fixed sub-rectangle.
 *
 * Frame order: re-apply the buffer→CSS transform, cover the viewport base, the
 * world pass (background → terrain → structures → troops → shots → particles →
 * weather), then the screen-space feedback overlays.
 */

import { BASE_X, ENEMY_BASE_X, GROUND_Y } from '../game/constants';
import { environmentRules } from '../game/environment';
import type { TugState, Unit } from '../game/tugTypes';
import { worldToScreen, type Camera } from '../platform/Viewport';
import { drawBattleFeatures } from './battleFeatures';
import { Battlefield } from './battlefield';
import {
  drawBlastScorch,
  drawMuzzleFlash,
  drawParticle,
  drawShell,
  drawTracer,
} from './effects';
import { drawCorpse, drawSandbags, drawSoldier, drawStrongpoint, drawTank } from './figures';
import {
  SCENE,
  SCENE_LOOKS,
  helmetFor,
  paletteFor,
  type FactionPalette,
  type HelmetShape,
} from './palette';
import { drawAtmosphere } from './weather';

export interface BattleHudInfo {
  readonly strongpoint: string;
  readonly paused: boolean;
}

export class BattleRenderer {
  private readonly background = new Battlefield();

  draw(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    camera: Camera,
    ratio: number,
    hud: BattleHudInfo,
  ): void {
    const { cssWidth, cssHeight } = camera;

    // 1. Buffer → CSS pixels. The backing store is devicePixelRatio times the
    //    viewport, so this must be re-applied every frame: resetting to identity
    //    here is what used to draw the game at 1/dpr scale in the top-left.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // 2. Cover the viewport base so any aspect ratio is filled edge to edge.
    this.paintBackdrop(ctx, state, camera);

    const playerPalette = paletteFor(state.playerFaction);
    const enemyPalette = paletteFor(state.enemyFaction);
    const playerHelmet = helmetFor(state.playerFaction, state.tier);
    const enemyHelmet = helmetFor(state.enemyFaction, state.tier);

    // 3. World pass, through the camera.
    ctx.save();
    const shakeX = Math.sin(state.time * 91) * state.shake * 0.6;
    const shakeY = Math.cos(state.time * 77) * state.shake * 0.4;
    ctx.translate(cssWidth / 2 + shakeX, cssHeight / 2 + shakeY);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.focusX, -camera.focusY);

    this.background.setEnvironment(state.environment);
    this.background.draw(ctx, { focusX: camera.focusX, time: state.time });
    drawBattleFeatures(ctx, state.features, SCENE_LOOKS[state.environment], state.time);

    // Structures first: troops stand in front of their own emplacement.
    drawStrongpoint(ctx, {
      x: BASE_X,
      side: 'player',
      palette: playerPalette,
      hpFraction: state.playerBase.hp / state.playerBase.maxHp,
      time: state.time,
      flash: state.playerBase.flash,
      hit: state.playerBase.hit,
      label: 'Your base',
      variant: 'hq',
    });
    drawStrongpoint(ctx, {
      x: ENEMY_BASE_X,
      side: 'enemy',
      palette: enemyPalette,
      hpFraction: state.enemyBase.hp / state.enemyBase.maxHp,
      time: state.time,
      flash: state.enemyBase.flash,
      hit: state.enemyBase.hit,
      label: hud.strongpoint,
      variant: 'stronghold',
    });

    for (const sandbag of state.sandbags) {
      drawSandbags(
        ctx,
        sandbag.x,
        GROUND_Y,
        sandbag.side,
        sandbag.side === 'player' ? playerPalette : enemyPalette,
      );
    }
    for (const corpse of state.corpses) {
      // elapsed drives the topple; the corpse's own life drives the silhouette fade.
      const elapsed = corpse.maxLife - corpse.life;
      drawCorpse(ctx, corpse, corpse.side === 'player' ? playerPalette : enemyPalette, elapsed);
    }
    // Smoke hangs behind the fighting.
    for (const particle of state.particles) {
      if (particle.kind === 'smoke') drawParticle(ctx, particle);
    }

    const drawOne = (unit: Unit, palette: FactionPalette, helmet: HelmetShape): void => {
      const hpFraction = unit.maxHp > 0 ? Math.max(0, unit.hp / unit.maxHp) : 0;
      // Stride phase from the unit id, so a line of troops is never in lockstep.
      const phase = ((unit.id % 7) / 7) * Math.PI * 2;
      const muzzle =
        unit.kind === 'tank'
          ? drawTank(ctx, {
              x: unit.x,
              palette,
              facing: unit.facing,
              time: state.time,
              hpFraction,
              spawn: unit.spawn,
              recoil: unit.recoil,
              illuminated: unit.illuminated,
            })
          : drawSoldier(ctx, {
              x: unit.x,
              palette,
              helmet,
              kind: unit.kind,
              facing: unit.facing,
              time: state.time,
              phase,
              walking: unit.state === 'advance',
              dugIn: unit.dugIn,
              hpFraction,
              spawn: unit.spawn,
              recoil: unit.recoil,
              illuminated: unit.illuminated,
              stagger: unit.stagger,
            });
      drawMuzzleFlash(ctx, muzzle.muzzleX, muzzle.muzzleY, unit.facing, unit.flash, state.time);
    };
    for (const unit of state.units) {
      if (unit.side === 'player') drawOne(unit, playerPalette, playerHelmet);
    }
    for (const unit of state.units) {
      if (unit.side === 'enemy') drawOne(unit, enemyPalette, enemyHelmet);
    }

    for (const shot of state.projectiles) {
      if (shot.kind === 'shell') drawShell(ctx, shot);
      else drawTracer(ctx, shot);
    }

    // Blast scorch marks, then the particles in front of the troops.
    for (const particle of state.particles) {
      if (particle.kind === 'dust' && particle.maxLife - particle.life > 1.2) {
        drawBlastScorch(ctx, particle.x, 26, particle.life / particle.maxLife);
      }
    }
    for (const particle of state.particles) {
      if (particle.kind !== 'smoke') drawParticle(ctx, particle);
    }

    ctx.restore();

    // 4. Weather and light, in screen space so it always covers the viewport.
    drawAtmosphere(ctx, {
      environment: state.environment,
      rules: environmentRules(state.environment),
      time: state.time,
      searchlights: state.searchlights,
      cssWidth,
      cssHeight,
    });

    // 5. Feedback: damage vignette, paused veil. Context state is left exactly
    //    as found so a bright overlay can never bleed into the next frame.
    if (state.playerBase.hit > 0) {
      const strength = Math.min(0.55, state.playerBase.hit * 0.5);
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
    if (hud.paused) {
      ctx.fillStyle = 'rgba(6, 9, 7, 0.5)';
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      ctx.fillStyle = SCENE.hud;
      ctx.font = '700 22px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSED', cssWidth / 2, cssHeight * 0.42);
      ctx.textAlign = 'left';
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** Sky above the ground line, earth below, at whatever aspect the viewport is. */
  private paintBackdrop(ctx: CanvasRenderingContext2D, state: TugState, camera: Camera): void {
    const look = SCENE_LOOKS[state.environment];
    const groundScreenY = worldToScreen(camera, 0, GROUND_Y).y;
    const skyHeight = Math.max(0, Math.min(camera.cssHeight, groundScreenY));
    ctx.fillStyle = look.skyTop;
    ctx.fillRect(0, 0, camera.cssWidth, skyHeight);
    ctx.fillStyle = look.groundNear;
    ctx.fillRect(0, skyHeight, camera.cssWidth, camera.cssHeight - skyHeight);
  }
}
