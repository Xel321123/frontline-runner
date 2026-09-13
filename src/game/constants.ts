/**
 * Match tuning constants. Pure numbers — no DOM, no browser APIs.
 *
 * Logical units are px in the fixed 1280x720 space; time is seconds. The
 * battlefield is a single horizontal lane with the player base at the left edge
 * and the enemy strongpoint at the right edge, exactly as the brief specifies.
 */

// --- frame loop -------------------------------------------------------------
export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 5;
export const MAX_FRAME_DT = 0.25;

// --- viewport ---------------------------------------------------------------
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 720;

/** Player base sits at the left edge, enemy strongpoint at the right edge. */
export const BASE_X = 50;
export const ENEMY_BASE_X = 1230;
/** Units are placed this far in front of their own base. */
export const BASE_SPAWN_OFFSET = 46;
/** Ground line: everything walks along here. */
export const GROUND_Y = 566;
/** Where shell smoke/impact dust settles. */
export const SHADOW_Y = GROUND_Y + 4;

// --- economy ----------------------------------------------------------------
/** Baseline supplies per second, before any logistics upgrades. */
export const SUPPLY_BASE_RATE = 2;
/** Supplies per level of the in-match logistics upgrade. */
export const SUPPLY_PER_LOGISTICS_LEVEL = 0.6;
export const LOGISTICS_MAX_LEVEL = 5;
/** War bonds paid for the first logistics upgrade; cost grows per level. */
export const LOGISTICS_BASE_COST = 30;
export const LOGISTICS_COST_STEP = 25;
/** Supplies banked at the start of a match (plus the upgrade bonus). */
export const SUPPLY_START = 60;
/** Hard cap so a passive player cannot bank an instant army. */
export const SUPPLY_CAP = 400;

// --- bases ------------------------------------------------------------------
/**
 * Your strongpoint, and the enemy's. Both are kept deliberately small: a
 * sustained push should *finish* a battle, not chip at a wall for three minutes.
 */
export const PLAYER_BASE_HP = 1800;
export const ENEMY_BASE_HP_BASE = 1100;
export const ENEMY_BASE_HP_PER_TIER = 150;

// --- enemy AI ---------------------------------------------------------------
export const ENEMY_SUPPLY_BASE = 1.7;
export const ENEMY_SUPPLY_PER_TIER = 0.05;
/** Seconds between enemy deployments (jittered by the level seed). */
export const ENEMY_DEPLOY_INTERVAL = 2.4;
export const ENEMY_DEPLOY_JITTER = 1.4;
/** Seconds before the enemy will commit armour — keeps openings consistent. */
export const ENEMY_ARMOUR_DELAY = 30;

// --- match rules ------------------------------------------------------------
export const MAX_UNITS_PER_SIDE = 24;
/**
 * The battle clock. It breaks a genuine stalemate (higher remaining base-health
 * fraction wins, a draw counts as a defeat so the attacker must take ground) —
 * but it sits comfortably past a well-played push, so it is not the normal way
 * a battle ends.
 */
export const MATCH_TIME_LIMIT = 165;
/** Minimum gap between the player's own deployments (stops click spamming). */
export const PLAYER_DEPLOY_COOLDOWN = 0.35;
/** Enemy hit points grow with the campaign tier. */
export const ENEMY_HP_PER_TIER_SCALE = 0.06;

// --- defensive base guns ----------------------------------------------------
export const BASE_GUN_RANGE = 250;
export const BASE_GUN_DAMAGE = 18;
export const BASE_GUN_FIRE_RATE = 0.9;
/** Collision half-width of a base structure. */
export const BASE_HALF_WIDTH = 44;

/** Minimum fraction of a hit that always lands, so armour never immunises. */
export const MIN_DAMAGE_FRACTION = 0.25;

// --- suppression ------------------------------------------------------------
export const SUPPRESS_TIME = 0.7;
export const SUPPRESSED_SPEED_MULTIPLIER = 0.55;

// --- projectiles ------------------------------------------------------------
export const BULLET_SPEED = 620;
export const SHELL_SPEED = 330;
export const SHELL_GRAVITY = 320;
/** Bullets are removed after travelling this far without a hit. */
export const PROJECTILE_MAX_LIFE = 3;

// --- particles / game feel --------------------------------------------------
export const PARTICLE_GRAVITY = 340;
/** Hard cap so a long barrage cannot tank the frame rate. */
export const PARTICLE_CAP = 700;
export const CORPSE_LIFE = 2.6;
export const SHAKE_DECAY = 3.2;
export const MUZZLE_FLASH_TIME = 0.07;
export const RECOIL_TIME = 0.16;
