/**
 * Deterministic battlefield scatter.
 *
 * The ground plane is decorated with trees, rocks, ruins, walls and abandoned
 * kit so the field reads as a place the battle is happening *in*. Placement is a
 * pure function of the node seed and the environment: the same sector always
 * scatters the same way, which keeps the field fair and makes the layout
 * assertable.
 *
 * Two constraints shape the distribution:
 *  - **The corridor stays clear.** The band the two sides fight across is left
 *    almost empty, because props here are scenery — the simulation has no
 *    collision with them, so a wood in the middle of the killing ground would
 *    invite the player to think it is cover. Cover is what trenches are for.
 *  - **The rear areas are dense.** Both sides' own ground is cluttered with
 *    buildings, orchards and dumps, which is what makes the rear areas read as
 *    inhabited and the front as stripped.
 */

import type { Environment } from '../../data/campaignData';
import { createRng } from '../../game/rng';
import { TILE, WORLD_H, WORLD_W } from '../../game/constants';
import type { PropKind } from './contracts';

export interface ScatterProp {
  readonly kind: PropKind;
  readonly x: number;
  readonly y: number;
  /** 0..1 per-prop hash: shape variant, lean, size and colour jitter. */
  readonly variant: number;
  /** Size multiplier around 1. */
  readonly scaleHint: number;
}

interface Exclusion {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** How likely each kind is in each season, ordered by rough density. */
const MIXES: Readonly<Record<Environment, readonly (readonly [PropKind, number])[]>> = {
  standard: [
    ['tree', 0.34],
    ['bush', 0.16],
    ['rock', 0.12],
    ['wall', 0.09],
    ['fence', 0.08],
    ['ruin', 0.06],
    ['haystack', 0.05],
    ['deadTree', 0.04],
    ['post', 0.04],
    ['crate', 0.02],
  ],
  snow: [
    ['pine', 0.4],
    ['deadTree', 0.13],
    ['rock', 0.13],
    ['tree', 0.1],
    ['bush', 0.08],
    ['ruin', 0.05],
    ['post', 0.05],
    ['haystack', 0.06],
  ],
  desert: [
    ['rock', 0.26],
    ['palm', 0.2],
    ['bush', 0.15],
    ['ruin', 0.11],
    ['deadTree', 0.09],
    ['post', 0.07],
    ['crate', 0.06],
    ['wreck', 0.05],
    ['wall', 0.04],
  ],
  mud: [
    ['deadTree', 0.22],
    ['bush', 0.15],
    ['tree', 0.13],
    ['rock', 0.12],
    ['ruin', 0.11],
    ['wreck', 0.08],
    ['post', 0.08],
    ['crate', 0.06],
    ['sandbags', 0.05],
  ],
  night: [
    ['tree', 0.32],
    ['bush', 0.15],
    ['rock', 0.14],
    ['ruin', 0.11],
    ['wall', 0.09],
    ['fence', 0.08],
    ['deadTree', 0.06],
    ['post', 0.05],
  ],
};

/** The band both sides fight across: kept nearly empty of scenery. */
const CORRIDOR_MIN_X = 300;
const CORRIDOR_MAX_X = 700;

export interface ScatterInput {
  /** Node seed, so a sector always scatters identically. */
  readonly seed: number;
  readonly environment: Environment;
  /** Positions and features to keep clear of props. */
  readonly exclusions: readonly Exclusion[];
}

/**
 * Build the whole scatter list once, when a battle starts. ~400 cells are
 * considered and roughly 90 props survive, which is what the renderer draws (and
 * only the ones inside the view at that).
 */
export function createScatter(input: ScatterInput): ScatterProp[] {
  const rng = createRng(`scatter:${input.seed}`);
  const mix = MIXES[input.environment];
  const props: ScatterProp[] = [];
  const cell = TILE * 1.6;

  for (let y = 20; y < WORLD_H; y += cell) {
    for (let x = 20; x < WORLD_W; x += cell) {
      // Two octaves: a jittered grid cell plus a second hash for the roll, so
      // the scatter never shows the grid it was built on.
      const jitterX = rng.range(-cell * 0.42, cell * 0.42);
      const jitterY = rng.range(-cell * 0.42, cell * 0.42);
      const px = x + jitterX;
      const py = y + jitterY;
      if (px < 14 || px > WORLD_W - 14 || py < 14 || py > WORLD_H - 14) continue;

      const inCorridor = px > CORRIDOR_MIN_X && px < CORRIDOR_MAX_X;
      // The killing ground keeps only the odd surviving tree, and never kit.
      const chance = inCorridor ? 0.12 : 0.62;
      if (rng.next() > chance) continue;

      let blocked = false;
      for (const exclusion of input.exclusions) {
        const dx = px - exclusion.x;
        const dy = py - exclusion.y;
        if (dx * dx + dy * dy < exclusion.r * exclusion.r) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      if (inCorridor && rng.next() < 0.7) continue;

      props.push({
        kind: rng.weighted(mix.map(([kind, weight]) => ({ value: kind, weight }))),
        x: px,
        y: py,
        variant: rng.next(),
        scaleHint: rng.range(0.82, 1.22),
      });
    }
  }

  // Sort by depth once, here, so the renderer can walk the list in order and
  // only has to merge in the moving entities.
  props.sort((a, b) => a.x + a.y - (b.x + b.y));
  return props;
}
