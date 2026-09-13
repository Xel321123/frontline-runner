/**
 * Screen markup builders.
 *
 * Every screen is a pure function of the save file + campaign data: HTML in,
 * string out. The shell owns state and events; this module owns presentation,
 * which keeps the flows easy to read and impossible to desync from the data.
 */

import { ASSET_MANIFEST } from '../core/assets';
import {
  FACTIONS,
  FACTION_INFO,
  type Faction,
  type SaveData,
  type StageRecord,
} from '../core/types';
import {
  UPGRADES,
  type CampaignNodeState,
  type NodeStatus,
  type StageDefinition,
  campaignMap,
  campaignProgress,
  campaignTotals,
  nextObjective as progressionNextObjective,
  upgradeCost,
  upgradeEffectLabel,
} from '../core/progression';
import type { RunOutcome } from './Play';
import { escapeHtml, fine, formatNumber } from './dom';

/** Map art, resolved through `import.meta.env.BASE_URL` so native builds work. */
const MAP_URL = `${import.meta.env.BASE_URL}${ASSET_MANIFEST.find((a) => a.key === 'map.europe')?.layers[0]?.url ?? ''}`;

function factionName(faction: Faction): string {
  return FACTION_INFO.find((info) => info.id === faction)?.name ?? faction;
}

// --------------------------------------------------------------------- title

export function titleScreenHtml(save: SaveData): string {
  const current = save.faction;
  const cards = FACTIONS.map((faction) => {
    const info = FACTION_INFO.find((entry) => entry.id === faction);
    const selected = current === faction;
    const totals = campaignTotals(faction, save.records);
    return `
      <button type="button" class="card faction-card${selected ? ' is-selected' : ''}"
              data-action="pick-faction" data-faction="${faction}">
        <span class="card-kicker">${selected ? 'active campaign' : 'campaign'}</span>
        <span class="card-title">${escapeHtml(info?.name ?? faction)}</span>
        <span class="card-body">${escapeHtml(info?.blurb ?? '')}</span>
        <span class="card-stats">
          <span>${totals.cleared}/30 cleared</span>
          <span>${totals.deployments} deployments</span>
          <span>${formatNumber(totals.casualties)} casualties</span>
        </span>
      </button>`;
  }).join('');

  return `
    <section class="screen screen--title">
      <div class="screen-head">
        <h2>The 1940-45 front</h2>
        <p class="lede">Pick a side to open its campaign map. Everything runs from
        the local save file — the game never calls the network.</p>
      </div>
      <div class="cards">${cards}</div>
      <div class="screen-actions">
        ${
          current
            ? `<button type="button" class="btn btn--primary" data-action="open-map">▶ continue ${escapeHtml(
                factionName(current),
              )}</button>`
            : ''
        }
        <button type="button" class="btn" data-action="open-camp">⚑ camp</button>
        <button type="button" class="btn" data-action="toggle-sound">sound: ${
          save.settings.muted ? 'off' : 'on'
        }</button>
        <button type="button" class="btn btn--ghost" data-action="toggle-diagnostics">diagnostics</button>
      </div>
      <div id="diagnostics" class="diagnostics" hidden></div>
    </section>`;
}

// --------------------------------------------------------------- campaign map

function statusLabel(state: CampaignNodeState): string {
  switch (state.status) {
    case 'cleared':
      return `cleared · best ${state.bestTroops} troops`;
    case 'contested':
      return `contested · ${state.losses} failed attempt${state.losses === 1 ? '' : 's'}`;
    case 'current':
      return 'next objective';
    default:
      return 'locked';
  }
}

function nodeHtml(state: CampaignNodeState): string {
  const { stage } = state;
  const classes = `node node--${state.status}${state.deployable ? ' is-deployable' : ''}`;
  const showLabel = state.status !== 'locked';
  return `
    <button type="button" class="${classes}" style="left:${stage.coords.x}%;top:${stage.coords.y}%"
            data-action="open-briefing" data-stage="${stage.id}"
            title="${escapeHtml(`${stage.index}. ${stage.name} (${stage.year}) — ${stage.bossName} · ${statusLabel(state)}`)}">
      <span class="node-dot">${stage.index}</span>
      ${showLabel ? `<span class="node-label">${escapeHtml(stage.name)}</span>` : ''}
    </button>`;
}

export function mapScreenHtml(save: SaveData): string {
  const faction = save.faction;
  if (!faction) return titleScreenHtml(save);

  const nodes = campaignMap(faction, save.unlockedStages, save.records);
  const totals = campaignTotals(faction, save.records);
  const progress = campaignProgress(faction, save.unlockedStages);
  // The live objective is the first *uncleared* unlocked node, not the first
  // unlocked one — otherwise a cleared sector would be offered again.
  const objective = nextObjective(faction, save);

  const legend = (
    [
      ['cleared', 'cleared'],
      ['current', 'next objective'],
      ['contested', 'contested'],
      ['locked', 'locked'],
    ] as readonly (readonly [NodeStatus, string])[]
  )
    .map(([status, label]) => `<span class="legend-item"><i class="swatch swatch--${status}"></i>${label}</span>`)
    .join('');

  return `
    <section class="screen screen--map">
      <div class="map-meta">
        <div class="map-stats">
          <span class="stat"><b>${totals.cleared}</b>/${progress.total} sectors cleared</span>
          <span class="stat"><b>${totals.contested}</b> contested</span>
          <span class="stat"><b>${formatNumber(totals.casualties)}</b> casualties</span>
          <span class="stat"><b>${formatNumber(save.warBonds)}</b> war bonds</span>
        </div>
        <div class="legend">${legend}</div>
      </div>
      <div class="map">
        <img class="map-bg" src="${MAP_URL}" alt="European theatre map" />
        <div class="map-nodes">${nodes.map(nodeHtml).join('')}</div>
      </div>
      <div class="map-footer">
        <span class="objective">${
          objective
            ? `next objective: <b>${escapeHtml(objective.name)}</b> (${escapeHtml(objective.year)})`
            : 'campaign complete'
        }</span>
        <div class="screen-actions">
          <button type="button" class="btn btn--primary" data-action="deploy-next">▶ deploy</button>
          <button type="button" class="btn" data-action="open-camp">⚑ camp</button>
          <button type="button" class="btn btn--ghost" data-action="open-title">faction</button>
        </div>
      </div>
    </section>`;
}

// ------------------------------------------------------------------ briefing

export function briefingHtml(stage: StageDefinition, save: SaveData): string {
  const record: StageRecord | undefined = save.records[stage.id];
  const cleared = record ? record.wins > 0 : false;
  const locked = !save.unlockedStages.includes(stage.id);

  const rows: (readonly [string, string])[] = [
    ['theatre', `${stage.theater} · ${stage.year}`],
    ['grid', `x ${stage.coords.x}% · y ${stage.coords.y}%`],
    ['strongpoint', `${stage.bossName} · ${formatNumber(stage.bossHp)} hp`],
    ['enemy tier', `${stage.tier} · ${stage.faction === 'allied' ? 'Axis' : 'Allied'} uniforms`],
    ['reward', `${stage.rewardBonds} war bonds`],
    ['status', cleared ? 'cleared' : locked ? 'locked' : 'open'],
  ];
  if (record) {
    rows.push([
      'record',
      `${record.wins}W / ${record.losses}L · ${formatNumber(record.casualties)} casualties${
        record.bestTroops > 0 ? ` · best ${record.bestTroops} troops` : ''
      }`,
    ]);
  }

  return `
    <div class="modal-head">
      <span class="modal-kicker">${escapeHtml(stage.id)} · node ${stage.index}/30</span>
      <h2>${escapeHtml(stage.name)} <span class="mono">${escapeHtml(stage.year)}</span></h2>
    </div>
    <p class="briefing">${escapeHtml(stage.briefing)}</p>
    <dl class="detail-grid">
      ${rows
        .map(
          ([term, value]) =>
            `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`,
        )
        .join('')}
    </dl>
    ${
      locked
        ? fine('This sector is not open yet — clear the preceding node first.')
        : ''
    }
    <div class="modal-actions">
      <button type="button" class="btn btn--primary" data-action="deploy-stage" data-stage="${
        stage.id
      }" ${locked ? 'disabled' : ''}>▶ deploy</button>
      <button type="button" class="btn" data-action="open-camp">⚑ camp</button>
      <button type="button" class="btn btn--ghost" data-action="close-modal">back to map</button>
    </div>`;
}

// ---------------------------------------------------------------------- camp

export interface CampView {
  readonly faction: Faction;
  readonly stageIndex: number;
  readonly weaponName: string;
  readonly weaponDetail: string;
  readonly squadSize: number;
  readonly damagePerTroop: number;
  readonly roundsPerSecond: number;
  readonly revives: number;
}

export function campHtml(save: SaveData, view: CampView): string {
  const rows = UPGRADES.map((upgrade) => {
    const level = save.upgrades[upgrade.id];
    const cost = upgradeCost(upgrade.id, level);
    const affordable = cost !== null && save.warBonds >= cost;
    const maxed = cost === null;
    const pips = Array.from({ length: upgrade.maxLevel })
      .map((_, index) => `<i class="pip${index < level ? ' is-filled' : ''}"></i>`)
      .join('');
    return `
      <li class="upgrade">
        <div class="upgrade-main">
          <div class="upgrade-head">
            <b>${escapeHtml(upgrade.name)}</b>
            <span class="pips">${pips}</span>
            <span class="mono level">L${level}/${upgrade.maxLevel}</span>
          </div>
          <p class="upgrade-desc">${escapeHtml(upgrade.description)}</p>
          <p class="upgrade-effect mono">${escapeHtml(upgradeEffectLabel(upgrade.id, level))}</p>
        </div>
        <div class="upgrade-buy">
          ${
            maxed
              ? '<span class="tag">maxed</span>'
              : `<span class="cost${affordable ? '' : ' is-poor'}">${cost} bonds</span>
                 <button type="button" class="btn btn--small" data-action="buy-upgrade"
                         data-upgrade="${upgrade.id}" ${affordable ? '' : 'disabled'}>buy</button>`
          }
        </div>
      </li>`;
  }).join('');

  return `
    <div class="modal-head">
      <span class="modal-kicker">${escapeHtml(factionName(view.faction))} · camp</span>
      <h2>Armoury &amp; replacements</h2>
      <p class="lede">War bonds: <b>${formatNumber(save.warBonds)}</b></p>
    </div>
    <div class="camp-grid">
      <section class="camp-block">
        <h3>Active weapon</h3>
        <div class="weapon-card">
          <b>${escapeHtml(view.weaponName)}</b>
          <p class="mono">${escapeHtml(view.weaponDetail)}</p>
        </div>
        <ul class="loadout">
          <li><span>squad at deployment</span><b>${view.squadSize} troops</b></li>
          <li><span>damage per trooper</span><b>${view.damagePerTroop.toFixed(1)}</b></li>
          <li><span>rounds per second</span><b>${view.roundsPerSecond.toFixed(2)}</b></li>
          <li><span>revives per run</span><b>${view.revives}</b></li>
        </ul>
        <p class="fine">Weapons unlock by campaign node (<span class="mono">minLevel</span>);
        ${escapeHtml(view.weaponName)} is the best one open to this army at node ${view.stageIndex}.</p>
      </section>
      <section class="camp-block">
        <h3>Upgrades</h3>
        <ul class="upgrades">${rows}</ul>
        <p class="fine">Bonds come from cleared sectors — ${formatNumber(save.warBonds)} banked.</p>
      </section>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn--primary" data-action="deploy-next">▶ deploy</button>
      <button type="button" class="btn btn--ghost" data-action="close-modal">back to map</button>
    </div>`;
}

// -------------------------------------------------------------------- result

export function resultHtml(outcome: RunOutcome, save: SaveData, nextStage?: StageDefinition): string {
  const won = outcome.status === 'won';
  const title = won
    ? 'Sector cleared'
    : outcome.lossReason === 'time-expired'
      ? 'Time expired'
      : 'Squad wiped';

  const unlocked = outcome.unlockedStage
    ? (nextStage ?? null)
    : null;

  return `
    <div class="modal-head modal-head--${won ? 'win' : 'loss'}">
      <span class="modal-kicker">${escapeHtml(outcome.nodeName)} · ${escapeHtml(outcome.year)}</span>
      <h2>${title}</h2>
    </div>
    <div class="result-grid">
      <div class="result-stat"><span>war bonds earned</span><b class="${won ? 'pos' : ''}">${
        won ? `+${formatNumber(outcome.bondsAwarded)}` : '0'
      }</b></div>
      <div class="result-stat"><span>troops remaining</span><b>${outcome.troopsRemaining}</b></div>
      <div class="result-stat"><span>casualties</span><b class="neg">${formatNumber(
        outcome.casualties,
      )}</b></div>
      <div class="result-stat"><span>infantry killed</span><b>${outcome.kills}</b></div>
      <div class="result-stat"><span>crates collected</span><b>${outcome.cratesCollected}</b></div>
      <div class="result-stat"><span>troops raised</span><b>${outcome.troopsGained}</b></div>
    </div>
    ${
      unlocked
        ? `<p class="unlock-line">Unlocked: <b>${escapeHtml(unlocked.name)}</b> (${escapeHtml(
            unlocked.year,
          )}) — ${escapeHtml(unlocked.bossName)}</p>`
        : fine(
            won
              ? 'That was the last node in this campaign.'
              : 'No new ground taken — the node stays open for another attempt.',
          )
    }
    <div class="modal-actions">
      ${
        won && unlocked
          ? `<button type="button" class="btn btn--primary" data-action="deploy-stage" data-stage="${unlocked.id}">▶ next sector</button>`
          : `<button type="button" class="btn btn--primary" data-action="deploy-stage" data-stage="${outcome.nodeId}">↻ retry sector</button>`
      }
      <button type="button" class="btn" data-action="open-camp">⚑ camp (${formatNumber(
        save.warBonds,
      )} bonds)</button>
      <button type="button" class="btn btn--ghost" data-action="close-modal">map</button>
    </div>`;
}

// --------------------------------------------------------------- diagnostics

export interface DiagnosticsView {
  readonly backendId: string;
  readonly persistent: boolean;
  readonly assetSummary: string;
  readonly assetFailures: readonly string[];
  readonly theatreCount: number;
  readonly note?: string;
}
export function diagnosticsHtml(view: DiagnosticsView): string {
  const failureRows = view.assetFailures.length
    ? `<ul class="failures">${view.assetFailures
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')}</ul>`
    : '<p class="fine">no sprite fell back to its procedural stand-in</p>';

  return `
    <h3>Diagnostics</h3>
    <ul class="diag-rows">
      <li><span>save backend</span><b>${escapeHtml(view.backendId)}${
        view.persistent ? '' : ' (in-memory only!)'
      }</b></li>
      <li><span>sprites</span><b>${escapeHtml(view.assetSummary)}</b></li>
      <li><span>theatres in database</span><b>${view.theatreCount}</b></li>
      <li><span>network calls needed to play</span><b>0</b></li>
    </ul>
    ${failureRows}
    <div class="screen-actions">
      <button type="button" class="btn btn--small" data-action="play-sound" data-sound="shot">shot</button>
      <button type="button" class="btn btn--small" data-action="play-sound" data-sound="hit">hit</button>
      <button type="button" class="btn btn--small" data-action="play-sound" data-sound="explosion">explosion</button>
      <button type="button" class="btn btn--small" data-action="play-sound" data-sound="uiClick">ui</button>
      <button type="button" class="btn btn--small" data-action="request-landscape">⛶ landscape</button>
      <button type="button" class="btn btn--small btn--danger" data-action="reset-save">reset save</button>
      <button type="button" class="btn btn--small" data-action="export-save">copy save json</button>
    </div>
    ${view.note ? `<p class="fine">${escapeHtml(view.note)}</p>` : ''}`;
}

/** Shared by the map and the title screen: which sector is next in line. */
export function nextObjective(faction: Faction, save: SaveData): StageDefinition | undefined {
  return progressionNextObjective(faction, save.unlockedStages, save.records);
}
