/**
 * Engine barrel — composition root import surface.
 *
 * Nothing in `engine/` imports from `app/` or `main.ts`, so the subsystems can
 * be unit-tested and reused headlessly (see `docs/NATIVE_PORTABILITY.md`).
 *
 * Note there is no asset loader here any more: the battlefield, every unit and
 * the entire HUD are drawn from Canvas 2D paths, so the game has no image
 * dependencies at all beyond the campaign-map SVG used by the menu.
 */

export { GameStorage, createGameStorage, SAVE_KEY } from './Storage';
export type { GameStorageOptions, PurchaseResult, RunReport } from './Storage';
export { SoundManager } from './SoundManager';
export type { PlayOptions, SoundManagerOptions, SoundManagerState, SoundName } from './SoundManager';
export { createBattleInput } from './Input';
export type { BattleInput, BattleInputOptions, PointerSample } from './Input';
