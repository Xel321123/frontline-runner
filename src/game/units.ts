/**
 * Unit definitions for the tug-of-war battlefield.
 *
 * Four archetypes per side, deliberately distinct in how they fight rather than
 * just in numbers: a long-range rifleman that stops early, a fast SMG that has
 * to close the distance, an MG that digs in and suppresses, and a slow tank with
 * an area-of-effect cannon. Pure data — no DOM, no imports.
 */

export type UnitKind = 'rifleman' | 'smg' | 'mg' | 'tank';

export type ProjectileKind = 'bullet' | 'shell';

export interface UnitStats {
  readonly kind: UnitKind;
  readonly name: string;
  /** Supplies spent to field one. */
  readonly cost: number;
  /** Seconds before this type can be deployed again. */
  readonly deployCooldown: number;
  readonly hp: number;
  /** Flat damage subtracted from every incoming hit (tanks shrug off rifles). */
  readonly armor: number;
  /** Advance speed, px/s. */
  readonly speed: number;
  /** Stops to fight once a hostile is this close, px. */
  readonly range: number;
  /** Shots per second while engaged. */
  readonly fireRate: number;
  readonly damage: number;
  readonly projectile: ProjectileKind;
  /** Collision half-width, px. */
  readonly radius: number;
  /** Drawn height, px (also sets the size of the drop shadow). */
  readonly height: number;
  /** Fraction of incoming damage ignored once dug in (MG only). */
  readonly dugInResist?: number;
  /** Seconds of digging before the sandbags are up (MG only). */
  readonly digTime?: number;
  /** Movement multiplier applied to units this one hits (MG suppression). */
  readonly suppression?: number;
  /** Blast radius for shells, px. */
  readonly blast?: number;
  /** War bonds paid to the opposing side when this unit dies. */
  readonly bondDrop: number;
  /** Minimum gap kept behind the unit ahead, px. */
  readonly spacing: number;
  /** Barrels firing per volley (an MG sprays, a tank does not). */
  readonly roundsPerVolley: number;
}

export const UNIT_STATS: Readonly<Record<UnitKind, UnitStats>> = Object.freeze({
  rifleman: {
    kind: 'rifleman',
    name: 'Rifleman',
    cost: 20,
    deployCooldown: 0.3,
    hp: 62,
    armor: 0,
    speed: 60,
    range: 300,
    fireRate: 1.15,
    damage: 15,
    projectile: 'bullet',
    radius: 10,
    height: 34,
    bondDrop: 5,
    spacing: 28,
    roundsPerVolley: 1,
  },
  smg: {
    kind: 'smg',
    name: 'SMG Assault',
    cost: 35,
    deployCooldown: 0.5,
    hp: 74,
    armor: 0,
    speed: 95,
    range: 140,
    fireRate: 6.5,
    damage: 6,
    projectile: 'bullet',
    radius: 10,
    height: 34,
    bondDrop: 9,
    spacing: 27,
    roundsPerVolley: 1,
  },
  mg: {
    kind: 'mg',
    name: 'MG Gunner',
    cost: 55,
    deployCooldown: 1.0,
    hp: 96,
    armor: 1,
    speed: 42,
    range: 270,
    fireRate: 5.5,
    damage: 7,
    projectile: 'bullet',
    radius: 11,
    height: 32,
    dugInResist: 0.35,
    digTime: 1.2,
    suppression: 0.45,
    bondDrop: 15,
    spacing: 34,
    roundsPerVolley: 1,
  },
  tank: {
    kind: 'tank',
    name: 'Tank',
    cost: 140,
    deployCooldown: 2.5,
    hp: 430,
    armor: 6,
    speed: 34,
    range: 250,
    fireRate: 0.35,
    damage: 85,
    projectile: 'shell',
    radius: 27,
    height: 46,
    blast: 78,
    bondDrop: 45,
    spacing: 76,
    roundsPerVolley: 1,
  },
});

/** Deployment bar order, cheapest first — matches the HUD slot layout. */
export const UNIT_ORDER: readonly UnitKind[] = ['rifleman', 'smg', 'mg', 'tank'];

export function unitStats(kind: UnitKind): UnitStats {
  return UNIT_STATS[kind];
}
