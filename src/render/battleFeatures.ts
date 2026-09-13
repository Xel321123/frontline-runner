/**
 * Static battlefield features, drawn: dugouts, mine belts and bridge spans.
 *
 * These are drawn *under* the troops (they are terrain), and their live state
 * comes straight from the simulation — a trench that has been overrun is drawn
 * churned up and abandoned, and a mine that has gone off leaves its crater.
 */

import { GROUND_Y, VIEW_HEIGHT } from '../game/constants';
import type { FeatureLayout } from '../game/features';
import { SCENE, type SceneLook } from './palette';

/** A dugout line: a dark trench cut with a sandbag parapet on each lip. */
function drawTrench(
  ctx: CanvasRenderingContext2D,
  zone: { x: number; width: number; overrunBy: 'player' | 'enemy' | null },
  look: SceneLook,
): void {
  const left = zone.x - zone.width / 2;
  const right = zone.x + zone.width / 2;
  const depth = 9;
  const overrun = zone.overrunBy !== null;

  ctx.save();
  ctx.globalAlpha = overrun ? 0.85 : 1;

  // The cut itself.
  ctx.fillStyle = overrun ? '#241d13' : '#332a1c';
  ctx.beginPath();
  ctx.moveTo(left, GROUND_Y + 2);
  ctx.lineTo(left + 6, GROUND_Y + depth);
  ctx.lineTo(right - 6, GROUND_Y + depth);
  ctx.lineTo(right, GROUND_Y + 2);
  ctx.closePath();
  ctx.fill();

  // Wet spoil heaps thrown up on both sides — they take the colour of the
  // ground they were dug out of, so a dugout in snow reads pale.
  ctx.globalAlpha = overrun ? 0.9 : 0.65;
  ctx.fillStyle = look.groundLine;
  ctx.beginPath();
  ctx.ellipse(left + 10, GROUND_Y + 8, 14, 4, 0, 0, Math.PI * 2);
  ctx.ellipse(right - 10, GROUND_Y + 8, 14, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = overrun ? 0.85 : 1;

  // Sandbag parapet, unless the position has been overrun and abandoned.
  if (!overrun) {
    ctx.fillStyle = '#7a6f4f';
    for (let x = left + 4; x < right - 4; x += 13) {
      ctx.beginPath();
      ctx.roundRect(x, GROUND_Y - 5, 11, 5, 2.2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(30, 26, 18, 0.22)';
    ctx.fillRect(left + 4, GROUND_Y - 3, right - left - 8, 1.4);
  } else {
    // Broken timbers and scattered kit where the position was lost.
    ctx.strokeStyle = 'rgba(24, 20, 14, 0.8)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i += 1) {
      const x = left + 12 + i * (zone.width / 5);
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y - 2);
      ctx.lineTo(x + 9, GROUND_Y + 3);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** A mine belt: warning posts along the edge, and the mines themselves. */
function drawMinefield(
  ctx: CanvasRenderingContext2D,
  belt: {
    x: number;
    width: number;
    mines: readonly { x: number; exploded: boolean }[];
    armed: number;
  },
  time: number,
): void {
  const left = belt.x - belt.width / 2;
  const right = belt.x + belt.width / 2;

  ctx.save();
  // Danger tape across the belt.
  ctx.setLineDash([7, 6]);
  ctx.strokeStyle = 'rgba(196, 92, 74, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(left - 8, GROUND_Y - 16);
  ctx.lineTo(right + 8, GROUND_Y - 16);
  ctx.stroke();
  ctx.setLineDash([]);

  // Warning posts on both edges.
  ctx.strokeStyle = '#4a3f2c';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(left - 6, GROUND_Y + 4);
  ctx.lineTo(left - 6, GROUND_Y - 26);
  ctx.moveTo(right + 6, GROUND_Y + 4);
  ctx.lineTo(right + 6, GROUND_Y - 26);
  ctx.stroke();
  ctx.fillStyle = '#c45c4a';
  ctx.beginPath();
  ctx.moveTo(left - 6, GROUND_Y - 26);
  ctx.lineTo(left + 10, GROUND_Y - 22);
  ctx.lineTo(left - 6, GROUND_Y - 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = SCENE.bone;
  ctx.font = '700 8px ui-monospace, monospace';
  ctx.fillText('MINES', left - 4, GROUND_Y - 20);

  for (const mine of belt.mines) {
    if (mine.exploded) {
      // A crater where the mine was.
      ctx.fillStyle = 'rgba(20, 16, 12, 0.5)';
      ctx.beginPath();
      ctx.ellipse(mine.x, GROUND_Y + 2, 9, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    // A half-buried disc with a warning glint.
    ctx.fillStyle = '#3b3626';
    ctx.beginPath();
    ctx.ellipse(mine.x, GROUND_Y - 1, 6, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(196, 92, 74, ${0.5 + Math.sin(time * 3 + mine.x) * 0.2})`;
    ctx.beginPath();
    ctx.arc(mine.x, GROUND_Y - 3, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A bridge span: water either side, a reinforced deck, parapets and piers. */
function drawBridge(
  ctx: CanvasRenderingContext2D,
  span: { x: number; width: number },
  look: SceneLook,
): void {
  const left = span.x - span.width / 2;
  const right = span.x + span.width / 2;

  ctx.save();
  // The river, wider than the span so the ground either side reads as bank.
  const water = ctx.createLinearGradient(0, GROUND_Y, 0, VIEW_HEIGHT);
  water.addColorStop(0, '#2b3a46');
  water.addColorStop(1, '#16212a');
  ctx.fillStyle = water;
  ctx.fillRect(left - 90, GROUND_Y + 4, right - left + 180, VIEW_HEIGHT - GROUND_Y);

  // Ripples.
  ctx.strokeStyle = 'rgba(150, 178, 196, 0.25)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i += 1) {
    const y = GROUND_Y + 10 + i * 3.4;
    ctx.beginPath();
    ctx.moveTo(left - 70 + (i % 3) * 12, y);
    ctx.lineTo(right + 60 - (i % 4) * 10, y);
    ctx.stroke();
  }

  // Deck: a reinforced span that is slightly proud of the ground line.
  ctx.fillStyle = look.groundLine;
  ctx.beginPath();
  ctx.moveTo(left - 12, GROUND_Y + 4);
  ctx.lineTo(right + 12, GROUND_Y + 4);
  ctx.lineTo(right, GROUND_Y - 4);
  ctx.lineTo(left, GROUND_Y - 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(40, 36, 28, 0.45)';
  for (let x = left; x < right; x += 18) {
    ctx.fillRect(x, GROUND_Y - 4, 2, 8);
  }

  // Parapets and piers.
  ctx.fillStyle = '#59544a';
  ctx.fillRect(left - 6, GROUND_Y - 13, 6, 17);
  ctx.fillRect(right, GROUND_Y - 13, 6, 17);
  ctx.strokeStyle = 'rgba(196, 200, 190, 0.25)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(left, GROUND_Y - 12);
  ctx.lineTo(right, GROUND_Y - 12);
  ctx.stroke();
  ctx.fillStyle = '#4c4740';
  ctx.fillRect(left + 22, GROUND_Y + 4, 10, 26);
  ctx.fillRect(right - 32, GROUND_Y + 4, 10, 26);

  // Signpost naming the crossing.
  ctx.strokeStyle = '#3d3830';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(right + 26, GROUND_Y - 2);
  ctx.lineTo(right + 26, GROUND_Y - 30);
  ctx.stroke();
  ctx.fillStyle = '#d8d2c0';
  ctx.fillRect(right + 20, GROUND_Y - 38, 44, 12);
  ctx.fillStyle = '#2a2620';
  ctx.font = '700 7px ui-monospace, monospace';
  ctx.fillText('BRIDGE', right + 24, GROUND_Y - 30);
  ctx.restore();
}

/** Draw every feature on the field, behind the troops. */
export function drawBattleFeatures(
  ctx: CanvasRenderingContext2D,
  layout: FeatureLayout,
  look: SceneLook,
  time: number,
): void {
  for (const span of layout.bridges) drawBridge(ctx, span, look);
  for (const belt of layout.minefields) drawMinefield(ctx, belt, time);
  for (const trench of layout.trenches) drawTrench(ctx, trench, look);
}
