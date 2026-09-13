/**
 * Campaign and economy tables. Pure data + pure functions — no DOM, no I/O.
 *
 * Tiers come from the character pack that ships in `public/assets/characters/`
 * (the pack has no `t7`, hence the gap).
 */
import type { StageId, UpgradeId, UpgradeLevels } from './types';

export interface StageDefinition {
  readonly id: StageId;
  /** 1-based position in the campaign. */
  readonly index: number;
  readonly name: string;
  readonly region: string;
  /** Character-pack tier used by the enemies in this stage. */
  readonly tier: number;
  /** War bonds awarded on a first clear. */
  readonly rewardBonds: number;
}

export const STAGES: readonly StageDefinition[] = [
  { id: 't1', index: 1, name: 'Normandy Beachhead', region: 'France', tier: 1, rewardBonds: 60 },
  { id: 't2', index: 2, name: 'Bocage Breakout', region: 'France', tier: 2, rewardBonds: 75 },
  { id: 't3', index: 3, name: 'Ardennes Ridge', region: 'Belgium', tier: 3, rewardBonds: 90 },
  { id: 't4', index: 4, name: 'Rhine Crossing', region: 'Germany', tier: 4, rewardBonds: 110 },
  { id: 't5', index: 5, name: 'Ruhr Pocket', region: 'Germany', tier: 5, rewardBonds: 135 },
  { id: 't6', index: 6, name: 'Elbe Bridgehead', region: 'Germany', tier: 6, rewardBonds: 160 },
  { id: 't8', index: 7, name: 'Alpine Redoubt', region: 'Austria', tier: 8, rewardBonds: 200 },
  { id: 't9', index: 8, name: 'Final Command Post', region: 'Austria', tier: 9, rewardBonds: 250 },
];

/** Only the first stage is playable on a fresh save. */
export const STARTING_STAGES: readonly StageId[] = ['t1'];

const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));

export function getStage(id: StageId): StageDefinition | undefined {
  return STAGE_BY_ID.get(id);
}

export function isStageId(value: unknown): value is StageId {
  return typeof value === 'string' && STAGE_BY_ID.has(value);
}

/** Stage unlocked when `id` is cleared, or `undefined` at the end of the war. */
export function nextStageId(id: StageId): StageId | undefined {
  const stage = STAGE_BY_ID.get(id);
  if (!stage) return undefined;
  return STAGES[stage.index]?.id;
}

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
