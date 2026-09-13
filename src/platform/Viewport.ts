/**
 * Camera — world → screen mapping for a full-bleed mobile viewport.
 *
 * There is no letterboxing any more. The canvas always fills the whole window
 * (100vw x 100vh) and the camera *crops* instead of barring: it renders a
 * window of the 1280x720 world, zoomed in so units fill the screen, and pans
 * horizontally to follow the fighting.
 *
 * The zoom is derived, not fixed. A zoom is chosen so the visible world never
 * exceeds the world itself in either axis — on a very wide or very tall screen
 * that means zooming in further rather than showing empty space beyond the
 * battlefield. `MIN_ZOOM`/`MAX_ZOOM` bracket the result.
 *
 * Canvas CSS pixels are the unit of everything the player touches, so HUD
 * hit-testing happens in the same space the HUD is drawn in (see `game/hud.ts`).
 */

export interface Camera {
  /** World units per CSS pixel. 1.8 means "1.8x closer than no zoom". */
  readonly zoom: number;
  /** World coordinates at the centre of the viewport. */
  readonly focusX: number;
  readonly focusY: number;
  /** Canvas size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
}

export interface CameraBounds {
  readonly minFocusX: number;
  readonly maxFocusX: number;
  readonly minFocusY: number;
  readonly maxFocusY: number;
}

/** Never zoom out so far that the world runs out; never zoom in absurdly. */
export const MIN_ZOOM = 1.5;
export const MAX_ZOOM = 2.6;
/** Where the ground line sits vertically, as a fraction of screen height. */
export const GROUND_SCREEN_FRACTION = 0.66;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Pick the zoom for a viewport: the requested zoom, raised if necessary so the
 * visible world fits inside the world in both axes. This is what guarantees
 * "no bars, no gaps" at any aspect ratio.
 */
export function resolveZoom(
  cssWidth: number,
  cssHeight: number,
  worldWidth: number,
  worldHeight: number,
  desired: number,
): number {
  const widthFloor = cssWidth / worldWidth;
  const heightFloor = cssHeight / worldHeight;
  return clamp(Math.max(desired, widthFloor, heightFloor), MIN_ZOOM, MAX_ZOOM);
}

export function createCamera(
  cssWidth: number,
  cssHeight: number,
  worldWidth: number,
  worldHeight: number,
  desiredZoom: number,
  groundY: number,
): Camera {
  const zoom = resolveZoom(cssWidth, cssHeight, worldWidth, worldHeight, desiredZoom);
  return clampCamera(
    {
      zoom,
      focusX: worldWidth / 2,
      focusY: groundFocusY(zoom, cssHeight, groundY),
      cssWidth: Math.max(1, cssWidth),
      cssHeight: Math.max(1, cssHeight),
    },
    worldWidth,
    worldHeight,
  );
}

/** Focus Y that lands the ground line where the art direction wants it. */
export function groundFocusY(zoom: number, cssHeight: number, groundY: number): number {
  return groundY - (GROUND_SCREEN_FRACTION - 0.5) * (cssHeight / zoom);
}

export function visibleWorldWidth(camera: Camera): number {
  return camera.cssWidth / camera.zoom;
}

export function visibleWorldHeight(camera: Camera): number {
  return camera.cssHeight / camera.zoom;
}

/** Where the camera may look, keeping the view inside the world. */
export function cameraBounds(
  camera: Camera,
  worldWidth: number,
  worldHeight: number,
): CameraBounds {
  const halfW = visibleWorldWidth(camera) / 2;
  const halfH = visibleWorldHeight(camera) / 2;
  return {
    minFocusX: halfW,
    maxFocusX: Math.max(halfW, worldWidth - halfW),
    minFocusY: halfH,
    maxFocusY: Math.max(halfH, worldHeight - halfH),
  };
}

/** Keep a camera inside the world and pinned to the ground line. */
export function clampCamera(
  camera: Camera,
  worldWidth: number,
  worldHeight: number,
  groundY?: number,
): Camera {
  const bounds = cameraBounds(camera, worldWidth, worldHeight);
  const focusY =
    groundY === undefined
      ? clamp(camera.focusY, bounds.minFocusY, bounds.maxFocusY)
      : clamp(groundFocusY(camera.zoom, camera.cssHeight, groundY), bounds.minFocusY, bounds.maxFocusY);
  return {
    ...camera,
    focusX: clamp(camera.focusX, bounds.minFocusX, bounds.maxFocusX),
    focusY,
  };
}

/** Re-centre on a new world point without changing zoom. */
export function cameraAt(
  camera: Camera,
  worldWidth: number,
  worldHeight: number,
  focusX: number,
  groundY: number,
): Camera {
  return clampCamera({ ...camera, focusX }, worldWidth, worldHeight, groundY);
}

export function worldToScreen(
  camera: Camera,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return {
    x: (x - camera.focusX) * camera.zoom + camera.cssWidth / 2,
    y: (y - camera.focusY) * camera.zoom + camera.cssHeight / 2,
  };
}

export function screenToWorld(
  camera: Camera,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return {
    x: (x - camera.cssWidth / 2) / camera.zoom + camera.focusX,
    y: (y - camera.cssHeight / 2) / camera.zoom + camera.focusY,
  };
}
