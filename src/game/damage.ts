/**
 * Incoming-damage maths, as a pure function.
 *
 * Kept out of the simulation so it can be asserted directly: armour, a dug-in
 * machine-gun team, a trench parapet and a searchlight silhouette are four
 * separate multipliers, and the order they stack in is worth being able to read
 * in one place.
 */

import { MIN_DAMAGE_FRACTION, TRENCH_DAMAGE_MULTIPLIER } from './constants';

export interface DamageContext {
  /** Flat armour points that subtract from the hit. */
  readonly armor: number;
  /** Behind sandbags, from a machine-gun team digging in. */
  readonly dugIn: boolean;
  /** Fraction of damage a dug-in team ignores. */
  readonly dugInResist?: number;
  /** Standing in a trench line (infantry only, and only while stopped). */
  readonly trenchCover: boolean;
  /** Caught in a searchlight beam at night. */
  readonly illuminated: boolean;
  /** How much extra damage a lit silhouette takes. */
  readonly illuminatedDamageMultiplier: number;
}

export function incomingDamage(base: number, context: DamageContext): number {
  // Armour subtracts damage but never grants immunity: heavy plating should
  // blunt small arms, not make a tank untouchable by an infantry line.
  let applied = Math.max(base * MIN_DAMAGE_FRACTION, base - context.armor);
  if (context.dugIn) applied *= 1 - (context.dugInResist ?? 0);
  if (context.trenchCover) applied *= TRENCH_DAMAGE_MULTIPLIER;
  if (context.illuminated) applied *= context.illuminatedDamageMultiplier;
  return applied;
}
