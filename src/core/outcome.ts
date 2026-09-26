/**
 * The report a finished battle hands to the shell.
 *
 * Pure data, no DOM: `Match.ts` builds it from the simulation's final state and
 * the splash screen renders it. It carries per-base detail as well as the
 * totals, because the whole point of the v2 splash is to say *what happened to
 * each position* rather than just won/lost.
 */

import type { BaseKind } from '../game/units';

export type OutcomeStatus = 'victory' | 'defeat';

export interface BaseReport {
  /** Display letter within its own side: A..E. */
  readonly letter: string;
  /** Name shown on the field (the enemy bases carry the campaign's names). */
  readonly name: string;
  readonly kind: BaseKind;
  readonly destroyed: boolean;
  readonly hp: number;
  readonly maxHp: number;
  /** World-plane position, so the splash can hint at the layout. */
  readonly x: number;
  readonly y: number;
}

export interface BattleOutcome {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly year: string;
  readonly situation: string;
  readonly status: OutcomeStatus;
  readonly lossReason: string;
  readonly durationSeconds: number;

  readonly bondsAwarded: number;
  readonly bondsCollected: number;
  readonly unitsDeployed: number;
  readonly unitsLost: number;
  readonly enemyDestroyed: number;
  readonly logisticsBought: number;
  readonly minesHit: number;
  readonly enemyMinesHit: number;

  /** Position counts — the headline of the v2 splash. */
  readonly enemyBases: number;
  readonly enemyBasesDestroyed: number;
  readonly playerBases: number;
  readonly playerBasesLost: number;

  readonly playerHpRemaining: number;
  readonly playerHpMax: number;
  readonly enemyHpRemaining: number;
  readonly enemyHpMax: number;

  /** Every enemy position, in field order, for the per-base breakdown. */
  readonly enemyReport: readonly BaseReport[];
  /** Every friendly position, in field order. */
  readonly playerReport: readonly BaseReport[];

  readonly unlockedStage: string | null;
}
