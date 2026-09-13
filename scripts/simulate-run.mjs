/**
 * Headless run harness — balance, regression and performance checks for the
 * runner engine, with no browser involved.
 *
 * Part 1 drives the real `Simulation` with the real `createLoadout` numbers
 * over real campaign nodes and three autopilots:
 *   - dodge:  superhuman (430 px lookahead, optimal lane each frame)
 *   - react:  human-ish (150 px lookahead, reacts late)
 *   - hold:   never moves — the "do nothing" baseline
 * Part 2 is a mechanics suite: one assertion per rule in the spec (mine −3,
 * wire −1/s, infantry 1:1, crate counters, gate maths, bunker timer, revives).
 *
 * Run: npm run check:sim   (optionally: npm run check:sim -- --node allied-30)
 *
 * What it proves:
 *   1. a competent run reaches and destroys the bunker inside the time limit
 *   2. ignoring hazards loses the squad, and hazards cost a reacting player too
 *   3. every documented mechanic behaves exactly as specified
 *   4. the fixed-step simulation is far cheaper than a 16.6 ms frame budget
 */

import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));

const { getCampaignNode } = await import(
  new URL('../src/data/campaignData.ts', import.meta.url).href
);
const { getStage } = await import(new URL('../src/core/progression.ts', import.meta.url).href);
const { createLevelPlan } = await import(new URL('../src/game/level.ts', import.meta.url).href);
const { createLoadout, toSimConfig, squadDps } = await import(
  new URL('../src/game/loadout.ts', import.meta.url).href
);
const { Simulation } = await import(new URL('../src/game/Simulation.ts', import.meta.url).href);
const C = await import(new URL('../src/game/constants.ts', import.meta.url).href);

const failures = [];
const mechanics = [];

function expect(name, condition, detail) {
  mechanics.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(`mechanics: ${name} (${detail})`);
}

// ---------------------------------------------------------------------------
// Autopilots
// ---------------------------------------------------------------------------

const HALF_BAND = (C.SQUAD_BAND_HEIGHT / 2) * 0.72;
const Y_MIN = C.SQUAD_BAND_HEIGHT / 2;
const Y_MAX = C.VIEW_HEIGHT - C.SQUAD_BAND_HEIGHT / 2;

function dangerAt(state, y, lookaheadX, nearestOnly = false) {
  let danger = 0;
  let nearest = Infinity;
  const squadX = state.squadWorldX;

  const add = (penalty, dx) => {
    if (!nearestOnly) danger += penalty;
    else danger = Math.max(danger, penalty * (1 - Math.min(1, dx / lookaheadX)));
  };

  for (const mine of state.mines) {
    if (mine.armed) continue;
    const dx = mine.x - squadX;
    if (dx < -60 || dx > lookaheadX) continue;
    if (Math.abs(mine.y - y) < C.MINE_RADIUS + HALF_BAND + 16) {
      nearest = Math.min(nearest, dx);
      add(100, dx);
    }
  }

  for (const wire of state.wires) {
    const dx = wire.x - squadX;
    if (dx + wire.length < -60 || dx > lookaheadX) continue;
    const top = wire.y;
    const bottom = wire.y + wire.height;
    if (y + HALF_BAND > top - 12 && y - HALF_BAND < bottom + 12) {
      nearest = Math.min(nearest, dx);
      add(80 + wire.length * 0.1, dx);
    }
  }

  for (const enemy of state.infantry) {
    const dx = enemy.x - squadX;
    if (dx < -60 || dx > lookaheadX) continue;
    if (Math.abs(enemy.y - y) < C.INFANTRY_RADIUS + HALF_BAND + 16) {
      nearest = Math.min(nearest, dx);
      add(120, dx);
    }
  }

  return danger;
}

function rewardAt(state, y) {
  let reward = 0;
  const squadX = state.squadWorldX;

  for (const crate of state.crates) {
    if (crate.taken) continue;
    const dx = crate.x - squadX;
    if (dx < 0 || dx > 900) continue;
    reward += crate.value * 12 * (1 - dx / 1200);
  }
  for (const gate of state.gates) {
    if (gate.resolved) continue;
    const dx = gate.x - squadX;
    if (dx < 0 || dx > 1400) continue;
    const inside = y >= gate.y + 12 && y <= gate.y + gate.height - 12;
    if (!inside) continue;
    if (gate.op === 'add' || gate.op === 'mul') reward += gate.value * 6;
    else reward -= gate.value * 14;
  }
  return reward;
}

function laserTarget(state, lookaheadX, nearestOnly = false) {
  let bestY = state.squadY;
  let bestScore = -Infinity;
  for (let y = Y_MIN + 24; y <= Y_MAX - 24; y += 24) {
    const travel = Math.abs(y - state.squadY) * 0.35;
    const score = rewardAt(state, y) - dangerAt(state, y, lookaheadX, nearestOnly) - travel;
    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }
  return bestY;
}

/**
 * Autopilots. `react` deliberately models a *human*: limited foresight plus a
 * ~130 ms decision latency, so it re-decides every 8 frames instead of every
 * frame. `dodge` is the superhuman upper bound.
 */
function makePolicy(name) {
  let cachedY = null;
  let frame = 0;
  const lookahead = name === 'dodge' ? 430 : 180;
  const holdFrames = name === 'dodge' ? 1 : 8;
  const nearestOnly = name !== 'dodge';

  return (state) => {
    if (name === 'hold') return C.VIEW_HEIGHT / 2;
    if (cachedY === null || frame % holdFrames === 0) {
      cachedY = laserTarget(state, lookahead, nearestOnly);
    }
    frame += 1;
    return cachedY;
  };
}

// ---------------------------------------------------------------------------
// Part 1 — full-node runs
// ---------------------------------------------------------------------------

function planFor(nodeId) {
  const node = getCampaignNode(nodeId);
  const stage = getStage(nodeId);
  if (!node || !stage) throw new Error(`unknown node ${nodeId}`);
  return {
    node,
    stage,
    plan: createLevelPlan({
      nodeId: node.id,
      nodeName: node.name,
      year: node.year,
      theater: node.theater,
      tier: stage.tier,
      bossName: node.bossName,
      bossHp: node.bossHp,
    }),
  };
}

function runNode(nodeId, policyName, upgrades) {
  const { node, stage, plan } = planFor(nodeId);
  const faction = nodeId.startsWith('allied') ? 'allied' : 'axis';
  const loadout = createLoadout(
    faction,
    stage.index,
    upgrades ?? { firepower: 0, armour: 0, mobility: 0, medkit: 0 },
  );
  const sim = new Simulation(plan, toSimConfig(loadout));
  const policy = makePolicy(policyName);

  let ticks = 0;
  let bossTicks = 0;
  let peakTroops = sim.state.troops;
  let troopsAtBoss = 0;
  let cpuMs = 0;
  // Fingerprint of the flight path, so two policies can be shown to differ.
  let trace = 0;
  const events = {};
  const maxTicks = 60 * 240;

  while (sim.state.status === 'running' && ticks < maxTicks) {
    const state = sim.state;
    const targetY = policy(state);
    const t0 = process.hrtime.bigint();
    sim.update(C.FIXED_DT, { targetY });
    cpuMs += Number(process.hrtime.bigint() - t0) / 1e6;
    ticks += 1;
    trace = (trace * 31 + Math.round(sim.state.squadY)) % 0xfffffff;
    if (sim.state.phase === 'boss') {
      if (bossTicks === 0) troopsAtBoss = sim.state.troops;
      bossTicks += 1;
    }
    peakTroops = Math.max(peakTroops, sim.state.troops);
    for (const event of sim.takeEvents()) events[event.type] = (events[event.type] ?? 0) + 1;
  }

  const state = sim.state;
  return {
    nodeId,
    label: `${node.name} (${node.year})`,
    tier: stage.tier,
    weapon: loadout.weapon.name,
    policy: policyName,
    status: state.status,
    lossReason: state.lossReason,
    seconds: +(ticks / 60).toFixed(1),
    bossSeconds: +(bossTicks / 60).toFixed(1),
    bossMaxHp: plan.bossMaxHp,
    troopsAtBoss,
    peakTroops,
    dps: Math.round(squadDps(loadout, Math.max(1, troopsAtBoss))),
    stats: state.stats,
    events,
    trace,
    spawns: plan.spawns.length,
    spawned: sim.spawnedCount,
    cpuMsPerTick: cpuMs / Math.max(1, ticks),
  };
}

const args = process.argv.slice(2);
const nodeArg = args.indexOf('--node');
const onlyNode = nodeArg >= 0 ? args[nodeArg + 1] : undefined;
const nodes = onlyNode
  ? [onlyNode]
  : ['allied-01', 'allied-08', 'allied-15', 'allied-22', 'allied-30'];

const results = [];
console.log('frontline runner — headless simulation\n');
console.log(
  '  node              tier  weapon               policy  result              time    boss   troops(peak)  spawns',
);
console.log('  ' + '-'.repeat(112));
for (const nodeId of nodes) {
  for (const policy of ['dodge', 'react', 'hold']) {
    const result = runNode(nodeId, policy);
    results.push(result);
    console.log(
      '  ' +
        [
          result.nodeId.padEnd(17),
          String(result.tier).padEnd(5),
          result.weapon.slice(0, 20).padEnd(20),
          policy.padEnd(7),
          `${result.status}${result.lossReason ? `/${result.lossReason}` : ''}`.padEnd(19),
          `${result.seconds}s`.padEnd(7),
          `${result.bossSeconds}s`.padEnd(6),
          `${result.troopsAtBoss}(${result.peakTroops})`.padEnd(13),
          `${result.spawned}/${result.spawns}`.padEnd(6),
          `path#${result.trace}`,
        ].join(' '),
    );
  }
}

const byPolicy = (name) => results.filter((r) => r.policy === name);
const skilled = byPolicy('dodge');
const reacting = byPolicy('react');
const idle = byPolicy('hold');

for (const result of skilled) {
  if (result.status !== 'won') {
    failures.push(`dodge policy failed ${result.nodeId} (${result.status}/${result.lossReason})`);
  }
  if (result.bossSeconds > C.BOSS_TIME_LIMIT) {
    failures.push(
      `${result.nodeId}: boss fight took ${result.bossSeconds}s, over the ${C.BOSS_TIME_LIMIT}s limit`,
    );
  }
  if (result.stats.cratesCollected === 0) {
    failures.push(`${result.nodeId}: a winning run collected no crates`);
  }
  if (result.spawned !== result.spawns) {
    failures.push(
      `${result.nodeId}: only ${result.spawned}/${result.spawns} level spawns entered the world`,
    );
  }
}

const reactingWins = reacting.filter((r) => r.status === 'won').length;
if (reactingWins < Math.ceil(reacting.length / 2)) {
  failures.push(
    `react policy only won ${reactingWins}/${reacting.length} nodes — too punishing for a reacting player`,
  );
}

if (idle.filter((r) => r.status === 'won').length === idle.length) {
  failures.push('hold-centre policy won every node — hazards are not threatening enough');
}
const idleDamage = idle.reduce((sum, r) => sum + r.stats.troopsLost, 0);
if (idleDamage === 0) {
  failures.push('hold-centre policy took zero damage across every node — hazards never bite');
}
const reactingDamage = reacting.reduce((sum, r) => sum + r.stats.troopsLost, 0);
if (reactingDamage === 0) {
  failures.push('a merely reacting player took zero damage — hazards are decorative');
}

const worstTick = Math.max(...results.map((r) => r.cpuMsPerTick));
if (worstTick > 2) {
  failures.push(`simulation costs ${worstTick.toFixed(3)} ms/tick, too close to the 16.6 ms budget`);
}

console.log('\nwinning runs');
for (const result of skilled) {
  console.log(
    `  ${result.nodeId}: ${result.status} in ${result.seconds}s · bunker ${result.bossMaxHp}hp in ${result.bossSeconds}s` +
      ` with ${result.troopsAtBoss} troops (${result.dps} dps · ${result.weapon})`,
  );
  console.log(
    `      crates ${result.stats.cratesCollected} (+${result.stats.troopsFromCrates}) · gates +${result.stats.gateGains}/-${result.stats.gateLosses}` +
      ` · kills ${result.stats.kills} · mines ${result.stats.minesHit} · troops lost ${result.stats.troopsLost} · ${result.stats.shotsFired} rounds`,
  );
}

// ---------------------------------------------------------------------------
// Part 2 — mechanics suite (hand-built level plans)
// ---------------------------------------------------------------------------

function microSim({ spawns, bossHp = 3000, length = 4200, config }) {
  const base = createLoadout('allied', 1, {
    firepower: 0,
    armour: 0,
    mobility: 0,
    medkit: 0,
  });
  const plan = {
    nodeId: 'micro',
    nodeName: 'Micro',
    year: '1940',
    theater: 'Test',
    tier: 1,
    spawns,
    bunkerX: length,
    totalScroll: length - C.BOSS_SCREEN_X,
    bossName: 'Test Bunker',
    bossMaxHp: bossHp,
  };
  return new Simulation(plan, { ...toSimConfig(base), ...config });
}

function step(sim, seconds, targetY) {
  const ticks = Math.round(seconds * 60);
  for (let i = 0; i < ticks && sim.state.status === 'running'; i += 1) {
    sim.update(C.FIXED_DT, { targetY });
  }
  return sim.state;
}

// enemy infantry: shot dead before contact
{
  const sim = microSim({
    spawns: [{ kind: 'infantry', x: 700, y: 360, speed: 0, hp: 40 }],
  });
  const state = step(sim, 4, 360);
  expect(
    'enemy infantry can be shot dead',
    state.stats.kills === 1 && state.infantry.length === 0,
    `kills=${state.stats.kills} alive=${state.infantry.length}`,
  );
  expect('killing infantry costs no troops', state.troops === 3, `troops=${state.troops}`);
}

// infantry collision: 1:1
{
  const sim = microSim({
    spawns: [{ kind: 'infantry', x: 700, y: 360, speed: 0, hp: 100000 }],
    config: { startingTroops: 10, fireInterval: 1000 },
  });
  const state = step(sim, 6, 360);
  expect(
    'infantry collision costs exactly 1 troop',
    state.stats.troopsLost === 1 && state.troops === 9,
    `troops=${state.troops} lost=${state.stats.troopsLost}`,
  );
}

// mine: -3, and a triggered mine never fires twice
{
  const sim = microSim({
    spawns: [{ kind: 'mine', x: 700, y: 360 }],
    config: { startingTroops: 10 },
  });
  const state = step(sim, 8, 360);
  expect(
    'mine costs exactly 3 troops, once',
    state.stats.troopsLost === 3 && state.troops === 7 && state.stats.minesHit === 1,
    `troops=${state.troops} lost=${state.stats.troopsLost} hits=${state.stats.minesHit}`,
  );
}

// razor wire: ~1 troop per second spent inside the field
{
  const sim = microSim({
    spawns: [{ kind: 'wire', x: 500, y: 250, height: 220, length: 620 }],
    config: { startingTroops: 12 },
  });
  const state = step(sim, 10, 360);
  expect(
    'razor wire costs about 1 troop per second',
    state.stats.troopsLost >= 2 && state.stats.troopsLost <= 5,
    `lost=${state.stats.troopsLost} over ${state.time.toFixed(1)}s`,
  );
}

// crate: shooting raises the counter, passing deploys paratroopers
{
  const sim = microSim({
    spawns: [{ kind: 'crate', x: 900, y: 360, value: 1 }],
    config: { startingTroops: 4 },
  });
  const state = step(sim, 8, 360);
  expect(
    'shooting a crate raises its counter and passing deploys it',
    state.stats.cratesCollected === 1 && state.stats.troopsFromCrates >= 3,
    `collected=${state.stats.cratesCollected} troops=+${state.stats.troopsFromCrates}`,
  );
}

// gates: +N adds, and firing is disabled so the value is untouched
{
  const sim = microSim({
    spawns: [{ kind: 'gate', x: 700, op: 'add', value: 5, y: 300, height: 200 }],
    config: { startingTroops: 4, fireInterval: 1000 },
  });
  const state = step(sim, 8, 360);
  expect('+N gate adds its value on pass', state.troops === 9, `troops=${state.troops}`);
  expect('a passed gate counts as a gain', state.stats.gateGains === 1, `gains=${state.stats.gateGains}`);
}

// gates: ÷N is costly but never an instant wipe
{
  const sim = microSim({
    spawns: [{ kind: 'gate', x: 700, op: 'div', value: 4, y: 300, height: 200 }],
    config: { startingTroops: 3, fireInterval: 1000 },
  });
  const state = step(sim, 8, 360);
  expect(
    '÷N gate never wipes the squad instantly',
    state.troops === 1 && state.status === 'running',
    `troops=${state.troops} status=${state.status}`,
  );
}

// gates: shooting improves them (a -8 gate gets cheaper)
{
  const sim = microSim({
    spawns: [{ kind: 'gate', x: 700, op: 'sub', value: 8, y: 300, height: 200 }],
    config: { startingTroops: 20 },
  });
  let lowest = 8;
  let guard = 0;
  while (
    sim.state.status === 'running' &&
    !sim.state.gates[0]?.resolved &&
    guard < 60 * 30
  ) {
    sim.update(C.FIXED_DT, { targetY: 360 });
    const gate = sim.state.gates[0];
    if (gate) lowest = Math.min(lowest, gate.value);
    guard += 1;
  }
  expect('shooting a −N gate reduces its penalty', lowest < 8, `lowest value seen ${lowest}`);
}

// gates: a gate the squad does not pass through does not apply
{
  const sim = microSim({
    spawns: [{ kind: 'gate', x: 700, op: 'sub', value: 5, y: 40, height: 200 }],
    config: { startingTroops: 6, fireInterval: 1000 },
  });
  const state = step(sim, 8, 600);
  expect(
    'a gate outside the squad lane does not apply',
    state.troops === 6 && state.stats.gateLosses === 0,
    `troops=${state.troops} losses=${state.stats.gateLosses}`,
  );
}

// end zone: the bunker dies inside the time limit with a real squad
{
  const sim = microSim({
    spawns: [],
    length: 2200,
    bossHp: 3000,
    config: { startingTroops: 20 },
  });
  const state = step(sim, 60, 360);
  expect(
    'bunker is destroyed inside the time limit',
    state.status === 'won' && state.bossHp === 0,
    `status=${state.status} bossHp=${state.bossHp}`,
  );
  expect(
    'scrolling stops during the bunker fight',
    Math.abs(state.scrollX - (2200 - C.BOSS_SCREEN_X)) < 1,
    `scrollX=${state.scrollX}`,
  );
}

// end zone: a hopeless assault fails on the clock
{
  const sim = microSim({
    spawns: [],
    length: 2200,
    bossHp: 900000,
    config: { startingTroops: 2 },
  });
  const state = step(sim, 80, 360);
  expect(
    'an under-strength assault loses on the timer',
    state.status === 'lost' && state.lossReason === 'time-expired',
    `status=${state.status} reason=${state.lossReason}`,
  );
}

// medkit: a wipe is revived once
{
  const sim = microSim({
    spawns: [{ kind: 'mine', x: 700, y: 360 }],
    config: { startingTroops: 3, revives: 1 },
  });
  const state = step(sim, 8, 360);
  expect(
    'medkit revive rebuilds a wiped squad once',
    state.troops === 3 && state.revivesLeft === 0 && state.status === 'running',
    `troops=${state.troops} revives=${state.revivesLeft} status=${state.status}`,
  );
}

// squad wipe without a revive ends the run
{
  const sim = microSim({
    spawns: [{ kind: 'mine', x: 700, y: 360 }],
    config: { startingTroops: 3, revives: 0 },
  });
  const state = step(sim, 8, 360);
  expect(
    'zero troops without a revive is a defeat',
    state.status === 'lost' && state.lossReason === 'squad-wiped',
    `status=${state.status} reason=${state.lossReason}`,
  );
}

// level layout invariants
{
  const { plan } = planFor('allied-15');
  const bounds = plan.spawns.filter((spawn) => spawn.x >= plan.totalScroll);
  expect('no spawns are laid out beyond the boss stop', bounds.length === 0, `beyond=${bounds.length}`);
  const gates = plan.spawns.filter((spawn) => spawn.kind === 'gate');
  expect('gates are laid out in pairs', gates.length % 2 === 0, `gate count ${gates.length}`);
  expect('the level has obstacles', plan.spawns.length > 30, `spawns=${plan.spawns.length}`);
  const kinds = plan.spawns.reduce((acc, spawn) => {
    acc[spawn.kind] = (acc[spawn.kind] ?? 0) + 1;
    return acc;
  }, {});
  expect(
    'the level mixes all four content types',
    ['crate', 'mine', 'wire', 'infantry'].every((kind) => (kinds[kind] ?? 0) > 0),
    JSON.stringify(kinds),
  );
}

// determinism: identical seeds produce identical runs
{
  const first = runNode('allied-08', 'dodge');
  const second = runNode('allied-08', 'dodge');
  expect(
    'the same node plays out identically every time',
    first.status === second.status &&
      first.seconds === second.seconds &&
      first.stats.volleys === second.stats.volleys &&
      first.stats.kills === second.stats.kills,
    `${first.seconds}s/${first.stats.volleys} volleys vs ${second.seconds}s/${second.stats.volleys}`,
  );
}

// upgrades visibly change the run
{
  const stock = runNode('allied-22', 'dodge');
  const maxed = runNode('allied-22', 'dodge', {
    firepower: 5,
    armour: 5,
    mobility: 5,
    medkit: 3,
  });
  expect(
    'maxed upgrades start a bigger squad',
    maxed.stats.volleys > 0 && maxed.peakTroops >= stock.peakTroops,
    `stock peak ${stock.peakTroops} vs maxed ${maxed.peakTroops}`,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('\nmechanics suite');
const passed = mechanics.filter((m) => m.ok).length;
for (const check of mechanics) {
  console.log(`  ${check.ok ? '✓' : '✗'} ${check.name} — ${check.detail}`);
}
console.log(`  ${passed}/${mechanics.length} checks passed`);

console.log(
  `\nsimulation cost: worst ${(worstTick * 1000).toFixed(1)} µs/tick across ${results.length} full runs ` +
    `(16.6 ms budget at 60 fps)`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log('\nsimulation checks: OK');
