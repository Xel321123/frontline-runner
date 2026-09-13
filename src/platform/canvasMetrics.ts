/**
 * Canvas sizing maths — pure functions, no DOM.
 *
 * The bug this prevents: sizing the backing buffer by devicePixelRatio while
 * leaving the 2D context unscaled. The buffer then holds dpr^2 the pixels of the
 * displayed box, and every game coordinate lands in the top-left 1/dpr of the
 * screen. `buffer` and `ratio` therefore always travel together.
 */

export interface CanvasMetrics {
  /** Backing buffer size in device pixels. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Display size in CSS pixels — what the player actually sees. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Context scale: CSS pixels -> buffer pixels. */
  readonly ratio: number;
}

export const MAX_PIXEL_RATIO = 2;

export function computeCanvasMetrics(
  innerWidth: number,
  innerHeight: number,
  devicePixelRatio: number,
  maxPixelRatio: number = MAX_PIXEL_RATIO,
): CanvasMetrics {
  const cssWidth = Math.max(1, Math.floor(innerWidth));
  const cssHeight = Math.max(1, Math.floor(innerHeight));
  const ratio = Math.min(maxPixelRatio, Math.max(1, devicePixelRatio || 1));
  return {
    cssWidth,
    cssHeight,
    ratio,
    bufferWidth: Math.floor(cssWidth * ratio),
    bufferHeight: Math.floor(cssHeight * ratio),
  };
}

/** True when the context transform matches the buffer/display ratio. */
export function isTransformConsistent(metrics: CanvasMetrics, scaleX: number, scaleY: number): boolean {
  return Math.abs(scaleX - metrics.ratio) < 1e-6 && Math.abs(scaleY - metrics.ratio) < 1e-6;
}
