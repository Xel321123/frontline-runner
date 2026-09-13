/**
 * BattleRenderer — composes one frame of the tug-of-war in the fixed 1280x720
 * logical space, and draws the HUD that goes with it.
 *
 * The renderer holds no state: everything it draws is derived from the
 * simulation snapshot, the viewport and the frame rate. That means the same
 * state always produces the same frame (shake included, since the shake offset
 * is a function of `state.time`), and the only thing it caches is the terrain,
 * which is procedural and deterministic anyway.
 */

import type { Faction } from '../core/types';
import {
  BASE_BAR_HEIGHT,
  BASE_BAR_WIDTH,
  DEPLOY_SLOTS,
  LOGISTICS_RECT,
  READOUT_RECT,
  TOP_BAR_HEIGHT,
} from '../game/hud';
import { BASE_X, ENEMY_BASE_X, GROUND_Y, LOGISTICS_MAX_LEVEL, VIEW_HEIGHT, VIEW_WIDTH } from '../game/constants';
import { UNIT_STATS, type UnitKind } from '../game/units';
import type { TugState, Unit } from '../game/tugTypes';
import { computeGameViewport, type GameViewport } from '../platform/Viewport';
import { Battlefield } from './battlefield';
import { drawMuzzleFlash, drawMuzzleSmoke, drawParticles, drawShadow } from './effects';
import {
  drawCorpse,
  drawSandbags,
  drawSoldier,
  drawStrongpoint,
  drawTank,
  drawUnitIcon,
} from './figures';
import { FONT, SCENE, helmetFor, paletteFor, type FactionPalette } from './palette';

export interface BattleHudInfo {
  readonly nodeName: string;
  readonly year: string;
  readonly strongpoint: string;
  readonly faction: Faction;
  readonly enemyFaction: Faction;
  readonly tier: number;
  readonly fps: number;
}

/** Kinds drawn in order so vehicles sit over infantry. */
const DRAW_ORDER: readonly UnitKind[] = ['rifleman', 'smg', 'mg', 'tank'];

export class BattleRenderer {
  private readonly background = new Battlefield();

  draw(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    cssWidth: number,
    cssHeight: number,
    pixelRatio: number,
    hud: BattleHudInfo,
  ): void {
    const view: GameViewport = computeGameViewport(
      cssWidth,
      cssHeight,
      VIEW_WIDTH,
      VIEW_HEIGHT,
    );

    // Letterbox bars first, in device space.
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.fillStyle = '#050706';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // Screen shake: a deterministic function of the simulation state.
    const shakeX = Math.sin(state.time * 91) * state.shake * 0.7;
    const shakeY = Math.cos(state.time * 77) * state.shake * 0.45;

    ctx.save();
    ctx.setTransform(
      pixelRatio * view.scale,
      0,
      0,
      pixelRatio * view.scale,
      pixelRatio * (view.offsetX + shakeX * view.scale),
      pixelRatio * (view.offsetY + shakeY * view.scale),
    );
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    ctx.clip();

    this.drawWorld(ctx, state, hud);
    ctx.restore();

    // HUD is drawn without the shake so readouts stay legible.
    ctx.save();
    ctx.setTransform(
      pixelRatio * view.scale,
      0,
      0,
      pixelRatio * view.scale,
      pixelRatio * view.offsetX,
      pixelRatio * view.offsetY,
    );
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    ctx.clip();
    this.drawHud(ctx, state, hud);
    ctx.restore();
  }

  // ------------------------------------------------------------------- world

  private drawWorld(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    hud: BattleHudInfo,
  ): void {
    const allyPalette = paletteFor(hud.faction);
    const enemyPalette = paletteFor(hud.enemyFaction);

    this.background.draw(ctx, { focusX: state.focusX, time: state.time });

    // Structures first: troops stand in front of their own emplacement.
    drawStrongpoint(ctx, {
      x: ENEMY_BASE_X,
      side: 'enemy',
      palette: enemyPalette,
      hpFraction: state.enemyBase.hp / state.enemyBase.maxHp,
      time: state.time,
      flash: state.enemyBase.flash,
      smoke: state.enemyBase.smoke,
      hit: state.enemyBase.hit,
      label: hud.strongpoint,
    });
    drawStrongpoint(ctx, {
      x: BASE_X,
      side: 'player',
      palette: allyPalette,
      hpFraction: state.playerBase.hp / state.playerBase.maxHp,
      time: state.time,
      flash: state.playerBase.flash,
      smoke: state.playerBase.smoke,
      hit: state.playerBase.hit,
      label: `${hud.faction === 'axis' ? 'Axis' : 'Allied'} base`,
    });

    for (const bag of state.sandbags) {
      drawSandbags(ctx, bag.x, bag.side === 'player' ? allyPalette : enemyPalette);
    }
    for (const corpse of state.corpses) {
      drawCorpse(ctx, corpse, corpse.side === 'player' ? allyPalette : enemyPalette);
    }

    // Smoke hangs behind the troops; everything else reads in front.
    drawParticles(ctx, state.particles, 'behind');

    for (const kind of DRAW_ORDER) {
      for (const unit of state.units) {
        if (unit.kind !== kind) continue;
        this.drawUnit(
          ctx,
          unit,
          state,
          unit.side === 'player' ? allyPalette : enemyPalette,
          unit.side === 'player' ? hud.faction : hud.enemyFaction,
          hud.tier,
        );
      }
    }

    this.drawProjectiles(ctx, state);
    drawParticles(ctx, state.particles, 'front');
  }

  private drawUnit(
    ctx: CanvasRenderingContext2D,
    unit: Unit,
    state: TugState,
    palette: FactionPalette,
    faction: Faction,
    tier: number,
  ): void {
    const stats = UNIT_STATS[unit.kind];
    const helmet = helmetFor(faction, tier);
    const hpFraction = unit.maxHp > 0 ? unit.hp / unit.maxHp : 0;
    const walking = unit.state === 'advance';

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
            rolling: walking,
          })
        : drawSoldier(ctx, {
            x: unit.x,
            kind: unit.kind,
            palette,
            helmet,
            facing: unit.facing,
            time: state.time,
            phase: unit.id * 1.7,
            walking,
            dugIn: unit.dugIn,
            hpFraction,
            spawn: unit.spawn,
            recoil: unit.recoil,
            suppressed: unit.suppressed > 0,
          });

    if (unit.flash > 0) {
      drawMuzzleFlash(ctx, muzzle.muzzleX, muzzle.muzzleY, unit.facing, unit.flash / 0.07);
      if (unit.kind === 'tank') {
        drawMuzzleSmoke(ctx, muzzle.muzzleX, muzzle.muzzleY, unit.facing, 0.8);
      }
    }

    // Suppressed troops show a small marker so the MG's effect is visible.
    if (unit.suppressed > 0) {
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = SCENE.warning;
      ctx.fillRect(unit.x - 7, GROUND_Y - stats.height - 12, 14, 2);
      ctx.restore();
    }

    // Damaged units carry a slim health bar.
    if (hpFraction < 0.999 && unit.spawn > 0.9) {
      const width = Math.max(16, stats.radius * 2.2);
      ctx.fillStyle = 'rgba(10, 12, 10, 0.6)';
      ctx.fillRect(unit.x - width / 2, GROUND_Y - stats.height - 9, width, 3);
      ctx.fillStyle =
        unit.side === 'player' ? SCENE.playerHp : SCENE.enemyHp;
      ctx.fillRect(unit.x - width / 2, GROUND_Y - stats.height - 9, width * hpFraction, 3);
    }
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, state: TugState): void {
    for (const shot of state.projectiles) {
      if (shot.kind === 'bullet') {
        // Tracer: a short streak along the direction of travel.
        ctx.save();
        ctx.strokeStyle = SCENE.tracer;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(shot.x - Math.sign(shot.vx) * 12, shot.y);
        ctx.lineTo(shot.x, shot.y);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.save();
        drawShadow(ctx, shot.x, GROUND_Y, 10, 0.12);
        ctx.fillStyle = '#33302a';
        ctx.beginPath();
        ctx.ellipse(shot.x, shot.y, 5, 2.4, Math.atan2(shot.vy, shot.vx), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 214, 140, 0.55)';
        ctx.beginPath();
        ctx.arc(shot.x - Math.sign(shot.vx) * 5, shot.y, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // --------------------------------------------------------------------- HUD

  private drawHud(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    hud: BattleHudInfo,
  ): void {
    this.drawTopBar(ctx, state, hud);
    this.drawDeployBar(ctx, state, hud);
    if (state.status !== 'running') this.drawResultBanner(ctx, state);
  }

  private drawTopBar(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    hud: BattleHudInfo,
  ): void {
    ctx.fillStyle = SCENE.hudPanel;
    ctx.fillRect(0, 0, VIEW_WIDTH, TOP_BAR_HEIGHT);
    ctx.strokeStyle = SCENE.hudLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, TOP_BAR_HEIGHT + 0.5);
    ctx.lineTo(VIEW_WIDTH, TOP_BAR_HEIGHT + 0.5);
    ctx.stroke();

    // Player base health, left.
    this.drawBaseBar(
      ctx,
      16,
      14,
      BASE_BAR_WIDTH,
      state.playerBase.hp / state.playerBase.maxHp,
      SCENE.playerHp,
      false,
      `${hud.faction === 'axis' ? 'AXIS' : 'ALLIED'} BASE`,
      `${Math.ceil(state.playerBase.hp)} / ${state.playerBase.maxHp}`,
    );

    // Enemy strongpoint health, right (bar fills right-to-left).
    this.drawBaseBar(
      ctx,
      VIEW_WIDTH - 16 - BASE_BAR_WIDTH,
      14,
      BASE_BAR_WIDTH,
      state.enemyBase.hp / state.enemyBase.maxHp,
      SCENE.enemyHp,
      true,
      hud.strongpoint.toUpperCase(),
      `${Math.ceil(state.enemyBase.hp)} / ${state.enemyBase.maxHp}`,
    );

    // Clock, supplies and bonds in the middle.
    const cx = VIEW_WIDTH / 2;
    const minutes = Math.floor(state.time / 60);
    const seconds = Math.floor(state.time % 60);
    ctx.textAlign = 'center';
    ctx.font = `700 20px ${FONT}`;
    ctx.fillStyle = state.timeLeft < 30 ? SCENE.warning : SCENE.hud;
    ctx.fillText(`${minutes}:${String(seconds).padStart(2, '0')}`, cx, 26);

    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText(`${hud.nodeName} · ${hud.year} · tier ${hud.tier}`, cx, 46);

    // Supplies readout under the clock, left of centre.
    this.drawCurrency(ctx, cx - 150, 20, 'SUPPLIES', Math.floor(state.supplies), `+${state.supplyRate.toFixed(1)}/s`, SCENE.hud);
    this.drawCurrency(ctx, cx + 150, 20, 'WAR BONDS', state.bonds, `logistics L${state.logisticsLevel}`, SCENE.bond);

    ctx.textAlign = 'left';
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText(`${hud.fps.toFixed(0)} fps`, 16, TOP_BAR_HEIGHT - 6);
    ctx.textAlign = 'right';
    ctx.fillText(`fielded ${state.stats.deployed} · kills ${state.stats.kills}`, VIEW_WIDTH - 16, TOP_BAR_HEIGHT - 6);
    ctx.textAlign = 'left';
  }

  private drawBaseBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    fraction: number,
    color: string,
    mirrored: boolean,
    label: string,
    value: string,
  ): void {
    ctx.fillStyle = 'rgba(8, 10, 8, 0.75)';
    ctx.fillRect(x, y, width, BASE_BAR_HEIGHT);
    ctx.strokeStyle = SCENE.hudLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, BASE_BAR_HEIGHT - 1);

    const clamped = Math.max(0, Math.min(1, fraction));
    const fillW = (width - 4) * clamped;
    ctx.fillStyle = color;
    ctx.fillRect(mirrored ? x + width - 2 - fillW : x + 2, y + 2, fillW, BASE_BAR_HEIGHT - 4);

    ctx.font = `700 11px ${FONT}`;
    ctx.fillStyle = SCENE.hud;
    ctx.textAlign = mirrored ? 'right' : 'left';
    ctx.fillText(label, mirrored ? x + width : x, y + BASE_BAR_HEIGHT + 13);
    ctx.textAlign = mirrored ? 'left' : 'right';
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText(value, mirrored ? x : x + width, y + BASE_BAR_HEIGHT + 13);
    ctx.textAlign = 'left';
  }

  private drawCurrency(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    label: string,
    value: number,
    suffix: string,
    color: string,
  ): void {
    ctx.textAlign = 'center';
    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText(label, x, y - 2);
    ctx.font = `700 22px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(String(value), x, y + 20);
    ctx.font = `500 10px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText(suffix, x, y + 34);
    ctx.textAlign = 'left';
  }

  private drawDeployBar(
    ctx: CanvasRenderingContext2D,
    state: TugState,
    hud: BattleHudInfo,
  ): void {
    const barY = VIEW_HEIGHT - 104;
    ctx.fillStyle = SCENE.hudPanel;
    ctx.fillRect(0, barY, VIEW_WIDTH, 104);
    ctx.strokeStyle = SCENE.hudLine;
    ctx.beginPath();
    ctx.moveTo(0, barY + 0.5);
    ctx.lineTo(VIEW_WIDTH, barY + 0.5);
    ctx.stroke();

    const palette = paletteFor(hud.faction);

    // Deploy slots.
    for (const slot of DEPLOY_SLOTS) {
      const option = state.deployOptions.find((entry) => entry.kind === slot.kind);
      const affordable = option ? option.affordable : false;
      const ready = option ? option.ready : false;
      const rect = slot.rect;

      ctx.fillStyle = ready ? 'rgba(24, 32, 25, 0.96)' : 'rgba(16, 20, 17, 0.9)';
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8);
      ctx.fill();
      ctx.strokeStyle = ready ? SCENE.playerHp : SCENE.hudLine;
      ctx.lineWidth = ready ? 1.6 : 1;
      ctx.stroke();

      drawUnitIcon(ctx, slot.kind, palette, helmetFor(hud.faction, hud.tier), rect.x + 34, rect.y + 66, 1.15);

      ctx.globalAlpha = ready ? 1 : 0.45;
      ctx.font = `700 12px ${FONT}`;
      ctx.fillStyle = SCENE.hud;
      // maxWidth keeps a long name from bleeding into the next slot.
      ctx.fillText(UNIT_STATS[slot.kind].name.toUpperCase(), rect.x + 60, rect.y + 22, rect.w - 66);

      ctx.font = `500 10.5px ${FONT}`;
      ctx.fillStyle = SCENE.hudDim;
      ctx.fillText(this.unitBlurb(slot.kind), rect.x + 60, rect.y + 38, rect.w - 66);

      ctx.font = `700 14px ${FONT}`;
      ctx.fillStyle = affordable ? SCENE.hud : SCENE.enemyHp;
      ctx.fillText(`${UNIT_STATS[slot.kind].cost}`, rect.x + 62, rect.y + 74);
      ctx.font = `500 10px ${FONT}`;
      ctx.fillStyle = SCENE.hudDim;
      ctx.fillText('supplies', rect.x + 62 + ctx.measureText(`${UNIT_STATS[slot.kind].cost}`).width + 6, rect.y + 74);
      ctx.globalAlpha = 1;

      // Hotkey badge.
      ctx.fillStyle = 'rgba(8, 10, 8, 0.8)';
      ctx.beginPath();
      ctx.roundRect(rect.x + rect.w - 22, rect.y + 8, 14, 14, 3);
      ctx.fill();
      ctx.font = `700 10px ${FONT}`;
      ctx.fillStyle = SCENE.hudDim;
      ctx.textAlign = 'center';
      ctx.fillText(slot.hotkey, rect.x + rect.w - 15, rect.y + 18);
      ctx.textAlign = 'left';
    }

    // In-match logistics upgrade.
    const maxed = state.logisticsLevel >= LOGISTICS_MAX_LEVEL;
    const canBuy = !maxed && state.bonds >= state.logisticsCost;
    ctx.fillStyle = canBuy ? 'rgba(38, 34, 20, 0.96)' : 'rgba(16, 20, 17, 0.9)';
    ctx.beginPath();
    ctx.roundRect(LOGISTICS_RECT.x, LOGISTICS_RECT.y, LOGISTICS_RECT.w, LOGISTICS_RECT.h, 8);
    ctx.fill();
    ctx.strokeStyle = canBuy ? SCENE.bond : SCENE.hudLine;
    ctx.lineWidth = canBuy ? 1.6 : 1;
    ctx.stroke();

    ctx.font = `700 12px ${FONT}`;
    ctx.fillStyle = SCENE.hud;
    ctx.fillText('BOOST LOGISTICS', LOGISTICS_RECT.x + 14, LOGISTICS_RECT.y + 22);
    ctx.font = `500 10.5px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText('+0.6 supplies/s, permanently this battle', LOGISTICS_RECT.x + 14, LOGISTICS_RECT.y + 38);
    // Level pips.
    for (let i = 0; i < LOGISTICS_MAX_LEVEL; i += 1) {
      ctx.fillStyle = i < state.logisticsLevel ? SCENE.bond : 'rgba(60, 68, 58, 0.9)';
      ctx.fillRect(LOGISTICS_RECT.x + 14 + i * 16, LOGISTICS_RECT.y + 48, 12, 5);
    }
    ctx.font = `700 13px ${FONT}`;
    ctx.fillStyle = maxed ? SCENE.hudDim : canBuy ? SCENE.bond : SCENE.enemyHp;
    ctx.fillText(
      maxed ? 'MAX LEVEL' : `${state.logisticsCost} bonds  [U]`,
      LOGISTICS_RECT.x + 14,
      LOGISTICS_RECT.y + 74,
    );

    // Battlefield readout.
    ctx.fillStyle = 'rgba(16, 20, 17, 0.9)';
    ctx.beginPath();
    ctx.roundRect(READOUT_RECT.x, READOUT_RECT.y, READOUT_RECT.w, READOUT_RECT.h, 8);
    ctx.fill();
    ctx.strokeStyle = SCENE.hudLine;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText('ENEMY', READOUT_RECT.x + 14, READOUT_RECT.y + 18);
    ctx.font = `700 15px ${FONT}`;
    ctx.fillStyle = SCENE.enemyHp;
    ctx.fillText(`${state.enemyUnits} units`, READOUT_RECT.x + 14, READOUT_RECT.y + 38);
    ctx.font = `500 10.5px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText(`depot ${Math.floor(state.enemySupplies)}`, READOUT_RECT.x + 14, READOUT_RECT.y + 54);

    // Frontline indicator: where the weight of the battle currently sits.
    const front = this.frontLineFraction(state);
    const barX = READOUT_RECT.x + 14;
    const frontBarY = READOUT_RECT.y + 64;
    const barW = READOUT_RECT.w - 28;
    ctx.fillStyle = 'rgba(8, 10, 8, 0.8)';
    ctx.fillRect(barX, frontBarY, barW, 8);
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillRect(barX + barW * 0.5 - 0.5, frontBarY - 2, 1, 12);
    ctx.fillStyle = SCENE.playerHp;
    ctx.fillRect(barX + barW * 0.5, frontBarY + 2, Math.max(0, (front - 0.5) * barW), 4);
    ctx.fillStyle = SCENE.enemyHp;
    ctx.fillRect(barX + barW * front, frontBarY + 2, Math.max(0, (0.5 - front) * barW), 4);
    ctx.fillStyle = SCENE.hud;
    ctx.fillRect(barX + barW * front - 1, frontBarY - 1, 2, 10);
    ctx.font = `500 10px ${FONT}`;
    ctx.fillStyle = SCENE.hudDim;
    ctx.fillText('front line', barX, frontBarY + 22);
  }

  private unitBlurb(kind: UnitKind): string {
    // Kept short: these sit in a 148 px slot next to the unit portrait.
    switch (kind) {
      case 'rifleman':
        return 'long range';
      case 'smg':
        return 'fast, close-in';
      case 'mg':
        return 'digs in';
      case 'tank':
        return 'armour, blast';
    }
  }

  /** 0 = enemy strongpoint under pressure, 1 = player base under pressure. */
  private frontLineFraction(state: TugState): number {
    let sum = 0;
    let count = 0;
    for (const unit of state.units) {
      sum += unit.x;
      count += 1;
    }
    if (count === 0) return 0.5;
    const average = sum / count;
    return Math.max(0, Math.min(1, average / VIEW_WIDTH));
  }

  private drawResultBanner(ctx: CanvasRenderingContext2D, state: TugState): void {
    const won = state.status === 'victory';
    ctx.save();
    const gradient = ctx.createLinearGradient(0, 0, 0, VIEW_HEIGHT);
    gradient.addColorStop(0, 'rgba(6, 8, 6, 0.1)');
    gradient.addColorStop(0.5, 'rgba(6, 8, 6, 0.55)');
    gradient.addColorStop(1, 'rgba(6, 8, 6, 0.1)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    ctx.textAlign = 'center';
    ctx.font = `700 46px ${FONT}`;
    ctx.fillStyle = won ? SCENE.playerHp : SCENE.enemyHp;
    ctx.fillText(won ? 'VICTORY' : 'DEFEAT', VIEW_WIDTH / 2, 150);
    ctx.font = `600 14px ${FONT}`;
    ctx.fillStyle = SCENE.hud;
    ctx.fillText(
      won
        ? `${state.enemyBase.side === 'enemy' ? 'Strongpoint' : 'Base'} destroyed — sector cleared`
        : state.lossReason === 'time-expired'
          ? 'Time expired with the strongpoint still standing'
          : 'Your base has fallen',
      VIEW_WIDTH / 2,
      178,
    );
    ctx.textAlign = 'left';
    ctx.restore();
  }
}
