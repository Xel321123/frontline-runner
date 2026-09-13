/**
 * BattleHud — the battle HUD as real DOM over a fixed, full-viewport canvas.
 *
 * Data lives in the DOM (crisp text, accessible buttons, native touch targets);
 * the canvas draws only the world. Icons are painted once into tiny canvases
 * with the same procedural routines the battlefield uses.
 */

import { DEPLOY_ORDER, UNIT_STATS, hotkeyFor, type UnitKind } from '../game/units';
import { LOGISTICS_MAX_LEVEL } from '../game/constants';
import type { TugState } from '../game/tugTypes';
import { missionLabel } from '../game/stageInfo';
import { environmentRules } from '../game/environment';
import { drawUnitIcon } from '../render/figures';
import { helmetFor } from '../render/palette';
import { paletteFor } from '../render/palette';
import type { Faction } from '../core/types';

export interface BattleHudCallbacks {
  readonly onDeploy: (kind: UnitKind) => void;
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

const ICON_W = 54;
const ICON_H = 40;

export interface BattleHud {
  update(state: TugState, fps: number): void;
  setPaused(paused: boolean): void;
  setZoomed(zoomed: boolean): void;
  dispose(): void;
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

  // --- icons: painted once, at device resolution so they stay crisp ---------
  const iconScale = 1;
  for (const kind of DEPLOY_ORDER) {
    const holder = host.querySelector<HTMLCanvasElement>(`[data-icon="${kind}"]`);
    if (!holder) continue;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    holder.width = Math.floor(ICON_W * dpr);
    holder.height = Math.floor(ICON_H * dpr);
    const ctx = holder.getContext('2d');
    if (!ctx) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ICON_W, ICON_H);
    drawUnitIcon(
      ctx,
      kind,
      paletteFor(info.faction),
      helmetFor(info.faction, info.tier),
      ICON_W / 2,
      ICON_H - 6,
      kind === 'tank' ? 0.78 : 0.86 * iconScale,
    );
  }

  // --- wiring --------------------------------------------------------------
  const onDeploy = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-deploy]');
    if (button?.dataset.deploy) callbacks.onDeploy(button.dataset.deploy as UnitKind);
  };
  host.addEventListener('click', onDeploy);

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
  const clock = el<HTMLElement>('#hud-clock');
  const supplies = el<HTMLElement>('#hud-supplies');
  const rate = el<HTMLElement>('#hud-rate');
  const bonds = el<HTMLElement>('#hud-bonds');
  const logistics = el<HTMLElement>('#hud-logistics');
  const field = el<HTMLElement>('#hud-field');
  const objective = el<HTMLElement>('#hud-objective');
  const slotEls = new Map<UnitKind, HTMLElement>();
  for (const kind of DEPLOY_ORDER) {
    const button = host.querySelector<HTMLElement>(`[data-deploy="${kind}"]`);
    if (button) slotEls.set(kind, button);
  }

  let lastSignature = '';

  return {
    setPaused(paused: boolean): void {
      el('#hud-pause').textContent = paused ? '▶' : '❚❚';
      host.classList.toggle('is-paused', paused);
    },
    setZoomed(zoomed: boolean): void {
      el('#hud-zoom').classList.toggle('is-on', zoomed);
    },
    update(state: TugState, fps: number): void {
      const rules = environmentRules(state.environment);
      const playerFraction = Math.max(0, state.playerBase.hp / state.playerBase.maxHp);
      const enemyFraction = Math.max(0, state.enemyBase.hp / state.enemyBase.maxHp);
      playerBar.style.width = `${(playerFraction * 100).toFixed(1)}%`;
      enemyBar.style.width = `${(enemyFraction * 100).toFixed(1)}%`;
      playerHp.textContent = `${Math.max(0, Math.round(state.playerBase.hp))}`;
      enemyHp.textContent = `${Math.max(0, Math.round(state.enemyBase.hp))}`;

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
          const fraction = option.cooldownTotal > 0 ? option.cooldown / option.cooldownTotal : 0;
          sweep.style.setProperty('--sweep', `${Math.round(Math.min(1, fraction) * 360)}deg`);
          sweep.classList.toggle('is-active', option.cooldown > 0);
        }
        const wait = button.querySelector<HTMLElement>('.card-wait');
        if (wait) wait.textContent = option.cooldown > 0 ? `${option.cooldown.toFixed(1)}s` : '';
      }
    },
    dispose(): void {
      host.removeEventListener('click', onDeploy);
      host.remove();
    },
  };
}

/** Cards are built once: 4 unit buttons plus the logistics purchase. */
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
        <div class="hud-label">Your base</div>
        <div class="hud-bar"><span id="hud-player-fill"></span></div>
        <div class="hud-hp"><span id="hud-player-hp">0</span></div>
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
      </div>
      <div class="hud-side hud-side--enemy">
        <div class="hud-label" id="hud-enemy-name">${info.strongpoint}</div>
        <div class="hud-bar"><span id="hud-enemy-fill"></span></div>
        <div class="hud-hp"><span id="hud-enemy-hp">0</span></div>
      </div>
      <div class="hud-buttons">
        <button type="button" class="hud-btn" data-action="hud-zoom" title="Zoom">⤢</button>
        <button type="button" class="hud-btn" data-action="hud-recenter" title="Centre">◎</button>
        <button type="button" class="hud-btn" data-action="hud-pause" id="hud-pause" title="Pause">❚❚</button>
        <button type="button" class="hud-btn hud-btn--abort" data-action="hud-abort" title="Abort">Abort</button>
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
