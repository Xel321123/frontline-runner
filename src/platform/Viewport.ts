/**
 * Camera — world → screen mapping for a full-bleed viewport.
 *
 * Two rules define the whole model:
 *
 *  1. NO LETTERBOXING. The camera never draws into a fixed sub-rectangle; it
 *     spans 100% of the viewport at every aspect ratio, cropping rather than
 *     barring.
 *  2. The ground line is anchored `GROUND_MARGIN` px above the bottom edge, so
 *     the deployment bar sits on real ground and the sky does not dominate.
 *
 * `zoom` is a plain multiplier on the fit scale (CSS px per world px), so
 * zoom = 1 shows the whole battlefield — HQ near the left edge, strongpoint
 * near the right — and larger values push in for close action.
 */

import { GROUND_Y, VIEW_HEIGHT, VIEW_WIDTH } from '../game/constants';

/** Distance from the ground line to the bottom of the viewport, in CSS px. */
export const GROUND_MARGIN = 120;
export const MIN_ZOOM_FACTOR = 1;
export const MAX_ZOOM_FACTOR = 2.2;
export const DEFAULT_ZOOM_FACTOR = 1;
/** Opt-in close-action zoom (the HUD button toggles between the two). */
export const ZOOM_IN_FACTOR = 1.7;

export interface Camera {
  /** Viewport size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** CSS pixels per world unit. */
  readonly zoom: number;
  /** World point at the centre of the viewport. */
  readonly focusX: number;
  readonly focusY: number;
}

/** Whole battlefield visible: the scale that fits the world width exactly. */
export function fitScale(cssWidth: number): number {
  return Math.max(0.05, cssWidth / VIEW_WIDTH);
}

/** World point that sits at the viewport centre when the ground is anchored. */
function focusYFor(cssHeight: number, zoom: number): number {
  return GROUND_Y - (cssHeight / 2 - GROUND_MARGIN) / zoom;
}

export function clampZoomFactor(factor: number): number {
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, factor));
}

export function createCamera(cssWidth: number, cssHeight: number): Camera {
  const zoom = fitScale(cssWidth);
  return {
    cssWidth: Math.max(1, cssWidth),
    cssHeight: Math.max(1, cssHeight),
    zoom,
    focusX: VIEW_WIDTH / 2,
    focusY: focusYFor(cssHeight, zoom),
  };
}

/** World half-width visible at a given zoom. */
export function visibleWorldWidth(camera: Camera): number {
  return camera.cssWidth / camera.zoom;
}

export function visibleWorldHeight(camera: Camera): number {
  return camera.cssHeight / camera.zoom;
}

/**
 * Re-derive a camera for a new viewport / focus / zoom. Focus is clamped so the
 * view never leaves the battlefield horizontally, and the ground stays anchored.
 */
export function cameraAt(
  cssWidth: number,
  cssHeight: number,
  desiredFocusX: number,
  zoomFactor: number = DEFAULT_ZOOM_FACTOR,
): Camera {
  const zoom = fitScale(cssWidth) * clampZoomFactor(zoomFactor);
  const half = cssWidth / (2 * zoom);
  const minFocus = Math.min(half, VIEW_WIDTH / 2);
  const maxFocus = Math.max(VIEW_WIDTH - half, VIEW_WIDTH / 2);
  const focusX = Math.min(maxFocus, Math.max(minFocus, desiredFocusX));
  return {
    cssWidth: Math.max(1, cssWidth),
    cssHeight: Math.max(1, cssHeight),
    zoom,
    focusX,
    focusY: focusYFor(cssHeight, zoom),
  };
}

export function worldToScreen(camera: Camera, x: number, y: number): { x: number; y: number } {
  return {
    x: camera.cssWidth / 2 + (x - camera.focusX) * camera.zoom,
    y: camera.cssHeight / 2 + (y - camera.focusY) * camera.zoom,
  };
}

export function screenToWorld(camera: Camera, x: number, y: number): { x: number; y: number } {
  return {
    x: camera.focusX + (x - camera.cssWidth / 2) / camera.zoom,
    y: camera.focusY + (y - camera.cssHeight / 2) / camera.zoom,
  };
}

/** Vertical world bounds visible on screen, for the terrain painters. */
export function visibleWorldRange(camera: Camera): { top: number; bottom: number } {
  const half = visibleWorldHeight(camera) / 2;
  return { top: camera.focusY - half, bottom: camera.focusY + half };
}

/** Sanity helper used by the tests: the world height at this zoom. */
export function worldHeightOnScreen(camera: Camera): number {
  return VIEW_HEIGHT * camera.zoom;
}
