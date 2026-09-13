/**
 * Run tuning constants. Pure numbers — no DOM, no browser APIs.
 *
 * Everything is expressed in **logical units** (the fixed 1280x720 game space)
 * and **seconds**, so the simulation behaves identically on every device.
 */

import { BASE_SQUAD_TROOPS } from '../core/progression';

export const FIXED_DT = 1 / 60;
/** Simulation steps allowed per frame before the backlog is dropped. */
export const MAX_SUBSTEPS = 5;
/** Frames longer than this are treated as a stall (tab switch) and clamped. */
export const MAX_FRAME_DT = 0.25;

// --- viewport ---------------------------------------------------------------
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 720;

// --- squad ------------------------------------------------------------------
/** Horizontal anchor: 18% from the left, fixed for the whole run. */
export const SQUAD_X = Math.round(VIEW_WIDTH * 0.18);
export const SQUAD_BAND_HEIGHT = 104;
export const SQUAD_BAND_WIDTH = 46;
/** Exponential smoothing rate (1/s) for target → position. */
export const SQUAD_LERP_RATE = 9;
/** Soldiers actually drawn; the HUD number is the true count. */
export const SQUAD_MAX_DRAWN = 12;

export const BASE_SQUAD = BASE_SQUAD_TROOPS;
export const MAX_TROOPS = 30;

// --- world ------------------------------------------------------------------
export const SCROLL_SPEED = 215;
export const PROJECTILE_SPEED = 980;
export const PROJECTILE_RADIUS = 3;
/** Shots per volley. Above this, damage per shot scales instead. */
export const MAX_MUZZLES = 12;

// --- hazards ----------------------------------------------------------------
export const MINE_TROOP_LOSS = 3;
export const MINE_RADIUS = 20;
export const WIRE_TROOP_LOSS_PER_SECOND = 1;
/** Razor wire is an entanglement *field*, not a thin wall: the squad needs a
 *  couple of seconds inside it, which is what makes the per-second cost bite. */
export const WIRE_LENGTH_MIN = 320;
export const WIRE_LENGTH_MAX = 620;
export const INFANTRY_TROOP_LOSS = 1;
export const INFANTRY_RADIUS = 26;

// --- crates and gates -------------------------------------------------------
export const CRATE_SHOT_GAIN = 1;
export const CRATE_VALUE_MAX_INITIAL = 3;
export const CRATE_VALUE_CAP = 12;
export const CRATE_SIZE = 52;
export const GATE_SHOT_STEP = 1;
export const GATE_ADD_CAP = 30;

/** Two stacked bands spanning the playfield, with a safe gap between them. */
export const GATE_BANDS: readonly { readonly y: number; readonly height: number }[] = [
  { y: 40, height: 240 },
  { y: 400, height: 240 },
];
export const GATE_MULTIPLIER_LADDER: readonly number[] = [2, 2.5, 3, 3.5, 4, 5, 6];
export const GATE_DIVISOR_LADDER: readonly number[] = [4, 3, 2, 1];

// --- end zone ---------------------------------------------------------------
export const BOSS_HP_MULTIPLIER = 22;
export const BOSS_TIME_LIMIT = 45;
/** Where the bunker parks on screen once scrolling stops. */
export const BOSS_SCREEN_X = 980;
export const BOSS_WIDTH = 190;
export const BOSS_HEIGHT = 190;

// --- level layout -----------------------------------------------------------
export const LEVEL_LENGTH_BASE = 8200;
export const LEVEL_LENGTH_PER_TIER = 130;
export const GATE_INTERVAL_PX = 1500;

// --- upgrade effects (defined with the tracks in core/progression.ts) -------
// Re-exported so simulation code reads the same numbers the camp screen shows.
export {
  BASE_SQUAD_TROOPS,
  DAMAGE_PER_FIREPOWER_LEVEL,
  FIRE_RATE_PER_MOBILITY_LEVEL,
  REVIVES_PER_MEDKIT_LEVEL,
  TROOPS_PER_ARMOUR_LEVEL,
} from '../core/progression';

// --- popups -----------------------------------------------------------------
export const POPUP_LIFE = 1.1;
export const POPUP_RISE = 46;
