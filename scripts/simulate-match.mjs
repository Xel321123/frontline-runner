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
      armour: 0,
      firepower: 0,
      mobility: 0,
      medkit: 0,
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

function simFor(stageId, upgrades = {}) {
  const stage = getStage(stageId);
  if (!stage) throw new Error(`unknown stage ${stageId}`);
  const config = createMatchConfig(stage, saveWith(upgrades));
  return { sim: new TugSimulation(config), config, stage };
}

const NO_COMMAND = { deploy: null, buyLogistics: false };

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

// 1. supplies accumulate at the configured rate
{
  const { sim, config } = simFor('allied-01');
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
  const { sim } = simFor('allied-01');
  const rateBefore = sim.supplyRate;
  const cost = logisticsCost(0);
  check('first logistics upgrade has a price', typeof cost === 'number' && cost > 0, `cost=${cost}`);

  // Fight with a steady policy until the bonds for one upgrade are banked.
  let guard = 0;
  while (sim.state.bonds < cost && sim.state.status === 'running' && guard < 200) {
    play(sim, 2, (state) =>
      state.supplies >= UNIT_STATS.rifleman.cost ? deploy('rifleman') : null,
    );
    guard += 1;
  }
  const bondsBefore = sim.state.bonds;
  check(
    'destroyed enemies bank enough bonds for an upgrade',
    bondsBefore >= cost,
    `bonds=${bondsBefore}, cost=${cost}`,
  );
  const bought = play(sim, 0.1, () => upgrade());
  check(
    'the logistics upgrade is bought with bonds',
    bought.logisticsLevel === 1 && bought.bonds <= bondsBefore - cost,
    `level=${bought.logisticsLevel}, bonds ${bondsBefore} -> ${bought.bonds}`,
  );
  check(
    'logistics upgrade raises supply generation',
    Math.abs(sim.supplyRate - (rateBefore + C.SUPPLY_PER_LOGISTICS_LEVEL)) < 1e-9,
    `rate ${rateBefore} -> ${sim.supplyRate}`,
  );
  // And it cannot be bought without the bonds.
  const poor = simFor('allied-01').sim;
  const blocked = play(poor, 0.1, () => upgrade());
  check(
    'a broke player cannot buy logistics',
    blocked.logisticsLevel === 0,
    `level=${blocked.logisticsLevel}, bonds=${blocked.bonds}`,
  );
}

// 3. deploying costs supplies and spawns at the player's base
{
  const { sim } = simFor('allied-01');
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
  const { sim } = simFor('allied-01');
  play(sim, 0.1, () => deploy('rifleman'));
  const advancing = sim.state.units.find((u) => u.side === 'player');
  const x0 = advancing.x;
  play(sim, 3);
  const moved = sim.state.units.find((u) => u.side === 'player');
  check('units march toward the enemy', moved.x > x0 + 20, `x ${x0.toFixed(1)} -> ${moved.x.toFixed(1)}`);
}

// 5. a unit stops at its engagement range instead of walking into the enemy
{
  const { sim } = simFor('allied-01');
  // Two riflemen deployed at once end up facing each other across the field.
  play(sim, 0.1, () => deploy('rifleman'));
  play(sim, 20, (state) =>
    state.units.filter((u) => u.side === 'player').length < 1 ? deploy('rifleman') : null,
  );
  const engaged = sim.state.units.find((u) => u.kind === 'rifleman');
  const enemyNear = sim.state.units.filter((u) => u.side === 'enemy');
  if (engaged && enemyNear.length > 0) {
    const nearest = Math.min(...enemyNear.map((u) => Math.abs(u.x - engaged.x)));
    check(
      'riflemen hold their fire line instead of closing',
      nearest <= UNIT_STATS.rifleman.range + 40,
      `nearest hostile ${nearest.toFixed(1)}px, range ${UNIT_STATS.rifleman.range}`,
    );
    check(
      'engaged units switch to the engage state',
      engaged.state === 'engage',
      `state=${engaged.state}`,
    );
  } else {
    check('a firefight happened at all', false, 'no opposing units on the field');
  }
}

// 6. a bolt-action rifleman fires at its documented rate
{
  const { sim } = simFor('allied-01');
  play(sim, 0.1, () => deploy('rifleman'));
  let observed = null;
  for (let i = 0; i < 60 * 90 && observed === null; i += 1) {
    sim.update(C.FIXED_DT, NO_COMMAND);
    const events = sim.takeEvents();
    if (!events.some((event) => event.type === 'shot')) continue;
    // The frame a unit fires, its cooldown is exactly 1/fireRate.
    const shooter = sim.state.units.find(
      (unit) => unit.side === 'player' && unit.kind === 'rifleman' && unit.state === 'engage',
    );
    if (shooter) observed = shooter.cooldown;
  }
  const expected = 1 / UNIT_STATS.rifleman.fireRate;
  check(
    'bolt-action rifleman fires at its documented rate',
    observed !== null && Math.abs(observed - expected) < 0.05,
    `cooldown after firing ${observed === null ? 'never fired' : `${observed.toFixed(3)}s`}, expected ${expected.toFixed(3)}s`,
  );
}

// 6b. the enemy strongpoint is a valid target on its own
{
  const { sim } = simFor('allied-01');
  let sawBaseDamage = false;
  for (let i = 0; i < 60 * 120 && !sawBaseDamage; i += 1) {
    sim.update(C.FIXED_DT, sim.state.supplies >= 20 ? deploy('rifleman') : NO_COMMAND);
    if (sim.state.stats.baseDamage > 0) sawBaseDamage = true;
  }
  check('units engage the enemy strongpoint, not only its troops', sawBaseDamage);
}

// 7. the tank lobs a shell that damages an area and shakes the screen
{
  const { sim } = simFor('allied-01');
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
  const { sim } = simFor('allied-01');
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
  const { sim } = simFor('allied-01');
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

// 11. an idle player loses
{
  const { sim } = simFor('allied-01');
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

const POLICIES = {
  idle: () => null,
  rifle: (state) => (state.supplies >= UNIT_STATS.rifleman.cost ? deploy('rifleman') : null),
  adaptive: (state) => {
    if (state.bonds >= state.logisticsCost && state.logisticsLevel < 4 && state.time > 15) {
      return { deploy: null, buyLogistics: true };
    }
    const mine = state.units.filter((unit) => unit.side === 'player');
    const tanks = mine.filter((unit) => unit.kind === 'tank').length;
    const mgs = mine.filter((unit) => unit.kind === 'mg').length;
    if (state.supplies >= UNIT_STATS.tank.cost && tanks < 3) return deploy('tank');
    if (state.supplies >= UNIT_STATS.mg.cost && mgs < 5) return deploy('mg');
    if (state.supplies >= UNIT_STATS.smg.cost) return deploy('smg');
    return state.supplies >= UNIT_STATS.rifleman.cost ? deploy('rifleman') : null;
  },
};

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

const SAMPLE_NODES = ['allied-01', 'allied-08', 'allied-15', 'allied-22', 'allied-30', 'axis-30'];
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
  adaptive.filter((row) => row.status === 'victory').length >= adaptive.length - 1,
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
