/**
 * TugSimulation — the whole isometric battle, as pure logic.
 *
 * No DOM, no canvas, no audio, no timers: `update(dt, command)` advances the
 * world by an exact fixed step, and the class reports what happened through
 * `takeEvents()`. That is what lets the identical code run in a browser frame
 * loop and in the headless balance harness (see `scripts/simulate-match.mjs`).
 *
 * Layout (v2)
 * -----------
 * The battlefield is a **ground plane** (960 x 560 world units), not a lane.
 * Each side holds one to five *positions*: the game's bases. Every position has
 * its own hit points, its own defensive gun and **its own launch timer**, so
 * holding three positions lets a player press on three axes at once instead of
 * waiting on one global cooldown.
 *
 * A launch names a position to send from and a position to attack. Units march
 * across the plane toward the objective, stop the moment a hostile comes into
 * range, and — this is the rule that makes a multi-position battle work — when
 * their objective is razed they re-task themselves onto the nearest surviving
 * position of that side rather than standing in a field.
 *
 * Game feel is part of the state: muzzle flashes, ejected casings, impact
 * sparks, smoke, debris arcs, corpses and the screen-shake amplitude are all
 * simulation data, so rendering stays a pure function of the simulation and the
 * effects are deterministic enough to assert on.
 */

import { createRng, type Rng } from './rng';
import { unitStats, type UnitKind } from './units';
import type {
  BaseOption,
  BaseState,
  Corpse,
  DeployOption,
  LossReason,
  MatchCommand,
  MatchConfig,
  MatchStats,
  MatchStatus,
  Particle,
  ParticleKind,
  Projectile,
  Sandbags,
  Side,
  SimEvent,
  TugState,
  Unit,
} from './tugTypes';
import {
  BASE_FOOTPRINT,
  BASE_GUN_DAMAGE,
  BASE_GUN_FIRE_RATE,
  BASE_GUN_RANGE,
  BLAST_KNOCKBACK,
  BLAST_STAGGER,
  BULLET_SPEED,
  CORPSE_LIFE,
  ENEMY_ARMOUR_DELAY,
  ENEMY_DEPLOY_JITTER,
  ENEMY_HP_PER_TIER_SCALE,
  GARRISON_RADIUS,
  HOLD_LINE_X,
  LOGISTICS_BASE_COST,
  LOGISTICS_COST_STEP,
  LOGISTICS_MAX_LEVEL,
  MATCH_TIME_LIMIT,
  MINE_DAMAGE,
  MINE_TRIGGER_RADIUS,
  MAX_UNITS_PER_SIDE,
  MUZZLE_FLASH_TIME,
  MUZZLE_HEIGHT_FRACTION,
  PARTICLE_CAP,
  PARTICLE_GRAVITY,
  PROJECTILE_MAX_LIFE,
  QUEUE_PADDING,
  SEPARATION_STRENGTH,
  SHELL_GRAVITY,
  SHELL_MIN_FLIGHT,
  SHELL_SPEED,
  SHAKE_DECAY,
  SUPPRESSED_SPEED_MULTIPLIER,
  SUPPRESS_TIME,
  SUPPLY_CAP,
  SUPPLY_PER_LOGISTICS_LEVEL,
  SURVIVE_SECONDS,
  TRENCH_OVERRUN_RANGE,
  WORLD_H,
  WORLD_W,
} from './constants';
import { incomingDamage } from './damage';
import {
  environmentRules,
  litBySearchlight,
  searchlightPositions,
  type EnvironmentRules,
  type SearchlightPool,
} from './environment';
import {
  bridgeAt,
  createFeatureLayout,
  inWater,
  nearestBridge,
  recountBridges,
  trenchAt,
  type FeatureLayout,
} from './features';

/** In-match logistics upgrade cost for the next level. */
export function logisticsCost(level: number): number | null {
  if (level >= LOGISTICS_MAX_LEVEL) return null;
  return LOGISTICS_BASE_COST + LOGISTICS_COST_STEP * level;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function makeParticle(
  kind: ParticleKind,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  life: number,
  size: number,
  spin = 0,
  spinRate = 0,
): Particle {
  return { kind, x, y, z, vx, vy, vz, life, maxLife: life, size, spin, spinRate };
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** No beams at all — shared so a non-night battle allocates nothing per step. */
const EMPTY_POOLS: readonly SearchlightPool[] = [];

export class TugSimulation {
  private readonly config: MatchConfig;
  private readonly rng: Rng;
  /** Weather and light rules for this sector. */
  private readonly rules: EnvironmentRules;
  /** Static terrain: dugouts, mine belts, the crossing and its river. */
  private readonly layout: FeatureLayout;
  private searchlightValue: readonly SearchlightPool[] = EMPTY_POOLS;

  private statusValue: MatchStatus = 'running';
  private lossReasonValue: LossReason = null;
  private timeValue = 0;
  private suppliesValue: number;
  private bondsValue = 0;
  private logisticsLevelValue = 0;
  private enemySuppliesValue: number;
  /** Seconds until each enemy position launches again. Keyed by base id. */
  private readonly enemyLaunchTimers = new Map<number, number>();
  private focusXValue = WORLD_W / 2;
  private focusYValue = WORLD_H / 2;
  private shakeValue = 0;
  private nextId = 1;
  private events: SimEvent[] = [];

  private readonly basesValue: BaseState[] = [];
  private readonly unitsValue: Unit[] = [];
  private readonly corpsesValue: Corpse[] = [];
  private readonly sandbagsValue: Sandbags[] = [];
  private readonly projectilesValue: Projectile[] = [];
  private readonly particlesValue: Particle[] = [];

  private readonly statsValue: MatchStats = {
    deployed: 0,
    kills: 0,
    losses: 0,
    bondsCollected: 0,
    suppliesGenerated: 0,
    logisticsBought: 0,
    baseDamage: 0,
    minesHit: 0,
    enemyMinesHit: 0,
    basesDestroyed: 0,
    basesLost: 0,
    launches: 0,
    retargets: 0,
  };

  constructor(config: MatchConfig) {
    this.config = config;
    this.rng = createRng(config.seed);
    this.rules = environmentRules(config.environment);
    this.layout = createFeatureLayout({
      seed: config.nodeId,
      features: config.features,
      tier: config.tier,
    });
    this.suppliesValue = config.startSupplies;
    // The enemy opens with a comparable bank so the first contact is not a walkover.
    this.enemySuppliesValue = config.startSupplies;

    for (const plan of config.bases) {
      this.basesValue.push({
        id: plan.id,
        side: plan.side,
        letter: plan.letter,
        name: plan.name,
        kind: plan.kind,
        x: plan.x,
        y: plan.y,
        hp: plan.hp,
        maxHp: plan.hp,
        cooldown: 0,
        pendingKind: null,
        flash: 0,
        gunCooldown: 0.5,
        aim: plan.side === 'player' ? 0 : Math.PI,
        smoke: 0,
        hit: 0,
        destroyed: false,
      });
    }

    // Enemy positions open on a staggered cadence: if every one of five
    // positions fired its first wave on the same frame the opening would be a
    // single alpha strike rather than a developing attack.
    let stagger = 1.6;
    for (const base of this.basesValue) {
      if (base.side !== 'enemy') continue;
      this.enemyLaunchTimers.set(base.id, stagger);
      stagger += 1.1;
    }
  }

  // ------------------------------------------------------------------ public

  get supplyRate(): number {
    return this.config.supplyBaseRate + SUPPLY_PER_LOGISTICS_LEVEL * this.logisticsLevelValue;
  }

  /** Every position on the field, both sides — read-only for the renderer. */
  get bases(): readonly BaseState[] {
    return this.basesValue;
  }

  get state(): TugState {
    const playerBases = this.basesValue.filter((base) => base.side === 'player');
    const enemyBases = this.basesValue.filter((base) => base.side === 'enemy');
    const playerAlive = playerBases.filter((base) => !base.destroyed);
    const enemyAlive = enemyBases.filter((base) => !base.destroyed);
    return {
      status: this.statusValue,
      lossReason: this.lossReasonValue,
      time: this.timeValue,
      timeLeft: Math.max(0, this.timeLimit() - this.timeValue),
      missionType: this.config.missionType,
      playerFaction: this.config.faction,
      enemyFaction: this.config.enemyFaction,
      tier: this.config.tier,
      seed: this.config.seed,
      environment: this.config.environment,
      searchlights: this.searchlightValue,
      features: this.layout,
      supplies: this.suppliesValue,
      supplyRate: this.supplyRate,
      bonds: this.bondsValue,
      logisticsLevel: this.logisticsLevelValue,
      logisticsCost: logisticsCost(this.logisticsLevelValue) ?? 0,
      bases: this.basesValue,
      units: this.unitsValue,
      corpses: this.corpsesValue,
      sandbags: this.sandbagsValue,
      projectiles: this.projectilesValue,
      particles: this.particlesValue,
      shake: this.shakeValue,
      focusX: this.focusXValue,
      focusY: this.focusYValue,
      stats: this.statsValue,
      deployOptions: this.deployOptions(),
      playerBaseOptions: playerBases.map((base) => this.baseOption(base)),
      enemyBaseOptions: enemyBases.map((base) => this.baseOption(base)),
      enemySupplies: this.enemySuppliesValue,
      enemyUnits: this.countUnits('enemy'),
      playerUnits: this.countUnits('player'),
      playerBasesAlive: playerAlive.length,
      playerBasesTotal: playerBases.length,
      enemyBasesAlive: enemyAlive.length,
      enemyBasesTotal: enemyBases.length,
    };
  }

  takeEvents(): SimEvent[] {
    if (this.events.length === 0) return [];
    const drained = this.events;
    this.events = [];
    return drained;
  }

  update(dt: number, command: MatchCommand): void {
    if (this.statusValue === 'running') {
      this.timeValue += dt;
      this.updateEconomy(dt);
      this.handleCommand(command);
      this.updateBases(dt);
      this.updateEnemyAI(dt);
      // Bridge occupancy and the searchlight sweep are *inputs* to movement, so
      // they are read first; cover and mines are consequences of movement, so
      // they are read after it.
      this.updateBridges();
      this.updateUnits(dt);
      this.updateBattlefield();
      this.updateProjectiles(dt);
      this.updateFocus(dt);
      this.checkTimeLimit();
    } else {
      this.updateBases(dt);
    }
    this.updateEffects(dt);
    this.compact();
  }

  // ----------------------------------------------------------------- economy

  private updateEconomy(dt: number): void {
    const before = this.suppliesValue;
    this.suppliesValue = Math.min(SUPPLY_CAP, this.suppliesValue + this.supplyRate * dt);
    this.enemySuppliesValue += this.config.enemySupplyRate * dt;
    this.statsValue.suppliesGenerated += Math.max(0, this.suppliesValue - before);
  }

  // ------------------------------------------------------------------ player

  private handleCommand(command: MatchCommand): void {
    if (command.buyLogistics) {
      const cost = logisticsCost(this.logisticsLevelValue);
      if (cost !== null && this.bondsValue >= cost) {
        this.bondsValue -= cost;
        this.logisticsLevelValue += 1;
        this.statsValue.logisticsBought += 1;
        this.emit({ type: 'logisticsUpgrade', amount: this.logisticsLevelValue });
      }
    }

    if (!command.deploy) return;
    const target = this.resolveTarget(command.targetBaseId, null);
    const launchPad = this.resolveLaunchPad(command.fromBaseId, target);
    if (!launchPad) return;

    const kind = command.deploy;
    const cost = this.unitCostFor(kind);
    if (this.suppliesValue < cost) return;
    if (launchPad.cooldown > 0) return;
    if (this.countUnits('player') >= MAX_UNITS_PER_SIDE) return;

    const objective = target ?? this.nearestHostileBase(launchPad, 'player');
    this.suppliesValue -= cost;
    this.spawnUnit('player', kind, launchPad, objective);
    this.launchPadFired(launchPad, kind);
    this.statsValue.deployed += 1;
    this.statsValue.launches += 1;
    this.emit({ type: 'deploy', kind, side: 'player' });
  }

  /** A position that launches, plus the cooldown that keeps its own cadence. */
  private launchPadFired(base: BaseState, kind: UnitKind): void {
    base.cooldown = unitStats(kind).launchCooldown;
    base.pendingKind = kind;
  }

  private deployOptions(): DeployOption[] {
    const options: DeployOption[] = [];
    const atCap = this.countUnits('player') >= MAX_UNITS_PER_SIDE;
    for (const kind of ['rifleman', 'smg', 'mg', 'tank'] as UnitKind[]) {
      const stats = unitStats(kind);
      const cost = this.unitCostFor(kind);
      // The HUD reports the *best* launch pad, so the bar stays honest when the
      // player has not chosen one: is any position actually able to send this?
      let bestCooldown = Infinity;
      for (const base of this.basesValue) {
        if (base.side !== 'player' || base.destroyed) continue;
        bestCooldown = Math.min(bestCooldown, base.cooldown);
      }
      const cooldown = Number.isFinite(bestCooldown) ? bestCooldown : 0;
      const affordable = this.suppliesValue >= cost;
      options.push({
        kind,
        name: stats.name,
        cost,
        affordable,
        ready: affordable && cooldown <= 0 && !atCap,
        launchCooldown: cooldown,
        cooldownTotal: stats.launchCooldown,
      });
    }
    return options;
  }

  private baseOption(base: BaseState): BaseOption {
    const hostileSide: Side = base.side === 'player' ? 'enemy' : 'player';
    let nearest = Infinity;
    for (const other of this.basesValue) {
      if (other.side !== hostileSide || other.destroyed) continue;
      nearest = Math.min(nearest, distance(base.x, base.y, other.x, other.y));
    }
    let units = 0;
    for (const unit of this.unitsValue) {
      if (unit.homeBaseId === base.id) units += 1;
    }
    const cooldownTotal =
      base.pendingKind !== null ? unitStats(base.pendingKind).launchCooldown : 0;
    return {
      id: base.id,
      letter: base.letter,
      name: base.name,
      kind: base.kind,
      hp: base.hp,
      maxHp: base.maxHp,
      hpFraction: base.maxHp > 0 ? Math.max(0, base.hp / base.maxHp) : 0,
      destroyed: base.destroyed,
      ready: !base.destroyed && base.cooldown <= 0,
      cooldown: base.cooldown,
      cooldownTotal,
      units,
      // Closest hostile position: the HUD's "how far is the fighting from here"
      // readout, which stays meaningful whatever the player has selected.
      distance: Number.isFinite(nearest) ? nearest : 0,
    };
  }

  // -------------------------------------------------------------- targetting

  /** The hostile position a launch should be aimed at. */
  private resolveTarget(
    targetBaseId: number | null,
    from: BaseState | null,
  ): BaseState | null {
    const side: Side = from && from.side === 'enemy' ? 'enemy' : 'player';
    const hostile: Side = side === 'player' ? 'enemy' : 'player';
    if (targetBaseId !== null) {
      const named = this.baseById(targetBaseId);
      if (named && named.side === hostile && !named.destroyed) return named;
    }
    if (from) return this.nearestHostileBase(from, side);
    return this.firstAlive(hostile);
  }

  /** Which of my positions actually sends the troops. */
  private resolveLaunchPad(fromBaseId: number | null, target: BaseState | null): BaseState | null {
    if (fromBaseId !== null) {
      const named = this.baseById(fromBaseId);
      if (named && named.side === 'player' && !named.destroyed) return named;
    }
    if (target) {
      let best: BaseState | null = null;
      let bestDistance = Infinity;
      for (const base of this.basesValue) {
        if (base.side !== 'player' || base.destroyed) continue;
        const d = distance(base.x, base.y, target.x, target.y);
        if (d < bestDistance) {
          bestDistance = d;
          best = base;
        }
      }
      return best;
    }
    return this.firstAlive('player');
  }

  private baseById(id: number): BaseState | null {
    for (const base of this.basesValue) {
      if (base.id === id) return base;
    }
    return null;
  }

  private firstAlive(side: Side): BaseState | null {
    for (const base of this.basesValue) {
      if (base.side === side && !base.destroyed) return base;
    }
    return null;
  }

  /** The closest surviving hostile position to `from`. */
  private nearestHostileBase(from: BaseState, side: Side): BaseState | null {
    const hostile: Side = side === 'player' ? 'enemy' : 'player';
    let best: BaseState | null = null;
    let bestDistance = Infinity;
    for (const base of this.basesValue) {
      if (base.side !== hostile || base.destroyed) continue;
      const d = distance(base.x, base.y, from.x, from.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = base;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------- enemy

  /**
   * One launch timer per hostile position. The interval passed in the config
   * is already scaled by the position count, so a five-position sector does not
   * simply field five times the troops of a one-position sector.
   */
  private updateEnemyAI(dt: number): void {
    for (const base of this.basesValue) {
      if (base.side !== 'enemy' || base.destroyed) continue;
      const remaining = (this.enemyLaunchTimers.get(base.id) ?? 0) - dt;
      if (remaining > 0) {
        this.enemyLaunchTimers.set(base.id, remaining);
        continue;
      }
      if (base.cooldown > 0) {
        this.enemyLaunchTimers.set(base.id, 0.2);
        continue;
      }
      if (this.countUnits('enemy') >= MAX_UNITS_PER_SIDE) {
        this.enemyLaunchTimers.set(base.id, 1);
        continue;
      }

      // No armour in the opening minute: it gives the player time to establish
      // a line, and it stops a lucky early roll from deciding the whole battle.
      const armourUnlocked = this.timeValue >= ENEMY_ARMOUR_DELAY;
      const affordable = this.config.enemyMix.filter(
        (entry) =>
          (armourUnlocked || entry.kind !== 'tank') &&
          this.unitCostFor(entry.kind) <= this.enemySuppliesValue,
      );
      if (affordable.length === 0) {
        this.enemyLaunchTimers.set(base.id, 0.5);
        continue;
      }

      // Save for armour. An army that always spends on the cheapest body never
      // fields a tank — which made the late-war sectors fight like 1941 — so
      // while the sector wants armour and the enemy has less than its quota, it
      // banks supplies instead of buying another rifleman.
      const tankCost = this.unitCostFor('tank');
      const wantsArmour =
        armourUnlocked && this.config.enemyMix.some((entry) => entry.kind === 'tank');
      const lineHeld = this.countUnits('enemy') >= 3;
      const keepsPressing = this.config.missionType !== 'survive_timer';
      if (wantsArmour && lineHeld && keepsPressing) {
        const tanks = this.unitsValue.filter(
          (unit) => unit.side === 'enemy' && unit.kind === 'tank',
        ).length;
        if (tanks < 1 && this.enemySuppliesValue < tankCost) {
          this.enemyLaunchTimers.set(base.id, 0.7);
          continue;
        }
      }

      // Slight counter-bias: armour on the field pulls the enemy toward the
      // units that can actually hurt it.
      const playerTanks = this.unitsValue.filter(
        (unit) => unit.side === 'player' && unit.kind === 'tank',
      ).length;
      const weighted = affordable.map((entry) => ({
        value: entry.kind,
        weight:
          entry.weight *
          (playerTanks > 0 && (entry.kind === 'tank' || entry.kind === 'mg') ? 1.6 : 1),
      }));

      const kind = this.rng.weighted(weighted);
      const objective = this.enemyObjectiveFor(base);
      this.enemySuppliesValue -= this.unitCostFor(kind);
      this.spawnUnit('enemy', kind, base, objective);
      this.launchPadFired(base, kind);
      this.emit({ type: 'enemyDeploy', kind, side: 'enemy' });
      this.enemyLaunchTimers.set(
        base.id,
        Math.max(0.6, this.config.enemyDeployInterval + this.rng.range(0, ENEMY_DEPLOY_JITTER)),
      );
    }
  }

  /**
   * Which position this enemy launch is aimed at: usually the nearest, but
   * sometimes the weakest, so a defence cannot win by ignoring one flank.
   */
  private enemyObjectiveFor(base: BaseState): BaseState | null {
    const candidates: { value: BaseState; weight: number }[] = [];
    const nearest = this.nearestHostileBase(base, 'enemy');
    for (const other of this.basesValue) {
      if (other.side !== 'player' || other.destroyed) continue;
      const d = Math.max(1, distance(base.x, base.y, other.x, other.y));
      const weakness = 1.6 - Math.max(0.2, other.hp / other.maxHp);
      const proximity = other === nearest ? 2 : 1;
      candidates.push({ value: other, weight: (proximity * (0.4 + weakness)) / Math.sqrt(d) });
    }
    if (candidates.length === 0) return null;
    return this.rng.weighted(candidates);
  }

  // -------------------------------------------------------------------- units

  private spawnUnit(
    side: Side,
    kind: UnitKind,
    from: BaseState,
    objective: BaseState | null,
  ): Unit {
    const stats = unitStats(kind);
    // Enemy units scale with the campaign tier; the player's scale with the
    // armoury's Unit Health track instead.
    const hpScale =
      side === 'enemy'
        ? 1 + (this.config.tier - 1) * ENEMY_HP_PER_TIER_SCALE
        : this.config.unitHpMultiplier;
    const maxHp = stats.hp * hpScale;

    const target =
      objective ??
      this.nearestHostileBase(from, side) ??
      (side === 'player' ? this.firstAlive('enemy') : this.firstAlive('player'));
    const heading = target
      ? Math.atan2(target.y - from.y, target.x - from.x)
      : side === 'player'
        ? 0
        : Math.PI;

    // Spawn on the edge of the position, spread across a short arc so two units
    // leaving the same pad do not occupy the same pixel.
    const spread = this.rng.range(-0.42, 0.42);
    const offset = BASE_FOOTPRINT + stats.radius + 6;
    const spawnHeading = heading + spread;
    const x = from.x + Math.cos(spawnHeading) * offset;
    const y = from.y + Math.sin(spawnHeading) * offset;

    const unit: Unit = {
      id: this.nextId,
      side,
      kind,
      x: Math.max(8, Math.min(WORLD_W - 8, x)),
      y: Math.max(8, Math.min(WORLD_H - 8, y)),
      heading,
      facing: Math.cos(heading) - Math.sin(heading) >= 0 ? 1 : -1,
      stride: 0,
      marched: 0,
      hp: maxHp,
      maxHp,
      cooldown: 0.2,
      state: 'advance',
      flash: 0,
      recoil: 0,
      dig: 0,
      dugIn: false,
      suppressed: 0,
      rangeJitter: this.rng.range(0.85, 1.15),
      illuminated: false,
      stagger: 0,
      shoved: 0,
      trenchCover: false,
      spawn: 0,
      hpScale,
      targetBaseId: target ? target.id : -1,
      homeBaseId: from.id,
      retargeted: false,
    };
    this.nextId += 1;
    this.unitsValue.push(unit);
    return unit;
  }

  // ----------------------------------------------------- environment & terrain

  /** Engagement range after weather, plus this unit's own stagger. */
  private unitRange(unit: Unit): number {
    return unitStats(unit.kind).range * this.rules.rangeMultiplier * unit.rangeJitter;
  }

  /** Movement speed after weather, vehicle handling and suppression. */
  private unitSpeed(unit: Unit): number {
    const stats = unitStats(unit.kind);
    const terrain = unit.kind === 'tank' ? this.rules.vehicleSpeedMultiplier : 1;
    const slow = unit.suppressed > 0 ? SUPPRESSED_SPEED_MULTIPLIER : 1;
    return stats.speed * this.rules.moveSpeedMultiplier * terrain * slow;
  }

  /** Supply cost after terrain: armour costs half again as much in the mud. */
  unitCostFor(kind: UnitKind): number {
    const stats = unitStats(kind);
    if (kind !== 'tank') return stats.cost;
    return Math.round(stats.cost * this.rules.tankCostMultiplier);
  }

  /**
   * True when this unit is the defender in a survival battle and has reached
   * the line it is meant to hold — it digs in rather than pursuing. Without
   * this, "hold the line" missions turn into an advance across the player's own
   * minefield.
   */
  private holdsLine(unit: Unit): boolean {
    if (this.config.missionType !== 'survive_timer' || unit.side !== 'player') return false;
    return unit.x >= HOLD_LINE_X;
  }

  /**
   * Terrain and light, once per step: who is dug into a trench, who is caught
   * in a searchlight beam, and what has just walked onto a buried mine.
   */
  private updateBridges(): void {
    recountBridges(this.layout, this.unitsValue);
    this.searchlightValue = this.rules.look.searchlights
      ? searchlightPositions(this.timeValue)
      : EMPTY_POOLS;
  }

  /**
   * Who is under cover, who is lit, and what has just walked onto a mine. Runs
   * *after* movement: a unit that has just started walking must lose its trench
   * cover on the same step, not on the next one.
   */
  private updateBattlefield(): void {
    for (const unit of this.unitsValue) {
      const stopped = unit.state !== 'advance';
      // Only infantry use dugouts, and only while they are standing in one.
      const trench = unit.kind === 'tank' ? null : trenchAt(this.layout, unit.x, unit.y);
      unit.trenchCover = Boolean(trench && stopped && trench.overrunBy === null);

      if (trench && trench.overrunBy === null && stopped) {
        // A trench stops being cover the moment both sides are inside it.
        const contested = this.unitsValue.some(
          (other) =>
            other.side !== unit.side &&
            Math.abs(other.x - trench.x) <= trench.w / 2 + TRENCH_OVERRUN_RANGE &&
            Math.abs(other.y - trench.y) <= trench.h / 2 + TRENCH_OVERRUN_RANGE,
        );
        if (contested) {
          trench.overrunBy = unit.side === 'player' ? 'enemy' : 'player';
          unit.trenchCover = false;
          this.emit({ type: 'trenchOverrun' });
        }
      }

      unit.illuminated =
        this.searchlightValue.length > 0 &&
        litBySearchlight(this.searchlightValue, unit.x, unit.y);
    }

    if (this.layout.minefields.length > 0) this.updateMines();
  }

  /** Mine belts are neutral ground: they take whoever walks over them first. */
  private updateMines(): void {
    for (const belt of this.layout.minefields) {
      if (belt.armed === 0) continue;
      for (const mine of belt.mines) {
        if (mine.exploded) continue;
        for (const unit of this.unitsValue) {
          if (distance(unit.x, unit.y, mine.x, mine.y) > MINE_TRIGGER_RADIUS) continue;
          mine.exploded = true;
          belt.armed -= 1;
          if (unit.side === 'player') this.statsValue.minesHit += 1;
          else this.statsValue.enemyMinesHit += 1;
          this.explosion(mine.x, mine.y, 26);
          this.shakeValue = Math.max(this.shakeValue, 5);
          this.emit({ type: 'mineBlast' });
          // A mine is a burst of casualties, armoured or not: a buried charge
          // going off under a track does not care what the target is wearing, so
          // this is the one damage path that skips `hitUnit`'s armour.
          unit.hp -= MINE_DAMAGE;
          if (unit.hp <= 0) this.killUnit(unit);
          break;
        }
      }
    }
  }

  private countUnits(side: Side): number {
    let count = 0;
    for (const unit of this.unitsValue) if (unit.side === side) count += 1;
    return count;
  }

  private updateUnits(dt: number): void {
    for (const unit of this.unitsValue) {
      const stats = unitStats(unit.kind);
      unit.spawn = Math.min(1, unit.spawn + dt * 4);
      unit.flash = Math.max(0, unit.flash - dt);
      unit.recoil = Math.max(0, unit.recoil - dt / 0.16);
      unit.suppressed = Math.max(0, unit.suppressed - dt);
      unit.shoved = Math.max(0, unit.shoved - dt * 1.6);

      if (unit.stagger > 0) {
        unit.stagger = Math.max(0, unit.stagger - dt);
        continue;
      }

      const target = this.engageTarget(unit);
      if (target && target.distance <= this.unitRange(unit)) {
        unit.state = 'engage';
        // Machine gunners dig in where they stop and gain cover.
        if (stats.digTime !== undefined) {
          unit.dig += dt;
          if (!unit.dugIn && unit.dig >= stats.digTime) {
            unit.dugIn = true;
            this.sandbagsValue.push({ x: unit.x, y: unit.y, side: unit.side });
          }
        }
        unit.cooldown -= dt;
        if (unit.cooldown <= 0) this.fire(unit, target.x, target.y);
        this.turnTowards(unit, target.x, target.y, dt);
        continue;
      }

      if (unit.dugIn) {
        // Moving on abandons the position; the bags stay as scenery.
        unit.dugIn = false;
        unit.dig = 0;
      }

      if (this.holdsLine(unit)) {
        unit.state = 'hold';
        continue;
      }

      unit.state = 'advance';
      this.steer(unit, dt);
    }
  }

  /**
   * What this unit is shooting at: the nearest hostile figure, or its objective
   * position — whichever is closer. Firing at a *position* is what makes taking
   * ground possible at all: a unit that could only ever shoot at other units
   * would stand in the enemy's yard forever, which is exactly what the headless
   * harness caught.
   *
   * `distance` is measured to the target's edge for a position, so a rifleman's
   * range means "range to the building", not to its centre.
   */
  private engageTarget(
    unit: Unit,
  ): { x: number; y: number; unit: Unit | null; distance: number } | null {
    // A hostile standing inside this unit's own position is a raid: it is
    // weighted as though it were much closer, so a garrison turns on the troops
    // coming through its gate instead of watching them walk past.
    const home = this.baseById(unit.homeBaseId);
    let best: { x: number; y: number; unit: Unit | null; distance: number } | null = null;
    for (const other of this.unitsValue) {
      if (other.side === unit.side || other.hp <= 0) continue;
      let d = distance(other.x, other.y, unit.x, unit.y);
      if (home && !home.destroyed && distance(other.x, other.y, home.x, home.y) <= GARRISON_RADIUS) {
        d *= 0.55;
      }
      if (!best || d < best.distance) best = { x: other.x, y: other.y, unit: other, distance: d };
    }
    const objective = this.baseById(unit.targetBaseId);
    if (objective && !objective.destroyed) {
      const d = Math.max(
        0,
        distance(unit.x, unit.y, objective.x, objective.y) - BASE_FOOTPRINT,
      );
      if (!best || d < best.distance) {
        best = { x: objective.x, y: objective.y, unit: null, distance: d };
      }
    }
    return best;
  }

  /**
   * One step of movement: head for the objective, push clear of friends, keep
   * out of the buildings, and respect the river and the bridge span.
   */
  private steer(unit: Unit, dt: number): void {
    const objective = this.objectiveFor(unit);
    const speed = this.unitSpeed(unit);
    const stats = unitStats(unit.kind);
    let desiredX = 0;
    let desiredY = 0;

    if (objective) {
      const dx = objective.x - unit.x;
      const dy = objective.y - unit.y;
      const d = Math.hypot(dx, dy);
      if (d > 1) {
        desiredX += (dx / d) * speed;
        desiredY += (dy / d) * speed;
      }
    }

    // Separation: without it every unit walks the same line and a squad reads
    // as one sprite. Only same-side neighbours push, and the push weakens with
    // distance so a formed line is stable rather than jittering.
    for (const other of this.unitsValue) {
      if (other === unit || other.side !== unit.side) continue;
      const dx = unit.x - other.x;
      const dy = unit.y - other.y;
      const d = Math.hypot(dx, dy);
      const spacing = Math.max(stats.spacing, unitStats(other.kind).spacing);
      if (d >= spacing + QUEUE_PADDING || d < 0.01) continue;
      const push = ((spacing + QUEUE_PADDING - d) / (spacing + QUEUE_PADDING)) * SEPARATION_STRENGTH;
      desiredX += (dx / d) * push;
      desiredY += (dy / d) * push;
    }

    // Buildings are solid: walk around a position, not through it.
    for (const base of this.basesValue) {
      if (base.destroyed) continue;
      const dx = unit.x - base.x;
      const dy = unit.y - base.y;
      const d = Math.hypot(dx, dy);
      const clearance = BASE_FOOTPRINT + stats.radius;
      if (d >= clearance || d < 0.01) continue;
      const push = (clearance - d) * 3;
      desiredX += (dx / d) * push;
      desiredY += (dy / d) * push;
    }

    const nextX = unit.x + desiredX * dt;
    const nextY = unit.y + desiredY * dt;

    if (this.blockedByRiver(unit, nextX, nextY)) {
      // Hold the bank and slide toward the span: an attack at a crossing turns
      // into a column because there is nowhere else to go.
      const bridge = nearestBridge(this.layout, unit.x, unit.y);
      if (bridge) {
        const towardSpan = bridge.y > unit.y ? 1 : -1;
        desiredY = towardSpan * Math.max(speed * 0.7, Math.abs(desiredY));
        desiredX = 0;
      } else {
        desiredX = 0;
      }
      unit.x += desiredX * dt;
      unit.y += desiredY * dt;
      this.clampToWorld(unit);
      const moved = Math.abs(desiredY) * dt;
      this.advanceStride(unit, moved);
      return;
    }

    unit.x = nextX;
    unit.y = nextY;
    this.clampToWorld(unit);
    this.advanceStride(unit, Math.hypot(desiredX, desiredY) * dt);
  }

  /** True when stepping onto (x, y) means entering the river off the span. */
  private blockedByRiver(unit: Unit, x: number, y: number): boolean {
    if (this.layout.water.length === 0) return false;
    if (!inWater(this.layout, x, y)) {
      // Crossing a full span is refused too: the deck only holds so many.
      const bridge = bridgeAt(this.layout, x, y);
      if (!bridge) return false;
      const onIt = bridgeAt(this.layout, unit.x, unit.y) === bridge;
      return !onIt && bridge.occupants[unit.side] >= bridge.capacity;
    }
    return true;
  }

  private clampToWorld(unit: Unit): void {
    unit.x = Math.max(6, Math.min(WORLD_W - 6, unit.x));
    unit.y = Math.max(6, Math.min(WORLD_H - 6, unit.y));
  }

  /** The walk cycle advances with distance travelled, not with time. */
  private advanceStride(unit: Unit, marched: number): void {
    unit.marched += marched;
    const strideLength = unit.kind === 'tank' ? 34 : 26;
    unit.stride = (unit.marched / strideLength) % 1;
  }

  /** Turn an idle unit toward whatever it is shooting at. */
  private turnTowards(unit: Unit, x: number, y: number, dt: number): void {
    const desired = Math.atan2(y - unit.y, x - unit.x);
    const stats = unitStats(unit.kind);
    let delta = desired - unit.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const step = stats.turnRate * dt;
    unit.heading += Math.abs(delta) <= step ? delta : Math.sign(delta) * step;
    unit.facing = Math.cos(unit.heading) - Math.sin(unit.heading) >= 0 ? 1 : -1;
  }

  /**
   * Where this unit is going. When the objective has been razed it re-tasks
   * onto the nearest surviving hostile position — the rule that keeps a
   * multi-position battle moving instead of stranding troops in an empty field.
   */
  private objectiveFor(unit: Unit): Point | null {
    const hostile: Side = unit.side === 'player' ? 'enemy' : 'player';
    let base = this.baseById(unit.targetBaseId);
    if (!base || base.destroyed) {
      let best: BaseState | null = null;
      let bestDistance = Infinity;
      for (const candidate of this.basesValue) {
        if (candidate.side !== hostile || candidate.destroyed) continue;
        const d = distance(candidate.x, candidate.y, unit.x, unit.y);
        if (d < bestDistance) {
          bestDistance = d;
          best = candidate;
        }
      }
      if (!best) return null;
      unit.targetBaseId = best.id;
      if (!unit.retargeted) {
        unit.retargeted = true;
        this.statsValue.retargets += 1;
        this.emit({ type: 'retarget', side: unit.side });
      }
      base = best;
    }
    // Aim at the edge of the position rather than its centre, so a squad
    // surrounds a building instead of piling into one point.
    const stats = unitStats(unit.kind);
    const dx = unit.x - base.x;
    const dy = unit.y - base.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.01) return { x: base.x, y: base.y };
    const standoff = BASE_FOOTPRINT * 0.6 + stats.radius;
    return { x: base.x + (dx / d) * standoff, y: base.y + (dy / d) * standoff };
  }

  // -------------------------------------------------------------- projectiles

  private fire(unit: Unit, targetX: number, targetY: number): void {
    const stats = unitStats(unit.kind);
    unit.cooldown = 1 / stats.fireRate;
    unit.flash = MUZZLE_FLASH_TIME;
    unit.recoil = 1;

    const damage = stats.damage * (unit.side === 'player' ? this.config.damageMultiplier : 1);
    const dx = targetX - unit.x;
    const dy = targetY - unit.y;
    const d = Math.max(0.001, Math.hypot(dx, dy));
    const muzzleX = unit.x + (dx / d) * (stats.radius + 6);
    const muzzleY = unit.y + (dy / d) * (stats.radius + 6);
    const muzzleZ = stats.height * MUZZLE_HEIGHT_FRACTION;

    if (stats.projectile === 'shell') {
      // Lob it: solve the launch velocity so the shell lands on the ground at
      // the target, which is what makes the arc read as artillery.
      const flight = Math.max(SHELL_MIN_FLIGHT, Math.abs(d) / SHELL_SPEED);
      this.projectilesValue.push({
        x: muzzleX,
        y: muzzleY,
        z: muzzleZ,
        vx: dx / flight,
        vy: dy / flight,
        vz: (0.5 * SHELL_GRAVITY * flight * flight - muzzleZ) / flight,
        damage,
        kind: 'shell',
        side: unit.side,
        life: PROJECTILE_MAX_LIFE,
        suppress: 0,
        blast: stats.blast ?? 70,
      });
      this.ejectCasing(unit, muzzleX, muzzleY, muzzleZ);
      this.smokePuff(muzzleX, muzzleY, muzzleZ, dx / d, dy / d);
      this.shakeValue = Math.max(this.shakeValue, 2.2);
      this.emit({ type: 'shell', kind: unit.kind, side: unit.side });
      return;
    }

    for (let shot = 0; shot < stats.roundsPerVolley; shot += 1) {
      // A little scatter per round, so a volley reads as a burst of fire
      // rather than a single beam of identical projectiles.
      const scatter = this.rng.range(-0.035, 0.035);
      const cos = Math.cos(scatter);
      const sin = Math.sin(scatter);
      this.projectilesValue.push({
        x: muzzleX,
        y: muzzleY,
        z: muzzleZ,
        vx: ((dx / d) * cos - (dy / d) * sin) * BULLET_SPEED,
        vy: ((dx / d) * sin + (dy / d) * cos) * BULLET_SPEED,
        vz: 0,
        damage,
        kind: 'bullet',
        side: unit.side,
        life: PROJECTILE_MAX_LIFE,
        suppress: stats.suppression ?? 0,
        blast: 0,
      });
    }
    this.muzzleBurst(muzzleX, muzzleY, muzzleZ, dx / d, dy / d);
    this.ejectCasing(unit, muzzleX, muzzleY, muzzleZ);
    this.emit({ type: 'shot', kind: unit.kind, side: unit.side });
  }

  private updateProjectiles(dt: number): void {
    for (const shot of this.projectilesValue) {
      if (shot.life <= 0) continue;
      shot.life -= dt;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      if (shot.kind === 'shell') {
        shot.vz -= SHELL_GRAVITY * dt;
        shot.z += shot.vz * dt;
        if (shot.z <= 0) {
          shot.z = 0;
          this.detonate(shot);
          shot.life = 0;
          continue;
        }
      }

      const victim = this.unitAt(shot.x, shot.y, shot.side);
      if (victim) {
        if (shot.kind === 'shell') {
          this.detonate(shot);
        } else {
          this.hitUnit(victim, shot.damage, shot.suppress);
          this.impactSparks(shot.x, shot.y, shot.z);
          this.emit({ type: 'impact', metal: victim.kind === 'tank' });
        }
        shot.life = 0;
        continue;
      }

      const hit = this.baseAt(shot.x, shot.y, shot.side);
      if (hit) {
        this.damageBase(hit, shot.damage);
        if (shot.kind === 'shell') this.detonate(shot);
        else this.impactSparks(shot.x, shot.y, shot.z);
        shot.life = 0;
      }
    }
  }

  /** The first hostile in the plane the round passes through. */
  private unitAt(x: number, y: number, side: Side): Unit | null {
    for (const unit of this.unitsValue) {
      if (unit.side === side || unit.hp <= 0) continue;
      const stats = unitStats(unit.kind);
      if (distance(unit.x, unit.y, x, y) <= stats.radius + 3) return unit;
    }
    return null;
  }

  /** The hostile position this round has reached, if any. */
  private baseAt(x: number, y: number, side: Side): BaseState | null {
    for (const base of this.basesValue) {
      if (base.side === side || base.destroyed) continue;
      if (distance(base.x, base.y, x, y) <= BASE_FOOTPRINT + 4) return base;
    }
    return null;
  }

  /** Tank shell: area damage with falloff, plus dust, smoke and a screen shake. */
  private detonate(shot: Projectile): void {
    const radius = shot.blast > 0 ? shot.blast : 70;
    this.explosion(shot.x, shot.y, radius);
    this.shakeValue = Math.max(this.shakeValue, 7);

    for (const unit of this.unitsValue) {
      if (unit.side === shot.side) continue;
      const d = distance(unit.x, unit.y, shot.x, shot.y);
      if (d > radius) continue;
      const falloff = 1 - 0.6 * (d / radius);
      this.hitUnit(unit, shot.damage * falloff, 0);
      // Armour shrugs off the shockwave; infantry gets thrown backwards —
      // except on a bridge, where the parapet takes the push and a blast cannot
      // sweep the attackers back off the span.
      const onBridge = bridgeAt(this.layout, unit.x, unit.y) !== null;
      if (unit.kind !== 'tank' && !onBridge) {
        // Everyone caught in the blast is thrown, including the ones it kills:
        // an explosion that only moved the survivors would look wrong.
        const push = BLAST_KNOCKBACK * falloff;
        const dx = unit.x - shot.x;
        const dy = unit.y - shot.y;
        const len = Math.max(0.01, Math.hypot(dx, dy));
        unit.x = Math.max(6, Math.min(WORLD_W - 6, unit.x + (dx / len) * push));
        unit.y = Math.max(6, Math.min(WORLD_H - 6, unit.y + (dy / len) * push));
        unit.shoved = 1;
        // Only the living are staggered by it.
        if (unit.hp > 0) unit.stagger = Math.max(unit.stagger, BLAST_STAGGER * falloff);
      }
    }

    const hitBase = this.baseAt(shot.x, shot.y, shot.side);
    if (hitBase) this.damageBase(hitBase, shot.damage * 0.6);
    this.emit({ type: 'explosion', side: shot.side });
  }

  private hitUnit(unit: Unit, damage: number, suppress: number): void {
    const stats = unitStats(unit.kind);
    // Armour, sandbags, a trench parapet and a searchlight silhouette all stack
    // here; the maths lives in `damage.ts` so it can be asserted directly.
    const applied = incomingDamage(damage, {
      armor: stats.armor,
      dugIn: unit.dugIn,
      dugInResist: stats.dugInResist,
      trenchCover: unit.trenchCover,
      illuminated: unit.illuminated,
      illuminatedDamageMultiplier: this.rules.illuminatedDamageMultiplier,
    });
    unit.hp -= applied;
    if (suppress > 0) unit.suppressed = Math.max(unit.suppressed, SUPPRESS_TIME);
    if (unit.hp <= 0) this.killUnit(unit);
  }

  private killUnit(unit: Unit): void {
    const stats = unitStats(unit.kind);
    this.corpsesValue.push({
      x: unit.x,
      y: unit.y,
      kind: unit.kind,
      side: unit.side,
      facing: unit.facing,
      life: CORPSE_LIFE,
      maxLife: CORPSE_LIFE,
      // Bodies topple away from the enemy.
      topple: unit.side === 'player' ? -1 : 1,
    });
    this.deathBurst(unit.x, unit.y, unit.kind);

    if (unit.side === 'enemy') {
      // War bonds drop for the player: the in-match currency for logistics.
      this.bondsValue += stats.bondDrop;
      this.statsValue.bondsCollected += stats.bondDrop;
      this.statsValue.kills += 1;
      this.dropBonds(unit.x, unit.y, stats.bondDrop);
      this.emit({ type: 'unitDown', kind: unit.kind, amount: stats.bondDrop, side: 'enemy' });
    } else {
      this.statsValue.losses += 1;
      this.emit({ type: 'playerUnitDown', kind: unit.kind, side: 'player' });
    }
    unit.hp = -1;
  }

  // -------------------------------------------------------------------- bases

  /** Timers, defensive guns and aim for every position, both sides. */
  private updateBases(dt: number): void {
    for (const base of this.basesValue) {
      base.flash = Math.max(0, base.flash - dt);
      base.hit = Math.max(0, base.hit - dt);
      base.cooldown = Math.max(0, base.cooldown - dt);
      base.gunCooldown = Math.max(0, base.gunCooldown - dt);
      if (base.destroyed) continue;
      if (this.statusValue !== 'running') continue;

      const target = this.nearestHostileUnitTo(base.x, base.y, base.side);
      if (!target) continue;
      const dx = target.x - base.x;
      const dy = target.y - base.y;
      const d = Math.hypot(dx, dy);
      if (d > BASE_GUN_RANGE) continue;
      base.aim = Math.atan2(dy, dx);
      if (base.gunCooldown > 0) continue;
      base.gunCooldown = 1 / BASE_GUN_FIRE_RATE;
      base.flash = MUZZLE_FLASH_TIME;
      const len = Math.max(0.01, d);
      this.projectilesValue.push({
        x: base.x + (dx / len) * BASE_FOOTPRINT * 0.7,
        y: base.y + (dy / len) * BASE_FOOTPRINT * 0.7,
        z: 18,
        vx: (dx / len) * BULLET_SPEED,
        vy: (dy / len) * BULLET_SPEED,
        vz: 0,
        damage: BASE_GUN_DAMAGE,
        kind: 'bullet',
        side: base.side,
        life: PROJECTILE_MAX_LIFE,
        suppress: 0,
        blast: 0,
      });
      // The emplacement gun is a heavy automatic: it shares the MG signature.
      this.emit({ type: 'shot', kind: 'mg', side: base.side });
    }
  }

  private nearestHostileUnitTo(x: number, y: number, side: Side): Unit | null {
    let best: Unit | null = null;
    let bestDistance = Infinity;
    for (const unit of this.unitsValue) {
      if (unit.side === side || unit.hp <= 0) continue;
      const d = distance(unit.x, unit.y, x, y);
      if (d < bestDistance) {
        bestDistance = d;
        best = unit;
      }
    }
    return best;
  }

  private damageBase(base: BaseState, amount: number): void {
    if (base.destroyed || base.hp <= 0) return;
    base.hp = Math.max(0, base.hp - amount);
    base.hit = 0.35;
    base.smoke = Math.min(1, 1 - base.hp / base.maxHp);
    if (base.side === 'enemy') this.statsValue.baseDamage += amount;
    this.emit({ type: 'baseHit', side: base.side });
    if (base.hp > 0) return;

    base.destroyed = true;
    base.smoke = 1;
    this.explosion(base.x, base.y, 60);
    this.shakeValue = Math.max(this.shakeValue, 10);
    this.emit({ type: 'baseDestroyed', side: base.side });
    if (base.side === 'enemy') this.statsValue.basesDestroyed += 1;
    else this.statsValue.basesLost += 1;

    // Take every position at once: losing the last one ends the battle.
    const sideAlive = this.basesValue.some((other) => other.side === base.side && !other.destroyed);
    if (sideAlive) return;
    this.finish(base.side === 'enemy' ? 'victory' : 'defeat', 'bases-destroyed');
  }

  /** How long this sector lasts: a survival battle is shorter than a battle. */
  private timeLimit(): number {
    return this.config.missionType === 'survive_timer' ? SURVIVE_SECONDS : MATCH_TIME_LIMIT;
  }

  private checkTimeLimit(): void {
    if (this.timeValue < this.timeLimit()) return;
    // Holding out to the clock *is* the objective in a survival battle.
    if (this.config.missionType === 'survive_timer') {
      this.finish('victory', 'time-expired');
      return;
    }
    const playerFraction = this.totalHpFraction('player');
    const enemyFraction = this.totalHpFraction('enemy');
    // The attacker has to actually take ground: a draw counts as a defeat.
    this.finish(enemyFraction < playerFraction ? 'victory' : 'defeat', 'time-expired');
  }

  private totalHpFraction(side: Side): number {
    let hp = 0;
    let max = 0;
    for (const base of this.basesValue) {
      if (base.side !== side) continue;
      hp += base.hp;
      max += base.maxHp;
    }
    return max > 0 ? hp / max : 0;
  }

  private finish(status: MatchStatus, reason: LossReason): void {
    if (this.statusValue !== 'running') return;
    this.statusValue = status;
    this.lossReasonValue = reason;
    this.emit({ type: status === 'victory' ? 'victory' : 'defeat' });
  }

  // ------------------------------------------------------------------ effects

  private updateFocus(dt: number): void {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const unit of this.unitsValue) {
      sumX += unit.x;
      sumY += unit.y;
      count += 1;
    }
    // With nothing in the field, frame the corridor between the rear areas
    // rather than snapping the camera back to the origin.
    const targetX = count > 0 ? sumX / count : WORLD_W / 2;
    const targetY = count > 0 ? sumY / count : WORLD_H / 2;
    const k = Math.min(1, dt * 2.4);
    this.focusXValue += (targetX - this.focusXValue) * k;
    this.focusYValue += (targetY - this.focusYValue) * k;
  }

  private updateEffects(dt: number): void {
    this.shakeValue = Math.max(0, this.shakeValue - SHAKE_DECAY * dt);

    for (const particle of this.particlesValue) {
      particle.life -= dt;
      particle.spin += particle.spinRate * dt;
      if (particle.life <= 0) continue;
      // Smoke rises and thins; everything else falls and settles.
      const gravity = particle.kind === 'smoke' ? -14 : PARTICLE_GRAVITY;
      particle.vz -= gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      if (particle.z <= 0) {
        particle.z = 0;
        // Debris and casings bounce and skid to a stop instead of sinking
        // through the ground.
        if (particle.kind === 'smoke') {
          particle.vz = 0;
        } else {
          particle.vz = -particle.vz * 0.32;
          particle.vx *= 0.55;
          particle.vy *= 0.55;
          particle.spinRate *= 0.6;
        }
      }
      if (particle.kind === 'smoke') {
        particle.vx *= 1 - 0.6 * dt;
        particle.vy *= 1 - 0.6 * dt;
      }
    }

    for (const corpse of this.corpsesValue) corpse.life -= dt;
  }

  /** Swap-remove anything finished, keeping the arrays dense for the renderer. */
  private compact(): void {
    compactInPlace(
      this.particlesValue,
      (p) => p.life > 0 && p.x > -80 && p.x < WORLD_W + 80 && p.y > -80 && p.y < WORLD_H + 80,
    );
    compactInPlace(this.corpsesValue, (c) => c.life > 0);
    compactInPlace(this.projectilesValue, (p) => p.life > 0);
    compactInPlace(
      this.unitsValue,
      (u) => u.hp > 0 && u.x > -60 && u.x < WORLD_W + 60 && u.y > -60 && u.y < WORLD_H + 60,
    );
  }

  private push(particle: Particle): void {
    if (this.particlesValue.length >= PARTICLE_CAP) return;
    this.particlesValue.push(particle);
  }

  private muzzleBurst(x: number, y: number, z: number, dx: number, dy: number): void {
    for (let i = 0; i < 3; i += 1) {
      const speed = 60 + i * 40;
      this.push(
        makeParticle(
          'spark',
          x,
          y,
          z,
          dx * speed + this.rng.range(-20, 20),
          dy * speed + this.rng.range(-20, 20),
          this.rng.range(-18, 12),
          0.12 + i * 0.02,
          1.6,
        ),
      );
    }
  }

  private smokePuff(x: number, y: number, z: number, dx: number, dy: number): void {
    for (let i = 0; i < 5; i += 1) {
      const speed = this.rng.range(24, 70);
      this.push(
        makeParticle(
          'smoke',
          x,
          y,
          z,
          dx * speed + this.rng.range(-12, 12),
          dy * speed + this.rng.range(-12, 12),
          this.rng.range(8, 42),
          this.rng.range(0.5, 1),
          this.rng.range(6, 12),
        ),
      );
    }
  }

  private ejectCasing(unit: Unit, muzzleX: number, muzzleY: number, z: number): void {
    // Brass flies out of the breech to the shooter's right — perpendicular to
    // the aim, which keeps the arc readable now that shots go in any direction.
    const rightX = -Math.sin(unit.heading);
    const rightY = Math.cos(unit.heading);
    const speed = this.rng.range(28, 55);
    this.push(
      makeParticle(
        'casing',
        muzzleX,
        muzzleY,
        z,
        rightX * speed,
        rightY * speed,
        this.rng.range(70, 120),
        this.rng.range(0.6, 0.9),
        2,
        this.rng.range(-14, 14),
        this.rng.range(-18, 18),
      ),
    );
  }

  private impactSparks(x: number, y: number, z: number): void {
    for (let i = 0; i < 4; i += 1) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(30, 130);
      this.push(
        makeParticle(
          'spark',
          x,
          y,
          z,
          Math.cos(angle) * speed * 0.4,
          Math.sin(angle) * speed * 0.4,
          this.rng.range(10, 70),
          this.rng.range(0.12, 0.3),
          1.4,
        ),
      );
    }
    this.push(
      makeParticle(
        'dust',
        x,
        y,
        z,
        this.rng.range(-14, 14),
        this.rng.range(-14, 14),
        this.rng.range(4, 26),
        this.rng.range(0.3, 0.55),
        this.rng.range(3, 6),
      ),
    );
  }

  private explosion(x: number, y: number, radius: number): void {
    // The flash goes in as a particle of its own so it is deterministic like
    // everything else: one bright frame-expanding core, then the dirt.
    this.push(
      makeParticle('flash', x, y, 6, 0, 0, 0, 0.18, radius * 0.45),
    );
    const count = Math.round(radius * 0.35);
    for (let i = 0; i < count; i += 1) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(40, 190);
      this.push(
        makeParticle(
          this.rng.chance(0.35) ? 'smoke' : 'dust',
          x,
          y,
          this.rng.range(0, 14),
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          this.rng.range(20, 110),
          this.rng.range(0.4, 1.1),
          this.rng.range(5, 14),
        ),
      );
    }
    for (let i = 0; i < 10; i += 1) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(80, 260);
      this.push(
        makeParticle(
          this.rng.chance(0.5) ? 'spark' : 'debris',
          x,
          y,
          this.rng.range(2, 12),
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          this.rng.range(60, 220),
          this.rng.range(0.3, 0.8),
          this.rng.range(1.6, 3.4),
          this.rng.range(-16, 16),
          this.rng.range(-20, 20),
        ),
      );
    }
  }

  private deathBurst(x: number, y: number, kind: UnitKind): void {
    const heavy = kind === 'tank';
    for (let i = 0; i < (heavy ? 16 : 6); i += 1) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(30, 90);
      this.push(
        makeParticle(
          heavy ? 'smoke' : 'blood',
          x + this.rng.range(-6, 6),
          y + this.rng.range(-6, 6),
          this.rng.range(2, 30),
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          this.rng.range(40, 140),
          this.rng.range(0.35, 0.9),
          heavy ? this.rng.range(6, 13) : this.rng.range(2, 4),
        ),
      );
    }
    if (heavy) {
      this.shakeValue = Math.max(this.shakeValue, 5);
      this.explosion(x, y, 48);
    }
  }

  private dropBonds(x: number, y: number, amount: number): void {
    const tokens = Math.min(6, Math.max(1, Math.round(amount / 4)));
    for (let i = 0; i < tokens; i += 1) {
      this.push(
        makeParticle(
          'bond',
          x + this.rng.range(-8, 8),
          y + this.rng.range(-8, 8),
          this.rng.range(18, 44),
          this.rng.range(-34, 34),
          this.rng.range(-34, 34),
          this.rng.range(70, 150),
          this.rng.range(0.7, 1.1),
          3.2,
          this.rng.range(-8, 8),
        ),
      );
    }
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
  }
}

/** In-place swap-remove, so the renderer can read the arrays every frame. */
function compactInPlace<T>(items: T[], keep: (item: T) => boolean): void {
  let write = 0;
  for (let read = 0; read < items.length; read += 1) {
    const item = items[read];
    if (item === undefined) continue;
    if (keep(item)) {
      items[write] = item;
      write += 1;
    }
  }
  items.length = write;
}
