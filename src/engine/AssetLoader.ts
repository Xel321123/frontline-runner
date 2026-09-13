/**
 * AssetLoader — loads the sprite manifest, with a procedural fallback per key.
 *
 * Contract: `get(key)` always returns *something drawable*. A missing, corrupt
 * or slow asset downgrades that one sprite to its Canvas 2D fallback and is
 * reported in the load report; it never rejects the boot sequence and never
 * leaves the game without a sprite.
 */

import type { AssetKey, AssetSpec } from '../core/assets';
import { ASSET_MANIFEST } from '../core/assets';
import type { Drawable } from '../platform/images';
import { decodeImage, drawableSize } from '../platform/images';
import { createProceduralDrawable } from './ProceduralSprites';

export interface SpriteLayer {
  readonly name: string;
  readonly image: Drawable;
}

export interface LoadedSprite {
  readonly key: AssetKey;
  readonly label: string;
  readonly status: 'pending' | 'loaded' | 'procedural';
  /** Intrinsic size of the base layer. */
  readonly width: number;
  readonly height: number;
  /** Draw order: first entry is the base layer. */
  readonly layers: readonly SpriteLayer[];
  /** Why the fallback was used, or `null` when the real asset loaded. */
  readonly error: string | null;
}

export interface AssetFailure {
  readonly key: AssetKey;
  readonly label: string;
  readonly reason: string;
}

export interface AssetLoadReport {
  readonly total: number;
  readonly loaded: number;
  readonly procedural: number;
  readonly failures: readonly AssetFailure[];
  readonly durationMs: number;
}

export interface AssetLoaderOptions {
  readonly specs?: readonly AssetSpec[];
  /** Defaults to Vite's `BASE_URL`, so subpath deploys work unchanged. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly onProgress?: (completed: number, total: number, label: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Resolve a manifest-relative path against the deployed base path. */
export function resolveAssetUrl(path: string, baseUrl?: string): string {
  const base =
    baseUrl ??
    (typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env.BASE_URL as string)
      : '/');
  const root = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  try {
    return new URL(`${base}${path}`, root).href;
  } catch {
    return `${base}${path}`;
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class AssetLoader {
  private readonly specs: readonly AssetSpec[];
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly onProgress: AssetLoaderOptions['onProgress'];
  private readonly sprites = new Map<AssetKey, LoadedSprite>();
  private lastReport: AssetLoadReport | null = null;

  constructor(options: AssetLoaderOptions = {}) {
    this.specs = options.specs ?? ASSET_MANIFEST;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onProgress = options.onProgress;
  }

  get report(): AssetLoadReport | null {
    return this.lastReport;
  }

  /** Load every sprite in the manifest. Never rejects. */
  async load(): Promise<AssetLoadReport> {
    const startedAt = performance.now();
    let completed = 0;
    const failures: AssetFailure[] = [];

    await Promise.all(
      this.specs.map(async (spec) => {
        const { sprite, failure } = await this.loadSprite(spec);
        this.sprites.set(spec.key, sprite);
        if (failure) failures.push(failure);
        completed += 1;
        this.onProgress?.(completed, this.specs.length, spec.label);
      }),
    );

    const loaded = this.specs.length - failures.length;
    this.lastReport = {
      total: this.specs.length,
      loaded,
      procedural: failures.length,
      failures,
      durationMs: Math.round(performance.now() - startedAt),
    };
    return this.lastReport;
  }

  get(key: AssetKey): LoadedSprite | undefined {
    return this.sprites.get(key);
  }

  has(key: AssetKey): boolean {
    return this.sprites.has(key);
  }

  /** All loaded sprites, in manifest order. */
  all(): readonly LoadedSprite[] {
    return this.specs
      .map((spec) => this.sprites.get(spec.key))
      .filter((sprite): sprite is LoadedSprite => sprite !== undefined);
  }

  /**
   * Get a sprite or blow up loudly — for call sites where a missing sprite is
   * a programming error (render code should use `get` instead).
   */
  require(key: AssetKey): LoadedSprite {
    const sprite = this.sprites.get(key);
    if (!sprite) throw new Error(`Asset not loaded: ${key}`);
    return sprite;
  }

  private async loadSprite(
    spec: AssetSpec,
  ): Promise<{ sprite: LoadedSprite; failure: AssetFailure | null }> {
    try {
      const loaded = await Promise.all(
        spec.layers.map(async (layer): Promise<SpriteLayer | null> => {
          const url = resolveAssetUrl(layer.url, this.baseUrl);
          try {
            const image = await decodeImage(url, this.timeoutMs);
            return { name: layer.name, image };
          } catch (error) {
            if (layer.optional === true) {
              // Decorative layer: keep the sprite, note it and carry on.
              console.info(`[assets] optional layer "${layer.name}" skipped for ${spec.key}`, error);
              return null;
            }
            throw error;
          }
        }),
      );

      const layers = loaded.filter((layer): layer is SpriteLayer => layer !== null);
      const base = layers[0];
      if (!base) throw new Error('manifest entry has no loadable layers');
      const size = drawableSize(base.image);
      if (size.width === 0 || size.height === 0) {
        throw new Error(`decoded ${spec.layers[0]?.url ?? spec.key} with zero size`);
      }
      return {
        sprite: {
          key: spec.key,
          label: spec.label,
          status: 'loaded',
          width: size.width,
          height: size.height,
          layers,
          error: null,
        },
        failure: null,
      };
    } catch (error) {
      const reason = toMessage(error);
      return {
        sprite: this.buildProceduralSprite(spec, reason),
        failure: { key: spec.key, label: spec.label, reason },
      };
    }
  }

  private buildProceduralSprite(spec: AssetSpec, reason: string): LoadedSprite {
    const image = createProceduralDrawable(
      spec.procedural,
      spec.proceduralSize.width,
      spec.proceduralSize.height,
    );
    return {
      key: spec.key,
      label: spec.label,
      status: 'procedural',
      width: spec.proceduralSize.width,
      height: spec.proceduralSize.height,
      layers: [{ name: 'procedural', image }],
      error: reason,
    };
  }
}

export function createAssetLoader(options: AssetLoaderOptions = {}): AssetLoader {
  return new AssetLoader(options);
}
