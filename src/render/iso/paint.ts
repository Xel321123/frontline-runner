/**
 * The sprite painter: SVG vector art, drawn through Canvas 2D.
 *
 * Every sprite in the game is authored as **SVG path data** (`d` strings) plus
 * fills — no raster images, no sprite sheets, nothing downloaded. At paint time
 * each path is compiled once into a `Path2D` (cached by its `d` string) and
 * filled with the resolved paint, so a battle costs the same as it did when the
 * art was drawn from ad-hoc canvas calls, but the art itself is authored,
 * versioned and re-scaled like SVG.
 *
 * Two conventions make one path set work for every faction and season:
 *
 * - **Palette tokens.** A fill of `'@cloth'` is resolved through the palette
 *   passed at draw time, so the same rifleman path set becomes olive drab or
 *   feldgrau without duplicating the art.
 * - **Gradients in local space.** A gradient's coordinates are in the shape's
 *   own coordinate system, which is exactly how canvas interprets them (they
 *   are transformed by the current matrix at fill time), so a shaded roof still
 *   shades correctly when the sprite is scaled or rotated.
 */

export type Paint = string | GradientPaint;

export interface GradientPaint {
  readonly kind: 'linear' | 'radial';
  /** Local-space start/end (linear) or centre/radius pair (radial). */
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  /** `[offset, colour-or-token]` stops, offset 0..1. */
  readonly stops: readonly (readonly [number, string])[];
}

/** Affine transform in local space, applied before the shape is filled. */
export interface ShapeTransform {
  readonly tx?: number;
  readonly ty?: number;
  /** Radians, clockwise, about `pivot`. */
  readonly rotate?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly pivotX?: number;
  readonly pivotY?: number;
  /** Explicit matrix `[a, b, c, d, e, f]` — overrides the fields above. */
  readonly matrix?: readonly [number, number, number, number, number, number];
}

export interface Shape {
  /** SVG path data. */
  readonly d: string;
  /** Colour, `@token`, or gradient. Omit for a stroke-only shape. */
  readonly fill?: Paint;
  readonly stroke?: Paint;
  readonly strokeWidth?: number;
  readonly lineCap?: CanvasLineCap;
  readonly lineJoin?: CanvasLineJoin;
  readonly dash?: readonly number[];
  readonly opacity?: number;
  readonly transform?: ShapeTransform;
}

export interface Sprite {
  readonly shapes: readonly Shape[];
}

/** Colour lookup: `'@cloth'` resolves through the palette, literals pass through. */
export type Palette = Readonly<Record<string, string>>;

/** Authoring helper: `sh('M0 0L4 0L4 4Z', '@steel')`. */
export function sh(
  d: string,
  fill?: Paint,
  extra?: Omit<Shape, 'd' | 'fill'>,
): Shape {
  return extra ? { d, fill, ...extra } : { d, fill };
}

/** Authoring helper for a stroked line: `line('M0 0L0 -20', '@ink', 2)`. */
export function line(d: string, stroke: Paint, strokeWidth = 1.4): Shape {
  return { d, stroke, strokeWidth, lineCap: 'round' };
}

const pathCache = new Map<string, Path2D>();

/** Compile (and cache) SVG path data into a `Path2D`. */
export function pathOf(d: string): Path2D {
  const hit = pathCache.get(d);
  if (hit) return hit;
  const path = new Path2D(d);
  pathCache.set(d, path);
  return path;
}

/** Resolve a paint value to something canvas accepts. */
export function resolvePaint(
  paint: Paint | undefined,
  palette: Palette,
): string | CanvasGradient | null {
  if (paint === undefined) return null;
  if (typeof paint === 'string') return token(palette, paint);
  if (paint.kind === 'linear') {
    const gradient = gradientCacheFor(paint, palette, 'linear');
    return gradient;
  }
  return gradientCacheFor(paint, palette, 'radial');
}

/**
 * Gradients are cheap to build but not free, and a 24-tile-wide ground with
 * shading would build hundreds per frame, so they are cached by their
 * definition + resolved stops.
 */
function gradientCacheFor(
  paint: GradientPaint,
  palette: Palette,
  kind: 'linear' | 'radial',
): CanvasGradient | null {
  const ctx = currentContext;
  if (!ctx) return null;
  const stops = paint.stops.map(([offset, colour]) => `${offset}:${token(palette, colour)}`).join('|');
  const key = `${kind}|${paint.from.join(',')}|${paint.to.join(',')}|${stops}`;
  const hit = gradientCache.get(key);
  if (hit) return hit;
  const gradient =
    kind === 'linear'
      ? ctx.createLinearGradient(paint.from[0], paint.from[1], paint.to[0], paint.to[1])
      : ctx.createRadialGradient(
          paint.from[0],
          paint.from[1],
          0,
          paint.to[0],
          paint.to[1],
          Math.max(1, paint.to[0] - paint.from[0]),
        );
  for (const [offset, colour] of paint.stops) gradient.addColorStop(offset, token(palette, colour));
  gradientCache.set(key, gradient);
  return gradient;
}

/** Gradient cache, cleared whenever the drawing context changes. */
const gradientCache = new Map<string, CanvasGradient>();
let currentContext: CanvasRenderingContext2D | null = null;

/** Remember which context gradients belong to (they are context-bound objects). */
function useContext(ctx: CanvasRenderingContext2D): void {
  if (currentContext === ctx) return;
  currentContext = ctx;
  gradientCache.clear();
}

/** `'@cloth'` → `palette.cloth`; anything else is returned unchanged. */
export function token(palette: Palette, value: string): string {
  if (value.charCodeAt(0) !== 64 /* @ */) return value;
  return palette[value.slice(1)] ?? value.slice(1);
}

/** Paint one shape, optionally under an extra transform. */
export function paintShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  palette: Palette,
  override?: ShapeTransform,
): void {
  useContext(ctx);
  const transform = override ?? shape.transform;
  const needsSave = transform !== undefined || shape.opacity !== undefined;
  if (needsSave) ctx.save();
  if (transform) applyTransform(ctx, transform);
  if (shape.opacity !== undefined) ctx.globalAlpha *= shape.opacity;

  const path = pathOf(shape.d);
  const fill = resolvePaint(shape.fill, palette);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(path);
  }
  const stroke = resolvePaint(shape.stroke, palette);
  if (stroke && shape.strokeWidth !== 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = shape.strokeWidth ?? 1;
    ctx.lineCap = shape.lineCap ?? 'round';
    ctx.lineJoin = shape.lineJoin ?? 'round';
    if (shape.dash) ctx.setLineDash([...shape.dash]);
    ctx.stroke(path);
    if (shape.dash) ctx.setLineDash([]);
  }
  if (needsSave) ctx.restore();
}

/** Paint a whole sprite. `extra` applies to every shape in it. */
export function paintSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  palette: Palette,
  extra?: ShapeTransform,
): void {
  for (const shape of sprite.shapes) paintShape(ctx, shape, palette, extra ?? shape.transform);
}

function applyTransform(ctx: CanvasRenderingContext2D, transform: ShapeTransform): void {
  if (transform.matrix) {
    const m = transform.matrix;
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    return;
  }
  if (transform.rotate !== undefined && transform.pivotX !== undefined) {
    ctx.translate(transform.pivotX, transform.pivotY ?? 0);
    ctx.rotate(transform.rotate);
    ctx.translate(-transform.pivotX, -(transform.pivotY ?? 0));
  } else if (transform.rotate !== undefined) {
    ctx.rotate(transform.rotate);
  }
  if (transform.scaleX !== undefined || transform.scaleY !== undefined) {
    const pivotX = transform.pivotX ?? 0;
    const pivotY = transform.pivotY ?? 0;
    ctx.translate(pivotX, pivotY);
    ctx.scale(transform.scaleX ?? 1, transform.scaleY ?? 1);
    ctx.translate(-pivotX, -pivotY);
  }
  if (transform.tx !== undefined || transform.ty !== undefined) {
    ctx.translate(transform.tx ?? 0, transform.ty ?? 0);
  }
}
