/**
 * Static battlefield features — trenches, minefields and bridge chokepoints.
 *
 * The battlefield is a single lane, so these are x-ranges rather than areas:
 * a trench is a stretch of dugouts, a minefield is a belt of buried mines with
 * warning posts, and a bridge chokepoint is a narrow stretch where only a few
 * units per side can stand at once, which bunches an attack into a column.
 *
 * Layout is deterministic from the node id, so a stage always presents the same
 * problem and the headless harness can assert it.
 */

import type { BattlefieldFeature } from '../data/campaignData';
import type { Side } from './tugTypes';
import { createRng } from './rng';
import {
  BASE_X,
  BRIDGE_CAPACITY_PER_SIDE,
  BRIDGE_WIDTH,
  ENEMY_BASE_X,
  MINE_SPACING,
  TRENCH_WIDTH,
} from './constants';

export interface TrenchZone {
  readonly x: number;
  readonly width: number;
  /** Set once hostile troops are inside: the dugout is no longer cover. */
  overrunBy: Side | null;
}

export interface Mine {
  readonly x: number;
  exploded: boolean;
}

export interface MinefieldZone {
  readonly x: number;
  readonly width: number;
  readonly mines: Mine[];
  /** Mines still in the ground, for the warning post count in the HUD. */
  armed: number;
}

export interface BridgeZone {
  readonly x: number;
  readonly width: number;
  /** How many units of one side may occupy the span at the same time. */
  readonly capacity: number;
  occupants: Record<Side, number>;
}

export interface FeatureLayout {
  readonly trenches: TrenchZone[];
  readonly minefields: MinefieldZone[];
  readonly bridges: BridgeZone[];
}

/** Centre lines chosen so features never overlap and never touch a base. */
const TRENCH_LINES = [340, 640, 940];
const MINEFIELD_LINES = [480, 800];
const BRIDGE_LINE = 640;

export interface FeatureLayoutInput {
  readonly seed: string;
  readonly features: readonly BattlefieldFeature[];
  readonly tier: number;
}

export function createFeatureLayout(input: FeatureLayoutInput): FeatureLayout {
  const rng = createRng(`features:${input.seed}`);
  const wanted = new Set(input.features);
  const hasBridge = wanted.has('bridge_chokepoint');

  const trenches: TrenchZone[] = [];
  if (wanted.has('trenches')) {
    for (const line of TRENCH_LINES) {
      // The bridge owns the centre of the field.
      if (hasBridge && line === BRIDGE_LINE) continue;
      const centre = Math.round(line + rng.range(-24, 24));
      if (centre - TRENCH_WIDTH / 2 < BASE_X + 90) continue;
      if (centre + TRENCH_WIDTH / 2 > ENEMY_BASE_X - 90) continue;
      trenches.push({ x: centre, width: TRENCH_WIDTH, overrunBy: null });
    }
  }

  const minefields: MinefieldZone[] = [];
  if (wanted.has('minefield')) {
    for (const line of MINEFIELD_LINES) {
      const centre = Math.round(line + rng.range(-18, 18));
      if (centre - 80 < BASE_X + 90 || centre + 80 > ENEMY_BASE_X - 90) continue;
      // Deeper campaign tiers bury more mines per belt.
      const spacing = Math.max(18, MINE_SPACING - input.tier);
      const count = Math.floor((BRIDGE_WIDTH + 30) / spacing);
      const half = ((count - 1) * spacing) / 2;
      const mines: Mine[] = [];
      for (let i = 0; i < count; i += 1) {
        mines.push({ x: Math.round(centre - half + i * spacing), exploded: false });
      }
      minefields.push({
        x: centre,
        width: Math.round(count * spacing),
        mines,
        armed: mines.length,
      });
    }
  }

  const bridges: BridgeZone[] = [];
  if (hasBridge) {
    bridges.push({
      x: BRIDGE_LINE,
      width: BRIDGE_WIDTH,
      capacity: BRIDGE_CAPACITY_PER_SIDE,
      occupants: { player: 0, enemy: 0 },
    });
  }

  return { trenches, minefields, bridges };
}

/** The trench a stopped unit of `kind` is standing in, if any. */
export function trenchAt(layout: FeatureLayout, x: number): TrenchZone | null {
  for (const trench of layout.trenches) {
    if (x >= trench.x - trench.width / 2 && x <= trench.x + trench.width / 2) return trench;
  }
  return null;
}

/** The bridge a unit is standing on, if any. */
export function bridgeAt(layout: FeatureLayout, x: number): BridgeZone | null {
  for (const bridge of layout.bridges) {
    if (x >= bridge.x - bridge.width / 2 && x <= bridge.x + bridge.width / 2) return bridge;
  }
  return null;
}

/** Recompute how many units of each side currently hold each span. */
export function recountBridges(
  layout: FeatureLayout,
  units: readonly { side: Side; x: number }[],
): void {
  for (const bridge of layout.bridges) {
    bridge.occupants.player = 0;
    bridge.occupants.enemy = 0;
  }
  for (const unit of units) {
    const bridge = bridgeAt(layout, unit.x);
    if (bridge) bridge.occupants[unit.side] += 1;
  }
}
