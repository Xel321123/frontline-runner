/**
 * Environmental rules — the weather, its effect on the battle, and how the
 * isometric scene is lit.
 *
 * One table shared by the simulation (which applies the modifiers), the
 * briefing/map UI (which explains them) and the renderer (which paints them), so
 * a stage can never advertise a weather effect the battle does not apply, and
 * the sky can never look like a season the modifiers do not match.
 *
 * The numbers are the mutators from the design brief:
 *   snow   — white-out ground, falling snow, −35% movement for all ground units
 *   desert — sandstorm haze, −50% maximum weapon engagement range
 *   mud    — heavy going: tank supply cost +50%, vehicles traverse 40% slower
 *   night  — darkness with sweeping searchlight beams; lit units take +50% damage
 */

import type { Environment } from '../data/campaignData';
import { WORLD_H, WORLD_W } from './constants';

/** How the scene is lit — read by the renderer, never by the simulation. */
export interface EnvironmentLook {
  /** Sky above the field, top to horizon. */
  readonly skyTop: string;
  readonly skyMid: string;
  readonly skyHorizon: string;
  /** What surrounds the ground plane out to the edges of the screen. */
  readonly surround: string;
  /** Haze laid over the whole view at the horizon line. */
  readonly haze: string;
  /** Overall tint multiplied over the finished frame (or '' for none). */
  readonly tint: string;
  /** Multiplier on ambient light: < 1 darkens the ground pass. */
  readonly ambient: number;
  /** Falling precipitation, drawn in screen space. */
  readonly weather: 'none' | 'snow' | 'sand' | 'rain';
  /** True when the scene needs sweeping searchlight beams. */
  readonly searchlights: boolean;
}

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
  /** Always true — snow, sand and darkness all change the ground pass. */
  readonly look: EnvironmentLook;
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
    look: {
      skyTop: '#3d5f78',
      skyMid: '#7d99a6',
      skyHorizon: '#c3c3a6',
      surround: '#1b241d',
      haze: 'rgba(196, 200, 172, 0.16)',
      tint: '',
      ambient: 1,
      weather: 'none',
      searchlights: false,
    },
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
    look: {
      skyTop: '#8fa5b6',
      skyMid: '#c2cdd6',
      skyHorizon: '#e6ecef',
      surround: '#c9d6de',
      haze: 'rgba(232, 240, 246, 0.34)',
      tint: 'rgba(198, 214, 228, 0.16)',
      ambient: 1.06,
      weather: 'snow',
      searchlights: false,
    },
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
    look: {
      skyTop: '#b9a273',
      skyMid: '#dbc394',
      skyHorizon: '#efdcae',
      surround: '#a08a5f',
      haze: 'rgba(226, 199, 141, 0.44)',
      tint: 'rgba(214, 178, 116, 0.14)',
      ambient: 1.02,
      weather: 'sand',
      searchlights: false,
    },
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
    look: {
      skyTop: '#3b4239',
      skyMid: '#616a5c',
      skyHorizon: '#8b8f77',
      surround: '#2a2e26',
      haze: 'rgba(120, 124, 104, 0.22)',
      tint: 'rgba(90, 82, 62, 0.12)',
      ambient: 0.94,
      weather: 'rain',
      searchlights: false,
    },
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
    look: {
      skyTop: '#070b14',
      skyMid: '#0d1522',
      skyHorizon: '#1a2434',
      surround: '#080c11',
      haze: 'rgba(40, 58, 84, 0.3)',
      tint: 'rgba(12, 22, 44, 0.34)',
      ambient: 0.7,
      weather: 'none',
      searchlights: true,
    },
  },
};

export function environmentRules(environment: Environment): EnvironmentRules {
  return ENVIRONMENTS[environment] ?? ENVIRONMENTS.standard;
}

// --- searchlights -----------------------------------------------------------

/** Radius of a searchlight's lit pool on the ground, in world units. */
export const SEARCHLIGHT_RADIUS = 96;
/** Sweep period in seconds. */
export const SEARCHLIGHT_PERIOD = 13;
/** Beams in a night battle. */
export const SEARCHLIGHT_COUNT = 2;

export interface SearchlightPool {
  /** Beam centre on the ground plane. */
  readonly x: number;
  readonly y: number;
}

/**
 * Where each beam is pointing at time `t`. Deterministic, so the simulation and
 * the renderer agree without either one storing beam state: the beams sweep
 * across the depth of the field at fixed x, which is what a searchlight on the
 * perimeter of a position actually does.
 */
export function searchlightPositions(time: number): SearchlightPool[] {
  const pools: SearchlightPool[] = [];
  for (let i = 0; i < SEARCHLIGHT_COUNT; i += 1) {
    const phase = (time / SEARCHLIGHT_PERIOD + i * 0.5) * Math.PI * 2;
    const lane = (i + 1) / (SEARCHLIGHT_COUNT + 1);
    const x = lane * WORLD_W + Math.sin(phase * 0.8 + i) * 26;
    // Sweeps the depth of the field between 15% and 85% of it.
    const y = (0.5 + Math.sin(phase + i * 1.3) * 0.35) * WORLD_H;
    pools.push({ x, y });
  }
  return pools;
}

/** True when a point on the plane is inside any beam's lit pool. */
export function litBySearchlight(
  pools: readonly SearchlightPool[],
  x: number,
  y: number,
): boolean {
  const radiusSquared = SEARCHLIGHT_RADIUS * SEARCHLIGHT_RADIUS;
  for (const pool of pools) {
    const dx = pool.x - x;
    const dy = pool.y - y;
    if (dx * dx + dy * dy <= radiusSquared) return true;
  }
  return false;
}
