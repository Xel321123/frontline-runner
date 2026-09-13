/**
 * BattleRenderer — one frame of the tug-of-war, drawn full-bleed.
 *
 * Two coordinate systems, deliberately separated:
 *
 *   world   the 1280x720 simulation space, drawn through the camera (zoom +
 *           pan). Background layers get a parallax offset proportional to their
 *           depth, so panning the camera slides the horizon past the fighting.
 *   screen  canvas CSS pixels, used for everything the player touches: health
 *           pills, the supply counter, the deployment dock and its buttons.
 *
 * Nothing is letterboxed: the camera crops instead of barring, so the canvas
 * fills 100vw x 100vh at any aspect ratio (see `platform/Viewport.ts`).
 *
 * The renderer holds no state. Given the same state, camera and layout it
 * produces the same frame, shake included, because the shake offset is a
 * function of `state.time`.
 */

import type { Faction } from '../core/types';
import { environmentRules } from '../game/environment';
import {
  BASE_X,
  ENEMY_BASE_X,
  GROUND_Y,
  LOGISTICS_MAX_LEVEL,
  MAX_UNITS_PER_SIDE,
} from '../game/constants';
import type { HudLayout } from '../game/hud';
import { UNIT_STATS } from '../game/units';
import type { TugState, Unit } from '../game/tugTypes';
import type { Camera } from '../platform/Viewport';
import { visibleWorldWidth, worldToScreen } from '../platform/Viewport';
import { Battlefield } from './battlefield';
import { drawBattleFeatures } from './battleFeatures';
import { drawBlastScorch, drawMuzzleFlash, drawParticle, drawShell, drawTracer } from './effects';
import {
  drawCorpse,
  drawSandbags,
  drawSoldier,
  drawStrongpoint,
  drawTank,
  drawUnitIcon,
} from './figures';
import {
  AXIS_PALETTE,
  FONT,
  SCENE,
  SCENE_LOOKS,
  helmetFor,
  paletteFor,
} from './palette';
import { drawAtmosphere } from './weather';

export interface BattleHudInfo {
  readonly nodeName: string;
  readonly year: string;
  readonly strongpoint: string;
  readonly faction: Faction;
  readonly tier: number;
  readonly fps: number;
  readonly paused: boolean;
  readonly touch: boolean;
  /** Right-hand side of the pan control: is the camera following the fight? */
  readonly following: boolean;
}

export class BattleRenderer {
  private readonly background = new Battlefield();

  draw(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    camera: Camera,
    layout: HudLayout,
    hud: BattleHudInfo,
  ): void {
    const { cssWidth, cssHeight } = camera;

    // --- clear: no bars, so the whole canvas is game ------------------------
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // --- world pass --------------------------------------------------------
    const shake = this.shakeOffset(state);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cssWidth, cssHeight);
    ctx.clip();
    ctx.translate(cssWidth / 2 + shake.x, cssHeight / 2 + shake.y);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.focusX, -camera.focusY);
    this.drawWorld(ctx, state, camera);
    ctx.restore();

    // --- atmosphere, in screen space so it covers the whole window ---------
    drawAtmosphere(ctx, {
      environment: state.environment,
      rules: environmentRules(state.environment),
      time: state.time,
      searchlights: this.screenBeams(state, camera),
      cssWidth,
      cssHeight,
    });

    // --- base alert + result banner ----------------------------------------
    this.drawBaseAlert(ctx, state, cssWidth, cssHeight);
    if (state.status !== 'running') this.drawResultBanner(ctx, state, layout);

    // --- overlay HUD, in screen space --------------------------------------
    this.drawTopBar(ctx, state, layout, hud);
    this.drawDock(ctx, state, layout, hud);
    if (!hud.touch) this.drawKeyboardHints(ctx, state, layout, hud);
  }

  // --------------------------------------------------------------- world pass

  private shakeOffset(state: TugState): { x: number; y: number } {
    if (state.shake <= 0.01) return { x: 0, y: 0 };
    return {
      x: Math.sin(state.time * 87) * state.shake,
      y: Math.cos(state.time * 73) * state.shake * 0.55,
    };
  }

  /** World-space position of each searchlight pool, for the screen overlay. */
  private screenBeams(state: TugState, camera: Camera): readonly number[] {
    return state.searchlights.map((beam) => worldToScreen(camera, beam, GROUND_Y).x);
  }

  private drawWorld(ctx: CanvasRenderingContext2D, state: TugState, camera: Camera): void {
    const palette = paletteFor(state.playerFaction);
    const enemyPalette = paletteFor(state.enemyFaction);
    const helmet = helmetFor(state.playerFaction, state.tier);
    const look = SCENE_LOOKS[state.environment];

    // Only paint the strip of world the camera can see.
    const half = visibleWorldWidth(camera) / 2;
    const from = camera.focusX - half - 40;
    const to = camera.focusX + half + 40;

    this.background.setEnvironment(state.environment);
    // The world is only 1280 wide, so painting all of it is cheaper than
    // working out which tiles the camera can see; the clip does the rest.
    void from;
    void to;
    this.background.draw(ctx, { focusX: camera.focusX, time: state.time });

    drawBattleFeatures(ctx, state.features, look, state.time);

    // Structures, then scenery, then the living, then the fallen.
    drawStrongpoint(ctx, {
      x: ENEMY_BASE_X,
      side: 'enemy',
      palette: enemyPalette,
      hpFraction: state.enemyBase.hp / state.enemyBase.maxHp,
      time: state.time,
      flash: state.enemyBase.flash,
      hit: state.enemyBase.hit,
      label: '',
      variant: 'stronghold',
    });
    drawStrongpoint(ctx, {
      x: BASE_X,
      side: 'player',
      palette,
      hpFraction: state.playerBase.hp / state.playerBase.maxHp,
      time: state.time,
      flash: state.playerBase.flash,
      hit: state.playerBase.hit,
      label: '',
      variant: 'hq',
    });

    for (const bags of state.sandbags) {
      drawSandbags(ctx, bags.x, GROUND_Y, bags.side, paletteFor(bags.side === 'player' ? state.playerFaction : state.enemyFaction));
    }
    for (const corpse of state.corpses) {
      drawCorpse(ctx, corpse, paletteFor(state.playerFaction), corpse.maxLife - corpse.life);
    }

    // Smoke behind the troops so units stay readable through it.
    for (const particle of state.particles) {
      if (particle.kind === 'smoke') drawParticle(ctx, particle);
    }

    const tanks: Unit[] = [];
    const infantry: Unit[] = [];
    for (const unit of state.units) ((unit.kind === 'tank' ? tanks : infantry).push(unit));

    for (const unit of [...infantry, ...tanks]) {
      const unitPalette = unit.side === 'player' ? palette : enemyPalette;
      const unitHelmet = helmetFor(
        unit.side === 'player' ? state.playerFaction : state.enemyFaction,
        state.tier,
      );
      if (unit.kind === 'tank') {
        const muzzle = drawTank(ctx, {
          x: unit.x,
          palette: unitPalette,
          facing: unit.facing,
          time: state.time,
          hpFraction: unit.hp / unit.maxHp,
          spawn: unit.spawn,
          recoil: unit.recoil,
          illuminated: unit.illuminated,
        });
        if (unit.flash > 0) {
          drawMuzzleFlash(ctx, muzzle.muzzleX, muzzle.muzzleY, unit.facing, unit.flash * 12, state.time);
        }
      } else {
        const muzzle = drawSoldier(ctx, {
          x: unit.x,
          palette: unitPalette,
          helmet: unitHelmet,
          kind: unit.kind,
          facing: unit.facing,
          time: state.time,
          phase: unit.id * 1.7,
          walking: unit.state === 'advance',
          dugIn: unit.dugIn,
          hpFraction: unit.hp / unit.maxHp,
          spawn: unit.spawn,
          recoil: unit.recoil,
          illuminated: unit.illuminated,
          stagger: unit.stagger,
        });
        if (unit.flash > 0) {
          drawMuzzleFlash(
            ctx,
            muzzle.muzzleX,
            muzzle.muzzleY,
            unit.facing,
            unit.flash * 10,
            state.time,
          );
        }
      }
      // Searchlight halo: the danger of standing in a beam has to be visible.
      if (unit.illuminated) {
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = '#fff4cc';
        ctx.beginPath();
        ctx.ellipse(unit.x, GROUND_Y - UNIT_STATS[unit.kind].height * 0.55, 22, 30, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
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
      if (particle.kind !== 'smoke') drawParticle(ctx, particle);
    }
    void helmet;
  }

  // ------------------------------------------------------------------ overlay

  /**
   * The top overlay: health pills either side, supplies/clock/bonds in the
   * middle, the objective line beneath, and the pause/exit controls. All
   * translucent — the battlefield shows through everything.
   */
  private drawTopBar(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    layout: HudLayout,
    hud: BattleHudInfo,
  ): void {
    const { scale } = layout;
    const playerHp = Math.max(0, state.playerBase.hp / state.playerBase.maxHp);
    const enemyHp = Math.max(0, state.enemyBase.hp / state.enemyBase.maxHp);

    this.drawHealthPill(ctx, layout.playerBar, playerHp, 'hq', hud.faction, layout);
    this.drawHealthPill(ctx, layout.enemyBar, enemyHp, 'enemy', null, layout);

    // Centre: clock, supplies, bonds — one pill each, no chrome.
    const cx = layout.cssWidth / 2;
    const minute = Math.floor(state.time / 60);
    const second = Math.floor(state.time % 60);
    const clock = `${minute}:${second.toString().padStart(2, '0')}`;
    const remaining = Math.max(0, Math.ceil(state.timeLeft));

    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(17 * scale)}px ${FONT}`;
    ctx.fillStyle = state.timeLeft < 20 ? SCENE.warning : SCENE.hud;
    ctx.fillText(clock, cx, layout.playerBar.y + layout.playerBar.h);

    ctx.font = `700 ${Math.round(12 * scale)}px ${FONT}`;
    const supplyText = `${Math.floor(state.supplies)}`;
    const rateText = `+${state.supplyRate.toFixed(1)}/s`;
    const statW = Math.max(120 * scale, 150 * scale);
    const statY = layout.playerBar.y + layout.playerBar.h + Math.round(4 * scale);
    ctx.fillStyle = 'rgba(10, 13, 10, 0.42)';
    ctx.beginPath();
    ctx.roundRect(cx - statW / 2, statY, statW, Math.round(30 * scale), 8 * scale);
    ctx.fill();
    ctx.fillStyle = SCENE.hud;
    ctx.font = `700 ${Math.round(17 * scale)}px ${FONT}`;
    ctx.fillText(supplyText, cx - statW * 0.22, statY + Math.round(21 * scale));
    ctx.font = `600 ${Math.round(10.5 * scale)}px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText('supplies', cx - statW * 0.22, statY + Math.round(29 * scale));
    ctx.font = `700 ${Math.round(15 * scale)}px ${FONT}`;
    ctx.fillStyle = state.bonds > 0 ? SCENE.bond : SCENE.hudDim;
    ctx.fillText(`${state.bonds}`, cx + statW * 0.24, statY + Math.round(21 * scale));
    ctx.font = `600 ${Math.round(10.5 * scale)}px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText('bonds', cx + statW * 0.24, statY + Math.round(29 * scale));
    ctx.fillStyle = SCENE.hudDim;
    ctx.font = `600 ${Math.round(10 * scale)}px ${FONT}`;
    ctx.fillText(rateText, cx + statW * 0.24, statY + Math.round(39 * scale));

    // Objective + weather, and the sector's remaining time for a hold mission.
    const objective = this.objectiveText(state);
    ctx.font = `600 ${Math.round(10.5 * scale)}px ${FONT}`;
    ctx.fillStyle = SCENE.warning;
    const holdLine =
      state.missionType === 'survive_timer' ? ` · HOLD ${remaining}s` : '';
    ctx.fillText(`${objective}${holdLine}`, cx, statY + Math.round(52 * scale));

    // Pause + exit buttons.
    this.drawIconButton(ctx, layout.pause, state.status === 'running' ? '❚❚' : '▶', layout);
    this.drawIconButton(ctx, layout.exit, '✕', layout);
    ctx.textAlign = 'left';

    // FPS, for the diagnostics-minded: bottom-left, above the dock, where it
    // cannot collide with the pause/exit controls.
    ctx.font = `600 ${Math.round(9.5 * scale)}px ${FONT}`;
    ctx.fillStyle = 'rgba(210, 224, 205, 0.45)';
    ctx.fillText(
      `${hud.fps.toFixed(0)} fps`,
      layout.pad,
      layout.cssHeight - layout.dockHeight - Math.round(6 * scale),
    );
    ctx.textAlign = 'left';
  }

  private drawHealthPill(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    fraction: number,
    kind: 'hq' | 'enemy',
    faction: Faction | null,
    layout: HudLayout,
  ): void {
    const scale = layout.scale;
    ctx.save();
    ctx.fillStyle = 'rgba(10, 13, 10, 0.42)';
    ctx.beginPath();
    ctx.roundRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4, 6 * scale);
    ctx.fill();
    ctx.fillStyle = 'rgba(8, 10, 8, 0.7)';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    const fill = kind === 'enemy' ? SCENE.enemyHp : SCENE.playerHp;
    ctx.fillStyle = fraction > 0.3 ? fill : SCENE.warning;
    // The enemy's bar drains from the right, so both read as "your side".
    const width = rect.w * Math.max(0, Math.min(1, fraction));
    ctx.fillRect(kind === 'enemy' ? rect.x + rect.w - width : rect.x, rect.y, width, rect.h);

    const palette = faction ? paletteFor(faction) : AXIS_PALETTE;
    ctx.font = `700 ${Math.round(10 * scale)}px ${FONT}`;
    ctx.textAlign = kind === 'enemy' ? 'right' : 'left';
    const x = kind === 'enemy' ? rect.x + rect.w : rect.x;
    // Label and figure sit *under* the bar: above it there are controls.
    ctx.fillStyle = palette.accent;
    ctx.fillText(kind === 'enemy' ? 'ENEMY' : 'YOUR BASE', x, rect.y + rect.h + 11 * scale);
    ctx.fillStyle = SCENE.hud;
    ctx.fillText(`${Math.round(fraction * 100)}%`, x, rect.y + rect.h + 22 * scale);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  private drawIconButton(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    glyph: string,
    layout: HudLayout,
  ): void {
    ctx.save();
    ctx.fillStyle = 'rgba(10, 13, 10, 0.42)';
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8 * layout.scale);
    ctx.fill();
    ctx.fillStyle = SCENE.hud;
    ctx.font = `700 ${Math.round(12 * layout.scale)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(glyph, rect.x + rect.w / 2, rect.y + rect.h / 2 + 4 * layout.scale);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  /**
   * The deployment dock: four thumb-sized cards with a bold portrait, a supply
   * badge and a circular cooldown sweep, plus the logistics card.
   */
  private drawDock(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    layout: HudLayout,
    hud: BattleHudInfo,
  ): void {
    const { scale } = layout;
    const palette = paletteFor(state.playerFaction);
    const helmet = helmetFor(state.playerFaction, hud.tier);
    const atCap = state.playerUnits >= MAX_UNITS_PER_SIDE;

    for (const slot of layout.slots) {
      const option = state.deployOptions.find((entry) => entry.kind === slot.kind);
      const stats = UNIT_STATS[slot.kind];
      const price = option ? option.cost : stats.cost;
      const affordable = option ? option.affordable : false;
      const ready = option ? option.ready : false;
      const cooldown = option ? option.cooldown : 0;
      const total = option ? option.cooldownTotal : stats.deployCooldown;
      const rect = slot.rect;

      // Card: translucent so the battlefield reads through it.
      ctx.fillStyle = ready ? 'rgba(20, 28, 21, 0.62)' : 'rgba(12, 16, 13, 0.55)';
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 10 * scale);
      ctx.fill();
      ctx.strokeStyle = ready ? SCENE.playerHp : 'rgba(120, 132, 116, 0.35)';
      ctx.lineWidth = ready ? 2 : 1.2;
      ctx.stroke();

      // A translucent plate behind the portrait: the card sits over whatever the
      // battlefield is doing, and a pale snowfield would otherwise wash it out.
      ctx.save();
      ctx.fillStyle = 'rgba(8, 11, 9, 0.42)';
      ctx.beginPath();
      ctx.ellipse(
        slot.iconX,
        slot.iconY + Math.round(2 * scale),
        rect.w * 0.3,
        rect.h * 0.36,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();

      drawUnitIcon(ctx, slot.kind, palette, helmet, slot.iconX, rect.y + rect.h * 0.82, slot.iconScale);

      // Name, then the supply badge.
      ctx.textAlign = 'center';
      ctx.globalAlpha = affordable ? 1 : 0.5;
      ctx.font = `700 ${Math.round(10 * scale)}px ${FONT}`;
      ctx.fillStyle = SCENE.hud;
      ctx.fillText(
        stats.name.toUpperCase(),
        slot.iconX,
        rect.y + Math.round(13 * scale),
        rect.w - 8,
      );

      const badgeW = Math.round(Math.min(rect.w - 12, 62 * scale));
      const badgeH = Math.round(16 * scale);
      const badgeX = slot.iconX - badgeW / 2;
      const badgeY = rect.y + rect.h - badgeH - Math.round(5 * scale);
      ctx.fillStyle = affordable ? 'rgba(60, 74, 44, 0.9)' : 'rgba(52, 34, 32, 0.85)';
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, badgeH / 2);
      ctx.fill();
      ctx.font = `700 ${Math.round(11 * scale)}px ${FONT}`;
      ctx.fillStyle = affordable ? '#e6f0cf' : '#e8b0a4';
      ctx.fillText(`${price}`, badgeX + badgeW * 0.5, badgeY + badgeH * 0.72);
      ctx.globalAlpha = 1;

      // Circular cooldown sweep, drawn from 12 o'clock.
      if (cooldown > 0.01 && total > 0) {
        const cx = slot.iconX;
        const cy = slot.iconY;
        const radius = Math.min(rect.w, rect.h) * 0.42;
        const progress = Math.max(0, Math.min(1, cooldown / total));
        ctx.save();
        ctx.fillStyle = 'rgba(8, 11, 9, 0.5)';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(232, 193, 90, 0.9)';
        ctx.lineWidth = Math.max(2, 3 * scale);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - progress));
        ctx.stroke();
        ctx.fillStyle = SCENE.warning;
        ctx.font = `700 ${Math.round(13 * scale)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(cooldown.toFixed(1), cx, cy + 5 * scale);
        ctx.restore();
        ctx.textAlign = 'center';
      }

      // Hotkey badge, top-left of the card (desktop only).
      if (!hud.touch) {
        ctx.fillStyle = 'rgba(8, 10, 8, 0.6)';
        ctx.beginPath();
        ctx.roundRect(rect.x + 5, rect.y + 5, 14 * scale, 14 * scale, 4 * scale);
        ctx.fill();
        ctx.font = `700 ${Math.round(9.5 * scale)}px ${FONT}`;
        ctx.fillStyle = SCENE.hudDim;
        ctx.fillText(slot.hotkey, rect.x + 5 + 7 * scale, rect.y + 5 + 10 * scale);
      }
      if (atCap) {
        ctx.font = `700 ${Math.round(9.5 * scale)}px ${FONT}`;
        ctx.fillStyle = SCENE.warning;
        ctx.fillText('LINE FULL', slot.iconX, rect.y + rect.h - Math.round(26 * scale));
      }
      ctx.textAlign = 'left';
    }

    // --- logistics card -----------------------------------------------------
    const lr = layout.logistics;
    const maxed = state.logisticsLevel >= LOGISTICS_MAX_LEVEL;
    const canBuy = !maxed && state.bonds >= state.logisticsCost;
    ctx.fillStyle = canBuy ? 'rgba(40, 36, 18, 0.68)' : 'rgba(12, 16, 13, 0.55)';
    ctx.beginPath();
    ctx.roundRect(lr.x, lr.y, lr.w, lr.h, 10 * scale);
    ctx.fill();
    ctx.strokeStyle = canBuy ? SCENE.bond : 'rgba(120, 132, 116, 0.35)';
    ctx.lineWidth = canBuy ? 2 : 1.2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(10.5 * scale)}px ${FONT}`;
    ctx.fillStyle = SCENE.hud;
    ctx.fillText('BOOST LOGISTICS', lr.x + lr.w / 2, lr.y + 16 * scale, lr.w - 8);
    ctx.font = `600 ${Math.round(9.5 * scale)}px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText('+0.6 supplies/s this battle', lr.x + lr.w / 2, lr.y + 28 * scale, lr.w - 8);

    // Level pips.
    const pipW = Math.min(18 * scale, (lr.w - 24) / LOGISTICS_MAX_LEVEL - 4);
    for (let i = 0; i < LOGISTICS_MAX_LEVEL; i += 1) {
      const px = lr.x + lr.w / 2 - (LOGISTICS_MAX_LEVEL * (pipW + 3)) / 2 + i * (pipW + 3);
      ctx.fillStyle = i < state.logisticsLevel ? SCENE.bond : 'rgba(70, 78, 68, 0.9)';
      ctx.beginPath();
      ctx.roundRect(px, lr.y + lr.h * 0.46, pipW, 5 * scale, 2);
      ctx.fill();
    }
    ctx.font = `700 ${Math.round(12 * scale)}px ${FONT}`;
    ctx.fillStyle = maxed ? SCENE.hudDim : canBuy ? SCENE.bond : '#e8b0a4';
    ctx.fillText(
      maxed ? 'MAX LEVEL' : `L${state.logisticsLevel} · ${state.logisticsCost} bonds`,
      lr.x + lr.w / 2,
      lr.y + lr.h - 10 * scale,
    );

    // Recenter control sits above the logistics card.
    this.drawIconButton(ctx, layout.recenter, hud.following ? '◎' : '➤', layout);
    ctx.textAlign = 'left';
  }

  /** Keyboard hints: desktop only — never on a touch device. */
  private drawKeyboardHints(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    layout: HudLayout,
    hud: BattleHudInfo,
  ): void {
    if (hud.touch) return;
    ctx.save();
    ctx.font = `600 ${Math.round(9.5 * layout.scale)}px ${FONT}`;
    ctx.fillStyle = 'rgba(206, 220, 200, 0.55)';
    ctx.fillText(
      '1-4 deploy · U boost · P pause · drag to pan · ESC back to base',
      layout.cssWidth / 2,
      layout.cssHeight - layout.dockHeight - Math.round(6 * layout.scale),
    );
    ctx.textAlign = 'center';
    ctx.fillText(
      `${state.playerUnits}/${MAX_UNITS_PER_SIDE} on the line · ${state.enemyUnits} enemy`,
      layout.cssWidth / 2,
      layout.cssHeight - layout.dockHeight - Math.round(18 * layout.scale),
    );
    ctx.restore();
  }

  private objectiveText(state: TugState): string {
    const objective =
      state.missionType === 'survive_timer'
        ? 'HOLD THE LINE'
        : state.missionType === 'assault'
          ? 'ASSAULT THE STRONGPOINT'
          : 'DESTROY THE STRONGPOINT';
    const rules = environmentRules(state.environment);
    const weather = rules.id === 'standard' ? '' : ` · ${rules.label.toUpperCase()}`;
    return `${objective}${weather}`;
  }

  /** A red pulse at the screen edge while the player's own base is being hit. */
  private drawBaseAlert(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    cssWidth: number,
    cssHeight: number,
  ): void {
    const hit = state.playerBase.hit;
    if (hit <= 0) return;
    const strength = Math.min(1, hit / 0.35) * 0.5;
    const gradient = ctx.createRadialGradient(
      cssWidth / 2,
      cssHeight / 2,
      Math.min(cssWidth, cssHeight) * 0.3,
      cssWidth / 2,
      cssHeight / 2,
      Math.max(cssWidth, cssHeight) * 0.72,
    );
    gradient.addColorStop(0, 'rgba(180, 40, 30, 0)');
    gradient.addColorStop(1, `rgba(196, 52, 38, ${strength.toFixed(3)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  private drawResultBanner(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    layout: HudLayout,
  ): void {
    const won = state.status === 'victory';
    const scale = layout.scale;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(6, 8, 6, 0.55)';
    const bannerH = Math.round(84 * scale);
    const y = layout.cssHeight * 0.3;
    ctx.fillRect(0, y, layout.cssWidth, bannerH);
    ctx.font = `700 ${Math.round(34 * scale)}px ${FONT}`;
    ctx.fillStyle = won ? SCENE.playerHp : SCENE.enemyHp;
    ctx.fillText(won ? 'VICTORY' : 'DEFEAT', layout.cssWidth / 2, y + bannerH * 0.52);
    ctx.font = `600 ${Math.round(11 * scale)}px ${FONT}`;
    ctx.fillStyle = SCENE.hud;
    ctx.fillText(
      won
        ? 'The strongpoint is down — sector cleared'
        : state.lossReason === 'time-expired'
          ? 'Time expired'
          : 'Your base has fallen',
      layout.cssWidth / 2,
      y + bannerH * 0.82,
    );
    ctx.restore();
    ctx.textAlign = 'left';
  }
}

