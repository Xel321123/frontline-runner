/**
 * MatchSession — the battle's composition root.
 *
 * Owns the fixed-timestep loop, the camera, the DOM HUD, the renderer and the
 * audio policy. The canvas draws the world; every HUD element is DOM (see
 * BattleHud), so the battle view stays borderless at any viewport size.
 */

import { createBattleHud, type BattleHud, type BattleHudInfo } from './BattleHud';
import {
  createCanvasSurface,
  prefersTouch,
  enterFullscreen,
  tryLockLandscape,
  type CanvasSurface,
} from '../platform/Display';
import {
  cameraAt,
  clampZoomFactor,
  createCamera,
  DEFAULT_ZOOM_FACTOR,
  ZOOM_IN_FACTOR,
  type Camera,
} from '../platform/Viewport';
import { createBattleInput, type BattleInput } from '../engine/Input';
import type { GameStorage } from '../engine/Storage';
import { SoundManager, type SoundName } from '../engine/SoundManager';
import { BattleRenderer } from '../render/BattleRenderer';
import { createMatchConfig } from '../game/match';
import { TugSimulation } from '../game/TugSimulation';
import { kindForHotkey, type UnitKind } from '../game/units';
import type { MatchCommand, MatchStatus, SimEvent } from '../game/tugTypes';
import { FIXED_DT, VIEW_WIDTH } from '../game/constants';
import { stageTagline } from '../game/stageInfo';
import type { StageDefinition } from '../core/progression';
import type { Faction, StageId } from '../core/types';

export interface BattleOutcome {
  readonly nodeId: StageId;
  readonly nodeName: string;
  readonly year: string;
  readonly situation: string;
  readonly status: Extract<MatchStatus, 'victory' | 'defeat'>;
  readonly lossReason: string;
  readonly bondsAwarded: number;
  readonly bondsCollected: number;
  readonly unitsDeployed: number;
  readonly unitsLost: number;
  readonly enemyDestroyed: number;
  readonly minesHit: number;
  readonly enemyMinesHit: number;
  readonly logisticsBought: number;
  readonly playerBaseRemaining: number;
  readonly playerBaseMax: number;
  readonly enemyBaseRemaining: number;
  readonly enemyBaseMax: number;
  readonly durationSeconds: number;
  readonly unlockedStage: string | null;
}

export interface MatchHandlers {
  readonly onExit: () => void;
  readonly onFinish: (outcome: BattleOutcome) => void;
}

export interface MatchOptions {
  readonly container: HTMLElement;
  readonly storage: GameStorage;
  readonly sound: SoundManager;
  readonly stage: StageDefinition;
  readonly faction: Faction;
  readonly handlers: MatchHandlers;
}

const NO_COMMAND: MatchCommand = Object.freeze({ deploy: null, buyLogistics: false });
/** Upper bound on catch-up steps so a stalled tab cannot lock the loop. */
const MAX_STEPS = 5;

export interface MatchSession {
  readonly dispose: () => void;
  readonly outcome: () => BattleOutcome | null;
  readonly togglePause: () => void;
  readonly isPaused: () => boolean;
  /** Re-measure the canvas + HUD after a viewport change. */
  readonly handleResize: () => void;
}

export function createMatchSession(options: MatchOptions): MatchSession {
  const { container, storage, sound, stage, faction, handlers } = options;
  const config = createMatchConfig(stage, storage.snapshot());
  const simulation = new TugSimulation(config);

  const surface: CanvasSurface = createCanvasSurface(container);
  const renderer = new BattleRenderer();

  const touch = prefersTouch();
  const hudInfo: BattleHudInfo = {
    nodeName: config.nodeName,
    year: config.year,
    strongpoint: config.strongpoint,
    faction,
    enemyFaction: faction === 'allied' ? 'axis' : 'allied',
    tier: config.tier,
    touch,
  };

  let disposed = false;
  let paused = false;
  let zoomFactor = DEFAULT_ZOOM_FACTOR;
  let panX = 0;
  let panHold = 0;
  let dragging = false;
  let followX = VIEW_WIDTH / 2;
  let camera: Camera = createCamera(surface.width, surface.height);
  let finished = false;
  let outcome: BattleOutcome | null = null;

  // --- HUD ------------------------------------------------------------------
  const hud: BattleHud = createBattleHud(container, hudInfo, {
    onDeploy: (kind) => issue({ deploy: kind, buyLogistics: false }),
    onLogistics: () => issue({ deploy: null, buyLogistics: true }),
    onAbort: () => handlers.onExit(),
    onPause: () => {
      paused = !paused;
      hud.setPaused(paused);
      play('uiClick');
    },
    onZoom: () => {
      zoomFactor = zoomFactor > DEFAULT_ZOOM_FACTOR ? DEFAULT_ZOOM_FACTOR : clampZoomFactor(ZOOM_IN_FACTOR);
      hud.setZoomed(zoomFactor > DEFAULT_ZOOM_FACTOR);
      play('uiClick');
    },
    onRecenter: () => {
      panX = 0;
      panHold = 0;
      play('uiClick');
    },
  });

  function issue(command: MatchCommand): void {
    if (disposed || paused) return;
    simulation.update(0, command);
  }

  // --- audio ----------------------------------------------------------------
  let audioBlocked = false;
  const lastPlayed = new Map<SoundName, number>();

  function play(name: SoundName, minGapMs = 0, volume = 1): void {
    if (audioBlocked) return;
    const now = performance.now();
    const last = lastPlayed.get(name) ?? -Infinity;
    if (now - last < minGapMs) return;
    lastPlayed.set(name, now);
    try {
      sound.play(name, { volume });
    } catch {
      audioBlocked = true;
    }
  }

  function shotSound(kind: UnitKind): SoundName {
    if (kind === 'rifleman') return 'rifleShot';
    if (kind === 'smg') return 'smgShot';
    return 'mgShot';
  }

  function handleEvents(events: readonly SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'deploy':
          play('deploy');
          break;
        case 'shot':
          play(shotSound((event.kind ?? 'rifleman') as UnitKind), 0, 0.5);
          break;
        case 'shell':
          play('shellFire', 0, 0.8);
          break;
        case 'impact':
          play(event.metal ? 'ricochet' : 'impact', 0, 0.5);
          break;
        case 'explosion':
          play('explosion', 0, 0.7);
          break;
        case 'mineBlast':
          play('mineBlast', 0, 0.8);
          break;
        case 'baseHit':
          play('impact', 0, 0.6);
          break;
        case 'baseDestroyed':
          play('explosion', 0, 1);
          break;
        case 'logisticsUpgrade':
          play('upgrade');
          break;
        case 'trenchOverrun':
          play('uiBack', 0, 0.5);
          break;
        default:
          break;
      }
    }
  }

  // --- input ----------------------------------------------------------------
  const input: BattleInput = createBattleInput({
    element: surface.canvas,
    onFirstGesture: () => {
      void sound.unlock();
    },
  });

  function handleKeys(): void {
    for (const key of input.takeKeys()) {
      if (key === 'p') {
        paused = !paused;
        hud.setPaused(paused);
        play('uiClick');
        continue;
      }
      if (key === 'escape') {
        handlers.onExit();
        continue;
      }
      if (key === 'u') {
        issue({ deploy: null, buyLogistics: true });
        continue;
      }
      if (key === 'z') {
        zoomFactor = zoomFactor > DEFAULT_ZOOM_FACTOR ? DEFAULT_ZOOM_FACTOR : clampZoomFactor(ZOOM_IN_FACTOR);
        hud.setZoomed(zoomFactor > DEFAULT_ZOOM_FACTOR);
        continue;
      }
      const kind = kindForHotkey(key);
      if (kind) issue({ deploy: kind, buyLogistics: false });
    }
  }

  function handleDrag(): void {
    const drag = input.takeDrag();
    const pointer = input.pointer;
    dragging = input.pressing;
    if (!drag || !pointer) return;
    // Never pan from a touch that started on the deployment cards.
    if (pointer.y > surface.height - 130) return;
    panX -= drag.dx / camera.zoom;
    panHold = 4;
  }

  // --- loop -----------------------------------------------------------------
  let raf = 0;
  let accumulator = 0;
  let lastFrame = 0;
  let fps = 60;

  function updateCamera(dt: number): void {
    const state = simulation.state;
    const target = state.focusX;
    followX += (target - followX) * Math.min(1, dt * 1.6);

    if (panHold > 0) panHold = Math.max(0, panHold - dt);
    else if (!dragging) panX += (0 - panX) * Math.min(1, dt * 0.5);

    camera = cameraAt(surface.width, surface.height, followX + panX, zoomFactor);
  }

  function frame(now: number): void {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (lastFrame === 0) lastFrame = now;
    const elapsed = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    fps = fps * 0.9 + (1 / Math.max(elapsed, 1 / 240)) * 0.1;

    handleKeys();
    handleDrag();

    // The simulation runs on its own fixed step; the DOM HUD is refreshed once
    // per frame from the resulting state.
    if (!paused && simulation.state.status === 'running') {
      accumulator += elapsed;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
        simulation.update(FIXED_DT, NO_COMMAND);
        accumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps >= MAX_STEPS) accumulator = 0;
    }

    const state = simulation.state;
    handleEvents(simulation.takeEvents());

    updateCamera(elapsed);
    renderer.draw(surface.ctx, state, camera, surface.pixelRatio, {
      strongpoint: config.strongpoint,
      paused,
    });
    hud.update(state, Math.round(fps));

    if (!finished && state.status !== 'running') {
      finished = true;
      outcome = settle(state.status === 'victory' ? 'victory' : 'defeat', state.lossReason ?? 'time-expired');
    }
  }

  function settle(status: 'victory' | 'defeat', lossReason: string): BattleOutcome {
    const state = simulation.state;
    const stats = state.stats;
    const bondsAwarded = status === 'victory' ? stage.rewardBonds : 0;

    if (bondsAwarded > 0) {
      storage.completeStage(stage.id, bondsAwarded, {
        casualties: stats.losses,
        kills: stats.kills,
      });
    } else {
      storage.recordLoss(stage.id, { casualties: stats.losses, kills: stats.kills });
    }
    if (stats.bondsCollected > 0) storage.addWarBonds(stats.bondsCollected);

    play(status === 'victory' ? 'upgrade' : 'uiBack');

    const unlocked = storage.snapshot();
    const outcomeValue: BattleOutcome = {
      nodeId: stage.id,
      nodeName: stage.name,
      year: stage.year,
      situation: stageTagline(stage),
      status,
      lossReason,
      bondsAwarded,
      bondsCollected: stats.bondsCollected,
      unitsDeployed: stats.deployed,
      unitsLost: stats.losses,
      enemyDestroyed: stats.kills,
      minesHit: stats.minesHit,
      enemyMinesHit: stats.enemyMinesHit,
      logisticsBought: stats.logisticsBought,
      playerBaseRemaining: Math.max(0, Math.round(state.playerBase.hp)),
      playerBaseMax: state.playerBase.maxHp,
      enemyBaseRemaining: Math.max(0, Math.round(state.enemyBase.hp)),
      enemyBaseMax: state.enemyBase.maxHp,
      durationSeconds: state.time,
      unlockedStage: unlocked.unlockedStages[unlocked.unlockedStages.length - 1] ?? null,
    };
    return outcomeValue;
  }

  surface.onDraw = () => {
    if (disposed) return;
    camera = cameraAt(surface.width, surface.height, followX + panX, zoomFactor);
    renderer.draw(surface.ctx, simulation.state, camera, surface.pixelRatio, {
      strongpoint: config.strongpoint,
      paused,
    });
  };

  // Fullscreen is best requested from a real gesture (the Deploy tap), but if
  // the battle is entered another way this is the next best moment.
  void enterFullscreen();
  void tryLockLandscape();

  raf = requestAnimationFrame(frame);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      surface.onDraw = null;
      input.dispose();
      hud.dispose();
      surface.dispose();
      container.innerHTML = '';
    },
    outcome(): BattleOutcome | null {
      return outcome;
    },
    togglePause(): void {
      paused = !paused;
      hud.setPaused(paused);
    },
    isPaused(): boolean {
      return paused;
    },
    handleResize(): void {
      // The surface re-measures itself on resize; all we own is the camera.
      camera = cameraAt(surface.width, surface.height, followX + panX, zoomFactor);
      surface.onDraw?.(surface);
    },
  };
}

