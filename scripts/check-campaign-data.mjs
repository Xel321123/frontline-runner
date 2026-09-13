/**
 * Campaign + weapon database integrity check.
 *
 * Imports the real TypeScript modules (Node 22 strips types natively) and
 * asserts the data contract the rest of the game relies on: 30 + 30 nodes,
 * unique and well-formed ids, coords inside the map, exactly two sentences per
 * briefing, monotonic boss HP, sensible weapon stats, and correct wiring
 * through `core/progression.ts`.
 *
 * Run: npm run check:data
 *
 * Kept OUT of `npm run build` on purpose — it depends on Node's built-in
 * TypeScript support, and CI should not fail on a runtime detail like that.
 */

import { register } from 'node:module';

// Let Node resolve the game's extensionless relative imports (see the hook).
register(new URL('./ts-resolve-hooks.mjs', import.meta.url));

const dataUrl = new URL('../src/data/campaignData.ts', import.meta.url);
const progressionUrl = new URL('../src/core/progression.ts', import.meta.url);

const data = await import(dataUrl.href);
const progression = await import(progressionUrl.href);

const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

/**
 * Count sentences. A terminator only ends a sentence when followed by
 * whitespace + a capital letter (or end of string), so dotted abbreviations in
 * names like "Fort No. 5" are not miscounted.
 */
function countSentences(text) {
  const matches = text.match(/[.!?]+(?=\s+[A-Z"'“]|$)/g);
  return matches ? matches.length : 0;
}

const CAMPAIGN_LENGTH = 30;

for (const faction of ['allied', 'axis']) {
  const nodes = data.CAMPAIGNS[faction];
  const prefix = faction === 'allied' ? 'allied' : 'axis';

  check(Array.isArray(nodes), `${faction}: campaign is not an array`);
  check(
    nodes.length === CAMPAIGN_LENGTH,
    `${faction}: expected ${CAMPAIGN_LENGTH} nodes, found ${nodes.length}`,
  );

  let previousHp = -Infinity;
  nodes.forEach((node, index) => {
    const at = `${faction}[${index}] ${node.id ?? '(no id)'}`;

    check(
      new RegExp(`^${prefix}-\\d{2}$`).test(node.id ?? ''),
      `${at}: id must match ${prefix}-NN`,
    );
    check(
      node.id === `${prefix}-${String(index + 1).padStart(2, '0')}`,
      `${at}: id sequence broken at position ${index + 1}`,
    );
    check(typeof node.name === 'string' && node.name.length > 1, `${at}: missing name`);
    check(/^\d{4}(-\d{2})?$/.test(node.year ?? ''), `${at}: bad year "${node.year}"`);
    check(data.THEATERS.includes(node.theater), `${at}: unknown theater "${node.theater}"`);
    check(
      Number.isFinite(node.coords?.x) && node.coords.x >= 0 && node.coords.x <= 100,
      `${at}: coords.x out of range`,
    );
    check(
      Number.isFinite(node.coords?.y) && node.coords.y >= 0 && node.coords.y <= 100,
      `${at}: coords.y out of range`,
    );
    check(
      typeof node.bossName === 'string' && node.bossName.length > 2,
      `${at}: missing bossName`,
    );
    check(Number.isFinite(node.bossHp) && node.bossHp > 0, `${at}: bossHp must be positive`);
    check(node.bossHp > previousHp, `${at}: bossHp must escalate (${node.bossHp} after ${previousHp})`);
    previousHp = node.bossHp;

    const sentences = countSentences(node.briefing ?? '');
    check(sentences === 2, `${at}: briefing has ${sentences} sentences, expected 2`);
    check(
      typeof node.briefing === 'string' && node.briefing.length > 80,
      `${at}: briefing looks too short`,
    );
  });
}

// --- weapon table ----------------------------------------------------------

const REQUIRED_WEAPON_FIELDS = [
  'id',
  'name',
  'faction',
  'damage',
  'fireRate',
  'spread',
  'minLevel',
];

for (const faction of ['allied', 'axis']) {
  const weapons = faction === 'allied' ? data.ALLIED_WEAPONS : data.AXIS_WEAPONS;
  check(weapons.length >= 6, `${faction}: expected at least 6 weapons, found ${weapons.length}`);

  let previousMinLevel = -Infinity;
  weapons.forEach((weapon, index) => {
    const at = `${faction} weapon[${index}] ${weapon.id ?? '(no id)'}`;
    for (const field of REQUIRED_WEAPON_FIELDS) {
      check(weapon[field] !== undefined, `${at}: missing required field "${field}"`);
    }
    check(weapon.faction === faction, `${at}: faction is "${weapon.faction}"`);
    check(Number.isFinite(weapon.damage) && weapon.damage > 0, `${at}: damage must be > 0`);
    check(Number.isFinite(weapon.fireRate) && weapon.fireRate > 0, `${at}: fireRate must be > 0`);
    check(Number.isFinite(weapon.spread) && weapon.spread > 0, `${at}: spread must be > 0`);
    check(
      Number.isInteger(weapon.minLevel) && weapon.minLevel >= 1 && weapon.minLevel <= CAMPAIGN_LENGTH,
      `${at}: minLevel must be an integer in 1..${CAMPAIGN_LENGTH}`,
    );
    check(
      weapon.minLevel >= previousMinLevel,
      `${at}: minLevel must not go backwards (${weapon.minLevel} after ${previousMinLevel})`,
    );
    check(
      Number.isInteger(weapon.magazineSize) && weapon.magazineSize >= 1,
      `${at}: magazineSize must be >= 1`,
    );
    check(Number.isFinite(weapon.reloadTime) && weapon.reloadTime > 0, `${at}: reloadTime > 0`);
    check(weapon.automatic === true || weapon.automatic === false, `${at}: automatic must be boolean`);
    previousMinLevel = weapon.minLevel;
  });
}

const allWeaponIds = data.WEAPONS.map((weapon) => weapon.id);
check(
  new Set(allWeaponIds).size === allWeaponIds.length,
  `duplicate weapon ids: ${allWeaponIds.filter((id, i) => allWeaponIds.indexOf(id) !== i).join(', ')}`,
);
check(data.WEAPONS.length === 14, `expected 14 weapons, found ${data.WEAPONS.length}`);
check(
  data.getWeapon('mg-42')?.damage === 42,
  'getWeapon("mg-42") lookup is broken',
);
check(data.startingWeapon('allied').minLevel === 1, 'allied starting weapon must unlock at node 1');
check(data.startingWeapon('axis').minLevel === 1, 'axis starting weapon must unlock at node 1');

// --- progression wiring ----------------------------------------------------

const nodeIds = data.CAMPAIGN_NODES.map((node) => node.id);
check(
  new Set(nodeIds).size === nodeIds.length,
  `duplicate campaign node ids across factions`,
);
check(
  data.CAMPAIGN_NODES.length === CAMPAIGN_LENGTH * 2,
  `expected ${CAMPAIGN_LENGTH * 2} total nodes, found ${data.CAMPAIGN_NODES.length}`,
);
check(
  progression.STAGES.length === CAMPAIGN_LENGTH * 2,
  `progression.STAGES has ${progression.STAGES.length} stages, expected ${CAMPAIGN_LENGTH * 2}`,
);

for (const id of nodeIds) {
  check(progression.isStageId(id), `progression.isStageId rejects campaign node ${id}`);
}
check(
  progression.nextStageId('allied-01') === 'allied-02',
  'nextStageId(allied-01) must be allied-02',
);
check(
  progression.nextStageId('allied-30') === undefined,
  'nextStageId(allied-30) must stop at the end of the Allied campaign',
);
check(
  progression.nextStageId('axis-30') === undefined,
  'nextStageId(axis-30) must stop at the end of the Axis campaign',
);
check(
  progression.STARTING_STAGES.length === 2 &&
    progression.STARTING_STAGES[0] === 'allied-01' &&
    progression.STARTING_STAGES[1] === 'axis-01',
  `STARTING_STAGES should open both campaigns, got [${progression.STARTING_STAGES.join(', ')}]`,
);

for (const faction of ['allied', 'axis']) {
  const stages = progression.stagesForFaction(faction);
  check(stages.length === CAMPAIGN_LENGTH, `${faction}: staged ${stages.length} nodes`);
  const tiers = stages.map((stage) => stage.tier);
  for (const tier of tiers) {
    check(
      progression.TIER_LADDER.includes(tier),
      `${faction}: tier ${tier} is outside the difficulty ladder (${progression.TIER_LADDER.join(', ')})`,
    );
  }
  const bonds = stages.map((stage) => stage.rewardBonds);
  check(
    bonds.every((value, index) => index === 0 || value > bonds[index - 1]),
    `${faction}: reward bonds must escalate`,
  );
  notes.push(
    `${faction}: ${stages.length} nodes, tiers ${Math.min(...tiers)}→${Math.max(...tiers)}, bonds ${bonds[0]}→${bonds[bonds.length - 1]}`,
  );
}

// --- report ----------------------------------------------------------------

const weaponCounts = `allied ${data.ALLIED_WEAPONS.length} / axis ${data.AXIS_WEAPONS.length}`;
if (failures.length === 0) {
  console.log('campaign/weapon data: OK');
  console.log(`  nodes: ${data.CAMPAIGN_NODES.length} (${CAMPAIGN_LENGTH} per faction)`);
  console.log(`  weapons: ${data.WEAPONS.length} (${weaponCounts})`);
  console.log(`  theatres: ${data.THEATERS.length}`);
  for (const note of notes) console.log(`  ${note}`);
} else {
  console.error(`campaign/weapon data: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
