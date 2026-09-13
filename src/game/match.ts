/**
 * The supply rate a sector actually generates, including the mission bonuses:
 * the attacker in an assault has stockpiled, the defender in a survival battle
 * is dug in, and a plain battle gets neither. Shared with the UI so a briefing
 * can never advertise a rate the battle does not pay.
 */
export function effectiveSupplyRate(stage: StageDefinition): number {
  const assault = stage.missionType === 'assault' ? ASSAULT_ATTACKER_SUPPLY_BONUS : 1;
  const survival = stage.missionType === 'survive_timer' ? SURVIVE_DEFENDER_SUPPLY_BONUS : 1;
  return SUPPLY_BASE_RATE * stage.supplyRateMultiplier * assault * survival;
}

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

import { getUpgrade, type UpgradeDefinition } from '../core/progression';
import type { StageDefinition } from '../core/progression';
import type { SaveData, UpgradeId } from '../core/types';
import { hashString } from './rng';
import {
  ASSAULT_ATTACKER_SUPPLY_BONUS,
  ENEMY_DEPLOY_INTERVAL,
  ASSAULT_BASE_HP_MULTIPLIER,
  ENEMY_BASE_HP_BASE,
  ENEMY_BASE_HP_PER_TIER,
  ENEMY_LATE_WAR_SUPPLY,
  ENEMY_LATE_WAR_TIER,
  ENEMY_SUPPLY_BASE,
  ENEMY_SUPPLY_PER_TIER,
  PLAYER_BASE_HP,
  SUPPLY_BASE_RATE,
  SUPPLY_START,
  SURVIVE_DEFENDER_SUPPLY_BONUS,
  SURVIVE_ENEMY_DEPLOY_INTERVAL,
  SURVIVE_ENEMY_SUPPLY_BONUS,
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

/**
 * Read one upgrade's per-level effect. Typed against the definition so a track
 * cannot advertise an effect the simulation does not implement.
 */
function perLevel(id: UpgradeId, key: keyof UpgradeDefinition['perLevel']): number {
  const upgrade = getUpgrade(id);
  if (!upgrade) return 0;
  const value = upgrade.perLevel[key] as number | undefined;
  return typeof value === 'number' ? value : 0;
}

export function createMatchConfig(stage: StageDefinition, save: SaveData): MatchConfig {
  const levels = save.upgrades;
  const enemyFaction = stage.faction === 'allied' ? 'axis' : 'allied';

  const damageMultiplier = 1 + perLevel('damage', 'damage') * levels.damage;
  const unitHpMultiplier = 1 + perLevel('health', 'unitHp') * levels.health;
  // Starting supplies are fixed; the armory's three tracks are health,
  // damage and fortification, so nothing here inflates the opening depot.
  const startSupplies = SUPPLY_START;
  const baseHp = PLAYER_BASE_HP + perLevel('baseHp', 'baseHp') * levels.baseHp;

  const { missionType, environment, features, supplyRateMultiplier } = stage;
  // An assault is aimed at a prepared position, so the strongpoint is reinforced.
  const baseHpMultiplier = missionType === 'assault' ? ASSAULT_BASE_HP_MULTIPLIER : 1;
  // In a survival battle the enemy is the attacker and is reinforced accordingly.
  const enemySupplyBonus = missionType === 'survive_timer' ? SURVIVE_ENEMY_SUPPLY_BONUS : 1;
  const attackerSupplyBonus = missionType === 'assault' ? ASSAULT_ATTACKER_SUPPLY_BONUS : 1;
  // The attacker in an assault has stockpiled; the defender in a survival
  // battle is dug in with its dumps. A plain battle gets neither bonus.
  const survivalSupplyBonus = missionType === 'survive_timer' ? SURVIVE_DEFENDER_SUPPLY_BONUS : 1;

  return {
    nodeId: stage.id,
    nodeName: stage.name,
    year: stage.year,
    theater: stage.theater,
    tier: stage.tier,
    strongpoint: stage.bossName,
    faction: stage.faction,
    enemyFaction,
    missionType,
    environment,
    features,
    supplyRateMultiplier,
    playerBaseHp: Math.round(baseHp),
    // The node's own campaign value is the difficulty index, so late sectors are
    // tougher without a separate hand-tuned table.
    enemyBaseHp: Math.round(
      (ENEMY_BASE_HP_BASE + ENEMY_BASE_HP_PER_TIER * stage.tier) * baseHpMultiplier,
    ),
    startSupplies: Math.round(startSupplies),
    // The stage's supply multiplier is the logistics situation: 0.7 for a
    // besieged force, 1.4 for a blitzkrieg that has stockpiled for the push.
    supplyBaseRate:
      SUPPLY_BASE_RATE * supplyRateMultiplier * attackerSupplyBonus * survivalSupplyBonus,
    // The enemy economy scales with the tier; the player out-scales it through
    // the in-match logistics upgrade instead.
    enemySupplyRate:
      (ENEMY_SUPPLY_BASE +
        ENEMY_SUPPLY_PER_TIER * stage.tier +
        Math.max(0, stage.tier - ENEMY_LATE_WAR_TIER + 1) * ENEMY_LATE_WAR_SUPPLY) *
      enemySupplyBonus,
    enemyDeployInterval:
      missionType === 'survive_timer' ? SURVIVE_ENEMY_DEPLOY_INTERVAL : ENEMY_DEPLOY_INTERVAL,
    damageMultiplier,
    unitHpMultiplier,
    enemyMix: enemyMixForTier(stage.tier),
    seed: hashString(`match:${stage.id}`),
  };
}

/** Total supplies a unit costs, exposed so the HUD and AI agree. */
export function unitCost(kind: UnitKind): number {
  return UNIT_STATS[kind].cost;
}
