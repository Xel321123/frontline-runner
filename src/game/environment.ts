/**
 * Environmental rules.
 *
 * One table shared by the simulation (which applies the modifiers) and the
 * briefing/map UI (which explains them), so a stage can never advertise a
 * weather effect the battle does not actually apply.
 *
 * The numbers here are the mutators from the design brief:
 *   snow   — white-out ground, falling snow, −35% movement for all ground units
 *   desert — sandstorm haze, −50% maximum weapon engagement range
 *   mud    — heavy going: tank supply cost +50%, vehicles traverse 40% slower
 *   night  — darkness with searchlight sweeps; lit units take +50% damage
 */

import type { Environment } from '../data/campaignData';

export interface EnvironmentRules {
  readonly id: Environment;
  readonly label: string;
  /** One line for the briefing modal. */
  readonly summary: string;
  /** Terse version for the in-battle HUD. */
  readonly hint: string;
  /** Multiplier on every ground unit's movement speed. */
  readonly moveSpeedMultiplier: number;
  /** Extra multiplier applied to vehicles on top of `moveSpeedMultiplier`. */
  readonly vehicleSpeedMultiplier: number;
  /** Multiplier on weapon engagement ranges (sandstorm visibility). */
  readonly rangeMultiplier: number;
  /** Multiplier on the supply cost of armour (mud). */
  readonly tankCostMultiplier: number;
  /** Damage multiplier for units caught in a searchlight beam (night). */
  readonly illuminatedDamageMultiplier: number;
  /** True when the scene needs a searchlight sweep. */
  readonly searchlights: boolean;
  /** True when snow is falling. */
  readonly snowfall: boolean;
  /** True when a sandstorm is blowing. */
  readonly sandstorm: boolean;
  /** Ground palette family, used by the terrain painter. */
  readonly ground: 'temperate' | 'snow' | 'desert' | 'mud' | 'night';
}

export const ENVIRONMENTS: Readonly<Record<Environment, EnvironmentRules>> = {
  standard: {
    id: 'standard',
    hint: 'no modifiers',
    label: 'Temperate',
    summary: 'Clear ground and ordinary visibility — no modifiers.',
    moveSpeedMultiplier: 1,
    vehicleSpeedMultiplier: 1,
    rangeMultiplier: 1,
    tankCostMultiplier: 1,
    illuminatedDamageMultiplier: 1,
    searchlights: false,
    snowfall: false,
    sandstorm: false,
    ground: 'temperate',
  },
  snow: {
    id: 'snow',
    hint: 'snow −35% move',
    label: 'Snow',
    summary: 'Snow-covered ground and falling snow: all ground units move 35% slower.',
    moveSpeedMultiplier: 0.65,
    vehicleSpeedMultiplier: 1,
    rangeMultiplier: 1,
    tankCostMultiplier: 1,
    illuminatedDamageMultiplier: 1,
    searchlights: false,
    snowfall: true,
    sandstorm: false,
    ground: 'snow',
  },
  desert: {
    id: 'desert',
    hint: 'sandstorm −50% range',
    label: 'Desert',
    summary: 'Sand and blowing dust: maximum weapon engagement range is halved.',
    moveSpeedMultiplier: 1,
    vehicleSpeedMultiplier: 1,
    rangeMultiplier: 0.5,
    tankCostMultiplier: 1,
    illuminatedDamageMultiplier: 1,
    searchlights: false,
    snowfall: false,
    sandstorm: true,
    ground: 'desert',
  },
  mud: {
    id: 'mud',
    hint: 'mud armour +50%, vehicles −40%',
    label: 'Mud',
    summary: 'Churned, waterlogged ground: armour costs 50% more and vehicles move 40% slower.',
    moveSpeedMultiplier: 1,
    vehicleSpeedMultiplier: 0.6,
    rangeMultiplier: 1,
    tankCostMultiplier: 1.5,
    illuminatedDamageMultiplier: 1,
    searchlights: false,
    snowfall: false,
    sandstorm: false,
    ground: 'mud',
  },
  night: {
    id: 'night',
    hint: 'searchlights +50% damage taken',
    label: 'Night',
    summary: 'Darkness with sweeping searchlights: units caught in a beam take 50% more damage.',
    moveSpeedMultiplier: 1,
    vehicleSpeedMultiplier: 1,
    rangeMultiplier: 1,
    tankCostMultiplier: 1,
    illuminatedDamageMultiplier: 1.5,
    searchlights: true,
    snowfall: false,
    sandstorm: false,
    ground: 'night',
  },
};

export function environmentRules(environment: Environment): EnvironmentRules {
  return ENVIRONMENTS[environment] ?? ENVIRONMENTS.standard;
}

// --- searchlights -----------------------------------------------------------

/** Half-width of a searchlight beam's lit circle, in world px. */
export const SEARCHLIGHT_HALF_WIDTH = 78;
/** Sweep period in seconds. */
export const SEARCHLIGHT_PERIOD = 11;
/** Beams in a night battle, as a fraction of the field each one sweeps across. */
export const SEARCHLIGHT_COUNT = 2;

/**
 * Where each beam is pointing at time `t`. Deterministic, so the simulation and
 * the renderer agree without either one storing beam state.
 */
export function searchlightPositions(time: number): number[] {
  const positions: number[] = [];
  for (let i = 0; i < SEARCHLIGHT_COUNT; i += 1) {
    const phase = (time / SEARCHLIGHT_PERIOD + i * 0.5) * Math.PI * 2;
    // Beam sweeps between 22% and 78% of the field.
    const centre = 0.5 + Math.sin(phase + i * 1.3) * 0.28;
    positions.push(centre * 1280);
  }
  return positions;
}
