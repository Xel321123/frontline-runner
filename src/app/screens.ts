/**
 * Screen markup builders.
 *
 * Every screen is a pure function of the save file plus campaign data: HTML in,
 * string out. The shell owns state and events; this module owns presentation,
 * which keeps the flows easy to read and impossible to desync from the data.
 */

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
  upgradeCost,
  upgradeEffectLabel,
} from '../core/progression';
import { THEATERS } from '../data/campaignData';
import { environmentRules } from '../game/environment';
import { effectiveSupplyRate } from '../game/match';
import { featureLabel, missionDetail, missionLabel, stageTagline } from '../game/stageInfo';
import { UNIT_ORDER, UNIT_STATS } from '../game/units';
import type { BattleOutcome } from './Match';
import { escapeHtml, fine, formatNumber } from './dom';

/**
 * Campaign-map art, resolved through `import.meta.env.BASE_URL` so subpath and
 * native builds both work. This is the only image the app loads at all — the
 * battlefield itself is drawn from paths.
 */
const MAP_URL = `${import.meta.env.BASE_URL}assets/maps/europe_blank_laea.svg`;

/** Glyph shown next to a node for its weather, so the map reads at a glance. */
function environmentGlyph(stage: StageDefinition): string {
  switch (stage.environment) {
    case 'snow':
      return '❄';
    case 'desert':
      return '☀';
    case 'mud':
      return '≋';
    case 'night':
      return '☾';
    default:
      return '';
  }
}

function factionName(faction: Faction): string {
  return FACTION_INFO.find((info) => info.id === faction)?.name ?? faction;
}

function unitNote(kind: (typeof UNIT_ORDER)[number]): string {
  switch (kind) {
    case 'rifleman':
      return 'long engagement range, bolt-action fire';
    case 'smg':
      return 'fast advance, high fire rate in close quarters';
    case 'mg':
      return 'digs in behind sandbags, suppresses what it hits';
    case 'tank':
      return 'slow and heavily armoured, area-effect cannon';
  }
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
          <span>${totals.deployments} battles</span>
          <span>${formatNumber(totals.casualties)} units lost</span>
        </span>
      </button>`;
  }).join('');

  return `
    <section class="screen screen--title">
      <div class="screen-head">
        <h2>The 1940-45 front</h2>
        <p class="lede">Pick a side to open its campaign map. Battles are won by
        breaking the enemy strongpoint with waves of infantry and armour — every
        unit is drawn from scratch, and the whole game runs from the local save
        file with no network calls.</p>
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
      return `cleared · best ${state.bestKills} enemy units destroyed`;
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
            title="${escapeHtml(
              `${stage.index}. ${stage.name} (${stage.year}) — ${stage.bossName} · ${statusLabel(state)} · ${stageTagline(stage)}`,
            )}">
      <span class="node-dot">${stage.index}</span>
      ${
        showLabel
          ? `<span class="node-label">${escapeHtml(`${environmentGlyph(stage)}${environmentGlyph(stage) ? ' ' : ''}${stage.name}`)}</span>`
          : ''
      }
    </button>`;
}

export function mapScreenHtml(save: SaveData): string {
  const faction = save.faction;
  if (!faction) return titleScreenHtml(save);

  const nodes = campaignMap(faction, save.unlockedStages, save.records);
  const totals = campaignTotals(faction, save.records);
  const progress = campaignProgress(faction, save.unlockedStages);
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

  // Weather key: the glyph a node carries, and what it does to the battle.
  const weatherLegend = (['snow', 'desert', 'mud', 'night'] as const)
    .map((environment) => {
      const rules = environmentRules(environment);
      return `<span class="legend-item" title="${escapeHtml(rules.summary)}"><i class="swatch swatch--env">${
        environment === 'snow' ? '❄' : environment === 'desert' ? '☀' : environment === 'mud' ? '≋' : '☾'
      }</i>${escapeHtml(rules.label)} <span class="legend-hint">${escapeHtml(rules.hint)}</span></span>`;
    })
    .join('');

  return `
    <section class="screen screen--map">
      <div class="map-meta">
        <div class="map-stats">
          <span class="stat"><b>${totals.cleared}</b>/${progress.total} sectors cleared</span>
          <span class="stat"><b>${totals.contested}</b> contested</span>
          <span class="stat"><b>${formatNumber(totals.casualties)}</b> units lost</span>
          <span class="stat"><b>${formatNumber(save.warBonds)}</b> war bonds</span>
        </div>
        <div class="legend">${legend}</div>
        <div class="legend legend--env">${weatherLegend}</div>
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

  const rules = environmentRules(stage.environment);
  const supplyRate = effectiveSupplyRate(stage).toFixed(1);
  const rows: (readonly [string, string])[] = [
    ['theatre', `${stage.theater} · ${stage.year}`],
    ['grid', `x ${stage.coords.x}% · y ${stage.coords.y}%`],
    ['mission', `${missionLabel(stage.missionType)} — ${missionDetail(stage.missionType)}`],
    ['strongpoint', stage.bossName],
    [
      'conditions',
      stage.environment === 'standard' ? rules.label : `${rules.label} — ${rules.summary}`,
    ],
    [
      'terrain',
      stage.features.length > 0
        ? stage.features.map((feature) => featureLabel(feature)).join(', ')
        : 'open ground',
    ],
    [
      'supply rate',
      `${supplyRate}/s${Math.abs(stage.supplyRateMultiplier - 1) > 0.001 ? ` (×${stage.supplyRateMultiplier})` : ''}`,
    ],
    ['enemy tier', `${stage.tier} of 9 · ${stage.faction === 'allied' ? 'Axis' : 'Allied'} forces`],
    ['reward', `${stage.rewardBonds} war bonds`],
    ['status', cleared ? 'cleared' : locked ? 'locked' : 'open'],
  ];
  if (record) {
    rows.push([
      'record',
      `${record.wins}W / ${record.losses}L · ${formatNumber(record.casualties)} units lost${
        record.bestKills > 0 ? ` · best ${record.bestKills} destroyed` : ''
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
    <p class="fine">Command your line from the deployment bar: supplies arrive
    continuously (${supplyRate}/s here, before logistics upgrades), and bonds
    dropped by destroyed enemy units buy those upgrades mid-battle.</p>
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
  readonly objective: string;
  readonly tier: number;
  /** One-line description of the next objective's mission, weather and terrain. */
  readonly objectiveTagline: string;
  /** The army's current standard rifle, from the campaign weapon table. */
  readonly standardRifle: string;
  readonly standardRifleDetail: string;
  readonly startSupplies: number;
  /** Supplies per second this sector actually pays. */
  readonly supplyRate: number;
  readonly baseHp: number;
  readonly damageMultiplier: number;
  readonly fireRateMultiplier: number;
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

  const roster = UNIT_ORDER.map((kind) => {
    const stats = UNIT_STATS[kind];
    const damage = stats.damage * view.damageMultiplier;
    const rate = stats.fireRate * view.fireRateMultiplier;
    return `
      <li class="unit-card">
        <div class="unit-card-head">
          <b>${escapeHtml(stats.name)}</b>
          <span class="cost">${stats.cost} supplies</span>
        </div>
        <p class="unit-card-note">${escapeHtml(unitNote(kind))}</p>
        <p class="mono unit-card-stats">${stats.hp} hp · ${Math.round(damage)} dmg · ${rate.toFixed(
          2,
        )}/s · ${stats.range}px range${
          stats.blast ? ` · ${stats.blast}px blast` : ''
        }${stats.armor ? ` · ${stats.armor} armour` : ''}</p>
      </li>`;
  }).join('');

  return `
    <div class="modal-head">
      <span class="modal-kicker">${escapeHtml(factionName(view.faction))} · camp</span>
      <h2>Armoury &amp; replacements</h2>
      <p class="lede">War bonds: <b>${formatNumber(save.warBonds)}</b> · next objective
      <b>${escapeHtml(view.objective)}</b> (tier ${view.tier})</p>
      <p class="fine">${escapeHtml(view.objectiveTagline)}</p>
    </div>
    <div class="camp-grid">
      <section class="camp-block">
        <h3>Your battle line</h3>
        <div class="weapon-card">
          <b>Standard rifle: ${escapeHtml(view.standardRifle)}</b>
          <p class="mono">${escapeHtml(view.standardRifleDetail)}</p>
        </div>
        <ul class="loadout">
          <li><span>supplies at deploy</span><b>${formatNumber(view.startSupplies)}</b></li>
          <li><span>supply rate here</span><b>${view.supplyRate.toFixed(1)}/s</b></li>
          <li><span>base hit points</span><b>${formatNumber(view.baseHp)}</b></li>
          <li><span>unit damage</span><b>×${view.damageMultiplier.toFixed(2)}</b></li>
          <li><span>unit rate of fire</span><b>×${view.fireRateMultiplier.toFixed(2)}</b></li>
        </ul>
        <ul class="unit-list">${roster}</ul>
        <p class="fine">Every figure on the field is drawn procedurally — no sprite
        sheets, no downloads.</p>
      </section>
      <section class="camp-block">
        <h3>Upgrades</h3>
        <ul class="upgrades">${rows}</ul>
        <p class="fine">Bonds come from destroyed enemy units and from cleared
        sectors — ${formatNumber(save.warBonds)} banked.</p>
      </section>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn--primary" data-action="deploy-next">▶ deploy</button>
      <button type="button" class="btn btn--ghost" data-action="close-modal">back to map</button>
    </div>`;
}

// -------------------------------------------------------------------- result

export function resultHtml(
  outcome: BattleOutcome,
  save: SaveData,
  nextStage?: StageDefinition,
): string {
  const won = outcome.status === 'victory';
  // Never claim a strongpoint was destroyed when it was the clock that decided
  // the sector — the remaining-strength figures below tell the real story.
  const title = won
    ? outcome.lossReason === 'time-expired'
      ? 'Sector secured'
      : 'Strongpoint destroyed'
    : outcome.lossReason === 'time-expired'
      ? 'Time expired'
      : 'Base overrun';

  const unlocked = outcome.unlockedStage ? (nextStage ?? null) : null;
  const minutes = Math.floor(outcome.durationSeconds / 60);
  const seconds = Math.floor(outcome.durationSeconds % 60);

  return `
    <div class="modal-head modal-head--${won ? 'win' : 'loss'}">
      <span class="modal-kicker">${escapeHtml(outcome.nodeName)} · ${escapeHtml(
        outcome.year,
      )} · ${minutes}m ${String(seconds).padStart(2, '0')}s · ${escapeHtml(
        outcome.situation,
      )}</span>
      <h2>${title}</h2>
    </div>
    <div class="result-grid">
      <div class="result-stat"><span>war bonds awarded</span><b class="${
        won ? 'pos' : ''
      }">${won ? `+${formatNumber(outcome.bondsAwarded)}` : '0'}</b></div>
      <div class="result-stat"><span>bonds from the field</span><b class="pos">+${formatNumber(
        outcome.bondsCollected,
      )}</b></div>
      <div class="result-stat"><span>units deployed</span><b>${outcome.unitsDeployed}</b></div>
      <div class="result-stat"><span>units lost</span><b class="neg">${formatNumber(
        outcome.unitsLost,
      )}</b></div>
      <div class="result-stat"><span>enemy destroyed</span><b>${outcome.enemyDestroyed}</b></div>
      <div class="result-stat"><span>logistics upgrades</span><b>${outcome.logisticsBought}</b></div>
      <div class="result-stat"><span>your base</span><b>${formatNumber(
        outcome.playerBaseRemaining,
      )}/${formatNumber(outcome.playerBaseMax)}</b></div>
      <div class="result-stat"><span>enemy strongpoint</span><b>${formatNumber(
        outcome.enemyBaseRemaining,
      )}/${formatNumber(outcome.enemyBaseMax)}</b></div>
    </div>
    ${
      unlocked
        ? `<p class="unlock-line">Unlocked: <b>${escapeHtml(unlocked.name)}</b> (${escapeHtml(
            unlocked.year,
          )}) — ${escapeHtml(unlocked.bossName)}</p>`
        : fine(
            won
              ? 'That was the last node in this campaign.'
              : 'The sector stays open, and the bonds you collected are banked — spend them at camp and try again.',
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
  readonly theatreCount: number;
  readonly unitKinds: number;
  readonly note?: string;
}

export function diagnosticsHtml(view: DiagnosticsView): string {
  return `
    <h3>Diagnostics</h3>
    <ul class="diag-rows">
      <li><span>save backend</span><b>${escapeHtml(view.backendId)}${
        view.persistent ? '' : ' (in-memory only!)'
      }</b></li>
      <li><span>unit archetypes</span><b>${view.unitKinds}</b></li>
      <li><span>theatres in database</span><b>${view.theatreCount}</b></li>
      <li><span>sprites or images loaded by the battlefield</span><b>0</b></li>
      <li><span>network calls needed to play</span><b>0</b></li>
    </ul>
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
  return campaignMap(faction, save.unlockedStages, save.records).find(
    (state) => state.deployable,
  )?.stage;
}

export { THEATERS };
