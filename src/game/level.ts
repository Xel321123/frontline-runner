/**
 * Level layout generation.
 *
 * Pure and deterministic: the same campaign node always lays out the same
 * course (seeded from the node id), so difficulty is fair and a run can be
 * replayed or simulated headlessly.
 *
 * Density ramps with progress through the sector, and higher campaign tiers
 * face more hazards — the node's `tier` comes from the character-pack tier the
 * campaign database assigned it.
 */

import {
  BOSS_HP_MULTIPLIER,
  BOSS_SCREEN_X,
  CRATE_SIZE,
  CRATE_VALUE_MAX_INITIAL,
  GATE_BANDS,
  GATE_INTERVAL_PX,
  INFANTRY_RADIUS,
  LEVEL_LENGTH_BASE,
  LEVEL_LENGTH_PER_TIER,
  MINE_RADIUS,
  VIEW_HEIGHT,
  WIRE_LENGTH_MAX,
  WIRE_LENGTH_MIN,
} from './constants';
import { createRng } from './rng';
import type { GateOp, LevelPlan, Spawn, SpawnKind } from './types';

export interface LevelPlanInput {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly year: string;
  readonly theater: string;
  readonly tier: number;
  readonly bossName: string;
  readonly bossHp: number;
}

/** Where the first obstacle can appear (the player gets a run-up). */
const RUN_UP = 900;
/** Keep the last stretch clear so the bunker approach is readable. */
const BOSS_CLEARANCE = 1100;

const GATE_GOOD_OPS: readonly GateOp[] = ['add', 'mul'];
const GATE_BAD_OPS: readonly GateOp[] = ['sub', 'div'];

function clampY(y: number, halfHeight: number): number {
  const min = halfHeight + 24;
  const max = VIEW_HEIGHT - halfHeight - 24;
  return Math.min(max, Math.max(min, y));
}

/**
 * A gate event is a pair of stacked bands with a safe gap between them: the
 * squad's Y decides which operation it passes through, and either band can be
 * shot to improve it. One band is usually generous and the other punitive.
 */
function gatePair(x: number, rng: ReturnType<typeof createRng>, tier: number): Spawn[] {
  const scale = 1 + tier * 0.1;
  const goodOp = rng.pick(GATE_GOOD_OPS);
  const badOp = rng.pick(GATE_BAD_OPS);

  const valueFor = (op: GateOp): number => {
    switch (op) {
      case 'add':
        return Math.round(rng.range(4, 9) * scale);
      case 'mul':
        return rng.chance(0.25) ? 3 : 2;
      case 'sub':
        return Math.round(rng.range(3, 8) * scale);
      case 'div':
        return rng.chance(0.4) ? 3 : 2;
    }
  };

  // Occasionally both bands are good, so the choice is about magnitude.
  const bothGood = rng.chance(0.18);
  const secondOp = bothGood ? rng.pick(GATE_GOOD_OPS) : badOp;
  const values: [number, number] = [valueFor(goodOp), valueFor(secondOp)];
  const swap = rng.chance(0.5);

  return GATE_BANDS.map((band, index) => {
    const op = index === 0 ? goodOp : secondOp;
    const value = index === 0 ? values[0] : values[1];
    const ordered = swap ? (index === 0 ? values[1] : values[0]) : value;
    const orderedOp = swap ? (index === 0 ? secondOp : goodOp) : op;
    return { kind: 'gate' as const, x, op: orderedOp, value: ordered, y: band.y, height: band.height };
  });
}

/**
 * Named vertical lanes. Hazards are placed on lanes rather than at random
 * heights so formations are readable and a safe lane always exists.
 */
const LANES: readonly number[] = [120, 250, 380, 510, 640];

function pickLanes(rng: ReturnType<typeof createRng>, count: number): number[] {
  const pool = [...LANES];
  const chosen: number[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const index = rng.int(0, pool.length - 1);
    const lane = pool.splice(index, 1)[0];
    if (lane !== undefined) chosen.push(lane);
  }
  return chosen;
}

function makeSpawn(
  kind: SpawnKind,
  x: number,
  laneY: number,
  rng: ReturnType<typeof createRng>,
  tier: number,
): Spawn {
  switch (kind) {
    case 'crate':
      return {
        kind: 'crate',
        x,
        y: clampY(laneY, CRATE_SIZE / 2),
        value: rng.int(1, CRATE_VALUE_MAX_INITIAL + Math.min(2, Math.floor(tier / 4))),
      };
    case 'mine':
      return { kind: 'mine', x, y: clampY(laneY, MINE_RADIUS) };
    case 'wire': {
      const height = rng.range(150, 280);
      return {
        kind: 'wire',
        x,
        y: clampY(laneY, height / 2),
        height,
        length: rng.range(WIRE_LENGTH_MIN, WIRE_LENGTH_MAX) * (1 + tier * 0.02),
      };
    }
    case 'infantry':
      return {
        kind: 'infantry',
        x,
        y: clampY(laneY, INFANTRY_RADIUS),
        speed: -(30 + rng.range(0, 45) + tier * 2),
        hp: 34 + tier * 4,
      };
    case 'gate':
      // Gates span bands, not lanes — see gatePair().
      return {
        kind: 'gate',
        x,
        op: 'add',
        value: 1,
        y: laneY,
        height: 200,
      };
  }
}

export function createLevelPlan(input: LevelPlanInput): LevelPlan {
  const rng = createRng(`frontline:${input.nodeId}`);
  const length = LEVEL_LENGTH_BASE + input.tier * LEVEL_LENGTH_PER_TIER;
  const spawns: Spawn[] = [];

  const tierHazardScale = 0.85 + input.tier * 0.07;
  // Higher tiers also hand out fewer supplies, so the squad grows more slowly.
  const tierSupplyScale = 1 + input.tier * 0.05;
  let x = RUN_UP;
  let nextGateX = RUN_UP + rng.range(900, 1500);

  while (x < length - BOSS_CLEARANCE) {
    const progress = x / length;

    if (x >= nextGateX) {
      spawns.push(...gatePair(x, rng, input.tier));
      nextGateX = x + GATE_INTERVAL_PX + rng.range(0, 900);
      x += 420 + rng.range(0, 340) * (1 - 0.3 * progress);
      continue;
    }

    // Early sector: supplies. Later: hazards, weighted by tier.
    const weights = [
      { value: 'crate' as const, weight: (2.2 - 1.1 * progress) / tierSupplyScale },
      { value: 'mine' as const, weight: (0.9 + 2.3 * progress) * tierHazardScale },
      { value: 'wire' as const, weight: (0.7 + 1.9 * progress) * tierHazardScale },
      { value: 'infantry' as const, weight: (0.8 + 2.1 * progress) * tierHazardScale },
    ];

    // Formations: later sectors stack two or three threats on separate lanes,
    // which is what turns "react to the nearest thing" into a real choice.
    const clusterChance = 0.18 + 0.42 * progress;
    const count = rng.chance(clusterChance) ? rng.int(2, 3) : 1;
    const lanes = pickLanes(rng, count);

    lanes.forEach((lane, index) => {
      const itemX = x + index * rng.range(85, 175);
      // Nothing may land inside the boss arena: scrolling has stopped there, so
      // a late obstacle would sit frozen in front of the squad.
      if (itemX >= length - BOSS_CLEARANCE) return;
      const kind = rng.weighted(weights);
      spawns.push(makeSpawn(kind, itemX, lane, rng, input.tier));
    });

    // Obstacles get tighter as the sector progresses.
    x += (130 + rng.range(0, 110)) * (1 - 0.3 * progress) + count * 45;
  }

  // Sort by x so the renderer and simulation can walk them in order.
  spawns.sort((a, b) => a.x - b.x);

  return {
    nodeId: input.nodeId,
    nodeName: input.nodeName,
    year: input.year,
    theater: input.theater,
    tier: input.tier,
    spawns,
    bunkerX: length,
    // Scrolling stops with the bunker parked at BOSS_SCREEN_X, so the advance
    // phase covers this much ground.
    totalScroll: length - BOSS_SCREEN_X,
    bossName: input.bossName,
    bossMaxHp: Math.round(input.bossHp * BOSS_HP_MULTIPLIER),
  };
}

/** Distance the world scrolls before the bunker fight begins. */
export function scrollDistanceFor(plan: LevelPlan): number {
  return plan.totalScroll;
}
