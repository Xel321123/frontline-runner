/**
 * Shell — screens, navigation and the battle lifecycle.
 *
 * One state machine over three screens (title, campaign map, battle) plus modal
 * layers (briefing, camp, result). All navigation is a single delegated click
 * listener reading `data-action` attributes, so adding a button never adds a
 * listener and nothing can leak between screens.
 *
 * Nothing here talks to the network: the save file is the only state, and the
 * battle reads its configuration straight out of it.
 */

import { bestWeaponFor } from '../data/campaignData';
import { getStage, stagesForFaction, type StageDefinition } from '../core/progression';
import { THEATERS } from '../data/campaignData';
import { isFaction, isUpgradeId } from '../core/types';
import type { Faction } from '../core/types';
import type { GameStorage, SoundName } from '../engine';
import { createGameStorage, SoundManager } from '../engine';
import { createMatchConfig, effectiveSupplyRate } from '../game/match';
import { stageTagline } from '../game/stageInfo';
import { UNIT_ORDER } from '../game/units';
import type { CanvasSurface, OrientationLockResult } from '../platform/Display';
import {
  createCanvasSurface,
  enterFullscreen,
  exitFullscreen,
  isLandscape,
  tryLockLandscape,
} from '../platform/Display';
import { createMatchSession, prefersTouch, type BattleOutcome, type MatchSession } from './Match';
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
      <span class="bond-badge" title="War bonds are earned by clearing sectors and by destroying enemy units">
        ★ <b id="bond-count">0</b>
      </span>
      <button type="button" class="chip" id="btn-sound" data-action="toggle-sound">sound</button>
      <button type="button" class="chip" id="btn-camp" data-action="open-camp">camp</button>
      <button type="button" class="chip" id="btn-exit" data-action="exit-run" hidden>abort battle</button>
    </div>
  </header>
  <main>
    <div id="screen"></div>
    <div id="diagnostics" hidden></div>
    <div id="play" hidden>
      <div class="stage-wrap" id="stage"></div>
      <p class="play-hint"><span class="mono">1-4</span> deploy ·
        <span class="mono">U</span> boost logistics · <span class="mono">P</span> pause ·
        <span class="mono">ESC</span> back to base — or click the deployment bar</p>
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
  let session: MatchSession | null = null;
  let surface: CanvasSurface | null = null;
  let lastOutcome: BattleOutcome | null = null;
  let showingTitle = false;
  let diagnosticsOpen = false;
  let orientationLock: OrientationLockResult | 'idle' = 'idle';
  let hint = '';
  let saveNote = '';
  /** Console handle for diagnostics and verification. */
  const debugApi: Record<string, unknown> = { storage, sound };

  // ------------------------------------------------------------------ render

  function objectiveFor(save = storage.snapshot()): StageDefinition | undefined {
    const faction: Faction = save.faction ?? 'allied';
    return nextObjective(faction, save);
  }

  function campView(): CampView {
    const save = storage.snapshot();
    const faction: Faction = save.faction ?? 'allied';
    const objective = objectiveFor(save) ?? stagesForFaction(faction)[0];
    if (!objective) {
      throw new Error('campaign data is empty');
    }
    const config = createMatchConfig(objective, save);
    const weapon = bestWeaponFor(faction, objective.index);
    return {
      faction,
      stageIndex: objective.index,
      objective: `${objective.name} (${objective.year})`,
      objectiveTagline: stageTagline(objective),
      tier: objective.tier,
      standardRifle: weapon.name,
      standardRifleDetail: `${weapon.caliber} · ${weapon.year} · ${weapon.damage} dmg · ${weapon.fireRate}/s · ±${weapon.spread}° · ${weapon.magazineSize} rounds`,
      startSupplies: config.startSupplies,
      supplyRate: effectiveSupplyRate(objective),
      baseHp: config.playerBaseHp,
      damageMultiplier: config.damageMultiplier,
      unitHpMultiplier: config.unitHpMultiplier,
    };
  }

  function diagnosticsView(): DiagnosticsView {
    return {
      backendId: storage.backendId,
      persistent: storage.persistent,
      theatreCount: THEATERS.length,
      unitKinds: UNIT_ORDER.length,
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
      const stage = objectiveFor(save);
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

  // ------------------------------------------------------------------ battle

  /**
   * Battle presentation: full-bleed canvas with the HUD drawn on it. The shell
   * only toggles a class so CSS can hide the menu chrome — no DOM panel is left
   * eating vertical space while a battle is running.
   */
  function setBattleChrome(active: boolean): void {
    root.classList.toggle('battle-active', active);
  }

  function startBattle(stage: StageDefinition | undefined): void {
    const save = storage.snapshot();
    if (!stage || !save.faction || session) return;
    if (!save.unlockedStages.includes(stage.id)) {
      say('that sector is still locked');
      return;
    }

    // Fullscreen has to be requested from inside the tap that started this, so
    // it happens here rather than after the canvas is built.
    void enterFullscreen();
    void unlockAudio();
    setBattleChrome(true);
    modal = { kind: null };
    lastOutcome = null;
    surface = createCanvasSurface(stageEl);
    session = createMatchSession({
      surface,
      storage,
      sound,
      faction: save.faction,
      stage,
      situation: stageTagline(stage),
      onExit: () => exitBattle(),
      onFinish: (outcome: BattleOutcome) => {
        lastOutcome = outcome;
        modal = { kind: 'result' };
        saveNote = `last battle: ${outcome.status} at ${outcome.nodeName}`;
        render();
      },
    });
    debugApi.session = session;
    hint = '';
    render();
    say(
      prefersTouch()
        ? 'tap a card to deploy · drag the field to pan'
        : '1-4 or the deployment bar to field units · U boosts logistics · P pauses',
    );
  }

  function teardownSession(): void {
    setBattleChrome(false);
    exitFullscreen();
    session?.dispose();
    session = null;
    debugApi.session = null;
    surface?.dispose();
    surface = null;
  }

  function exitBattle(): void {
    teardownSession();
    if (lastOutcome) modal = { kind: 'result' };
    render();
  }

  function closeBattle(): void {
    teardownSession();
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
        // Leaving the result panel ends the battle behind it.
        if (session) {
          closeBattle();
          return;
        }
        modal = { kind: null };
        break;
      case 'deploy-next':
        startBattle(objectiveFor());
        return;
      case 'deploy-stage':
        startBattle(getStage(target.dataset.stage ?? ''));
        return;
      case 'exit-run':
        closeBattle();
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
    if (!isLandscape()) await enterFullscreen();
    orientationLock = await tryLockLandscape();
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.kind) {
      event.preventDefault();
      if (session) closeBattle();
      else {
        modal = { kind: null };
        render();
      }
      return;
    }
    if (session) return;
    if (event.key === 'Enter' && storage.snapshot().faction) {
      event.preventDefault();
      startBattle(objectiveFor());
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
  say('battlefield ready — everything is drawn from paths, nothing is downloaded');
  debugApi.campView = campView;
  (globalThis as unknown as { frontline?: unknown }).frontline = debugApi;
  render();
}
