/**
 * Isometric battlefield entity and state types (v2).
 *
 * The simulation owns the arrays and mutates them in place (dead entries are
 * compacted out with a swap-remove), so `TugState` hands the renderer live
 * references — treat everything it exposes as read-only from the outside.
 *
 * Positions are on the **ground plane**: `x` runs from the player's rear toward
 * the enemy, `y` is depth. `z` exists only for things that leave the ground —
 * shell arcs, thrown debris, helmets knocked off — and is never used for
 * collision on the plane itself.
 *
 * Visual game feel (muzzle flashes, ejected casings, impact sparks, smoke,
 * screen-shake amplitude) is simulation state too, not renderer bookkeeping.
 * That keeps the renderer a pure function of the state, makes the effects
 * deterministic, and lets the headless harness assert on them.
 */

import type { Faction, StageId } from '../core/types';
import type {
  BattlefieldFeature,
  Environment,
  MissionType,
} from '../data/campaignData';
import type { FeatureLayout } from './features';
import type { BaseKind, UnitKind } from './units';

export type Side = 'player' | 'enemy';

export type MatchStatus = 'running' | 'victory' | 'defeat';

/** Why the battle ended: every position razed, or the clock deciding it. */
export type LossReason = 'bases-destroyed' | 'time-expired' | null;

/** A unit's place in the fight this step. */
export type UnitState = 'advance' | 'hold' | 'engage';

export interface Unit {
  id: number;
  side: Side;
  kind: UnitKind;
  /** Ground-plane position, world units. */
  x: number;
  y: number;
  /** Heading in world axes, radians; 0 points along +x (toward the enemy). */
  heading: number;
  /** Screen-space facing: +1 to the iso-right, -1 to the iso-left. */
  facing: 1 | -1;
  /** 0..1 through the current stride, advanced by distance travelled. */
  stride: number;
  /** Distance travelled since spawning, for the walk cycle's phase. */
  marched: number;
  hp: number;
  maxHp: number;
  /** Seconds until the next shot. */
  cooldown: number;
  state: UnitState;
  /** Muzzle flash timer, seconds remaining. */
  flash: number;
  /** Recoil offset 0..1, decays — the barrel kicks back when it fires. */
  recoil: number;
  /** Seconds spent digging in (MG). */
  dig: number;
  /** True once the sandbags are up. */
  dugIn: boolean;
  /** Remaining suppression slow, seconds. */
  suppressed: number;
  /** Per-unit stop-distance stagger (0.85..1.15), so a firing line spreads. */
  rangeJitter: number;
  /** Caught in a searchlight beam: takes extra damage at night. */
  illuminated: boolean;
  /** Blast stagger, seconds: cannot move or fire while it lasts. */
  stagger: number;
  /** How hard this unit was last shoved, for the lean in its animation. */
  shoved: number;
  /** Holding a dugout: takes a fraction of incoming projectile damage. */
  trenchCover: boolean;
  /** Spawn scale-in animation, 0..1. */
  spawn: number;
  /** Enemy unit HP is scaled by the campaign tier. */
  hpScale: number;
  /** The hostile position this unit is attacking. */
  targetBaseId: number;
  /** The friendly position it launched from. */
  homeBaseId: number;
  /** True once it has been re-tasked after its objective fell. */
  retargeted: boolean;
}

export interface BaseState {
  id: number;
  side: Side;
  /** Display letter within its own side: A..E. */
  letter: string;
  /** Name shown on the field and in the splash breakdown. */
  name: string;
  kind: BaseKind;
  /** Ground-plane position of the position's centre. */
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /**
   * Seconds until this position may launch again. **Per base**: the v2 pacing
   * rule, which is what lets several positions press at once.
   */
  cooldown: number;
  /** What launched last, so the HUD can say what the wait is for. */
  pendingKind: UnitKind | null;
  /** Muzzle flash of the base's own defensive gun, seconds remaining. */
  flash: number;
  /** Reload timer of that gun. */
  gunCooldown: number;
  /** Where the defensive gun is currently laid, radians (world axes). */
  aim: number;
  /** Smoke intensity 0..1, grows as the base takes damage. */
  smoke: number;
  /** Seconds remaining on the "just hit" flinch. */
  hit: number;
  destroyed: boolean;
}

export interface Projectile {
  x: number;
  y: number;
  /** Height above the ground plane, world units. */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  damage: number;
  kind: 'bullet' | 'shell';
  side: Side;
  life: number;
  /** Movement slow applied to whatever this round hits (MG fire). */
  suppress: number;
  /** Blast radius for shells, world units. */
  blast: number;
}

export type ParticleKind =
  | 'spark'
  | 'dust'
  | 'smoke'
  | 'casing'
  | 'debris'
  | 'blood'
  | 'bond'
  /** The detonation flash itself: a short, bright, expanding core + ring. */
  | 'flash';

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  kind: ParticleKind;
  /** Casings and debris spin as they fall. */
  spin: number;
  spinRate: number;
}

/** A corpse fading out where a unit fell. */
export interface Corpse {
  x: number;
  y: number;
  kind: UnitKind;
  side: Side;
  facing: 1 | -1;
  life: number;
  maxLife: number;
  /** Direction the body toppled in, so it falls away from the impact. */
  topple: 1 | -1;
}

/** Sandbags left behind by a dug-in MG, kept as scenery once it advances. */
export interface Sandbags {
  x: number;
  y: number;
  side: Side;
}

export interface MatchStats {
  /** Units the player fielded. */
  deployed: number;
  /** Enemy units destroyed by the player. */
  kills: number;
  /** Player units lost. */
  losses: number;
  /** War bonds collected from enemy losses during this match. */
  bondsCollected: number;
  /** Supplies generated over the match. */
  suppliesGenerated: number;
  /** Logistics upgrades bought in-match. */
  logisticsBought: number;
  /** Damage dealt to enemy positions. */
  baseDamage: number;
  /** Buried mines the player's units set off. */
  minesHit: number;
  /** Mines the enemy's units set off. */
  enemyMinesHit: number;
  /** Enemy positions razed. */
  basesDestroyed: number;
  /** Friendly positions lost. */
  basesLost: number;
  /** Launches from player positions. */
  launches: number;
  /** Times a unit was re-tasked because its objective had fallen. */
  retargets: number;
}

export interface DeployOption {
  readonly kind: UnitKind;
  readonly name: string;
  readonly cost: number;
  readonly affordable: boolean;
  /** True when the selected position is ready, off cooldown and not capped. */
  readonly ready: boolean;
  /** Seconds the base would still wait after launching (0 when ready now). */
  readonly launchCooldown: number;
  /** Full length of that cooldown, for drawing the sweep. */
  readonly cooldownTotal: number;
}

/** One launch pad, as the HUD needs to show it. */
export interface BaseOption {
  readonly id: number;
  readonly letter: string;
  readonly name: string;
  readonly kind: BaseKind;
  readonly hp: number;
  readonly maxHp: number;
  readonly hpFraction: number;
  readonly destroyed: boolean;
  /** True when this position may launch immediately. */
  readonly ready: boolean;
  /** Seconds until it may launch again. */
  readonly cooldown: number;
  /** Seconds it will wait after a launch of the cheapest kind. */
  readonly cooldownTotal: number;
  /** How many units it has in the field right now. */
  readonly units: number;
  /** Distance to the position it is currently aimed at, world units. */
  readonly distance: number;
}

export interface MatchConfig {
  readonly nodeId: StageId;
  readonly nodeName: string;
  readonly year: string;
  readonly theater: string;
  readonly tier: number;
  /** Name shown on the enemy positions (from the campaign database). */
  readonly strongpoint: string;
  readonly faction: Faction;
  readonly enemyFaction: Faction;
  /** How this sector is won. */
  readonly missionType: MissionType;
  /** Weather and light, which modify movement, range and damage. */
  readonly environment: Environment;
  /** Static terrain to lay out on the field. */
  readonly features: readonly BattlefieldFeature[];
  /** The stage's own multiplier on the player's supply generation. */
  readonly supplyRateMultiplier: number;
  readonly startSupplies: number;
  readonly supplyBaseRate: number;
  readonly enemySupplyRate: number;
  /** Seconds between launches from one enemy position. */
  readonly enemyDeployInterval: number;
  /** Multipliers from campaign upgrades. */
  readonly damageMultiplier: number;
  /** Multiplier on every player unit's hit points, from the armoury. */
  readonly unitHpMultiplier: number;
  /** Unit kinds the enemy is allowed to field, with weights. */
  readonly enemyMix: readonly { readonly kind: UnitKind; readonly weight: number }[];
  /** Every position on the field, both sides, laid out deterministically. */
  readonly bases: readonly BasePlan[];
  /** Seed for the enemy AI's jitter, derived from the node id. */
  readonly seed: number;
}

/** A position that exists before the battle starts. */
export interface BasePlan {
  readonly id: number;
  readonly side: Side;
  readonly letter: string;
  readonly name: string;
  readonly kind: BaseKind;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
}

export interface TugState {
  readonly status: MatchStatus;
  readonly lossReason: LossReason;
  readonly time: number;
  readonly timeLeft: number;
  /** How this sector is won (affects what the HUD tells the player). */
  readonly missionType: MissionType;
  readonly environment: Environment;
  readonly playerFaction: Faction;
  readonly enemyFaction: Faction;
  /** Campaign tier: drives late-war kit, such as the M1 helmet. */
  readonly tier: number;
  /** Deterministic layout seed, for the renderer's scatter passes. */
  readonly seed: number;
  /** Searchlight beam centres on the ground plane. */
  readonly searchlights: readonly { readonly x: number; readonly y: number }[];
  /** Static terrain on the field, with live damage/occupancy state. */
  readonly features: FeatureLayout;
  readonly supplies: number;
  readonly supplyRate: number;
  readonly bonds: number;
  readonly logisticsLevel: number;
  readonly logisticsCost: number;
  /** Every position on the field: friendly first, then hostile. */
  readonly bases: readonly BaseState[];
  readonly units: readonly Unit[];
  readonly corpses: readonly Corpse[];
  readonly sandbags: readonly Sandbags[];
  readonly projectiles: readonly Projectile[];
  readonly particles: readonly Particle[];
  /** Current screen-shake amplitude in px; the renderer applies it. */
  readonly shake: number;
  /** Where the action is, on the ground plane: the camera frames this. */
  readonly focusX: number;
  readonly focusY: number;
  readonly stats: MatchStats;
  /** Launch options for the player's currently selected position. */
  readonly deployOptions: readonly DeployOption[];
  /** One entry per friendly position, for the HUD's launch-pad row. */
  readonly playerBaseOptions: readonly BaseOption[];
  /** One entry per hostile position, for the HUD's objective row. */
  readonly enemyBaseOptions: readonly BaseOption[];
  /** Enemy supply readout for the HUD (approximate, for tension). */
  readonly enemySupplies: number;
  readonly enemyUnits: number;
  /** Live player units on the field (for the cap indicator). */
  readonly playerUnits: number;
  /** Surviving positions, and the total that set out. */
  readonly playerBasesAlive: number;
  readonly playerBasesTotal: number;
  readonly enemyBasesAlive: number;
  readonly enemyBasesTotal: number;
}

export type SimEventType =
  | 'deploy'
  | 'enemyDeploy'
  | 'shot'
  | 'shell'
  | 'impact'
  | 'explosion'
  | 'unitDown'
  | 'playerUnitDown'
  | 'baseHit'
  | 'baseDestroyed'
  | 'retarget'
  | 'mineBlast'
  | 'trenchOverrun'
  | 'logisticsUpgrade'
  | 'victory'
  | 'defeat';

export interface SimEvent {
  readonly type: SimEventType;
  readonly amount?: number;
  /** Which unit type caused it, so audio can pick the right weapon signature. */
  readonly kind?: UnitKind;
  /** True when the hit landed on armour — the audio layer turns it into a ping. */
  readonly metal?: boolean;
  /** Which side the event belongs to, where that matters. */
  readonly side?: Side;
}

/** One frame of player intent, produced by the input layer. */
export interface MatchCommand {
  readonly deploy: UnitKind | null;
  /** Launch pad to send from; `null` = the one nearest the objective. */
  readonly fromBaseId: number | null;
  /** Hostile position to attack; `null` = nearest to the launch pad. */
  readonly targetBaseId: number | null;
  readonly buyLogistics: boolean;
}
