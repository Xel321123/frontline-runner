/**
 * Run-time entity and state types.
 *
 * The simulation owns the arrays and mutates them in place (dead entries are
 * compacted out with a swap-remove), so `SimState` hands the renderer live
 * references. Renderers must treat them as read-only.
 */

export type RunStatus = 'running' | 'won' | 'lost';
export type LossReason = 'squad-wiped' | 'time-expired';
export type RunPhase = 'advance' | 'boss';

export type GateOp = 'add' | 'mul' | 'sub' | 'div';

export interface Projectile {
  x: number;
  y: number;
  vx: number;
  /** Vertical drift from weapon spread; straight-flying rounds have vy 0. */
  vy: number;
  damage: number;
}

export interface Crate {
  /** World x of the crate centre. */
  x: number;
  y: number;
  /** Troops granted when the squad passes; raised by shooting. */
  value: number;
  hitFlash: number;
  taken: boolean;
}

export interface Mine {
  x: number;
  y: number;
  /** Triggered mines stay as scorch marks until they scroll off. */
  armed: boolean;
  flash: number;
}

export interface Wire {
  x: number;
  y: number;
  height: number;
  /** Horizontal extent: crossing the field takes time, which is the cost. */
  length: number;
  /** Fractional damage accumulator, so 1 troop/sec is exact over time. */
  damageAccumulator: number;
  flash: number;
}

export interface Infantry {
  x: number;
  y: number;
  speed: number;
  hp: number;
  maxHp: number;
  flash: number;
}

export interface Gate {
  x: number;
  op: GateOp;
  value: number;
  y: number;
  height: number;
  resolved: boolean;
  hitFlash: number;
}

export type PopupTone = 'gain' | 'loss' | 'info';

export interface Popup {
  x: number;
  y: number;
  text: string;
  tone: PopupTone;
  /** Seconds remaining. */
  life: number;
}

export interface RunStats {
  volleys: number;
  shotsFired: number;
  kills: number;
  cratesCollected: number;
  troopsFromCrates: number;
  gateGains: number;
  gateLosses: number;
  troopsLost: number;
  minesHit: number;
  distance: number;
}

/** Spawned layout for one level — produced by `game/level.ts`. */
export type SpawnKind = 'crate' | 'mine' | 'wire' | 'infantry' | 'gate';

export interface CrateSpawn {
  readonly kind: 'crate';
  readonly x: number;
  readonly y: number;
  readonly value: number;
}
export interface MineSpawn {
  readonly kind: 'mine';
  readonly x: number;
  readonly y: number;
}
export interface WireSpawn {
  readonly kind: 'wire';
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly length: number;
}
export interface InfantrySpawn {
  readonly kind: 'infantry';
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly hp: number;
}
export interface GateSpawn {
  readonly kind: 'gate';
  readonly x: number;
  readonly op: GateOp;
  readonly value: number;
  readonly y: number;
  readonly height: number;
}

export type Spawn = CrateSpawn | MineSpawn | WireSpawn | InfantrySpawn | GateSpawn;

export interface LevelPlan {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly year: string;
  readonly theater: string;
  readonly tier: number;
  readonly spawns: readonly Spawn[];
  /** World x where the squad stops and the bunker fight starts. */
  readonly bunkerX: number;
  readonly totalScroll: number;
  readonly bossName: string;
  readonly bossMaxHp: number;
}

export interface SimConfig {
  readonly weaponId: string;
  readonly weaponName: string;
  readonly damagePerTroop: number;
  readonly fireInterval: number;
  readonly spreadDegrees: number;
  readonly startingTroops: number;
  readonly revives: number;
  readonly maxTroops: number;
}

export interface SimState {
  readonly status: RunStatus;
  readonly lossReason: LossReason | null;
  readonly phase: RunPhase;
  readonly troops: number;
  readonly revivesLeft: number;
  readonly squadWorldX: number;
  readonly squadY: number;
  readonly scrollX: number;
  /** 0..1 towards the point where scrolling stops. */
  readonly progress: number;
  readonly time: number;
  readonly bossWorldX: number;
  readonly bossMaxHp: number;
  readonly bossHp: number;
  readonly bossTimeLeft: number;
  readonly bossName: string;
  readonly projectiles: readonly Projectile[];
  readonly crates: readonly Crate[];
  readonly mines: readonly Mine[];
  readonly wires: readonly Wire[];
  readonly infantry: readonly Infantry[];
  readonly gates: readonly Gate[];
  readonly popups: readonly Popup[];
  readonly stats: RunStats;
}

export type SimEventType =
  | 'volley'
  | 'bulletHit'
  | 'infantryKilled'
  | 'infantryCollision'
  | 'mineHit'
  | 'wireHit'
  | 'crateDeployed'
  | 'gateGain'
  | 'gateLoss'
  | 'bossPhase'
  | 'bossDestroyed'
  | 'defeat'
  | 'revive';

export interface SimEvent {
  readonly type: SimEventType;
  /** Troop change for gain/loss events, otherwise undefined. */
  readonly amount?: number;
}
