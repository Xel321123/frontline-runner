/**
 * PlaySession — the run's composition root.
 *
 * Owns the fixed-timestep loop, the pointer input, the renderer and the audio
 * policy, and is the only place where the pure simulation meets the browser.
 *
 * Loop shape: `requestAnimationFrame` gives a variable frame delta which is
 * accumulated and consumed in exact 1/60 s steps (max 5 per frame, with the
 * backlog dropped) so physics is deterministic and identical to the headless
 * harness in `scripts/simulate-run.mjs`. Rendering happens once per frame.
 */

import type { CampaignNode } from '../data/campaignData';
import type { Faction } from '../core/types';
import type { StageDefinition } from '../core/progression';
import type { AssetLoader, GameStorage, SoundManager } from '../engine';
import { createVerticalInput } from '../engine/Input';
import type { VerticalInput } from '../engine/Input';
import {
  FIXED_DT,
  MAX_FRAME_DT,
  MAX_SUBSTEPS,
  SQUAD_BAND_HEIGHT,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from '../game/constants';
import { createLevelPlan } from '../game/level';
import { createLoadout, toSimConfig } from '../game/loadout';
import { Simulation } from '../game/Simulation';
import type { RunStatus, SimEvent, SimState } from '../game/types';
import type { CanvasSurface } from '../platform/Display';
import { computeGameViewport } from '../platform/Viewport';
import { Background } from '../render/Background';
import { RunRenderer } from '../render/Renderer';
import type { HudInfo } from '../render/Renderer';
import { UnitSpriteBank } from '../render/UnitSprites';

export interface RunOutcome {
  readonly nodeId: string;
  readonly status: RunStatus;
  readonly troops: number;
  readonly bondsAwarded: number;
  readonly unlockedStage: string | null;
}

export interface PlaySessionOptions {
  readonly surface: CanvasSurface;
  readonly loader: AssetLoader;
  readonly storage: GameStorage;
  readonly sound: SoundManager;
  readonly faction: Faction;
  readonly node: CampaignNode;
  readonly stage: StageDefinition;
  /** Called when the player leaves the run (ESC or after finishing). */
  readonly onExit: (outcome: RunOutcome) => void;
}

const HALF_BAND = SQUAD_BAND_HEIGHT / 2;

export class PlaySession {
  private readonly options: PlaySessionOptions;
  private readonly input: VerticalInput;
  private readonly renderer: RunRenderer;
  private readonly unitBank: UnitSpriteBank;
  private readonly squadBank: UnitSpriteBank;

  private simulation: Simulation;
  private weaponName = '';
  private frameHandle: number | null = null;
  private lastFrameTime = 0;
  private accumulator = 0;
  private disposed = false;

  private fpsValue = 60;
  private readonly soundGate: Record<string, number> = {};
  private awarded = false;
  private outcomeValue: RunOutcome | null = null;

  constructor(options: PlaySessionOptions) {
    this.options = options;

    this.unitBank = new UnitSpriteBank(options.loader, { targetHeight: 74 });
    this.squadBank = new UnitSpriteBank(options.loader, { targetHeight: 56 });
    this.renderer = new RunRenderer({
      background: new Background(options.node.id),
      units: this.unitBank,
      squadUnits: this.squadBank,
      faction: options.faction,
      tier: options.stage.tier,
    });

    this.input = createVerticalInput({
      element: options.surface.canvas,
      // Input needs the same letterbox maths the renderer uses, otherwise the
      // squad would follow the pointer's screen position rather than its
      // position inside the 16:9 play area.
      getViewport: () =>
        computeGameViewport(
          options.surface.width,
          options.surface.height,
          VIEW_WIDTH,
          VIEW_HEIGHT,
        ),
      minY: HALF_BAND,
      maxY: VIEW_HEIGHT - HALF_BAND,
      initialY: VIEW_HEIGHT / 2,
    });

    this.simulation = this.createSimulation();
    window.addEventListener('keydown', this.onKeyDown);
  }

  // ------------------------------------------------------------------ public

  start(): void {
    if (this.frameHandle !== null || this.disposed) return;
    this.lastFrameTime = performance.now();
    this.accumulator = 0;
    this.frameHandle = requestAnimationFrame(this.onFrame);
  }

  stop(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.input.dispose();
    this.unitBank.dispose();
    this.squadBank.dispose();
    window.removeEventListener('keydown', this.onKeyDown);
  }

  get state(): SimState {
    return this.simulation.state;
  }

  get fps(): number {
    return this.fpsValue;
  }

  get outcome(): RunOutcome | null {
    return this.outcomeValue;
  }

  // ------------------------------------------------------------------- loop

  private readonly onFrame = (now: number): void => {
    if (this.disposed) return;

    const frameSeconds = Math.min(MAX_FRAME_DT, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    // Exponential moving average, so the readout is stable enough to trust.
    if (frameSeconds > 0) {
      this.fpsValue = this.fpsValue * 0.9 + (1 / frameSeconds) * 0.1;
    }

    this.input.update(frameSeconds);
    this.accumulator += frameSeconds;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this.simulation.update(FIXED_DT, { targetY: this.input.targetY });
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    if (steps >= MAX_SUBSTEPS) this.accumulator = 0;

    this.handleEvents(this.simulation.takeEvents());
    this.settleOutcome();
    this.render();

    this.frameHandle = requestAnimationFrame(this.onFrame);
  };

  private currentViewport(): { cssWidth: number; cssHeight: number } {
    const { surface } = this.options;
    return { cssWidth: surface.width, cssHeight: surface.height };
  }

  private render(): void {
    const { surface } = this.options;
    const ctx = surface.ctx;
    const viewport = this.currentViewport();

    // Letterbox bars outside the 16:9 play area.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050706';
    ctx.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
    ctx.restore();

    this.renderer.applyViewport(
      ctx,
      viewport.cssWidth,
      viewport.cssHeight,
      surface.pixelRatio,
    );
    this.renderer.draw(ctx, this.simulation.state, this.hud());
  }

  private hud(): HudInfo {
    const { storage, stage } = this.options;
    const upgrades = storage.snapshot().upgrades;
    return {
      fps: this.fpsValue,
      nodeName: this.options.node.name,
      year: this.options.node.year,
      theater: this.options.node.theater,
      tier: stage.tier,
      weaponName: this.weaponName,
      upgrades: `FP${upgrades.firepower} AR${upgrades.armour} MO${upgrades.mobility} MK${upgrades.medkit}`,
      finished: this.simulation.state.status !== 'running',
    };
  }

  // ------------------------------------------------------------- simulation

  private createSimulation(): Simulation {
    const { faction, node, stage, storage } = this.options;
    const save = storage.snapshot();
    const loadout = createLoadout(faction, stage.index, save.upgrades);
    const plan = createLevelPlan({
      nodeId: node.id,
      nodeName: node.name,
      year: node.year,
      theater: node.theater,
      tier: stage.tier,
      bossName: node.bossName,
      bossHp: node.bossHp,
    });
    const simulation = new Simulation(plan, toSimConfig(loadout));
    // The loadout's weapon name is part of the HUD contract.
    this.weaponName = loadout.weapon.name;
    return simulation;
  }

  /** Award progression exactly once, when the run first finishes. */
  private settleOutcome(): void {
    const state = this.simulation.state;
    if (state.status === 'running' || this.awarded) return;
    this.awarded = true;

    const { storage, stage, node } = this.options;
    const before = storage.snapshot().unlockedStages;
    let bonds = 0;

    if (state.status === 'won') {
      bonds = stage.rewardBonds;
      storage.completeStage(stage.id, bonds);
    }

    const after = storage.snapshot();
    const unlocked = after.unlockedStages.find((id) => !before.includes(id)) ?? null;

    this.outcomeValue = {
      nodeId: node.id,
      status: state.status,
      troops: state.troops,
      bondsAwarded: bonds,
      unlockedStage: unlocked,
    };
  }

  // ------------------------------------------------------------------ audio

  /**
   * Simulation events → sound. The simulation never touches audio; this is the
   * only place that decides what the player hears, including the rate limits
   * that keep a 20 round/second volley from turning into a buzz.
   */
  private handleEvents(events: readonly SimEvent[]): void {
    const { sound } = this.options;
    for (const event of events) {
      switch (event.type) {
        case 'volley':
          sound.play('shot', { volume: 0.34, rate: 0.94 + Math.random() * 0.12 });
          break;
        case 'bulletHit':
          if (this.allow('hit', 90)) sound.play('hit', { volume: 0.3, rate: 1.05 });
          break;
        case 'infantryKilled':
          if (this.allow('kill', 120)) sound.play('hit', { volume: 0.5, rate: 0.9 });
          break;
        case 'infantryCollision':
          sound.play('hit', { volume: 0.85, rate: 0.75 });
          break;
        case 'mineHit':
          sound.play('explosion', { volume: 0.8, rate: 1.05 });
          break;
        case 'wireHit':
          if (this.allow('wire', 260)) sound.play('hit', { volume: 0.4, rate: 0.7 });
          break;
        case 'crateDeployed':
          sound.play('uiClick', { volume: 0.9, rate: 1.15 });
          break;
        case 'gateGain':
          sound.play('uiClick', { volume: 0.85, rate: 1.05 });
          break;
        case 'gateLoss':
          sound.play('uiBack', { volume: 0.85 });
          break;
        case 'bossPhase':
          sound.play('reload', { volume: 0.7, rate: 0.85 });
          break;
        case 'bossDestroyed':
          sound.play('explosion', { volume: 1, rate: 0.8 });
          break;
        case 'revive':
          sound.play('uiClick', { volume: 0.9, rate: 0.9 });
          break;
        case 'defeat':
          sound.play('uiBack', { volume: 1, rate: 0.7 });
          break;
      }
    }
  }

  private allow(key: string, minGapMs: number): boolean {
    const now = performance.now();
    const last = this.soundGate[key] ?? -Infinity;
    if (now - last < minGapMs) return false;
    this.soundGate[key] = now;
    return true;
  }

  // ------------------------------------------------------------------ input

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'r' || event.key === 'R') {
      if (this.simulation.state.status !== 'running') this.restart();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.options.onExit(
        this.outcomeValue ?? {
          nodeId: this.options.node.id,
          status: this.simulation.state.status,
          troops: this.simulation.state.troops,
          bondsAwarded: 0,
          unlockedStage: null,
        },
      );
      return;
    }
    if (event.key === ' ' && this.simulation.state.status !== 'running') {
      event.preventDefault();
      this.restart();
    }
  };

  private restart(): void {
    this.simulation = this.createSimulation();
    this.input.reset(VIEW_HEIGHT / 2);
    this.accumulator = 0;
    this.awarded = false;
    this.outcomeValue = null;
  }
}
