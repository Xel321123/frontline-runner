/**
 * TugSimulation — the whole tug-of-war battle, as pure logic.
 *
 * No DOM, no canvas, no audio, no timers: `update(dt, command)` advances the
 * world by an exact fixed step, and the class reports what happened through
 * `takeEvents()`. That is what lets the identical code run in a browser frame
 * loop and in the headless balance harness (see `scripts/simulate-match.mjs`).
 *
 * Battlefield layout: the player base sits at the left edge (x = 50), the enemy
 * strongpoint at the right edge (x = 1230), and a single ground lane runs
 * between them. Units march toward the enemy, stop the moment a hostile is in
 * range, and trade fire until one side is gone.
 *
 * Game feel is part of the state: muzzle flashes, ejected casings, impact
 * sparks, smoke, corpses and the screen-shake amplitude are all simulation data,
 * so rendering stays a pure function of the simulation and the effects are
 * deterministic enough to assert on.
 */

import { createRng, type Rng } from './rng';
import { UNIT_STATS, unitStats, type UnitKind } from './units';
import type {
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
  BASE_GUN_DAMAGE,
  BASE_GUN_FIRE_RATE,
  BASE_GUN_RANGE,
  BASE_HALF_WIDTH,
  BASE_SPAWN_OFFSET,
  BASE_X,
  BLAST_KNOCKBACK,
  BLAST_STAGGER,
  BULLET_SPEED,
  CORPSE_LIFE,
  ENEMY_ARMOUR_DELAY,
  ENEMY_BASE_X,
  ENEMY_DEPLOY_JITTER,
  ENEMY_HP_PER_TIER_SCALE,
  GROUND_Y,
  HOLD_LINE_X,
  LOGISTICS_BASE_COST,
  LOGISTICS_COST_STEP,
  LOGISTICS_MAX_LEVEL,
  MATCH_TIME_LIMIT,
  MINE_DAMAGE,
  MINE_TRIGGER_RADIUS,
  MAX_UNITS_PER_SIDE,
  MUZZLE_FLASH_TIME,
  PARTICLE_CAP,
  PARTICLE_GRAVITY,
  PROJECTILE_MAX_LIFE,
  SHELL_GRAVITY,
  SHELL_SPEED,
  SHAKE_DECAY,
  SUPPRESSED_SPEED_MULTIPLIER,
  SUPPRESS_TIME,
  SURVIVE_SECONDS,
  TRENCH_OVERRUN_RANGE,
  SUPPLY_CAP,
  SUPPLY_PER_LOGISTICS_LEVEL,
  VIEW_WIDTH,
} from './constants';
import { incomingDamage } from './damage';
import {
  environmentRules,
  searchlightPositions,
  SEARCHLIGHT_HALF_WIDTH,
  type EnvironmentRules,
} from './environment';
import {
  bridgeAt,
  createFeatureLayout,
  recountBridges,
  trenchAt,
  type FeatureLayout,
} from './features';

/** In-match logistics upgrade cost for the next level. */
export function logisticsCost(level: number): number | null {
  if (level >= LOGISTICS_MAX_LEVEL) return null;
  return LOGISTICS_BASE_COST + LOGISTICS_COST_STEP * level;
}

function makeParticle(
  kind: ParticleKind,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  size: number,
  spin = 0,
): Particle {
  return { kind, x, y, vx, vy, life, maxLife: life, size, spin };
}

/** No beams at all — shared so a non-night battle allocates nothing per step. */
const EMPTY_BEAMS: readonly number[] = [];

export class TugSimulation {
  private readonly config: MatchConfig;
  private readonly rng: Rng;
  /** Weather and light rules for this sector. */
  private readonly rules: EnvironmentRules;
  /** Static terrain: dugouts, mine belts and bridge spans. */
  private readonly layout: FeatureLayout;
  private searchlightValue: readonly number[] = EMPTY_BEAMS;

  private statusValue: MatchStatus = 'running';
  private lossReasonValue: LossReason = null;
  private timeValue = 0;
  private suppliesValue: number;
  private bondsValue = 0;
  private logisticsLevelValue = 0;
  private enemySuppliesValue: number;
  private readonly deployCooldowns = new Map<UnitKind, number>();
  private enemyDeployTimer: number;
  private focusValue = VIEW_WIDTH / 2;
  private shakeValue = 0;
  private nextId = 1;
  private events: SimEvent[] = [];

  private readonly unitsValue: Unit[] = [];
  private readonly corpsesValue: Corpse[] = [];
  private readonly sandbagsValue: Sandbags[] = [];
  private readonly projectilesValue: Projectile[] = [];
  private readonly particlesValue: Particle[] = [];

  private readonly playerBase: BaseState;
  private readonly enemyBase: BaseState;
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
    this.enemyDeployTimer = 1.6;
    this.playerBase = {
      side: 'player',
      hp: config.playerBaseHp,
      maxHp: config.playerBaseHp,
      flash: 0,
      cooldown: 0.5,
      smoke: 0,
      hit: 0,
    };
    this.enemyBase = {
      side: 'enemy',
      hp: config.enemyBaseHp,
      maxHp: config.enemyBaseHp,
      flash: 0,
      cooldown: 0.5,
      smoke: 0,
      hit: 0,
    };
  }

  // ------------------------------------------------------------------ public

  get supplyRate(): number {
    return this.config.supplyBaseRate + SUPPLY_PER_LOGISTICS_LEVEL * this.logisticsLevelValue;
  }

  get state(): TugState {
    return {
      status: this.statusValue,
      lossReason: this.lossReasonValue,
      time: this.timeValue,
      timeLeft: Math.max(0, this.timeLimit() - this.timeValue),
      missionType: this.config.missionType,
      playerFaction: this.config.faction,
      enemyFaction: this.config.enemyFaction,
      tier: this.config.tier,
      environment: this.config.environment,
      searchlights: this.searchlightValue,
      features: this.layout,
      supplies: this.suppliesValue,
      supplyRate: this.supplyRate,
      bonds: this.bondsValue,
      logisticsLevel: this.logisticsLevelValue,
      logisticsCost: logisticsCost(this.logisticsLevelValue) ?? 0,
      playerBase: this.playerBase,
      enemyBase: this.enemyBase,
      units: this.unitsValue,
      corpses: this.corpsesValue,
      sandbags: this.sandbagsValue,
      projectiles: this.projectilesValue,
      particles: this.particlesValue,
      shake: this.shakeValue,
      focusX: this.focusValue,
      stats: this.statsValue,
      deployOptions: this.deployOptions(),
      enemySupplies: this.enemySuppliesValue,
      enemyUnits: this.countUnits('enemy'),
      playerUnits: this.countUnits('player'),
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
      this.handleCommand(dt, command);
      this.updateEnemyAI(dt);
      this.updateBattlefield();
      this.updateUnits(dt);
      this.updateBaseGuns(dt);
      this.updateProjectiles(dt);
      this.updateFocus(dt);
      this.checkTimeLimit();
    }
    this.updateEffects(dt);
    this.compact();
  }

  // ----------------------------------------------------------------- economy

  private updateEconomy(dt: number): void {
    const before = this.suppliesValue;
    this.suppliesValue = Math.min(SUPPLY_CAP, this.suppliesValue + this.supplyRate * dt);
    this.enemySuppliesValue =
      this.enemySuppliesValue + this.config.enemySupplyRate * dt;
    this.statsValue.suppliesGenerated += Math.max(0, this.suppliesValue - before);
  }

  private handleCommand(dt: number, command: MatchCommand): void {
    for (const [kind, remaining] of this.deployCooldowns) {
      if (remaining > 0) this.deployCooldowns.set(kind, Math.max(0, remaining - dt));
    }

    if (command.buyLogistics) {
      const cost = logisticsCost(this.logisticsLevelValue);
      if (cost !== null && this.bondsValue >= cost) {
        this.bondsValue -= cost;
        this.logisticsLevelValue += 1;
        this.statsValue.logisticsBought += 1;
        this.emit({ type: 'logisticsUpgrade', amount: this.logisticsLevelValue });
      }
    }

    if (command.deploy) {
      const kind = command.deploy;
      const cost = this.unitCostFor(kind);
      const ready = (this.deployCooldowns.get(kind) ?? 0) <= 0;
      if (this.suppliesValue >= cost && ready && this.countUnits('player') < MAX_UNITS_PER_SIDE) {
        this.suppliesValue -= cost;
        this.spawnUnit('player', kind);
        this.statsValue.deployed += 1;
        this.deployCooldowns.set(kind, unitStats(kind).deployCooldown);
        this.emit({ type: 'deploy', kind });
      }
    }
  }

  private deployOptions(): DeployOption[] {
    const options: DeployOption[] = [];
    const atCap = this.countUnits('player') >= MAX_UNITS_PER_SIDE;
    for (const kind of ['rifleman', 'smg', 'mg', 'tank'] as UnitKind[]) {
      const stats = UNIT_STATS[kind];
      const cost = this.unitCostFor(kind);
      const cooldown = this.deployCooldowns.get(kind) ?? 0;
      const affordable = this.suppliesValue >= cost;
      options.push({
        kind,
        name: stats.name,
        cost,
        affordable,
        // `ready` is what the button acts on: affordable, off cooldown, not capped.
        ready: affordable && cooldown <= 0 && !atCap,
        cooldown,
        cooldownTotal: stats.deployCooldown,
      });
    }
    return options;
  }

  // -------------------------------------------------------------------- enemy

  private updateEnemyAI(dt: number): void {
    this.enemyDeployTimer -= dt;
    if (this.enemyDeployTimer > 0) return;

    if (this.countUnits('enemy') >= MAX_UNITS_PER_SIDE) {
      this.enemyDeployTimer = 1;
      return;
    }

    // No armour in the opening minute: it gives the player time to establish a
    // line, and it stops a lucky early roll from deciding the whole battle.
    const armourUnlocked = this.timeValue >= ENEMY_ARMOUR_DELAY;
    const affordable = this.config.enemyMix.filter(
      (entry) =>
        (armourUnlocked || entry.kind !== 'tank') &&
        this.unitCostFor(entry.kind) <= this.enemySuppliesValue,
    );
    if (affordable.length === 0) {
      this.enemyDeployTimer = 0.5;
      return;
    }

    // Save for armour. An army that always spends on the cheapest body never
    // fields a tank — which made the late-war sectors fight like 1941 — so while
    // the sector wants armour and the enemy has less than its quota, it banks
    // supplies instead of buying another rifleman.
    const tankCost = this.unitCostFor('tank');
    const wantsArmour =
      armourUnlocked && this.config.enemyMix.some((entry) => entry.kind === 'tank');
    // Only bank for armour while the line is manned, and never in a hold
    // mission: there the clock is the enemy's weapon and it has to keep
    // pressing rather than saving.
    const lineHeld = this.countUnits('enemy') >= 3;
    const keepsPressing = this.config.missionType !== 'survive_timer';
    if (wantsArmour && lineHeld && keepsPressing) {
      // One tank at a time: enough to make armour a real threat without
      // starving the infantry line that protects it.
      const tanks = this.unitsValue.filter(
        (unit) => unit.side === 'enemy' && unit.kind === 'tank',
      ).length;
      if (tanks < 1 && this.enemySuppliesValue < tankCost) {
        this.enemyDeployTimer = 0.7;
        return;
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
    this.enemySuppliesValue -= this.unitCostFor(kind);
    this.spawnUnit('enemy', kind);
    this.emit({ type: 'enemyDeploy', kind });
    this.enemyDeployTimer =
      this.config.enemyDeployInterval + this.rng.range(0, ENEMY_DEPLOY_JITTER);
  }

  // -------------------------------------------------------------------- units

  private spawnUnit(side: Side, kind: UnitKind): Unit {
    const stats = unitStats(kind);
    const facing: 1 | -1 = side === 'player' ? 1 : -1;
    // Enemy units scale with the campaign tier; the player's scale with the
    // armory's Unit Health track instead.
    const hpScale =
      side === 'enemy'
        ? 1 + (this.config.tier - 1) * ENEMY_HP_PER_TIER_SCALE
        : this.config.unitHpMultiplier;
    const maxHp = stats.hp * hpScale;
    const unit: Unit = {
      id: this.nextId,
      side,
      kind,
      x: side === 'player' ? BASE_X + BASE_SPAWN_OFFSET : ENEMY_BASE_X - BASE_SPAWN_OFFSET,
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
      facing,
      hpScale,
    };
    this.nextId += 1;
    this.unitsValue.push(unit);
    return unit;
  }

  // ----------------------------------------------------- environment & terrain

  /**
   * Engagement range after weather, plus this unit's own stagger: without it
   * every rifleman would stop on exactly the same pixel and the line would
   * stack into a blob. The jitter is drawn from the seeded RNG, so a node still
   * plays out identically every time.
   */
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
   * this, "hold the line" missions turned into an advance across the player's
   * own minefield.
   */
  private holdsLine(unit: Unit): boolean {
    if (this.config.missionType !== 'survive_timer' || unit.side !== 'player') return false;
    return unit.x >= HOLD_LINE_X;
  }

  /** A bridge span only holds so many units of one side at a time. */
  private isBridgeFull(unit: Unit): boolean {
    const bridge = bridgeAt(this.layout, unit.x + unit.facing * 6);
    if (!bridge) return false;
    return bridge.occupants[unit.side] >= bridge.capacity;
  }

  /**
   * Terrain and light, once per step: who is dug into a trench, who is caught
   * in a searchlight beam, and what has just walked onto a buried mine.
   */
  private updateBattlefield(): void {
    recountBridges(this.layout, this.unitsValue);
    this.searchlightValue = this.rules.searchlights
      ? searchlightPositions(this.timeValue)
      : EMPTY_BEAMS;

    for (const unit of this.unitsValue) {
      const stopped = unit.state !== 'advance';
      // Only infantry use dugouts, and only while they are standing in one.
      const trench = unit.kind === 'tank' ? null : trenchAt(this.layout, unit.x);
      unit.trenchCover = Boolean(trench && stopped && trench.overrunBy === null);

      if (trench && !trench.overrunBy && stopped) {
        // A trench stops being cover the moment both sides are inside it.
        const contested = this.unitsValue.some(
          (other) =>
            other.side !== unit.side &&
            Math.abs(other.x - trench.x) <= trench.width / 2 + TRENCH_OVERRUN_RANGE,
        );
        if (contested) {
          trench.overrunBy = unit.side === 'player' ? 'enemy' : 'player';
          unit.trenchCover = false;
          this.emit({ type: 'trenchOverrun' });
        }
      }

      unit.illuminated = this.rules.searchlights
        ? this.searchlightValue.some((beam) => Math.abs(beam - unit.x) <= SEARCHLIGHT_HALF_WIDTH)
        : false;
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
          if (Math.abs(unit.x - mine.x) > MINE_TRIGGER_RADIUS) continue;
          mine.exploded = true;
          belt.armed -= 1;
          if (unit.side === 'player') this.statsValue.minesHit += 1;
          else this.statsValue.enemyMinesHit += 1;
          this.explosion(unit.x, GROUND_Y - 8, 26);
          this.shakeValue = Math.max(this.shakeValue, 5);
          this.emit({ type: 'mineBlast' });
          // A mine is a burst of casualties, armoured or not.
          this.hitUnit(unit, MINE_DAMAGE, 0);
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

      if (unit.stagger > 0) {
        unit.stagger = Math.max(0, unit.stagger - dt);
        unit.shoved = Math.max(0, unit.shoved - dt * 1.6);
        continue;
      }
      unit.shoved = Math.max(0, unit.shoved - dt * 1.6);
      const target = this.findTarget(unit);
      // Sandstorms and the like cut the range at which anyone can engage.
      if (target && Math.abs(target - unit.x) <= this.unitRange(unit)) {
        unit.state = 'engage';
        // Machine gunners dig in where they stop and gain cover.
        if (stats.digTime !== undefined) {
          unit.dig += dt;
          if (!unit.dugIn && unit.dig >= stats.digTime) {
            unit.dugIn = true;
            this.sandbagsValue.push({ x: unit.x, side: unit.side });
          }
        }
        unit.cooldown -= dt;
        if (unit.cooldown <= 0) this.fire(unit, target);
      } else {
        unit.state = 'advance';
        if (unit.dugIn) {
          // Moving on abandons the position; the bags stay as scenery.
          unit.dugIn = false;
          unit.dig = 0;
        }
        // Units walk past each other to their own firing distance — a queue in
        // single file would mean only the front man ever shoots. A bridge span
        // is the one place they really cannot pass: it is a chokepoint.
        // Holding a line is a state, not merely a blocked advance: a defender
        // waiting on its line counts as stopped, and so takes trench cover.
        if (this.holdsLine(unit)) {
          unit.state = 'hold';
        } else if (!this.isBridgeFull(unit)) {
          unit.x += unit.facing * this.unitSpeed(unit) * dt;
        }
      }

      // Never walk into the enemy structure or off the battlefield.
      const limit = stats.radius + BASE_HALF_WIDTH + 4;
      unit.x =
        unit.side === 'player'
          ? Math.min(ENEMY_BASE_X - limit, Math.max(BASE_X + limit, unit.x))
          : Math.max(BASE_X + limit, Math.min(ENEMY_BASE_X - limit, unit.x));
    }
  }

  /** The nearest hostile x within reach: a unit first, then the enemy structure. */
  private findTarget(unit: Unit): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const other of this.unitsValue) {
      if (other.side === unit.side) continue;
      const distance = Math.abs(other.x - unit.x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = other.x;
      }
    }
    const baseX = unit.side === 'player' ? ENEMY_BASE_X : BASE_X;
    const baseDistance = Math.abs(baseX - unit.x);
    if (baseDistance < bestDistance) return baseX;
    return best;
  }

  private fire(unit: Unit, targetX: number): void {
    const stats = unitStats(unit.kind);
    const rate =
      stats.fireRate;
    unit.cooldown = 1 / rate;
    unit.flash = MUZZLE_FLASH_TIME;
    unit.recoil = 1;

    const damage =
      stats.damage * (unit.side === 'player' ? this.config.damageMultiplier : 1);
    const muzzleX = unit.x + unit.facing * (stats.radius + 6);

    if (stats.projectile === 'shell') {
      // Lob it: solve the launch velocity so the shell lands on the ground line
      // at the target, which is what makes the arc read as artillery.
      const target = targetX + unit.facing * 10;
      const dx = target - muzzleX;
      const flight = Math.max(0.35, Math.abs(dx) / SHELL_SPEED);
      const muzzleY = GROUND_Y - stats.height * 0.72;
      const dy = GROUND_Y - muzzleY;
      const vx = dx / flight;
      const vy = (dy - 0.5 * SHELL_GRAVITY * flight * flight) / flight;
      this.projectilesValue.push({
        x: muzzleX,
        y: muzzleY,
        vx,
        vy,
        damage,
        kind: 'shell',
        side: unit.side,
        life: PROJECTILE_MAX_LIFE,
        suppress: 0,
        blast: stats.blast ?? 70,
      });
      this.ejectCasing(unit, muzzleX);
      this.smokePuff(muzzleX, muzzleY, unit.facing);
      this.shakeValue = Math.max(this.shakeValue, 2.2);
      this.emit({ type: 'shell', kind: unit.kind });
      return;
    }

    const muzzleY = GROUND_Y - stats.height * 0.62;
    for (let shot = 0; shot < stats.roundsPerVolley; shot += 1) {
      this.projectilesValue.push({
        x: muzzleX,
        y: muzzleY + (shot - (stats.roundsPerVolley - 1) / 2) * 2,
        vx: unit.facing * BULLET_SPEED,
        vy: 0,
        damage,
        kind: 'bullet',
        side: unit.side,
        life: PROJECTILE_MAX_LIFE,
        suppress: stats.suppression ?? 0,
        blast: 0,
      });
    }
    this.muzzleBurst(muzzleX, muzzleY, unit.facing);
    this.ejectCasing(unit, muzzleX);
    this.emit({ type: 'shot', kind: unit.kind });
  }

  // -------------------------------------------------------------- projectiles

  private updateProjectiles(dt: number): void {
    for (const shot of this.projectilesValue) {
      if (shot.life <= 0) continue;
      shot.life -= dt;
      shot.x += shot.vx * dt;
      if (shot.kind === 'shell') {
        shot.vy += SHELL_GRAVITY * dt;
        shot.y += shot.vy * dt;
        if (shot.y >= GROUND_Y) {
          shot.y = GROUND_Y;
          this.detonate(shot);
          shot.life = 0;
          continue;
        }
      }

      const victim = this.unitAt(shot.x, shot.side);
      if (victim) {
        if (shot.kind === 'shell') {
          this.detonate(shot);
        } else {
          this.hitUnit(victim, shot.damage, shot.suppress);
          this.impactSparks(shot.x, shot.y, shot.vx > 0 ? 1 : -1);
          this.emit({ type: 'impact', metal: victim.kind === 'tank' });
        }
        shot.life = 0;
        continue;
      }

      if (this.reachesBase(shot)) {
        this.damageBase(shot.side === 'player' ? 'enemy' : 'player', shot.damage);
        if (shot.kind === 'shell') this.detonate(shot, true);
        else this.impactSparks(shot.x, shot.y, shot.vx > 0 ? 1 : -1);
        shot.life = 0;
      }
    }
  }

  /** The first hostile in the lane the round passes through. */
  private unitAt(x: number, side: Side): Unit | null {
    for (const unit of this.unitsValue) {
      if (unit.side === side) continue;
      const stats = unitStats(unit.kind);
      if (Math.abs(unit.x - x) <= stats.radius + 3) return unit;
    }
    return null;
  }

  private reachesBase(shot: Projectile): boolean {
    if (shot.side === 'player') return shot.x >= ENEMY_BASE_X - BASE_HALF_WIDTH;
    return shot.x <= BASE_X + BASE_HALF_WIDTH;
  }

  /** Tank shell: area damage with falloff, plus dust, smoke and a screen shake. */
  private detonate(shot: Projectile, atBase = false): void {
    const radius = shot.blast > 0 ? shot.blast : 70;
    this.explosion(shot.x, shot.kind === 'shell' ? Math.min(shot.y, GROUND_Y) : shot.y, radius);
    this.shakeValue = Math.max(this.shakeValue, 7);

    for (const unit of this.unitsValue) {
      if (unit.side === shot.side) continue;
      const distance = Math.abs(unit.x - shot.x);
      if (distance > radius) continue;
      const falloff = 1 - 0.6 * (distance / radius);
      this.hitUnit(unit, shot.damage * falloff, 0);
      // Armour shrugs off the shockwave; infantry gets thrown backwards —
      // except on a bridge, where the parapet takes the push and a blast cannot
      // sweep the attackers back off the span.
      const onBridge = bridgeAt(this.layout, unit.x) !== null;
      if (unit.kind !== 'tank' && !onBridge) {
        // Everyone caught in the blast is thrown, including the ones it kills:
        // an explosion that only moved the survivors would look wrong.
        const push = BLAST_KNOCKBACK * falloff;
        unit.x = Math.max(
          BASE_X + BASE_SPAWN_OFFSET,
          Math.min(ENEMY_BASE_X - BASE_SPAWN_OFFSET, unit.x + Math.sign(unit.x - shot.x || 1) * push),
        );
        unit.shoved = 1;
        // Only the living are staggered by it.
        if (unit.hp > 0) unit.stagger = Math.max(unit.stagger, BLAST_STAGGER * falloff);
      }
    }

    if (atBase) {
      const targetSide: Side = shot.side === 'player' ? 'enemy' : 'player';
      const baseX = targetSide === 'enemy' ? ENEMY_BASE_X : BASE_X;
      if (Math.abs(baseX - shot.x) <= radius + BASE_HALF_WIDTH) {
        this.damageBase(targetSide, shot.damage * 0.6);
      }
    }
    this.emit({ type: 'explosion' });
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
      kind: unit.kind,
      side: unit.side,
      facing: unit.facing,
      life: CORPSE_LIFE,
      maxLife: CORPSE_LIFE,
      // Bodies topple away from the enemy and the helmet is knocked off.
      topple: unit.side === 'player' ? -1 : 1,
      helmetX: unit.x,
      helmetY: GROUND_Y - unitStats(unit.kind).height * 0.82,
      helmetVx: (unit.side === 'player' ? -1 : 1) * this.rng.range(26, 48),
      helmetVy: this.rng.range(-140, -96),
    });
    this.deathBurst(unit.x, unit.kind);

    if (unit.side === 'enemy') {
      // War bonds drop for the player: the in-match currency for logistics.
      this.bondsValue += stats.bondDrop;
      this.statsValue.bondsCollected += stats.bondDrop;
      this.statsValue.kills += 1;
      this.dropBonds(unit.x, stats.bondDrop);
      this.emit({ type: 'unitDown', kind: unit.kind, amount: stats.bondDrop });
    } else {
      this.statsValue.losses += 1;
      this.emit({ type: 'playerUnitDown', kind: unit.kind });
    }
    unit.hp = -1;
  }

  // -------------------------------------------------------------------- bases

  private updateBaseGuns(dt: number): void {
    for (const base of [this.playerBase, this.enemyBase]) {
      base.flash = Math.max(0, base.flash - dt);
      base.hit = Math.max(0, base.hit - dt);
      base.cooldown = Math.max(0, base.cooldown - dt);
      if (this.statusValue !== 'running') continue;

      const side = base.side;
      const gunX = side === 'player' ? BASE_X + BASE_HALF_WIDTH : ENEMY_BASE_X - BASE_HALF_WIDTH;
      const target = this.nearestHostileTo(gunX, side);
      if (target === null) continue;
      if (Math.abs(target - gunX) > BASE_GUN_RANGE) continue;
      if (base.cooldown > 0) continue;
      base.cooldown = 1 / BASE_GUN_FIRE_RATE;
      base.flash = MUZZLE_FLASH_TIME;
      this.projectilesValue.push({
        x: gunX + (side === 'player' ? 10 : -10),
        y: GROUND_Y - 44,
        vx: (side === 'player' ? 1 : -1) * BULLET_SPEED,
        vy: 0,
        damage: BASE_GUN_DAMAGE,
        kind: 'bullet',
        side,
        life: PROJECTILE_MAX_LIFE,
        suppress: 0,
        blast: 0,
      });
      // The emplacement gun is a heavy automatic: it shares the MG signature.
      this.emit({ type: 'shot', kind: 'mg' });
    }
  }

  private nearestHostileTo(x: number, side: Side): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const unit of this.unitsValue) {
      if (unit.side === side) continue;
      const distance = Math.abs(unit.x - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = unit.x;
      }
    }
    return best;
  }

  private damageBase(side: Side, amount: number): void {
    const base = side === 'player' ? this.playerBase : this.enemyBase;
    if (base.hp <= 0) return;
    base.hp = Math.max(0, base.hp - amount);
    base.hit = 0.35;
    base.smoke = Math.min(1, 1 - base.hp / base.maxHp);
    if (side === 'enemy') this.statsValue.baseDamage += amount;
    this.emit({ type: 'baseHit' });
    if (base.hp <= 0) {
      this.emit({ type: 'baseDestroyed' });
      this.shakeValue = Math.max(this.shakeValue, 10);
      this.finish(side === 'enemy' ? 'victory' : 'defeat', 'base-destroyed');
    }
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
    const playerFraction = this.playerBase.hp / this.playerBase.maxHp;
    const enemyFraction = this.enemyBase.hp / this.enemyBase.maxHp;
    // The attacker has to actually take ground: a draw counts as a defeat.
    this.finish(enemyFraction < playerFraction ? 'victory' : 'defeat', 'time-expired');
  }

  private finish(status: MatchStatus, reason: LossReason): void {
    if (this.statusValue !== 'running') return;
    this.statusValue = status;
    this.lossReasonValue = reason;
    this.emit({ type: status === 'victory' ? 'victory' : 'defeat' });
  }

  // ------------------------------------------------------------------ effects

  private updateFocus(dt: number): void {
    let sum = 0;
    let count = 0;
    for (const unit of this.unitsValue) {
      sum += unit.x;
      count += 1;
    }
    const target = count > 0 ? sum / count : VIEW_WIDTH / 2;
    const k = Math.min(1, dt * 2.4);
    this.focusValue += (target - this.focusValue) * k;
  }

  private updateEffects(dt: number): void {
    this.shakeValue = Math.max(0, this.shakeValue - SHAKE_DECAY * dt);

    for (const particle of this.particlesValue) {
      particle.life -= dt;
      if (particle.life <= 0) continue;
      const gravity = particle.kind === 'smoke' ? -18 : PARTICLE_GRAVITY * 0.5;
      particle.vy += gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      if (particle.kind === 'smoke') particle.vx *= 1 - 0.6 * dt;
    }

    for (const corpse of this.corpsesValue) corpse.life -= dt;
  }

  /** Swap-remove anything finished, keeping the arrays dense for the renderer. */
  private compact(): void {
    compactInPlace(this.particlesValue, (p) => p.life > 0 && p.y < GROUND_Y + 40);
    compactInPlace(this.corpsesValue, (c) => c.life > 0);
    compactInPlace(this.projectilesValue, (p) => p.life > 0);
    compactInPlace(
      this.unitsValue,
      (u) => u.hp > 0 && u.x > -60 && u.x < VIEW_WIDTH + 60,
    );
  }

  private push(particle: Particle): void {
    if (this.particlesValue.length >= PARTICLE_CAP) return;
    this.particlesValue.push(particle);
  }

  private muzzleBurst(x: number, y: number, facing: 1 | -1): void {
    for (let i = 0; i < 3; i += 1) {
      this.push(
        makeParticle(
          'spark',
          x,
          y,
          facing * (60 + i * 40) + this.rng.range(-20, 20),
          this.rng.range(-40, 10),
          0.12 + i * 0.02,
          1.6,
        ),
      );
    }
  }

  private smokePuff(x: number, y: number, facing: 1 | -1): void {
    for (let i = 0; i < 5; i += 1) {
      this.push(
        makeParticle(
          'smoke',
          x,
          y,
          facing * this.rng.range(30, 90),
          this.rng.range(-45, -8),
          this.rng.range(0.5, 1),
          this.rng.range(6, 12),
        ),
      );
    }
  }

  private ejectCasing(unit: Unit, muzzleX: number): void {
    const stats = unitStats(unit.kind);
    this.push(
      makeParticle(
        'casing',
        muzzleX - unit.facing * 4,
        GROUND_Y - stats.height * 0.6,
        -unit.facing * this.rng.range(28, 55),
        this.rng.range(-120, -70),
        this.rng.range(0.6, 0.9),
        2,
        this.rng.range(-14, 14),
      ),
    );
  }

  private impactSparks(x: number, y: number, direction: number): void {
    for (let i = 0; i < 4; i += 1) {
      this.push(
        makeParticle(
          'spark',
          x,
          y,
          direction * this.rng.range(30, 130) * -0.4,
          this.rng.range(-70, 10),
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
        this.rng.range(-14, 14),
        this.rng.range(-24, -4),
        this.rng.range(0.3, 0.55),
        this.rng.range(3, 6),
      ),
    );
  }

  private explosion(x: number, y: number, radius: number): void {
    const count = Math.round(radius * 0.35);
    for (let i = 0; i < count; i += 1) {
      const angle = this.rng.range(0, Math.PI * 2);
      const speed = this.rng.range(40, 190);
      this.push(
        makeParticle(
          this.rng.chance(0.35) ? 'smoke' : 'dust',
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed - 40,
          this.rng.range(0.4, 1.1),
          this.rng.range(5, 14),
        ),
      );
    }
    for (let i = 0; i < 10; i += 1) {
      const angle = this.rng.range(-Math.PI, 0);
      const speed = this.rng.range(80, 260);
      this.push(
        makeParticle(
          this.rng.chance(0.5) ? 'spark' : 'debris',
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          this.rng.range(0.3, 0.8),
          this.rng.range(1.6, 3.4),
          this.rng.range(-16, 16),
        ),
      );
    }
  }

  private deathBurst(x: number, kind: UnitKind): void {
    const heavy = kind === 'tank';
    for (let i = 0; i < (heavy ? 16 : 6); i += 1) {
      this.push(
        makeParticle(
          heavy ? 'smoke' : 'blood',
          x + this.rng.range(-6, 6),
          GROUND_Y - this.rng.range(6, 30),
          this.rng.range(-70, 70),
          this.rng.range(-110, -30),
          this.rng.range(0.35, 0.9),
          heavy ? this.rng.range(6, 13) : this.rng.range(2, 4),
        ),
      );
    }
    if (heavy) {
      this.shakeValue = Math.max(this.shakeValue, 5);
      this.explosion(x, GROUND_Y - 18, 60);
    }
  }

  private dropBonds(x: number, amount: number): void {
    const tokens = Math.min(6, Math.max(1, Math.round(amount / 4)));
    for (let i = 0; i < tokens; i += 1) {
      this.push(
        makeParticle(
          'bond',
          x + this.rng.range(-8, 8),
          GROUND_Y - this.rng.range(18, 44),
          this.rng.range(-40, 40),
          this.rng.range(-130, -80),
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
