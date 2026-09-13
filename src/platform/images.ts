/**
 * Canvas + image primitives.
 *
 * The only place that creates DOM nodes for rendering. Both APIs used here
 * (`HTMLCanvasElement`, `HTMLImageElement`) are web standards available in
 * every target — browsers, iOS WKWebView and Android WebView via Capacitor —
 * so no restructuring is needed to ship native.
 */

/** Anything the renderer can draw with `ctx.drawImage`. */
export type Drawable = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export function isCanvasSupported(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

export function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

export function drawableSize(drawable: Drawable): { width: number; height: number } {
  if (drawable instanceof HTMLImageElement) {
    return { width: drawable.naturalWidth || drawable.width, height: drawable.naturalHeight || drawable.height };
  }
  return { width: drawable.width, height: drawable.height };
}

export class ImageLoadError extends Error {
  override name = 'ImageLoadError';
}

/**
 * Decode one image. Rejects on network/parse error **and** on timeout, so a
 * stalled request can never wedge the boot sequence — the caller falls back to
 * the procedural painter instead.
 */
export function decodeImage(url: string, timeoutMs = 10_000): Promise<Drawable> {
  return new Promise((resolve, reject) => {
    if (!isCanvasSupported()) {
      reject(new ImageLoadError(`No DOM available to decode ${url}`));
      return;
    }
    const image = new Image();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      image.src = '';
      reject(new ImageLoadError(`Timed out after ${timeoutMs}ms loading ${url}`));
    }, timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    image.onload = () => {
      if (typeof image.decode === 'function') {
        image
          .decode()
          .then(() => finish(() => resolve(image)))
          .catch(() => finish(() => resolve(image)));
        return;
      }
      finish(() => resolve(image));
    };
    image.onerror = () => finish(() => reject(new ImageLoadError(`Failed to load ${url}`)));
    image.src = url;
  });
}
