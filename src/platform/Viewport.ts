/**
 * Camera — world plane → viewport mapping for the isometric view.
 *
 * Two rules define the whole model:
 *
 *  1. NO LETTERBOXING. The camera never draws into a fixed sub-rectangle; it
 *     spans 100% of the viewport at every aspect ratio, cropping ground rather
 *     than barring. Whatever is outside the ground plane is painted as the
 *     environment's surround, so there is never a black bar to look at.
 *  2. Zoom 1 fits the *playable* field (see `iso.fitScale`), not the whole
 *     diamond of the plane. The corners of an isometric field are empty ground,
 *     so fitting them instead would shrink every soldier for nothing.
 *
 * `focus` is a point on the **ground plane**; the projection itself lives in
 * `src/render/iso/iso.ts` so the camera, the artwork and the pointer hit-tests
 * all agree on it.
 */

import {
  ISO_Y_SCALE,
  fitScale,
  isoPoint,
  isoUnproject,
  type Point,
} from '../render/iso/iso';
import {
  CAMERA_DEFAULT_ZOOM_FACTOR,
  CAMERA_MAX_ZOOM_FACTOR,
  CAMERA_MIN_ZOOM_FACTOR,
  CAMERA_ZOOM_IN_FACTOR,
  WORLD_H,
  WORLD_W,
} from '../game/constants';

export const DEFAULT_ZOOM_FACTOR = CAMERA_DEFAULT_ZOOM_FACTOR;
export const MIN_ZOOM_FACTOR = CAMERA_MIN_ZOOM_FACTOR;
export const MAX_ZOOM_FACTOR = CAMERA_MAX_ZOOM_FACTOR;
/** Opt-in close-action zoom (the HUD button toggles between the two). */
export const ZOOM_IN_FACTOR = CAMERA_ZOOM_IN_FACTOR;

/** How far past the plane's edge the camera may be pushed, world units. */
const OVERSCROLL = 60;

export interface Camera {
  /** Viewport size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** CSS pixels per world unit. */
  readonly zoom: number;
  /** Ground-plane point at the centre of the viewport. */
  readonly focusX: number;
  readonly focusY: number;
  /** The focus point in projected px — cached because every draw needs it. */
  readonly focusProjectedX: number;
  readonly focusProjectedY: number;
}

export function clampZoomFactor(factor: number): number {
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, factor));
}

/** Scale that fits the playable field into this viewport, in CSS px per unit. */
export function baseScale(cssWidth: number, cssHeight: number): number {
  return fitScale(cssWidth, cssHeight);
}

function makeCamera(cssWidth: number, cssHeight: number, zoom: number, focusX: number, focusY: number): Camera {
  const projected = isoPoint(focusX, focusY);
  return {
    cssWidth: Math.max(1, cssWidth),
    cssHeight: Math.max(1, cssHeight),
    zoom,
    focusX,
    focusY,
    focusProjectedX: projected.x,
    focusProjectedY: projected.y,
  };
}

/** A camera at zoom 1, framing the centre of the field. */
export function createCamera(cssWidth: number, cssHeight: number): Camera {
  return makeCamera(
    cssWidth,
    cssHeight,
    baseScale(cssWidth, cssHeight),
    WORLD_W / 2,
    WORLD_H / 2,
  );
}

/**
 * Re-derive a camera for a viewport, focus and zoom factor. The focus is
 * clamped so the view cannot be pushed far off the plane: the isometric plane is
 * a diamond, so a little overscroll past an edge is normal, but flying into the
 * void is not.
 */
export function cameraAt(
  cssWidth: number,
  cssHeight: number,
  desiredFocusX: number,
  desiredFocusY: number,
  zoomFactor: number = DEFAULT_ZOOM_FACTOR,
): Camera {
  const zoom = baseScale(cssWidth, cssHeight) * clampZoomFactor(zoomFactor);
  const focusX = Math.min(WORLD_W + OVERSCROLL, Math.max(-OVERSCROLL, desiredFocusX));
  const focusY = Math.min(WORLD_H + OVERSCROLL, Math.max(-OVERSCROLL, desiredFocusY));
  return makeCamera(cssWidth, cssHeight, zoom, focusX, focusY);
}

/**
 * World plane → viewport. `z` lifts the point off the ground (muzzle height,
 * a lobbed shell, debris in flight) and is scaled with everything else, which is
 * what keeps a vertical offset consistent as the player zooms.
 */
export function worldToScreen(camera: Camera, x: number, y: number, z = 0): Point {
  const projected = isoPoint(x, y);
  return {
    x: camera.cssWidth / 2 + (projected.x - camera.focusProjectedX) * camera.zoom,
    y: camera.cssHeight / 2 + (projected.y - camera.focusProjectedY) * camera.zoom - z * camera.zoom,
  };
}

/** Viewport → world plane (points on the ground; `z` is not recoverable). */
export function screenToWorld(camera: Camera, screenX: number, screenY: number): Point {
  const projectedX = (screenX - camera.cssWidth / 2) / camera.zoom + camera.focusProjectedX;
  const projectedY = (screenY - camera.cssHeight / 2) / camera.zoom + camera.focusProjectedY;
  return isoUnproject(projectedX, projectedY);
}

/** Projected px size of one world unit at this camera. */
export function scaleOf(camera: Camera): number {
  return camera.zoom;
}

/**
 * The world-plane rectangle the viewport can see, expanded a little so art with
 * a footprint larger than a point is not popped off at the edges. The projection
 * is affine, so unprojecting the four viewport corners gives the exact bounds.
 */
export function visibleWorldRect(camera: Camera): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const corners = [
    screenToWorld(camera, 0, 0),
    screenToWorld(camera, camera.cssWidth, 0),
    screenToWorld(camera, 0, camera.cssHeight),
    screenToWorld(camera, camera.cssWidth, camera.cssHeight),
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  }
  const margin = 80;
  return { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin };
}

/**
 * Ground-plane size of the viewport, used by the HUD hit tests and by the
 * renderer's coarse culling (props and tiles that cannot be visible are skipped
 * before they cost a path).
 */
export function visibleWorldSize(camera: Camera): { width: number; height: number } {
  return {
    width: camera.cssWidth / camera.zoom,
    height: (camera.cssHeight / camera.zoom) / ISO_Y_SCALE,
  };
}
