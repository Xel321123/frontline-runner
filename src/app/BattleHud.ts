/**
 * BattleHud — the battle HUD as real DOM over a fixed, full-viewport canvas.
 *
 * Data lives in the DOM (crisp text, accessible buttons, native touch targets);
 * the canvas draws only the world. Icons are painted once into tiny canvases
 * with the same procedural art the battlefield uses.
 *
 * The v2 addition is the two selection rows. An isometric battle with several
 * positions per side needs the player to say *where from* and *where to*, so the
 * HUD carries a launch-pad row (your positions) and an objective row (theirs),
 * each chip showing that position's health, its own launch timer and how many of
 * its troops are still in the field. Choosing a pad and an objective is the whole
 * tactical layer, so it sits on the main HUD rather than behind a menu.
 */

import {
  DEPLOY_ORDER,
  UNIT_STATS,
  baseKindLabel,
  hotkeyFor,
  type BaseKind,
  type UnitKind,
} from '../game/units';
import { LOGISTICS_MAX_LEVEL } from '../game/constants';
import type { BaseOption, TugState } from '../game/tugTypes';
import { missionLabel } from '../game/stageInfo';
import { environmentRules } from '../game/environment';
import { drawStructureIcon } from '../render/iso/structures';
import { drawUnitIcon } from '../render/iso/figures';
import type { Faction } from '../core/types';

export interface BattleHudCallbacks {
  readonly onDeploy: (kind: UnitKind) => void;
  readonly onSelectFrom: (baseId: number) => void;
  readonly onSelectTarget: (baseId: number) => void;
  readonly onLogistics: () => void;
  readonly onAbort: () => void;
  readonly onPause: () => void;
  readonly onZoom: () => void;
  readonly onRecenter: () => void;
}

export interface BattleHudInfo {
  readonly nodeName: string;
  readonly year: string;
  readonly strongpoint: string;
  readonly faction: Faction;
  readonly enemyFaction: Faction;
  readonly tier: number;
  readonly touch: boolean;
}

/** What the player currently has selected, owned by the match session. */
export interface HudSelection {
  readonly fromBaseId: number | null;
  readonly targetBaseId: number | null;
}

const ICON_W = 54;
const ICON_H = 40;
const BASE_ICON_W = 40;
const BASE_ICON_H = 32;

export interface BattleHud {
  update(state: TugState, fps: number, selection: HudSelection): void;
  setPaused(paused: boolean): void;
  setZoomed(zoomed: boolean): void;
  /** Brief message under the clock: what just happened, or what to do next. */
  say(message: string): void;
  dispose(): void;
}

interface ChipRefs {
  readonly root: HTMLElement;
  readonly hp: HTMLElement;
  readonly wait: HTMLElement;
  readonly units: HTMLElement;
  readonly icon: HTMLCanvasElement;
}

export function createBattleHud(
  root: HTMLElement,
  info: BattleHudInfo,
  callbacks: BattleHudCallbacks,
): BattleHud {
  // The HUD owns its own subtree: rendering directly into the container would
  // wipe the battle canvas the surface factory put there.
  const host = document.createElement('div');
  host.className = 'battle-hud';
  host.innerHTML = markup(info);
  root.appendChild(host);

  const el = <T extends HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector);
    if (!found) throw new Error(`missing ${selector}`);
    return found;
  };

  // --- unit icons: painted once, at device resolution so they stay crisp ----
  for (const kind of DEPLOY_ORDER) {
    const holder = host.querySelector<HTMLCanvasElement>(`[data-icon="${kind}"]`);
    if (!holder) continue;
    paintIcon(holder, ICON_W, ICON_H, (ctx) => {
      drawUnitIcon(ctx, kind, info.faction, info.tier, ICON_W / 2, ICON_H - 5, kind === 'tank' ? 30 : 30);
    });
  }

  // --- wiring --------------------------------------------------------------
  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    const deploy = target.closest<HTMLButtonElement>('[data-deploy]');
    if (deploy?.dataset.deploy) {
      callbacks.onDeploy(deploy.dataset.deploy as UnitKind);
      return;
    }
    const from = target.closest<HTMLButtonElement>('[data-from]');
    if (from?.dataset.from) {
      callbacks.onSelectFrom(Number(from.dataset.from));
      return;
    }
    const to = target.closest<HTMLButtonElement>('[data-to]');
    if (to?.dataset.to) callbacks.onSelectTarget(Number(to.dataset.to));
  };
  host.addEventListener('click', onClick);

  const buttons: readonly [string, () => void][] = [
    ['[data-action="hud-abort"]', callbacks.onAbort],
    ['[data-action="hud-pause"]', callbacks.onPause],
    ['[data-action="hud-zoom"]', callbacks.onZoom],
    ['[data-action="hud-recenter"]', callbacks.onRecenter],
    ['[data-logistics]', callbacks.onLogistics],
  ];
  for (const [selector, handler] of buttons) {
    el(selector).addEventListener('click', handler);
  }

  const playerBar = el<HTMLElement>('#hud-player-fill');
  const enemyBar = el<HTMLElement>('#hud-enemy-fill');
  const playerHp = el<HTMLElement>('#hud-player-hp');
  const enemyHp = el<HTMLElement>('#hud-enemy-hp');
  const playerPos = el<HTMLElement>('#hud-player-pos');
  const enemyPos = el<HTMLElement>('#hud-enemy-pos');
  const clock = el<HTMLElement>('#hud-clock');
  const supplies = el<HTMLElement>('#hud-supplies');
  const rate = el<HTMLElement>('#hud-rate');
  const bonds = el<HTMLElement>('#hud-bonds');
  const logistics = el<HTMLElement>('#hud-logistics');
  const field = el<HTMLElement>('#hud-field');
  const objective = el<HTMLElement>('#hud-objective');
  const note = el<HTMLElement>('#hud-note');
  const fromRow = el<HTMLElement>('#hud-from');
  const toRow = el<HTMLElement>('#hud-to');

  const fromChips = new Map<number, ChipRefs>();
  const toChips = new Map<number, ChipRefs>();
  const slotEls = new Map<UnitKind, HTMLElement>();
  for (const kind of DEPLOY_ORDER) {
    const button = host.querySelector<HTMLElement>(`[data-deploy="${kind}"]`);
    if (button) slotEls.set(kind, button);
  }

  let lastSignature = '';
  let lastFromKey = '';
  let lastToKey = '';

  /**
   * The chip rows are rebuilt only when the *set* of positions changes (a
   * position razed, or the next sector having a different layout). Everything
   * that changes every frame — health, timers, troop counts — is written into
   * the existing nodes instead, which is what keeps the HUD off the frame's
   * critical path.
   */
  function ensureChips(
    column: HTMLElement,
    options: readonly BaseOption[],
    cache: Map<number, ChipRefs>,
    faction: Faction,
    side: 'from' | 'to',
  ): void {
    const key = options.map((option) => `${option.id}:${option.kind}`).join(',');
    const expected = column.dataset.key ?? '';
    if (expected === key && cache.size === options.length) return;
    column.dataset.key = key;
    column.innerHTML = options.map((option) => chipMarkup(option, side)).join('');
    cache.clear();
    for (const option of options) {
      const chip = column.querySelector<HTMLElement>(`[data-chip="${option.id}"]`);
      if (!chip) continue;
      const icon = chip.querySelector<HTMLCanvasElement>('canvas');
      if (icon) {
        paintIcon(icon, BASE_ICON_W, BASE_ICON_H, (ctx) => {
          drawStructureIcon(ctx, option.kind, faction, info.tier, BASE_ICON_W / 2, BASE_ICON_H - 3, 26);
        });
      }
      cache.set(option.id, {
        root: chip,
        hp: chip.querySelector<HTMLElement>('.chip-hp i') ?? chip,
        wait: chip.querySelector<HTMLElement>('.chip-wait') ?? chip,
        units: chip.querySelector<HTMLElement>('.chip-units') ?? chip,
        icon: icon ?? document.createElement('canvas'),
      });
    }
  }

  function updateChips(options: readonly BaseOption[], cache: Map<number, ChipRefs>, selection: number | null, side: 'from' | 'to'): void {
    for (const option of options) {
      const refs = cache.get(option.id);
      if (!refs) continue;
      refs.hp.style.width = `${Math.round(option.hpFraction * 100)}%`;
      refs.root.classList.toggle('is-selected', selection === option.id);
      refs.root.classList.toggle('is-destroyed', option.destroyed);
      refs.root.classList.toggle('is-ready', option.ready);
      if (option.destroyed) {
        refs.wait.textContent = side === 'to' ? 'razed' : 'lost';
      } else if (option.cooldown > 0.05) {
        refs.wait.textContent = `${option.cooldown.toFixed(1)}s`;
      } else {
        refs.wait.textContent = 'ready';
      }
      refs.units.textContent = option.units > 0 ? `${option.units} in field` : '';
    }
  }

  return {
    setPaused(paused: boolean): void {
      el('#hud-pause').textContent = paused ? '▶' : '❚❚';
      host.classList.toggle('is-paused', paused);
    },
    setZoomed(zoomed: boolean): void {
      el('#hud-zoom').classList.toggle('is-on', zoomed);
    },
    say(message: string): void {
      note.textContent = message;
    },
    update(state: TugState, fps: number, selection: HudSelection): void {
      const rules = environmentRules(state.environment);
      let playerHpValue = 0;
      let playerHpMax = 0;
      let enemyHpValue = 0;
      let enemyHpMax = 0;
      for (const base of state.bases) {
        if (base.side === 'player') {
          playerHpValue += base.hp;
          playerHpMax += base.maxHp;
        } else {
          enemyHpValue += base.hp;
          enemyHpMax += base.maxHp;
        }
      }
      // The bar tracks *strength* (total hit points across the side's positions),
      // which is what actually decides a stalemate; the counts sit beside it.
      const playerStrength = playerHpMax > 0 ? Math.max(0, playerHpValue / playerHpMax) : 0;
      const enemyStrength = enemyHpMax > 0 ? Math.max(0, enemyHpValue / enemyHpMax) : 0;
      playerBar.style.width = `${(playerStrength * 100).toFixed(1)}%`;
      enemyBar.style.width = `${(enemyStrength * 100).toFixed(1)}%`;
      // Rounded: a bar driven by sums of per-position hit points otherwise
      // prints raw float noise like "4454.2000000000001 hp".
      playerHp.textContent = `${Math.round(playerHpValue)}`;
      enemyHp.textContent = `${Math.round(enemyHpValue)}`;
      playerPos.textContent = `${state.playerBasesAlive}/${state.playerBasesTotal} positions`;
      enemyPos.textContent = `${state.enemyBasesAlive}/${state.enemyBasesTotal} positions`;

      const total = state.timeLeft;
      const minutes = Math.floor(total / 60);
      const seconds = Math.floor(total % 60);
      clock.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
      supplies.textContent = `${Math.floor(state.supplies)}`;
      rate.textContent = `+${state.supplyRate.toFixed(1)}/s`;
      bonds.textContent = `${state.bonds}`;
      logistics.textContent =
        state.logisticsLevel >= LOGISTICS_MAX_LEVEL
          ? `L${state.logisticsLevel} max`
          : `L${state.logisticsLevel} · ${state.logisticsCost} bonds`;
      field.textContent = `${state.playerUnits}/${state.enemyUnits} fielded · ${fps} fps`;

      // Everything that changes rarely is rebuilt only when it changes.
      const signature = `${state.missionType}|${state.environment}|${state.supplyRate.toFixed(2)}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        objective.textContent = `${missionLabel(state.missionType)} · ${rules.label} · ${rules.hint}`;
      }

      const fromKey = state.playerBaseOptions.map((option) => `${option.id}:${option.kind}`).join(',');
      if (fromKey !== lastFromKey) {
        lastFromKey = fromKey;
        ensureChips(fromRow, state.playerBaseOptions, fromChips, info.faction, 'from');
      }
      const toKey = state.enemyBaseOptions.map((option) => `${option.id}:${option.kind}`).join(',');
      if (toKey !== lastToKey) {
        lastToKey = toKey;
        ensureChips(toRow, state.enemyBaseOptions, toChips, info.enemyFaction, 'to');
      }
      updateChips(state.playerBaseOptions, fromChips, selection.fromBaseId, 'from');
      updateChips(state.enemyBaseOptions, toChips, selection.targetBaseId, 'to');

      for (const kind of DEPLOY_ORDER) {
        const button = slotEls.get(kind);
        const option = state.deployOptions.find((candidate) => candidate.kind === kind);
        if (!button || !option) continue;
        button.classList.toggle('is-ready', option.ready);
        button.classList.toggle('is-affordable', option.affordable);
        button.classList.toggle('is-blocked', !option.affordable);
        const cost = button.querySelector<HTMLElement>('.card-cost');
        if (cost) cost.textContent = `${option.cost}`;
        const sweep = button.querySelector<HTMLElement>('.card-sweep');
        if (sweep) {
          const fraction =
            option.cooldownTotal > 0 ? option.launchCooldown / option.cooldownTotal : 0;
          sweep.style.setProperty('--sweep', `${Math.round(Math.min(1, fraction) * 360)}deg`);
          sweep.classList.toggle('is-active', option.launchCooldown > 0);
        }
        const wait = button.querySelector<HTMLElement>('.card-wait');
        if (wait) wait.textContent = option.launchCooldown > 0 ? `${option.launchCooldown.toFixed(1)}s` : '';
      }
    },
    dispose(): void {
      host.removeEventListener('click', onClick);
      host.remove();
    },
  };
}

/** Paint into a small canvas at device resolution. */
function paintIcon(
  holder: HTMLCanvasElement,
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  holder.width = Math.floor(width * dpr);
  holder.height = Math.floor(height * dpr);
  const ctx = holder.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  paint(ctx);
}

/**
 * One launch pad / objective chip. Exactly one selection attribute is emitted:
 * a chip in the "launch from" row is a pad, a chip in the "attack" row is an
 * objective, and the delegated click handler tells them apart by that attribute.
 */
function chipMarkup(option: BaseOption, side: 'from' | 'to'): string {
  const state = option.destroyed ? 'is-destroyed' : option.ready ? 'is-ready' : '';
  const select = side === 'from' ? `data-from="${option.id}"` : `data-to="${option.id}"`;
  return `
    <button type="button" class="chip-base ${state} chip-base--${side}" data-chip="${option.id}" ${select}
            title="${baseKindLabel(option.kind as BaseKind)} · ${option.name}">
      <canvas width="${BASE_ICON_W}" height="${BASE_ICON_H}"></canvas>
      <span class="chip-body">
        <span class="chip-top"><b class="chip-letter">${option.letter}</b><span class="chip-name">${option.name}</span></span>
        <span class="chip-hp"><i style="width:${Math.round(option.hpFraction * 100)}%"></i></span>
      </span>
      <span class="chip-side">
        <span class="chip-wait">ready</span>
        <span class="chip-units"></span>
      </span>
    </button>`;
}

/** Cards are built once: 4 unit buttons plus the logistics purchase, plus the
 * two position rows that the player uses to aim a launch. */
function markup(info: BattleHudInfo): string {
  const cards = DEPLOY_ORDER.map((kind) => {
    const stats = UNIT_STATS[kind];
    return `
      <button type="button" class="card" data-deploy="${kind}" aria-label="Deploy ${stats.name}">
        <canvas class="card-icon" data-icon="${kind}" width="${ICON_W}" height="${ICON_H}"></canvas>
        <span class="card-name">${stats.name}</span>
        <span class="card-cost-wrap"><span class="card-cost">0</span><span class="card-supplies">s</span></span>
        <span class="card-hotkey">${hotkeyFor(kind)}</span>
        <span class="card-sweep" aria-hidden="true"></span>
        <span class="card-wait" aria-hidden="true"></span>
      </button>`;
  }).join('');

  return `
    <div id="hud-top">
      <div class="hud-side">
        <div class="hud-label">Your positions</div>
        <div class="hud-bar"><span id="hud-player-fill"></span></div>
        <div class="hud-hp"><span id="hud-player-hp">0</span> hp · <span id="hud-player-pos"></span></div>
      </div>
      <div class="hud-mid">
        <div class="hud-clock" id="hud-clock">0:00</div>
        <div class="hud-objective" id="hud-objective"></div>
        <div class="hud-stats">
          <span class="hud-stat"><b id="hud-supplies">0</b><i id="hud-rate"></i></span>
          <span class="hud-stat hud-stat--bond">★ <b id="hud-bonds">0</b></span>
          <span class="hud-stat" id="hud-logistics"></span>
          <span class="hud-stat hud-stat--dim" id="hud-field"></span>
        </div>
        <div class="hud-note" id="hud-note"></div>
      </div>
      <div class="hud-side hud-side--enemy">
        <div class="hud-label" id="hud-enemy-name">${info.strongpoint}</div>
        <div class="hud-bar"><span id="hud-enemy-fill"></span></div>
        <div class="hud-hp"><span id="hud-enemy-hp">0</span> hp · <span id="hud-enemy-pos"></span></div>
      </div>
      <div class="hud-buttons">
        <button type="button" class="hud-btn" data-action="hud-zoom" title="Zoom">⤢</button>
        <button type="button" class="hud-btn" data-action="hud-recenter" title="Centre">◎</button>
        <button type="button" class="hud-btn" data-action="hud-pause" id="hud-pause" title="Pause">❚❚</button>
        <button type="button" class="hud-btn hud-btn--abort" data-action="hud-abort" title="Abort">Abort</button>
      </div>
    </div>
    <div id="hud-orders">
      <div class="hud-order-row">
        <span class="hud-order-label">launch from</span>
        <div class="hud-chips" id="hud-from"></div>
      </div>
      <div class="hud-order-row">
        <span class="hud-order-label">attack</span>
        <div class="hud-chips" id="hud-to"></div>
      </div>
    </div>
    <div id="hud-bottom">
      ${cards}
      <button type="button" class="card card--logistics" data-logistics>
        <span class="card-boost">BOOST</span>
        <span class="card-name">Logistics</span>
        <span class="card-supplies-note">+0.6 supplies/s</span>
      </button>
    </div>`;
}
