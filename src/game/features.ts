/**
 * Static battlefield features — trenches, minefields and bridge chokepoints —
 * as **areas on the ground plane** rather than stretches of a single lane.
 *
 * A trench line is a dug-out band lying across the direction of advance, so a
 * unit holding it is covered from anything coming down the field. A mine belt is
 * a rectangle of buried mines that takes whoever crosses it first, from either
 * side. A bridge span is the one place where the river can be crossed at all,
 * so everything funnels through a narrow band and only so many units of one side
 * fit on the deck.
 *
 * Layout is deterministic from the node id, so a sector always presents the same
 * problem and the headless harness can assert it.
 */

import type { BattlefieldFeature } from '../data/campaignData';
import type { Side } from './tugTypes';
import { createRng } from './rng';
import {
  BRIDGE_CAPACITY_PER_SIDE,
  BRIDGE_WIDTH,
  MINE_SPACING,
  WORLD_H,
  WORLD_W,
} from './constants';

/** An axis-aligned rectangle on the ground plane. */
export interface PlaneRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TrenchZone extends PlaneRect {
  /** Set once hostile troops are inside: the dugout is no longer cover. */
  overrunBy: Side | null;
}

export interface Mine {
  readonly x: number;
  readonly y: number;
  exploded: boolean;
}

export interface MinefieldZone extends PlaneRect {
  readonly mines: Mine[];
  /** Mines still in the ground, for the warning post count in the HUD. */
  armed: number;
}

export interface BridgeZone extends PlaneRect {
  /** How many units of one side may occupy the span at the same time. */
  readonly capacity: number;
  occupants: Record<Side, number>;
}

export interface FeatureLayout {
  readonly trenches: TrenchZone[];
  readonly minefields: MinefieldZone[];
  readonly bridges: BridgeZone[];
  /**
   * The river the bridge crosses: a band of impassable ground at a fixed x.
   * Units outside a span's y-range are held on the bank, which is what turns an
   * attack into a column at a crossing.
   */
  readonly water: readonly PlaneRect[];
}

/** Centre lines, chosen so features never overlap and never touch a base. */
const TRENCH_LINES = [372, 520, 668];
/** Mines lie in belts crossing the corridor. */
const MINEFIELD_LINES = [300, 596];
/** The crossing owns the centre of the field. */
const BRIDGE_LINE = 484;
/** A trench line is a band this deep (in y) lying across the advance. */
const TRENCH_DEPTH = 236;
const TRENCH_WIDTH_X = 62;
/** A mine belt crosses the corridor and is this wide in x. */
const MINEFIELD_WIDTH_X = 84;
const MINEFIELD_DEPTH = 200;
/** The river band the bridge spans. */
const RIVER_WIDTH = 58;

export function rectContains(rect: PlaneRect, x: number, y: number): boolean {
  return (
    x >= rect.x - rect.w / 2 &&
    x <= rect.x + rect.w / 2 &&
    y >= rect.y - rect.h / 2 &&
    y <= rect.y + rect.h / 2
  );
}

export interface FeatureLayoutInput {
  readonly seed: string;
  readonly features: readonly BattlefieldFeature[];
  readonly tier: number;
}

export function createFeatureLayout(input: FeatureLayoutInput): FeatureLayout {
  const rng = createRng(`features:${input.seed}`);
  const wanted = new Set(input.features);
  const hasBridge = wanted.has('bridge_chokepoint');
  const corridorMid = WORLD_H / 2;

  const trenches: TrenchZone[] = [];
  if (wanted.has('trenches')) {
    for (const line of TRENCH_LINES) {
      // The crossing owns the centre of the field.
      if (hasBridge && line === BRIDGE_LINE) continue;
      const centreX = Math.round(line + rng.range(-20, 20));
      // Two lines of dugouts, staggered in depth, so holding the line means
      // holding a front and a support trench rather than one thin strip.
      const offsets = line === TRENCH_LINES[1] ? [-76, 78] : [0];
      for (const offset of offsets) {
        const centreY = Math.round(corridorMid + offset + rng.range(-14, 14));
        const h = Math.min(TRENCH_DEPTH, WORLD_H - 120);
        if (centreY - h / 2 < 40 || centreY + h / 2 > WORLD_H - 40) continue;
        trenches.push({
          x: centreX,
          y: centreY,
          w: TRENCH_WIDTH_X,
          h,
          overrunBy: null,
        });
      }
    }
  }

  const minefields: MinefieldZone[] = [];
  if (wanted.has('minefield')) {
    for (const line of MINEFIELD_LINES) {
      const centreX = Math.round(line + rng.range(-16, 16));
      const centreY = Math.round(corridorMid + rng.range(-30, 30));
      const h = Math.min(MINEFIELD_DEPTH, WORLD_H - 160);
      // Deeper campaign tiers bury more mines per belt.
      const spacing = Math.max(20, MINE_SPACING - input.tier);
      const columns = 3;
      const rows = Math.floor(h / spacing);
      const mines: Mine[] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const jitterX = rng.range(-spacing * 0.4, spacing * 0.4);
          const jitterY = rng.range(-spacing * 0.4, spacing * 0.4);
          mines.push({
            x: Math.round(centreX - MINEFIELD_WIDTH_X / 2 + (column + 0.5) * (MINEFIELD_WIDTH_X / columns) + jitterX),
            y: Math.round(centreY - h / 2 + (row + 0.5) * spacing + jitterY),
            exploded: false,
          });
        }
      }
      minefields.push({
        x: centreX,
        y: centreY,
        w: MINEFIELD_WIDTH_X,
        h,
        mines,
        armed: mines.length,
      });
    }
  }

  const bridges: BridgeZone[] = [];
  const water: PlaneRect[] = [];
  if (hasBridge) {
    const centreX = BRIDGE_LINE + Math.round(rng.range(-10, 10));
    // The river runs the whole depth of the field; the span is the only way over.
    water.push({ x: centreX, y: WORLD_H / 2, w: RIVER_WIDTH, h: WORLD_H });
    bridges.push({
      x: centreX,
      y: corridorMid,
      w: RIVER_WIDTH + 22,
      h: BRIDGE_WIDTH,
      capacity: BRIDGE_CAPACITY_PER_SIDE,
      occupants: { player: 0, enemy: 0 },
    });
  }

  return { trenches, minefields, bridges, water };
}

/** The trench a stopped unit is standing in, if any. */
export function trenchAt(layout: FeatureLayout, x: number, y: number): TrenchZone | null {
  for (const trench of layout.trenches) {
    if (rectContains(trench, x, y)) return trench;
  }
  return null;
}

/** The span a unit is standing on, if any. */
export function bridgeAt(layout: FeatureLayout, x: number, y: number): BridgeZone | null {
  for (const bridge of layout.bridges) {
    if (rectContains(bridge, x, y)) return bridge;
  }
  return null;
}

/** True when a point is in the river and not on a span. */
export function inWater(layout: FeatureLayout, x: number, y: number): boolean {
  if (layout.water.length === 0) return false;
  for (const band of layout.water) {
    if (!rectContains(band, x, y)) continue;
    if (bridgeAt(layout, x, y)) return false;
    return true;
  }
  return false;
}

/**
 * The span this unit should head for when the river is in its way: whichever
 * bridge is nearest on the field. Returns null when there is no crossing.
 */
export function nearestBridge(layout: FeatureLayout, x: number, y: number): BridgeZone | null {
  let best: BridgeZone | null = null;
  let bestDistance = Infinity;
  for (const bridge of layout.bridges) {
    const dx = bridge.x - x;
    const dy = bridge.y - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = bridge;
    }
  }
  return best;
}

/** Recompute how many units of each side currently hold each span. */
export function recountBridges(
  layout: FeatureLayout,
  units: readonly { side: Side; x: number; y: number }[],
): void {
  for (const bridge of layout.bridges) {
    bridge.occupants.player = 0;
    bridge.occupants.enemy = 0;
  }
  for (const unit of units) {
    const bridge = bridgeAt(layout, unit.x, unit.y);
    if (bridge) bridge.occupants[unit.side] += 1;
  }
}

/** World extents used by the layout so nothing is placed off the plane. */
export const WORLD_BOUNDS = { w: WORLD_W, h: WORLD_H } as const;
