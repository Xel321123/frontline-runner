/**
 * Match configuration — where the campaign database, the save file and the
 * battlefield meet.
 *
 * One function turns "the node the player is attacking, with the upgrades they
 * own" into everything the simulation needs: base hit points, the supply
 * economy, the enemy's unit mix for that tier, and the name on the enemy
 * strongpoint. Both the game and the headless harness call this, so balance
 * numbers can never drift from what ships.
 */

import { getUpgrade } from '../core/progression';
import type { StageDefinition } from '../core/progression';
import type { SaveData } from '../core/types';
import { hashString } from './rng';
import {
  ENEMY_BASE_HP_BASE,
  ENEMY_BASE_HP_PER_TIER,
  ENEMY_SUPPLY_BASE,
  ENEMY_SUPPLY_PER_TIER,
  PLAYER_BASE_HP,
  SUPPLY_BASE_RATE,
  SUPPLY_START,
} from './constants';
import type { MatchConfig } from './tugTypes';
import { UNIT_STATS } from './units';
import type { UnitKind } from './units';

/** The enemy fields these archetypes from the start. */
function enemyMixForTier(tier: number): { kind: UnitKind; weight: number }[] {
  const mix: { kind: UnitKind; weight: number }[] = [
    { kind: 'rifleman', weight: 5 },
    { kind: 'smg', weight: 2.4 },
  ];
  // Machine guns appear once the player has met the mid-war nodes, tanks late.
  if (tier >= 3) mix.push({ kind: 'mg', weight: 1.2 + tier * 0.14 });
  if (tier >= 6) mix.push({ kind: 'tank', weight: 0.45 + (tier - 6) * 0.25 });
  return mix;
}

function perLevel(id: 'armour' | 'firepower' | 'mobility' | 'medkit', key: string): number {
  const upgrade = getUpgrade(id);
  if (!upgrade) return 0;
  const value = (upgrade.perLevel as Record<string, number | undefined>)[key];
  return typeof value === 'number' ? value : 0;
}

export function createMatchConfig(stage: StageDefinition, save: SaveData): MatchConfig {
  const levels = save.upgrades;
  const enemyFaction = stage.faction === 'allied' ? 'axis' : 'allied';

  const damageMultiplier = 1 + perLevel('firepower', 'damage') * levels.firepower;
  const fireRateMultiplier = 1 + perLevel('mobility', 'fireRate') * levels.mobility;
  const startSupplies = SUPPLY_START + perLevel('armour', 'supplies') * levels.armour;
  const baseHp = PLAYER_BASE_HP + perLevel('medkit', 'baseHp') * levels.medkit;

  return {
    nodeId: stage.id,
    nodeName: stage.name,
    year: stage.year,
    theater: stage.theater,
    tier: stage.tier,
    strongpoint: stage.bossName,
    faction: stage.faction,
    enemyFaction,
    playerBaseHp: Math.round(baseHp),
    // The node's own campaign value is the difficulty index, so late sectors are
    // tougher without a separate hand-tuned table.
    enemyBaseHp: Math.round(ENEMY_BASE_HP_BASE + ENEMY_BASE_HP_PER_TIER * stage.tier),
    startSupplies: Math.round(startSupplies),
    supplyBaseRate: SUPPLY_BASE_RATE,
    // The enemy economy scales with the tier; the player out-scales it through
    // the in-match logistics upgrade instead.
    enemySupplyRate: ENEMY_SUPPLY_BASE + ENEMY_SUPPLY_PER_TIER * stage.tier,
    damageMultiplier,
    fireRateMultiplier,
    enemyMix: enemyMixForTier(stage.tier),
    seed: hashString(`match:${stage.id}`),
  };
}

/** Total supplies a unit costs, exposed so the HUD and AI agree. */
export function unitCost(kind: UnitKind): number {
  return UNIT_STATS[kind].cost;
}
