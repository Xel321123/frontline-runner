/**
 * Campaign and economy tables.
 *
 * Balance lives here; the history lives in `src/data/campaignData.ts`. The
 * sixty campaign nodes are mapped into `StageDefinition`s (adding the per-stage
 * enemy tier and war-bond reward) so the save layer validates against exactly
 * the same ids the UI and renderer use.
 */
import type { StageId, StageRecord, UpgradeId, UpgradeLevels } from './types';
import { UNIT_TIERS } from './assets';
import type { CampaignNode } from '../data/campaignData';
import {
  AXIS_CAMPAIGN,
  ALLIED_CAMPAIGN,
  CAMPAIGNS,
  CAMPAIGN_LENGTH,
  getCampaignNode,
  nextCampaignNode,
  stageIndexOf,
} from '../data/campaignData';

export interface StageDefinition extends CampaignNode {
  readonly faction: 'allied' | 'axis';
  /** 1-based position within the faction's own campaign. */
  readonly index: number;
  readonly region: string;
  /** Character-pack tier used by the enemies in this stage. */
  readonly tier: number;
  /** War bonds awarded on a first clear. */
  readonly rewardBonds: number;
}

/**
 * Four nodes per character-pack tier, walking the eight tiers the pack ships
 * (it has no `t7`, hence the gap in `UNIT_TIERS`).
 */
const NODES_PER_TIER = 4;

function tierForIndex(index: number): number {
  const slot = Math.min(Math.floor(index / NODES_PER_TIER), UNIT_TIERS.length - 1);
  return UNIT_TIERS[slot] ?? 1;
}

/** War bonds rise by 15 per node: 60 at Narvik, 495 at the Halbe Pocket. */
function bondsForIndex(index: number): number {
  return 60 + index * 15;
}

function toStage(node: CampaignNode, faction: 'allied' | 'axis', index: number): StageDefinition {
  return {
    ...node,
    faction,
    index: index + 1,
    region: node.theater,
    tier: tierForIndex(index),
    rewardBonds: bondsForIndex(index),
  };
}

export const ALLIED_STAGES: readonly StageDefinition[] = ALLIED_CAMPAIGN.map((node, index) =>
  toStage(node, 'allied', index),
);

export const AXIS_STAGES: readonly StageDefinition[] = AXIS_CAMPAIGN.map((node, index) =>
  toStage(node, 'axis', index),
);

/** Every campaign node, both factions, in play order. */
export const STAGES: readonly StageDefinition[] = [...ALLIED_STAGES, ...AXIS_STAGES];

export const STAGES_BY_FACTION = {
  allied: ALLIED_STAGES,
  axis: AXIS_STAGES,
} as const satisfies Record<'allied' | 'axis', readonly StageDefinition[]>;

/**
 * A fresh save can start either campaign, so both opening nodes are unlocked
 * from the beginning.
 */
export const STARTING_STAGES: readonly StageId[] = [
  ALLIED_CAMPAIGN[0]?.id ?? 'allied-01',
  AXIS_CAMPAIGN[0]?.id ?? 'axis-01',
];

const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));

export function getStage(id: StageId): StageDefinition | undefined {
  return STAGE_BY_ID.get(id);
}

export function isStageId(value: unknown): value is StageId {
  return typeof value === 'string' && STAGE_BY_ID.has(value);
}

/** Stages of one faction, in play order. */
export function stagesForFaction(faction: 'allied' | 'axis'): readonly StageDefinition[] {
  return STAGES_BY_FACTION[faction];
}

/**
 * Stage unlocked when `id` is cleared. Follows the node's own campaign, so
 * finishing the last Allied node does not unlock an Axis node.
 */
export function nextStageId(id: StageId): StageId | undefined {
  return nextCampaignNode(id)?.id;
}

/** Number of campaign nodes in one faction's campaign. */
export const STAGES_PER_CAMPAIGN = CAMPAIGN_LENGTH;

/** How far through its campaign a save is, for the boot/menu readouts. */
export function campaignProgress(
  faction: 'allied' | 'axis',
  unlockedStages: readonly StageId[],
): {
  readonly unlocked: number;
  readonly total: number;
  readonly next: StageDefinition | undefined;
  readonly complete: boolean;
} {
  const stages = STAGES_BY_FACTION[faction];
  const unlocked = stages.filter((stage) => unlockedStages.includes(stage.id));
  const next = stages.find((stage) => unlockedStages.includes(stage.id));
  return {
    unlocked: unlocked.length,
    total: stages.length,
    next,
    complete: unlocked.length === stages.length && stages.length > 0,
  };
}

/** How a node should be drawn on the campaign map. */
export type NodeStatus = 'cleared' | 'contested' | 'current' | 'locked';

export interface CampaignNodeState {
  readonly stage: StageDefinition;
  readonly status: NodeStatus;
  readonly wins: number;
  readonly losses: number;
  readonly casualties: number;
  readonly bestTroops: number;
  /** True while this is the node the next deployment would fight. */
  readonly deployable: boolean;
}

/**
 * Derive the whole map from the save: cleared ground (green), ground that has
 * cost the player troops (red), the next objective (gold) and the rest (grey).
 */
export function campaignMap(
  faction: 'allied' | 'axis',
  unlockedStages: readonly StageId[],
  records: Readonly<Record<string, StageRecord>>,
): readonly CampaignNodeState[] {
  const stages = STAGES_BY_FACTION[faction];
  let currentTaken = false;

  return stages.map((stage) => {
    const record = records[stage.id];
    const unlocked = unlockedStages.includes(stage.id);
    const wins = record ? record.wins : 0;
    const losses = record ? record.losses : 0;
    const cleared = wins > 0;

    let status: NodeStatus = 'locked';
    let deployable = false;
    if (cleared) {
      status = 'cleared';
    } else if (unlocked && !currentTaken) {
      // The first unlocked node that has not been won is the live objective.
      status = losses > 0 ? 'contested' : 'current';
      deployable = true;
      currentTaken = true;
    } else if (unlocked && losses > 0) {
      status = 'contested';
    }

    return {
      stage,
      status,
      wins,
      losses,
      casualties: record ? record.casualties : 0,
      bestTroops: record ? record.bestTroops : 0,
      deployable,
    };
  });
}

/** Campaign-wide totals for the map header and the result screens. */
export function campaignTotals(
  faction: 'allied' | 'axis',
  records: Readonly<Record<string, StageRecord>>,
): {
  readonly cleared: number;
  readonly contested: number;
  readonly casualties: number;
  readonly deployments: number;
} {
  const stages = STAGES_BY_FACTION[faction];
  let cleared = 0;
  let contested = 0;
  let casualties = 0;
  let deployments = 0;
  for (const stage of stages) {
    const record = records[stage.id];
    if (!record) continue;
    if (record.wins > 0) cleared += 1;
    else if (record.losses > 0) contested += 1;
    casualties += record.casualties;
    deployments += record.wins + record.losses;
  }
  return { cleared, contested, casualties, deployments };
}

/**
 * The node a deployment would actually fight: the first *uncleared* unlocked
 * node. (`campaignProgress().next` answers a different question — the first
 * unlocked node — so a cleared sector would otherwise be offered again.)
 */
export function nextObjective(
  faction: 'allied' | 'axis',
  unlockedStages: readonly StageId[],
  records: Readonly<Record<string, StageRecord>>,
): StageDefinition | undefined {
  return campaignMap(faction, unlockedStages, records).find((state) => state.deployable)?.stage;
}

export { CAMPAIGNS, CAMPAIGN_LENGTH, getCampaignNode, stageIndexOf };

export interface UpgradeDefinition {
  readonly id: UpgradeId;
  readonly name: string;
  readonly description: string;
  readonly maxLevel: number;
  /** War bonds for level 1. */
  readonly baseCost: number;
  /** Additional bonds per level already owned. */
  readonly costStep: number;
  /** Effect per level, so the camp screen and the simulation agree. */
  readonly perLevel: {
    /** Extra troops at deployment. */
    readonly troops?: number;
    /** Multiplicative bonus to projectile damage. */
    readonly damage?: number;
    /** Multiplicative bonus to rounds per second. */
    readonly fireRate?: number;
    /** Extra mid-run revives. */
    readonly revives?: number;
  };
}

/** Troops a stock squad deploys with, before any Starting Squad levels. */
export const BASE_SQUAD_TROOPS = 3;
export const TROOPS_PER_ARMOUR_LEVEL = 1;
export const DAMAGE_PER_FIREPOWER_LEVEL = 0.15;
export const FIRE_RATE_PER_MOBILITY_LEVEL = 0.06;
export const REVIVES_PER_MEDKIT_LEVEL = 1;

/**
 * Upgrade tracks sold at camp. The ids are persisted, so they are stable;
 * `name` is the label the camp screen shows.
 */
export const UPGRADES: readonly UpgradeDefinition[] = [
  {
    id: 'armour',
    name: 'Starting Squad',
    description: 'Deploy with more troopers in the line.',
    maxLevel: 5,
    baseCost: 140,
    costStep: 100,
    perLevel: { troops: TROOPS_PER_ARMOUR_LEVEL },
  },
  {
    id: 'firepower',
    name: 'Damage',
    description: 'Every round hits harder.',
    maxLevel: 5,
    baseCost: 120,
    costStep: 90,
    perLevel: { damage: DAMAGE_PER_FIREPOWER_LEVEL },
  },
  {
    id: 'mobility',
    name: 'Fire Rate',
    description: 'The squad works the bolt faster.',
    maxLevel: 5,
    baseCost: 110,
    costStep: 80,
    perLevel: { fireRate: FIRE_RATE_PER_MOBILITY_LEVEL },
  },
  {
    id: 'medkit',
    name: 'Field Medkit',
    description: 'One extra revive per run.',
    maxLevel: 3,
    baseCost: 200,
    costStep: 150,
    perLevel: { revives: REVIVES_PER_MEDKIT_LEVEL },
  },
];

const UPGRADE_BY_ID = new Map(UPGRADES.map((upgrade) => [upgrade.id, upgrade]));

/**
 * Human-readable effect of owning `level` levels of a track, e.g.
 * `+2 troops`, `+30% damage`. Used by the camp screen.
 */
export function upgradeEffectLabel(id: UpgradeId, level: number): string {
  const upgrade = UPGRADE_BY_ID.get(id);
  if (!upgrade) return '';
  const parts: string[] = [];
  const { troops = 0, damage = 0, fireRate = 0, revives = 0 } = upgrade.perLevel;
  if (troops > 0) parts.push(`+${troops * level} troops (${BASE_SQUAD_TROOPS + troops * level} at deploy)`);
  if (damage > 0) parts.push(`+${Math.round(damage * level * 100)}% damage`);
  if (fireRate > 0) parts.push(`+${Math.round(fireRate * level * 100)}% fire rate`);
  if (revives > 0) parts.push(`+${revives * level} revive${revives * level === 1 ? '' : 's'}`);
  return level > 0 ? parts.join(' · ') : 'not upgraded';
}

export function getUpgrade(id: UpgradeId): UpgradeDefinition | undefined {
  return UPGRADE_BY_ID.get(id);
}

/** Cost of the *next* level, or `null` when the track is maxed. */
export function upgradeCost(id: UpgradeId, currentLevel: number): number | null {
  const upgrade = UPGRADE_BY_ID.get(id);
  if (!upgrade) return null;
  if (currentLevel >= upgrade.maxLevel) return null;
  return upgrade.baseCost + upgrade.costStep * currentLevel;
}

export function clampLevel(id: UpgradeId, level: number): number {
  const upgrade = UPGRADE_BY_ID.get(id);
  const max = upgrade ? upgrade.maxLevel : 0;
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(level)));
}

export function cloneLevels(levels: UpgradeLevels): UpgradeLevels {
  return { ...levels };
}
