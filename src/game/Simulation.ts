/**
 * Simulation — the whole side-scrolling runner, as pure logic.
 *
 * No DOM, no canvas, no audio, no timers: `update(dt, input)` advances the
 * world by an exact fixed step and the class reports what happened through
 * `takeEvents()`. That is what makes the run playable in a browser *and*
 * runnable headlessly in Node for balance and regression checks.
 *
 * Coordinate model: entities live in **world space** (x grows to the right as
 * the squad advances). The camera shows `scrollX … scrollX + 1280`, the squad
 * is pinned at world x = `scrollX + SQUAD_X`, and the renderer converts to
 * screen space by subtracting `scrollX`.
 */

import {
  BASE_SQUAD,
  BOSS_HEIGHT,
  BOSS_TIME_LIMIT,
  BOSS_WIDTH,
  CRATE_SHOT_GAIN,
  CRATE_SIZE,
  CRATE_VALUE_CAP,
  FIXED_DT,
  GATE_ADD_CAP,
  GATE_DIVISOR_LADDER,
  GATE_MULTIPLIER_LADDER,
  GATE_SHOT_STEP,
  INFANTRY_RADIUS,
  INFANTRY_TROOP_LOSS,
  MAX_MUZZLES,
  MINE_RADIUS,
  MINE_TROOP_LOSS,
  POPUP_LIFE,
  POPUP_RISE,
  PROJECTILE_RADIUS,
  PROJECTILE_SPEED,
  SCROLL_SPEED,
  SQUAD_BAND_HEIGHT,
  SQUAD_BAND_WIDTH,
  SQUAD_LERP_RATE,
  SQUAD_X,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  WIRE_TROOP_LOSS_PER_SECOND,
} from './constants';
import type { LevelPlan } from './types';
import type {
  Crate,
  Gate,
  GateOp,
  Infantry,
  Mine,
  Popup,
  Projectile,
  RunStats,
  RunStatus,
  SimConfig,
  SimEvent,
  SimState,
  LossReason,
  RunPhase,
  Wire,
} from './types';

export interface SimInput {
  /** Where the player wants the squad, in logical units. */
  readonly targetY: number;
}

const REVIVE_TROOPS = BASE_SQUAD;
/** Vertical drift scaling: spread degrees → px/s of drift. */
const SPREAD_DRIFT = 40;
/** Cap so a pathological frame can never spawn an unbounded volley. */
const MAX_PROJECTILES = 700;

export class Simulation {
  private readonly plan: LevelPlan;
  private readonly config: SimConfig;

  private statusValue: RunStatus = 'running';
  private lossReasonValue: LossReason | null = null;
  private phaseValue: RunPhase = 'advance';
  private troopsValue: number;
  private revivesLeft: number;
  private squadYValue: number;
  private scrollXValue = 0;
  private fireTimer = 0;
  private timeValue = 0;
  private bossHpValue: number;
  private bossTimeLeftValue = BOSS_TIME_LIMIT;
  private shotCounter = 0;

  private readonly projectiles: Projectile[] = [];
  private readonly crates: Crate[] = [];
  private readonly mines: Mine[] = [];
  private readonly wires: Wire[] = [];
  private readonly infantry: Infantry[] = [];
  private readonly gates: Gate[] = [];
  private readonly popups: Popup[] = [];
  private readonly spawnCursor = { index: 0 };

  private readonly statsValue: RunStats = {
    volleys: 0,
    shotsFired: 0,
    kills: 0,
    cratesCollected: 0,
    troopsFromCrates: 0,
    gateGains: 0,
    gateLosses: 0,
    troopsLost: 0,
    minesHit: 0,
    distance: 0,
  };

  private events: SimEvent[] = [];

  constructor(plan: LevelPlan, config: SimConfig) {
    this.plan = plan;
    this.config = config;
    this.troopsValue = Math.max(1, Math.min(config.maxTroops, config.startingTroops));
    this.revivesLeft = config.revives;
    this.squadYValue = VIEW_HEIGHT / 2;
    this.bossHpValue = plan.bossMaxHp;
  }

  // ------------------------------------------------------------------ public

  get state(): SimState {
    return {
      status: this.statusValue,
      lossReason: this.lossReasonValue,
      phase: this.phaseValue,
      troops: this.troopsValue,
      revivesLeft: this.revivesLeft,
      squadWorldX: this.squadWorldX,
      squadY: this.squadYValue,
      scrollX: this.scrollXValue,
      progress: this.plan.totalScroll > 0 ? this.scrollXValue / this.plan.totalScroll : 0,
      time: this.timeValue,
      bossWorldX: this.plan.bunkerX,
      bossMaxHp: this.plan.bossMaxHp,
      bossHp: this.bossHpValue,
      bossTimeLeft: Math.max(0, this.bossTimeLeftValue),
      bossName: this.plan.bossName,
      projectiles: this.projectiles,
      crates: this.crates,
      mines: this.mines,
      infantry: this.infantry,
      wires: this.wires,
      gates: this.gates,
      popups: this.popups,
      stats: this.statsValue,
    };
  }

  get planRef(): LevelPlan {
    return this.plan;
  }

  /** Drain the events produced since the last call. */
  takeEvents(): SimEvent[] {
    if (this.events.length === 0) return [];
    const drained = this.events;
    this.events = [];
    return drained;
  }

  /** One fixed step. `dt` should always be FIXED_DT; other values are for tests. */
  update(dt: number, input: SimInput): void {
    this.timeValue += dt;
    this.decayEffects(dt);

    if (this.statusValue === 'running') {
      this.spawnAhead();
      if (this.phaseValue === 'advance') this.advance(dt);
      this.steer(dt, input.targetY);
      this.fire(dt);
      this.moveProjectiles(dt);
      this.moveInfantry(dt);
      this.resolveProjectileHits();
      this.resolveHazards(dt);
      this.resolvePasses();
      if (this.phaseValue === 'boss') this.updateBoss(dt);
      if (this.statusValue === 'running') this.checkDefeat();
    }

    this.cull();
  }

  // ------------------------------------------------------------------ phases

  private advance(dt: number): void {
    this.scrollXValue = Math.min(
      this.plan.totalScroll,
      this.scrollXValue + SCROLL_SPEED * dt,
    );
    this.statsValue.distance = this.scrollXValue;
    if (this.scrollXValue >= this.plan.totalScroll) {
      this.phaseValue = 'boss';
      this.bossTimeLeftValue = BOSS_TIME_LIMIT;
      this.pushPopup(this.bossScreenX, VIEW_HEIGHT / 2 - 140, `${this.plan.bossName} ENGAGED`, 'info');
      this.emit({ type: 'bossPhase' });
    }
  }

  private updateBoss(dt: number): void {
    if (this.bossHpValue <= 0) {
      this.bossHpValue = 0;
      this.statusValue = 'won';
      this.pushPopup(this.bossScreenX, VIEW_HEIGHT / 2 - 160, 'SECTOR CLEARED', 'gain');
      this.emit({ type: 'bossDestroyed' });
      return;
    }
    this.bossTimeLeftValue -= dt;
    if (this.bossTimeLeftValue <= 0) {
      this.bossTimeLeftValue = 0;
      this.statusValue = 'lost';
      this.lossReasonValue = 'time-expired';
      this.emit({ type: 'defeat' });
    }
  }

  private checkDefeat(): void {
    if (this.troopsValue > 0) return;
    if (this.revivesLeft > 0) {
      this.revivesLeft -= 1;
      this.troopsValue = REVIVE_TROOPS;
      this.pushPopup(SQUAD_X, this.squadYValue - 60, 'REINFORCED', 'gain');
      this.emit({ type: 'revive', amount: REVIVE_TROOPS });
      return;
    }
    this.troopsValue = 0;
    this.statusValue = 'lost';
    this.lossReasonValue = 'squad-wiped';
    this.emit({ type: 'defeat' });
  }

  // ------------------------------------------------------------------ squad

  private get squadWorldX(): number {
    return this.scrollXValue + SQUAD_X;
  }

  private get bossScreenX(): number {
    return this.plan.bunkerX - this.scrollXValue;
  }

  private get bossY(): number {
    return VIEW_HEIGHT - BOSS_HEIGHT / 2 - 40;
  }

  private steer(dt: number, targetY: number): void {
    const half = SQUAD_BAND_HEIGHT / 2;
    const clamped = Math.min(VIEW_HEIGHT - half, Math.max(half, targetY));
    // Frame-rate independent exponential smoothing (the "lerp" to the pointer).
    const k = 1 - Math.exp(-SQUAD_LERP_RATE * dt);
    this.squadYValue += (clamped - this.squadYValue) * k;
  }

  private fire(dt: number): void {
    const interval = Math.max(0.05, this.config.fireInterval);
    this.fireTimer += dt;
    let volleys = 0;
    while (this.fireTimer >= interval && volleys < 4) {
      this.fireTimer -= interval;
      volleys += 1;
      this.fireVolley();
    }
  }

  /**
   * One volley = one shot per drawn muzzle. Above `MAX_MUZZLES` the extra
   * troops fold into per-shot damage, so DPS always scales with squad size
   * without spawning hundreds of entities.
   */
  private fireVolley(): void {
    const muzzles = Math.min(this.troopsValue, MAX_MUZZLES);
    if (muzzles <= 0) return;

    const damagePerShot = this.config.damagePerTroop * (this.troopsValue / muzzles);
    const band = SQUAD_BAND_HEIGHT * 0.78;
    const originX = this.squadWorldX + 16;

    // In the end zone the squad aims at the objective: rounds converge on the
    // bunker band instead of flying flat, so the timer measures DPS rather than
    // whether the player happened to be aligned. Weapon spread becomes a small
    // aim scatter, preserving the difference between a Sten and a Lee-Enfield.
    const converging = this.phaseValue === 'boss' && this.bossHpValue > 0;
    const bossLeft = this.plan.bunkerX - BOSS_WIDTH / 2;
    const bossY = this.bossY;
    const travelTime = Math.max(0.05, (bossLeft - originX) / PROJECTILE_SPEED);

    for (let i = 0; i < muzzles; i += 1) {
      const t = muzzles === 1 ? 0.5 : i / (muzzles - 1);
      const y = this.squadYValue + (t - 0.5) * band;
      // Deterministic pseudo-spread so a wide weapon genuinely disperses.
      const u = Math.sin((this.shotCounter + i * 7.13) * 1.7);
      const vy = converging
        ? (bossY + u * this.config.spreadDegrees * 6 - y) / travelTime
        : u * this.config.spreadDegrees * SPREAD_DRIFT * 0.5;
      this.projectiles.push({
        x: originX,
        y,
        vx: PROJECTILE_SPEED,
        vy,
        damage: damagePerShot,
      });
    }

    this.shotCounter += muzzles;
    this.statsValue.volleys += 1;
    this.statsValue.shotsFired += muzzles;
    this.emit({ type: 'volley', amount: muzzles });

    if (this.projectiles.length > MAX_PROJECTILES) {
      this.projectiles.splice(0, this.projectiles.length - MAX_PROJECTILES);
    }
  }

  // ------------------------------------------------------------------ motion

  private moveProjectiles(dt: number): void {
    for (const projectile of this.projectiles) {
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
    }
  }

  private moveInfantry(dt: number): void {
    for (const enemy of this.infantry) {
      enemy.x += enemy.speed * dt;
      if (enemy.flash > 0) enemy.flash = Math.max(0, enemy.flash - dt);
    }
  }

  // -------------------------------------------------------------- collisions

  private resolveProjectileHits(): void {
    const crateHalf = CRATE_SIZE / 2 + PROJECTILE_RADIUS;
    const bossLeft = this.plan.bunkerX - BOSS_WIDTH / 2;
    const bossHalfY = BOSS_HEIGHT / 2;
    const bossY = this.bossY;

    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const shot = this.projectiles[i];
      if (!shot) continue;

      // Crates: shooting raises the counter.
      let consumed = false;
      for (const crate of this.crates) {
        if (crate.taken) continue;
        if (Math.abs(shot.x - crate.x) > crateHalf) continue;
        if (Math.abs(shot.y - crate.y) > crateHalf) continue;
        const before = crate.value;
        crate.value = Math.min(CRATE_VALUE_CAP, crate.value + CRATE_SHOT_GAIN);
        crate.hitFlash = 0.16;
        if (crate.value !== before) {
          this.pushPopup(crate.x, crate.y - 40, `+${crate.value}`, 'gain', 0.7);
        }
        consumed = true;
        break;
      }
      if (consumed) {
        this.removeProjectile(i);
        this.emit({ type: 'bulletHit' });
        continue;
      }

      // Gates: shooting improves the operation.
      for (const gate of this.gates) {
        if (gate.resolved) continue;
        if (Math.abs(shot.x - gate.x) > 14) continue;
        if (shot.y < gate.y || shot.y > gate.y + gate.height) continue;
        const improved = this.improveGate(gate);
        gate.hitFlash = 0.16;
        if (improved) this.pushPopup(gate.x, gate.y + 18, this.gateLabel(gate), 'gain', 0.7);
        consumed = true;
        break;
      }
      if (consumed) {
        this.removeProjectile(i);
        this.emit({ type: 'bulletHit' });
        continue;
      }

      // Enemy infantry.
      for (let e = this.infantry.length - 1; e >= 0; e -= 1) {
        const enemy = this.infantry[e];
        if (!enemy) continue;
        if (Math.abs(shot.x - enemy.x) > INFANTRY_RADIUS) continue;
        if (Math.abs(shot.y - enemy.y) > INFANTRY_RADIUS) continue;
        enemy.hp -= shot.damage;
        enemy.flash = 0.14;
        consumed = true;
        if (enemy.hp <= 0) {
          this.removeInfantry(e);
          this.statsValue.kills += 1;
          this.pushPopup(enemy.x, enemy.y - 34, `-${INFANTRY_TROOP_LOSS}`, 'info', 0.6);
          this.emit({ type: 'infantryKilled' });
        } else {
          this.emit({ type: 'bulletHit' });
        }
        break;
      }
      if (consumed) {
        this.removeProjectile(i);
        continue;
      }

      // End-zone bunker.
      if (
        this.phaseValue === 'boss' &&
        this.bossHpValue > 0 &&
        shot.x >= bossLeft &&
        Math.abs(shot.y - bossY) <= bossHalfY
      ) {
        this.bossHpValue = Math.max(0, this.bossHpValue - shot.damage);
        this.removeProjectile(i);
      }
    }
  }

  private resolveHazards(dt: number): void {
    const halfW = SQUAD_BAND_WIDTH / 2;
    const halfH = SQUAD_BAND_HEIGHT / 2;
    const squadX = this.squadWorldX;
    const squadY = this.squadYValue;

    for (const mine of this.mines) {
      if (mine.armed) {
        if (mine.flash > 0) mine.flash = Math.max(0, mine.flash - dt);
        continue;
      }
      const hitX = Math.abs(mine.x - squadX) <= MINE_RADIUS + halfW;
      const hitY = Math.abs(mine.y - squadY) <= MINE_RADIUS + halfH * 0.72;
      if (!hitX || !hitY) continue;
      mine.armed = true;
      mine.flash = 0.5;
      this.loseTroops(MINE_TROOP_LOSS, mine.x, mine.y - 40);
      this.statsValue.minesHit += 1;
      this.emit({ type: 'mineHit', amount: MINE_TROOP_LOSS });
      if (this.troopsValue <= 0) return;
    }

    for (const wire of this.wires) {
      const overlapX = squadX + halfW + 16 > wire.x && squadX - halfW - 16 < wire.x + wire.length;
      const overlapY = squadY + halfH * 0.72 >= wire.y && squadY - halfH * 0.72 <= wire.y + wire.height;
      if (!overlapX || !overlapY) {
        wire.damageAccumulator = 0;
        continue;
      }
      wire.damageAccumulator += WIRE_TROOP_LOSS_PER_SECOND * dt;
      wire.flash = 0.2;
      const whole = Math.floor(wire.damageAccumulator);
      if (whole > 0) {
        wire.damageAccumulator -= whole;
        this.loseTroops(whole, wire.x - 10, squadY - 46);
        this.emit({ type: 'wireHit', amount: whole });
        if (this.troopsValue <= 0) return;
      }
    }

    // Enemy infantry that reach the squad trade one for one.
    for (let i = this.infantry.length - 1; i >= 0; i -= 1) {
      const enemy = this.infantry[i];
      if (!enemy) continue;
      const hitX = Math.abs(enemy.x - squadX) <= INFANTRY_RADIUS + halfW;
      const hitY = Math.abs(enemy.y - squadY) <= INFANTRY_RADIUS + halfH * 0.72;
      if (!hitX || !hitY) continue;
      this.removeInfantry(i);
      this.loseTroops(INFANTRY_TROOP_LOSS, enemy.x - 20, enemy.y - 40);
      this.emit({ type: 'infantryCollision', amount: INFANTRY_TROOP_LOSS });
      if (this.troopsValue <= 0) return;
    }
  }

  private resolvePasses(): void {
    const squadX = this.squadWorldX;

    for (const crate of this.crates) {
      if (crate.taken || squadX <= crate.x) continue;
      crate.taken = true;
      const gained = Math.min(CRATE_VALUE_CAP, Math.max(0, crate.value));
      const applied = Math.min(gained, this.config.maxTroops - this.troopsValue);
      this.troopsValue = Math.min(this.config.maxTroops, this.troopsValue + gained);
      this.statsValue.cratesCollected += 1;
      this.statsValue.troopsFromCrates += Math.max(0, applied);
      this.pushPopup(crate.x, crate.y - 46, `+${gained} PARATROOPERS`, 'gain');
      this.emit({ type: 'crateDeployed', amount: gained });
    }

    for (const gate of this.gates) {
      if (gate.resolved || squadX <= gate.x) continue;
      if (this.squadYValue < gate.y || this.squadYValue > gate.y + gate.height) continue;
      gate.resolved = true;
      const before = this.troopsValue;
      const after = this.applyGate(gate.op, gate.value, before);
      this.troopsValue = after;
      const delta = after - before;
      const gain = delta >= 0;
      if (gain) this.statsValue.gateGains += 1;
      else this.statsValue.gateLosses += 1;
      if (delta < 0) this.statsValue.troopsLost += -delta;
      this.pushPopup(
        gate.x,
        gate.y + gate.height / 2,
        `${this.gateLabel(gate)} → ${after}`,
        gain ? 'gain' : 'loss',
      );
      this.emit({ type: gain ? 'gateGain' : 'gateLoss', amount: Math.abs(delta) });
    }
  }

  // ------------------------------------------------------------------ gates

  private gateLabel(gate: Gate): string {
    switch (gate.op) {
      case 'add':
        return `+${gate.value}`;
      case 'mul':
        return `x${gate.value}`;
      case 'sub':
        return `-${gate.value}`;
      case 'div':
        return `÷${gate.value}`;
    }
  }

  /** Shooting a gate always improves it — never makes it worse. */
  private improveGate(gate: Gate): boolean {
    switch (gate.op) {
      case 'add':
        if (gate.value >= GATE_ADD_CAP) return false;
        gate.value = Math.min(GATE_ADD_CAP, gate.value + GATE_SHOT_STEP);
        return true;
      case 'sub':
        if (gate.value <= 0) return false;
        gate.value = Math.max(0, gate.value - GATE_SHOT_STEP);
        return true;
      case 'mul': {
        const index = GATE_MULTIPLIER_LADDER.indexOf(gate.value);
        const next = GATE_MULTIPLIER_LADDER[Math.min(index + 1, GATE_MULTIPLIER_LADDER.length - 1)];
        const current = GATE_MULTIPLIER_LADDER[Math.max(0, index)];
        if (next === undefined || current === undefined || next === gate.value) {
          // Value came from outside the ladder (level gen) — snap onto it.
          const snapped = GATE_MULTIPLIER_LADDER.find((step) => step > gate.value);
          if (snapped === undefined) return false;
          gate.value = snapped;
          return true;
        }
        gate.value = next;
        return true;
      }
      case 'div': {
        const index = GATE_DIVISOR_LADDER.indexOf(gate.value);
        if (index <= 0) return false;
        const next = GATE_DIVISOR_LADDER[Math.max(0, index - 1)];
        if (next === undefined) return false;
        gate.value = next;
        return true;
      }
    }
  }

  private applyGate(op: GateOp, value: number, troops: number): number {
    let result: number;
    switch (op) {
      case 'add':
        result = troops + value;
        break;
      case 'mul':
        result = Math.round(troops * value);
        break;
      case 'sub':
        result = troops - value;
        break;
      case 'div':
        // Never instantly lethal — a divider costs troops, it does not wipe them.
        result = Math.max(1, Math.floor(troops / Math.max(1, value)));
        break;
    }
    return Math.max(0, Math.min(this.config.maxTroops, result));
  }

  // ------------------------------------------------------------------ misc

  private loseTroops(amount: number, x: number, y: number): void {
    const applied = Math.min(this.troopsValue, Math.max(0, amount));
    this.troopsValue -= applied;
    this.statsValue.troopsLost += applied;
    if (applied > 0) this.pushPopup(x, y, `-${applied}`, 'loss', 0.8);
  }

  private pushPopup(x: number, y: number, text: string, tone: Popup['tone'], life = POPUP_LIFE): void {
    this.popups.push({ x, y, text, tone, life });
    if (this.popups.length > 24) this.popups.shift();
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
  }

  /** Move level spawns into the world as the camera approaches them. */
  private spawnAhead(): void {
    const horizon = this.scrollXValue + VIEW_WIDTH + 260;
    while (this.spawnCursor.index < this.plan.spawns.length) {
      const spawn = this.plan.spawns[this.spawnCursor.index];
      if (!spawn || spawn.x > horizon) break;
      this.spawnCursor.index += 1;

      switch (spawn.kind) {
        case 'crate':
          this.crates.push({ x: spawn.x, y: spawn.y, value: spawn.value, hitFlash: 0, taken: false });
          break;
        case 'mine':
          this.mines.push({ x: spawn.x, y: spawn.y, armed: false, flash: 0 });
          break;
        case 'wire':
          this.wires.push({
            x: spawn.x,
            y: spawn.y,
            height: spawn.height,
            length: spawn.length,
            damageAccumulator: 0,
            flash: 0,
          });
          break;
        case 'infantry':
          this.infantry.push({
            x: spawn.x,
            y: spawn.y,
            speed: spawn.speed,
            hp: spawn.hp,
            maxHp: spawn.hp,
            flash: 0,
          });
          break;
        case 'gate':
          this.gates.push({
            x: spawn.x,
            op: spawn.op,
            value: spawn.value,
            y: spawn.y,
            height: spawn.height,
            resolved: false,
            hitFlash: 0,
          });
          break;
      }
    }
  }

  private decayEffects(dt: number): void {
    for (let i = this.popups.length - 1; i >= 0; i -= 1) {
      const popup = this.popups[i];
      if (!popup) continue;
      popup.life -= dt;
      popup.y -= POPUP_RISE * dt * 0.6;
      if (popup.life <= 0) this.popups.splice(i, 1);
    }
  }

  /** Drop anything the camera has passed; swap-remove keeps the arrays dense. */
  private cull(): void {
    const behind = this.scrollXValue - 260;
    const aheadLimit = this.scrollXValue + VIEW_WIDTH + 140;

    compact(this.crates, (crate) => !crate.taken && crate.x >= behind);
    compact(this.mines, (mine) => mine.x >= behind);
    compact(this.wires, (wire) => wire.x >= behind);
    compact(this.infantry, (enemy) => enemy.x >= behind && enemy.x <= aheadLimit);
    compact(this.gates, (gate) => gate.x >= behind);
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const shot = this.projectiles[i];
      if (!shot) continue;
      if (shot.x < this.scrollXValue - 80 || shot.x > aheadLimit || shot.y < -40 || shot.y > VIEW_HEIGHT + 40) {
        this.removeProjectile(i);
      }
    }
  }

  private removeProjectile(index: number): void {
    swapRemove(this.projectiles, index);
  }

  private removeInfantry(index: number): void {
    swapRemove(this.infantry, index);
  }

  /** Distance remaining before the bunker fight, for the HUD. */
  get remainingDistance(): number {
    return Math.max(0, this.plan.totalScroll - this.scrollXValue);
  }

  /** How many level spawns have entered the world (verification aid). */
  get spawnedCount(): number {
    return this.spawnCursor.index;
  }

  /** Total spawns in the plan (verification aid). */
  get plannedSpawnCount(): number {
    return this.plan.spawns.length;
  }

  /** Exposed for tests: force a step count for a headless fast-forward. */
  static get stepSeconds(): number {
    return FIXED_DT;
  }
}

function swapRemove<T>(items: T[], index: number): void {
  if (index < 0 || index >= items.length) return;
  const last = items.pop();
  if (last === undefined) return;
  if (index < items.length) items[index] = last;
}

function compact<T>(items: T[], keep: (item: T) => boolean): void {
  let write = 0;
  for (let read = 0; read < items.length; read += 1) {
    const item = items[read];
    if (item === undefined) continue;
    if (!keep(item)) continue;
    items[write] = item;
    write += 1;
  }
  items.length = write;
}
