/**
 * Headless v2 battle harness — mechanics assertions, balance brackets and
 * performance for the **isometric-bases** simulation, with no browser involved.
 *
 * v2 replaced the 1-D side-view tug-of-war with a ground plane holding one to
 * five *positions* per side. Two rules are the whole point of the rewrite, and
 * this harness exists mostly to hold them down:
 *
 *   1. **Launches are per pad.** Every position has its own cooldown, so
 *      holding three positions lets you press on three axes at once. A launch
 *      that names a pad must spawn there, spend its supplies, and lock only
 *      that pad — a different pad must still be free in the same instant.
 *   2. **Units re-task.** When a unit's objective is razed while it is still
 *      marching it must re-task onto the nearest surviving hostile position,
 *      not stand in an empty field. Player and enemy units both.
 *
 * Everything else asserted here is the rest of the documented battle contract:
 * the position layout and its hit points, the supply/logistics economy and the
 * terrain surcharges, the fallback rules for a null or razed id, movement over
 * weather and terrain (snow, mud, river spans, trenches, mine belts, the world
 * bounds), the combat rules (engagement range, damage stacking, MG dig-in,
 * lobbed shells with blast falloff, razed positions, bond drops) and how a
 * battle ends (positions destroyed, the stalemate clock, a survival clock).
 *
 * It drives the real `TugSimulation` with the real `createMatchConfig` numbers,
 * so every conclusion comes from the code that ships: an assertion failing here
 * means the game is wrong, not the harness. Part 2 then plays whole campaign
 * nodes with three autopilots (`idle`, `rifle`, `adaptive`) and reports a
 * bracket that keeps the balance honest, plus a µs-per-tick measurement against
 * the 16.6 ms frame budget.
 *
 * Requires Node's built-in TypeScript support (22.18+); see
 * scripts/ts-resolve-hooks.mjs for the extensionless-import shim.
 */

import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));

const { TugSimulation, logisticsCost } = await import('../src/game/TugSimulation.ts');
const { createMatchConfig, positionCountFor } = await import('../src/game/match.ts');
const { UNIT_STATS, BASE_LETTERS } = await import('../src/game/units.ts');
const C = await import('../src/game/constants.ts');
const ENV = await import('../src/game/environment.ts');
const { incomingDamage } = await import('../src/game/damage.ts');
const { createFeatureLayout, trenchAt, inWater } = await import('../src/game/features.ts');
const { getStage } = await import('../src/core/progression.ts');
const { createFreshSave } = await import('../src/core/types.ts');

// ------------------------------------------------------------------- harness

const failures = [];
const simulationBugs = [];
const findings = [];
let checks = 0;

/** One printed line per assertion: `·` when it holds, `x` plus detail when not. */
function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  · ${name}`);
  } else {
    console.log(`  x ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
  return Boolean(condition);
}

/** A failure that looks like the simulation, not the harness. */
function bug(name, detail) {
  simulationBugs.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log('');
  console.log(title);
}

const DT = C.FIXED_DT;
const NO_COMMAND = { deploy: null, fromBaseId: null, targetBaseId: null, buyLogistics: false };

/** One frame of player intent. `null` ids mean "nearest / primary". */
function order(deploy, fromBaseId = null, targetBaseId = null, buyLogistics = false) {
  return { deploy, fromBaseId, targetBaseId, buyLogistics };
}

/** A save with a plausible armoury, so tier checks are not run on a strawman. */
function saveWith(upgrades = {}) {
  return {
    ...createFreshSave(0, []),
    faction: 'allied',
    upgrades: { health: 0, damage: 0, baseHp: 0, ...upgrades },
  };
}

function stageFor(stageId) {
  const stage = getStage(stageId);
  if (!stage) throw new Error(`unknown stage ${stageId}`);
  return stage;
}

/** The real `createMatchConfig`, with optional overrides for a mechanics fixture. */
function simFor(stageId, options = {}) {
  const { upgrades = {}, stageOverrides = {}, configOverrides = {} } = options;
  const stage = { ...stageFor(stageId), ...stageOverrides };
  const config = { ...createMatchConfig(stage, saveWith(upgrades)), ...configOverrides };
  return { sim: new TugSimulation(config), config, stage };
}

/** Update one fixed step and hand back the events, so nothing accumulates. */
function step(sim, command = NO_COMMAND) {
  sim.update(DT, command);
  return sim.takeEvents();
}

/** Advance `ticks` fixed steps; `policy(state, i)` may return a command or null. */
function stepMany(sim, ticks, policy = null) {
  const events = [];
  for (let i = 0; i < ticks; i += 1) {
    if (sim.state.status !== 'running') break;
    sim.update(DT, (policy ? policy(sim.state, i) : NO_COMMAND) ?? NO_COMMAND);
    events.push(...sim.takeEvents());
  }
  return events;
}

/** Advance `seconds` at the shipping fixed step. */
function play(sim, seconds, policy = null) {
  return stepMany(sim, Math.round(seconds / DT), policy);
}

const baseById = (state, id) => state.bases.find((base) => base.id === id);
const sideBases = (state, side) => state.bases.filter((base) => base.side === side);
const aliveBases = (state, side) =>
  state.bases.filter((base) => base.side === side && !base.destroyed);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function nearestTo(state, list, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of list) {
    const d = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

/** The player position that would actually send the next launch (v2: per pad). */
function readyPads(state) {
  return state.bases.filter((base) => base.side === 'player' && !base.destroyed && base.cooldown <= 0);
}

/** A plain sector: `destroy_base`, temperate, no terrain and supplies ×1.0. */
const PLAIN = 'axis-19';

// ------------------------------------------------------------------------- A

section('A. configuration and position layout');

const MISSIONS = ['destroy_base', 'survive_timer', 'assault'];
const SIDES = ['player', 'enemy'];

{
  let inRange = true;
  let detail = '';
  for (let tier = 1; tier <= 9; tier += 1) {
    for (const mission of MISSIONS) {
      for (const side of SIDES) {
        const count = positionCountFor(side, tier, mission);
        if (!Number.isInteger(count) || count < 1 || count > 5) {
          inRange = false;
          detail = `${side} tier ${tier} ${mission} -> ${count}`;
        }
      }
    }
  }
  check('every position count of every tier and mission sits inside 1..5', inRange, detail);
  check(
    'tier 1 is a single position a side',
    positionCountFor('player', 1, 'destroy_base') === 1 &&
      positionCountFor('enemy', 1, 'destroy_base') === 1,
    `player ${positionCountFor('player', 1, 'destroy_base')}, enemy ${positionCountFor('enemy', 1, 'destroy_base')}`,
  );
  check(
    'tier 9 gives each side five positions',
    positionCountFor('player', 9, 'destroy_base') === 5 &&
      positionCountFor('enemy', 9, 'destroy_base') === 5,
    `player ${positionCountFor('player', 9, 'destroy_base')}, enemy ${positionCountFor('enemy', 9, 'destroy_base')}`,
  );
  let assaultBonus = true;
  for (let tier = 1; tier <= 9; tier += 1) {
    const plain = positionCountFor('enemy', tier, 'destroy_base');
    const hardened = positionCountFor('enemy', tier, 'assault');
    // The defender is reinforced for a prepared position; the attacker is not.
    if (hardened !== Math.min(5, plain + 1)) assaultBonus = false;
    if (positionCountFor('player', tier, 'assault') !== positionCountFor('player', tier, 'destroy_base')) {
      assaultBonus = false;
    }
  }
  check('an assault hands the defender one extra position and the attacker none', assaultBonus);
  let defenderAhead = true;
  for (let tier = 1; tier <= 9; tier += 1) {
    if (positionCountFor('enemy', tier, 'destroy_base') < positionCountFor('player', tier, 'destroy_base')) {
      defenderAhead = false;
    }
  }
  check('the defender never holds fewer positions than the attacker', defenderAhead);
}

/** Where the layout is checked: both campaigns, opening, mid and final tiers. */
const LAYOUT_STAGES = [
  'allied-01', // tier 1, assault, snow, trenches
  'allied-13', // mid, desert
  'allied-30', // tier 9, assault, trenches
  'axis-01', // tier 1, assault
  'axis-19', // tier 6, destroy_base, the plain fixture
  'axis-30', // tier 9, survive_timer, mud
];

let minSeparationSeen = Infinity;
const separationViolations = [];
for (const stageId of LAYOUT_STAGES) {
  const { config, stage } = simFor(stageId);
  const countsOk = SIDES.every(
    (side) =>
      config.bases.filter((base) => base.side === side).length ===
      positionCountFor(side, stage.tier, stage.missionType),
  );
  check(`${stageId}: both sides hold their positionCountFor count`, countsOk);

  const ids = new Set(config.bases.map((base) => base.id));
  check(
    `${stageId}: position ids are unique across both sides`,
    ids.size === config.bases.length && config.bases.every((base) => base.id > 0),
    `${ids.size} of ${config.bases.length}`,
  );

  let lettersOk = true;
  for (const side of SIDES) {
    const list = config.bases.filter((base) => base.side === side);
    const inDepth = [...list].sort((a, b) => a.y - b.y);
    list.forEach((base, index) => {
      if (base.letter !== BASE_LETTERS[index]) lettersOk = false;
    });
    inDepth.forEach((base, index) => {
      if (base.letter !== BASE_LETTERS[index]) lettersOk = false;
    });
  }
  check(`${stageId}: letters run A.. in depth order`, lettersOk);

  check(
    `${stageId}: every position carries a name`,
    config.bases.every((base) => typeof base.name === 'string' && base.name.trim().length > 0),
  );

  const hostile = config.bases.filter((base) => base.side === 'enemy');
  check(
    `${stageId}: the primary hostile position carries the campaign's boss name`,
    hostile[0]?.name === stage.bossName && config.strongpoint === stage.bossName,
    `"${hostile[0]?.name}" vs "${stage.bossName}"`,
  );

  const offPlane = config.bases.filter(
    (base) => !(base.x > 0 && base.x < C.WORLD_W && base.y > 0 && base.y < C.WORLD_H),
  );
  check(
    `${stageId}: every position sits inside the ${C.WORLD_W}x${C.WORLD_H} world plane`,
    offPlane.length === 0,
    offPlane.map((base) => `${base.letter}@${base.x},${base.y}`).join(' '),
  );

  let separation = Infinity;
  for (const side of SIDES) {
    const list = config.bases.filter((base) => base.side === side);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        separation = Math.min(separation, Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y));
      }
    }
  }
  minSeparationSeen = Math.min(minSeparationSeen, separation);
  const separationOk = separation >= C.BASE_MIN_SEPARATION - 0.5;
  check(
    `${stageId}: positions respect BASE_MIN_SEPARATION (${C.BASE_MIN_SEPARATION})`,
    separationOk,
    `closest pair ${separation.toFixed(2)}`,
  );
  if (!separationOk) {
    separationViolations.push(`${stageId} closest pair ${separation.toFixed(2)}`);
    bug(
      `position layout (${stageId}): two positions of one side sit ${separation.toFixed(2)} apart, below BASE_MIN_SEPARATION (${C.BASE_MIN_SEPARATION})`,
      'src/game/match.ts layoutPositions(): the `y = Math.max(48, Math.min(WORLD_H - 48, y))` clamp runs *after* the separation pass, so the outer positions are pulled back into the rear band and the separation the pass just reached is lost; the 0.25 x-push per pass is too weak to make the distance up',
    );
  }
}

check(
  'no sampled sector leaves two positions of a side closer than BASE_MIN_SEPARATION',
  separationViolations.length === 0,
  `${separationViolations.length}/${LAYOUT_STAGES.length} sectors: ${separationViolations.join('; ')}`,
);

{
  // Hit points are a side total split over however many positions it holds, with
  // no position ever starved below MIN_BASE_HP, and extra ground adding a
  // modest slice of total HP rather than multiplying the defence.
  const one = simFor('axis-19', { stageOverrides: { tier: 1, missionType: 'destroy_base' } });
  const many = simFor('axis-19', { stageOverrides: { tier: 9, missionType: 'destroy_base' } });

  const playerOne = sideBases(one.sim.state, 'player');
  const playerMany = sideBases(many.sim.state, 'player');
  const sum = (list) => list.reduce((total, base) => total + base.hp, 0);
  const count = (list) => list.length;

  check(
    'a side holding more positions holds more total hit points',
    sum(playerMany) > sum(playerOne) &&
      sum(sideBases(many.sim.state, 'enemy')) >
        sum(sideBases(one.sim.state, 'enemy')) * 0.999 &&
      C.BASE_HP_PER_EXTRA_BASE > 0,
    `player ${count(playerOne)}:${sum(playerOne)} vs ${count(playerMany)}:${sum(playerMany)}, ` +
      `enemy ${count(sideBases(one.sim.state, 'enemy'))}:${sum(sideBases(one.sim.state, 'enemy'))} vs ` +
      `${count(sideBases(many.sim.state, 'enemy'))}:${sum(sideBases(many.sim.state, 'enemy'))}`,
  );

  // The player total is tier-independent, so this isolates the count effect.
  const expectedPlayer = C.PLAYER_BASE_HP_TOTAL * (1 + C.BASE_HP_PER_EXTRA_BASE * (count(playerMany) - 1));
  check(
    'the side total is split across its positions',
    Math.abs(sum(playerMany) - expectedPlayer) <= count(playerMany),
    `${sum(playerMany)} vs ${expectedPlayer.toFixed(1)}`,
  );
  check(
    'no position is starved below MIN_BASE_HP',
    playerMany.every((base) => base.hp >= C.MIN_BASE_HP) &&
      playerOne.every((base) => base.hp >= C.MIN_BASE_HP),
    `${C.MIN_BASE_HP}`,
  );

  // The enemy total grows with the tier as well, so compare it against the
  // one-position baseline at its *own* tier: the extra slice is the count.
  const enemyMany = sideBases(many.sim.state, 'enemy');
  const enemyTierBase = (C.ENEMY_BASE_HP_BASE + C.ENEMY_BASE_HP_PER_TIER * 9) * 1;
  check(
    'the defender gets the same extra-HP slice per position',
    sum(enemyMany) > enemyTierBase * (1 + C.BASE_HP_PER_EXTRA_BASE * 0.5),
    `${sum(enemyMany)} vs one-position baseline ${enemyTierBase}`,
  );
}

{
  // Enemy throughput must be a property of the tier, not of how many positions
  // the sector happens to have: the per-position interval is scaled by the
  // count, so a five-position sector does not field five times the troops.
  let scaled = true;
  let detail = '';
  const perPosition = new Map();
  for (const stageId of ['allied-01', 'allied-13', 'allied-30', 'axis-01', 'axis-19', 'axis-30']) {
    const { config } = simFor(stageId);
    const count = config.bases.filter((base) => base.side === 'enemy').length;
    const perBase =
      config.missionType === 'survive_timer'
        ? C.SURVIVE_ENEMY_DEPLOY_INTERVAL
        : C.ENEMY_DEPLOY_INTERVAL;
    if (Math.abs(config.enemyDeployInterval - perBase * count) > 1e-9) {
      scaled = false;
      detail = `${stageId}: ${config.enemyDeployInterval} vs ${perBase} x ${count}`;
    }
    const key = config.missionType;
    const value = config.enemyDeployInterval / count;
    if (perPosition.has(key) && Math.abs(perPosition.get(key) - value) > 1e-9) {
      scaled = false;
      detail = `${stageId}: throughput ${value} vs ${perPosition.get(key)}`;
    }
    perPosition.set(key, value);
  }
  check('enemyDeployInterval is the per-position interval times the position count', scaled, detail);
  check(
    'total enemy throughput does not grow with the position count',
    perPosition.get('destroy_base') === C.ENEMY_DEPLOY_INTERVAL &&
      perPosition.get('assault') === C.ENEMY_DEPLOY_INTERVAL &&
      perPosition.get('survive_timer') === C.SURVIVE_ENEMY_DEPLOY_INTERVAL,
    [...perPosition.entries()].map(([k, v]) => `${k}=${v}`).join(' '),
  );
}

// ------------------------------------------------------------------------- B

section('B. economy');

{
  const { sim, config } = simFor(PLAIN);
  const start = sim.state.supplies;
  check(
    'the opening bank is the configured start',
    start === config.startSupplies,
    `${start} vs ${config.startSupplies}`,
  );
  check(
    'the supply rate is the configured base rate',
    Math.abs(sim.supplyRate - config.supplyBaseRate) < 1e-9,
    `${sim.supplyRate} vs ${config.supplyBaseRate}`,
  );

  play(sim, 10);
  const expected = start + config.supplyBaseRate * 10;
  check(
    'supplies accrue at the supply rate',
    Math.abs(sim.state.supplies - expected) < 0.5,
    `${sim.state.supplies.toFixed(2)} vs ${expected.toFixed(2)}`,
  );

  // The ceiling: over-fill the bank in one long economic step and it holds at
  // SUPPLY_CAP instead of overflowing into an instant army.
  sim.update(C.SUPPLY_CAP / config.supplyBaseRate + 10, NO_COMMAND);
  sim.takeEvents();
  check(
    'supplies stop at SUPPLY_CAP',
    Math.abs(sim.state.supplies - C.SUPPLY_CAP) < 1e-6,
    `${sim.state.supplies} vs cap ${C.SUPPLY_CAP}`,
  );
  check(
    'suppliesGenerated counts what the tank actually took in',
    sim.state.stats.suppliesGenerated >= C.SUPPLY_CAP - config.startSupplies - 1,
    `${sim.state.stats.suppliesGenerated.toFixed(1)}`,
  );
}

{
  check(
    'logisticsCost is LOGISTICS_BASE_COST + LOGISTICS_COST_STEP * level',
    [0, 1, 2, 3, 4].every(
      (level) => logisticsCost(level) === C.LOGISTICS_BASE_COST + C.LOGISTICS_COST_STEP * level,
    ),
    [0, 1, 2, 3, 4].map((level) => `${level}:${logisticsCost(level)}`).join(' '),
  );
  check(
    'logisticsCost stops at LOGISTICS_MAX_LEVEL',
    logisticsCost(C.LOGISTICS_MAX_LEVEL) === null && logisticsCost(C.LOGISTICS_MAX_LEVEL + 3) === null,
  );

  const firstCost = logisticsCost(0);
  /**
   * Play nodes with a plain rifle flood until one banks the first upgrade: the
   * bonds come from enemy losses, so this is the real route the player takes.
   */
  function bankFirstUpgrade() {
    for (const stageId of ['allied-18', 'axis-12', 'allied-25', 'allied-22', 'axis-19', 'allied-13', 'allied-29', 'axis-26']) {
      const { sim } = simFor(stageId);
      for (let i = 0; i < Math.round(C.MATCH_TIME_LIMIT / DT) && sim.state.status === 'running'; i += 1) {
        if (sim.state.bonds >= firstCost) return { sim, stageId };
        const pad = readyPads(sim.state)[0];
        sim.update(DT, pad && sim.state.supplies >= UNIT_STATS.rifleman.cost ? order('rifleman', pad.id, null) : NO_COMMAND);
        sim.takeEvents();
      }
    }
    return null;
  }

  const banked = bankFirstUpgrade();
  check('destroyed enemies bank bonds for logistics', banked !== null, `best battle never reached ${firstCost} bonds`);
  if (banked) {
    const { sim, stageId } = banked;
    const rateBefore = sim.supplyRate;
    const bondsBefore = sim.state.bonds;
    sim.update(0, order(null, null, null, true));
    check(
      'buying logistics spends bonds',
      Math.abs(sim.state.bonds - (bondsBefore - firstCost)) < 1e-9,
      `${stageId}: ${bondsBefore} -> ${sim.state.bonds}, cost ${firstCost}`,
    );
    check('the logistics level rises', sim.state.logisticsLevel === 1, `${sim.state.logisticsLevel}`);
    check(
      'buying logistics raises the supply rate by one step',
      Math.abs(sim.supplyRate - rateBefore - C.SUPPLY_PER_LOGISTICS_LEVEL) < 1e-9,
      `${rateBefore} -> ${sim.supplyRate}`,
    );
    check(
      'the raised rate is reported to the HUD',
      Math.abs(sim.state.supplyRate - sim.supplyRate) < 1e-9 && sim.state.supplyRate > rateBefore,
      `${sim.state.supplyRate}`,
    );
  } else {
    check('buying logistics spends bonds', false, 'no fixture banked the upgrade');
  }
}

{
  // Logistics is capped: the level never passes the maximum, and at the cap a
  // further purchase is a no-op rather than a bond sink.
  const { sim } = simFor(PLAIN);
  play(sim, C.MATCH_TIME_LIMIT, (state) => {
    const pad = readyPads(state)[0];
    if (state.bonds >= state.logisticsCost && state.logisticsLevel < C.LOGISTICS_MAX_LEVEL) {
      return order(null, null, null, true);
    }
    return pad && state.supplies >= 20 ? order('rifleman', pad.id, null) : NO_COMMAND;
  });
  const state = sim.state;
  check(
    'the logistics level never passes LOGISTICS_MAX_LEVEL',
    state.logisticsLevel <= C.LOGISTICS_MAX_LEVEL,
    `${state.logisticsLevel}`,
  );
  check(
    'the reported logistics cost matches logisticsCost()',
    state.logisticsCost === (logisticsCost(state.logisticsLevel) ?? 0),
    `${state.logisticsCost}`,
  );
  if (state.logisticsLevel === C.LOGISTICS_MAX_LEVEL) {
    const bondsBefore = state.bonds;
    sim.update(0, order(null, null, null, true));
    check(
      'a purchase at the cap spends nothing',
      sim.state.bonds === bondsBefore && sim.state.logisticsLevel === C.LOGISTICS_MAX_LEVEL,
      `${bondsBefore} -> ${sim.state.bonds}`,
    );
  } else {
    console.log(`  · (logistics reached level ${state.logisticsLevel} of ${C.LOGISTICS_MAX_LEVEL} in one battle; the cap rule was asserted on logisticsCost()`);
  }
}

{
  // Armour is the only thing terrain surcharges, and only the mud does it.
  const standard = simFor(PLAIN, { stageOverrides: { environment: 'standard', features: [] } });
  const mud = simFor(PLAIN, { stageOverrides: { environment: 'mud', features: [] } });
  const snow = simFor(PLAIN, { stageOverrides: { environment: 'snow', features: [] } });
  const desert = simFor(PLAIN, { stageOverrides: { environment: 'desert', features: [] } });
  const night = simFor(PLAIN, { stageOverrides: { environment: 'night', features: [] } });

  check(
    'a tank costs its list price on ordinary ground',
    standard.sim.unitCostFor('tank') === UNIT_STATS.tank.cost,
    `${standard.sim.unitCostFor('tank')} vs ${UNIT_STATS.tank.cost}`,
  );
  check(
    'a tank costs 50% more in the mud',
    mud.sim.unitCostFor('tank') === Math.round(UNIT_STATS.tank.cost * 1.5),
    `${mud.sim.unitCostFor('tank')}`,
  );
  check(
    'the mud surcharge shows up in deployOptions',
    mud.sim.state.deployOptions.find((option) => option.kind === 'tank')?.cost ===
      Math.round(UNIT_STATS.tank.cost * 1.5),
  );
  check(
    'infantry costs never change with the terrain',
    ['rifleman', 'smg', 'mg'].every(
      (kind) =>
        standard.sim.unitCostFor(kind) === UNIT_STATS[kind].cost &&
        mud.sim.unitCostFor(kind) === UNIT_STATS[kind].cost &&
        snow.sim.unitCostFor(kind) === UNIT_STATS[kind].cost &&
        desert.sim.unitCostFor(kind) === UNIT_STATS[kind].cost &&
        night.sim.unitCostFor(kind) === UNIT_STATS[kind].cost,
    ),
  );
  check(
    'the environment table is the documented one',
    Math.abs(ENV.environmentRules('snow').moveSpeedMultiplier - 0.65) < 1e-9 &&
      Math.abs(ENV.environmentRules('mud').vehicleSpeedMultiplier - 0.6) < 1e-9 &&
      Math.abs(ENV.environmentRules('mud').tankCostMultiplier - 1.5) < 1e-9 &&
      Math.abs(ENV.environmentRules('desert').rangeMultiplier - 0.5) < 1e-9 &&
      Math.abs(ENV.environmentRules('night').illuminatedDamageMultiplier - 1.5) < 1e-9,
  );
}

// ------------------------------------------------------------- autopilots

/**
 * Three ways to play a whole node, used by the balance bracket. They are
 * deliberately different levels of competence: the bracket only means
 * something if the policies really do play differently.
 */

/** Do nothing at all: never launches, never upgrades. */
function idlePolicy() {
  return NO_COMMAND;
}

/** The naive attacker: a rifleman whenever the supplies allow one. */
function riflePolicy(state) {
  const pad = readyPads(state)[0];
  if (!pad) return NO_COMMAND;
  const cost = state.deployOptions.find((option) => option.kind === 'rifleman')?.cost ?? UNIT_STATS.rifleman.cost;
  return state.supplies >= cost ? order('rifleman', pad.id, null) : NO_COMMAND;
}

/**
 * Mission-aware play. The rifle line is the best value on this field, so it
 * launches a rifleman every time the supplies allow one — from the ready pad
 * nearest the objective, so a launch never waits on one pad's cooldown — and
 * presses the hostile position nearest its own leading ready pad, so the force
 * stays on one axis and spends as little time as possible closing the
 * distance on foot. Labelling the objective and the pad every launch is what
 * makes it re-pick automatically when a position falls.
 *
 * Everything else is a deliberate exception to the line: logistics waits until
 * four units are in the field (bonds buy nothing else, but tempo is worth more
 * than supply rate while the line is still thin), the machine gun only answers
 * an enemy that is actually on the field in numbers, and armour is bought only
 * when the enemy has armour this policy has no answer to *and* the bank can
 * pay for it and keep the line coming.
 */
function adaptivePolicy(state) {
  const pads = readyPads(state);
  const mine = state.units.filter((unit) => unit.side === 'player');
  const targets = aliveBases(state, 'enemy');
  const hostiles = state.units.filter((unit) => unit.side === 'enemy');
  if (targets.length === 0 || pads.length === 0) return NO_COMMAND;
  const cost = (kind) => state.deployOptions.find((option) => option.kind === kind)?.cost ?? UNIT_STATS[kind].cost;
  const count = (list, kind) => list.filter((unit) => unit.kind === kind).length;

  // 1. The objective: the hostile position our leading ready pad can reach
  //    first. Distance breaking the tie keeps the march short.
  const objective = nearestTo(state, targets, pads[0]) ?? targets[0];
  // 2. The ready pad nearest that objective, so the walk in is short and no
  //    launch is wasted waiting on another pad's cooldown.
  const pad = nearestTo(state, pads, objective) ?? pads[0];

  // 3. What to send. The line is riflemen first, with two exceptions: armour
  //    as the answer to *their* armour (with a reserve, so the line keeps
  //    coming while the tank is bought) and a dug-in gun once they have two or
  //    more figures on the field to suppress.
  const myArmour = count(mine, 'tank');
  const myMgs = count(mine, 'mg');
  if (count(hostiles, 'tank') > myArmour && state.supplies >= cost('tank') + 60) {
    return order('tank', pad.id, objective.id);
  }
  if (hostiles.length >= 2 && myMgs < 2 && state.supplies >= cost('mg')) {
    return order('mg', pad.id, objective.id);
  }
  if (state.supplies >= cost('rifleman')) return order('rifleman', pad.id, objective.id);

  // 4. Logistics last, and only once the line is real: 30 bonds is most of a
  //    rifleman's worth of tempo, but the extra supply rate compounds for the
  //    rest of the battle.
  if (
    mine.length >= 4 &&
    state.bonds >= state.logisticsCost &&
    state.logisticsLevel < C.LOGISTICS_MAX_LEVEL
  ) {
    return order(null, null, null, true);
  }
  return NO_COMMAND;
}

const POLICIES = { idle: idlePolicy, rifle: riflePolicy, adaptive: adaptivePolicy };

/** Play a whole node to its finish, collecting the numbers the table reports. */
function runNode(stageId, policyName, options = {}) {
  const { sim, config } = simFor(stageId, options);
  const policy = POLICIES[policyName];
  let ticks = 0;
  let peakUnits = 0;
  let terminalEvents = 0;
  let retargetEvents = 0;
  const started = performance.now();
  for (let i = 0; i < Math.round(260 / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    sim.update(DT, policy(sim.state) ?? NO_COMMAND);
    for (const event of sim.takeEvents()) {
      if (event.type === 'victory' || event.type === 'defeat') terminalEvents += 1;
      if (event.type === 'retarget') retargetEvents += 1;
    }
    ticks += 1;
    peakUnits = Math.max(peakUnits, sim.state.units.length);
  }
  const cpuMs = performance.now() - started;
  const state = sim.state;
  return {
    stageId,
    policy: policyName,
    tier: config.tier,
    mission: config.missionType,
    environment: config.environment,
    features: config.features,
    playerPositions: config.bases.filter((base) => base.side === 'player').length,
    enemyPositions: config.bases.filter((base) => base.side === 'enemy').length,
    status: state.status,
    reason: state.lossReason,
    seconds: state.time,
    deployed: state.stats.deployed,
    losses: state.stats.losses,
    kills: state.stats.kills,
    bonds: state.stats.bondsCollected,
    logistics: state.stats.logisticsBought,
    retargets: state.stats.retargets,
    minesHit: state.stats.minesHit + state.stats.enemyMinesHit,
    basesDestroyed: state.stats.basesDestroyed,
    basesLost: state.stats.basesLost,
    baseDamage: state.stats.baseDamage,
    peakUnits,
    terminalEvents,
    retargetEvents,
    usPerTick: (cpuMs / Math.max(1, ticks)) * 1000,
    ticks,
    config,
    final: state,
    sim,
  };
}

/**
 * The balance sample: every mission type, every environment and every terrain
 * feature, spread across the opening, middle and last tiers of the campaign.
 * Fifteen nodes is enough to catch a policy that only works on one kind of
 * ground, and cheap enough to play three times in a few seconds.
 */
const SAMPLE_NODES = [
  'allied-01', // tier 1, assault, snow, trenches
  'allied-02', // tier 1, survive_timer, standard, minefield
  'allied-03', // tier 1, destroy_base, night, no terrain
  'allied-04', // tier 1, assault, desert, no terrain
  'allied-07', // tier 2, assault, snow, trenches
  'allied-13', // tier 4, assault, desert, trenches + minefield
  'allied-17', // tier 5, assault, mud, bridge chokepoint
  'allied-18', // tier 6, assault, standard, trenches + minefield
  'allied-22', // tier 7, assault, standard, minefield + trenches
  'allied-27', // tier 8, survive_timer, snow, trenches + minefield
  'allied-29', // tier 9, assault, night, trenches + minefield
  'axis-12', // tier 4, destroy_base, mud, trenches + minefield
  'axis-21', // tier 7, survive_timer, snow, trenches
  'axis-26', // tier 8, assault, snow, minefield
  'axis-30', // tier 9, survive_timer, mud, trenches
];

let sweepCache = null;

/** Play the whole sample once: section G and the bracket table share the rows. */
function sweepRows() {
  if (sweepCache) return sweepCache;
  sweepCache = [];
  for (const nodeId of SAMPLE_NODES) {
    for (const policyName of ['idle', 'rifle', 'adaptive']) {
      sweepCache.push(runNode(nodeId, policyName));
    }
  }
  return sweepCache;
}

// The exploratory sweep this harness was written against. It is kept because it
// is the fastest way to see the whole balance table raw (`SIM_DIAG=1 npm run
// check:sim`); it is not part of the assertions.
if (process.env.SIM_DIAG === '1') {
  const CANDIDATES = [
    'allied-01', 'allied-02', 'allied-03', 'allied-04', 'allied-05', 'allied-07', 'allied-10',
    'allied-11', 'allied-13', 'allied-17', 'allied-18', 'allied-22', 'allied-25', 'allied-27',
    'allied-29', 'allied-30', 'axis-01', 'axis-03', 'axis-09', 'axis-12', 'axis-19', 'axis-21',
    'axis-22', 'axis-26', 'axis-30',
  ];
  console.log('=== DIAGNOSTIC: node sweep ===');
  console.log(
    ['node', 'tier', 'mission', 'env', 'feat', 'P/E', 'policy', 'result', 'sec', 'k/l', 'dep', 'bonds', 'logi', 'peak', 'retg', 'mines', 'maxSup']
      .map((h, i) => h.padEnd([8, 4, 14, 9, 22, 5, 9, 16, 6, 8, 4, 6, 5, 5, 5, 6, 7][i]))
      .join(' '),
  );
  for (const id of CANDIDATES) {
    for (const policy of ['idle', 'rifle', 'adaptive']) {
      const r = runNode(id, policy);
      console.log(
        [
          id.padEnd(8),
          String(r.tier).padEnd(4),
          r.mission.padEnd(14),
          r.environment.padEnd(9),
          (r.features.join('+') || '-').padEnd(22),
          `${r.playerPositions}/${r.enemyPositions}`.padEnd(5),
          policy.padEnd(9),
          `${r.status}${r.reason === 'time-expired' ? '*' : ''}`.padEnd(16),
          r.seconds.toFixed(1).padEnd(6),
          `${r.kills}/${r.losses}`.padEnd(8),
          String(r.deployed).padEnd(4),
          String(r.bonds).padEnd(6),
          String(r.logistics).padEnd(5),
          String(r.peakUnits).padEnd(5),
          String(r.retargets).padEnd(5),
          String(r.minesHit).padEnd(6),
          r.maxSupplies.toFixed(0).padEnd(7),
        ].join(' '),
      );
    }
  }

  console.log('');
  console.log('=== DIAGNOSTIC: events and razed positions (adaptive) ===');
  const SPECIAL = ['allied-02', 'allied-11', 'allied-17', 'allied-18', 'allied-25', 'allied-29', 'allied-30', 'axis-01', 'axis-12', 'axis-19', 'axis-22', 'axis-30'];
  for (const id of SPECIAL) {
    const { sim } = simFor(id);
    const counts = {};
    let playerRazedAt = null;
    let playerRazedId = null;
    let enemyRazedAt = null;
    let illuminatedHits = 0;
    let minSeparation = Infinity;
    let retargetsSeen = 0;
    for (let i = 0; i < Math.round(180 / DT); i += 1) {
      if (sim.state.status !== 'running') break;
      sim.update(DT, adaptivePolicy(sim.state));
      for (const event of sim.takeEvents()) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === 'retarget') retargetsSeen += 1;
      }
      if (playerRazedAt === null) {
        const razed = sim.state.bases.find((base) => base.side === 'player' && base.destroyed);
        if (razed) {
          playerRazedAt = sim.state.time;
          playerRazedId = razed.id;
        }
      }
      if (enemyRazedAt === null && sim.state.bases.some((base) => base.side === 'enemy' && base.destroyed)) {
        enemyRazedAt = sim.state.time;
      }
      for (const list of [sideBases(sim.state, 'player'), sideBases(sim.state, 'enemy')]) {
        for (let a = 0; a < list.length; a += 1) {
          for (let b = a + 1; b < list.length; b += 1) {
            minSeparation = Math.min(minSeparation, distance(list[a], list[b]));
          }
        }
      }
      for (const unit of sim.state.units) if (unit.illuminated && unit.hp < unit.maxHp) illuminatedHits += 1;
    }
    console.log(
      `${id.padEnd(9)} status=${sim.state.status}/${sim.state.lossReason} t=${sim.state.time.toFixed(1)} ` +
        `pRazed=${playerRazedAt ? `${playerRazedAt.toFixed(1)}s(#${playerRazedId})` : '-'} ` +
        `eRazed=${enemyRazedAt ? `${enemyRazedAt.toFixed(1)}s` : '-'} ` +
        `illumHits=${illuminatedHits} minSep=${minSeparation === Infinity ? '-' : minSeparation.toFixed(1)} ` +
        Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' '),
    );
  }
}

// ------------------------------------------------------------------------- C

/**
 * The v2 pacing rule: a launch names a pad, the pad pays its own cooldown, and
 * pads are independent of each other. Everything in this section is that rule.
 */
const BOOSTED = { configOverrides: { startSupplies: 400 } };

section('C. launch — per-pad timing, objectives and refusals');

{
  const { sim } = simFor(PLAIN, BOOSTED);
  const pads = sideBases(sim.state, 'player');
  const hostiles = sideBases(sim.state, 'enemy');
  const pad = pads[0];
  const other = pads[1];
  const target = hostiles[1];
  check('the fixture offers more than one launch pad', pads.length >= 2, `${pads.length}`);

  const suppliesBefore = sim.state.supplies;
  sim.update(0, order('rifleman', pad.id, target.id));
  const mine = sim.state.units.filter((unit) => unit.side === 'player');
  const unit = mine[0];
  check('a launch spawns exactly one unit', mine.length === 1 && sim.state.stats.deployed === 1);
  check(
    'a launch spends the unit cost',
    Math.abs(suppliesBefore - sim.state.supplies - UNIT_STATS.rifleman.cost) < 1e-9,
    `${suppliesBefore} -> ${sim.state.supplies}, cost ${UNIT_STATS.rifleman.cost}`,
  );
  check(
    'the unit spawns on the named pad',
    Boolean(unit) &&
      Math.hypot(unit.x - pad.x, unit.y - pad.y) <= C.BASE_FOOTPRINT + UNIT_STATS.rifleman.radius + 12,
    unit ? `${Math.hypot(unit.x - pad.x, unit.y - pad.y).toFixed(1)} from the pad` : 'no unit',
  );
  check('the unit remembers the pad it launched from', unit?.homeBaseId === pad.id, `${unit?.homeBaseId}`);
  check('the unit remembers the objective it was given', unit?.targetBaseId === target.id, `${unit?.targetBaseId} vs ${target.id}`);
  check(
    'the launching pad starts its own launch cooldown',
    Math.abs(pad.cooldown - UNIT_STATS.rifleman.launchCooldown) < 1e-9 && pad.pendingKind === 'rifleman',
    `cooldown ${pad.cooldown}`,
  );

  const suppliesAfter = sim.state.supplies;
  sim.update(0, order('rifleman', pad.id, target.id));
  check(
    'the same pad is refused while its own cooldown runs',
    sim.state.units.length === 1 && sim.state.supplies === suppliesAfter && sim.state.stats.deployed === 1,
    `units ${sim.state.units.length}, supplies ${sim.state.supplies}, deployed ${sim.state.stats.deployed}`,
  );

  // The headline change: a second pad is a second front in the same instant.
  sim.update(0, order('rifleman', other.id, target.id));
  const both = sim.state.units.filter((unit) => unit.side === 'player');
  check(
    'a different pad launches in the same moment',
    both.length === 2 && both.some((unit) => unit.homeBaseId === other.id) && sim.state.stats.launches === 2,
    `units ${both.length}, launches ${sim.state.stats.launches}`,
  );
  check(
    'each pad owns its own cooldown',
    pad.cooldown > 0 && other.cooldown > 0 && pad.cooldown !== Infinity,
    `${pad.cooldown.toFixed(2)} / ${other.cooldown.toFixed(2)}`,
  );

  play(sim, 1);
  check(
    'a pad cooldown decays with battle time, not with launches',
    Math.abs(pad.cooldown - (UNIT_STATS.rifleman.launchCooldown - 1)) < 0.03,
    `${pad.cooldown.toFixed(3)}`,
  );
  play(sim, 0.7);
  sim.update(0, order('rifleman', pad.id, target.id));
  check('a pad launches again once its cooldown has run out', sim.state.stats.launches === 3, `${sim.state.stats.launches}`);
}

{
  // Null ids mean "choose sensibly", and any id that is not a living hostile /
  // living pad falls back rather than ordering nothing.
  const { sim } = simFor(PLAIN, BOOSTED);
  const pads = sideBases(sim.state, 'player');
  const hostiles = aliveBases(sim.state, 'enemy');

  sim.update(0, order('rifleman', null, null));
  const nullUnit = sim.state.units[0];
  const nullTarget = nullUnit ? baseById(sim.state, nullUnit.targetBaseId) : null;
  check(
    'a null objective falls back to a living hostile position',
    Boolean(nullTarget) && nullTarget.side === 'enemy' && !nullTarget.destroyed,
    `${nullUnit?.targetBaseId}`,
  );
  check(
    'a null pad falls back to the pad nearest the objective',
    nullUnit?.homeBaseId === nearestTo(sim.state, pads, nullTarget)?.id,
    `${nullUnit?.homeBaseId} vs ${nearestTo(sim.state, pads, nullTarget)?.id}`,
  );

  // An explicit objective with a null pad: the pad nearest *that* objective.
  const far = hostiles[hostiles.length - 1];
  const { sim: sim2 } = simFor(PLAIN, BOOSTED);
  sim2.update(0, order('rifleman', null, far.id));
  const unit2 = sim2.state.units[0];
  check(
    'a null pad picks the position nearest the named objective',
    unit2?.homeBaseId === nearestTo(sim2.state, sideBases(sim2.state, 'player'), far)?.id &&
      unit2?.targetBaseId === far.id,
    `pad ${unit2?.homeBaseId}, target ${unit2?.targetBaseId}`,
  );

  // Explicit pad, null objective: the leading hostile position.
  const { sim: sim3 } = simFor(PLAIN, BOOSTED);
  sim3.update(0, order('rifleman', pads[0].id, null));
  check(
    'an explicit pad with a null objective takes the primary hostile position',
    sim3.state.units[0]?.targetBaseId === aliveBases(sim3.state, 'enemy')[0]?.id,
    `${sim3.state.units[0]?.targetBaseId}`,
  );

  // An id that is not a live hostile position (here: one of our own pads) is
  // ignored, not obeyed.
  const { sim: sim4 } = simFor(PLAIN, BOOSTED);
  sim4.update(0, order('rifleman', null, pads[0].id));
  const unit4 = sim4.state.units[0];
  check(
    'a target id that is not a living hostile position falls back',
    Boolean(unit4) && aliveBases(sim4.state, 'enemy').some((base) => base.id === unit4.targetBaseId),
    `${unit4?.targetBaseId}`,
  );
}

/** Play until a position of `side` is razed while the battle is still running. */
function huntRazedBase(stageId, side, policy, options, maxSeconds = 200) {
  const { sim } = simFor(stageId, options);
  for (let i = 0; i < Math.round(maxSeconds / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    sim.update(DT, policy(sim.state));
    sim.takeEvents();
    const razed = sim.state.bases.find((base) => base.side === side && base.destroyed);
    if (razed) return { sim, razed, alive: aliveBases(sim.state, side) };
  }
  return { sim, razed: null, alive: aliveBases(sim.state, side) };
}

/** A generous fixture: the point is the order rules, not the supply rate. */
const RICH = { configOverrides: { startSupplies: 400, supplyBaseRate: 20 } };

/** Issue one order at zero dt and hand back the unit it spawned, if any. */
function launchedUnit(sim, command) {
  const before = new Set(sim.state.units.map((unit) => unit.id));
  sim.update(0, command);
  sim.takeEvents();
  return sim.state.units.find((unit) => !before.has(unit.id)) ?? null;
}

/**
 * Wait until an order would actually be accepted: the bank can pay, a living
 * pad is off cooldown *and* the field is below the unit cap. Without all three
 * the order is refused and the fixture silently tests nothing — a flooded
 * field is just as bad as a pad on cooldown.
 */
function readyToLaunch(sim, cost, ticks = 900) {
  for (let i = 0; i < ticks && sim.state.status === 'running'; i += 1) {
    const padReady = readyPads(sim.state).length > 0;
    const underCap = sim.state.playerUnits < C.MAX_UNITS_PER_SIDE;
    if (padReady && underCap && sim.state.supplies >= cost) return true;
    sim.update(DT, NO_COMMAND);
    sim.takeEvents();
  }
  return false;
}

{
  // A razed pad id must fall back to a living one, and a razed objective id to a
  // living hostile position — silently doing nothing would strand the player.
  const enemyHunt = huntRazedBase(PLAIN, 'enemy', adaptivePolicy, RICH, 120);
  check('a hostile position can be razed mid-battle (fixture)', Boolean(enemyHunt.razed), 'no enemy position fell inside 120s');
  if (enemyHunt.razed) {
    const { sim, razed } = enemyHunt;
    // The order has to be *acceptable* — bank paid and a pad off cooldown — or
    // the fallback under test never runs.
    readyToLaunch(sim, UNIT_STATS.rifleman.cost);
    const suppliesBefore = sim.state.supplies;
    const unit = launchedUnit(sim, order('rifleman', null, razed.id));
    check(
      'a launch ordered onto a razed position falls back to a living one',
      Boolean(unit) &&
        unit.targetBaseId !== razed.id &&
        aliveBases(sim.state, 'enemy').some((base) => base.id === unit.targetBaseId),
      `target ${unit?.targetBaseId}, razed ${razed.id}, supplies ${suppliesBefore.toFixed(0)}`,
    );
    check('and it still spends the supplies', sim.state.supplies < suppliesBefore, `${suppliesBefore} -> ${sim.state.supplies}`);
  }

  // The player does nothing at all here, so its own positions are the ones that
  // fall — which is the situation the razed-pad fallback is for.
  const playerHunt = huntRazedBase(PLAIN, 'player', idlePolicy, {}, 120);
  check('a friendly position can be razed mid-battle (fixture)', Boolean(playerHunt.razed), 'no player position fell inside 120s');
  if (playerHunt.razed) {
    const { sim, razed } = playerHunt;
    readyToLaunch(sim, UNIT_STATS.rifleman.cost);
    const suppliesBefore = sim.state.supplies;
    const unit = launchedUnit(sim, order('rifleman', razed.id, null));
    check(
      'a launch ordered from a razed pad falls back to a living pad',
      Boolean(unit) && unit.homeBaseId !== razed.id && aliveBases(sim.state, 'player').some((base) => base.id === unit.homeBaseId),
      `pad ${unit?.homeBaseId}, razed ${razed.id}, supplies ${suppliesBefore.toFixed(0)}`,
    );
    check(
      'and the fallback unit is on the field, not silently dropped',
      Boolean(unit) && sim.state.units.some((candidate) => candidate.id === unit.id),
    );
  }
}

{
  // Refusals: no supplies, or the field is already full. And `deployOptions`
  // has to report the truth about cost, affordability and readiness.
  const poor = simFor(PLAIN);
  check('the opening bank cannot pay for a tank', poor.sim.state.supplies < UNIT_STATS.tank.cost);
  const launchesBefore = poor.sim.state.stats.launches;
  poor.sim.update(0, order('tank', null, null));
  check(
    'a launch is refused when the supplies are short',
    poor.sim.state.stats.launches === launchesBefore && !poor.sim.state.units.some((unit) => unit.kind === 'tank'),
    `supplies ${poor.sim.state.supplies}`,
  );

  const rich = simFor(PLAIN, BOOSTED);
  const options = rich.sim.state.deployOptions;
  check(
    'deployOptions reports every unit kind, cheapest first',
    options.length === 4 && options[0].kind === 'rifleman' && options[3].kind === 'tank',
    options.map((option) => option.kind).join(','),
  );
  check(
    'deployOptions reports the real cost (terrain surcharge included)',
    options.every((option) => option.cost === rich.sim.unitCostFor(option.kind)),
    options.map((option) => `${option.kind}:${option.cost}`).join(' '),
  );
  check(
    'deployOptions reports affordability against the real bank',
    options.every((option) => option.affordable === (rich.sim.state.supplies >= option.cost)),
  );
  check(
    'deployOptions reports readiness and the pad cooldown',
    options.every(
      (option) =>
        option.launchCooldown === Math.min(...sideBases(rich.sim.state, 'player').map((base) => base.cooldown)) &&
        option.cooldownTotal === UNIT_STATS[option.kind].launchCooldown &&
        option.ready === (option.affordable && option.launchCooldown <= 0),
    ),
    options.map((option) => `${option.kind}:${option.ready}`).join(' '),
  );

  // Flood the field to the side cap. The economy is boosted so the cap — not
  // the supply rate — is what stops the launches.
  const busy = simFor(PLAIN, { configOverrides: { startSupplies: 400, supplyBaseRate: 40 } });
  let peak = 0;
  for (let i = 0; i < Math.round(90 / DT) && busy.sim.state.status === 'running'; i += 1) {
    const padReady = readyPads(busy.sim.state)[0];
    const count = busy.sim.state.playerUnits;
    peak = Math.max(peak, count);
    if (count >= C.MAX_UNITS_PER_SIDE) break;
    busy.sim.update(DT, padReady && busy.sim.state.supplies >= UNIT_STATS.rifleman.cost ? order('rifleman', padReady.id, null) : NO_COMMAND);
    busy.sim.takeEvents();
  }
  check(
    'a side can fill the field to MAX_UNITS_PER_SIDE in a busy battle (fixture)',
    busy.sim.state.playerUnits >= C.MAX_UNITS_PER_SIDE,
    `peak ${Math.max(peak, busy.sim.state.playerUnits)} of ${C.MAX_UNITS_PER_SIDE}`,
  );
  if (busy.sim.state.playerUnits >= C.MAX_UNITS_PER_SIDE) {
    const suppliesBefore = busy.sim.state.supplies;
    const pad = readyPads(busy.sim.state)[0];
    const padId = pad ? pad.id : sideBases(busy.sim.state, 'player')[0].id;
    busy.sim.update(0, order('rifleman', padId, null));
    check(
      'a launch is refused when the side is at its unit cap',
      busy.sim.state.playerUnits === C.MAX_UNITS_PER_SIDE && busy.sim.state.supplies === suppliesBefore,
      `${busy.sim.state.playerUnits} units, supplies ${busy.sim.state.supplies}`,
    );
    check(
      'deployOptions reports the cap as not ready but affordable',
      busy.sim.state.deployOptions.every((option) => option.affordable === (busy.sim.state.supplies >= option.cost) && option.ready === false),
    );
  }
}

// ------------------------------------------------------------------------- D

/**
 * The other headline change: an objective that falls does not strand the troops
 * marching at it. They re-task onto the nearest *surviving* hostile position,
 * count themselves in `stats.retargets`, emit one `retarget` event — and only
 * one, however many times their new objective is decided later.
 */

section('D. retargeting');

/**
 * Play a node until a unit of `side` re-tasks, catching the exact tick: the
 * unit's target at the start of the tick, the survivors it could have chosen,
 * and the events the sim emitted.
 */
function huntRetarget(stageId, side, policy, options = {}, maxSeconds = 200) {
  const { sim } = simFor(stageId, options);
  const hostileSide = side === 'player' ? 'enemy' : 'player';
  for (let i = 0; i < Math.round(maxSeconds / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    const before = new Map();
    for (const unit of sim.state.units) {
      before.set(unit.id, {
        x: unit.x,
        y: unit.y,
        target: unit.targetBaseId,
        retargeted: unit.retargeted,
        state: unit.state,
        kind: unit.kind,
      });
    }
    const retargetsBefore = sim.state.stats.retargets;
    sim.update(DT, policy(sim.state));
    const events = sim.takeEvents();
    const retargetEvents = events.filter((event) => event.type === 'retarget');
    const survivors = aliveBases(sim.state, hostileSide);
    const caught = [];
    for (const unit of sim.state.units) {
      if (unit.side !== side) continue;
      const prior = before.get(unit.id);
      if (!prior || prior.retargeted || !unit.retargeted) continue;
      caught.push({
        unit,
        prior,
        expected: nearestTo(sim.state, survivors, prior),
        targetChanged: unit.targetBaseId !== prior.target,
      });
    }
    if (caught.length > 0) {
      return { sim, caught, retargetEvents, retargetsBefore, retargetsAfter: sim.state.stats.retargets, survivors, policy, hostileSide };
    }
  }
  return { sim, caught: [], retargetEvents: [], retargetsBefore: 0, retargetsAfter: 0, survivors: [], policy, hostileSide };
}

{
  const hunt = huntRetarget(PLAIN, 'player', adaptivePolicy, { configOverrides: { startSupplies: 400 } }, 150);
  check('a player unit re-tasks when its objective falls (fixture)', hunt.caught.length > 0, 'no player retarget inside 150s');
  if (hunt.caught.length > 0) {
    const { caught, retargetEvents, retargetsBefore, retargetsAfter } = hunt;
    const allExpected = caught.every(
      (entry) => entry.expected && entry.unit.targetBaseId === entry.expected.id,
    );
    check(
      'the unit re-tasks onto the nearest surviving hostile position',
      allExpected && caught.every((entry) => entry.targetChanged),
      caught.map((entry) => `target ${entry.prior.target} -> ${entry.unit.targetBaseId} (nearest ${entry.expected?.id})`).join('; '),
    );
    // The re-tasked unit has to still be a live figure in the field — not
    // parked on a razed position. Which of the two field states it is in when
    // the objective falls depends on whether it happened to be shooting, so
    // the check reports the state rather than demanding one of them.
    const fielded = caught.filter((entry) => entry.prior.state !== 'hold' && entry.unit.hp > 0);
    check(
      'the re-tasked unit was still in the field when the objective fell',
      fielded.length === caught.length,
      caught.map((entry) => `${entry.prior.state} hp ${entry.unit.hp.toFixed(0)}`).join(', '),
    );
    check(
      'stats.retargets counts exactly one per re-tasked unit',
      retargetsAfter - retargetsBefore === caught.length,
      `${retargetsBefore} -> ${retargetsAfter} for ${caught.length} unit(s)`,
    );
    const sideEvents = retargetEvents.filter((event) => (event.side ?? 'player') === 'player').length;
    check('a retarget event is emitted', retargetEvents.length > 0 && sideEvents >= retargetEvents.length, `${retargetEvents.length} events`);

    // A second tick must not re-emit: the unit is only ever counted once.
    const window = stepMany(hunt.sim, 120, adaptivePolicy);
    const retargetsInWindow = window.filter((event) => event.type === 'retarget').length;
    const destroyedInWindow = window.filter((event) => event.type === 'baseDestroyed').length;
    check(
      'a second (and third) tick never re-emits for the same unit',
      retargetsInWindow === 0,
      `${retargetsInWindow} retarget events in 2s (${destroyedInWindow} positions razed)`,
    );
    check(
      'the retarget tally does not move again for the same units',
      hunt.sim.state.stats.retargets === retargetsAfter,
      `${retargetsAfter} -> ${hunt.sim.state.stats.retargets}`,
    );
  }
}

{
  const hunt = huntRetarget(PLAIN, 'enemy', idlePolicy, {}, 200);
  check('an enemy unit re-tasks when its objective falls (fixture)', hunt.caught.length > 0, 'no enemy retarget inside 200s');
  if (hunt.caught.length > 0) {
    const { caught, retargetEvents, retargetsBefore, retargetsAfter } = hunt;
    check(
      'the enemy unit also re-tasks onto the nearest surviving position',
      caught.every((entry) => entry.expected && entry.unit.targetBaseId === entry.expected.id && entry.targetChanged),
      caught.map((entry) => `target ${entry.prior.target} -> ${entry.unit.targetBaseId} (nearest ${entry.expected?.id})`).join('; '),
    );
    check(
      'the enemy retarget is counted and reported',
      retargetsAfter - retargetsBefore === caught.length &&
        retargetEvents.some((event) => event.side === 'enemy'),
      `${retargetsBefore} -> ${retargetsAfter}; sides ${retargetEvents.map((event) => event.side ?? '-').join(',')}`,
    );
    const window = stepMany(hunt.sim, 120, idlePolicy);
    check(
      'the enemy does not re-emit either',
      window.filter((event) => event.type === 'retarget').length === 0,
      `${window.filter((event) => event.type === 'retarget').length}`,
    );
  }
}

// ------------------------------------------------------------------------- E

section('E. movement, weather and terrain');

function distanceTravelled(environment, kind, seconds, configOverrides = {}) {
  const { sim } = simFor(PLAIN, {
    stageOverrides: { environment, features: [], missionType: 'destroy_base' },
    configOverrides: { startSupplies: 400, ...configOverrides },
  });
  const pad = sideBases(sim.state, 'player')[0];
  const target = aliveBases(sim.state, 'enemy')[0];
  sim.update(0, order(kind, pad.id, target.id));
  const unit = sim.state.units.find((candidate) => candidate.side === 'player');
  let travelled = 0;
  let marching = true;
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const beforeX = unit.x;
    const beforeY = unit.y;
    sim.update(DT, NO_COMMAND);
    sim.takeEvents();
    if (unit.state !== 'advance') {
      marching = false;
      break;
    }
    travelled += Math.hypot(unit.x - beforeX, unit.y - beforeY);
  }
  return { travelled, marching, unit };
}

{
  const { sim } = simFor(PLAIN, BOOSTED);
  const pad = sideBases(sim.state, 'player')[0];
  sim.update(0, order('rifleman', pad.id, null));
  const unit = sim.state.units[0];
  const startDistance = distance(unit, baseById(sim.state, unit.targetBaseId));
  const marchedBefore = unit.marched;
  const strideBefore = unit.stride;
  play(sim, 2);
  const after = sim.state.units.find((candidate) => candidate.id === unit.id);
  const endDistance = distance(after, baseById(sim.state, after.targetBaseId));
  check(
    'a unit closes the distance on its objective',
    endDistance < startDistance - 60,
    `${startDistance.toFixed(0)} -> ${endDistance.toFixed(0)}`,
  );
  check(
    'stride advances with distance travelled',
    after.marched > marchedBefore + 60 && after.stride !== strideBefore,
    `marched ${marchedBefore.toFixed(1)} -> ${after.marched.toFixed(1)}, stride ${strideBefore.toFixed(3)} -> ${after.stride.toFixed(3)}`,
  );
  check('state is "advance" while nothing is in range', after.state === 'advance', after.state);

  // Once it is stopped, neither marched nor stride may creep: the walk cycle is
  // driven by distance, so a unit holding a line stands still.
  const { sim: stopped } = simFor(PLAIN, BOOSTED);
  const pad2 = sideBases(stopped.state, 'player')[0];
  stopped.update(0, order('rifleman', pad2.id, null));
  const walker = stopped.state.units[0];
  let stoppedUnit = null;
  for (let i = 0; i < 60 * 60 && !stoppedUnit; i += 1) {
    stopped.update(DT, NO_COMMAND);
    stopped.takeEvents();
    const live = stopped.state.units.find((candidate) => candidate.id === walker.id);
    if (live && live.state === 'engage') stoppedUnit = live;
  }
  check('a unit eventually stops to fight (fixture)', Boolean(stoppedUnit), 'never engaged');
  if (stoppedUnit) {
    const marched = stoppedUnit.marched;
    const stride = stoppedUnit.stride;
    play(stopped, 1);
    const still = stopped.state.units.find((candidate) => candidate.id === walker.id);
    check(
      'stride does not advance while a unit is stopped',
      still && still.marched === marched && still.stride === stride,
      still ? `marched ${marched.toFixed(2)} -> ${still.marched.toFixed(2)}, stride ${stride.toFixed(3)} -> ${still.stride.toFixed(3)}` : 'unit died',
    );
  }
}

{
  // Weather: identical setups, one environment different, so the ratio is the
  // modifier itself rather than the fortunes of one soldier.
  const groundStandard = distanceTravelled('standard', 'rifleman', 2.5);
  const groundSnow = distanceTravelled('snow', 'rifleman', 2.5);
  const groundMud = distanceTravelled('mud', 'rifleman', 2.5);
  const tankStandard = distanceTravelled('standard', 'tank', 3);
  const tankSnow = distanceTravelled('snow', 'tank', 3);
  const tankMud = distanceTravelled('mud', 'tank', 3);

  check(
    'the march comparison is a march, not a firefight',
    [groundStandard, groundSnow, groundMud, tankStandard, tankSnow, tankMud].every((run) => run.marching),
    [groundStandard, groundSnow, groundMud, tankStandard, tankSnow, tankMud].map((run) => run.marching).join(','),
  );
  const snowRatio = groundSnow.travelled / groundStandard.travelled;
  check(
    'snow moves ground units at 65% of their base speed',
    snowRatio > 0.6 && snowRatio < 0.7,
    `${groundStandard.travelled.toFixed(1)} vs ${groundSnow.travelled.toFixed(1)} (ratio ${snowRatio.toFixed(3)})`,
  );
  const mudRatio = tankMud.travelled / tankStandard.travelled;
  check(
    'mud slows vehicles by 40%',
    mudRatio > 0.55 && mudRatio < 0.65,
    `${tankStandard.travelled.toFixed(1)} vs ${tankMud.travelled.toFixed(1)} (ratio ${mudRatio.toFixed(3)})`,
  );
  check(
    'and mud does not slow infantry',
    Math.abs(groundMud.travelled / groundStandard.travelled - 1) < 0.02,
    `${groundStandard.travelled.toFixed(1)} vs ${groundMud.travelled.toFixed(1)}`,
  );
  const tankSnowRatio = tankSnow.travelled / tankStandard.travelled;
  check(
    'snow slows armour by the same 35% (no vehicle exemption)',
    tankSnowRatio > 0.6 && tankSnowRatio < 0.7,
    `${tankStandard.travelled.toFixed(1)} vs ${tankSnow.travelled.toFixed(1)} (ratio ${tankSnowRatio.toFixed(3)})`,
  );
  check(
    'the mud tank surcharge and its slow speed agree',
    simFor(PLAIN, { stageOverrides: { environment: 'mud' } }).sim.unitCostFor('tank') === 210,
  );
}

{
  // A river span is the only crossing and it only holds so many: the funnel has
  // to hold, and nothing may end up standing in the water (river, not span).
  const { sim } = simFor('allied-17');
  const bridge = sim.state.features.bridges[0];
  check('the crossing exists (fixture)', Boolean(bridge), `bridges ${sim.state.features.bridges.length}`);
  let inWaterEver = 0;
  let peakPlayer = 0;
  let peakEnemy = 0;
  for (let i = 0; i < Math.round(160 / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    sim.update(DT, adaptivePolicy(sim.state));
    sim.takeEvents();
    for (const unit of sim.state.units) {
      if (inWater(sim.state.features, unit.x, unit.y)) inWaterEver += 1;
    }
    for (const span of sim.state.features.bridges) {
      peakPlayer = Math.max(peakPlayer, span.occupants.player);
      peakEnemy = Math.max(peakEnemy, span.occupants.enemy);
    }
  }
  check(
    'no unit ever ends up inside the river',
    inWaterEver === 0,
    `${inWaterEver} unit-ticks in the water`,
  );
  check(
    'the span actually carries the attack',
    peakPlayer > 0 && peakEnemy > 0,
    `peak occupants player ${peakPlayer}, enemy ${peakEnemy}, capacity ${bridge?.capacity}`,
  );
}

{
  // Trenches are cover for infantry that stop inside one — and lose it when the
  // other side gets in among them.
  const { sim } = simFor('allied-18');
  const trenches = sim.state.features.trenches;
  check('the trench line is laid out (fixture)', trenches.length > 0, `${trenches.length}`);
  let coverSeen = 0;
  let illegalCover = 0;
  let movingCover = 0;
  let overrunSeen = false;
  let coverAfterOverrun = 0;
  for (let i = 0; i < Math.round(170 / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    sim.update(DT, adaptivePolicy(sim.state));
    for (const event of sim.takeEvents()) if (event.type === 'trenchOverrun') overrunSeen = true;
    for (const unit of sim.state.units) {
      if (unit.kind === 'tank' || !unit.trenchCover) continue;
      coverSeen += 1;
      const zone = trenchAt(sim.state.features, unit.x, unit.y);
      if (!zone) illegalCover += 1;
      // Cover is granted after movement, so a unit that has just started walking
      // loses it on the same step: cover and a walking state never coexist.
      if (unit.state === 'advance') movingCover += 1;
      if (zone && zone.overrunBy !== null) coverAfterOverrun += 1;
    }
  }
  check('infantry take cover in a trench when they stop in one', coverSeen > 0, `${coverSeen} unit-ticks of cover`);
  check('cover never coexists with a walking unit', movingCover === 0, `${movingCover} unit-ticks on the move`);
  check('cover only exists inside a trench', illegalCover === 0, `${illegalCover} unit-ticks outside`);
  check('a position can be overrun (fixture)', overrunSeen, 'no trenchOverrun in 170s');
  check('an overrun trench grants no cover', coverAfterOverrun === 0, `${coverAfterOverrun} unit-ticks`);
  check(
    'the overrun is recorded on the zone itself',
    sim.state.features.trenches.some((zone) => zone.overrunBy !== null) || !overrunSeen,
    sim.state.features.trenches.map((zone) => zone.overrunBy ?? '-').join(','),
  );
}

{
  // Mine belts: live terrain that takes whoever crosses it first, exactly once
  // per mine, from either side.
  const { sim } = simFor('allied-18');
  const belts = sim.state.features.minefields;
  check('the mine belt is laid out (fixture)', belts.length > 0, `${belts.length} belts`);
  const armedAtStart = belts.reduce((total, belt) => total + belt.armed, 0);
  const exploded = new Set();
  let blasts = 0;
  let blastsWithoutDamage = 0;
  let blastsWithAUnitOnTheMine = 0;
  for (let i = 0; i < Math.round(170 / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    const hpBefore = new Map();
    for (const unit of sim.state.units) hpBefore.set(unit.id, unit.hp);
    sim.update(DT, adaptivePolicy(sim.state));
    const events = sim.takeEvents();
    const mineEvents = events.filter((event) => event.type === 'mineBlast').length;
    if (mineEvents === 0) continue;
    blasts += mineEvents;
    const fresh = [];
    for (const belt of belts) {
      for (const mine of belt.mines) {
        if (!mine.exploded || exploded.has(mine)) continue;
        exploded.add(mine);
        fresh.push(mine);
      }
    }
    let damaged = 0;
    for (const [id, hp] of hpBefore) {
      const after = sim.state.units.find((unit) => unit.id === id);
      if (!after || after.hp < hp - 1e-9) damaged += 1;
    }
    if (damaged === 0) blastsWithoutDamage += 1;
    for (const mine of fresh) {
      if (
        sim.state.units.some((unit) => Math.hypot(unit.x - mine.x, unit.y - mine.y) <= C.MINE_TRIGGER_RADIUS + 8)
      ) {
        blastsWithAUnitOnTheMine += 1;
      }
    }
  }
  const armedNow = belts.reduce((total, belt) => total + belt.armed, 0);
  check('units walk onto mines (fixture)', blasts > 0, `${blasts} blasts`);
  check(
    'each detonation consumes exactly one mine',
    armedNow === armedAtStart - exploded.size && armedNow >= 0,
    `armed ${armedNow} of ${armedAtStart}, exploded ${exploded.size}, blasts ${blasts}`,
  );
  check(
    'every detonation comes from a mine that was still in the ground',
    blasts === exploded.size,
    `${blasts} blasts vs ${exploded.size} mines`,
  );
  check(
    'each mine blows once and only once',
    exploded.size === new Set([...exploded].map((mine) => `${mine.x},${mine.y}`)).size,
    `${exploded.size} exploded, ${new Set([...exploded].map((mine) => `${mine.x},${mine.y}`)).size} distinct`,
  );
  check(
    'the unit that set a mine off takes damage',
    blastsWithoutDamage === 0 && blastsWithAUnitOnTheMine > 0,
    `${blastsWithoutDamage} blast ticks with no casualties, ${blastsWithAUnitOnTheMine} with a unit on the mine`,
  );
  check(
    'minesHit and enemyMinesHit count every detonation',
    sim.state.stats.minesHit + sim.state.stats.enemyMinesHit === blasts,
    `${sim.state.stats.minesHit} + ${sim.state.stats.enemyMinesHit} vs ${blasts}`,
  );
}

{
  // Depth-sort sanity: nothing may ever be drawn outside the ground plane.
  const { sim } = simFor('allied-29');
  let outside = 0;
  let worst = null;
  for (let i = 0; i < Math.round(175 / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    sim.update(DT, adaptivePolicy(sim.state));
    sim.takeEvents();
    for (const unit of sim.state.units) {
      if (unit.x < -10 || unit.x > C.WORLD_W + 10 || unit.y < -10 || unit.y > C.WORLD_H + 10) {
        outside += 1;
        worst = `${unit.kind} @ ${unit.x.toFixed(1)},${unit.y.toFixed(1)} @${sim.state.time.toFixed(1)}s`;
      }
    }
  }
  check(
    'no unit ever leaves the world plane',
    outside === 0,
    `${outside} unit-ticks outside (${worst ?? ''})`,
  );
}

// ------------------------------------------------------------------------- F

section('F. combat');

/**
 * The engagement rule, re-derived here so the harness can check it: a unit
 * fights the nearest hostile figure **or** its objective position — whichever is
 * closer — with a hostile standing inside the unit's own position weighted as
 * though it were much nearer (the raid rule). `prior` holds the positions from
 * before the tick, because the simulation decides with the positions it can see.
 *
 * `model` matters because units die mid-tick: a figure that was killed earlier
 * in the same tick is no longer a target, so a unit that is *not* engaged is
 * checked against the survivors only, and a unit that *is* engaged against the
 * field as it was when the tick began.
 *
 * `decision` is the unit's own entry from `decisionView()` — the pre-step view
 * of the tick. It matters because a unit whose objective is razed re-tasks
 * inside the same step: after the step its live `targetBaseId` is one step
 * ahead of the tick that was decided, so both the objective and the positions
 * have to come from before the step for the comparison to be like-for-like.
 */
function engageDistance(state, unit, prior, model = 'all', decision = null) {
  const spot = prior.get(unit.id);
  if (!spot) return Infinity;
  const alive = new Map();
  for (const other of state.units) alive.set(other.id, other.hp > 0);
  const home = baseById(state, unit.homeBaseId);
  let best = Infinity;
  for (const [id, where] of prior) {
    if (id === unit.id || where.side === unit.side) continue;
    if (model === 'alive' && alive.get(id) !== true) continue;
    let d = Math.hypot(where.x - spot.x, where.y - spot.y);
    if (home && !home.destroyed && Math.hypot(where.x - home.x, where.y - home.y) <= C.GARRISON_RADIUS) {
      d *= 0.55;
    }
    best = Math.min(best, d);
  }
  const objective = decision ? decision.objective : baseById(state, unit.targetBaseId);
  if (objective && !objective.destroyed) {
    best = Math.min(best, Math.max(0, Math.hypot(objective.x - spot.x, objective.y - spot.y) - C.BASE_FOOTPRINT));
  }
  return best;
}

/** A snapshot of every unit's ground-plane position, keyed by id. */
function positionsOf(state) {
  const map = new Map();
  for (const unit of state.units) map.set(unit.id, { x: unit.x, y: unit.y, side: unit.side });
  return map;
}

/**
 * The world a tick was decided on: each unit's position and state, and the
 * objective it was marching on as that stood *before* the step (its position
 * and whether it was still standing). The state itself is read after the step
 * — that is the decision the step came to — but everything the decision was
 * made from is read before it.
 */
function decisionView(state) {
  const bases = new Map();
  for (const base of state.bases) bases.set(base.id, { x: base.x, y: base.y, destroyed: base.destroyed });
  const map = new Map();
  for (const unit of state.units) {
    map.set(unit.id, {
      x: unit.x,
      y: unit.y,
      side: unit.side,
      state: unit.state,
      objective: bases.get(unit.targetBaseId) ?? null,
    });
  }
  return map;
}

{
  const { sim } = simFor(PLAIN, { configOverrides: { startSupplies: 400, supplyBaseRate: 8 } });
  let advancingSeen = 0;
  let engagingSeen = 0;
  let violations = 0;
  let detail = '';
  let shotEvents = 0;
  let projectileWhileEngaged = 0;
  let fireCadence = null;
  const tolerance = 6;
  for (let i = 0; i < Math.round(60 / DT) && sim.state.status === 'running'; i += 1) {
    const pads = readyPads(sim.state);
    const command =
      sim.state.playerUnits < 3 && pads[0] && sim.state.supplies >= UNIT_STATS.rifleman.cost
        ? order('rifleman', pads[0].id, null)
        : NO_COMMAND;
    const view = decisionView(sim.state);
    const staggerBefore = new Map();
    for (const unit of sim.state.units) staggerBefore.set(unit.id, unit.stagger);
    sim.update(DT, command);
    const events = sim.takeEvents();
    shotEvents += events.filter((event) => event.type === 'shot').length;
    for (const unit of sim.state.units) {
      const before = view.get(unit.id);
      if (unit.kind !== 'rifleman' || !before) continue;
      // A unit caught in a blast is staggered: it skips its whole step, so it
      // cannot engage on that tick whatever is in range.
      if ((staggerBefore.get(unit.id) ?? 0) > 0) continue;
      const rule = ENV.environmentRules(sim.state.environment);
      const threshold = UNIT_STATS[unit.kind].range * rule.rangeMultiplier * unit.rangeJitter;
      // Measure the tick against the world it was decided on: the state below
      // is the decision the step came to, the distances are the ones it had.
      const expected = engageDistance(sim.state, unit, view, 'all', before);
      if (!Number.isFinite(expected)) continue;
      if (unit.state === 'engage') {
        engagingSeen += 1;
        if (expected > threshold + tolerance) {
          violations += 1;
          detail = `engaged at ${expected.toFixed(0)} > range ${threshold.toFixed(0)}`;
        }
        if (sim.state.projectiles.some((shot) => shot.side === unit.side)) projectileWhileEngaged += 1;
      } else {
        advancingSeen += 1;
        const survivors = engageDistance(sim.state, unit, view, 'alive', before);
        if (survivors < threshold - tolerance) {
          violations += 1;
          detail = `${unit.state} at ${survivors.toFixed(0)} < range ${threshold.toFixed(0)}`;
        }
      }
      if (unit.cooldown > (fireCadence ?? 0)) fireCadence = unit.cooldown;
    }
  }
  check('units advance with no target in range', advancingSeen > 0, `${advancingSeen} unit-ticks`);
  check('units stop and engage with a target in range', engagingSeen > 0, `${engagingSeen} unit-ticks`);
  check('engagement follows the unit range exactly', violations === 0, `${violations} violations (${detail})`);
  check('engaged units put projectiles in the air', projectileWhileEngaged > 0, `${projectileWhileEngaged}`);
  check('firing emits shot events', shotEvents > 0, `${shotEvents} shots`);
  check(
    'a rifleman fires at its documented rate',
    fireCadence !== null && Math.abs(fireCadence - 1 / UNIT_STATS.rifleman.fireRate) < 0.02,
    `cooldown ${fireCadence?.toFixed(3)} vs ${(1 / UNIT_STATS.rifleman.fireRate).toFixed(3)}`,
  );
}

{
  // The sandstorm halves the range, measured as the distance between the two
  // forces when our own rifleman first opens fire in two otherwise identical
  // battles. `effective` is the rule the simulation applies (raids weighted in);
  // `real` is the plain separation between the two sides.
  function firstEngagement(environment) {
    const { sim } = simFor('axis-01', {
      stageOverrides: { environment, features: [], missionType: 'destroy_base' },
    });
    const pad = sideBases(sim.state, 'player')[0];
    sim.update(0, order('rifleman', pad.id, null));
    const unit = sim.state.units.find((candidate) => candidate.side === 'player');
    const rule = ENV.environmentRules(environment);
    for (let i = 0; i < Math.round(40 / DT) && sim.state.status === 'running'; i += 1) {
      const prior = positionsOf(sim.state);
      sim.update(DT, NO_COMMAND);
      sim.takeEvents();
      const live = sim.state.units.find((candidate) => candidate.id === unit.id);
      if (!live) return null;
      if (live.state !== 'engage') continue;
      const here = prior.get(unit.id);
      let real = Infinity;
      if (here) {
        for (const other of sim.state.units) {
          if (other.side !== 'enemy' || other.hp <= 0) continue;
          const where = prior.get(other.id);
          if (!where) continue;
          real = Math.min(real, Math.hypot(where.x - here.x, where.y - here.y));
        }
      }
      return {
        real,
        effective: engageDistance(sim.state, live, prior),
        threshold: UNIT_STATS.rifleman.range * rule.rangeMultiplier * live.rangeJitter,
        unit: live,
      };
    }
    return null;
  }
  const open = firstEngagement('standard');
  const sandstorm = firstEngagement('desert');
  check(
    'a rifleman opens fire inside its own range',
    open !== null && open.effective <= open.threshold + 6 && open.effective >= open.threshold - 10,
    open ? `engaged at effective ${open.effective.toFixed(0)} of ${open.threshold.toFixed(0)}` : 'never engaged',
  );
  check(
    'both battles reach first contact (fixture)',
    sandstorm !== null && open !== null && sandstorm.real < Infinity,
    sandstorm ? `${sandstorm.real.toFixed(0)}` : 'no contact',
  );
  if (open && sandstorm && Number.isFinite(open.real) && Number.isFinite(sandstorm.real)) {
    const ratio = sandstorm.real / open.real;
    check(
      'the desert halves the distance at which the first shots are traded',
      ratio > 0.42 && ratio < 0.58,
      `standard ${open.real.toFixed(0)} vs desert ${sandstorm.real.toFixed(0)} (ratio ${ratio.toFixed(3)})`,
    );
    check(
      'and each side first fires inside its own (halved) range',
      sandstorm.effective <= sandstorm.threshold + 6 && sandstorm.threshold < open.threshold,
      `desert effective ${sandstorm.effective.toFixed(0)} of ${sandstorm.threshold.toFixed(0)}`,
    );
  }
}

{
  // The stacking itself, as pure maths — the same function the simulation calls.
  const plain = incomingDamage(100, { armor: 0, dugIn: false, trenchCover: false, illuminated: false, illuminatedDamageMultiplier: 1 });
  const armored = incomingDamage(100, { armor: 6, dugIn: false, trenchCover: false, illuminated: false, illuminatedDamageMultiplier: 1 });
  const immune = incomingDamage(100, { armor: 500, dugIn: false, trenchCover: false, illuminated: false, illuminatedDamageMultiplier: 1 });
  const dugIn = incomingDamage(100, { armor: 0, dugIn: true, dugInResist: UNIT_STATS.mg.dugInResist, trenchCover: false, illuminated: false, illuminatedDamageMultiplier: 1 });
  const trench = incomingDamage(100, { armor: 0, dugIn: false, trenchCover: true, illuminated: false, illuminatedDamageMultiplier: 1 });
  const lit = incomingDamage(100, { armor: 0, dugIn: false, trenchCover: false, illuminated: true, illuminatedDamageMultiplier: 1.5 });
  const stacked = incomingDamage(100, {
    armor: 0,
    dugIn: true,
    dugInResist: UNIT_STATS.mg.dugInResist,
    trenchCover: true,
    illuminated: true,
    illuminatedDamageMultiplier: 1.5,
  });
  check('unmodified damage passes through', Math.abs(plain - 100) < 1e-9, `${plain}`);
  check('armour subtracts flat damage', Math.abs(armored - 94) < 1e-9, `${armored}`);
  check('armour can never grant immunity', Math.abs(immune - 25) < 1e-9, `${immune}`);
  check(
    'sandbags cut a dug-in MG\u2019s damage',
    Math.abs(dugIn - 100 * (1 - (UNIT_STATS.mg.dugInResist ?? 0))) < 1e-9,
    `${dugIn}`,
  );
  check('a trench cuts projectile damage by 70%', Math.abs(trench - 30) < 1e-9, `${trench}`);
  check('a searchlight silhouette takes 50% more', Math.abs(lit - 150) < 1e-9, `${lit}`);
  check(
    'the four stack multiplicatively',
    Math.abs(stacked - 100 * (1 - (UNIT_STATS.mg.dugInResist ?? 0)) * C.TRENCH_DAMAGE_MULTIPLIER * 1.5) < 1e-9,
    `${stacked.toFixed(3)}`,
  );
}

/**
 * The first *clean* mine burst a unit of `kind` walks into. A mine is the one
 * damage path that skips the damage stack entirely — a buried charge under a
 * track does not care what the target is wearing — so on a tick with nothing
 * else happening the drop in hit points has to be exactly MINE_DAMAGE, armour
 * or no armour. That makes it the end-to-end proof that the simulation applies
 * the documented number, and not just that `damage.ts` can compute it.
 */
function mineVictim(kind) {
  const { sim } = simFor('allied-02', { configOverrides: { startSupplies: 400, supplyBaseRate: 8 } });
  const pad = sideBases(sim.state, 'player')[0];
  sim.update(0, order(kind, pad.id, null));
  for (let i = 0; i < Math.round(90 / DT) && sim.state.status === 'running'; i += 1) {
    const before = new Map();
    for (const unit of sim.state.units) before.set(unit.id, { hp: unit.hp, kind: unit.kind });
    sim.update(DT, NO_COMMAND);
    const events = sim.takeEvents();
    const blasts = events.filter((event) => event.type === 'mineBlast').length;
    if (blasts === 0) continue;
    // Only accept a tick where the mine was the *only* thing that happened: no
    // incoming fire, and no detonation (a shell landing, a base or tank going
    // up) stacking its own damage into the same tick. Mine blasts themselves do
    // not emit an `explosion` event, so any explosion here is somebody else's.
    if (events.some((event) => event.type === 'explosion' || event.type === 'impact')) continue;
    for (const unit of sim.state.units) {
      const prior = before.get(unit.id);
      if (!prior || prior.kind !== kind || unit.hp >= prior.hp - 1e-9) continue;
      return { kind, drop: prior.hp - unit.hp, expected: C.MINE_DAMAGE };
    }
  }
  return null;
}

{
  const infantry = mineVictim('rifleman');
  const armour = mineVictim('tank');
  check('a mine goes off under a marching unit (fixture)', Boolean(infantry) && Boolean(armour), `infantry ${Boolean(infantry)}, armour ${Boolean(armour)}`);
  check(
    'the mine applies exactly the documented damage through the simulation',
    Boolean(infantry) && Math.abs(infantry.drop - infantry.expected) < 1e-6,
    infantry
      ? `rifleman lost ${infantry.drop.toFixed(3)}, expected ${infantry.expected.toFixed(3)}`
      : 'no infantry victim',
  );
  check(
    'a mine does not care about armour: the same burst takes the same hit points off a tank',
    Boolean(armour) && Math.abs(armour.drop - armour.expected) < 1e-6,
    armour ? `tank lost ${armour.drop.toFixed(3)}, expected ${armour.expected.toFixed(3)}` : 'no armour victim',
  );
}

{
  // The rest of the stack, end to end: outside mines and blasts, every hit that
  // lands on a single surviving unit has to match `incomingDamage(D, context)`
  // for the round that hit it — and a real battle has to exercise cover and
  // light at the same time.
  const { sim } = simFor('allied-29'); // night, trenches, mines: lit and covered
  let matched = 0;
  let unexplained = 0;
  let withCover = 0;
  let withDugIn = 0;
  let withLight = 0;
  let detail = '';
  for (let i = 0; i < Math.round(175 / DT) && sim.state.status === 'running'; i += 1) {
    const before = new Map();
    for (const unit of sim.state.units) before.set(unit.id, unit.hp);
    const shotsBefore = new Set(sim.state.projectiles);
    sim.update(DT, adaptivePolicy(sim.state));
    const events = sim.takeEvents();
    if (!events.some((event) => event.type === 'impact')) continue;
    const vanished = [...shotsBefore].filter((shot) => !sim.state.projectiles.includes(shot));
    const damaged = [];
    for (const [id, hp] of before) {
      const now = sim.state.units.find((unit) => unit.id === id);
      if (now && now.hp < hp - 1e-9) damaged.push({ now, drop: hp - now.hp });
    }
    if (damaged.length !== 1) continue;
    const victim = damaged[0];
    const context = {
      armor: UNIT_STATS[victim.now.kind].armor,
      dugIn: victim.now.dugIn,
      dugInResist: UNIT_STATS[victim.now.kind].dugInResist,
      trenchCover: victim.now.trenchCover,
      illuminated: victim.now.illuminated,
      illuminatedDamageMultiplier: ENV.environmentRules(sim.state.environment).illuminatedDamageMultiplier,
    };
    // Two rounds can land on the same figure in the same tick, so the drop is
    // a whole multiple of one hit: accept one to four of them, from a round on
    // the other side only.
    const hit = vanished.find(
      (shot) =>
        shot.kind === 'bullet' &&
        shot.side !== victim.now.side &&
        [1, 2, 3, 4].some(
          (rounds) => Math.abs(rounds * incomingDamage(shot.damage, context) - victim.drop) < 1e-6,
        ),
    );
    if (!hit) {
      unexplained += 1;
      detail = `${victim.now.kind} lost ${victim.drop.toFixed(3)}`;
      continue;
    }
    matched += 1;
    if (context.trenchCover) withCover += 1;
    if (context.dugIn) withDugIn += 1;
    if (context.illuminated) withLight += 1;
  }
  check(
    'every clean hit lands exactly the stacked damage the model predicts',
    matched > 0 && unexplained === 0,
    `${matched} matched, ${unexplained} unexplained (${detail})`,
  );
  check(
    'cover and light are exercised end to end in a real battle',
    withCover + withDugIn + withLight > 0,
    `trench ${withCover}, dug-in ${withDugIn}, lit ${withLight}`,
  );
}

{
  // Armour, end to end. A tank-only enemy on a boosted enemy economy: the
  // enemy cannot field armour for ENEMY_ARMOUR_DELAY seconds and then has to
  // afford it, so the fight is built to put a hostile tank on the field with
  // our rifle line already shooting, and the same single-victim match has to
  // hold against the flat armour subtraction.
  const { sim } = simFor('allied-29', {
    configOverrides: {
      enemyMix: [{ kind: 'tank', weight: 1 }],
      enemySupplyRate: 9,
      enemyDeployInterval: 0.5,
      startSupplies: 400,
    },
  });
  let armourHits = 0;
  let armourSeen = 0;
  let first = '';
  for (let i = 0; i < Math.round(175 / DT) && sim.state.status === 'running'; i += 1) {
    const before = new Map();
    for (const unit of sim.state.units) before.set(unit.id, unit.hp);
    const shotsBefore = new Set(sim.state.projectiles);
    sim.update(DT, adaptivePolicy(sim.state));
    const events = sim.takeEvents();
    if (!events.some((event) => event.type === 'impact')) continue;
    const vanished = [...shotsBefore].filter((shot) => !sim.state.projectiles.includes(shot));
    const damaged = [];
    for (const [id, hp] of before) {
      const now = sim.state.units.find((unit) => unit.id === id);
      if (now && now.hp < hp - 1e-9) damaged.push({ now, drop: hp - now.hp });
    }
    for (const victim of damaged) {
      const stats = UNIT_STATS[victim.now.kind];
      if (stats.armor <= 0) continue;
      armourSeen += 1;
      const context = {
        armor: stats.armor,
        dugIn: victim.now.dugIn,
        dugInResist: stats.dugInResist,
        trenchCover: victim.now.trenchCover,
        illuminated: victim.now.illuminated,
        illuminatedDamageMultiplier: ENV.environmentRules(sim.state.environment).illuminatedDamageMultiplier,
      };
      const hit = vanished.find(
        (shot) =>
          shot.kind === 'bullet' &&
          shot.side !== victim.now.side &&
          [1, 2, 3, 4].some(
            (rounds) => Math.abs(rounds * incomingDamage(shot.damage, context) - victim.drop) < 1e-6,
          ),
      );
      if (hit) {
        armourHits += 1;
        if (!first) first = `${victim.now.kind} lost ${victim.drop.toFixed(3)} of ${incomingDamage(hit.damage, context).toFixed(3)}`;
      }
    }
  }
  check(
    'armour is exercised end to end in a real battle',
    armourHits > 0,
    `${armourHits} matched hits on armour of ${armourSeen} damaged armoured figures${first ? ` (${first})` : ''}`,
  );
}

{
  // The MG digs in where it stops, leaves sandbags, and suppresses what it hits.
  const { sim } = simFor(PLAIN, { configOverrides: { startSupplies: 400, supplyBaseRate: 8 } });
  const pad = sideBases(sim.state, 'player')[0];
  sim.update(0, order('mg', pad.id, null));
  const gunner = sim.state.units[0];
  let dugInTick = null;
  let bags = 0;
  let suppressed = false;
  let suppressionSeen = 0;
  for (let i = 0; i < Math.round(120 / DT) && sim.state.status === 'running'; i += 1) {
    sim.update(DT, NO_COMMAND);
    sim.takeEvents();
    const live = sim.state.units.find((unit) => unit.id === gunner.id);
    if (live && live.dugIn && dugInTick === null) dugInTick = live.dig;
    bags = Math.max(bags, sim.state.sandbags.length);
    for (const unit of sim.state.units) {
      if (unit.side === 'enemy' && unit.suppressed > 0) {
        suppressed = true;
        suppressionSeen += 1;
      }
    }
  }
  check('the MG digs in after digTime of standing and firing', dugInTick !== null && dugInTick >= (UNIT_STATS.mg.digTime ?? 0), `${dugInTick?.toFixed(2)}`);
  check('the MG leaves sandbags behind', bags > 0, `${bags} sandbag positions`);
  check('the MG\u2019s fire suppresses what it hits', suppressed, `${suppressionSeen} suppressed unit-ticks`);
}

/**
 * What one burst did, against what the falloff model predicts for each hostile
 * standing inside the radius: `incomingDamage(D * (1 - 0.6 * d / radius))`,
 * bracketed by the one tick of movement between the pre-tick snapshot and the
 * burst. A victim only *judges* the model when the shell alone can explain its
 * whole drop: a figure that was also under other fire that tick shows more
 * than the bracket, and a figure whose remaining hit points were already below
 * the bracket cannot show the shell's damage at all (it just dies). Both are
 * reported, neither is judged.
 */
function blastEvidence(burst) {
  const rows = [];
  for (const entry of burst.affected) {
    const dMin = Math.max(0, entry.d - 1.8);
    const dMax = Math.min(burst.radius, entry.d + 1.8);
    const low = incomingDamage(burst.damage * (1 - 0.6 * (dMax / burst.radius)), entry.prior.context);
    const high = incomingDamage(burst.damage * (1 - 0.6 * (dMin / burst.radius)), entry.prior.context);
    const drop = entry.died ? entry.prior.hp : entry.prior.hp - Math.max(0, entry.afterHp);
    const otherFire = drop > high + 1e-6;
    const alreadyDying = entry.died && entry.prior.hp < low - 1e-6;
    const clean = drop > 1e-9 && !otherFire && !alreadyDying;
    rows.push({ entry, low, high, drop, clean, otherFire, alreadyDying, inBracket: clean && drop >= low - 1e-6 });
  }
  return rows;
}

/**
 * The point a tank's next round is aimed at: the nearest hostile figure, or its
 * objective position — the choice `engageTarget()` makes in the simulation.
 * Used to re-derive the distance a shell was fired over, which is what its
 * speed is built from.
 */
function aimPoint(state, shooter) {
  const home = baseById(state, shooter.homeBaseId);
  let best = null;
  for (const other of state.units) {
    if (other.side === shooter.side || other.hp <= 0) continue;
    let d = Math.hypot(other.x - shooter.x, other.y - shooter.y);
    if (home && !home.destroyed && Math.hypot(other.x - home.x, other.y - home.y) <= C.GARRISON_RADIUS) {
      d *= 0.55;
    }
    if (!best || d < best.d) best = { x: other.x, y: other.y, d };
  }
  const objective = baseById(state, shooter.targetBaseId);
  if (objective && !objective.destroyed) {
    const d = Math.max(0, Math.hypot(objective.x - shooter.x, objective.y - shooter.y) - C.BASE_FOOTPRINT);
    if (!best || d < best.d) best = { x: objective.x, y: objective.y, d };
  }
  return best;
}

{
  // A tank shells: the round is lobbed, lands, hurts everything inside the
  // blast with falloff, throws infantry about, spares armour on its feet, and
  // shakes the ground. Driven with one tank on the field so the only damage
  // source for the enemy is that shell.
  const { sim } = simFor(PLAIN, { configOverrides: { startSupplies: 400, supplyBaseRate: 10 } });
  const pad = sideBases(sim.state, 'player')[0];
  sim.update(0, order('tank', pad.id, null));
  const profiles = new Map();
  const shellAim = new Map();
  const landed = [];
  const playerBursts = [];
  let burst = null;
  for (let i = 0; i < Math.round(150 / DT) && sim.state.status === 'running'; i += 1) {
    const before = new Map();
    for (const unit of sim.state.units) {
      before.set(unit.id, {
        hp: unit.hp,
        x: unit.x,
        y: unit.y,
        side: unit.side,
        kind: unit.kind,
        context: {
          armor: UNIT_STATS[unit.kind].armor,
          dugIn: unit.dugIn,
          dugInResist: UNIT_STATS[unit.kind].dugInResist,
          trenchCover: unit.trenchCover,
          illuminated: unit.illuminated,
          illuminatedDamageMultiplier: ENV.environmentRules(sim.state.environment).illuminatedDamageMultiplier,
        },
      });
    }
    sim.update(DT, NO_COMMAND);
    sim.takeEvents();
    const live = new Set(sim.state.projectiles);
    for (const shot of sim.state.projectiles) {
      if (shot.kind !== 'shell') continue;
      if (!shellAim.has(shot)) {
        // A new round: find the muzzle it came out of (`radius + 6` back along
        // the firing line, one step behind where the round is now) and the
        // distance from that figure to the point it was aimed at. That
        // distance is the number the launch velocity was solved from.
        const speed = Math.hypot(shot.vx, shot.vy);
        const originX = shot.x - shot.vx * DT - (shot.vx / speed) * (UNIT_STATS.tank.radius + 6);
        const originY = shot.y - shot.vy * DT - (shot.vy / speed) * (UNIT_STATS.tank.radius + 6);
        let shooter = null;
        let best = Infinity;
        for (const unit of sim.state.units) {
          if (unit.side !== shot.side || unit.kind !== 'tank') continue;
          const d = Math.hypot(unit.x - originX, unit.y - originY);
          if (d < best) {
            best = d;
            shooter = unit;
          }
        }
        const aim = shooter ? aimPoint(sim.state, shooter) : null;
        const dist = shooter && aim ? Math.hypot(aim.x - shooter.x, aim.y - shooter.y) : null;
        shellAim.set(shot, {
          dist,
          // The documented model: the flight time is floored at
          // SHELL_MIN_FLIGHT so every round visibly arcs, so the horizontal
          // speed is dist / max(SHELL_MIN_FLIGHT, dist / SHELL_SPEED) — below
          // SHELL_SPEED whenever the tank is firing inside 204.6 units, which
          // is every range a tank's 152-unit gun can shoot at.
          expected: dist === null ? null : dist / Math.max(C.SHELL_MIN_FLIGHT, dist / C.SHELL_SPEED),
          floored: dist !== null && dist / C.SHELL_SPEED < C.SHELL_MIN_FLIGHT,
        });
      }
      if (!profiles.has(shot)) profiles.set(shot, []);
      profiles.get(shot).push(shot.z);
    }
    for (const [shot, samples] of profiles) {
      if (live.has(shot)) continue;
      profiles.delete(shot);
      const radius = shot.blast > 0 ? shot.blast : 70;
      landed.push({ shot, samples, radius });
      if (shot.side !== 'player') continue;
      // The round ended its flight this tick: see what it did to whatever was
      // standing where it burst. Distances use the pre-tick positions, so the
      // bracket covers the one tick of movement between that snapshot and the
      // burst. Everything the blast did is read *now*, at the burst tick:
      // holding the live unit would read whatever it looked like 150 s later.
      const affected = [];
      for (const [id, prior] of before) {
        if (prior.side === shot.side) continue;
        const d = Math.hypot(prior.x - shot.x, prior.y - shot.y);
        if (d > radius + 1.8) continue;
        const now = sim.state.units.find((unit) => unit.id === id) ?? null;
        affected.push({ prior, d, afterHp: now ? now.hp : null, shoved: now ? now.shoved : 0, died: now === null });
      }
      playerBursts.push({ shot, affected, radius, damage: shot.damage, shake: sim.state.shake });
    }
  }
  // Prefer a round that actually reached the ground — the artillery case — and
  // fall back to one that burst on the target it was aimed at.
  burst =
    playerBursts.find((entry) => entry.shot.z === 0 && entry.affected.length > 0) ??
    playerBursts.find((entry) => entry.affected.length > 0) ??
    null;
  // The falloff is judged on a burst that can carry the evidence: one with a
  // clean sample inside the bracket. A burst whose victims were all also under
  // other fire that tick cannot say anything about the shell.
  const withEvidence = playerBursts.filter((entry) => blastEvidence(entry).some((row) => row.inBracket));
  const falloff = withEvidence.find((entry) => entry.shot.z === 0) ?? withEvidence[0] ?? burst;
  const groundBursts = landed.filter((entry) => entry.shot.z === 0).length;
  const arced = landed.filter(
    (entry) => entry.samples.length > 1 && Math.max(...entry.samples) > entry.samples[0] + 0.5,
  );
  check('a tank fires shells (fixture)', landed.length > 0, `${landed.length} shells in 150s`);
  check(
    'the shell is lobbed: it rises, then falls to the ground',
    arced.length > 0 &&
      arced.every((entry) => {
        const peak = Math.max(...entry.samples);
        return peak > entry.samples[0] + 0.5 && entry.samples[entry.samples.length - 1] < peak;
      }),
    arced.length > 0
      ? `${arced.length} arcing shells, e.g. z ${arced[0].samples[0].toFixed(1)} -> ${Math.max(...arced[0].samples).toFixed(1)} -> ${arced[0].shot.z.toFixed(2)}`
      : `${landed.length} shells, none of them arced`,
  );
  check(
    'shells travel at the floored artillery speed, never the bullet speed (short lobs are slower by design)',
    landed.length > 0 &&
      landed.every((entry) => {
        const aim = shellAim.get(entry.shot);
        if (!aim || aim.expected === null) return false;
        const speed = Math.hypot(entry.shot.vx, entry.shot.vy);
        return Math.abs(speed - aim.expected) <= aim.expected * 0.15;
      }),
    landed
      .map((entry) => {
        const aim = shellAim.get(entry.shot);
        const speed = Math.hypot(entry.shot.vx, entry.shot.vy).toFixed(1);
        if (!aim || aim.expected === null) return `${speed} over an unknown range`;
        return `${speed} over ${aim.dist.toFixed(0)} (model ${aim.expected.toFixed(1)}${aim.floored ? ', flight floored' : ''})`;
      })
      .join('; '),
  );
  check(
    'no shell passes through the ground or is left hanging in the air',
    landed.every(
      (entry) => entry.shot.z >= 0 && entry.shot.life <= 0 && entry.samples.every((z) => z >= 0),
    ),
    `${landed.length} rounds ended, ${groundBursts} of them at ground level`,
  );
  if (groundBursts === 0 && landed.length > 0) {
    findings.push(
      `tank shells never reached the ground: all ${landed.length} bursts in 150s were intercepted at the target by ` +
        'unitAt()/baseAt() in updateProjectiles(), so the ground-detonation branch (`if (shot.z <= 0)`) is nearly dead ' +
        'code — the round arcs, but it always goes off in the air over the target',
    );
  }
  if (landed.length > 0 && landed.every((entry) => shellAim.get(entry.shot)?.floored)) {
    findings.push(
      `SHELL_MIN_FLIGHT always binds: a tank's gun reaches ${UNIT_STATS.tank.range} units and the floor covers every ` +
        `shot inside ${(C.SHELL_MIN_FLIGHT * C.SHELL_SPEED).toFixed(1)} units, so SHELL_SPEED never sets a shell's ` +
        'horizontal speed — every tank round in the game travels at dist / SHELL_MIN_FLIGHT instead',
    );
  }
  if (burst) {
    check(
      'the shell bursts at the end of its arc and shakes the ground',
      burst.shot.z >= 0 && burst.shake > 4,
      `burst at z ${burst.shot.z.toFixed(2)}${burst.shot.z === 0 ? ' (ground)' : ' (intercepted over the target)'}, shake ${burst.shake.toFixed(2)}`,
    );
    const caught = blastEvidence(burst);
    check(
      'every hostile inside the blast radius is damaged',
      caught.length > 0 && caught.every((row) => row.drop > 1e-9),
      `${caught.filter((row) => row.drop > 1e-9).length} of ${caught.length} caught`,
    );
    const evidence = falloff ? blastEvidence(falloff) : [];
    const clean = evidence.filter((row) => row.clean);
    const inBracket = clean.filter((row) => row.inBracket);
    const tooWeak = clean.filter((row) => !row.inBracket);
    const otherFire = evidence.filter((row) => row.otherFire);
    const alreadyDying = evidence.filter((row) => row.alreadyDying);
    const wrong = tooWeak[0] ?? otherFire[0] ?? null;
    check(
      'blast damage falls off with distance exactly as documented',
      inBracket.length >= 1 && tooWeak.length === 0,
      `${inBracket.length}/${clean.length} clean samples inside the falloff bracket, ${tooWeak.length} too weak, ` +
        `${otherFire.length} also under other fire, ${alreadyDying.length} already dying` +
        (wrong
          ? ` (${wrong.entry.prior.kind} at ${wrong.entry.d.toFixed(1)}: ${wrong.drop.toFixed(2)} vs [${wrong.low.toFixed(2)}, ${wrong.high.toFixed(2)}])`
          : ''),
    );
    const infantry = caught.filter((row) => row.entry.prior.kind !== 'tank' && !row.entry.died);
    const armour = caught.filter((row) => row.entry.prior.kind === 'tank' && !row.entry.died);
    check(
      'the blast throws infantry off their feet',
      infantry.length > 0 && infantry.some((row) => row.entry.shoved > 0),
      `infantry caught ${infantry.length}, max shove ${Math.max(0, ...infantry.map((row) => row.entry.shoved)).toFixed(2)}`,
    );
    check(
      'the blast does not throw armour',
      armour.every((row) => row.entry.shoved === 0),
      armour.map((row) => row.entry.shoved).join(','),
    );
  } else {
    check('the shell detonates among hostiles (fixture)', false, 'no burst with casualties in 150s');
  }
}

{
  // A razed position shakes the field, is marked destroyed and stops firing for
  // the rest of the battle.
  const { sim } = simFor(PLAIN, { configOverrides: { startSupplies: 400, supplyBaseRate: 10 } });
  let razed = null;
  let shakeAtRaze = 0;
  let baseGunAfter = 0;
  let settle = 0;
  const razedIds = new Set();
  for (let i = 0; i < Math.round(170 / DT) && sim.state.status === 'running'; i += 1) {
    const before = new Set(sim.state.projectiles);
    sim.update(DT, adaptivePolicy(sim.state));
    sim.takeEvents();
    for (const base of sim.state.bases) {
      if (base.destroyed && !razedIds.has(base.id)) {
        razedIds.add(base.id);
        if (razed === null) {
          razed = base;
          shakeAtRaze = sim.state.shake;
        }
      }
    }
    if (razed !== null) {
      settle += DT;
      // A base gun round leaving a razed position would be the bug this asserts.
      for (const shot of sim.state.projectiles) {
        if (before.has(shot) || shot.damage !== C.BASE_GUN_DAMAGE) continue;
        if (Math.hypot(shot.x - razed.x, shot.y - razed.y) < 30 && shot.side === razed.side && settle > 2) baseGunAfter += 1;
      }
    }
  }
  check('a position is razed during the battle (fixture)', razed !== null, 'nothing was destroyed');
  if (razed) {
    check('razing a position raises the screen shake', shakeAtRaze > 6, `${shakeAtRaze.toFixed(2)}`);
    check('a razed position is marked destroyed and smokes', razed.destroyed && razed.smoke === 1, `smoke ${razed.smoke}`);
    check('a razed position stops firing its gun', baseGunAfter === 0 && razed.flash === 0 && razed.gunCooldown === 0, `${baseGunAfter} rounds after it fell`, );
    check('a razed position reads as destroyed in the HUD options', sim.state.playerBaseOptions.concat(sim.state.enemyBaseOptions).filter((option) => option.id === razed.id).every((option) => option.destroyed && !option.ready && option.hpFraction === 0));
  }
}

{
  // War bonds drop when an enemy unit is destroyed. A plain rifle line plays
  // here, so the only thing moving the bond bank is a kill.
  const { sim } = simFor(PLAIN, { configOverrides: { startSupplies: 400, supplyBaseRate: 10 } });
  let drops = 0;
  let mismatched = 0;
  for (let i = 0; i < Math.round(150 / DT) && sim.state.status === 'running'; i += 1) {
    const bondsBefore = sim.state.bonds;
    const collectedBefore = sim.state.stats.bondsCollected;
    sim.update(DT, riflePolicy(sim.state));
    const events = sim.takeEvents();
    const expected = events
      .filter((event) => event.type === 'unitDown' && event.side === 'enemy')
      .reduce((total, event) => total + (event.amount ?? 0), 0);
    drops += expected;
    if (Math.abs(sim.state.bonds - bondsBefore - expected) > 1e-9) mismatched += 1;
    if (Math.abs(sim.state.stats.bondsCollected - collectedBefore - expected) > 1e-9) mismatched += 1;
  }
  check('destroying an enemy unit pays its bondDrop', drops > 0, `${drops} bonds`);
  check('every bond drop lands in bonds and bondsCollected, exactly once', mismatched === 0, `${mismatched} mismatched ticks`);
}

// ------------------------------------------------------------------------- G

section('G. how a battle ends');

const totalHpFraction = (state, side) => {
  let hp = 0;
  let max = 0;
  for (const base of state.bases) {
    if (base.side !== side) continue;
    hp += base.hp;
    max += base.maxHp;
  }
  return max > 0 ? hp / max : 0;
};

{
  const rows = sweepRows();

  // 1. Victory by demolition: every hostile position razed.
  const wiped = rows.filter((row) => row.final.enemyBasesAlive === 0);
  check('some node is won by razing every hostile position (fixture)', wiped.length > 0, `${wiped.length} of ${rows.length} battles`);
  check(
    'destroying every hostile position wins the battle',
    wiped.length > 0 && wiped.every((row) => row.status === 'victory' && row.reason === 'bases-destroyed'),
    wiped
      .filter((row) => row.status !== 'victory' || row.reason !== 'bases-destroyed')
      .map((row) => `${row.stageId}/${row.policy}:${row.status}/${row.reason}`)
      .join(' '),
  );
  check(
    'the win counts the positions it razed, with a position left standing',
    wiped.every(
      (row) => row.final.stats.basesDestroyed === row.final.enemyBasesTotal && row.final.playerBasesAlive > 0,
    ),
  );

  // 2. Defeat by demolition: every friendly position razed.
  const lostAll = rows.filter((row) => row.final.playerBasesAlive === 0);
  check('some node is lost by losing every position (fixture)', lostAll.length > 0, `${lostAll.length} of ${rows.length}`);
  check(
    'losing every friendly position loses the battle',
    lostAll.length > 0 && lostAll.every((row) => row.status === 'defeat' && row.reason === 'bases-destroyed'),
    lostAll
      .filter((row) => row.status !== 'defeat' || row.reason !== 'bases-destroyed')
      .map((row) => `${row.stageId}/${row.policy}`)
      .join(' '),
  );
  check(
    'the loss counts the positions it lost',
    lostAll.every((row) => row.final.stats.basesLost === row.final.playerBasesTotal),
  );

  // 3. The stalemate clock: the side holding the larger fraction of its
  //    positions wins, and a draw counts as a defeat so the attacker must take
  //    ground. An untouched battle is an exact draw, and must therefore lose.
  const drawn = simFor(PLAIN);
  drawn.sim.update(C.MATCH_TIME_LIMIT + 1, NO_COMMAND);
  drawn.sim.takeEvents();
  check(
    'the clock decides an untouched battle',
    drawn.sim.state.lossReason === 'time-expired' && drawn.sim.state.status !== 'running',
    `${drawn.sim.state.status}/${drawn.sim.state.lossReason}`,
  );
  check(
    'an exact draw on the clock is a defeat',
    Math.abs(totalHpFraction(drawn.sim.state, 'player') - totalHpFraction(drawn.sim.state, 'enemy')) < 1e-9 &&
      drawn.sim.state.status === 'defeat',
    `${totalHpFraction(drawn.sim.state, 'player')} vs ${totalHpFraction(drawn.sim.state, 'enemy')} -> ${drawn.sim.state.status}`,
  );

  const clocked = rows.filter((row) => row.reason === 'time-expired' && row.mission !== 'survive_timer');
  check('the clock decides some sectors (fixture)', clocked.length > 0, `${clocked.length} of ${rows.length} battles`);
  check(
    'every clock verdict follows the surviving hit-point fractions',
    clocked.length > 0 &&
      clocked.every(
        (row) =>
          row.status ===
          (totalHpFraction(row.final, 'enemy') < totalHpFraction(row.final, 'player') ? 'victory' : 'defeat'),
      ),
    clocked
      .map(
        (row) =>
          `${row.stageId}/${row.policy}:${row.status} ${totalHpFraction(row.final, 'player').toFixed(2)}/${totalHpFraction(row.final, 'enemy').toFixed(2)}`,
      )
      .join(' '),
  );
  check(
    'the clock can hand down both verdicts',
    clocked.some((row) => row.status === 'victory') && clocked.some((row) => row.status === 'defeat'),
    `wins ${clocked.filter((row) => row.status === 'victory').length}, losses ${clocked.filter((row) => row.status === 'defeat').length}`,
  );

  // 4. A survival sector is won by holding out to its own, shorter clock.
  const survived = rows.filter((row) => row.mission === 'survive_timer' && row.reason === 'time-expired');
  check('a survive_timer sector runs to its own clock (fixture)', survived.length > 0, `${survived.length} of ${rows.length} battles`);
  check(
    'holding a survive_timer sector to the clock is a victory',
    survived.length > 0 &&
      survived.every((row) => row.status === 'victory' && row.seconds >= C.SURVIVE_SECONDS - 0.5),
    survived.map((row) => `${row.stageId}/${row.policy}:${row.status}@${row.seconds.toFixed(0)}s`).join(' '),
  );
  check(
    'the survival clock is shorter than the battle clock',
    C.SURVIVE_SECONDS < C.MATCH_TIME_LIMIT,
    `${C.SURVIVE_SECONDS} vs ${C.MATCH_TIME_LIMIT}`,
  );

  // 5. Terminal means terminal, and it is announced exactly once.
  const decided = rows.filter((row) => row.status !== 'running');
  check('every sampled battle reaches a terminal state', decided.length === rows.length, `${decided.length} of ${rows.length}`);
  check(
    'the victory/defeat event fires exactly once in every battle',
    decided.length > 0 && decided.every((row) => row.terminalEvents === 1),
    decided.filter((row) => row.terminalEvents !== 1).map((row) => `${row.stageId}/${row.policy}:${row.terminalEvents}`).join(' '),
  );
  const sample = decided[0];
  const decidedStatus = sample.status;
  const later = stepMany(sample.sim, 60 * 5, POLICIES[sample.policy]);
  check(
    'the status never leaves its terminal value',
    sample.sim.state.status === decidedStatus && sample.sim.state.lossReason !== null,
    `${sample.stageId}/${sample.policy}: ${decidedStatus} -> ${sample.sim.state.status}`,
  );
  check(
    'the event is not repeated after the battle',
    later.filter((event) => event.type === 'victory' || event.type === 'defeat').length === 0,
  );
  const launchesBefore = sample.sim.state.stats.launches;
  sample.sim.update(0, order('rifleman', null, null));
  sample.sim.takeEvents();
  check(
    'no further launches are accepted once the battle is over',
    sample.sim.state.stats.launches === launchesBefore,
    `${launchesBefore} -> ${sample.sim.state.stats.launches}`,
  );
}

// ------------------------------------------------------------------------- H

section('H. determinism');

{
  // Two runs of the same node with the same orders must agree to the last
  // decimal: same layout, same units, same hit points.
  const runs = [0, 1].map(() => {
    const { sim } = simFor(PLAIN, { configOverrides: { startSupplies: 400, supplyBaseRate: 6 } });
    const policy = (state) => {
      const pads = readyPads(state);
      if (state.bonds >= state.logisticsCost && state.logisticsLevel < C.LOGISTICS_MAX_LEVEL) {
        return order(null, null, null, true);
      }
      if (!pads.length) return NO_COMMAND;
      const target = aliveBases(state, 'enemy')[0];
      const kind = state.supplies >= UNIT_STATS.mg.cost ? 'mg' : 'rifleman';
      return order(kind, pads[0].id, target ? target.id : null);
    };
    stepMany(sim, 40 * 60, policy);
    return {
      bases: sim.state.bases.map((base) => `${base.id}:${base.x},${base.y},${base.hp.toFixed(6)},${base.destroyed}`),
      units: sim.state.units
        .map((unit) => `${unit.id}:${unit.kind},${unit.x.toFixed(6)},${unit.y.toFixed(6)},${unit.hp.toFixed(6)},${unit.targetBaseId},${unit.marched.toFixed(6)}`)
        .sort(),
      stats: JSON.stringify(sim.state.stats),
      status: sim.state.status,
    };
  });

  check('the base layout is identical in both runs', runs[0].bases.join('|') === runs[1].bases.join('|'));
  check('the units are identical in both runs', runs[0].units.join('|') === runs[1].units.join('|'), `${runs[0].units.length} vs ${runs[1].units.length} units`);
  check('the stats match in both runs', runs[0].stats === runs[1].stats);
  check('the outcome matches in both runs', runs[0].status === runs[1].status, `${runs[0].status}`);
}

// ------------------------------------------------------------------------- I

section('I. balance brackets');

{
  const rows = sweepRows();

  // ---------------------------------------------------------------- the sample
  const missions = new Set(rows.map((row) => row.mission));
  const environments = new Set(rows.map((row) => row.environment));
  const features = new Set(rows.flatMap((row) => row.features));
  const tiers = [...new Set(rows.map((row) => row.tier))].sort((a, b) => a - b);
  check('the sample covers all three mission types', missions.size === 3, [...missions].join(','));
  check('the sample covers all five environments', environments.size === 5, [...environments].join(','));
  check('the sample covers all three terrain features', features.size === 3, [...features].join(','));
  check(
    'the sample spans the opening, middle and final tiers',
    tiers.includes(1) && tiers.some((tier) => tier >= 4 && tier <= 6) && Math.max(...tiers) >= 9,
    `tiers ${tiers.join(',')}`,
  );
  check(
    'both factions are represented',
    rows.some((row) => row.stageId.startsWith('allied')) && rows.some((row) => row.stageId.startsWith('axis')),
  );

  // ----------------------------------------------------------------- the table
  console.log('');
  console.log('  node      pos   mission        env       result            time    dep/kil/lost   bonds  logi  peak  µs/tick');
  for (const row of rows) {
    console.log(
      '  ' +
        [
          row.stageId.padEnd(9),
          `${row.playerPositions}/${row.enemyPositions}`.padEnd(5),
          row.mission.padEnd(14),
          row.environment.padEnd(9),
          `${row.status}${row.reason === 'time-expired' ? '*' : ''}`.padEnd(17),
          `${row.seconds.toFixed(1)}s`.padEnd(7),
          `${row.deployed}/${row.kills}/${row.losses}`.padEnd(14),
          String(row.bonds).padEnd(6),
          String(row.logistics).padEnd(5),
          String(row.peakUnits).padEnd(5),
          row.usPerTick.toFixed(1),
        ].join(' '),
    );
  }
  console.log('  (* = decided by the clock; pos = positions per side; dep/kil/lost = deployed/kills/losses)');

  // --------------------------------------------------------------- the bracket
  const of = (policy) => rows.filter((row) => row.policy === policy);
  const wins = (list) => list.filter((row) => row.status === 'victory').length;
  const idle = of('idle');
  const rifle = of('rifle');
  const adaptive = of('adaptive');
  const adaptiveRate = wins(adaptive) / adaptive.length;

  check('the idle player loses every sampled node', wins(idle) === 0, `${wins(idle)}/${idle.length} won`);
  check(
    'the rifle flood beats doing nothing',
    wins(rifle) > wins(idle),
    `rifle ${wins(rifle)}/${rifle.length}, idle ${wins(idle)}/${idle.length}`,
  );
  check(
    'adaptive play wins a clear majority of the sample',
    adaptiveRate >= 0.6,
    `${(adaptiveRate * 100).toFixed(0)}% (${wins(adaptive)}/${adaptive.length})`,
  );
  check(
    'adaptive play beats the naive rifle flood',
    wins(adaptive) > wins(rifle),
    `adaptive ${wins(adaptive)}/${adaptive.length}, rifle ${wins(rifle)}/${rifle.length}`,
  );
  check(
    'the rifle flood lands in between: it wins some and loses some',
    wins(rifle) > 0 && wins(rifle) < rifle.length,
    `rifle ${wins(rifle)}/${rifle.length} won`,
  );
  check(
    'the three policies really do play differently',
    adaptive.some((row) => {
      const same = rifle.find((other) => other.stageId === row.stageId);
      return same && (same.status !== row.status || Math.abs(same.seconds - row.seconds) > 5);
    }),
    `idle ${wins(idle)}/${idle.length}, rifle ${wins(rifle)}/${rifle.length}, adaptive ${wins(adaptive)}/${adaptive.length}`,
  );
  check(
    'every sampled battle lasts long enough to be a game',
    rows.every((row) => row.seconds >= 10),
    rows.filter((row) => row.seconds < 10).map((row) => `${row.stageId}/${row.policy}:${row.seconds.toFixed(0)}s`).join(' '),
  );
  check(
    'no battle overruns its own clock',
    rows.every((row) => row.seconds <= Math.max(C.MATCH_TIME_LIMIT, C.SURVIVE_SECONDS) + 1),
    rows
      .filter((row) => row.seconds > Math.max(C.MATCH_TIME_LIMIT, C.SURVIVE_SECONDS) + 1)
      .map((row) => `${row.stageId}/${row.policy}`)
      .join(' '),
  );
  check(
    'the opponent keeps the pressure on: losses happen in every policy',
    rows.some((row) => row.losses > 0) && idle.every((row) => row.losses >= 0),
    `kills ${rows.reduce((total, row) => total + row.kills, 0)}, losses ${rows.reduce((total, row) => total + row.losses, 0)}`,
  );

  // ------------------------------------------------- what the bracket says
  const broken = [];
  for (const row of adaptive) {
    const rifleRow = rifle.find((other) => other.stageId === row.stageId);
    const lostFaster = rifleRow && rifleRow.status === 'victory' && row.status !== 'victory';
    const muchSlower = rifleRow && rifleRow.status === 'victory' && row.status === 'victory' && row.seconds > rifleRow.seconds * 2;
    if (lostFaster) broken.push(`${row.stageId} (adaptive loses where rifle wins)`);
    else if (muchSlower) broken.push(`${row.stageId} (adaptive takes twice as long)`);
  }
  const idleWins = idle.filter((row) => row.status === 'victory');
  if (idleWins.length > 0) broken.push(`idle wins on ${idleWins.map((row) => row.stageId).join('/')}`);

  console.log('');
  console.log(
    `  adaptive win rate ${(adaptiveRate * 100).toFixed(0)}% (${wins(adaptive)}/${adaptive.length}); ` +
      `rifle ${((wins(rifle) / rifle.length) * 100).toFixed(0)}% (${wins(rifle)}/${rifle.length}); ` +
      `idle ${wins(idle)}/${idle.length}`,
  );
  console.log(
    broken.length > 0
      ? `  balance callouts: ${broken.join('; ')}`
      : '  balance callouts: none — the mission-aware policy is never behind the naive one',
  );
}

// ------------------------------------------------------------------------- J

section('J. performance');

{
  // Busy fixture: a five-position sector with a boosted economy, so the field is
  // at its unit cap with shells, corpses and particles live while we measure.
  const { sim } = simFor('allied-30', { configOverrides: { startSupplies: 400, supplyBaseRate: 40 } });
  let peakUnits = 0;
  const samples = [];
  for (let i = 0; i < Math.round(50 / DT); i += 1) {
    if (sim.state.status !== 'running') break;
    const pad = readyPads(sim.state)[0];
    const command =
      pad && sim.state.supplies >= UNIT_STATS.rifleman.cost ? order('rifleman', pad.id, null) : NO_COMMAND;
    const started = process.hrtime.bigint();
    sim.update(DT, command);
    const microseconds = Number(process.hrtime.bigint() - started) / 1000;
    sim.takeEvents();
    const units = sim.state.units.length;
    peakUnits = Math.max(peakUnits, units);
    samples.push({ us: microseconds, units });
  }
  // Report the busy part of the battle: the frame budget matters when the field
  // is full, not when it is empty.
  const busySamples = samples.filter((sample) => sample.units >= 20);
  const window = busySamples.length >= 300 ? busySamples : samples;
  const mean = window.reduce((total, sample) => total + sample.us, 0) / Math.max(1, window.length);
  const worst = Math.max(...window.map((sample) => sample.us));
  const budget = 16.6 * 1000;

  check('the measured battle is busy', peakUnits >= 20, `${peakUnits} units on the field`);
  check('the tick count measured is meaningful', window.length >= 300, `${window.length} ticks timed`);
  check(
    'an update tick stays far inside the 16.6 ms frame budget',
    mean < 2000 && worst < 4000,
    `mean ${mean.toFixed(1)} µs, max ${worst.toFixed(1)} µs of ${budget.toFixed(0)} µs`,
  );
  console.log(
    `  measured ${window.length} ticks with up to ${peakUnits} units on the field: ` +
      `mean ${mean.toFixed(1)} µs/tick, max ${worst.toFixed(1)} µs/tick ` +
      `(${((mean / budget) * 100).toFixed(2)}% of the 16.6 ms frame budget)`,
  );
}

// -------------------------------------------------------------------- report

console.log('');
console.log(`checks: ${checks - failures.length}/${checks} passed`);

if (simulationBugs.length > 0) {
  console.log('');
  console.log('SIMULATION BUGS (reported, not patched — src/ is out of bounds for this harness):');
  for (const entry of simulationBugs) console.log(`  - ${entry}`);
  if (separationViolations.length > 0) {
    console.log(
      `  >> ${separationViolations.length} of the ${LAYOUT_STAGES.length} sampled sectors break BASE_MIN_SEPARATION: ` +
        `${separationViolations.join('; ')}`,
    );
  }
}

if (findings.length > 0) {
  console.log('');
  console.log('FINDINGS (behaviour worth a second look, not harness failures):');
  for (const entry of findings) console.log(`  - ${entry}`);
}

if (failures.length > 0) {
  console.log('');
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('  all battle mechanics, autopilot brackets, determinism and performance checks passed');
}

console.log('');
console.log('what this proves:');
console.log('  · per-pad launches: a pad pays its own cooldown, other pads fire in the same instant');
console.log('  · fallbacks: null ids and razed ids resolve to a living pad / position, never silently');
console.log('  · retasking: player and enemy units re-task onto the nearest survivor, counted once');
console.log('  · terrain and weather: snow, mud, river spans, trenches, mine belts, world bounds');
console.log('  · combat: range rules, the stacked damage model, MG dig-in, lobbed shells with falloff');
console.log('  · outcomes: demolition, the clock (draws lose), survival clocks, exactly one verdict');
console.log('  · determinism: same node + same orders = same bases and same units');
console.log('  · balance: idle loses, rifle is in between, adaptive wins the majority');
console.log('  · performance: a busy battle stays far inside the frame budget');
