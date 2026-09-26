/**
 * The art contracts.
 *
 * These interfaces are the seam between the renderer (which owns the camera,
 * the depth sort and the simulation state) and the artwork modules (which own
 * every pixel of terrain, structure, prop and figure). The renderer computes a
 * **screen anchor in CSS px** for each thing it draws and hands it over with the
 * current world→screen `scale`; the art module draws in a local frame around
 * that anchor and never touches the camera.
 *
 * Local frames
 * ------------
 * - **Structures, props and figures** are drawn in *billboard* space: origin at
 *   the anchor (the object's feet/ground contact), `-y` is up, `+x` is to the
 *   right. Right and 2:1 iso geometry come from `isoBox()` / `isoPoint()`, which
 *   return coordinates already in that frame.
 * - **Ground and flat features** (terrain tiles, roads, trench lines, mine
 *   belts, scorch marks) are drawn under `applyIso(ctx)` in *world* coordinates.
 */

import type { Environment } from '../../data/campaignData';
import type { Faction } from '../../core/types';
import type { BaseKind, UnitKind } from '../../game/units';

export interface DrawBase {
  /** Screen anchor in CSS px (device-pixel-ratio transform already applied). */
  readonly x: number;
  readonly y: number;
  /** CSS px per world unit at the current camera. */
  readonly scale: number;
  /** Seconds since the battle started — drives every idle animation. */
  readonly time: number;
  readonly environment: Environment;
}

export interface UnitDrawOptions extends DrawBase {
  readonly kind: UnitKind;
  readonly faction: Faction;
  readonly tier: number;
  /** -1 when the unit faces the iso-left, +1 the iso-right. */
  readonly facing: 1 | -1;
  /** Unit heading in world axes, normalised. `+x` is toward the enemy. */
  readonly headingX: number;
  readonly headingY: number;
  /** 0..1 through the walk cycle; kept continuous across strides. */
  readonly phase: number;
  /** 0..1 progress across the current stride — 0 at footfall. */
  readonly stride: number;
  readonly moving: boolean;
  readonly dugIn: boolean;
  readonly hpFraction: number;
  /** Scale-in on spawn, 0..1. */
  readonly spawn: number;
  /** 0..1 barrel kick just after firing. */
  readonly recoil: number;
  /** 0..1 how hard the unit was last shoved, leaning it off balance. */
  readonly shoved: number;
  readonly illuminated: boolean;
  readonly suppressed: boolean;
  readonly staggering: boolean;
  /** Draw the drop shadow (false while the unit is mid-air). */
  readonly shadow: boolean;
}

export interface CorpseDrawOptions extends DrawBase {
  readonly kind: UnitKind;
  readonly faction: Faction;
  readonly tier: number;
  /** -1 or +1: the direction the body toppled in. */
  readonly topple: 1 | -1;
  /** 0..1 through the fall; 1 is flat on the ground. */
  readonly fallen: number;
  /** 1 → fresh, 0 → about to be removed. */
  readonly fade: number;
}


export interface StructureDrawOptions extends DrawBase {
  readonly kind: BaseKind;
  readonly faction: Faction;
  readonly tier: number;
  readonly hpFraction: number;
  readonly destroyed: boolean;
  /** 0..1 muzzle flash of this base's own defensive gun. */
  readonly flash: number;
  /** 0..1 "just hit" flinch. */
  readonly hit: number;
  /** 0..1 smoke pouring out of it, from accumulated damage. */
  readonly smoke: number;
  /** True when this base is the player's selected launch pad. */
  readonly selected: boolean;
  /** True when this base is the currently designated objective. */
  readonly targeted: boolean;
}

export type PropKind =
  | 'tree'
  | 'pine'
  | 'palm'
  | 'deadTree'
  | 'rock'
  | 'bush'
  | 'ruin'
  | 'wall'
  | 'fence'
  | 'sandbags'
  | 'crate'
  | 'wreck'
  | 'post'
  | 'haystack';

export interface PropDrawOptions extends DrawBase {
  readonly kind: PropKind;
  /** 0..1 deterministic variation, so no two props of a kind look identical. */
  readonly variant: number;
  readonly scaleHint: number;
}

export interface TerrainTileOptions extends DrawBase {
  readonly tx: number;
  readonly ty: number;
  /** Tile centre in projected px (already includes camera zoom). */
  readonly cx: number;
  readonly cy: number;
  /** Tile side in projected px. */
  readonly size: number;
  /** 0..1 deterministic per-tile variation. */
  readonly variant: number;
  /** 0..1 dirt/road weight from the corridor mask. */
  readonly wear: number;
  readonly edge: 'inner' | 'north' | 'south' | 'east' | 'west' | 'corner';
}

/** The slice of the world the camera can see, in world coordinates. */
export interface WorldView {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly environment: Environment;
  readonly time: number;
  /** Deterministic layout seed (the node id hashed). */
  readonly seed: number;
}

/**
 * The terrain features a battle was laid out with, as the renderer sees them:
 * axis-aligned rectangles on the ground plane. The simulation's own layout is
 * structurally compatible with this.
 */
export interface GroundFeaturesView {
  readonly trenches: readonly {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly overrunBy: 'player' | 'enemy' | null;
  }[];
  readonly minefields: readonly {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly armed: number;
    readonly mines: readonly { readonly x: number; readonly y: number; readonly exploded: boolean }[];
  }[];
  readonly bridges: readonly {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly capacity: number;
    readonly occupants: { readonly player: number; readonly enemy: number };
  }[];
}

