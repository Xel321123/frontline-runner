/**
 * Shell — screens, navigation and the run lifecycle.
 *
 * One state machine over three screens (title, campaign map, play) plus modal
 * layers (briefing, camp, result). All navigation is a single delegated click
 * listener reading `data-action` attributes, so adding a button never adds a
 * listener and nothing can leak between screens.
 *
 * Nothing here talks to the network: the save file is the only state, and the
 * play scene reads its data straight out of it.
 */

import { getStage, type StageDefinition } from '../core/progression';
import { THEATERS } from '../data/campaignData';
import { isFaction, isUpgradeId } from '../core/types';
import type { Faction } from '../core/types';
import type { AssetLoadReport, GameStorage, SoundName } from '../engine';
import { createAssetLoader, createGameStorage, SoundManager } from '../engine';
import { createLoadout } from '../game/loadout';
import type { CanvasSurface, OrientationLockResult } from '../platform/Display';
import {
  createCanvasSurface,
  isLandscape,
  requestFullscreen,
  tryLockLandscape,
} from '../platform/Display';
import { PlaySession, type RunOutcome } from './Play';
import { mustFind, setHtml, show } from './dom';
import {
  briefingHtml,
  campHtml,
  diagnosticsHtml,
  mapScreenHtml,
  nextObjective,
  resultHtml,
  titleScreenHtml,
  type CampView,
  type DiagnosticsView,
} from './screens';

type ModalKind = 'briefing' | 'camp' | 'result' | null;

interface ModalState {
  readonly kind: ModalKind;
  readonly stageId?: string;
}

const SHELL_HTML = `
<div class="app">
  <header class="bar">
    <div class="brand">
      <h1>Frontline Runner</h1>
      <p class="sub" id="bar-sub">loading</p>
    </div>
    <div class="bar-actions">
      <span class="bond-badge" title="War bonds are earned by clearing sectors">
        ★ <b id="bond-count">0</b>
      </span>
      <button type="button" class="chip" id="btn-sound" data-action="toggle-sound">sound</button>
      <button type="button" class="chip" id="btn-camp" data-action="open-camp">camp</button>
      <button type="button" class="chip" id="btn-exit" data-action="exit-run" hidden>abort run</button>
    </div>
  </header>
  <main>
    <div id="screen"></div>
    <div id="diagnostics" hidden></div>
    <div id="play" hidden>
      <div class="stage-wrap" id="stage"></div>
      <p class="play-hint">drag / <span class="mono">W S ↑ ↓</span> to steer ·
        <span class="mono">R</span> redeploy · <span class="mono">ESC</span> back to base</p>
    </div>
    <div id="modal-layer" hidden><div class="modal" id="modal"></div></div>
  </main>
  <footer class="hint" id="hint"></footer>
</div>`;

export async function startShell(root: HTMLElement): Promise<void> {
  const storage: GameStorage = createGameStorage({
    onError: (error, context) => console.warn(`[storage] ${context}`, error),
  });
  const sound: SoundManager = new SoundManager({
    muted: storage.snapshot().settings.muted,
  });
  const loader = createAssetLoader({ baseUrl: import.meta.env.BASE_URL });

  setHtml(root, SHELL_HTML);
  const screenEl = mustFind<HTMLElement>(root, '#screen');
  const diagnosticsEl = mustFind<HTMLElement>(root, '#diagnostics');
  const playEl = mustFind<HTMLElement>(root, '#play');
  const stageEl = mustFind<HTMLElement>(root, '#stage');
  const modalLayerEl = mustFind<HTMLElement>(root, '#modal-layer');
  const modalEl = mustFind<HTMLElement>(root, '#modal');
  const hintEl = mustFind<HTMLElement>(root, '#hint');
  const bondEl = mustFind<HTMLElement>(root, '#bond-count');
  const soundEl = mustFind<HTMLButtonElement>(root, '#btn-sound');
  const barSubEl = mustFind<HTMLElement>(root, '#bar-sub');
  const exitEl = mustFind<HTMLElement>(root, '#btn-exit');

  let modal: ModalState = { kind: null };
  let session: PlaySession | null = null;
  let surface: CanvasSurface | null = null;
  let lastOutcome: RunOutcome | null = null;
  let showingTitle = false;
  let diagnosticsOpen = false;
  let orientationLock: OrientationLockResult | 'idle' = 'idle';
  let report: AssetLoadReport | null = null;
  let hint = '';
  let saveNote = '';
  /** Console handle for diagnostics and verification. */
  const debugApi: Record<string, unknown> = { storage, sound, loader };

  // ------------------------------------------------------------------ render

  function campView(): CampView {
    const save = storage.snapshot();
    const faction: Faction = save.faction ?? 'allied';
    const stageIndex = nextObjective(faction, save)?.index ?? 1;
    const loadout = createLoadout(faction, stageIndex, save.upgrades);
    const weapon = loadout.weapon;
    return {
      faction,
      stageIndex,
      weaponName: weapon.name,
      weaponDetail: `${weapon.caliber} · ${weapon.year} · ${weapon.damage} dmg · ${weapon.fireRate}/s · ±${weapon.spread}° · ${weapon.magazineSize} rounds · ${weapon.automatic ? 'automatic' : 'single shot'}`,
      squadSize: loadout.startingTroops,
      damagePerTroop: loadout.damagePerTroop,
      roundsPerSecond: 1 / loadout.fireInterval,
      revives: loadout.revives,
    };
  }

  function diagnosticsView(): DiagnosticsView {
    const failures = report ? report.failures.map((failure) => `${failure.label}: ${failure.reason}`) : [];
    return {
      backendId: storage.backendId,
      persistent: storage.persistent,
      assetSummary: report
        ? `${report.loaded}/${report.total} loaded in ${Math.round(report.durationMs)} ms · ${report.procedural} procedural`
        : 'loading',
      assetFailures: failures,
      theatreCount: THEATERS.length,
      note: saveNote,
    };
  }

  function renderBase(): void {
    const save = storage.snapshot();
    const onTitle = showingTitle || !save.faction;
    setHtml(screenEl, onTitle ? titleScreenHtml(save) : mapScreenHtml(save));
  }

  function renderModal(): void {
    const save = storage.snapshot();
    if (!modal.kind) {
      show(modalLayerEl, false);
      return;
    }

    if (modal.kind === 'briefing') {
      const stage = modal.stageId ? getStage(modal.stageId) : undefined;
      if (!stage) {
        modal = { kind: null };
        show(modalLayerEl, false);
        return;
      }
      setHtml(modalEl, briefingHtml(stage, save));
    } else if (modal.kind === 'camp') {
      setHtml(modalEl, campHtml(save, campView()));
    } else if (modal.kind === 'result' && lastOutcome) {
      const unlocked = lastOutcome.unlockedStage ? getStage(lastOutcome.unlockedStage) : undefined;
      setHtml(modalEl, resultHtml(lastOutcome, save, unlocked));
    }
    show(modalLayerEl, true);
  }

  function renderBar(): void {
    const save = storage.snapshot();
    bondEl.textContent = String(save.warBonds);
    soundEl.textContent = save.settings.muted ? 'sound off' : 'sound on';
    soundEl.setAttribute('aria-pressed', String(!save.settings.muted));
    show(exitEl, session !== null);

    if (session) {
      barSubEl.textContent = 'in the field';
    } else if (!save.faction) {
      barSubEl.textContent = 'select a faction to begin';
    } else {
      const stage = nextObjective(save.faction, save);
      const side = save.faction === 'allied' ? 'Allied' : 'Axis';
      barSubEl.textContent = stage
        ? `${side} campaign · next ${stage.name} (${stage.year})`
        : `${side} campaign · complete`;
    }
  }

  function render(): void {
    const playing = session !== null;
    document.body.classList.toggle('playing', playing);
    show(playEl, playing);
    show(screenEl, !playing);
    show(diagnosticsEl, !playing && diagnosticsOpen);
    if (!playing) {
      renderBase();
      if (diagnosticsOpen) setHtml(diagnosticsEl, diagnosticsHtml(diagnosticsView()));
    }
    renderModal();
    renderBar();
    hintEl.textContent = hint;
  }

  function say(message: string): void {
    hint = message;
    hintEl.textContent = message;
  }

  // -------------------------------------------------------------------- play

  function startRun(stage: StageDefinition | undefined): void {
    const save = storage.snapshot();
    if (!stage || !save.faction || session) return;
    if (!save.unlockedStages.includes(stage.id)) {
      say('that sector is still locked');
      return;
    }

    void unlockAudio();
    modal = { kind: null };
    lastOutcome = null;
    surface = createCanvasSurface(stageEl);
    session = new PlaySession({
      surface,
      loader,
      storage,
      sound,
      faction: save.faction,
      node: stage,
      stage,
      onExit: () => exitRun(),
      onFinish: (outcome) => {
        lastOutcome = outcome;
        modal = { kind: 'result' };
        saveNote = `last run: ${outcome.status} at ${outcome.nodeName}`;
        render();
      },
    });
    session.start();
    debugApi.session = session;
    hint = '';
    render();
    say('drag or WASD to steer · R redeploy · ESC back to base');
  }

  function exitRun(): void {
    session?.dispose();
    session = null;
    debugApi.session = null;
    surface?.dispose();
    surface = null;
    if (lastOutcome) {
      modal = { kind: 'result' };
    }
    render();
  }

  function closeRun(): void {
    session?.dispose();
    session = null;
    debugApi.session = null;
    surface?.dispose();
    surface = null;
    modal = { kind: null };
    render();
  }

  // ------------------------------------------------------------------ events

  async function unlockAudio(): Promise<void> {
    // `state` reports 'suspended' both before the graph exists and while the
    // browser is holding it back for autoplay reasons, so retry unless it is
    // actually running — otherwise a context created by a non-gesture event
    // would stay silent for the whole session.
    if (sound.state === 'running') return;
    try {
      await sound.unlock();
    } catch (error) {
      console.warn('[audio] unlock failed', error);
    }
  }

  function pickFaction(value: string | undefined): void {
    if (!isFaction(value)) return;
    storage.setFaction(value);
    showingTitle = false;
    modal = { kind: null };
    say(`${value === 'allied' ? 'Allied' : 'Axis'} campaign opened — pick a node or deploy`);
  }

  function buyUpgrade(id: string | undefined): void {
    if (!id || !isUpgradeId(id)) return;
    const result = storage.purchaseUpgrade(id);
    if (result.ok) {
      sound.play('uiClick');
      say(`${id} upgraded to level ${result.level} for ${result.cost} bonds`);
    } else {
      sound.play('uiBack');
      say(`upgrade blocked: ${result.reason}`);
    }
  }

  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target || target.hasAttribute('disabled')) return;
    const action = target.dataset.action;
    void unlockAudio();

    switch (action) {
      case 'pick-faction':
        pickFaction(target.dataset.faction);
        break;
      case 'open-title':
        showingTitle = true;
        modal = { kind: null };
        break;
      case 'open-map':
        showingTitle = false;
        modal = { kind: null };
        break;
      case 'open-briefing':
        modal = { kind: 'briefing', stageId: target.dataset.stage };
        break;
      case 'open-camp':
        modal = { kind: 'camp' };
        break;
      case 'close-modal':
        // Leaving the result panel ends the run behind it.
        if (session) {
          closeRun();
          return;
        }
        modal = { kind: null };
        break;
      case 'deploy-next':
        startRun(nextObjective(storage.snapshot().faction ?? 'allied', storage.snapshot()));
        return;
      case 'deploy-stage':
        startRun(getStage(target.dataset.stage ?? ''));
        return;
      case 'exit-run':
        closeRun();
        return;
      case 'toggle-sound': {
        const muted = sound.toggleMute();
        storage.setMuted(muted);
        say(muted ? 'audio muted' : 'audio on');
        break;
      }
      case 'toggle-diagnostics':
        diagnosticsOpen = !diagnosticsOpen;
        break;
      case 'buy-upgrade':
        buyUpgrade(target.dataset.upgrade);
        break;
      case 'play-sound': {
        const name = target.dataset.sound;
        if (name) sound.play(name as SoundName);
        break;
      }
      case 'request-landscape':
        void requestLandscape();
        break;
      case 'reset-save':
        storage.reset();
        showingTitle = true;
        modal = { kind: null };
        say('save wiped — fresh campaign');
        break;
      case 'export-save':
        void copySave();
        break;
      default:
        return;
    }
    render();
  });

  async function copySave(): Promise<void> {
    const json = storage.exportJson();
    try {
      await navigator.clipboard.writeText(json);
      saveNote = `save copied to clipboard (${json.length} bytes)`;
    } catch {
      saveNote = 'clipboard unavailable — see the console';
      console.info('[save]', json);
    }
    render();
  }

  async function requestLandscape(): Promise<void> {
    if (!isLandscape()) await requestFullscreen(stageEl.closest('.stage-wrap') ?? stageEl);
    orientationLock = await tryLockLandscape();
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.kind) {
      event.preventDefault();
      if (session) closeRun();
      else {
        modal = { kind: null };
        render();
      }
      return;
    }
    if (session) return;
    if (event.key === 'Enter') {
      const stage = nextObjective(storage.snapshot().faction ?? 'allied', storage.snapshot());
      if (storage.snapshot().faction) {
        event.preventDefault();
        startRun(stage);
      }
    }
  });

  storage.subscribe(() => render());
  // The browser only lets audio start from a gesture: unlock on the first
  // pointer interaction anywhere, then this becomes a no-op.
  window.addEventListener('pointerdown', () => {
    void unlockAudio();
  });
  window.addEventListener('resize', () => {
    if (orientationLock !== 'idle') void tryLockLandscape();
  });

  // -------------------------------------------------------------------- boot

  render();
  report = await loader.load();
  const failures = report.failures.length;
  say(
    failures === 0
      ? `${report.loaded}/${report.total} sprites ready · offline`
      : `${report.loaded}/${report.total} sprites · ${failures} procedural fallback`,
  );
  (globalThis as unknown as { frontline?: unknown }).frontline = debugApi;
  render();
}
