/**
 * Small drawing helpers shared by the artwork modules and the renderer.
 *
 * Everything here is deliberately tiny and stateless: a drop shadow, a health
 * bar, a selection ring, a target marker. They exist so the same visual
 * language (shadow softness, bar geometry, ring pulse) is used on every figure,
 * structure and prop instead of each art module inventing its own.
 */

export interface ShadowOptions {
  /** Anchor: the point where the object touches the ground, in CSS px. */
  readonly x: number;
  readonly y: number;
  /** Half-extents of the ellipse, CSS px. */
  readonly rx: number;
  readonly ry: number;
  /** 0..1 — larger objects cast a softer, darker shadow. */
  readonly alpha?: number;
}

/** A soft ground-plane drop shadow, drawn as a squashed radial gradient. */
export function drawShadow(ctx: CanvasRenderingContext2D, o: ShadowOptions): void {
  const rx = Math.max(1, o.rx);
  const ry = Math.max(0.5, o.ry);
  const alpha = o.alpha ?? 0.34;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(1, ry / rx);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  gradient.addColorStop(0, `rgba(8, 9, 6, ${alpha.toFixed(3)})`);
  gradient.addColorStop(0.6, `rgba(8, 9, 6, ${(alpha * 0.55).toFixed(3)})`);
  gradient.addColorStop(1, 'rgba(8, 9, 6, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export interface HealthBarOptions {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height?: number;
  /** 0..1 remaining hit points. */
  readonly fraction: number;
  /** Bar colour for the healthy end of the range. */
  readonly colour?: string;
  readonly back?: string;
  /** Draw a thin dark outline so the bar reads on snow and on sand. */
  readonly outline?: boolean;
}

/** A compact health bar, used above damaged units and above every base. */
export function drawHealthBar(ctx: CanvasRenderingContext2D, o: HealthBarOptions): void {
  const height = o.height ?? 3;
  const width = Math.max(4, o.width);
  const fraction = Math.max(0, Math.min(1, o.fraction));
  const x = o.x - width / 2;
  const y = o.y;
  ctx.save();
  ctx.fillStyle = o.back ?? 'rgba(10, 12, 9, 0.72)';
  ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
  ctx.fillStyle = o.colour ?? hpColour(fraction);
  ctx.fillRect(x, y, width * fraction, height);
  if (o.outline) {
    ctx.strokeStyle = 'rgba(10, 12, 9, 0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, width + 1, height + 1);
  }
  ctx.restore();
}

/** Green through amber to red as a position is ground down. */
export function hpColour(fraction: number): string {
  if (fraction > 0.66) return '#8dc86a';
  if (fraction > 0.33) return '#e0b455';
  return '#d4614d';
}

export interface RingOptions {
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
  readonly colour: string;
  readonly time: number;
  /** Seconds for one full pulse. */
  readonly period?: number;
}

/** A pulsing ground ring — the "this is selected" marker for a base. */
export function drawGroundRing(ctx: CanvasRenderingContext2D, o: RingOptions): void {
  const period = o.period ?? 1.6;
  const pulse = 0.5 + 0.5 * Math.sin((o.time / period) * Math.PI * 2);
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(1, o.ry / Math.max(1, o.rx));
  ctx.strokeStyle = o.colour;
  ctx.globalAlpha = 0.45 + 0.4 * pulse;
  ctx.lineWidth = 2 + pulse;
  ctx.beginPath();
  ctx.arc(0, 0, o.rx * (0.92 + 0.08 * pulse), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export interface MarkerOptions {
  /** Anchor point, in CSS px. */
  readonly x: number;
  readonly y: number;
  readonly colour: string;
  readonly time: number;
  /** Height of the floating chevron above the anchor. */
  readonly lift: number;
  /** Label drawn with the marker (a base letter), or empty. */
  readonly letter?: string;
}

/**
 * The objective marker: a chevron that bobs above a targeted base so the player
 * can always tell which position their next launch will be aimed at.
 */
export function drawObjectiveMarker(ctx: CanvasRenderingContext2D, o: MarkerOptions): void {
  const bob = Math.sin(o.time * 3.1) * 2.5;
  const y = o.y - o.lift + bob;
  ctx.save();
  ctx.fillStyle = o.colour;
  ctx.strokeStyle = 'rgba(6, 8, 5, 0.65)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(o.x, y + 7);
  ctx.lineTo(o.x - 7, y - 3);
  ctx.lineTo(o.x - 3, y - 3);
  ctx.lineTo(o.x, y - 8);
  ctx.lineTo(o.x + 3, y - 3);
  ctx.lineTo(o.x + 7, y - 3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (o.letter) {
    ctx.font = '700 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(8, 10, 7, 0.9)';
    ctx.fillText(o.letter, o.x, y - 11);
  }
  ctx.restore();
}

/** Blend two hex colours, 0 → `a`, 1 → `b`. Used for damage tinting. */
export function mix(a: string, b: string, t: number): string {
  const ca = hex(a);
  const cb = hex(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const k = Math.max(0, Math.min(1, t));
  const channel = (i: number): number => Math.round(ca[i]! + (cb[i]! - ca[i]!) * k);
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, '0')).join('')}`;
}

function hex(value: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const int = parseInt(match[1]!, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}
