/**
 * ProceduralSprites — the Canvas 2D fallback for every sprite.
 *
 * If an asset in `public/assets/**` is missing, corrupt, blocked by a proxy or
 * times out, `engine/AssetLoader.ts` paints one of these instead, so the game
 * is always playable. All painters are deterministic (no `Math.random`) and use
 * only the standard Canvas 2D API, so they behave identically in a browser,
 * an iOS WKWebView and an Android WebView.
 *
 * These are deliberately schematic stand-ins, not reproductions of the
 * downloaded art.
 */

import type { ProceduralSpriteId } from '../core/assets';
import { createCanvas, get2dContext } from '../platform/images';

export type ProceduralPainter = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => void;

export const PALETTE = {
  ink: '#0d1210',
  sea: '#14202a',
  seaLine: '#1e3140',
  land: '#4a5c3a',
  landEdge: '#6d8551',
  grid: 'rgba(140,170,190,0.16)',
  allied: '#7d8f52',
  alliedDark: '#4c5733',
  axis: '#6b7280',
  axisDark: '#3f454e',
  metal: '#2b2f33',
  metalLight: '#4b5158',
  wood: '#6b4a2a',
  warn: '#c8a13a',
  text: 'rgba(200,215,200,0.45)',
} as const;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** Draw a closed path through normalized (0–1) points, smoothed. */
function smoothPath(
  ctx: CanvasRenderingContext2D,
  points: readonly (readonly [number, number])[],
  width: number,
  height: number,
): void {
  if (points.length < 3) return;
  const first = points[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first[0] * width, first[1] * height);
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous || !current) continue;
    const midX = ((previous[0] + current[0]) / 2) * width;
    const midY = ((previous[1] + current[1]) / 2) * height;
    ctx.quadraticCurveTo(previous[0] * width, previous[1] * height, midX, midY);
  }
  ctx.closePath();
}

// --- coarse, hand-digitised theatre outlines (normalized canvas space) -------

const MAINLAND: readonly (readonly [number, number])[] = [
  [0.045, 0.845], [0.02, 0.78], [0.03, 0.73], [0.055, 0.69], [0.1, 0.67],
  [0.15, 0.655], [0.135, 0.615], [0.17, 0.57], [0.2, 0.53], [0.23, 0.5],
  [0.26, 0.47], [0.31, 0.44], [0.38, 0.42], [0.45, 0.41], [0.51, 0.37],
  [0.555, 0.33], [0.6, 0.26], [0.65, 0.2], [0.75, 0.19], [0.85, 0.21],
  [0.9, 0.28], [0.89, 0.4], [0.85, 0.48], [0.81, 0.56], [0.79, 0.6],
  [0.73, 0.605], [0.65, 0.605], [0.58, 0.62], [0.545, 0.695], [0.62, 0.7],
  [0.7, 0.7], [0.78, 0.69], [0.79, 0.735], [0.72, 0.775], [0.63, 0.79],
  [0.575, 0.775], [0.56, 0.81], [0.58, 0.845], [0.595, 0.79], [0.545, 0.735],
  [0.51, 0.7], [0.485, 0.665], [0.44, 0.62], [0.42, 0.645], [0.44, 0.69],
  [0.47, 0.74], [0.44, 0.78], [0.425, 0.845], [0.41, 0.79], [0.38, 0.725],
  [0.33, 0.7], [0.29, 0.685], [0.24, 0.72], [0.19, 0.76], [0.115, 0.795],
];

const SCANDINAVIA: readonly (readonly [number, number])[] = [
  [0.245, 0.415], [0.2, 0.34], [0.19, 0.27], [0.24, 0.22], [0.31, 0.165],
  [0.38, 0.105], [0.44, 0.08], [0.47, 0.13], [0.465, 0.2], [0.49, 0.29],
  [0.5, 0.335], [0.46, 0.35], [0.43, 0.32], [0.415, 0.38], [0.4, 0.44],
  [0.36, 0.425], [0.31, 0.4], [0.27, 0.39],
];

const BRITAIN: readonly (readonly [number, number])[] = [
  [0.115, 0.5], [0.135, 0.44], [0.17, 0.4], [0.2, 0.44], [0.19, 0.5],
  [0.16, 0.53], [0.18, 0.575], [0.15, 0.6], [0.125, 0.57],
];

const IRELAND: readonly (readonly [number, number])[] = [
  [0.075, 0.5], [0.095, 0.465], [0.1, 0.52], [0.08, 0.555], [0.06, 0.53],
];

const ISLANDS: readonly (readonly (readonly [number, number])[])[] = [
  [[0.425, 0.79], [0.455, 0.815], [0.43, 0.84], [0.41, 0.815]], // Sicily
  [[0.385, 0.745], [0.4, 0.79], [0.385, 0.795], [0.375, 0.755]], // Sardinia
  [[0.36, 0.71], [0.375, 0.74], [0.36, 0.745]], // Corsica
  [[0.58, 0.855], [0.62, 0.855], [0.605, 0.88], [0.585, 0.87]], // Crete
];

/** Schematic theatre map: sea, graticule, smooth landmasses, caption. */
function paintEuropeMap(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = PALETTE.sea;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = Math.max(1, width / 900);
  const steps = 8;
  for (let i = 1; i < steps; i += 1) {
    const x = (width / steps) * i;
    const y = (height / steps) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const landmasses = [MAINLAND, SCANDINAVIA, BRITAIN, IRELAND, ...ISLANDS];
  ctx.lineJoin = 'round';
  for (const shape of landmasses) {
    smoothPath(ctx, shape, width, height);
    ctx.fillStyle = PALETTE.land;
    ctx.fill();
    ctx.strokeStyle = PALETTE.landEdge;
    ctx.lineWidth = Math.max(1, width / 500);
    ctx.stroke();
  }

  // Two frontier lines, purely decorative — no political claim intended.
  ctx.strokeStyle = 'rgba(200,161,58,0.5)';
  ctx.lineWidth = Math.max(1, width / 700);
  ctx.setLineDash([width / 60, width / 90]);
  ctx.beginPath();
  ctx.moveTo(width * 0.4, height * 0.5);
  ctx.lineTo(width * 0.62, height * 0.63);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = PALETTE.text;
  ctx.font = `${Math.round(width / 52)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('EUROPE THEATRE — PROCEDURAL FALLBACK', width * 0.02, height * 0.97);
  ctx.restore();
}

/** Stylized 3×3 weapon sheet standing in for the SVG atlas. */
function paintWeaponsAtlas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, width, height);

  const cols = 3;
  const rows = 3;
  const cellW = width / cols;
  const cellH = height / rows;
  const variants = [
    { barrel: 0.52, mag: 0.1, stock: true, scope: false },
    { barrel: 0.62, mag: 0.14, stock: true, scope: false },
    { barrel: 0.4, mag: 0.08, stock: false, scope: false },
    { barrel: 0.3, mag: 0.07, stock: false, scope: false },
    { barrel: 0.66, mag: 0.12, stock: true, scope: true },
    { barrel: 0.58, mag: 0.09, stock: false, scope: true },
    { barrel: 0.46, mag: 0.11, stock: true, scope: false },
    { barrel: 0.34, mag: 0.06, stock: false, scope: false },
    { barrel: 0.7, mag: 0.13, stock: true, scope: true },
  ];

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    if (!variant) continue;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const originX = col * cellW;
    const originY = row * cellH;

    ctx.strokeStyle = 'rgba(120,140,130,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(originX + 0.5, originY + 0.5, cellW - 1, cellH - 1);

    const cx = originX + cellW * 0.16;
    const cy = originY + cellH * 0.55;
    const scale = cellW;
    const bodyH = cellH * 0.1;

    // receiver
    ctx.fillStyle = PALETTE.metal;
    roundRect(ctx, cx, cy - bodyH * 0.5, scale * variant.barrel, bodyH, bodyH * 0.25);
    ctx.fill();
    // barrel
    ctx.fillStyle = PALETTE.metalLight;
    ctx.fillRect(cx + scale * variant.barrel, cy - bodyH * 0.18, scale * 0.16, bodyH * 0.36);
    // magazine
    ctx.fillStyle = PALETTE.metal;
    roundRect(
      ctx,
      cx + scale * 0.16,
      cy + bodyH * 0.4,
      scale * 0.09,
      cellH * variant.mag * 3,
      bodyH * 0.2,
    );
    ctx.fill();
    // stock
    if (variant.stock) {
      ctx.fillStyle = PALETTE.wood;
      ctx.fillRect(cx - scale * 0.14, cy - bodyH * 0.3, scale * 0.15, bodyH * 0.6);
    }
    // optic / grip
    ctx.fillStyle = variant.scope ? PALETTE.warn : PALETTE.metal;
    roundRect(ctx, cx + scale * 0.2, cy - bodyH * 0.95, scale * 0.16, bodyH * 0.42, bodyH * 0.2);
    ctx.fill();
  }

  ctx.fillStyle = PALETTE.text;
  ctx.font = `${Math.round(width / 46)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText('PROCEDURAL WEAPONS', width * 0.98, height * 0.02);
  ctx.restore();
}

/**
 * Top-down soldier standing in for a character-pack sprite. Drawn facing
 * right (+x), matching the run direction of a landscape runner.
 */
function paintUnit(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  faction: 'allied' | 'enemy',
): void {
  const allied = faction === 'allied';
  const body = allied ? PALETTE.allied : PALETTE.axis;
  const dark = allied ? PALETTE.alliedDark : PALETTE.axisDark;

  ctx.save();
  ctx.clearRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height / 2;
  const unit = Math.min(width, height);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + unit * 0.34, unit * 0.34, unit * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();

  // torso (rounded, oriented along +x)
  ctx.fillStyle = dark;
  roundRect(ctx, cx - unit * 0.3, cy - unit * 0.22, unit * 0.58, unit * 0.44, unit * 0.16);
  ctx.fill();

  // pack
  ctx.fillStyle = PALETTE.metal;
  roundRect(ctx, cx - unit * 0.42, cy - unit * 0.16, unit * 0.16, unit * 0.32, unit * 0.07);
  ctx.fill();

  // arms
  ctx.fillStyle = body;
  roundRect(ctx, cx - unit * 0.04, cy - unit * 0.34, unit * 0.22, unit * 0.14, unit * 0.06);
  ctx.fill();
  roundRect(ctx, cx - unit * 0.04, cy + unit * 0.2, unit * 0.22, unit * 0.14, unit * 0.06);
  ctx.fill();

  // rifle pointing right — the "runner" silhouette reads at a glance
  ctx.fillStyle = PALETTE.metal;
  ctx.fillRect(cx + unit * 0.1, cy - unit * 0.03, unit * 0.62, unit * 0.08);
  ctx.fillStyle = PALETTE.wood;
  ctx.fillRect(cx + unit * 0.0, cy - unit * 0.05, unit * 0.14, unit * 0.12);

  // helmet / head
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx + unit * 0.12, cy, unit * 0.19, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = Math.max(1, unit * 0.03);
  ctx.stroke();

  // facing pip
  ctx.fillStyle = allied ? '#dfe6c8' : '#c3cad6';
  ctx.beginPath();
  ctx.arc(cx + unit * 0.22, cy, unit * 0.045, 0, Math.PI * 2);
  ctx.fill();

  // facing arrow under the unit
  ctx.strokeStyle = 'rgba(220,230,220,0.35)';
  ctx.lineWidth = Math.max(1, unit * 0.025);
  ctx.beginPath();
  ctx.moveTo(cx - unit * 0.1, cy + unit * 0.44);
  ctx.lineTo(cx + unit * 0.22, cy + unit * 0.44);
  ctx.lineTo(cx + unit * 0.12, cy + unit * 0.38);
  ctx.moveTo(cx + unit * 0.22, cy + unit * 0.44);
  ctx.lineTo(cx + unit * 0.12, cy + unit * 0.5);
  ctx.stroke();

  ctx.restore();
}

export const PROCEDURAL_PAINTERS: Record<ProceduralSpriteId, ProceduralPainter> = {
  'map.europe': paintEuropeMap,
  'weapons.atlas': paintWeaponsAtlas,
  'unit.allied': (ctx, width, height) => paintUnit(ctx, width, height, 'allied'),
  'unit.enemy': (ctx, width, height) => paintUnit(ctx, width, height, 'enemy'),
};

/** Paint a fallback onto an existing context. Returns `false` for unknown ids. */
export function paintProcedural(
  id: ProceduralSpriteId,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const painter = PROCEDURAL_PAINTERS[id];
  if (!painter) return false;
  painter(ctx, Math.max(1, width), Math.max(1, height));
  return true;
}

/**
 * Render a fallback into an off-screen canvas so it is a first-class drawable
 * (`ctx.drawImage`-able) interchangeable with a decoded asset.
 */
export function createProceduralDrawable(
  id: ProceduralSpriteId,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = createCanvas(width, height);
  try {
    paintProcedural(id, get2dContext(canvas), canvas.width, canvas.height);
  } catch {
    // Last-ditch placeholder: loud magenta so a broken painter is obvious.
    const ctx = get2dContext(canvas);
    ctx.fillStyle = '#ff00aa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}
