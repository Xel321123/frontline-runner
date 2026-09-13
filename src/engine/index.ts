/**
 * Engine barrel — composition root import surface.
 *
 * Nothing in `engine/` imports from `app/` or `main.ts`, so the subsystems can
 * be unit-tested and reused headlessly (see `docs/NATIVE_PORTABILITY.md`).
 */
export { GameStorage, createGameStorage, SAVE_KEY } from './Storage';
export type { GameStorageOptions, PurchaseResult } from './Storage';
export { SoundManager } from './SoundManager';
export type { PlayOptions, SoundManagerOptions, SoundManagerState, SoundName } from './SoundManager';
export { AssetLoader, createAssetLoader, resolveAssetUrl } from './AssetLoader';
export type {
  AssetFailure,
  AssetLoadReport,
  AssetLoaderOptions,
  LoadedSprite,
  SpriteLayer,
} from './AssetLoader';
export {
  PALETTE,
  PROCEDURAL_PAINTERS,
  createProceduralDrawable,
  paintProcedural,
} from './ProceduralSprites';
export type { ProceduralPainter } from './ProceduralSprites';
