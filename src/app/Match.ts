/**
 * MatchSession — the battle's composition root.
 *
 * Owns the fixed-timestep loop, the camera, the deployment-bar input, the
 * renderer and the audio policy, and is the only place where the pure
 * simulation meets the browser.
 *
 * Camera behaviour is the mobile centrepiece: the view is zoomed in on the
 * ground line and follows the fighting automatically, but a horizontal drag
 * pans it — held for a moment so you can study a flank, then eased back to the
 * action so you never lose the battle by looking away.
 */

import {
  createBattleInput,
  type BattleInput,
} from '../engine/Input';
import type { GameStorage, SoundManager, SoundName } from '../engine';
import { nextStageId, type StageDefinition } from '../core/progression';
import { CAMERA_ZOOM, GROUND_Y, VIEW_HEIGHT, VIEW_WIDTH } from '../game/constants';
import {
  computeHudLayout,
  hitControl,
  hitDeploy,
  hitLogistics,
  kindForHotkey,
  type HudLayout,
} from '../game/hud';
import { createMatchConfig } from '../game/match';
import { TugSimulation } from '../game/TugSimulation';
import type { MatchCommand, MatchStatus, SimEvent } from '../game/tugTypes';
import type { UnitKind } from '../game/units';
import type { CanvasSurface } from '../platform/Display';
import {
  cameraAt,
  createCamera,
  type Camera,
} from '../platform/Viewport';
import { BattleRenderer } from '../render/BattleRenderer';

/** How long a manual pan is held before the camera eases back to the action. */
const PAN_HOLD_SECONDS = 4;
/** World pixels/second the camera eases at. */
const FOLLOW_RATE = 2.2;

export interface BattleOutcome {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly year: string;
  readonly situation: string;
  readonly status: Exclude<MatchStatus, 'running'>;
  readonly lossReason: string;
  /** Bonds banked for taking the sector (0 on a defeat). */
  readonly bondsAwarded: number;
  /** Bonds picked up from enemy losses, banked win or lose. */
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
  /** The node this victory opened, if any. */
  readonly unlockedStage: string | null;
}

export interface MatchSessionOptions {
  readonly surface: CanvasSurface;
  readonly storage: GameStorage;
  readonly sound: SoundManager;
  readonly faction: 'allied' | 'axis';
  readonly stage: StageDefinition;
  readonly situation: string;
  /** Leave the battle without a result (back to the map). */
  readonly onExit: () => void;
  /** Called exactly once, when the battle is decided. */
  readonly onFinish: (outcome: BattleOutcome) => void;
  /** Called when the pause state changes, so the shell can react. */
  readonly onPauseChange?: (paused: boolean) => void;
}

export interface MatchSession {
  readonly state: TugSimulation['state'];
  readonly camera: Camera;
  readonly layout: HudLayout;
  readonly fps: number;
  readonly paused: boolean;
  setPaused(paused: boolean): void;
  dispose(): void;
}

export function createMatchSession(options: MatchSessionOptions): MatchSession {
  const { surface, storage, sound, faction, stage } = options;
  const config = createMatchConfig(stage, storage.snapshot());
  const simulation = new TugSimulation(config);
  const renderer = new BattleRenderer();

  const touch = prefersTouch();
  let layout = computeHudLayout(surface.width, surface.height, touch);
  let camera = createCamera(
    surface.width,
    surface.height,
    VIEW_WIDTH,
    VIEW_HEIGHT,
    CAMERA_ZOOM,
    GROUND_Y,
  );
  let followX = simulation.state.focusX;
  let panX = 0;
  let panHold = 0;
  let paused = false;
  let disposed = false;
  let awarded = false;
  let frame = 0;
  let last = performance.now();
  let accumulator = 0;
  let fpsValue = 60;
  const lastPlayed = new Map<SoundName, number>();

  const input: BattleInput = createBattleInput({
    element: surface.canvas,
    onFirstGesture: () => {
      void unlockAudio();
    },
  });

  async function unlockAudio(): Promise<void> {
    if (sound.state === 'running') return;
    try {
      await sound.unlock();
    } catch {
      /* audio is optional; the game never blocks on it */
    }
  }

  function play(name: SoundName, minGapMs: number, volume: number): void {
    const now = performance.now();
    const previous = lastPlayed.get(name) ?? -Infinity;
    if (now - previous < minGapMs) return;
    lastPlayed.set(name, now);
    sound.play(name, { volume });
  }

  function shotSoundFor(kind: SimEvent['kind']): SoundName {
    switch (kind) {
      case 'rifleman':
        return 'rifleShot';
      case 'smg':
        return 'smgShot';
      case 'tank':
        return 'shellFire';
      default:
        return 'mgShot';
    }
  }

  /** Sim events → soundboard. Each weapon keeps its own signature. */
  function handleEvents(events: readonly SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'deploy':
          play('deploy', 0, 0.5);
          break;
        case 'enemyDeploy':
          play('uiBack', 400, 0.16);
          break;
        case 'shot':
          play(shotSoundFor(event.kind), 0, 0.3);
          break;
        case 'shell':
          play('shellFire', 0, 0.55);
          break;
        case 'impact':
          play(event.metal ? 'ricochet' : 'impact', 0, event.metal ? 0.3 : 0.2);
          break;
        case 'explosion':
          play('explosion', 0, 0.6);
          break;
        case 'mineBlast':
          play('mineBlast', 0, 0.7);
          break;
        case 'unitDown':
          play('impact', 60, 0.4);
          break;
        case 'playerUnitDown':
          play('uiBack', 320, 0.26);
          break;
        case 'trenchOverrun':
          play('uiBack', 200, 0.3);
          break;
        case 'baseHit':
          play('impact', 120, 0.36);
          break;
        case 'baseDestroyed':
          play('explosion', 0, 0.85);
          break;
        case 'logisticsUpgrade':
          play('upgrade', 0, 0.6);
          break;
        case 'victory':
          play('explosion', 0, 0.75);
          break;
        case 'defeat':
          play('uiBack', 0, 0.5);
          break;
      }
    }
  }

  /** Taps are HUD presses; the canvas is the only surface, so all of it lands. */
  function handleTap(x: number, y: number): void {
    const control = hitControl(layout, x, y);
    if (control === 'pause') {
      setPaused(!paused);
      return;
    }
    if (control === 'exit') {
      play('uiBack', 0, 0.4);
      options.onExit();
      return;
    }
    if (control === 'recenter') {
      panX = 0;
      panHold = 0;
      play('uiClick', 0, 0.4);
      return;
    }
    const kind = hitDeploy(layout, x, y);
    if (kind) {
      queuedDeploy = kind;
      return;
    }
    if (hitLogistics(layout, x, y)) {
      if (simulation.state.bonds >= simulation.state.logisticsCost) {
        buyLogistics = true;
      } else {
        play('uiBack', 0, 0.3);
      }
    }
  }

  function setPaused(next: boolean): void {
    if (next === paused) return;
    paused = next;
    options.onPauseChange?.(paused);
  }

  // Player intent for the next simulation step.
  let queuedDeploy: UnitKind | null = null;
  let buyLogistics = false;

  function handleKeys(): void {
    for (const key of input.takeKeys()) {
      const lower = key.toLowerCase();
      if (lower === 'escape') {
        options.onExit();
        return;
      }
      if (lower === 'p') {
        setPaused(!paused);
        continue;
      }
      if (lower === 'u') {
        if (simulation.state.bonds >= simulation.state.logisticsCost) {
          buyLogistics = true;
        }
        continue;
      }
      if (lower === 'c') {
        panX = 0;
        panHold = 0;
        continue;
      }
      const kind = kindForHotkey(lower);
      if (kind) queuedDeploy = kind;
    }
  }

  function handleDrag(): void {
    const drag = input.takeDrag();
    if (!drag) return;
    if (Math.abs(drag.dx) < 0.5 && Math.abs(drag.dy) < 0.5) return;
    // A drag that happens over the dock is a deploy attempt, not a pan.
    const pointer = input.pointer;
    if (pointer === null) return;
    if (pointer.y > layout.cssHeight - layout.dockHeight) return;
    panX -= drag.dx / camera.zoom;
    panHold = PAN_HOLD_SECONDS;
  }

  function step(dt: number): void {
    handleKeys();
    for (let tap = input.takeTap(); tap; tap = input.takeTap()) handleTap(tap.x, tap.y);
    handleDrag();

    if (paused) {
      // Particles and shake still settle, but the war stops.
      simulation.update(0, { deploy: null, buyLogistics: false });
      queuedDeploy = null;
      buyLogistics = false;
      return;
    }

    const command: MatchCommand = { deploy: queuedDeploy, buyLogistics };
    queuedDeploy = null;
    buyLogistics = false;
    simulation.update(dt, command);
    handleEvents(simulation.takeEvents());
    settle();
  }

  function settle(): void {
    const state = simulation.state;
    if (state.status === 'running' || awarded) return;
    awarded = true;
    const bondsCollected = state.bonds;
    if (bondsCollected > 0) storage.addWarBonds(bondsCollected);
    const report = { casualties: state.stats.losses, kills: state.stats.kills };
    if (state.status === 'victory') {
      storage.completeStage(stage.id, stage.rewardBonds, report);
    } else {
      storage.recordLoss(stage.id, report);
    }
    options.onFinish({
      nodeId: stage.id,
      nodeName: stage.name,
      year: stage.year,
      situation: options.situation,
      status: state.status,
      lossReason: state.lossReason ?? '',
      bondsAwarded: state.status === 'victory' ? stage.rewardBonds : 0,
      bondsCollected,
      unitsDeployed: state.stats.deployed,
      unitsLost: state.stats.losses,
      enemyDestroyed: state.stats.kills,
      minesHit: state.stats.minesHit,
      enemyMinesHit: state.stats.enemyMinesHit,
      logisticsBought: state.logisticsLevel,
      playerBaseRemaining: Math.max(0, Math.round(state.playerBase.hp)),
      playerBaseMax: state.playerBase.maxHp,
      enemyBaseRemaining: Math.max(0, Math.round(state.enemyBase.hp)),
      enemyBaseMax: state.enemyBase.maxHp,
      durationSeconds: state.time,
      unlockedStage: state.status === 'victory' ? (nextStageId(stage.id) ?? null) : null,
    });
  }

  /** Camera: follow the fighting, respect a manual pan, ease back after a beat. */
  function updateCamera(dt: number): void {
    const state = simulation.state;
    const wanted = state.focusX;
    followX += (wanted - followX) * Math.min(1, dt * FOLLOW_RATE);
    if (!paused && panHold > 0) panHold = Math.max(0, panHold - dt);
    if (panHold === 0 && panX !== 0) {
      panX *= Math.max(0, 1 - dt * 1.4);
      if (Math.abs(panX) < 0.5) panX = 0;
    }
    camera = cameraAt(camera, VIEW_WIDTH, VIEW_HEIGHT, followX + panX, GROUND_Y);
  }

  function resize(): void {
    layout = computeHudLayout(surface.width, surface.height, touch);
    camera = createCamera(
      surface.width,
      surface.height,
      VIEW_WIDTH,
      VIEW_HEIGHT,
      CAMERA_ZOOM,
      GROUND_Y,
    );
    camera = cameraAt(camera, VIEW_WIDTH, VIEW_HEIGHT, followX + panX, GROUND_Y);
  }

  function render(): void {
    const state = simulation.state;
    renderer.draw(surface.ctx, state, camera, layout, {
      nodeName: stage.name,
      year: stage.year,
      strongpoint: state.enemyBase.side === 'enemy' ? stage.bossName : stage.bossName,
      faction,
      tier: stage.tier,
      fps: fpsValue,
      paused,
      touch,
      following: panX === 0,
    });
  }

  function loop(now: number): void {
    if (disposed) return;
    const elapsed = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    fpsValue = fpsValue * 0.9 + (elapsed > 0 ? 1 / elapsed : 60) * 0.1;

    accumulator += elapsed;
    const stepSeconds = 1 / 60;
    let steps = 0;
    while (accumulator >= stepSeconds && steps < 5) {
      step(stepSeconds);
      accumulator -= stepSeconds;
      steps += 1;
    }
    updateCamera(elapsed);
    render();
    frame = requestAnimationFrame(loop);
  }

  surface.onDraw = () => {
    resize();
    render();
  };
  frame = requestAnimationFrame((now) => {
    last = now;
    loop(now);
  });

  return {
    get state() {
      return simulation.state;
    },
    get camera() {
      return camera;
    },
    get layout() {
      return layout;
    },
    get fps() {
      return fpsValue;
    },
    get paused() {
      return paused;
    },
    setPaused,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      input.dispose();
      surface.onDraw = null;
    },
  };
}

/** Touch-first device? Keyboard hints are pointless there. */
export function prefersTouch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const noHover = window.matchMedia('(hover: none)').matches;
  const touchPoints = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarse || noHover || touchPoints;
}

export type { Camera, HudLayout };
