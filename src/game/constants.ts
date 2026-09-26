/**
 * Match tuning constants. Pure numbers — no DOM, no browser APIs.
 *
 * v2 (isometric bases): the battlefield is a ground **plane** rather than a
 * lane. `x` runs from the player's rear toward the enemy, `y` is depth across
 * the field, and both are in world units rendered isometrically (see
 * `src/render/iso/iso.ts`).
 *
 * Each side holds one to five bases. Bases are independent: each has its own
 * hit points, its own defensive gun and **its own launch timer** — the pacing
 * rule in v2 is per base, so holding three bases lets you press on three axes
 * at once instead of waiting on one global cooldown.
 */

// --- frame loop -------------------------------------------------------------
export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 5;
export const MAX_FRAME_DT = 0.25;

// --- world plane ------------------------------------------------------------
/** Ground plane extents, world units. x runs toward the enemy, y is depth. */
export const WORLD_W = 960;
export const WORLD_H = 560;
/** Terrain tile size, world units (24 x 14 tiles of ground). */
export const TILE = 40;

/**
 * The part of the plane the camera frames by default: the corridor between the
 * two rear areas, plus a margin. Projecting this box gives the default fit
 * scale, so nothing important is ever off-screen at zoom 1.
 */
export const VIEW_MIN_X = 70;
export const VIEW_MAX_X = 890;
export const VIEW_MIN_Y = 40;
export const VIEW_MAX_Y = 520;

/** Logical reference size, kept for HUD layout maths only. */
export const VIEW_WIDTH = 1280;
export const VIEW_HEIGHT = 720;

/** Rear area of each side: bases are placed inside this band, with jitter. */
export const PLAYER_REAR_X = 150;
export const ENEMY_REAR_X = 810;
export const REAR_X_JITTER = 44;
export const BASE_Y_MIN = 80;
export const BASE_Y_MAX = 480;
/** Collision radius of a base's built-up footprint, world units. */
export const BASE_FOOTPRINT = 36;
/**
 * Two positions of one side never sit closer than this, in x and y combined.
 * Five positions across a 400-unit-deep rear area with an alternating lean puts
 * adjacent positions ~130 apart, so this is the constraint the layout is built
 * to satisfy — and the headless harness asserts it.
 */
export const BASE_MIN_SEPARATION = 112;

// --- economy ----------------------------------------------------------------
/** Baseline supplies per second, before any logistics upgrades. */
export const SUPPLY_BASE_RATE = 2;
/** Supplies per level of the in-match logistics upgrade. */
export const SUPPLY_PER_LOGISTICS_LEVEL = 0.6;
export const LOGISTICS_MAX_LEVEL = 5;
/** War bonds paid for the first logistics upgrade; cost grows per level. */
export const LOGISTICS_BASE_COST = 30;
export const LOGISTICS_COST_STEP = 25;
/** Supplies banked at the start of a match. */
export const SUPPLY_START = 60;
/** Hard cap so a passive player cannot bank an instant army. */
export const SUPPLY_CAP = 400;

// --- bases ------------------------------------------------------------------
/**
 * Total hit points for a side, split across however many bases it holds, so a
 * five-base sector takes roughly as much work to level as a one-base sector —
 * the difference is that the work is spread over five places at once.
 */
export const PLAYER_BASE_HP_TOTAL = 1800;
export const ENEMY_BASE_HP_BASE = 1100;
export const ENEMY_BASE_HP_PER_TIER = 150;
/** Extra total hit points per base beyond the first (spread-out targets). */
export const BASE_HP_PER_EXTRA_BASE = 0.16;
/** A single base never drops below this, however many the side holds. */
export const MIN_BASE_HP = 260;

/** Seconds a base must wait after launching before it may launch again. */
export const BASE_LAUNCH_COOLDOWN_SCALE = 3.4;
/** Enemy launch jitter, seconds, added to its own per-base interval. */
export const ENEMY_DEPLOY_JITTER = 1.1;
/**
 * Seconds between deployments from *one* enemy base at tier 1. The value fed to
 * the simulation is multiplied by the enemy's base count so total enemy
 * throughput does not scale with how many bases the sector has.
 */
export const ENEMY_DEPLOY_INTERVAL = 2.4;
/** Seconds before the enemy will commit armour — keeps openings consistent. */
export const ENEMY_ARMOUR_DELAY = 30;
/** Enemy hit points grow with the campaign tier. */
export const ENEMY_HP_PER_TIER_SCALE = 0.06;
export const ENEMY_SUPPLY_BASE = 1.7;
export const ENEMY_SUPPLY_PER_TIER = 0.05;
export const ENEMY_LATE_WAR_SUPPLY = 0.15;
export const ENEMY_LATE_WAR_TIER = 6;

// --- defensive base guns ----------------------------------------------------
/**
 * A position's own defensive gun. Deliberately strong enough to hold off a
 * couple of infantry sections: with one to five positions a side, a position
 * that could be rolled by two riflemen would make the whole layout meaningless,
 * because the first raiders to slip past the line would end the battle.
 */
export const BASE_GUN_RANGE = 178;
export const BASE_GUN_DAMAGE = 20;
export const BASE_GUN_FIRE_RATE = 1.0;

/**
 * A hostile inside this radius of a unit's OWN position is a raid, and a unit
 * will break off to deal with it. Without this rule a garrison stands in the
 * field while its own gate is walked past, which made defence a matter of luck.
 */
export const GARRISON_RADIUS = 250;

// --- match rules ------------------------------------------------------------
export const MAX_UNITS_PER_SIDE = 24;
/**
 * The battle clock. It breaks a genuine stalemate (the side holding the larger
 * fraction of its base hit points wins; a draw counts as a defeat so the
 * attacker must take ground) but sits past a well-played push.
 */
export const MATCH_TIME_LIMIT = 175;
/**
 * In a `survive_timer` battle the player is the defender, so its units advance
 * to this line and hold it dug in rather than marching off the map.
 */
export const HOLD_LINE_X = 470;
/** How long a `survive_timer` sector must be held. */
export const SURVIVE_SECONDS = 120;
/** An `assault` faces a prepared position: stronger, but the attacker is ready. */
export const ASSAULT_BASE_HP_MULTIPLIER = 1.25;
export const SURVIVE_ENEMY_SUPPLY_BONUS = 1.4;
export const SURVIVE_ENEMY_DEPLOY_INTERVAL = 2.2;
export const SURVIVE_DEFENDER_SUPPLY_BONUS = 2.1;
export const ASSAULT_ATTACKER_SUPPLY_BONUS = 1.25;

/** Minimum fraction of a hit that always lands, so armour never immunises. */
export const MIN_DAMAGE_FRACTION = 0.25;

// --- static battlefield features --------------------------------------------
/** Projectile damage multiplier for infantry holding a trench (−70%). */
export const TRENCH_DAMAGE_MULTIPLIER = 0.3;
/** A hostile this close to a held trench overruns it and the cover is lost. */
export const TRENCH_OVERRUN_RANGE = 46;
/** Damage a mine does to whatever walks over it, in one burst. */
export const MINE_DAMAGE = 45;
/** How close a unit must come to a buried mine to set it off. */
export const MINE_TRIGGER_RADIUS = 11;
/** Spacing between mines in a belt, before tier scaling tightens it. */
export const MINE_SPACING = 30;
/** Depth (y) of a bridge span: units are funnelled into this band. */
export const BRIDGE_WIDTH = 96;
export const BRIDGE_CAPACITY_PER_SIDE = 4;

// --- movement ---------------------------------------------------------------
/**
 * Strength of the side-by-side separation push. Without it every unit walks the
 * same pixel line into the same pixel and a squad reads as one sprite.
 */
export const SEPARATION_STRENGTH = 26;
/** Extra spacing kept behind the unit ahead of you in a queue. */
export const QUEUE_PADDING = 6;

// --- suppression ------------------------------------------------------------
export const SUPPRESS_TIME = 0.7;
export const SUPPRESSED_SPEED_MULTIPLIER = 0.55;

// --- projectiles ------------------------------------------------------------
export const BULLET_SPEED = 620;
export const SHELL_SPEED = 330;
export const SHELL_GRAVITY = 320;
/**
 * Minimum flight time for a shell, seconds. A tank at point-blank range would
 * otherwise fire its round *downwards* at the target, because the arc that lands
 * on the ground over a very short flight starts below the muzzle. Holding a
 * floor on the flight time keeps every round a visible lob.
 */
export const SHELL_MIN_FLIGHT = 0.62;
/** Bullets are removed after travelling this long without a hit. */
export const PROJECTILE_MAX_LIFE = 3;
/** Muzzle height as a fraction of a unit's drawn height. */
export const MUZZLE_HEIGHT_FRACTION = 0.62;

// --- particles / game feel --------------------------------------------------
export const PARTICLE_GRAVITY = 340;
/** Hard cap so a long barrage cannot tank the frame rate. */
export const PARTICLE_CAP = 700;
export const CORPSE_LIFE = 9;
/** World units a shell blast shoves nearby infantry back. */
export const BLAST_KNOCKBACK = 34;
/** Seconds a unit is staggered after being caught in a blast. */
export const BLAST_STAGGER = 0.45;
export const SHAKE_DECAY = 3.2;
export const MUZZLE_FLASH_TIME = 0.07;
export const RECOIL_TIME = 0.16;

// --- camera -----------------------------------------------------------------
/** Fit scale is multiplied by the zoom factor, clamped to this range. */
export const CAMERA_MIN_ZOOM_FACTOR = 1;
export const CAMERA_MAX_ZOOM_FACTOR = 2.4;
export const CAMERA_DEFAULT_ZOOM_FACTOR = 1;
/** Opt-in close-action zoom (the HUD button toggles between the two). */
export const CAMERA_ZOOM_IN_FACTOR = 1.8;
