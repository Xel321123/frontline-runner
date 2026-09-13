/**
 * Canvas surface + display/orientation handling.
 *
 * Everything DOM-shaped for the render layer lives here: sizing the canvas to
 * device-pixel-ratio, reacting to resize/orientation changes, and asking for a
 * landscape lock. The game logic never touches this file directly; it receives
 * a `CanvasSurface` and draws into `surface.ctx`.
 */

import { computeCanvasMetrics } from './canvasMetrics';
import { createCanvas, get2dContext } from './images';

export type OrientationLockResult = 'locked' | 'unsupported' | 'denied';
export function exitFullscreen(): void {
  if (typeof document === 'undefined') return;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
}

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
      window.visualViewport?.removeEventListener('resize', onLayoutChange);
      canvas.remove();
    },
  };

  /**
   * Size the backing buffer and the display box together, from the *window*.
   *
   * Taking the size from `window.innerWidth/innerHeight` rather than the
   * container's rect removes any dependence on layout timing (the container can
   * still be mid-transition when a battle starts, which used to leave the buffer
   * sized for the old, letterboxed box). `buffer = css * ratio` and
   * `ctx.setTransform(ratio, ...)` are applied in the same place, so the two can
   * never drift apart.
   */
  function resize(): void {
    const metrics = computeCanvasMetrics(
      window.innerWidth,
      window.innerHeight,
      window.devicePixelRatio,
      maxPixelRatio,
    );
    width = metrics.cssWidth;
    height = metrics.cssHeight;
    ratio = metrics.ratio;

    canvas.style.width = `${metrics.cssWidth}px`;
    canvas.style.height = `${metrics.cssHeight}px`;
    if (canvas.width !== metrics.bufferWidth) canvas.width = metrics.bufferWidth;
    if (canvas.height !== metrics.bufferHeight) canvas.height = metrics.bufferHeight;
    // Draw in CSS pixels; this transform carries the retina scaling.
    ctx.setTransform(metrics.ratio, 0, 0, metrics.ratio, 0, 0);
    surface.requestRedraw();
  }

  const onLayoutChange = (): void => {
    resize();
  };

  const observer = new ResizeObserver(onLayoutChange);
  observer.observe(container);
  window.addEventListener('orientationchange', onLayoutChange);
  // iOS fires neither reliably when the URL bar collapses: the visual viewport
  // does, and it is the box the player actually sees.
  window.visualViewport?.addEventListener('resize', onLayoutChange);

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

/**
 * Enter fullscreen and lock landscape, from inside a user gesture.
 *
 * Browsers only honour `requestFullscreen` when it is called synchronously from
 * a real interaction, which is why the Deploy button calls this directly rather
 * than after the canvas has been built. Everything here is best-effort: iPhone
 * Safari has no fullscreen for non-video elements, and the game must still be
 * perfectly playable filling the window without it.
 */
export async function enterFullscreen(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const target = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
    webkitRequestFullScreen?: () => Promise<void> | void;
  };
  const scope = target as HTMLElement;
  try {
    if (!document.fullscreenElement) {
      const request =
        scope.requestFullscreen?.bind(scope) ??
        target.webkitRequestFullscreen?.bind(target) ??
        target.webkitRequestFullScreen?.bind(target);
      if (!request) return false;
      await request({ navigationUI: 'hide' } as FullscreenOptions);
    }
  } catch {
    return false;
  }
  await tryLockLandscape();
  return true;
}
