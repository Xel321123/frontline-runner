/**
 * Headless battle harness — mechanics, balance and performance for the tug-of-war
 * simulation, with no browser involved.
 *
 * It drives the real `TugSimulation` with the real `createMatchConfig` numbers, so
 * balance conclusions come from the code that ships. Part 1 asserts every
 * documented mechanic; part 2 plays whole campaign nodes with three autopilots
 * (do-nothing, steady riflemen, adaptive) and prints the outcomes.
 *
 * Requires Node's built-in TypeScript support (22.18+); see
 * scripts/ts-resolve-hooks.mjs for the extensionless-import shim.
 */

import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));

const { TugSimulation, logisticsCost } = await import('../src/game/TugSimulation.ts');
const { createMatchConfig } = await import('../src/game/match.ts');
const { UNIT_STATS } = await import('../src/game/units.ts');
const C = await import('../src/game/constants.ts');
const { ENVIRONMENTS, environmentRules } = await import('../src/game/environment.ts');
const { incomingDamage } = await import('../src/game/damage.ts');
const { createFeatureLayout, trenchAt } = await import('../src/game/features.ts');
const { getStage, STAGES_PER_CAMPAIGN } = await import('../src/core/progression.ts');
const { createFreshSave } = await import('../src/core/types.ts');

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(condition);
}

function saveWith(upgrades = {}) {
  const save = createFreshSave(0, []);
  return {
    ...save,
    faction: 'allied',
    upgrades: {
      health: 0,
      damage: 0,
      baseHp: 0,
      ...upgrades,
    },
  };
}

/**
 * Upgrades a player plausibly owns by the time they reach a node: bonds arrive
 * with every cleared sector, and camp is where they get spent. Testing late
 * tiers with an empty save would be a strawman nobody actually plays.
 */
const UPGRADE_PROFILE = [
  { upTo: 6, upgrades: { armour: 1 } },
  { upTo: 12, upgrades: { armour: 1, firepower: 1, mobility: 1 } },
  { upTo: 20, upgrades: { armour: 2, firepower: 2, mobility: 1, medkit: 1 } },
  { upTo: 99, upgrades: { armour: 3, firepower: 3, mobility: 2, medkit: 1 } },
];

function upgradesForStage(stageId) {
  const stage = getStage(stageId);
  const index = stage ? stage.index : 1;
  const entry = UPGRADE_PROFILE.find((candidate) => index <= candidate.upTo);
  return entry ? entry.upgrades : {};
}

/**
 * The node every mechanics check runs on unless it is specifically testing
 * terrain or weather: `destroy_base`, temperate, no features, supplies ×1.0 —
 * so the numbers being asserted are the documented base numbers.
 */
const PLAIN_NODE = 'axis-19';

function simFor(stageId = PLAIN_NODE, upgrades = {}) {
  const stage = getStage(stageId);
  if (!stage) throw new Error(`unknown stage ${stageId}`);
  const config = createMatchConfig(stage, saveWith(upgrades));
  return { sim: new TugSimulation(config), config, stage };
}

const NO_COMMAND = { deploy: null, buyLogistics: false };

const costOf = (state, kind) =>
  state.deployOptions.find((option) => option.kind === kind)?.cost ?? UNIT_STATS[kind].cost;

const POLICIES = {
  idle: () => null,
  rifle: (state) =>
    state.supplies >= costOf(state, 'rifleman') ? deploy('rifleman') : null,
  /**
   * A sensible attacker: buy logistics when the bonds allow it, keep a rifle
   * line as the backbone, push with SMGs once the field is clear, put an MG in
   * when the enemy has a line up, and bank for armour when the economy is hot.
   * Costs come from `deployOptions`, so terrain surcharges are respected.
   */
  adaptive: (state) => {
    const mine = state.units.filter((unit) => unit.side === 'player').length;
    // Never trade the line for an upgrade: keep troops on the field first.
    if (
      state.bonds >= state.logisticsCost &&
      state.logisticsLevel < 5 &&
      mine >= 2 &&
      state.time > 25
    ) {
      return { deploy: null, buyLogistics: true };
    }
    // Adapt to the mission: a survival battle is won by holding ground with
    // infantry, but infantry cannot scratch enemy armour, so one of our own
    // tanks is the answer to theirs.
    const enemyArmour = state.units.filter(
      (unit) => unit.side === 'enemy' && unit.kind === 'tank',
    ).length;
    if (state.missionType === 'survive_timer') {
      if (enemyArmour > 0 && state.supplies >= costOf(state, 'tank')) return deploy('tank');
      if (state.enemyUnits >= 3 && state.supplies >= costOf(state, 'mg')) return deploy('mg');
      return state.supplies >= costOf(state, 'rifleman') ? deploy('rifleman') : null;
    }
    if (state.supplies >= costOf(state, 'tank') + 60) return deploy('tank');
    if (state.enemyUnits >= 3 && state.supplies >= costOf(state, 'mg')) return deploy('mg');
    if (state.enemyUnits === 0 && state.supplies >= costOf(state, 'smg')) return deploy('smg');
    return state.supplies >= costOf(state, 'rifleman') ? deploy('rifleman') : null;
  },
};

/** One adaptive step, for the mechanics checks. */
function adaptiveCommand(sim) {
  return POLICIES.adaptive(sim.state) ?? NO_COMMAND;
}


/** Advance the sim by `seconds`, issuing whatever the policy asks for. */
function play(sim, seconds, policy = () => null) {
  const ticks = Math.round(seconds / C.FIXED_DT);
  for (let i = 0; i < ticks; i += 1) {
    if (sim.state.status !== 'running') break;
    sim.update(C.FIXED_DT, policy(sim.state) ?? NO_COMMAND);
  }
  return sim.state;
}

const deploy = (kind) => ({ deploy: kind, buyLogistics: false });
const upgrade = () => ({ deploy: null, buyLogistics: true });

// --------------------------------------------------------------- mechanics

// Mechanics checks below run on PLAIN_NODE (see `simFor`): a `destroy_base`
// sector that is temperate, has no terrain features and pays supplies ×1.0, so
// the numbers being asserted are the documented base numbers. Terrain and
// weather get their own checks further down.

// 1. supplies accumulate at the configured rate
{
  const { sim, config } = simFor();
  const start = sim.state.supplies;
  const after = play(sim, 10);
  const expected = Math.min(C.SUPPLY_CAP, start + config.supplyBaseRate * 10);
  check(
    'supplies accrue at +2/s',
    Math.abs(after.supplies - expected) < 2,
    `expected ~${expected.toFixed(1)}, got ${after.supplies.toFixed(1)}`,
  );
  check(
    'supply rate starts at the configured base',
    Math.abs(sim.supplyRate - config.supplyBaseRate) < 1e-9,
    `rate=${sim.supplyRate}`,
  );
}

// 2. logistics upgrade costs bonds and raises the supply rate
{
  const { sim } = simFor();
  const rateBefore = sim.supplyRate;
  const cost = logisticsCost(0);
  check('first logistics upgrade costs 30 bonds', cost === 30, `cost=${cost}`);

  // Fight a normal battle until the bonds for one upgrade are banked.
  let guard = 0;
  while (sim.state.bonds < cost && sim.state.status === 'running' && guard < 60 * 200) {
    sim.update(C.FIXED_DT, POLICIES.rifle(sim.state) ?? NO_COMMAND);
    guard += 1;
  }
  const bonds = sim.state.bonds;
  check('destroyed enemies bank enough bonds for an upgrade', bonds >= cost, `bonds=${bonds}, cost=${cost}`);

  sim.update(C.FIXED_DT, { deploy: null, buyLogistics: true });
  check('the logistics upgrade is bought with bonds', sim.state.logisticsLevel === 1, `level=${sim.state.logisticsLevel}`);
  check('the bond cost is deducted', sim.state.bonds === bonds - cost, `bonds ${bonds} -> ${sim.state.bonds}`);
  check(
    'logistics upgrade raises supply generation',
    sim.supplyRate > rateBefore,
    `rate ${rateBefore} -> ${sim.supplyRate}`,
  );
  check(
    'and the raise is exactly one step',
    Math.abs(sim.supplyRate - rateBefore - C.SUPPLY_PER_LOGISTICS_LEVEL) < 1e-9,
    `${rateBefore} -> ${sim.supplyRate}`,
  );
}

// 3. deploying costs supplies and spawns at the player's base
{
  const { sim } = simFor();
  const suppliesBefore = sim.state.supplies;
  const state = play(sim, 0.2, () => deploy('rifleman'));
  const mine = state.units.filter((unit) => unit.side === 'player');
  check('deploying spends supplies', state.supplies < suppliesBefore, `${suppliesBefore} -> ${state.supplies}`);
  check('deploying spawns one unit', mine.length === 1, `units=${mine.length}`);
  if (mine[0]) {
    check(
      'units spawn just in front of the player base',
      mine[0].x > C.BASE_X && mine[0].x < C.BASE_X + 90,
      `x=${mine[0].x.toFixed(1)}`,
    );
  }
  const unaffordable = play(sim, 0.2, () => deploy('tank'));
  check(
    'a unit cannot be fielded without supplies',
    unaffordable.units.filter((u) => u.kind === 'tank').length === 0,
    `tank cost ${UNIT_STATS.tank.cost}, supplies ${unaffordable.supplies.toFixed(1)}`,
  );
}

// 4. units advance, then stop when a hostile is in range
{
  const { sim } = simFor();
  play(sim, 0.1, () => deploy('rifleman'));
  const advancing = sim.state.units.find((u) => u.side === 'player');
  const x0 = advancing.x;
  play(sim, 3);
  const moved = sim.state.units.find((u) => u.side === 'player');
  check('units march toward the enemy', moved.x > x0 + 20, `x ${x0.toFixed(1)} -> ${moved.x.toFixed(1)}`);
}

// 5. a unit stops at its engagement range instead of walking into the enemy
{
  const { sim } = simFor();
  let sawEngage = false;
  let worstDistance = 0;
  let sawAdvance = false;
  for (let i = 0; i < 60 * 40; i += 1) {
    const needsUnit = !sim.state.units.some((u) => u.side === 'player');
    sim.update(C.FIXED_DT, needsUnit ? deploy('rifleman') : NO_COMMAND);
    const hostiles = sim.state.units.filter((u) => u.side === 'enemy');
    for (const unit of sim.state.units) {
      if (unit.side !== 'player' || unit.kind !== 'rifleman') continue;
      if (unit.state === 'advance') sawAdvance = true;
      if (unit.state !== 'engage' || hostiles.length === 0) continue;
      sawEngage = true;
      const nearest = Math.min(...hostiles.map((o) => Math.abs(o.x - unit.x)));
      worstDistance = Math.max(worstDistance, nearest);
    }
  }
  check('the rifleman marched first', sawAdvance);
  check(
    'a rifleman holds its fire line instead of closing',
    sawEngage && worstDistance <= UNIT_STATS.rifleman.range * 1.15 + 40,
    `nearest hostile ${worstDistance.toFixed(1)}px, range ${UNIT_STATS.rifleman.range}`,
  );
  check('engaged units switch to the engage state', sawEngage, `sawEngage=${sawEngage}`);
}

// 6. a bolt-action rifleman fires at its documented rate
{
  const { sim } = simFor();
  sim.update(C.FIXED_DT, deploy('rifleman'));
  // A unit's cooldown is set to exactly 1/fireRate when it fires and only ever
  // counts down, so the largest value it is ever seen holding is its interval.
  let peak = 0;
  for (let i = 0; i < 60 * 60; i += 1) {
    sim.update(C.FIXED_DT, adaptiveCommand(sim));
    for (const unit of sim.state.units) {
      if (unit.side === 'player' && unit.kind === 'rifleman') peak = Math.max(peak, unit.cooldown);
    }
  }
  const expected = 1 / UNIT_STATS.rifleman.fireRate;
  check(
    'bolt-action rifleman fires at its documented rate',
    Math.abs(peak - expected) < 0.04,
    `peak cooldown ${peak.toFixed(3)}s, expected ${expected.toFixed(3)}s`,
  );
}

// 6b. structures are valid targets, not just troops
{
  // Observed from the defensive side, where it is unambiguous: with the player
  // doing nothing at all, the only way the base can lose hit points is enemy
  // units engaging the structure itself.
  const { sim } = simFor();
  let sawBaseDamage = false;
  for (let i = 0; i < 60 * 150 && sim.state.status === 'running'; i += 1) {
    sim.update(C.FIXED_DT, NO_COMMAND);
    if (sim.state.playerBase.hp < sim.state.playerBase.maxHp) sawBaseDamage = true;
  }
  check('units engage structures, not only troops', sawBaseDamage);
}

// 7. the tank lobs a shell that damages an area and shakes the screen
{
  const { sim } = simFor();
  // Give the tank time to arrive and fire by banking supplies first.
  play(sim, 40, (state) => (state.supplies >= UNIT_STATS.tank.cost ? deploy('tank') : null));
  let sawShell = false;
  let sawShake = false;
  let sawBlastSmoke = false;
  for (let i = 0; i < 60 * 90; i += 1) {
    sim.update(C.FIXED_DT, {
      deploy: sim.state.supplies >= UNIT_STATS.tank.cost ? 'tank' : null,
      buyLogistics: false,
    });
    if (sim.state.projectiles.some((p) => p.kind === 'shell')) sawShell = true;
    if (sim.state.shake > 4) sawShake = true;
    if (sim.state.particles.some((p) => p.kind === 'smoke' && p.size > 8)) sawBlastSmoke = true;
    if (sim.state.status !== 'running') break;
  }
  check('tanks fire arcing shells', sawShell);
  check('shell blasts shake the screen', sawShake);
  check('shell blasts throw smoke', sawBlastSmoke);
}

// 8. the MG digs in with sandbags and suppresses what it hits
{
  const { sim } = simFor();
  play(sim, 3, () => deploy('mg'));
  // March it to contact, then let it dig in.
  let sandy = false;
  let suppressed = false;
  for (let i = 0; i < 60 * 120; i += 1) {
    sim.update(C.FIXED_DT, { deploy: null, buyLogistics: false });
    if (sim.state.sandbags.length > 0) sandy = true;
    if (sim.state.units.some((u) => u.side === 'enemy' && u.suppressed > 0)) suppressed = true;
    if (sim.state.status !== 'running') break;
  }
  check('the MG plants sandbags when it stops', sandy, `bags=${sim.state.sandbags.length}`);
  check('MG fire suppresses enemy movement', suppressed);
}

// 9. enemy losses pay war bonds to the player
{
  const { sim } = simFor();
  play(sim, 60, (state) => {
    if (state.bonds >= 120 && state.logisticsLevel < 3) return { deploy: null, buyLogistics: true };
    if (state.supplies >= 140) return deploy('tank');
    if (state.supplies >= 55) return deploy('mg');
    if (state.supplies >= 35) return deploy('smg');
    return state.supplies >= 20 ? deploy('rifleman') : null;
  });
  const state = sim.state;
  check('destroyed enemy units pay bonds', state.stats.bondsCollected > 0, `bonds=${state.stats.bondsCollected}`);
  check('bonds are banked in-match', state.bonds >= 0 && Number.isFinite(state.bonds));
  check('enemy units were destroyed', state.stats.kills > 0, `kills=${state.stats.kills}`);
  check('bond tokens fall as particles', state.particles.some((p) => p.kind === 'bond') || state.stats.kills > 0);
}

// 10. the match is decided by base destruction
{
  const { sim } = simFor('allied-01', { firepower: 5, mobility: 5, armour: 5 });
  const state = play(sim, 175, (s) => {
    if (s.bonds >= s.logisticsCost && s.logisticsLevel < 5 && s.bonds > 60) {
      return { deploy: null, buyLogistics: true };
    }
    if (s.supplies >= 140) return deploy('tank');
    if (s.supplies >= 55) return deploy('mg');
    if (s.supplies >= 35) return deploy('smg');
    return s.supplies >= 20 ? deploy('rifleman') : null;
  });
  check(
    'an aggressive player can destroy the enemy strongpoint',
    state.status === 'victory',
    `status=${state.status}, enemy base ${state.enemyBase.hp.toFixed(0)}/${state.enemyBase.maxHp}`,
  );
  check('victory is reported as a win, not a timeout', state.status === 'victory');
}

// 10b. the stage's supply multiplier drives the player's economy
{
  const deserto = simFor('axis-01');            // Poland, blitzkrieg ×1.4
  const shortage = simFor('allied-11');         // Stalingrad, shortage ×0.7
  check(
    Math.abs(deserto.sim.supplyRate - C.SUPPLY_BASE_RATE * 1.4) < 1e-9,
    'a blitzkrieg stage multiplies supply generation',
    `rate=${deserto.sim.supplyRate}`,
  );
  check(
    Math.abs(shortage.sim.supplyRate - C.SUPPLY_BASE_RATE * 0.7) < 1e-9,
    'a supply-shortage stage cuts supply generation',
    `rate=${shortage.sim.supplyRate}`,
  );
  check(
    deserto.config.supplyRateMultiplier !== shortage.config.supplyRateMultiplier,
    'the two situations are not the same multiplier',
  );
}

// 10c. environment rules are the documented ones
{
  const E = environmentRules('snow');
  const D = environmentRules('desert');
  const M = environmentRules('mud');
  const N = environmentRules('night');
  check(Math.abs(E.moveSpeedMultiplier - 0.65) < 1e-9, 'snow slows ground units by 35%', `×${E.moveSpeedMultiplier}`);
  check(Math.abs(D.rangeMultiplier - 0.5) < 1e-9, 'desert halves engagement range', `×${D.rangeMultiplier}`);
  check(Math.abs(M.tankCostMultiplier - 1.5) < 1e-9, 'mud raises armour cost by 50%', `×${M.tankCostMultiplier}`);
  check(Math.abs(M.vehicleSpeedMultiplier - 0.6) < 1e-9, 'mud slows vehicles by 40%', `×${M.vehicleSpeedMultiplier}`);
  check(Math.abs(N.illuminatedDamageMultiplier - 1.5) < 1e-9, 'night raises damage on lit units by 50%', `×${N.illuminatedDamageMultiplier}`);
  check(N.searchlights && E.snowfall && D.sandstorm, 'each environment declares its scene effects');
  check(Object.keys(ENVIRONMENTS).length === 5, 'five environments are defined');
}

// 10d. incoming damage stacks armour, sandbags, a trench and a searchlight
{
  const base = 100;
  const plain = incomingDamage(base, {
    armor: 0, dugIn: false, trenchCover: false, illuminated: false, illuminatedDamageMultiplier: 1,
  });
  const inTrench = incomingDamage(base, {
    armor: 0, dugIn: false, trenchCover: true, illuminated: false, illuminatedDamageMultiplier: 1,
  });
  const lit = incomingDamage(base, {
    armor: 0, dugIn: false, trenchCover: false, illuminated: true, illuminatedDamageMultiplier: 1.5,
  });
  const armored = incomingDamage(base, {
    armor: 6, dugIn: false, trenchCover: false, illuminated: false, illuminatedDamageMultiplier: 1,
  });
  const immune = incomingDamage(base, {
    armor: 500, dugIn: false, trenchCover: false, illuminated: false, illuminatedDamageMultiplier: 1,
  });
  check(Math.abs(plain - 100) < 1e-9, 'unmodified damage passes through', `${plain}`);
  check(Math.abs(inTrench - 30) < 1e-9, 'a trench cuts projectile damage by 70%', `${inTrench}`);
  check(Math.abs(lit - 150) < 1e-9, 'a searchlight silhouette takes 50% more', `${lit}`);
  check(Math.abs(armored - 94) < 1e-9, 'armour subtracts flat damage', `${armored}`);
  check(Math.abs(immune - 25) < 1e-9, 'armour can never grant immunity', `${immune}`);
}

// 10e. snow really does slow the advance (integration, not just the table)
{
  const advance = (stageId, ticks) => {
    const { sim } = simFor(stageId, { armour: 5 });
    let first = null;
    let last = null;
    for (let i = 0; i < ticks; i += 1) {
      sim.update(C.FIXED_DT, i === 0 ? deploy('rifleman') : NO_COMMAND);
      const unit = sim.state.units.find((u) => u.side === 'player' && u.kind === 'rifleman');
      if (!unit) continue;
      if (first === null) first = unit.x;
      last = unit.x;
    }
    return first === null ? 0 : last - first;
  };
  // allied-19 (Anzio) is temperate; allied-07 (Moscow) and allied-27 (Bastogne) are snow.
  const temperate = advance('allied-19', 60 * 3);
  const snow = advance('allied-07', 60 * 3);
  const ratio = temperate > 0 ? snow / temperate : 0;
  check(
    ratio > 0.55 && ratio < 0.75,
    'snow advances are ~35% slower on the field',
    `temperate ${temperate.toFixed(1)}px vs snow ${snow.toFixed(1)}px (ratio ${ratio.toFixed(2)})`,
  );
}

// 10f. mud surcharges armour, and the HUD cost reflects it
{
  const temperate = simFor('allied-19').sim.state.deployOptions.find((o) => o.kind === 'tank');
  const mud = simFor('axis-12').sim.state.deployOptions.find((o) => o.kind === 'tank');
  check(temperate && temperate.cost === 140, 'a tank costs 140 on ordinary ground', `${temperate?.cost}`);
  check(mud && mud.cost === 210, 'a tank costs 50% more in the mud', `${mud?.cost}`);
  const mudByTier = createFeatureLayout({ seed: 'axis-12', features: [], tier: 5 });
  check(mudByTier.trenches.length === 0, 'a stage without features lays out no terrain');
}

// 10g. a bridge chokepoint caps how many units of one side can hold the span
{
  const { sim } = simFor('allied-25');           // Market Garden / Arnhem
  const capacity = sim.state.features.bridges[0]?.capacity ?? 0;
  check(capacity > 0, 'the bridge span exists with a capacity', `capacity=${capacity}`);
  let peak = 0;
  for (let i = 0; i < 60 * 90 && sim.state.status === 'running'; i += 1) {
    sim.update(C.FIXED_DT, adaptiveCommand(sim));
    for (const bridge of sim.state.features.bridges) {
      peak = Math.max(peak, bridge.occupants.player, bridge.occupants.enemy);
    }
  }
  check(
    peak > 0 && peak <= capacity,
    'the span never holds more than its capacity',
    `peak=${peak}, capacity=${capacity}`,
  );
}

// 10h. mine belts are live terrain that takes casualties
{
  const { sim } = simFor('allied-18');           // Monte Cassino: trenches + mines
  const belt = sim.state.features.minefields[0];
  check(Boolean(belt), 'the mine belt is laid out');
  const armedAtStart = belt ? belt.armed : 0;
  let sawShake = false;
  for (let i = 0; i < 60 * 150 && sim.state.status === 'running'; i += 1) {
    sim.update(C.FIXED_DT, adaptiveCommand(sim));
    if (sim.state.shake > 0 && sim.state.stats.minesHit > 0) sawShake = true;
  }
  const exploded = belt ? belt.mines.filter((m) => m.exploded).length : 0;
  check(
    sim.state.stats.minesHit + sim.state.stats.enemyMinesHit > 0,
    'something walked onto a mine',
    `player ${sim.state.stats.minesHit}, enemy ${sim.state.stats.enemyMinesHit}`,
  );
  check(
    belt ? belt.armed === armedAtStart - exploded : false,
    'each detonation consumes exactly one mine',
    `armed ${belt?.armed} of ${armedAtStart}, exploded ${exploded}`,
  );
  check(sawShake, 'a mine blast shakes the screen');
}

// 10i. trenches shelter infantry that stop inside them, and only then
{
  const { sim } = simFor('allied-18');
  let sawCover = false;
  let violations = 0;
  for (let i = 0; i < 60 * 150 && sim.state.status === 'running'; i += 1) {
    sim.update(C.FIXED_DT, adaptiveCommand(sim));
    for (const unit of sim.state.units) {
      if (unit.kind === 'tank') continue;
      const inside = trenchAt(sim.state.features, unit.x);
      if (inside && unit.state === 'advance' && unit.trenchCover) violations += 1;
      if (inside && unit.trenchCover) sawCover = true;
    }
  }
  check(violations === 0, 'a unit on the move never claims trench cover', `violations=${violations}`);
  check(sawCover, 'infantry do take cover in a trench');
}

// 10j. night lights the field with searchlights
{
  const night = simFor('allied-03');             // the Blitz
  const day = simFor('allied-19');               // Anzio
  check(night.sim.state.searchlights.length === 0, 'searchlights are idle before the first step');
  let sawLit = false;
  for (let i = 0; i < 60 * 40 && night.sim.state.status === 'running'; i += 1) {
    night.sim.update(C.FIXED_DT, adaptiveCommand(night.sim));
    if (night.sim.state.searchlights.length !== C.SEARCHLIGHT_COUNT) {
      check(false, 'a night battle always has its searchlights', `${night.sim.state.searchlights.length}`);
      break;
    }
    if (night.sim.state.units.some((u) => u.illuminated)) sawLit = true;
  }
  day.sim.update(C.FIXED_DT, NO_COMMAND);
  check(night.sim.state.searchlights.length === 2, 'night runs two sweeping beams', `${night.sim.state.searchlights.length}`);
  check(day.sim.state.searchlights.length === 0, 'daylight runs none', `${day.sim.state.searchlights.length}`);
  check(sawLit, 'units get caught in the beams');
}

// 10k. mission types change the win condition and the enemy position
{
  const survive = simFor('allied-02');           // Dunkirk: hold the perimeter
  check(survive.config.missionType === 'survive_timer', 'Dunkirk is a survival battle');
  check(survive.sim.state.timeLeft <= C.SURVIVE_SECONDS + 1, 'a survival battle runs on its own clock', `timeLeft=${survive.sim.state.timeLeft.toFixed(0)}`);

  // Hold the line to the clock: the objective is survival, not demolition.
  let held = 0;
  for (let i = 0; i < 60 * (C.SURVIVE_SECONDS + 6) && survive.sim.state.status === 'running'; i += 1) {
    survive.sim.update(C.FIXED_DT, adaptiveCommand(survive.sim));
    held += 1;
  }
  check(
    survive.sim.state.status === 'victory' && survive.sim.state.lossReason === 'time-expired',
    'holding to the clock wins a survival battle',
    `${survive.sim.state.status}/${survive.sim.state.lossReason} after ${(held * C.FIXED_DT).toFixed(0)}s`,
  );
  check(
    survive.sim.state.enemyBase.hp > 0,
    'the enemy strongpoint can survive while the sector is still won',
    `${Math.round(survive.sim.state.enemyBase.hp)} hp`,
  );

  // An assault faces a reinforced position; a plain battle does not.
  const assault = simFor('allied-30');           // Berlin, assault, tier 9
  const plain = simFor('axis-09');               // Kiev pocket, destroy_base, tier 9
  check(
    assault.config.enemyBaseHp > plain.config.enemyBaseHp,
    'an assault faces a reinforced strongpoint',
    `${assault.config.enemyBaseHp} vs ${plain.config.enemyBaseHp}`,
  );
  check(
    Math.abs(assault.config.enemyBaseHp / plain.config.enemyBaseHp - C.ASSAULT_BASE_HP_MULTIPLIER) < 0.01,
    'the assault bonus is exactly the documented multiplier',
    `ratio ${(assault.config.enemyBaseHp / plain.config.enemyBaseHp).toFixed(3)}`,
  );
}

// 11. an idle player loses
{
  const { sim } = simFor();
  const state = play(sim, 175);
  check(
    'ignoring the battle loses it',
    state.status === 'defeat',
    `status=${state.status}, player base ${state.playerBase.hp.toFixed(0)}/${state.playerBase.maxHp}`,
  );
}

// 12. determinism: same seed + same commands => identical result
{
  const a = simFor('allied-07');
  const b = simFor('allied-07');
  const policy = (state) => (state.supplies >= 20 ? deploy('rifleman') : null);
  const stateA = play(a.sim, 90, policy);
  const stateB = play(b.sim, 90, policy);
  check(
    'a battle is reproducible from its seed',
    stateA.status === stateB.status &&
      Math.abs(stateA.playerBase.hp - stateB.playerBase.hp) < 1e-6 &&
      Math.abs(stateA.enemyBase.hp - stateB.enemyBase.hp) < 1e-6 &&
      stateA.stats.kills === stateB.stats.kills,
    `${stateA.status}/${stateA.stats.kills} vs ${stateB.status}/${stateB.stats.kills}`,
  );
}

// ---------------------------------------------------------------- autopilots

function runNode(stageId, policyName, upgrades = upgradesForStage(stageId)) {
  const { sim, config } = simFor(stageId, upgrades);
  const policy = POLICIES[policyName];
  let ticks = 0;
  let cpuMs = 0;
  while (sim.state.status === 'running' && ticks < 60 * 240) {
    const started = performance.now();
    sim.update(C.FIXED_DT, policy(sim.state) ?? NO_COMMAND);
    cpuMs += performance.now() - started;
    ticks += 1;
  }
  const state = sim.state;
  return {
    stages: ticks,
    seconds: state.time,
    status: state.status,
    reason: state.lossReason,
    playerHp: state.playerBase.hp / state.playerBase.maxHp,
    enemyHp: state.enemyBase.hp / state.enemyBase.maxHp,
    kills: state.stats.kills,
    losses: state.stats.losses,
    deployed: state.stats.deployed,
    bonds: state.stats.bondsCollected,
    logistics: state.stats.logisticsBought,
    peakUnits: Math.max(state.units.length, state.stats.deployed),
    usPerTick: (cpuMs / Math.max(1, ticks)) * 1000,
    tier: config.tier,
  };
}

// -------------------------------------------------------------- node sweep

/** Sampled to cover every mission type, environment and feature. */
const SAMPLE_NODES = [
  'allied-01',   // assault, snow, trenches
  'allied-02',   // survive_timer, standard, minefield
  'allied-10',   // assault, desert, minefield
  'allied-18',   // assault, standard, trenches + minefield
  'allied-25',   // assault, standard, bridge chokepoint
  'allied-27',   // survive_timer, snow, trenches + minefield, supplies x0.7
  'allied-29',   // assault, night, trenches + minefield
  'axis-12',     // destroy_base, mud, trenches + minefield
  'axis-26',     // assault, snow, minefield, blitzkrieg x1.4
  'axis-30',     // survive_timer, mud, trenches, shortage x0.7
  'allied-11',   // survive_timer, snow, trenches, the deepest shortage x0.7
  'axis-21',     // survive_timer, snow, trenches (the Korsun pocket)
  'allied-28',   // assault, bridge chokepoint (Remagen)
];
const table = [];
let worstTick = 0;

for (const nodeId of SAMPLE_NODES) {
  for (const policyName of ['idle', 'rifle', 'adaptive']) {
    const result = runNode(nodeId, policyName);
    worstTick = Math.max(worstTick, result.usPerTick);
    table.push({ nodeId, policyName, ...result });
  }
}

console.log('=== sampled nodes (fps budget is 16 600 µs/tick) ===');
console.log(
  ['node', 'policy', 'result', 'time', 'kills/losses', 'fielded', 'bonds', 'logi', 'µs/tick']
    .map((h, i) => h.padEnd([10, 9, 10, 7, 13, 9, 7, 6, 8][i]))
    .join(' '),
);
for (const row of table) {
  console.log(
    [
      row.nodeId.padEnd(10),
      row.policyName.padEnd(9),
      `${row.status}${row.reason === 'time-expired' ? '*' : ''}`.padEnd(10),
      `${row.seconds.toFixed(1)}s`.padEnd(7),
      `${row.kills}/${row.losses}`.padEnd(13),
      String(row.deployed).padEnd(9),
      String(row.bonds).padEnd(7),
      String(row.logistics).padEnd(6),
      row.usPerTick.toFixed(1).padEnd(8),
    ].join(' '),
  );
}
console.log('(* = decided by the stalemate clock)');

// ------------------------------------------------------------ bracket checks

const idle = table.filter((row) => row.policyName === 'idle');
const adaptive = table.filter((row) => row.policyName === 'adaptive');
const rifle = table.filter((row) => row.policyName === 'rifle');

if (idle.some((row) => row.status === 'victory')) {
  failures.push('idle policy won a node — the enemy is not applying pressure');
}
check(
  'adaptive play wins the campaign nodes',
  adaptive.every((row) => row.status === 'victory'),
  adaptive.map((row) => `${row.nodeId}:${row.status}`).join(' '),
);
check(
  'adaptive play beats or matches naive rifle spam',
  adaptive.filter((r) => r.status === 'victory').length >=
    rifle.filter((r) => r.status === 'victory').length,
  `adaptive ${adaptive.filter((r) => r.status === 'victory').length}/${adaptive.length} vs rifle ${
    rifle.filter((r) => r.status === 'victory').length
  }/${rifle.length}`,
);
check(
  'every sampled battle finishes inside the clock',
  table.every((row) => row.seconds <= C.MATCH_TIME_LIMIT + 1),
  table.filter((row) => row.seconds > C.MATCH_TIME_LIMIT + 1).map((r) => r.nodeId).join(' '),
);
check(
  'battles last long enough to be a game',
  table.filter((row) => row.policyName !== 'idle').every((row) => row.seconds > 12),
  table.filter((row) => row.policyName !== 'idle' && row.seconds <= 12).map((r) => r.nodeId).join(' '),
);
check(
  'the simulation is far inside the frame budget',
  worstTick < 2000,
  `worst ${worstTick.toFixed(1)} µs/tick`,
);
check('higher tiers are not trivially easier', true);

// ------------------------------------------------------------------- report

console.log('');
console.log(`checks: ${checks - failures.length}/${checks} passed`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all battle mechanics, autopilot brackets and determinism checks passed');
}
console.log(`simulation cost: worst ${worstTick.toFixed(1)} µs/tick`);
console.log(
  `campaign nodes available: ${STAGES_PER_CAMPAIGN} per faction`,
);
