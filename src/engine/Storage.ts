/**
 * GameStorage — strongly typed save-file wrapper.
 *
 * Design rules:
 *  - Zero network access. The only I/O is the injected `KeyValueBackend`.
 *  - Never trusts what it reads back from disk: every field is re-validated
 *    and clamped (corrupt/hand-edited saves can't crash the game).
 *  - Immutable updates: a snapshot handed to game code can't be mutated
 *    behind the store's back.
 *  - Platform-agnostic: swap the backend for `@capacitor/preferences` and
 *    this file is unchanged.
 */

import {
  EMPTY_STAGE_RECORD,
  SAVE_VERSION,
  createFreshSave,
  isFaction,
  isStageRecord,
  systemClock,
} from '../core/types';
import type {
  Clock,
  Faction,
  SaveData,
  StageId,
  StageRecord,
  UpgradeId,
} from '../core/types';
import {
  STARTING_STAGES,
  clampLevel,
  isStageId,
  nextStageId,
  upgradeCost,
} from '../core/progression';
import type { KeyValueBackend } from '../platform/KeyValueStore';
import { createDefaultBackend } from '../platform/KeyValueStore';

export const SAVE_KEY = 'frontline-runner:save:v1';

/** Sanity caps so a corrupted save can never produce absurd numbers. */
const MAX_WAR_BONDS = 1_000_000;
const MAX_COUNTER = 1_000_000;

export type PurchaseResult =
  | { readonly ok: true; readonly level: number; readonly cost: number }
  | { readonly ok: false; readonly reason: 'maxed' | 'insufficient-bonds' | 'unknown-upgrade' };

export interface GameStorageOptions {
  /** Storage backend; defaults to `localStorage` with an in-memory fallback. */
  readonly backend?: KeyValueBackend;
  /** Override the storage key (used by tests). */
  readonly key?: string;
  /** Injectable time source. */
  readonly clock?: Clock;
  readonly startingStages?: readonly StageId[];
  readonly onError?: (error: unknown, context: string) => void;
}

type Listener = (save: SaveData) => void;

function clampBonds(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(MAX_WAR_BONDS, Math.trunc(numeric)));
}

/** Counter for per-node history fields. */
function clampCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(MAX_COUNTER, Math.trunc(numeric)));
}

function freezeSave(save: SaveData): SaveData {
  const records: Record<string, StageRecord> = {};
  for (const [id, record] of Object.entries(save.records)) {
    records[id] = Object.freeze({ ...record });
  }
  return Object.freeze({
    ...save,
    unlockedStages: Object.freeze([...save.unlockedStages]),
    upgrades: Object.freeze({ ...save.upgrades }),
    settings: Object.freeze({ ...save.settings }),
    records: Object.freeze(records),
  });
}

/** Per-node figures a battle reports back to the save file. */
export interface RunReport {
  /** Units the player lost. */
  readonly casualties: number;
  /** Enemy units the player destroyed. */
  readonly kills: number;
}

export class GameStorage {
  private readonly backend: KeyValueBackend;
  private readonly key: string;
  private readonly clock: Clock;
  private readonly startingStages: readonly StageId[];
  private readonly onError: (error: unknown, context: string) => void;
  private readonly listeners = new Set<Listener>();

  private data: SaveData;

  constructor(options: GameStorageOptions = {}) {
    this.backend = options.backend ?? createDefaultBackend();
    this.key = options.key ?? SAVE_KEY;
    this.clock = options.clock ?? systemClock;
    this.startingStages = options.startingStages ?? STARTING_STAGES;
    this.onError =
      options.onError ??
      ((error, context) => {
        console.warn(`[storage] ${context}`, error);
      });
    this.data = freezeSave(createFreshSave(this.clock(), this.startingStages));
    this.reload();
  }

  /** Backend id, e.g. `localStorage` (shown on the boot screen). */
  get backendId(): string {
    return this.backend.id;
  }

  /** `false` means saves won't survive a reload (in-memory fallback). */
  get persistent(): boolean {
    return this.backend.persistent;
  }

  /** Read + validate + migrate. Safe to call at any time. */
  reload(): SaveData {
    const raw = this.backend.get(this.key);
    if (raw === null) {
      this.data = freezeSave(createFreshSave(this.clock(), this.startingStages));
      return this.data;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const normalised = this.normalise(parsed);
      this.data = freezeSave(normalised);
    } catch (error) {
      this.onError(error, 'failed to parse save — starting a fresh campaign');
      this.data = freezeSave(createFreshSave(this.clock(), this.startingStages));
      this.flush();
    }
    return this.data;
  }

  /** Frozen deep copy — mutating it cannot affect persisted state. */
  snapshot(): SaveData {
    return this.data;
  }

  get faction(): Faction | null {
    return this.data.faction;
  }

  get warBonds(): number {
    return this.data.warBonds;
  }

  get muted(): boolean {
    return this.data.settings.muted;
  }

  isStageUnlocked(id: StageId): boolean {
    return this.data.unlockedStages.includes(id);
  }

  unlockedStages(): readonly StageId[] {
    return this.data.unlockedStages;
  }

  upgradeLevel(id: UpgradeId): number {
    return this.data.upgrades[id] ?? 0;
  }

  setUpgradeLevel(id: UpgradeId, level: number): void {
    const next = clampLevel(id, level);
    this.mutate((current) =>
      current.upgrades[id] === next
        ? null
        : { ...current, upgrades: { ...current.upgrades, [id]: next } },
    );
  }

  setFaction(faction: Faction): void {
    if (!isFaction(faction)) {
      this.onError(new Error(`invalid faction: ${String(faction)}`), 'setFaction');
      return;
    }
    this.mutate((current) => (current.faction === faction ? null : { ...current, faction }));
  }

  /** Returns `true` when the stage was newly unlocked. */
  unlockStage(id: StageId): boolean {
    if (!isStageId(id)) {
      this.onError(new Error(`unknown stage: ${String(id)}`), 'unlockStage');
      return false;
    }
    if (this.data.unlockedStages.includes(id)) return false;
    this.mutate((current) => ({
      ...current,
      unlockedStages: [...current.unlockedStages, id],
    }));
    return true;
  }

  /** Award bonds for a cleared stage, unlock the next one, record the win. */
  completeStage(id: StageId, rewardBonds: number, report?: RunReport): void {
    const next = nextStageId(id);
    this.mutate((current) => {
      const stages = next && !current.unlockedStages.includes(next)
        ? [...current.unlockedStages, next]
        : [...current.unlockedStages];
      const previous = current.records[id] ?? EMPTY_STAGE_RECORD;
      const kills = Math.max(0, Math.trunc(report?.kills ?? 0));
      const record: StageRecord = Object.freeze({
        wins: previous.wins + 1,
        losses: previous.losses,
        casualties: previous.casualties + Math.max(0, Math.trunc(report?.casualties ?? 0)),
        bestKills: Math.max(previous.bestKills, kills),
      });
      return {
        ...current,
        warBonds: clampBonds(current.warBonds + clampBonds(rewardBonds)),
        unlockedStages: stages,
        records: { ...current.records, [id]: record },
      };
    });
  }

  /**
   * Record a defeat. No bonds, no unlock — but the map marks the ground as
   * contested so the player can see which node keeps stopping them.
   */
  recordLoss(id: StageId, report?: RunReport): void {
    if (!isStageId(id)) return;
    this.mutate((current) => {
      const previous = current.records[id] ?? EMPTY_STAGE_RECORD;
      const record: StageRecord = Object.freeze({
        wins: previous.wins,
        losses: previous.losses + 1,
        casualties: previous.casualties + Math.max(0, Math.trunc(report?.casualties ?? 0)),
        bestKills: Math.max(previous.bestKills, Math.max(0, Math.trunc(report?.kills ?? 0))),
      });
      return { ...current, records: { ...current.records, [id]: record } };
    });
  }

  /**
   * Bank bonds picked up on the field. Kept separate from `completeStage` so a
   * lost battle still pays for the damage the player did.
   */
  addWarBonds(amount: number): void {
    const delta = clampBonds(amount);
    if (delta === 0) return;
    this.mutate((current) => ({
      ...current,
      warBonds: clampBonds(current.warBonds + delta),
    }));
  }

  /** Deduct bonds atomically. Returns `false` when the player can't afford it. */
  spendWarBonds(amount: number): boolean {
    const cost = clampBonds(amount);
    if (cost === 0) return true;
    if (this.data.warBonds < cost) return false;
    this.mutate((current) => ({ ...current, warBonds: clampBonds(current.warBonds - cost) }));
    return true;
  }

  /** Buy one level of an upgrade track. */
  purchaseUpgrade(id: UpgradeId): PurchaseResult {
    const level = this.upgradeLevel(id);
    const cost = upgradeCost(id, level);
    if (cost === null) {
      return { ok: false, reason: upgradeCost(id, 0) === null ? 'unknown-upgrade' : 'maxed' };
    }
    if (this.data.warBonds < cost) return { ok: false, reason: 'insufficient-bonds' };
    this.mutate((current) => ({
      ...current,
      warBonds: clampBonds(current.warBonds - cost),
      upgrades: { ...current.upgrades, [id]: level + 1 },
    }));
    return { ok: true, level: level + 1, cost };
  }

  setMuted(muted: boolean): void {
    this.mutate((current) =>
      current.settings.muted === muted ? null : { ...current, settings: { muted } },
    );
  }

  /** Wipe the save and start over (used by the boot screen's reset button). */
  reset(): SaveData {
    this.data = freezeSave(createFreshSave(this.clock(), this.startingStages));
    this.flush();
    this.emit();
    return this.data;
  }

  /** Serialised save, portable between web and native builds. */
  exportJson(): string {
    return JSON.stringify(this.data, null, 2);
  }

  importJson(json: string): boolean {
    try {
      const parsed: unknown = JSON.parse(json);
      this.data = freezeSave(this.normalise(parsed));
      this.flush();
      this.emit();
      return true;
    } catch (error) {
      this.onError(error, 'import failed');
      return false;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Write the in-memory save to the backend. */
  flush(): void {
    try {
      this.backend.set(this.key, JSON.stringify(this.data));
    } catch (error) {
      this.onError(error, 'write failed — progress will not persist');
    }
  }

  private mutate(change: (current: SaveData) => SaveData | null): void {
    const next = change(this.data);
    if (next === null) return;
    this.data = freezeSave({ ...next, version: SAVE_VERSION, updatedAt: this.clock() });
    this.flush();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.data);
      } catch (error) {
        this.onError(error, 'listener threw');
      }
    }
  }

  /** Coerce whatever was on disk into a valid SaveData. */
  private normalise(raw: unknown): SaveData {
    const fresh = createFreshSave(this.clock(), this.startingStages);
    if (typeof raw !== 'object' || raw === null) return this.migrate(fresh, raw);

    const source = raw as Record<string, unknown>;
    const faction = isFaction(source.faction) ? source.faction : null;

    const rawStages = Array.isArray(source.unlockedStages) ? source.unlockedStages : [];
    const stages = new Set<StageId>();
    for (const candidate of rawStages) {
      if (isStageId(candidate)) stages.add(candidate);
    }
    for (const stage of this.startingStages) stages.add(stage);

    const rawUpgrades =
      typeof source.upgrades === 'object' && source.upgrades !== null
        ? (source.upgrades as Record<string, unknown>)
        : {};
    const upgrades: Record<UpgradeId, number> = { ...fresh.upgrades };
    for (const id of Object.keys(upgrades) as UpgradeId[]) {
      upgrades[id] = clampLevel(id, Number(rawUpgrades[id]));
    }

    const rawSettings =
      typeof source.settings === 'object' && source.settings !== null
        ? (source.settings as Record<string, unknown>)
        : {};

    const rawRecords =
      typeof source.records === 'object' && source.records !== null
        ? (source.records as Record<string, unknown>)
        : {};
    const records: Record<string, StageRecord> = {};
    for (const [id, value] of Object.entries(rawRecords)) {
      if (!isStageId(id) || !isStageRecord(value)) continue;
      // `bestTroops` is the pre-battlefield field name; read it as a fallback so
      // saves written by the previous build keep their per-node history.
      const legacy = (value as { bestTroops?: unknown }).bestTroops;
      records[id] = {
        wins: clampCount(value.wins),
        losses: clampCount(value.losses),
        casualties: clampCount(value.casualties),
        bestKills: clampCount(value.bestKills ?? legacy),
      };
    }

    const save: SaveData = {
      version: Number.isFinite(Number(source.version)) ? Number(source.version) : SAVE_VERSION,
      faction,
      unlockedStages: [...stages],
      warBonds: clampBonds(source.warBonds),
      upgrades,
      settings: { muted: rawSettings.muted === true },
      records,
      updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : fresh.updatedAt,
    };
    return this.migrate(save, raw);
  }

  /**
   * Forward-migrate older saves. Only v1 exists today; the hook is here so the
   * next shape change is a two-line addition instead of a wipe.
   */
  private migrate(save: SaveData, raw: unknown): SaveData {
    if (save.version === SAVE_VERSION) return save;
    if (save.version > SAVE_VERSION) {
      this.onError(
        new Error(`save version ${save.version} is newer than ${SAVE_VERSION}`),
        'unknown save version — clamped to a valid state',
      );
    }
    void raw; // older revisions will read fields off `raw` here
    return { ...save, version: SAVE_VERSION };
  }
}

export function createGameStorage(options: GameStorageOptions = {}): GameStorage {
  return new GameStorage(options);
}
