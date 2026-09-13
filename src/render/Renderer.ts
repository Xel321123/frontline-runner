/**
 * RunRenderer — draws one frame of the run in the fixed 1280x720 logical space.
 *
 * The canvas can be any CSS size: `applyViewport` sets the transform that
 * letterboxes the logical space into it (aspect-ratio locked, bars outside), so
 * the game looks identical on a phone in landscape and on a desktop monitor.
 *
 * The renderer is stateless with respect to the simulation — it reads a
 * `SimState` snapshot and never mutates it.
 */

import {
  BOSS_HEIGHT,
  BOSS_WIDTH,
  CRATE_SHOT_GAIN,
  CRATE_SIZE,
  INFANTRY_RADIUS,
  MINE_RADIUS,
  PROJECTILE_RADIUS,
  SQUAD_X,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from '../game/constants';
import type { Faction } from '../core/types';
import type { SimState } from '../game/types';
import { GROUND_HEIGHT, GROUND_Y } from './Background';
import type { Background } from './Background';
import type { UnitSprite, UnitSpriteBank } from './UnitSprites';

export interface HudInfo {
  readonly fps: number;
  readonly nodeName: string;
  readonly year: string;
  readonly theater: string;
  readonly tier: number;
  readonly weaponName: string;
  readonly upgrades: string;
  /** True while the run is paused on the end panel. */
  readonly finished: boolean;
}

export interface RendererOptions {
  readonly background: Background;
  /** Enemy soldiers, at full size. */
  readonly units: UnitSpriteBank;
  /** The player's squad, drawn smaller so a formation of them fits the band. */
  readonly squadUnits: UnitSpriteBank;
  readonly faction: Faction;
  /** Campaign tier of the node being played — selects the enemy uniform. */
  readonly tier: number;
}

const FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export class RunRenderer {
  private readonly options: RendererOptions;

  constructor(options: RendererOptions) {
    this.options = options;
  }

  /**
   * Letterbox the logical space into the canvas and return the transform.
   * `pixelRatio` is the device pixel ratio already applied by the surface.
   */
  applyViewport(
    ctx: CanvasRenderingContext2D,
    cssWidth: number,
    cssHeight: number,
    pixelRatio: number,
  ): number {
    const scale = Math.min(cssWidth / VIEW_WIDTH, cssHeight / VIEW_HEIGHT);
    const offsetX = (cssWidth - VIEW_WIDTH * scale) / 2;
    const offsetY = (cssHeight - VIEW_HEIGHT * scale) / 2;
    ctx.setTransform(
      pixelRatio * scale,
      0,
      0,
      pixelRatio * scale,
      pixelRatio * offsetX,
      pixelRatio * offsetY,
    );
    return scale;
  }

  draw(ctx: CanvasRenderingContext2D, state: SimState, hud: HudInfo): void {
    const scrollX = state.scrollX;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    ctx.clip();

    this.options.background.draw(ctx, scrollX, VIEW_WIDTH, VIEW_HEIGHT, state.time);
    this.drawGates(ctx, state, scrollX);
    this.drawWires(ctx, state, scrollX);
    this.drawMines(ctx, state, scrollX);
    this.drawCrates(ctx, state, scrollX);
    this.drawEnemies(ctx, state, scrollX);
    this.drawBunker(ctx, state, scrollX);
    this.drawSquad(ctx, state);
    this.drawProjectiles(ctx, state, scrollX);
    this.drawPopups(ctx, state, scrollX);
    this.drawForeground(ctx, state);
    if (state.phase === 'boss') this.drawBossBar(ctx, state);
    this.drawTopBar(ctx, state, hud);
    if (hud.finished) this.drawEndPanel(ctx, state, hud);

    ctx.restore();
  }

  /** Screen x of a world position. */
  private sx(worldX: number, scrollX: number): number {
    return worldX - scrollX;
  }

  // ------------------------------------------------------------------ world

  private drawGates(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    for (const gate of state.gates) {
      const x = this.sx(gate.x, scrollX);
      if (x < -80 || x > VIEW_WIDTH + 80) continue;

      const good = gate.op === 'add' || gate.op === 'mul';
      const base = good ? '90, 200, 120' : '210, 90, 70';
      const alpha = gate.resolved ? 0.1 : 0.22;

      ctx.fillStyle = `rgba(${base}, ${alpha})`;
      ctx.fillRect(x - 16, gate.y, 32, gate.height);
      ctx.strokeStyle = `rgba(${base}, ${gate.resolved ? 0.25 : 0.8})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 16, gate.y, 32, gate.height);

      // Operation label, repeated down the band so it reads while moving.
      const labelSize = 30;
      ctx.font = `700 ${labelSize}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = gate.resolved ? 'rgba(230,240,225,0.35)' : '#f2f6ea';
      const rows = Math.max(1, Math.floor(gate.height / (labelSize + 16)));
      for (let i = 0; i < rows; i += 1) {
        const y = gate.y + labelSize / 2 + 10 + i * (labelSize + 10);
        ctx.fillText(this.gateLabel(gate.op, gate.value), x, y);
      }
    }
  }

  private gateLabel(op: string, value: number): string {
    switch (op) {
      case 'add':
        return `+${value}`;
      case 'mul':
        return `x${value}`;
      case 'sub':
        return `-${value}`;
      case 'div':
        return `÷${value}`;
      default:
        return String(value);
    }
  }

  private drawWires(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    for (const wire of state.wires) {
      const x = this.sx(wire.x, scrollX);
      if (x + wire.length < -60 || x > VIEW_WIDTH + 60) continue;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, wire.y, wire.length, wire.height);
      ctx.clip();

      ctx.fillStyle = 'rgba(40, 44, 40, 0.35)';
      ctx.fillRect(x, wire.y, wire.length, wire.height);

      // Coil pattern, anchored to world coordinates so it scrolls solidly.
      ctx.strokeStyle = wire.flash > 0 ? 'rgba(255, 180, 120, 0.95)' : 'rgba(190, 196, 200, 0.7)';
      ctx.lineWidth = 2;
      const step = 26;
      const start = Math.floor(x / step) * step;
      for (let cx = start; cx < x + wire.length + step; cx += step) {
        ctx.beginPath();
        ctx.moveTo(cx, wire.y + 6);
        ctx.lineTo(cx + step * 0.6, wire.y + wire.height - 6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + step * 0.6, wire.y + 6);
        ctx.lineTo(cx, wire.y + wire.height - 6);
        ctx.stroke();
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(220, 220, 210, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, wire.y, wire.length, wire.height);
    }
  }

  private drawMines(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    for (const mine of state.mines) {
      const x = this.sx(mine.x, scrollX);
      if (x < -60 || x > VIEW_WIDTH + 60) continue;

      const armed = mine.armed;
      ctx.save();
      ctx.translate(x, mine.y);

      if (armed) {
        ctx.fillStyle = 'rgba(20, 18, 16, 0.85)';
        ctx.beginPath();
        ctx.arc(0, 0, MINE_RADIUS * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(90, 80, 70, 0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        continue;
      }

      ctx.fillStyle = '#3c3f42';
      ctx.beginPath();
      ctx.arc(0, 0, MINE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#22262a';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Spike ring.
      ctx.strokeStyle = '#565c60';
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i += 1) {
        const angle = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * MINE_RADIUS * 0.6, Math.sin(angle) * MINE_RADIUS * 0.6);
        ctx.lineTo(Math.cos(angle) * MINE_RADIUS * 1.35, Math.sin(angle) * MINE_RADIUS * 1.35);
        ctx.stroke();
      }

      // Warning lamp, blinking with run time.
      const blink = (Math.sin(state.time * 8) + 1) / 2;
      ctx.fillStyle = `rgba(255, ${80 + blink * 120}, 60, ${0.45 + blink * 0.5})`;
      ctx.beginPath();
      ctx.arc(0, 0, MINE_RADIUS * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawCrates(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    for (const crate of state.crates) {
      if (crate.taken) continue;
      const x = this.sx(crate.x, scrollX);
      if (x < -80 || x > VIEW_WIDTH + 80) continue;

      const half = CRATE_SIZE / 2;
      ctx.save();
      ctx.translate(x, crate.y);

      const glow = crate.hitFlash > 0;
      ctx.fillStyle = glow ? '#8a6a3a' : '#6b4f2c';
      ctx.fillRect(-half, -half, CRATE_SIZE, CRATE_SIZE);
      ctx.strokeStyle = glow ? '#ffd977' : '#3a2a16';
      ctx.lineWidth = 3;
      ctx.strokeRect(-half, -half, CRATE_SIZE, CRATE_SIZE);
      ctx.strokeStyle = 'rgba(30, 22, 12, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-half, -half);
      ctx.lineTo(half, half);
      ctx.moveTo(half, -half);
      ctx.lineTo(-half, half);
      ctx.stroke();

      // Paratrooper counter.
      ctx.font = `700 26px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = glow ? '#fff2cc' : '#f0e2c0';
      ctx.fillText(`+${crate.value}`, 0, 1);

      ctx.font = `600 11px ${FONT}`;
      ctx.fillStyle = 'rgba(240, 226, 192, 0.7)';
      ctx.fillText(`SHOOT +${CRATE_SHOT_GAIN}`, 0, half + 12);
      ctx.restore();
    }
  }

  private drawEnemies(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    const sprite =
      this.options.units.enemyFor(this.options.faction, this.options.tier) ??
      this.options.units.squad(this.options.faction);
    if (!sprite) return;

    for (const enemy of state.infantry) {
      const x = this.sx(enemy.x, scrollX);
      if (x < -80 || x > VIEW_WIDTH + 100) continue;

      ctx.save();
      ctx.translate(x, enemy.y);
      // Enemies advance right-to-left, so mirror them to face the squad.
      ctx.scale(-1, 1);
      this.drawUnitSprite(ctx, sprite, enemy.flash > 0);
      ctx.restore();

      // Damage pip when hit.
      if (enemy.flash > 0) {
        ctx.fillStyle = 'rgba(255, 200, 140, 0.85)';
        ctx.beginPath();
        ctx.arc(x, enemy.y - INFANTRY_RADIUS - 12, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawUnitSprite(
    ctx: CanvasRenderingContext2D,
    sprite: UnitSprite,
    flash = false,
  ): void {
    const draw = (): void => {
      ctx.drawImage(sprite.image, -sprite.width / 2, -sprite.height, sprite.width, sprite.height);
    };
    draw();
    if (flash) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55;
      draw();
      ctx.restore();
    }
    if (sprite.status === 'procedural') {
      ctx.strokeStyle = 'rgba(200, 161, 58, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-sprite.width / 2, -sprite.height, sprite.width, sprite.height);
    }
  }

  private drawBunker(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    const x = this.sx(state.bossWorldX, scrollX);
    if (x < -BOSS_WIDTH || x > VIEW_WIDTH + BOSS_WIDTH) return;

    const baseY = Math.min(GROUND_Y + 26, VIEW_HEIGHT - 12);
    const top = baseY - BOSS_HEIGHT;
    const left = x - BOSS_WIDTH / 2;
    const ratio = state.bossMaxHp > 0 ? state.bossHp / state.bossMaxHp : 0;

    ctx.save();
    // Concrete emplacement with a sloped front.
    ctx.fillStyle = '#40474a';
    ctx.beginPath();
    ctx.moveTo(left, baseY);
    ctx.lineTo(left + 26, top + 40);
    ctx.lineTo(x + 10, top);
    ctx.lineTo(x + BOSS_WIDTH / 2, top + 30);
    ctx.lineTo(x + BOSS_WIDTH / 2, baseY);
    ctx.closePath();
    ctx.fill();

    // Shadowed bunker mouth.
    ctx.fillStyle = '#14171a';
    ctx.fillRect(x - 24, top + 54, 60, 44);
    ctx.fillStyle = '#2a2f33';
    ctx.fillRect(x - 12, top + 34, 108, 16);

    // Damage cracks appear as the bar drains.
    ctx.strokeStyle = `rgba(15, 15, 15, ${0.35 + (1 - ratio) * 0.5})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i += 1) {
      const crackX = left + 20 + i * 38;
      ctx.beginPath();
      ctx.moveTo(crackX, top + 20 + i * 8);
      ctx.lineTo(crackX + 14, top + 54 + i * 10);
      ctx.stroke();
    }

    // Smoke while it burns.
    if (ratio < 0.66) {
      const puffs = ratio < 0.33 ? 3 : 2;
      for (let i = 0; i < puffs; i += 1) {
        const t = (state.time * 0.6 + i * 0.37) % 1;
        ctx.fillStyle = `rgba(60, 58, 56, ${0.35 * (1 - t)})`;
        ctx.beginPath();
        ctx.arc(x + 10 + i * 16, top - t * 90, 16 + t * 26, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * The squad reads as a small phalanx centred on the collision band: three
   * columns of three, spaced so each soldier is legible. More troops than drawn
   * slots are represented by the HUD count (and by the muzzle fan).
   */
  private drawSquad(ctx: CanvasRenderingContext2D, state: SimState): void {
    const sprite = this.options.squadUnits.squad(this.options.faction);
    if (!sprite) return;

    const columns = 3;
    const rows = 3;
    const slots = columns * rows;
    const drawn = Math.max(1, Math.min(slots, state.troops));
    const spacingX = Math.max(18, sprite.width * 0.62);
    const spacingY = Math.max(20, sprite.height * 0.52);

    const blockWidth = spacingX * (columns - 1) + sprite.width;
    const blockHeight = spacingY * (rows - 1) + sprite.height;

    // Soft ground shadow under the formation.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(
      SQUAD_X,
      state.squadY + blockHeight * 0.34,
      blockWidth * 0.45,
      12,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    // Back rows first so the front rank overlaps them.
    const order = [...Array(drawn).keys()].sort((a, b) => a % columns - (b % columns));
    for (const index of order) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const offsetX = (column - (columns - 1) / 2) * spacingX;
      const offsetY = (row - (rows - 1) / 2) * spacingY;
      ctx.save();
      ctx.translate(SQUAD_X + offsetX, state.squadY + offsetY);
      // Soldiers in the left columns lead, so the formation reads as advancing.
      ctx.globalAlpha = 0.88 + row * 0.06;
      ctx.drawImage(sprite.image, -sprite.width / 2, -sprite.height * 0.55);
      ctx.restore();
    }

    // Muzzle flashes along the leading edge while the squad is firing.
    const flashPhase = state.time % 0.09;
    if (state.troops > 0 && state.status === 'running' && flashPhase < 0.045) {
      ctx.fillStyle = 'rgba(255, 226, 150, 0.8)';
      for (let i = 0; i < Math.min(3, drawn); i += 1) {
        const y = state.squadY + (i - 1) * spacingY;
        ctx.beginPath();
        ctx.moveTo(SQUAD_X + blockWidth * 0.4, y - 4);
        ctx.lineTo(SQUAD_X + blockWidth * 0.4 + 16, y);
        ctx.lineTo(SQUAD_X + blockWidth * 0.4, y + 4);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    ctx.strokeStyle = 'rgba(255, 236, 170, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const shot of state.projectiles) {
      const x = this.sx(shot.x, scrollX);
      if (x < -20 || x > VIEW_WIDTH + 20) continue;
      ctx.moveTo(x - 14, shot.y);
      ctx.lineTo(x + PROJECTILE_RADIUS, shot.y);
    }
    ctx.stroke();
  }

  private drawPopups(ctx: CanvasRenderingContext2D, state: SimState, scrollX: number): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const popup of state.popups) {
      const x = this.sx(popup.x, scrollX);
      if (x < -120 || x > VIEW_WIDTH + 120) continue;
      const alpha = Math.max(0, Math.min(1, popup.life * 1.6));
      const colour =
        popup.tone === 'gain' ? '168, 224, 120' : popup.tone === 'loss' ? '240, 120, 96' : '226, 232, 226';
      ctx.font = `700 20px ${FONT}`;
      ctx.fillStyle = `rgba(10, 14, 10, ${alpha * 0.6})`;
      const width = ctx.measureText(popup.text).width;
      ctx.fillRect(x - width / 2 - 6, popup.y - 13, width + 12, 26);
      ctx.fillStyle = `rgba(${colour}, ${alpha})`;
      ctx.fillText(popup.text, x, popup.y);
    }
  }

  /** Dark vignette at the edges, plus the smoke haze along the horizon. */
  private drawForeground(ctx: CanvasRenderingContext2D, _state: SimState): void {
    const gradient = ctx.createLinearGradient(0, GROUND_Y + GROUND_HEIGHT - 30, 0, VIEW_HEIGHT);
    gradient.addColorStop(0, 'rgba(12, 12, 10, 0)');
    gradient.addColorStop(1, 'rgba(12, 12, 10, 0.55)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, GROUND_Y + GROUND_HEIGHT - 30, VIEW_WIDTH, 60);
  }

  // -------------------------------------------------------------------- HUD

  private drawTopBar(ctx: CanvasRenderingContext2D, state: SimState, hud: HudInfo): void {
    ctx.save();
    ctx.fillStyle = 'rgba(8, 11, 9, 0.55)';
    ctx.fillRect(0, 0, VIEW_WIDTH, 54);

    // Troop count.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = state.troops > 0 ? '#e8f0dc' : '#f0a090';
    ctx.fillText(String(state.troops), 24, 27);
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = 'rgba(200, 215, 200, 0.7)';
    ctx.fillText('TROOPS', 24 + ctx.measureText(String(state.troops)).width + 26, 29);

    if (state.revivesLeft > 0) {
      ctx.fillStyle = 'rgba(168, 224, 120, 0.9)';
      ctx.fillText(`+${state.revivesLeft} REVIVE`, 24, 46);
    }

    // Weapon and upgrades.
    ctx.textAlign = 'center';
    ctx.font = `600 14px ${FONT}`;
    ctx.fillStyle = 'rgba(226, 236, 220, 0.9)';
    ctx.fillText(
      `${hud.nodeName.toUpperCase()} · ${hud.year} · TIER ${hud.tier}`,
      VIEW_WIDTH / 2,
      18,
    );
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = 'rgba(200, 215, 200, 0.75)';
    ctx.fillText(`${hud.weaponName} · ${hud.upgrades}`, VIEW_WIDTH / 2, 38);

    // Progress or FPS on the right.
    ctx.textAlign = 'right';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = 'rgba(200, 215, 200, 0.8)';
    ctx.fillText(`${hud.fps.toFixed(0)} FPS`, VIEW_WIDTH - 24, 18);

    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = 'rgba(200, 215, 200, 0.6)';
    ctx.fillText(
      state.phase === 'boss' ? 'END ZONE' : `${Math.round(state.progress * 100)}% ADVANCE`,
      VIEW_WIDTH - 24,
      38,
    );

    // Advance progress bar.
    if (state.phase === 'advance') {
      const barX = VIEW_WIDTH / 2 - 180;
      const barY = 46;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(barX, barY, 360, 5);
      ctx.fillStyle = 'rgba(200, 224, 150, 0.9)';
      ctx.fillRect(barX, barY, 360 * Math.min(1, state.progress), 5);
    }
    ctx.restore();
  }

  private drawBossBar(ctx: CanvasRenderingContext2D, state: SimState): void {
    const ratio = state.bossMaxHp > 0 ? Math.max(0, state.bossHp / state.bossMaxHp) : 0;
    const barWidth = 620;
    const barX = (VIEW_WIDTH - barWidth) / 2;
    const barY = 74;

    ctx.save();
    ctx.fillStyle = 'rgba(8, 11, 9, 0.7)';
    ctx.fillRect(barX - 10, barY - 22, barWidth + 20, 62);
    ctx.strokeStyle = 'rgba(200, 161, 58, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX - 10, barY - 22, barWidth + 20, 62);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 15px ${FONT}`;
    ctx.fillStyle = '#f2e6c8';
    ctx.fillText(state.bossName.toUpperCase(), barX, barY - 8);

    ctx.textAlign = 'right';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = state.bossTimeLeft < 10 ? '#f09070' : 'rgba(220, 230, 220, 0.85)';
    ctx.fillText(`${state.bossTimeLeft.toFixed(1)}s`, barX + barWidth, barY - 8);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(barX, barY + 2, barWidth, 16);
    const hue = 120 * ratio;
    ctx.fillStyle = `hsl(${hue}, 62%, 48%)`;
    ctx.fillRect(barX, barY + 2, barWidth * ratio, 16);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY + 2, barWidth, 16);

    ctx.textAlign = 'center';
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = 'rgba(240, 245, 235, 0.9)';
    ctx.fillText(
      `${Math.ceil(state.bossHp)} / ${state.bossMaxHp} HP`,
      VIEW_WIDTH / 2,
      barY + 10,
    );
    ctx.restore();
  }

  private drawEndPanel(ctx: CanvasRenderingContext2D, state: SimState, hud: HudInfo): void {
    ctx.save();
    ctx.fillStyle = 'rgba(6, 9, 7, 0.72)';
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    const won = state.status === 'won';
    const title = won
      ? 'SECTOR CLEARED'
      : state.lossReason === 'time-expired'
        ? 'TIME EXPIRED'
        : 'SQUAD WIPED';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 56px ${FONT}`;
    ctx.fillStyle = won ? '#c9e06a' : '#e08a70';
    ctx.fillText(title, VIEW_WIDTH / 2, 250);

    ctx.font = `600 20px ${FONT}`;
    ctx.fillStyle = 'rgba(230, 240, 225, 0.9)';
    ctx.fillText(`${hud.nodeName} · ${hud.year} · ${hud.theater}`, VIEW_WIDTH / 2, 300);

    ctx.font = `500 17px ${FONT}`;
    ctx.fillStyle = 'rgba(210, 222, 205, 0.85)';
    const lines = [
      `troops remaining: ${state.troops}   ·   ${state.stats.kills} infantry killed   ·   ${state.stats.minesHit} mines hit`,
      `crates collected: ${state.stats.cratesCollected} (+${state.stats.troopsFromCrates} paratroopers)   ·   gates: +${state.stats.gateGains} / -${state.stats.gateLosses}`,
      `troops lost: ${state.stats.troopsLost}   ·   rounds fired: ${state.stats.shotsFired}`,
    ];
    lines.forEach((line, index) => {
      ctx.fillText(line, VIEW_WIDTH / 2, 344 + index * 26);
    });

    if (won) {
      ctx.fillStyle = '#c9e06a';
      ctx.font = `600 18px ${FONT}`;
      ctx.fillText('WAR BONDS AWARDED — next sector unlocked', VIEW_WIDTH / 2, 450);
    }

    ctx.fillStyle = 'rgba(226, 236, 220, 0.9)';
    ctx.font = `600 18px ${FONT}`;
    ctx.fillText('R  redeploy        ESC  back to base', VIEW_WIDTH / 2, 520);
    ctx.restore();
  }
}
