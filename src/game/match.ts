/**
 * Match configuration — where the campaign database, the save file and the
 * battlefield meet.
 *
 * One function turns "the node the player is attacking, with the upgrades they
 * own" into everything the simulation needs: how many positions each side holds,
 * where they are on the ground plane, their hit points and names, the supply
 * economy and the enemy's unit mix. Both the game and the headless harness call
 * this, so balance numbers can never drift from what ships.
 *
 * The position count is the v2 progression lever: a tier-1 sector is a duel
 * between two positions, and by tier 9 each side is holding five. Enemy
 * throughput is deliberately *not* scaled by that count — the per-position
 * interval is multiplied by the position count so five positions field the same
 * weight of troops as one, just from five directions.
 */

import { getUpgrade, type UpgradeDefinition } from '../core/progression';
import type { StageDefinition } from '../core/progression';
import type { SaveData, UpgradeId } from '../core/types';
import { hashString, createRng } from './rng';
import {
  ASSAULT_ATTACKER_SUPPLY_BONUS,
  ASSAULT_BASE_HP_MULTIPLIER,
  BASE_HP_PER_EXTRA_BASE,
  BASE_MIN_SEPARATION,
  BASE_Y_MAX,
  BASE_Y_MIN,
  ENEMY_BASE_HP_BASE,
  ENEMY_BASE_HP_PER_TIER,
  ENEMY_DEPLOY_INTERVAL,
  ENEMY_LATE_WAR_SUPPLY,
  ENEMY_LATE_WAR_TIER,
  ENEMY_REAR_X,
  ENEMY_SUPPLY_BASE,
  ENEMY_SUPPLY_PER_TIER,
  MIN_BASE_HP,
  PLAYER_BASE_HP_TOTAL,
  PLAYER_REAR_X,
  REAR_X_JITTER,
  SUPPLY_BASE_RATE,
  SUPPLY_START,
  SURVIVE_DEFENDER_SUPPLY_BONUS,
  SURVIVE_ENEMY_DEPLOY_INTERVAL,
  SURVIVE_ENEMY_SUPPLY_BONUS,
  WORLD_H,
} from './constants';
import type { BasePlan, MatchConfig, Side } from './tugTypes';
import { UNIT_STATS, baseLetter, type BaseKind, type UnitKind } from './units';

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

/**
 * How many positions a side holds in this sector. The opening sectors are a
 * single position per side, which teaches the launch/target loop without any
 * flank to watch; from tier 7 a sector has so many positions that losing one
 * cannot be ignored, and the enemy always holds at least as many as the
 * attacker is given (it is defending ground it has had time to prepare).
 */
export function positionCountFor(side: Side, tier: number, missionType: string): number {
  // Both sides hold the same ground for the same tier — one position at tier 1,
  // five by tier 8 — so a campaign node is a fight between equals, and the only
  // asymmetry is the mission's: an assault is aimed at a prepared position, so
  // the defender holds one more.
  const base = 1 + Math.floor(tier / 2);
  const hardened = missionType === 'assault' && side === 'enemy' ? 1 : 0;
  return Math.max(1, Math.min(5, base + hardened));
}

/** Names for the second and later positions, drawn per node so they never drift. */
const ENEMY_POSITION_NAMES: readonly string[] = [
  'railway cutting',
  'old mill',
  'stone church',
  'farm buildings',
  'quarry face',
  'orchard line',
  'road junction',
  'tile works',
];

const PLAYER_POSITION_NAMES: readonly string[] = [
  'supply dump',
  'field depot',
  'aid station',
  'forward outpost',
  'battery position',
  'engineer yard',
];

/** What each extra position looks like, in order of appearance. */
const ENEMY_KINDS: readonly BaseKind[] = ['bunker', 'depot', 'outpost', 'bunker'];
const PLAYER_KINDS: readonly BaseKind[] = ['depot', 'outpost', 'bunker', 'depot'];

interface PositionSpec {
  readonly x: number;
  readonly y: number;
}

/**
 * Lay a side's positions out in its rear area: spread across the depth of the
 * field so the player has to choose which one to push, pushed apart until no two
 * are within `BASE_MIN_SEPARATION`, and jittered deterministically per node.
 */
function layoutPositions(side: Side, count: number, seed: string): PositionSpec[] {
  const rng = createRng(`bases:${seed}:${side}`);
  const rearX = side === 'player' ? PLAYER_REAR_X : ENEMY_REAR_X;
  const span = BASE_Y_MAX - BASE_Y_MIN;
  const positions: PositionSpec[] = [];

  for (let index = 0; index < count; index += 1) {
    // Even spread across the depth, with alternating lean in x so the rear area
    // reads as a line of positions rather than a column.
    const t = count === 1 ? 0.5 : index / (count - 1);
    let y = BASE_Y_MIN + t * span + rng.range(-18, 18);
    // Alternating lean across the rear area: adjacent positions are then offset
    // in BOTH axes, which is what lets five of them keep their distance apart in
    // a rear area only 400 units deep.
    const lean = index % 2 === 0 ? -1 : 1;
    let x = rearX + lean * REAR_X_JITTER * 0.8 + rng.range(-10, 10);

    for (let pass = 0; pass < 12; pass += 1) {
      let moved = false;
      for (const other of positions) {
        const dx = x - other.x;
        const dy = y - other.y;
        const d = Math.hypot(dx, dy);
        if (d >= BASE_MIN_SEPARATION) continue;
        const push = BASE_MIN_SEPARATION - d;
        y += (dy >= 0 ? 1 : -1) * push * 0.6;
        x += (dx >= 0 ? 1 : -1) * push * 0.25;
        moved = true;
      }
      if (!moved) break;
    }

    y = Math.max(48, Math.min(WORLD_H - 48, y));
    positions.push({ x: Math.round(x), y: Math.round(y) });
  }

  // Field order is depth order, so base letter A is always the northernmost
  // position of a side and the HUD row matches what the player sees.
  return positions.sort((a, b) => a.y - b.y);
}

/** Total hit points for a side, spread over its positions. */
function hpPerBase(total: number, count: number): number {
  return Math.max(MIN_BASE_HP, Math.round(total / count));
}

function buildPositions(
  side: Side,
  count: number,
  seed: string,
  bossName: string,
  hpTotal: number,
): BasePlan[] {
  const positions = layoutPositions(side, count, seed);
  const rng = createRng(`baseNames:${seed}:${side}`);
  const planes: BasePlan[] = [];
  const names = side === 'enemy' ? ENEMY_POSITION_NAMES : PLAYER_POSITION_NAMES;
  const kinds = side === 'enemy' ? ENEMY_KINDS : PLAYER_KINDS;
  const shuffled = rng.shuffle([...names]);

  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (!position) continue;
    const first = index === 0;
    // The primary hostile position carries the campaign's own name, so the
    // briefing's "strongpoint" is a place on the field and not just a label.
    const name =
      side === 'enemy' && first
        ? bossName
        : first
          ? 'field headquarters'
          : `the ${shuffled[index - 1] ?? 'outpost'}`;
    const kind: BaseKind = first
      ? side === 'enemy'
        ? 'stronghold'
        : 'hq'
      : (kinds[(index - 1) % kinds.length] ?? 'outpost');
    planes.push({
      id: 0,
      side,
      letter: baseLetter(index),
      name,
      kind,
      x: position.x,
      y: position.y,
      hp: hpPerBase(hpTotal, positions.length),
    });
  }
  return planes;
}

export function createMatchConfig(stage: StageDefinition, save: SaveData): MatchConfig {
  const levels = save.upgrades;
  const enemyFaction = stage.faction === 'allied' ? 'axis' : 'allied';

  const damageMultiplier = 1 + perLevel('damage', 'damage') * levels.damage;
  const unitHpMultiplier = 1 + perLevel('health', 'unitHp') * levels.health;
  // Starting supplies are fixed; the armoury's three tracks are health,
  // damage and fortification, so nothing here inflates the opening depot.
  const startSupplies = SUPPLY_START;
  const baseHp = PLAYER_BASE_HP_TOTAL + perLevel('baseHp', 'baseHp') * levels.baseHp;

  const { missionType, environment, features, supplyRateMultiplier } = stage;
  const seed = stage.id;

  // An assault is aimed at a prepared position, so the strongpoint is reinforced.
  const baseHpMultiplier = missionType === 'assault' ? ASSAULT_BASE_HP_MULTIPLIER : 1;
  // In a survival battle the enemy is the attacker and is reinforced accordingly.
  const enemySupplyBonus = missionType === 'survive_timer' ? SURVIVE_ENEMY_SUPPLY_BONUS : 1;
  const attackerSupplyBonus = missionType === 'assault' ? ASSAULT_ATTACKER_SUPPLY_BONUS : 1;
  const survivalSupplyBonus = missionType === 'survive_timer' ? SURVIVE_DEFENDER_SUPPLY_BONUS : 1;

  const playerCount = positionCountFor('player', stage.tier, missionType);
  const enemyCount = positionCountFor('enemy', stage.tier, missionType);

  // Spreading a side's hit points over several positions does not make it
  // tougher to *win* — the work is the same, it is just spread out — so only a
  // modest bonus is added for the extra ground that has to be crossed.
  const playerTotal = baseHp * (1 + BASE_HP_PER_EXTRA_BASE * (playerCount - 1));
  const enemyTotal =
    (ENEMY_BASE_HP_BASE + ENEMY_BASE_HP_PER_TIER * stage.tier) *
    baseHpMultiplier *
    (1 + BASE_HP_PER_EXTRA_BASE * (enemyCount - 1));

  const playerPositions = buildPositions('player', playerCount, seed, stage.bossName, playerTotal);
  const enemyPositions = buildPositions('enemy', enemyCount, seed, stage.bossName, enemyTotal);

  // Ids are unique across both sides; the simulation and the command channel
  // both address positions by id.
  const bases: BasePlan[] = [];
  playerPositions.forEach((plan, index) => bases.push({ ...plan, id: index + 1 }));
  const playerOffset = playerPositions.length;
  enemyPositions.forEach((plan, index) =>
    bases.push({ ...plan, id: playerOffset + index + 1 }),
  );

  const perBaseInterval =
    missionType === 'survive_timer' ? SURVIVE_ENEMY_DEPLOY_INTERVAL : ENEMY_DEPLOY_INTERVAL;

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
    // One interval per position, scaled by the count, so total enemy throughput
    // is set by the tier rather than by how many positions the sector has.
    enemyDeployInterval: perBaseInterval * enemyCount,
    damageMultiplier,
    unitHpMultiplier,
    enemyMix: enemyMixForTier(stage.tier),
    bases,
    seed: hashString(`match:${stage.id}`),
  };
}

/** Total supplies a unit costs, exposed so the HUD and AI agree. */
export function unitCost(kind: UnitKind): number {
  return UNIT_STATS[kind].cost;
}

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
