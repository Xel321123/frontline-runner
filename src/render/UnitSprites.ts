/**
 * UnitSpriteBank — turns a manifest entry into one ready-to-draw bitmap.
 *
 * The character pack ships each body part (body, head, helmet, weapon) on its
 * own full-size transparent canvas, positioned so the parts line up when drawn
 * at the same origin. Naively drawn, the soldier would be a speck: the artwork
 * occupies a small part of a 1024x1024 frame.
 *
 * So each unit is processed once: measure the union alpha bounds of its layers
 * (on a downscaled copy — cheap and accurate enough for a crop), then composite
 * every layer through that same source rect into a single tightly-cropped
 * canvas at the requested height. Rendering a run then costs one `drawImage`
 * per soldier instead of four, and the crop is identical for every layer, so
 * alignment is preserved.
 */

import type { AssetKey } from '../core/assets';
import type { Faction } from '../core/types';
import type { AssetLoader, LoadedSprite, SpriteLayer } from '../engine/AssetLoader';
import { createCanvas, drawableSize, get2dContext } from '../platform/images';

export interface UnitSprite {
  readonly key: AssetKey;
  readonly image: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** `procedural` units are Canvas 2D stand-ins for a failed asset. */
  readonly status: 'asset' | 'procedural';
}

interface SourceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Resolution used for the alpha-bounds scan (scaled back up afterwards). */
const SAMPLE = 128;
/** Alpha below this counts as empty (the art has soft edges). */
const ALPHA_THRESHOLD = 10;

function measureBounds(layers: readonly SpriteLayer[]): SourceRect | null {
  const first = layers[0];
  if (!first) return null;
  const natural = drawableSize(first.image);
  if (natural.width === 0 || natural.height === 0) return null;

  const canvas = createCanvas(SAMPLE, SAMPLE);
  const ctx = get2dContext(canvas);

  let minX = SAMPLE;
  let minY = SAMPLE;
  let maxX = -1;
  let maxY = -1;

  for (const layer of layers) {
    ctx.clearRect(0, 0, SAMPLE, SAMPLE);
    ctx.drawImage(layer.image, 0, 0, SAMPLE, SAMPLE);
    const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
    for (let y = 0; y < SAMPLE; y += 1) {
      const row = y * SAMPLE;
      for (let x = 0; x < SAMPLE; x += 1) {
        if (data[(row + x) * 4 + 3] > ALPHA_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const scaleX = natural.width / SAMPLE;
  const scaleY = natural.height / SAMPLE;
  // One pixel of padding stops edge clipping after the scale-up.
  const pad = Math.ceil(Math.max(scaleX, scaleY));
  const x = Math.max(0, Math.floor(minX * scaleX) - pad);
  const y = Math.max(0, Math.floor(minY * scaleY) - pad);
  const right = Math.min(natural.width, Math.ceil((maxX + 1) * scaleX) + pad);
  const bottom = Math.min(natural.height, Math.ceil((maxY + 1) * scaleY) + pad);

  return { x, y, width: right - x, height: bottom - y };
}

export class UnitSpriteBank {
  private readonly loader: AssetLoader;
  private readonly targetHeight: number;
  private readonly cache = new Map<AssetKey, UnitSprite | null>();

  constructor(loader: AssetLoader, options: { targetHeight?: number } = {}) {
    this.loader = loader;
    this.targetHeight = options.targetHeight ?? 76;
  }

  /** The player's own squad, in their faction's uniform. */
  squad(faction: Faction): UnitSprite | null {
    return this.get(faction === 'allied' ? 'unit.allied.t1' : 'unit.axis.t1');
  }

  /** The opposing infantry for a campaign tier. */
  enemyFor(faction: Faction, tier: number): UnitSprite | null {
    if (faction === 'allied') {
      const key = `unit.axis.t${tier}` as AssetKey;
      return this.get(this.loader.has(key) ? key : 'unit.axis.t1');
    }
    return this.get('unit.allied.t1');
  }

  get(key: AssetKey): UnitSprite | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const sprite = this.loader.get(key);
    const built = sprite ? this.build(sprite) : null;
    this.cache.set(key, built);
    return built;
  }

  dispose(): void {
    this.cache.clear();
  }

  private build(sprite: LoadedSprite): UnitSprite | null {
    const bounds = measureBounds(sprite.layers);
    const first = sprite.layers[0];
    if (!bounds || !first) return null;

    const scale = this.targetHeight / bounds.height;
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(this.targetHeight));

    const canvas = createCanvas(width, height);
    const ctx = get2dContext(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    for (const layer of sprite.layers) {
      ctx.drawImage(
        layer.image,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        0,
        0,
        width,
        height,
      );
    }

    return {
      key: sprite.key,
      image: canvas,
      width,
      height,
      status: sprite.status === 'procedural' ? 'procedural' : 'asset',
    };
  }
}
