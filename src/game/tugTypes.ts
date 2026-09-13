/**
 * Tug-of-war entity and state types.
 *
 * The simulation owns the arrays and mutates them in place (dead entries are
 * compacted out with a swap-remove), so `TugState` hands the renderer live
 * references — treat everything it exposes as read-only from the outside.
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
import type { UnitKind } from './units';

export type Side = 'player' | 'enemy';

export type MatchStatus = 'running' | 'victory' | 'defeat';

export type LossReason = 'base-destroyed' | 'time-expired' | null;

export interface Unit {
  id: number;
  side: Side;
  kind: UnitKind;
  /** Horizontal position on the battlefield, px. */
  x: number;
  hp: number;
  maxHp: number;
  /** Seconds until the next shot. */
  cooldown: number;
  /** `hold` = stopped on its line without a target in range (dug in). */
  state: 'advance' | 'hold' | 'engage';
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
  /** Facing: +1 toward the enemy base for the player, -1 for the enemy. */
  facing: 1 | -1;
  /** Enemy unit HP is scaled by the campaign tier. */
  hpScale: number;
}

export interface BaseState {
  side: Side;
  hp: number;
  maxHp: number;
  /** Muzzle flash of the base's own defensive gun, seconds remaining. */
  flash: number;
  /** Reload timer of that gun. */
  cooldown: number;
  /** Smoke intensity 0..1, grows as the base takes damage. */
  smoke: number;
  /** Seconds remaining on the "just hit" flinch. */
  hit: number;
}

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  kind: 'bullet' | 'shell';
  side: Side;
  life: number;
  /** Movement slow applied to whatever this round hits (MG fire). */
  suppress: number;
  /** Blast radius for shells, px. */
  blast: number;
}

export type ParticleKind = 'spark' | 'dust' | 'smoke' | 'casing' | 'debris' | 'blood' | 'bond';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  kind: ParticleKind;
  /** Casings and debris spin as they fall. */
  spin: number;
}

/** A corpse fading out where a unit fell. */
export interface Corpse {
  x: number;
  kind: UnitKind;
  side: Side;
  facing: 1 | -1;
  life: number;
  maxLife: number;
  /** Direction the body toppled in, so it falls away from the impact. */
  topple: 1 | -1;
  /** Helmet launched off on impact (drawn as its own little arc). */
  helmetX: number;
  helmetY: number;
  helmetVx: number;
  helmetVy: number;
}

/** Sandbags left behind by a dug-in MG, kept as scenery once it advances. */
export interface Sandbags {
  x: number;
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
  /** Damage dealt to the enemy strongpoint. */
  baseDamage: number;
  /** Buried mines the player's units set off. */
  minesHit: number;
  /** Mines the enemy's units set off. */
  enemyMinesHit: number;
}

export interface DeployOption {
  readonly kind: UnitKind;
  readonly name: string;
  /** Seconds until this type can be deployed again (0 when ready). */
  readonly cooldown: number;
  /** Full length of that cooldown, for drawing the sweep. */
  readonly cooldownTotal: number;
  readonly cost: number;
  readonly affordable: boolean;
  /** True when the deployment bar slot is shown as available. */
  readonly ready: boolean;
}

export interface MatchConfig {
  readonly nodeId: StageId;
  readonly nodeName: string;
  readonly year: string;
  readonly theater: string;
  readonly tier: number;
  /** Name shown on the enemy strongpoint (from the campaign database). */
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
  readonly playerBaseHp: number;
  readonly enemyBaseHp: number;
  readonly startSupplies: number;
  readonly supplyBaseRate: number;
  readonly enemySupplyRate: number;
  /** Seconds between enemy deployments (shorter when it is the attacker). */
  readonly enemyDeployInterval: number;
  /** Multipliers from campaign upgrades. */
  readonly damageMultiplier: number;
  /** Multiplier on every player unit's hit points, from the armory. */
  readonly unitHpMultiplier: number;
  /** Unit kinds the enemy is allowed to field, with weights. */
  readonly enemyMix: readonly { readonly kind: UnitKind; readonly weight: number }[];
  /** Seed for the enemy AI's jitter, derived from the node id. */
  readonly seed: number;
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
  /** Searchlight beam centres, empty unless it is a night battle. */
  readonly searchlights: readonly number[];
  /** Static terrain on the field, with live damage/occupancy state. */
  readonly features: FeatureLayout;
  readonly supplies: number;
  readonly supplyRate: number;
  readonly bonds: number;
  readonly logisticsLevel: number;
  readonly logisticsCost: number;
  readonly playerBase: BaseState;
  readonly enemyBase: BaseState;
  readonly units: readonly Unit[];
  readonly corpses: readonly Corpse[];
  readonly sandbags: readonly Sandbags[];
  readonly projectiles: readonly Projectile[];
  readonly particles: readonly Particle[];
  /** Current screen-shake amplitude in px; the renderer applies it. */
  readonly shake: number;
  /** Parallax focus: the average x of engaged units, or the midpoint. */
  readonly focusX: number;
  readonly stats: MatchStats;
  readonly deployOptions: readonly DeployOption[];
  /** Enemy supply readout for the HUD (approximate, for tension). */
  readonly enemySupplies: number;
  readonly enemyUnits: number;
  /** Live player units on the field (for the cap indicator). */
  readonly playerUnits: number;
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
}

/** One frame of player intent, produced by the input layer. */
export interface MatchCommand {
  readonly deploy: UnitKind | null;
  readonly buyLogistics: boolean;
}
