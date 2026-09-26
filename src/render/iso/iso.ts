/**
 * Isometric projection for the ground plane.
 *
 * One rule defines the whole view:
 *
 *     screenX = (x - y)
 *     screenY = (x + y) * 0.5
 *
 * so a `TILE`-unit square of ground becomes a 2:1 diamond (twice as wide as it
 * is tall) — the classic Age of Empires camera. One world unit is one screen px
 * at zoom 1, which means an upright figure `h` world units tall is drawn `h`
 * screen px tall: no separate vertical scale to get wrong.
 *
 * Coordinates
 * -----------
 * - **World plane**: `(x, y)`, x runs from the player's rear toward the enemy,
 *   y is depth from the top edge of the plane to the bottom.
 * - **Screen/projected**: `isoPoint(x, y)`, in unzoomed px, relative to the
 *   world origin. The camera (see `src/platform/Viewport.ts`) scales and pans
 *   this into the viewport.
 *
 * This module is pure maths — no canvas, no DOM — so the simulation-adjacent
 * checks and the artwork both build on exactly the same projection.
 */

import {
  TILE,
  VIEW_MAX_X,
  VIEW_MAX_Y,
  VIEW_MIN_X,
  VIEW_MIN_Y,
  WORLD_H,
  WORLD_W,
} from '../../game/constants';

/** Vertical squash of the projection. 0.5 gives the standard 2:1 diamond. */
export const ISO_Y_SCALE = 0.5;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** World plane → projected screen offset (px, before camera zoom). */
export function isoPoint(x: number, y: number): Point {
  return { x: x - y, y: (x + y) * ISO_Y_SCALE };
}

/** Projected screen offset → world plane. Exact inverse of `isoPoint`. */
export function isoUnproject(sx: number, sy: number): Point {
  const a = sx;
  const b = sy / ISO_Y_SCALE;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/**
 * The affine basis that turns the current canvas transform into the ground
 * plane: after `applyIso(ctx)`, drawing in world coordinates draws ground-plane
 * geometry in the isometric view. Path data for flat art (terrain, roads,
 * trenches, scorch marks) is authored in world coordinates and painted under it.
 */
export const ISO_BASIS: readonly [number, number, number, number] = [1, ISO_Y_SCALE, -1, ISO_Y_SCALE];

export function applyIso(ctx: CanvasRenderingContext2D): void {
  ctx.transform(ISO_BASIS[0], ISO_BASIS[1], ISO_BASIS[2], ISO_BASIS[3], 0, 0);
}

/** SVG path data for a polyline/polygon through projected points. */
export function poly(points: readonly Point[], close = true): string {
  if (points.length === 0) return '';
  const head = points[0];
  if (!head) return '';
  let d = `M${round(head.x)} ${round(head.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point) d += `L${round(point.x)} ${round(point.y)}`;
  }
  return close ? `${d}Z` : d;
}

/** Same as `poly`, but the points are world-plane coordinates. */
export function isoPoly(points: readonly Point[], close = true): string {
  return poly(points.map((point) => isoPoint(point.x, point.y)), close);
}

/** One decimal is plenty for path data and keeps the strings small. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface IsoBoxFaces {
  /** Roof quad, at height `h` above the ground plane. */
  readonly top: string;
  /** Two visible wall quads, in projected px relative to the box's own origin. */
  readonly left: string;
  readonly right: string;
  /** The four roof corners, projected — handy for ridge lines and chimneys. */
  readonly topCorners: readonly Point[];
  /** Ground-level footprint, projected. */
  readonly baseCorners: readonly Point[];
}

/**
 * The three visible faces of an axis-aligned box standing on the ground plane,
 * as SVG path data in projected px relative to the world origin. Keeping only
 * the visible faces is what makes a block of geometry read as a solid building
 * in this projection: the top face is always visible, and exactly two walls are.
 *
 * `u0..u1` is the extent along x, `v0..v1` along y, and `h` the height.
 */
export function isoBox(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  h: number,
): IsoBoxFaces {
  const a = isoPoint(u0, v0);
  const b = isoPoint(u1, v0);
  const c = isoPoint(u1, v1);
  const d = isoPoint(u0, v1);

  const lift = (point: Point): Point => ({ x: point.x, y: point.y - h });
  const at = lift(a);
  const bt = lift(b);
  const ct = lift(c);
  const dt = lift(d);

  // Which two walls face the camera is fixed by this projection: the +x face
  // (right) and the +y face (front-left) are the visible pair.
  return {
    top: poly([at, bt, ct, dt]),
    right: poly([d, c, ct, dt]),
    left: poly([b, c, ct, bt]),
    topCorners: [at, bt, ct, dt],
    baseCorners: [a, b, c, d],
  };
}

/** Centre of a tile in world coordinates. */
export function tileCentre(tx: number, ty: number): Point {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/** Which tile a world point falls in. */
export function tileAt(x: number, y: number): { tx: number; ty: number } {
  return { tx: Math.floor(x / TILE), ty: Math.floor(y / TILE) };
}

/** Tiles needed to cover the ground plane. */
export const TILES_X = Math.ceil(WORLD_W / TILE);
export const TILES_Y = Math.ceil(WORLD_H / TILE);

/**
 * Painter's-algorithm sort key for anything standing on the plane: entities
 * farther from the camera (smaller x + y) are drawn first. `bias` breaks ties
 * within a depth so a base can be forced behind the troops leaving it.
 */
export function depthKey(x: number, y: number, bias = 0): number {
  return x + y + bias;
}

/** Bounding box of the default framing, in projected px at zoom 1. */
export const VIEW_BOUNDS = ((): { minX: number; maxX: number; minY: number; maxY: number } => {
  const corners: Point[] = [
    isoPoint(VIEW_MIN_X, VIEW_MIN_Y),
    isoPoint(VIEW_MAX_X, VIEW_MIN_Y),
    isoPoint(VIEW_MAX_X, VIEW_MAX_Y),
    isoPoint(VIEW_MIN_X, VIEW_MAX_Y),
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
  return { minX, maxX, minY, maxY };
})();

/**
 * Scale that fits the default framing into a viewport (CSS px per world unit).
 * The camera clamps to at least this, so zoom 1 always shows the whole playable
 * field and zooming in crops ground rather than adding bars.
 */
export function fitScale(cssWidth: number, cssHeight: number): number {
  const width = Math.max(1, VIEW_BOUNDS.maxX - VIEW_BOUNDS.minX);
  const height = Math.max(1, VIEW_BOUNDS.maxY - VIEW_BOUNDS.minY);
  return Math.max(0.2, Math.min(cssWidth / width, cssHeight / height));
}

/** Centre of the default framing, in projected px. */
export const VIEW_CENTRE: Point = {
  x: (VIEW_BOUNDS.minX + VIEW_BOUNDS.maxX) / 2,
  y: (VIEW_BOUNDS.minY + VIEW_BOUNDS.maxY) / 2,
};

/** Where a base's flag/roof centre sits, for labels and targeting markers. */
export function baseAnchor(x: number, y: number, height: number): Point {
  const projected = isoPoint(x, y);
  return { x: projected.x, y: projected.y - height };
}
