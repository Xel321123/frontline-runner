/**
 * Letterboxed game viewport.
 *
 * The game always simulates and renders a fixed 1280x720 (16:9) logical space
 * regardless of the device. This module maps that logical space into the CSS
 * box of the canvas with pillarbox/letterbox bars, and maps pointer
 * coordinates back the other way — the two directions must agree exactly, so
 * they live together here.
 *
 * Landscape lock: on a portrait screen the game still renders 16:9 (small, with
 * bars), which is why `src/main.ts` also shows a rotate hint.
 */

export interface GameViewport {
  /** CSS pixels per logical unit. */
  readonly scale: number;
  /** CSS pixel offset of the logical origin inside the canvas. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Logical size, unchanging. */
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  /** CSS size of the canvas these rects were computed for. */
  readonly cssWidth: number;
  readonly cssHeight: number;
}

export function computeGameViewport(
  cssWidth: number,
  cssHeight: number,
  logicalWidth: number,
  logicalHeight: number,
): GameViewport {
  const safeWidth = Math.max(1, cssWidth);
  const safeHeight = Math.max(1, cssHeight);
  const scale = Math.min(safeWidth / logicalWidth, safeHeight / logicalHeight);
  return {
    scale,
    offsetX: (safeWidth - logicalWidth * scale) / 2,
    offsetY: (safeHeight - logicalHeight * scale) / 2,
    logicalWidth,
    logicalHeight,
    cssWidth: safeWidth,
    cssHeight: safeHeight,
  };
}

/** Client (viewport) coordinates → logical game coordinates. */
export function clientToLogical(
  clientX: number,
  clientY: number,
  canvasRect: { readonly left: number; readonly top: number },
  viewport: GameViewport,
): { x: number; y: number } {
  return {
    x: (clientX - canvasRect.left - viewport.offsetX) / viewport.scale,
    y: (clientY - canvasRect.top - viewport.offsetY) / viewport.scale,
  };
}

/** Letterspill bars to paint outside the logical area. */
export function letterboxBars(
  viewport: GameViewport,
): { top: number; bottom: number; left: number; right: number } {
  const drawnWidth = viewport.logicalWidth * viewport.scale;
  const drawnHeight = viewport.logicalHeight * viewport.scale;
  return {
    top: viewport.offsetY,
    bottom: viewport.cssHeight - viewport.offsetY - drawnHeight,
    left: viewport.offsetX,
    right: viewport.cssWidth - viewport.offsetX - drawnWidth,
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
