/**
 * MatchSession — the battle's composition root.
 *
 * Owns the fixed-timestep loop, the isometric camera, the launch/target
 * selection, the DOM HUD, the renderer and the audio policy. The canvas draws the
 * world; every HUD element is DOM (see BattleHud), so the battle view stays
 * borderless at any viewport size.
 *
 * Selection is owned here rather than by the simulation: the player's chosen
 * launch pad and objective are *interface* state, and only the momentary order
 * (`fromBaseId`, `targetBaseId`) is handed to the simulation. Auto-repairing that
 * choice — when a pad or a target is razed, the nearest surviving position takes
 * over — is what stops the HUD from ever asking the player to launch from
 * somewhere that no longer exists.
 */

import { createBattleHud, type BattleHud, type BattleHudInfo, type HudSelection } from './BattleHud';
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
  screenToWorld,
  type Camera,
} from '../platform/Viewport';
import { createBattleInput, type BattleInput } from '../engine/Input';
import type { GameStorage } from '../engine/Storage';
import { SoundManager, type SoundName } from '../engine/SoundManager';
import { BattleRenderer } from '../render/BattleRenderer';
import { createScatter } from '../render/iso/scatter';
import { createMatchConfig } from '../game/match';
import { TugSimulation } from '../game/TugSimulation';
import { BASE_FOOTPRINT } from '../game/constants';
import { kindForHotkey, unitStats, type UnitKind } from '../game/units';
import type { BaseState, MatchCommand, Side, SimEvent } from '../game/tugTypes';
import { FIXED_DT } from '../game/constants';
import { stageTagline } from '../game/stageInfo';
import { isoUnproject } from '../render/iso/iso';
import type { BaseReport, BattleOutcome } from '../core/outcome';
import type { StageDefinition } from '../core/progression';
import type { Faction } from '../core/types';

export interface MatchHandlers {
  /**
   * A battle ended and produced its report. There is deliberately no `onExit`:
   * a battle can no longer be abandoned without a result, because the splash is
   * how a level ends.
   */
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

const NO_COMMAND: MatchCommand = Object.freeze({
  deploy: null,
  fromBaseId: null,
  targetBaseId: null,
  buyLogistics: false,
});

/** Upper bound on catch-up steps so a stalled tab cannot lock the loop. */
const MAX_STEPS = 5;
/** How close a tap must land to a position to select it, world units. */
const TAP_RADIUS = BASE_FOOTPRINT * 1.9;

/**
 * How long the withdraw button stays armed after the first press. Two presses
 * inside this window withdraw; outside it the first press merely arms, so a
 * stray tap at the edge of the HUD cannot throw a battle away.
 */
const WITHDRAW_CONFIRM_MS = 4000;

export interface MatchSession {
  readonly dispose: () => void;
  readonly outcome: () => BattleOutcome | null;
  readonly togglePause: () => void;
  readonly isPaused: () => boolean;
  /** Per-frame HUD message, used by the shell for onboarding hints. */
  readonly say: (message: string) => void;
  /** Re-measure the canvas + HUD after a viewport change. */
  readonly handleResize: () => void;
}

export function createMatchSession(options: MatchOptions): MatchSession {
  const { container, storage, sound, stage, faction, handlers } = options;
  const config = createMatchConfig(stage, storage.snapshot());
  const simulation = new TugSimulation(config);

  const surface: CanvasSurface = createCanvasSurface(container);
  const renderer = new BattleRenderer();

  // Scatter is built once: it is scenery, not simulation, but it must not grow
  // inside a position or on a trench line, so those are passed in as no-go areas.
  const scatter = createScatter({
    seed: config.seed,
    environment: config.environment,
    exclusions: [
      ...config.bases.map((base) => ({ x: base.x, y: base.y, r: 132 })),
      ...simulation.state.features.trenches.map((trench) => ({ x: trench.x, y: trench.y, r: 96 })),
      ...simulation.state.features.minefields.map((belt) => ({ x: belt.x, y: belt.y, r: 92 })),
      ...simulation.state.features.bridges.map((bridge) => ({ x: bridge.x, y: bridge.y, r: 110 })),
    ],
  });

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
  let panY = 0;
  let panHold = 0;
  let dragging = false;
  let followX = config.bases[0]?.x ?? 300;
  let followY = config.bases[0]?.y ?? 280;
  let camera: Camera = createCamera(surface.width, surface.height);
  let finished = false;
  let outcome: BattleOutcome | null = null;
  /** When the withdraw button was first pressed, for its two-press confirm. */
  let withdrawArmedAt = 0;

  // --- selection ------------------------------------------------------------
  let selection: HudSelection = { fromBaseId: null, targetBaseId: null };

  function aliveOn(side: Side): BaseState[] {
    return simulation.bases.filter((base) => base.side === side && !base.destroyed);
  }

  function nearestTo(x: number, y: number, side: Side): BaseState | null {
    let best: BaseState | null = null;
    let bestDistance = Infinity;
    for (const base of aliveOn(side)) {
      const d = Math.hypot(base.x - x, base.y - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = base;
      }
    }
    return best;
  }

  /** Keep the launch pad and objective pointing at positions that still stand. */
  function syncSelection(): void {
    const playerBases = aliveOn('player');
    const enemyBases = aliveOn('enemy');
    if (playerBases.length === 0 || enemyBases.length === 0) return;
    let from = playerBases.find((base) => base.id === selection.fromBaseId) ?? null;
    if (!from) {
      // A razed pad hands over to the one nearest the objective, so a push keeps
      // going instead of quietly stalling on a dead position.
      const target = enemyBases.find((base) => base.id === selection.targetBaseId) ?? enemyBases[0];
      from = target ? nearestTo(target.x, target.y, 'player') : playerBases[0] ?? null;
    }
    const to =
      enemyBases.find((base) => base.id === selection.targetBaseId) ??
      (from ? nearestObjectiveTo(from) : enemyBases[0]) ??
      null;
    selection = { fromBaseId: from ? from.id : null, targetBaseId: to ? to.id : null };
  }

  /** The hostile position a launch from `from` would be aimed at by default. */
  function nearestObjectiveTo(from: BaseState): BaseState | null {
    return nearestTo(from.x, from.y, 'enemy');
  }

  syncSelection();

  // --- HUD ------------------------------------------------------------------
  const hud: BattleHud = createBattleHud(container, hudInfo, {
    onDeploy: (kind) => launch(kind),
    onSelectFrom: (baseId) => {
      selection = { ...selection, fromBaseId: baseId };
      const base = simulation.bases.find((candidate) => candidate.id === baseId);
      // Choosing a pad re-aims at whatever is nearest it, unless the player has
      // deliberately picked an objective: this is the AoE-style default.
      if (base) {
        const nearest = nearestObjectiveTo(base);
        if (nearest) selection = { ...selection, targetBaseId: nearest.id };
        hud.say(`launch pad: ${base.name}`);
      }
      play('uiClick');
    },
    onSelectTarget: (baseId) => {
      selection = { ...selection, targetBaseId: baseId };
      const base = simulation.bases.find((candidate) => candidate.id === baseId);
      if (base) hud.say(`objective: ${base.name}`);
      play('uiClick');
    },
    onLogistics: () => {
      issue({ ...NO_COMMAND, buyLogistics: true });
    },
    onWithdraw: () => requestWithdraw(),
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
      panY = 0;
      panHold = 0;
      play('uiClick');
    },
  });

  function issue(command: MatchCommand): void {
    if (disposed || paused || finished) return;
    simulation.update(0, command);
  }

  /** A launch, with the HUD told why when it does not happen. */
  function launch(kind: UnitKind): void {
    if (disposed || paused || finished) return;
    syncSelection();
    const option = simulation.state.deployOptions.find((candidate) => candidate.kind === kind);
    const pad = simulation.bases.find((base) => base.id === selection.fromBaseId);
    if (!pad) {
      hud.say('no launch pad left');
      play('uiBack', 0, 0.5);
      return;
    }
    if (!option || !option.affordable) {
      hud.say(`${unitStats(kind).name} costs ${simulation.state.deployOptions.find((c) => c.kind === kind)?.cost ?? 0} supplies`);
      play('uiBack', 0, 0.5);
      return;
    }
    if (!option.ready) {
      hud.say(pad.cooldown > 0 ? `${pad.name} reloading — ${pad.cooldown.toFixed(1)}s` : 'at the field limit');
      play('uiBack', 0, 0.5);
      return;
    }
    issue({ deploy: kind, fromBaseId: selection.fromBaseId, targetBaseId: selection.targetBaseId, buyLogistics: false });
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
          play(shotSound(event.kind ?? 'rifleman'), 0, 0.5);
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
          hud.say(event.side === 'enemy' ? 'enemy position razed' : 'position lost');
          break;
        case 'retarget':
          // A quiet cue that a push has re-aimed itself onto a new objective.
          play('uiBack', 0, 0.35);
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

  function cycleBase(side: Side, step: number): void {
    const list = aliveOn(side);
    if (list.length === 0) return;
    const currentId = side === 'player' ? selection.fromBaseId : selection.targetBaseId;
    const index = Math.max(0, list.findIndex((base) => base.id === currentId));
    const next = list[(index + step + list.length) % list.length];
    if (!next) return;
    if (side === 'player') {
      selection = { ...selection, fromBaseId: next.id };
      hud.say(`launch pad: ${next.name}`);
    } else {
      selection = { ...selection, targetBaseId: next.id };
      hud.say(`objective: ${next.name}`);
    }
  }

  function handleKeys(): void {
    for (const key of input.takeKeys()) {
      const lower = key.toLowerCase();
      if (lower === 'p') {
        paused = !paused;
        hud.setPaused(paused);
        play('uiClick');
        continue;
      }
      if (key === 'Escape') {
        requestWithdraw();
        continue;
      }
      if (lower === 'u') {
        issue({ ...NO_COMMAND, buyLogistics: true });
        continue;
      }
      if (lower === 'z') {
        zoomFactor = zoomFactor > DEFAULT_ZOOM_FACTOR ? DEFAULT_ZOOM_FACTOR : clampZoomFactor(ZOOM_IN_FACTOR);
        hud.setZoomed(zoomFactor > DEFAULT_ZOOM_FACTOR);
        continue;
      }
      if (key === 'Tab') {
        cycleBase('player', 1);
        continue;
      }
      if (lower === 'q') {
        cycleBase('enemy', -1);
        continue;
      }
      if (lower === 'e') {
        cycleBase('enemy', 1);
        continue;
      }
      const kind = kindForHotkey(key);
      if (kind) launch(kind);
    }
  }

  function handleDrag(): void {
    const drag = input.takeDrag();
    const pointer = input.pointer;
    dragging = input.pressing;
    if (!drag || !pointer) return;
    // Never pan from a gesture that started in the HUD furniture.
    if (pointer.y > surface.height - 210 || pointer.y < 96) return;
    // Screen deltas → world deltas, through the same projection the renderer uses.
    const dz = Math.max(0.05, camera.zoom * 0.5);
    const world = isoUnproject(-drag.dx / dz, -drag.dy / dz);
    panX += world.x;
    panY += world.y;
    panHold = 4;
  }

  /** A tap on the field selects the position under it. */
  function handleTap(): void {
    const tap = input.takeTap();
    if (!tap) return;
    if (tap.y > surface.height - 210 || tap.y < 96) return;
    const world = screenToWorld(camera, tap.x, tap.y);
    let best: BaseState | null = null;
    let bestDistance = TAP_RADIUS;
    for (const base of simulation.bases) {
      const d = Math.hypot(base.x - world.x, base.y - world.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = base;
      }
    }
    if (!best) {
      hud.say('tap a position to select it · drag to pan the field');
      return;
    }
    if (best.side === 'player') {
      selection = { ...selection, fromBaseId: best.id };
      hud.say(`launch pad: ${best.name}`);
    } else {
      selection = { ...selection, targetBaseId: best.id };
      hud.say(`objective: ${best.name}`);
    }
    play('uiClick');
  }

  // --- loop -----------------------------------------------------------------
  let raf = 0;
  let accumulator = 0;
  let lastFrame = 0;
  let fps = 60;

  function updateCamera(dt: number): void {
    const state = simulation.state;
    followX += (state.focusX - followX) * Math.min(1, dt * 1.4);
    followY += (state.focusY - followY) * Math.min(1, dt * 1.4);

    if (panHold > 0) panHold = Math.max(0, panHold - dt);
    else if (!dragging) {
      panX += (0 - panX) * Math.min(1, dt * 0.5);
      panY += (0 - panY) * Math.min(1, dt * 0.5);
    }

    camera = cameraAt(surface.width, surface.height, followX + panX, followY + panY, zoomFactor);
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
    handleTap();

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

    syncSelection();
    if (withdrawArmedAt !== 0 && performance.now() - withdrawArmedAt > WITHDRAW_CONFIRM_MS) {
      withdrawArmedAt = 0;
      hud.setWithdrawArmed(false);
    }
    const state = simulation.state;
    handleEvents(simulation.takeEvents());

    updateCamera(elapsed);
    renderer.draw(surface.ctx, state, camera, surface.pixelRatio, {
      selectedBaseId: selection.fromBaseId,
      targetBaseId: selection.targetBaseId,
      scatter,
      paused,
    });
    hud.update(state, Math.round(fps), selection);

    if (!finished && state.status !== 'running') {
      finished = true;
      outcome = settle(state.status === 'victory' ? 'victory' : 'defeat', state.lossReason ?? 'time-expired');
      handlers.onFinish(outcome);
    }
  }

  /**
   * Withdrawing is the only way out of a live battle, and it resolves the
   * sector rather than abandoning it: `settle` records the loss and the shell
   * shows the same splash a fought-out defeat gets. Two presses, so it cannot
   * happen by accident.
   */
  function requestWithdraw(): void {
    if (disposed || finished) return;
    const now = performance.now();
    if (now - withdrawArmedAt > WITHDRAW_CONFIRM_MS) {
      withdrawArmedAt = now;
      hud.setWithdrawArmed(true);
      hud.say('press again to withdraw — the sector ends as a defeat');
      play('uiClick');
      return;
    }
    withdraw();
  }

  function withdraw(): void {
    withdrawArmedAt = 0;
    hud.setWithdrawArmed(false);
    finished = true;
    hud.say('withdrawn');
    outcome = settle('defeat', 'withdrawn');
    handlers.onFinish(outcome);
  }

  function reportFor(base: BaseState): BaseReport {
    return {
      letter: base.letter,
      name: base.name,
      kind: base.kind,
      destroyed: base.destroyed,
      hp: Math.max(0, Math.round(base.hp)),
      maxHp: base.maxHp,
      x: base.x,
      y: base.y,
    };
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

    const enemyReport = state.bases.filter((base) => base.side === 'enemy').map(reportFor);
    const playerReport = state.bases.filter((base) => base.side === 'player').map(reportFor);
    let playerHp = 0;
    let playerMax = 0;
    let enemyHp = 0;
    let enemyMax = 0;
    for (const report of playerReport) {
      playerHp += report.hp;
      playerMax += report.maxHp;
    }
    for (const report of enemyReport) {
      enemyHp += report.hp;
      enemyMax += report.maxHp;
    }

    const unlocked = storage.snapshot();
    return {
      nodeId: stage.id,
      nodeName: stage.name,
      year: stage.year,
      situation: stageTagline(stage),
      status,
      lossReason,
      durationSeconds: state.time,
      bondsAwarded,
      bondsCollected: stats.bondsCollected,
      unitsDeployed: stats.deployed,
      unitsLost: stats.losses,
      enemyDestroyed: stats.kills,
      logisticsBought: stats.logisticsBought,
      minesHit: stats.minesHit,
      enemyMinesHit: stats.enemyMinesHit,
      enemyBases: enemyReport.length,
      enemyBasesDestroyed: enemyReport.filter((report) => report.destroyed).length,
      playerBases: playerReport.length,
      playerBasesLost: playerReport.filter((report) => report.destroyed).length,
      playerHpRemaining: playerHp,
      playerHpMax: playerMax,
      enemyHpRemaining: enemyHp,
      enemyHpMax: enemyMax,
      enemyReport,
      playerReport,
      unlockedStage: unlocked.unlockedStages[unlocked.unlockedStages.length - 1] ?? null,
    };
  }

  surface.onDraw = () => {
    if (disposed) return;
    camera = cameraAt(surface.width, surface.height, followX + panX, followY + panY, zoomFactor);
    renderer.draw(surface.ctx, simulation.state, camera, surface.pixelRatio, {
      selectedBaseId: selection.fromBaseId,
      targetBaseId: selection.targetBaseId,
      scatter,
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
    say(message: string): void {
      hud.say(message);
    },
    handleResize(): void {
      // The surface re-measures itself on resize; all we own is the camera.
      camera = cameraAt(surface.width, surface.height, followX + panX, followY + panY, zoomFactor);
      surface.onDraw?.(surface);
    },
  };
}

/** Re-exported so the shell has one import for the whole battle result shape. */
export type { BattleOutcome, BaseReport } from '../core/outcome';
