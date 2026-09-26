/**
 * Unit and base definitions for the isometric battlefield.
 *
 * Four archetypes per side, deliberately distinct in how they fight rather than
 * just in numbers: a long-range rifleman that stops early, a fast SMG that has
 * to close the distance, an MG that digs in and suppresses, and a slow tank with
 * an area-of-effect cannon. Pure data — no DOM, no imports.
 *
 * Ranges and blast radii are sized against the 960x560 world plane: a rifleman
 * covers roughly a fifth of the field, an SMG a tenth. `launchCooldown` is the
 * wait a **base** takes after launching this kind — the v2 pacing rule is per
 * base, not global, so each launch pad has its own timings.
 */

export type UnitKind = 'rifleman' | 'smg' | 'mg' | 'tank';

export type ProjectileKind = 'bullet' | 'shell';

/** What a base looks like and what it is called on the field. */
export type BaseKind = 'hq' | 'stronghold' | 'depot' | 'bunker' | 'outpost';

export interface UnitStats {
  readonly kind: UnitKind;
  readonly name: string;
  /** Supplies spent to field one. */
  readonly cost: number;
  /**
   * Seconds the launching base must wait before it may launch again. A base has
   * one launch timer for all kinds, so this is the per-base pacing rule.
   */
  readonly launchCooldown: number;
  readonly hp: number;
  /** Flat damage subtracted from every incoming hit (tanks shrug off rifles). */
  readonly armor: number;
  /** Advance speed, world units/s. */
  readonly speed: number;
  /** Stops to fight once a hostile is this close, world units. */
  readonly range: number;
  /** Shots per second while engaged. */
  readonly fireRate: number;
  readonly damage: number;
  readonly projectile: ProjectileKind;
  /** Collision radius, world units. */
  readonly radius: number;
  /** Drawn height, world units (also the size of the drop shadow). */
  readonly height: number;
  /** How fast the figure turns to face its heading, radians/s. */
  readonly turnRate: number;
  /** Fraction of incoming damage ignored once dug in (MG only). */
  readonly dugInResist?: number;
  /** Seconds of digging before the sandbags are up (MG only). */
  readonly digTime?: number;
  /** Movement multiplier applied to units this one hits (MG suppression). */
  readonly suppression?: number;
  /** Blast radius for shells, world units. */
  readonly blast?: number;
  /** War bonds paid to the opposing side when this unit dies. */
  readonly bondDrop: number;
  /** Minimum gap kept from another unit of the same side, world units. */
  readonly spacing: number;
  /** Barrels firing per volley (an MG sprays, a tank does not). */
  readonly roundsPerVolley: number;
}

export const UNIT_STATS: Readonly<Record<UnitKind, UnitStats>> = Object.freeze({
  rifleman: {
    kind: 'rifleman',
    name: 'Rifleman',
    cost: 20,
    launchCooldown: 1.5,
    hp: 62,
    armor: 0,
    speed: 62,
    range: 178,
    fireRate: 1.15,
    damage: 15,
    projectile: 'bullet',
    radius: 10,
    height: 34,
    turnRate: 7,
    bondDrop: 5,
    spacing: 30,
    roundsPerVolley: 1,
  },
  smg: {
    kind: 'smg',
    name: 'SMG Assault',
    cost: 35,
    launchCooldown: 2.4,
    hp: 74,
    armor: 0,
    speed: 96,
    range: 92,
    fireRate: 6.5,
    damage: 6,
    projectile: 'bullet',
    radius: 10,
    height: 34,
    turnRate: 9,
    bondDrop: 9,
    spacing: 29,
    roundsPerVolley: 1,
  },
  mg: {
    kind: 'mg',
    name: 'MG Gunner',
    cost: 55,
    launchCooldown: 3.6,
    hp: 96,
    armor: 1,
    speed: 42,
    range: 162,
    fireRate: 5.5,
    damage: 7,
    projectile: 'bullet',
    radius: 11,
    height: 32,
    turnRate: 5,
    dugInResist: 0.35,
    digTime: 1.2,
    suppression: 0.45,
    bondDrop: 15,
    spacing: 36,
    roundsPerVolley: 1,
  },
  tank: {
    kind: 'tank',
    name: 'Tank',
    cost: 140,
    launchCooldown: 8,
    hp: 430,
    armor: 6,
    speed: 36,
    range: 152,
    fireRate: 0.35,
    damage: 85,
    projectile: 'shell',
    radius: 24,
    height: 46,
    turnRate: 2.4,
    blast: 48,
    bondDrop: 45,
    spacing: 74,
    roundsPerVolley: 1,
  },
});

/** Deployment bar order, cheapest first — matches the HUD slot layout. */
export const UNIT_ORDER: readonly UnitKind[] = ['rifleman', 'smg', 'mg', 'tank'];

export function unitStats(kind: UnitKind): UnitStats {
  return UNIT_STATS[kind];
}

/** Bar order for the deployment cards. */
export const DEPLOY_ORDER: readonly UnitKind[] = ['rifleman', 'smg', 'mg', 'tank'];

/** Keyboard shortcut label for a unit: its position in the bar. */
export function hotkeyFor(kind: UnitKind): string {
  return String(DEPLOY_ORDER.indexOf(kind) + 1);
}

/** Reverse of `hotkeyFor`, for the '1'..'4' keys. */
export function kindForHotkey(key: string): UnitKind | null {
  const index = Number(key);
  if (!Number.isInteger(index) || index < 1 || index > DEPLOY_ORDER.length) return null;
  return DEPLOY_ORDER[index - 1] ?? null;
}

/** Cycle helper for the 'next base' / 'next objective' keys. */
export function cycle<T>(items: readonly T[], current: number, step: number): number {
  if (items.length === 0) return 0;
  return (current + step + items.length) % items.length;
}

/** Display letters for the 1st..5th base of a side: A, B, C, D, E. */
export const BASE_LETTERS: readonly string[] = ['A', 'B', 'C', 'D', 'E'];

export function baseLetter(index: number): string {
  return BASE_LETTERS[index] ?? String(index + 1);
}

/** A human label for a base kind, used in the HUD and the result splash. */
export function baseKindLabel(kind: BaseKind): string {
  switch (kind) {
    case 'hq':
      return 'field HQ';
    case 'stronghold':
      return 'stronghold';
    case 'depot':
      return 'supply depot';
    case 'bunker':
      return 'bunker';
    default:
      return 'outpost';
  }
}
