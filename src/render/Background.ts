/**
 * Parallax background.
 *
 * Everything is drawn procedurally from a seeded RNG, so the scenery needs no
 * art, no network and no cache — and the same seed always produces the same
 * countryside. Each layer scrolls at its own fraction of the world speed and is
 * built from fixed-width *tiles* whose content is keyed by absolute tile index:
 * a tile looks the same every time it comes around, so nothing pops as the
 * camera moves.
 */

import { createRng } from '../game/rng';
import type { Rng } from '../game/rng';

export const GROUND_Y = 646;
export const GROUND_HEIGHT = 74;

interface ParallaxLayer {
  readonly name: string;
  /** Fraction of the world scroll speed (1 = same speed as the ground). */
  readonly factor: number;
  readonly tileWidth: number;
  readonly paint: (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    tile: number,
  ) => void;
}

export class Background {
  private readonly seed: string;
  private readonly layers: readonly ParallaxLayer[];

  constructor(seed: string) {
    this.seed = seed;
    this.layers = [
      {
        name: 'hills',
        factor: 0.16,
        tileWidth: 520,
        paint: (ctx, x, _y, w, _h, tile) => this.paintHills(ctx, x, w, tile),
      },
      {
        name: 'ruins',
        factor: 0.34,
        tileWidth: 380,
        paint: (ctx, x, _y, w, _h, tile) => this.paintRuins(ctx, x, w, tile),
      },
      {
        name: 'treeline',
        factor: 0.58,
        tileWidth: 300,
        paint: (ctx, x, _y, w, _h, tile) => this.paintTreeline(ctx, x, w, tile),
      },
      {
        name: 'ground',
        factor: 1,
        tileWidth: 260,
        paint: (ctx, x, _y, w, _h, tile) => this.paintGround(ctx, x, w, tile),
      },
    ];
  }

  private rng(layer: string, tile: number): Rng {
    return createRng(`${this.seed}:${layer}:${tile}`);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    scrollX: number,
    width: number,
    height: number,
    time: number,
  ): void {
    this.paintSky(ctx, width, time);

    for (const layer of this.layers) {
      const scrolled = scrollX * layer.factor;
      const baseIndex = Math.floor(scrolled / layer.tileWidth);
      const offset = scrolled - baseIndex * layer.tileWidth;
      const tiles = Math.ceil(width / layer.tileWidth) + 2;

      for (let i = -1; i < tiles; i += 1) {
        const tileIndex = baseIndex + i;
        const x = i * layer.tileWidth - offset;
        layer.paint(ctx, x, GROUND_Y, layer.tileWidth, height - GROUND_Y, tileIndex);
      }
    }
  }

  /** Dawn over the front: a fixed gradient plus a slow sun and cloud band. */
  private paintSky(ctx: CanvasRenderingContext2D, width: number, time: number): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    gradient.addColorStop(0, '#0e1a24');
    gradient.addColorStop(0.45, '#243a44');
    gradient.addColorStop(0.78, '#5b6a5a');
    gradient.addColorStop(1, '#8a7f5c');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, GROUND_Y);

    // Sun low on the horizon, with a soft halo.
    const sunX = width * 0.78;
    const sunY = GROUND_Y - 120;
    const halo = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 220);
    halo.addColorStop(0, 'rgba(255, 214, 150, 0.55)');
    halo.addColorStop(1, 'rgba(255, 214, 150, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(sunX - 240, sunY - 240, 480, 480);
    ctx.fillStyle = 'rgba(255, 232, 190, 0.85)';
    ctx.beginPath();
    ctx.arc(sunX, sunY, 34, 0, Math.PI * 2);
    ctx.fill();

    // Smoke haze drifts slowly, independent of the world.
    const drift = (time * 6) % (width + 400);
    ctx.fillStyle = 'rgba(30, 34, 36, 0.28)';
    for (let i = 0; i < 3; i += 1) {
      const x = ((drift + i * 420) % (width + 400)) - 200;
      const y = 120 + i * 70;
      ctx.beginPath();
      ctx.ellipse(x, y, 190, 26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private paintHills(
    ctx: CanvasRenderingContext2D,
    x: number,
    width: number,
    tile: number,
  ): void {
    const rng = this.rng('hills', tile);
    ctx.fillStyle = '#2b3a3a';
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y);
    const steps = 6;
    for (let i = 0; i <= steps; i += 1) {
      const px = x + (width / steps) * i;
      const py = GROUND_Y - 130 - rng.range(0, 90);
      ctx.lineTo(px, py);
    }
    ctx.lineTo(x + width, GROUND_Y);
    ctx.closePath();
    ctx.fill();
  }

  private paintRuins(
    ctx: CanvasRenderingContext2D,
    x: number,
    width: number,
    tile: number,
  ): void {
    const rng = this.rng('ruins', tile);
    const count = rng.int(1, 3);
    for (let i = 0; i < count; i += 1) {
      const bx = x + rng.range(20, width - 70);
      const bw = rng.range(34, 66);
      const bh = rng.range(40, 110);
      ctx.fillStyle = '#1f2b2b';
      ctx.fillRect(bx, GROUND_Y - bh, bw, bh);
      // broken roofline
      ctx.beginPath();
      ctx.moveTo(bx, GROUND_Y - bh);
      ctx.lineTo(bx + bw * 0.4, GROUND_Y - bh - rng.range(8, 26));
      ctx.lineTo(bx + bw, GROUND_Y - bh + rng.range(0, 12));
      ctx.lineTo(bx + bw, GROUND_Y - bh + 2);
      ctx.lineTo(bx, GROUND_Y - bh + 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  private paintTreeline(
    ctx: CanvasRenderingContext2D,
    x: number,
    width: number,
    tile: number,
  ): void {
    const rng = this.rng('treeline', tile);
    const trees = rng.int(4, 8);
    ctx.fillStyle = '#16211f';
    for (let i = 0; i < trees; i += 1) {
      const tx = x + (width / trees) * i + rng.range(-8, 8);
      const th = rng.range(34, 70);
      const tw = rng.range(14, 26);
      ctx.beginPath();
      ctx.moveTo(tx, GROUND_Y + 6);
      ctx.lineTo(tx + tw / 2, GROUND_Y - th);
      ctx.lineTo(tx + tw, GROUND_Y + 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  private paintGround(
    ctx: CanvasRenderingContext2D,
    x: number,
    width: number,
    tile: number,
  ): void {
    const rng = this.rng('ground', tile);

    ctx.fillStyle = '#2a2b22';
    ctx.fillRect(x, GROUND_Y, width, GROUND_HEIGHT);

    // Road surface with lane pitting.
    ctx.fillStyle = '#3a3a2e';
    ctx.fillRect(x, GROUND_Y, width, 16);
    ctx.fillStyle = 'rgba(20, 20, 16, 0.5)';
    for (let i = 0; i < 5; i += 1) {
      ctx.fillRect(x + rng.range(0, width), GROUND_Y + rng.range(2, 12), rng.range(6, 18), 2);
    }

    // Grass tufts and scattered debris below the road.
    for (let i = 0; i < 10; i += 1) {
      const gx = x + rng.range(0, width);
      const gy = GROUND_Y + rng.range(20, GROUND_HEIGHT - 6);
      ctx.strokeStyle = 'rgba(110, 128, 74, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, gy + 8);
      ctx.lineTo(gx + rng.range(-4, 4), gy);
      ctx.stroke();
    }

    // Barbed-wire stakes every so often, for the period feel.
    if (rng.chance(0.45)) {
      const sx = x + rng.range(10, width - 10);
      ctx.strokeStyle = '#4a4a3c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx, GROUND_Y + 4);
      ctx.lineTo(sx - 4, GROUND_Y - 34);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(200, 200, 190, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 4, GROUND_Y - 30);
      ctx.lineTo(sx - 40, GROUND_Y - 22);
      ctx.stroke();
    }
  }
}
