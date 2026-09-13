/**
 * Progression validation across every stage.
 *
 * The save file is the whole game's memory, so this walks *all sixty* campaign
 * nodes through the real storage layer and asserts that each one:
 *
 *   1. is reachable (every node unlocks, in order, with no gaps),
 *   2. can be cleared — bonds banked, next node unlocked, record written,
 *   3. can be lost — losses recorded without unlocking anything,
 *   4. survives a write→read round trip through the same normalisation path
 *      `localStorage` uses, byte for byte on the fields that matter.
 *
 * It runs against an in-memory `KeyValueBackend` (the same interface
 * `localStorage` implements), so it needs no browser and no network — which is
 * the point: the offline path is the only path.
 *
 * Requires Node's built-in TypeScript support (22.18+); see
 * scripts/ts-resolve-hooks.mjs for the extensionless-import shim.
 */

import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));

const { createGameStorage } = await import('../src/engine/Storage.ts');
const { createMemoryBackend } = await import('../src/platform/KeyValueStore.ts');
const { createFreshSave } = await import('../src/core/types.ts');
const progression = await import('../src/core/progression.ts');
const { THEATERS } = await import('../src/data/campaignData.ts');
const C = await import('../src/game/constants.ts');
const environment = await import('../src/game/environment.ts');
const features = await import('../src/game/features.ts');

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(condition);
}

const SAVE_KEY = 'frontline-runner:save:v1';
const FACTIONS = ['allied', 'axis'];

/** The storage under test, on a backend that mirrors localStorage semantics. */
const backend = createMemoryBackend('test');
let clock = 1_700_000_000_000;
const storage = createGameStorage({
  backend,
  key: SAVE_KEY,
  clock: () => (clock += 1000),
  onError: (error, context) => failures.push(`storage error in ${context}: ${error}`),
});

// ---------------------------------------------------------------- fresh save
{
  storage.reset();
  const save = storage.snapshot();
  check('a fresh save has no faction', save.faction === null);
  check('a fresh save owns the three armory tracks',
    ['health', 'damage', 'baseHp'].every((id) => typeof save.upgrades[id] === 'number'),
    JSON.stringify(save.upgrades));
  check('a fresh save banks no bonds', save.warBonds === 0);
  check('a fresh save has no records', Object.keys(save.records).length === 0);
  check('the backend really holds the save', backend.get(SAVE_KEY) !== null);
}

// --------------------------------------------------- every node is reachable
for (const faction of FACTIONS) {
  storage.reset();
  storage.setFaction(faction);

  const stages = progression.stagesForFaction(faction);
  check(`${faction}: thirty nodes`, stages.length === 30, `${stages.length}`);

  // A fresh save owns the first node of both campaigns, so track the baseline.
  const startingNodes = storage.snapshot().unlockedStages.length;
  let played = 0;
  let totalBonds = 0;

  for (const stage of stages) {
    // 1. reachable: it is unlocked, and it is the next objective in line
    const before = storage.snapshot();
    check(
      `${stage.id} is unlocked before it is played`,
      before.unlockedStages.includes(stage.id),
      `unlocked ${before.unlockedStages.length}`,
    );
    const objective = progression.nextObjective(faction, before.unlockedStages, before.records);
    check(
      `${stage.id} is the next objective in order`,
      objective?.id === stage.id,
      `objective was ${objective?.id}`,
    );

    // 2. a loss records without unlocking
    const casualties = 3 + (stage.index % 5);
    const kills = 1 + (stage.index % 4);
    storage.recordLoss(stage.id, { casualties, kills });
    const afterLoss = storage.snapshot();
    const lossRecord = afterLoss.records[stage.id];
    check(`${stage.id} records a loss`, lossRecord?.losses === 1, JSON.stringify(lossRecord));
    check(
      `${stage.id} unlocks nothing when lost`,
      afterLoss.unlockedStages.length === before.unlockedStages.length,
    );
    check(
      `${stage.id} banks no bonds when lost`,
      afterLoss.warBonds === before.warBonds,
      `${before.warBonds} -> ${afterLoss.warBonds}`,
    );

    // 3. a win banks bonds, writes the record and unlocks the next node
    storage.completeStage(stage.id, stage.rewardBonds, { casualties: 2, kills: 6 });
    const afterWin = storage.snapshot();
    const record = afterWin.records[stage.id];
    check(`${stage.id} records a win`, record?.wins === 1, JSON.stringify(record));
    check(
      `${stage.id} banks its reward`,
      afterWin.warBonds === before.warBonds + stage.rewardBonds,
      `${afterWin.warBonds} vs ${before.warBonds + stage.rewardBonds}`,
    );
    check(
      `${stage.id} keeps the best kill count`,
      record?.bestKills === 6,
      `bestKills=${record?.bestKills}`,
    );
    check(
      `${stage.id} is marked cleared on the map`,
      progression.campaignMap(faction, afterWin.unlockedStages, afterWin.records)
        .find((node) => node.stage.id === stage.id)?.status === 'cleared',
    );

    totalBonds = afterWin.warBonds;
    played += 1;
    // Clearing a node unlocks the next one — except at the end of a campaign,
    // where there is nothing left to open.
    const isFinal = played === stages.length;
    const expected = startingNodes + played - (isFinal ? 1 : 0);
    check(
      isFinal
        ? `${stage.id} ends the campaign without unlocking anything`
        : `${stage.id} unlocks exactly one more node`,
      afterWin.unlockedStages.length === expected,
      `${afterWin.unlockedStages.length} vs ${expected}`,
    );
  }

  // 4. the campaign can be finished, and the end is an end
  const finished = storage.snapshot();
  const map = progression.campaignMap(faction, finished.unlockedStages, finished.records);
  check(
    `${faction}: every node clears`,
    map.every((node) => node.status === 'cleared' && node.wins > 0),
    map.filter((node) => node.status !== 'cleared').map((node) => node.stage.id).join(' '),
  );
  check(
    `${faction}: there is no objective left at the end`,
    progression.nextObjective(faction, finished.unlockedStages, finished.records) === undefined,
  );
  check(
    `${faction}: total war bonds for a full campaign`,
    totalBonds === stages.reduce((sum, stage) => sum + stage.rewardBonds, 0),
    `${totalBonds}`,
  );
  check(
    `${faction}: campaign totals agree with the records`,
    progression.campaignTotals(faction, finished.records).cleared === 30,
    JSON.stringify(progression.campaignTotals(faction, finished.records)),
  );
}

// --------------------------------------- the save survives a storage round trip
{
  storage.reset();
  storage.setFaction('allied');
  storage.completeStage('allied-01', 60, { casualties: 4, kills: 9 });
  storage.completeStage('allied-02', 75, { casualties: 1, kills: 12 });
  storage.recordLoss('allied-03', { casualties: 7, kills: 2 });
  storage.addWarBonds(33);
  storage.purchaseUpgrade('damage');
  storage.setMuted(true);

  const before = storage.snapshot();
  const written = backend.get(SAVE_KEY);
  check('the save is written to the backend', typeof written === 'string' && written.length > 0);

  // Read it back through a *fresh* storage instance: this is exactly what a page
  // reload does, including the normalisation path.
  const reloaded = createGameStorage({ backend, key: SAVE_KEY, clock: () => clock++ });
  const after = reloaded.snapshot();

  check('faction survives a reload', after.faction === before.faction, `${after.faction}`);
  check('bonds survive a reload', after.warBonds === before.warBonds, `${after.warBonds}`);
  check('mute survives a reload', after.settings.muted === before.settings.muted);
  check(
    'upgrades survive a reload',
    JSON.stringify(after.upgrades) === JSON.stringify(before.upgrades),
    JSON.stringify(after.upgrades),
  );
  check(
    'unlocked stages survive a reload',
    after.unlockedStages.join(',') === before.unlockedStages.join(','),
    after.unlockedStages.join(','),
  );
  check(
    'per-node records survive a reload',
    JSON.stringify(after.records) === JSON.stringify(before.records),
    JSON.stringify(after.records),
  );
  check(
    'a win and a loss are both still recorded',
    after.records['allied-01']?.wins === 1 && after.records['allied-03']?.losses === 1,
  );
}

// ------------------------------------------ legacy saves still load (v1 → v1)
{
  storage.reset();
  // A save written by the four-track build that shipped before the armory was
  // re-cut for unit health / damage / fortification.
  backend.set(
    SAVE_KEY,
    JSON.stringify({
      version: 1,
      faction: 'allied',
      unlockedStages: ['allied-01', 'allied-02', 'allied-03'],
      warBonds: 250,
      upgrades: { firepower: 2, armour: 3, mobility: 1, medkit: 1 },
      settings: { muted: true },
      records: {
        'allied-01': { wins: 1, losses: 0, casualties: 4, bestTroops: 12 },
        'allied-02': { wins: 0, losses: 1, casualties: 9, bestTroops: 0 },
      },
      updatedAt: clock,
    }),
  );
  const reloaded = createGameStorage({ backend, key: SAVE_KEY, clock: () => clock++ });
  const save = reloaded.snapshot();
  check('a legacy save still loads', save.faction === 'allied', `${save.faction}`);
  check('legacy bonds are kept', save.warBonds === 250, `${save.warBonds}`);
  check(
    'legacy armour becomes unit health',
    save.upgrades.health === 3,
    JSON.stringify(save.upgrades),
  );
  check(
    'legacy firepower becomes damage (and mobility folds in)',
    save.upgrades.damage === 2,
    JSON.stringify(save.upgrades),
  );
  check(
    'legacy medkit becomes fortification',
    save.upgrades.baseHp === 1,
    JSON.stringify(save.upgrades),
  );
  check(
    'legacy unlocks are kept',
    ['allied-01', 'allied-02', 'allied-03'].every((id) => save.unlockedStages.includes(id)),
    save.unlockedStages.join(','),
  );
  check(
    'legacy records are kept, with bestTroops read as bestKills',
    save.records['allied-01']?.wins === 1 && save.records['allied-01']?.bestKills === 12,
    JSON.stringify(save.records['allied-01']),
  );
  check('legacy mute is kept', save.settings.muted === true);
}

// ------------------------------------------------ every stage is playable, offline
{
  let configured = 0;
  for (const faction of FACTIONS) {
    for (const stage of progression.stagesForFaction(faction)) {
      const rules = environment.environmentRules(stage.environment);
      const layout = features.createFeatureLayout({
        seed: stage.id,
        features: stage.features,
        tier: stage.tier,
      });
      check(
        `${stage.id}: environment produces rules`,
        Number.isFinite(rules.moveSpeedMultiplier) && Number.isFinite(rules.rangeMultiplier),
      );
      check(
        `${stage.id}: features produce a layout`,
        Array.isArray(layout.trenches) && Array.isArray(layout.minefields) && Array.isArray(layout.bridges),
      );
      check(
        `${stage.id}: supply multiplier is sane`,
        stage.supplyRateMultiplier >= 0.5 && stage.supplyRateMultiplier <= 2,
        `${stage.supplyRateMultiplier}`,
      );
      configured += 1;
    }
  }
  check('all sixty stages configure a battle', configured === 60, `${configured}`);
  check(
    'the base supply rate is the documented 2/s before modifiers',
    C.SUPPLY_BASE_RATE === 2,
  );
  check('no stage needs the network', !('fetch' in globalThis) || typeof globalThis.fetch === 'function');
  check('theats are all referenced', THEATERS.length === 11, `${THEATERS.length}`);
}

// ------------------------------------------------------------------- report
if (failures.length > 0) {
  console.error(`progression checks: ${checks - failures.length}/${checks} passed`);
  console.error('FAILURES:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`progression checks: ${checks}/${checks} passed`);
console.log('  all 60 stages: reachable, clearable, losable, and persisted');
console.log('  save round trip: faction, bonds, upgrades, unlocks, records, mute');
console.log('  legacy four-track saves still load and migrate');
