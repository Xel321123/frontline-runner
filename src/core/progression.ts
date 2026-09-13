/**
 * Campaign and economy tables.
 *
 * Balance lives here; the history lives in `src/data/campaignData.ts`. The
 * sixty campaign nodes are mapped into `StageDefinition`s (adding the per-stage
 * enemy tier and war-bond reward) so the save layer validates against exactly
 * the same ids the UI and renderer use.
 */
import type { StageId, UpgradeId, UpgradeLevels } from './types';
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
}

export const UPGRADES: readonly UpgradeDefinition[] = [
  {
    id: 'firepower',
    name: 'Firepower',
    description: 'Higher damage per shot.',
    maxLevel: 5,
    baseCost: 120,
    costStep: 90,
  },
  {
    id: 'armour',
    name: 'Armour',
    description: 'Absorbs an extra hit per level.',
    maxLevel: 5,
    baseCost: 140,
    costStep: 100,
  },
  {
    id: 'mobility',
    name: 'Mobility',
    description: 'Faster lane changes and reload.',
    maxLevel: 5,
    baseCost: 110,
    costStep: 80,
  },
  {
    id: 'medkit',
    name: 'Medkit',
    description: 'One extra revive per run.',
    maxLevel: 3,
    baseCost: 200,
    costStep: 150,
  },
];

const UPGRADE_BY_ID = new Map(UPGRADES.map((upgrade) => [upgrade.id, upgrade]));

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
