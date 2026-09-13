/**
 * Frontline Runner — pure domain model.
 *
 * PURITY RULE: this module must never import a DOM type, a browser global, or
 * a platform adapter. It is the contract shared by web, iOS and Android
 * (Capacitor) builds and can be unit-tested in plain Node. Everything that
 * touches `window`, `document`, `localStorage` or `AudioContext` lives in
 * `src/platform/**` or `src/engine/**` behind an interface.
 */

/** Which army the player fights for. Persisted in the save file. */
export type Faction = 'allied' | 'axis';

export const FACTIONS: readonly Faction[] = ['allied', 'axis'];

export interface FactionInfo {
  readonly id: Faction;
  readonly name: string;
  readonly blurb: string;
}

export const FACTION_INFO: readonly FactionInfo[] = [
  { id: 'allied', name: 'Allied Forces', blurb: 'Pushing east through occupied Europe.' },
  { id: 'axis', name: 'Axis Forces', blurb: 'Holding the line against the advance.' },
];

export function isFaction(value: unknown): value is Faction {
  return value === 'allied' || value === 'axis';
}

/** Stable stage identifier, e.g. `t1`. Mirrors the character-pack tiers. */
export type StageId = string;

/** Permanent upgrade tracks bought with war bonds. */
export type UpgradeId = 'firepower' | 'armour' | 'mobility' | 'medkit';

export const UPGRADE_IDS: readonly UpgradeId[] = ['firepower', 'armour', 'mobility', 'medkit'];

export function isUpgradeId(value: unknown): value is UpgradeId {
  return typeof value === 'string' && (UPGRADE_IDS as readonly string[]).includes(value);
}

/** Zero-based level per upgrade track (see `progression.ts` for max levels). */
export type UpgradeLevels = Record<UpgradeId, number>;

/**
 * What happened to a node, kept so the campaign map can show cleared ground
 * (green), contested ground (red) and progress stats without a network call.
 */
export interface StageRecord {
  readonly wins: number;
  readonly losses: number;
  /** Troops lost across every attempt at this node. */
  readonly casualties: number;
  /** Best troops remaining on a win (0 until the node is cleared). */
  readonly bestTroops: number;
}

export type StageRecords = Record<StageId, StageRecord>;

export const EMPTY_STAGE_RECORD: StageRecord = {
  wins: 0,
  losses: 0,
  casualties: 0,
  bestTroops: 0,
};

export function isStageRecord(value: unknown): value is Partial<StageRecord> {
  return typeof value === 'object' && value !== null;
}

export interface Settings {
  readonly muted: boolean;
}

/**
 * Everything persisted to local storage. Shape is versioned so a future
 * migration can rewrite older saves instead of wiping them.
 */
export interface SaveData {
  readonly version: number;
  readonly faction: Faction | null;
  readonly unlockedStages: readonly StageId[];
  readonly warBonds: number;
  readonly upgrades: UpgradeLevels;
  readonly settings: Settings;
  /** Per-node history. Absent in older saves — readers must default it. */
  readonly records: StageRecords;
  /** Epoch milliseconds of the last mutation. */
  readonly updatedAt: number;
}

/** Bumped only when the persisted shape changes incompatibly. */
export const SAVE_VERSION = 1;

export function createFreshSave(now: number, startingStages: readonly StageId[]): SaveData {
  return {
    version: SAVE_VERSION,
    faction: null,
    unlockedStages: [...startingStages],
    warBonds: 0,
    upgrades: { firepower: 0, armour: 0, mobility: 0, medkit: 0 },
    settings: { muted: false },
    records: {},
    updatedAt: now,
  };
}

/** Epoch milliseconds, injectable so pure logic stays testable. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
