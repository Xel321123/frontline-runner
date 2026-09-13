/**
 * MatchSession — the battle's composition root.
 *
 * Owns the fixed-timestep loop, the deployment-bar input, the renderer and the
 * audio policy, and is the only place where the pure simulation meets the
 * browser. Progression is written back to the save file exactly once, when the
 * battle is decided.
 */

import type { StageDefinition } from '../core/progression';
import type { Faction } from '../core/types';
import type { GameStorage, SoundManager, SoundName } from '../engine';
import { createBattleInput, type BattleInput, type PointerState } from '../engine/Input';
import {
  FIXED_DT,
  MAX_FRAME_DT,
  MAX_SUBSTEPS,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from '../game/constants';
import { logisticsAt, slotAt, kindForHotkey } from '../game/hud';
import { createMatchConfig } from '../game/match';
import { stageTagline } from '../game/stageInfo';
import { TugSimulation } from '../game/TugSimulation';
import type { MatchCommand, MatchStatus, SimEvent } from '../game/tugTypes';
import type { UnitKind } from '../game/units';
import type { CanvasSurface } from '../platform/Display';
import { computeGameViewport } from '../platform/Viewport';
import { BattleRenderer } from '../render/BattleRenderer';

export interface BattleOutcome {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly year: string;
  readonly status: MatchStatus;
  readonly lossReason: 'base-destroyed' | 'time-expired' | null;
  /** Mission, weather and terrain, for the result panel's kicker. */
  readonly situation: string;
  readonly durationSeconds: number;
  readonly bondsAwarded: number;
  readonly bondsCollected: number;
  readonly unitsDeployed: number;
  readonly unitsLost: number;
  readonly enemyDestroyed: number;
  readonly logisticsBought: number;
  readonly playerBaseRemaining: number;
  readonly playerBaseMax: number;
  readonly enemyBaseRemaining: number;
  readonly enemyBaseMax: number;
  readonly unlockedStage: string | null;
}

export interface MatchSessionOptions {
  readonly surface: CanvasSurface;
  readonly storage: GameStorage;
  readonly sound: SoundManager;
  readonly faction: Faction;
  readonly stage: StageDefinition;
  /** Called when the player leaves mid-battle (ESC) with no result screen. */
  readonly onExit: () => void;
  /** Called once, the moment the battle is decided. */
  readonly onFinish?: (outcome: BattleOutcome) => void;
}

const HALF_BAR = 0;

export class MatchSession {
  private readonly options: MatchSessionOptions;
  private readonly simulation: TugSimulation;
  private readonly renderer = new BattleRenderer();
  private readonly input: BattleInput;

  private frameHandle: number | null = null;
  private lastTime = 0;
  private accumulator = 0;
  private fpsValue = 60;
  private paused = false;
  private awarded = false;
  private outcomeValue: BattleOutcome | null = null;
  private readonly lastPlayed = new Map<SoundName, number>();
  private now = 0;

  constructor(options: MatchSessionOptions) {
    this.options = options;
    const config = createMatchConfig(options.stage, options.storage.snapshot());
    this.simulation = new TugSimulation(config);

    this.input = createBattleInput({
      element: options.surface.canvas,
      getViewport: () =>
        computeGameViewport(
          options.surface.width,
          options.surface.height,
          VIEW_WIDTH,
          VIEW_HEIGHT,
        ),
    });
  }

  // ------------------------------------------------------------------ public

  get fps(): number {
    return this.fpsValue;
  }

  get state() {
    return this.simulation.state;
  }

  get outcome(): BattleOutcome | null {
    return this.outcomeValue;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  start(): void {
    if (this.frameHandle !== null) return;
    this.lastTime = performance.now();
    const frame = (now: number) => {
      this.frameHandle = requestAnimationFrame(frame);
      this.tick(now);
    };
    this.frameHandle = requestAnimationFrame(frame);
    // Draw one frame immediately so the canvas is not blank before the first rAF.
    this.render();
  }

  dispose(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.input.dispose();
  }

  // ------------------------------------------------------------------- frame

  private tick(now: number): void {
    const frameSeconds = Math.min(MAX_FRAME_DT, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (frameSeconds > 0) {
      this.fpsValue = this.fpsValue * 0.9 + (1 / frameSeconds) * 0.1;
    }
    this.now += frameSeconds;

    const actions = this.collectIntent();
    if (actions.togglePause) this.paused = !this.paused;

    if (!this.paused) {
      this.accumulator += frameSeconds;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this.simulation.update(FIXED_DT, actions.command);
        this.accumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps >= MAX_SUBSTEPS) this.accumulator = 0;
      this.handleEvents(this.simulation.takeEvents());
      this.settle();
    }

    this.render();
  }

  /** Turn this frame's presses and keys into a single simulation command. */
  private collectIntent(): { command: MatchCommand; togglePause: boolean } {
    let deployKind: UnitKind | null = null;
    let buyLogistics = false;
    let togglePause = false;

    for (const key of this.input.takeKeys()) {
      if (key === 'p') togglePause = true;
      else if (key === 'u') buyLogistics = true;
      else {
        const kind = kindForHotkey(key);
        if (kind) deployKind = kind;
      }
    }

    const press: PointerState | null = this.input.takePress();
    if (press) {
      // Ignore presses outside the logical area (the letterbox bars).
      const inside =
        press.x >= 0 && press.x <= VIEW_WIDTH && press.y >= 0 && press.y <= VIEW_HEIGHT;
      if (inside) {
        const slot = slotAt(press.x, press.y);
        if (slot) deployKind = slot;
        else if (logisticsAt(press.x, press.y)) buyLogistics = true;
      }
    }

    return { command: { deploy: deployKind, buyLogistics }, togglePause };
  }

  private render(): void {
    const { surface } = this.options;
    this.renderer.draw(
      surface.ctx,
      this.simulation.state,
      surface.width,
      surface.height,
      surface.pixelRatio,
      {
        nodeName: this.options.stage.name,
        year: this.options.stage.year,
        strongpoint: this.options.stage.bossName,
        faction: this.options.faction,
        enemyFaction: this.options.faction === 'allied' ? 'axis' : 'allied',
        tier: this.options.stage.tier,
        fps: this.fpsValue,
      },
    );
    if (this.paused) {
      const ctx = surface.ctx;
      ctx.save();
      ctx.setTransform(surface.pixelRatio, 0, 0, surface.pixelRatio, 0, 0);
      ctx.fillStyle = 'rgba(5, 7, 6, 0.55)';
      ctx.fillRect(0, 0, surface.width, surface.height);
      ctx.fillStyle = '#e6ecdd';
      ctx.font = '700 22px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSED — press P', surface.width / 2, surface.height / 2);
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------- audio

  private play(name: SoundName, minGapMs = 45, volume = 0.6): void {
    const last = this.lastPlayed.get(name) ?? -Infinity;
    if (this.now * 1000 - last < minGapMs) return;
    this.lastPlayed.set(name, this.now * 1000);
    this.options.sound.play(name, { volume });
  }

  private handleEvents(events: readonly SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'deploy':
          this.play('uiClick', 60, 0.5);
          break;
        case 'enemyDeploy':
          this.play('uiBack', 400, 0.25);
          break;
        case 'shot':
          this.play('shot', 40, 0.32);
          break;
        case 'shell':
          this.play('hit', 120, 0.5);
          break;
        case 'impact':
          this.play('hit', 90, 0.22);
          break;
        case 'explosion':
          this.play('explosion', 140, 0.6);
          break;
        case 'unitDown':
          this.play('hit', 110, 0.42);
          break;
        case 'playerUnitDown':
          this.play('uiBack', 320, 0.3);
          break;
        case 'baseHit':
          this.play('hit', 150, 0.34);
          break;
        case 'baseDestroyed':
          this.play('explosion', 100, 0.8);
          break;
        case 'logisticsUpgrade':
          this.play('uiClick', 80, 0.6);
          break;
        case 'victory':
          this.play('explosion', 100, 0.75);
          break;
        case 'defeat':
          this.play('uiBack', 100, 0.5);
          break;
      }
    }
  }

  // -------------------------------------------------------------- progression

  /** Write the result to the save file exactly once. */
  private settle(): void {
    const state = this.simulation.state;
    if (state.status === 'running' || this.awarded) return;
    this.awarded = true;

    const { storage, stage } = this.options;
    const before = storage.snapshot().unlockedStages;
    const report = {
      // The save file's counters, mapped to a battle: casualties are troopers
      // lost, and the "best" figure is the strongest force taken to victory.
      casualties: state.stats.losses,
      kills: state.stats.kills,
    };
    let bonds = 0;

    if (state.status === 'victory') {
      bonds = stage.rewardBonds;
      storage.completeStage(stage.id, bonds, report);
    } else {
      storage.recordLoss(stage.id, report);
    }
    // Bonds picked up on the field are banked whether or not the day was won —
    // otherwise a loss would leave the player with nothing to spend at camp.
    if (state.stats.bondsCollected > 0) {
      storage.addWarBonds(state.stats.bondsCollected);
    }

    const after = storage.snapshot();
    const unlocked = after.unlockedStages.find((id) => !before.includes(id)) ?? null;

    this.outcomeValue = {
      nodeId: stage.id,
      nodeName: stage.name,
      year: stage.year,
      situation: stageTagline(stage),
      status: state.status,
      lossReason: state.lossReason,
      durationSeconds: state.time,
      bondsAwarded: bonds,
      bondsCollected: state.stats.bondsCollected,
      unitsDeployed: state.stats.deployed,
      unitsLost: state.stats.losses,
      enemyDestroyed: state.stats.kills,
      logisticsBought: state.stats.logisticsBought,
      playerBaseRemaining: Math.ceil(state.playerBase.hp),
      playerBaseMax: state.playerBase.maxHp,
      enemyBaseRemaining: Math.ceil(state.enemyBase.hp),
      enemyBaseMax: state.enemyBase.maxHp,
      unlockedStage: unlocked,
    };
    this.options.onFinish?.(this.outcomeValue);
  }
}

export { HALF_BAR };
