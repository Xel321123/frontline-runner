/**
 * Canvas surface + display/orientation handling.
 *
 * Everything DOM-shaped for the render layer lives here: sizing the canvas to
 * device-pixel-ratio, reacting to resize/orientation changes, and asking for a
 * landscape lock. The game logic never touches this file directly; it receives
 * a `CanvasSurface` and draws into `surface.ctx`.
 */

import { createCanvas, get2dContext } from './images';

export type OrientationLockResult = 'locked' | 'unsupported' | 'denied';

export interface CanvasSurfaceOptions {
  /** Cap the device pixel ratio so 3x phones do not render 9x the pixels. */
  readonly maxPixelRatio?: number;
}

export interface CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Logical (CSS pixel) size of the drawing area. */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /** Draw callback, invoked on every resize and explicit redraw request. */
  onDraw: ((surface: CanvasSurface) => void) | null;
  /** Coalesces to a single frame per change — this is NOT a game loop yet. */
  requestRedraw(): void;
  dispose(): void;
}

export function createCanvasSurface(
  container: HTMLElement,
  options: CanvasSurfaceOptions = {},
): CanvasSurface {
  const maxPixelRatio = options.maxPixelRatio ?? 2;
  const canvas = createCanvas(1, 1);
  canvas.className = 'stage';
  container.appendChild(canvas);
  const ctx = get2dContext(canvas);

  let ratio = 1;
  let width = 1;
  let height = 1;
  let frame: number | null = null;
  let disposed = false;

  const surface: CanvasSurface = {
    canvas,
    ctx,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get pixelRatio() {
      return ratio;
    },
    onDraw: null,
    requestRedraw() {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        surface.onDraw?.(surface);
      });
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      observer.disconnect();
      window.removeEventListener('orientationchange', onLayoutChange);
      canvas.remove();
    },
  };

  function resize(): void {
    const rect = container.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    ratio = Math.min(maxPixelRatio, Math.max(1, window.devicePixelRatio || 1));
    width = cssWidth;
    height = cssHeight;

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    // Draw in CSS pixels; the transform handles the retina scaling.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    surface.requestRedraw();
  }

  const onLayoutChange = (): void => {
    resize();
  };

  const observer = new ResizeObserver(onLayoutChange);
  observer.observe(container);
  window.addEventListener('orientationchange', onLayoutChange);

  resize();
  return surface;
}

export function isLandscape(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia) return window.matchMedia('(orientation: landscape)').matches;
  return window.innerWidth >= window.innerHeight;
}

/**
 * Best-effort landscape lock. Browsers only allow `screen.orientation.lock`
 * from fullscreen (and iOS Safari does not implement it at all), so callers
 * must treat every outcome as advisory. The manifest `orientation: 'landscape'`
 * covers installed Android PWAs; native builds lock via Capacitor/Info.plist.
 */
export async function tryLockLandscape(): Promise<OrientationLockResult> {
  type Lockable = { lock?: (orientation: 'landscape') => Promise<void> };
  const orientation = (globalThis.screen as unknown as { orientation?: Lockable } | undefined)
    ?.orientation;
  if (!orientation || typeof orientation.lock !== 'function') return 'unsupported';
  try {
    await orientation.lock('landscape');
    return 'locked';
  } catch {
    return 'denied';
  }
}

export async function requestFullscreen(element: HTMLElement): Promise<boolean> {
  try {
    await element.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}
