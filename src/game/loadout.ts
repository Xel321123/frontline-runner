/**
 * Loadout — turns save-file progress into run parameters.
 *
 * This is the single place where campaign progress, the weapon database and
 * the upgrade tracks meet, so the game and the headless balance harness
 * (`scripts/simulate-run.mjs`) compute identical numbers.
 *
 * Upgrade effects:
 *   firepower → +15% damage per level
 *   armour    → +1 starting troop per level
 *   mobility  → +6% rate of fire per level
 *   medkit    → +1 revive per level (a wipe restores a small squad instead of
 *               ending the run)
 */

import type { Faction, UpgradeLevels } from '../core/types';
import type { WeaponStats } from '../data/campaignData';
import { availableWeapons, startingWeapon } from '../data/campaignData';
import {
  BASE_SQUAD,
  DAMAGE_PER_FIREPOWER_LEVEL,
  FIRE_RATE_PER_MOBILITY_LEVEL,
  MAX_TROOPS,
  REVIVES_PER_MEDKIT_LEVEL,
  TROOPS_PER_ARMOUR_LEVEL,
} from './constants';
import type { SimConfig } from './types';

export interface Loadout {
  readonly faction: Faction;
  /** Campaign node (1-based) this loadout was built for. */
  readonly stageIndex: number;
  readonly weapon: WeaponStats;
  readonly damagePerTroop: number;
  readonly fireInterval: number;
  readonly spreadDegrees: number;
  readonly startingTroops: number;
  readonly revives: number;
  readonly maxTroops: number;
  readonly upgrades: UpgradeLevels;
}

/**
 * Weapon selection.
 *
 * The arms a squad carries in 1944 are not those of 1940, so the loadout takes
 * the latest weapon the campaign has unlocked (`minLevel <= stageIndex`).
 * Several weapons can share a minLevel — the final slot pairs a belt-fed HMG
 * with a single-shot launcher — and an auto-firing squad wants sustained fire,
 * so ties prefer the automatic weapon with the highest burst DPS. The launcher
 * stays in the database for a future weapon-select UI.
 */
export function pickWeapon(faction: Faction, stageIndex: number): WeaponStats {
  const unlocked = availableWeapons(faction, stageIndex);
  if (unlocked.length === 0) return startingWeapon(faction);
  const score = (weapon: WeaponStats): number =>
    (weapon.automatic ? 1 : 0) * 1_000_000 + weapon.damage * weapon.fireRate;
  return unlocked.reduce((best, candidate) => {
    if (candidate.minLevel !== best.minLevel) {
      return candidate.minLevel > best.minLevel ? candidate : best;
    }
    return score(candidate) > score(best) ? candidate : best;
  });
}

export function createLoadout(
  faction: Faction,
  stageIndex: number,
  upgrades: UpgradeLevels,
): Loadout {
  const weapon = pickWeapon(faction, stageIndex);

  const damageMultiplier = 1 + DAMAGE_PER_FIREPOWER_LEVEL * upgrades.firepower;
  const rateMultiplier = 1 + FIRE_RATE_PER_MOBILITY_LEVEL * upgrades.mobility;
  const rate = Math.max(0.1, weapon.fireRate * rateMultiplier);

  return {
    faction,
    stageIndex,
    weapon,
    damagePerTroop: weapon.damage * damageMultiplier,
    fireInterval: 1 / rate,
    spreadDegrees: weapon.spread,
    startingTroops: BASE_SQUAD + TROOPS_PER_ARMOUR_LEVEL * upgrades.armour,
    revives: REVIVES_PER_MEDKIT_LEVEL * upgrades.medkit,
    maxTroops: MAX_TROOPS,
    upgrades,
  };
}

export function toSimConfig(loadout: Loadout): SimConfig {
  return {
    weaponId: loadout.weapon.id,
    weaponName: loadout.weapon.name,
    damagePerTroop: loadout.damagePerTroop,
    fireInterval: loadout.fireInterval,
    spreadDegrees: loadout.spreadDegrees,
    startingTroops: loadout.startingTroops,
    revives: loadout.revives,
    maxTroops: loadout.maxTroops,
  };
}

/**
 * Squad DPS for a given troop count — used by the balance harness.
 *
 * Above the muzzle cap the extra troops fold into per-shot damage, so DPS is
 * linear in troop count regardless of how many projectiles are drawn.
 */
export function squadDps(loadout: Loadout, troops: number): number {
  const effective = Math.max(0, Math.min(troops, loadout.maxTroops));
  return effective * (1 / loadout.fireInterval) * loadout.damagePerTroop;
}
