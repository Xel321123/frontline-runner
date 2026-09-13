/**
 * HUD layout — computed from the *actual* canvas size, in CSS pixels.
 *
 * The battle HUD is drawn on the canvas and everything is overlaid on top of
 * the game: no DOM panels eat vertical space, so the battlefield gets the whole
 * screen. Because the canvas fills the window at any aspect ratio, the layout
 * has to be derived from the viewport rather than baked to 1280x720 — this
 * module is that derivation, and it is a pure function so the renderer can draw
 * a card in exactly the rectangle the input layer hit-tests.
 *
 * Sizing rules of thumb:
 * - deploy cards are thumb-sized: at least ~84px wide and ~64px tall, growing
 *   with the screen so a tablet gets generous targets rather than tiny ones;
 * - the dock hugs the bottom edge, inside the safe area, so it can be reached
 *   with a thumb while holding the phone in landscape;
 * - readouts (health, supplies, clock) are pills across the top, translucent,
 *   so the sky shows through.
 */

import type { UnitKind } from './units';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DeploySlotLayout {
  readonly kind: UnitKind;
  readonly hotkey: string;
  readonly rect: Rect;
  /** Centre of the unit portrait inside the card. */
  readonly iconX: number;
  readonly iconY: number;
  readonly iconScale: number;
}

export interface HudLayout {
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** UI scale derived from the viewport; 1.0 ≈ a 430px-tall window. */
  readonly scale: number;
  /** True on touch-first devices: keyboard hints are suppressed. */
  readonly touch: boolean;
  readonly topBarHeight: number;
  readonly dockHeight: number;
  /** Outer padding used by the dock and top overlay. */
  readonly pad: number;
  readonly slots: readonly DeploySlotLayout[];
  readonly logistics: Rect;
  /** Recorder/recenter button, sitting above the logistics card. */
  readonly recenter: Rect;
  readonly zoom: Rect;
  readonly pause: Rect;
  readonly exit: Rect;
  readonly playerBar: Rect;
  readonly enemyBar: Rect;
  /** Objective + weather line, under the top pills. */
  readonly statusLineY: number;
  /** Where the floating "deployment" totals sit. */
  readonly statsLineY: number;
}

export const HOTKEYS: Readonly<Record<UnitKind, string>> = {
  rifleman: '1',
  smg: '2',
  mg: '3',
  tank: '4',
};

const DEPLOY_ORDER: readonly UnitKind[] = ['rifleman', 'smg', 'mg', 'tank'];

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * Lay the HUD out for a viewport. Everything scales from the short edge so a
 * phone in landscape gets bigger, closer controls than the same code on a
 * monitor at the same pixel height.
 */
export function computeHudLayout(cssWidth: number, cssHeight: number, touch: boolean): HudLayout {
  const w = Math.max(320, Math.floor(cssWidth));
  const h = Math.max(240, Math.floor(cssHeight));
  // Short-edge driven UI scale. Phones in landscape are ~390-430 tall, so this
  // lands near 1.0 there and grows on tablets/desktop, capped so it stays sane.
  const scale = Math.min(1.6, Math.max(0.78, h / 430));

  const pad = Math.round(10 * scale);
  const dockHeight = Math.round(Math.min(168, Math.max(84, 104 * scale)));
  const dockY = h - dockHeight;
  const topBarHeight = Math.round(Math.max(34, 44 * scale));

  // --- bottom dock: four deploy cards + the logistics card ------------------
  const gap = Math.round(8 * scale);
  const logisticsW = Math.round(Math.min(230, Math.max(112, w * 0.17)));
  const cardsSpan = w - pad * 2 - logisticsW - gap;
  const cardW = Math.round(
    Math.min(210, Math.max(74, (cardsSpan - gap * (DEPLOY_ORDER.length - 1)) / DEPLOY_ORDER.length)),
  );
  const cardH = dockHeight - pad * 2;
  const slots: DeploySlotLayout[] = DEPLOY_ORDER.map((kind, index) => {
    const x = pad + index * (cardW + gap);
    return {
      kind,
      hotkey: HOTKEYS[kind],
      rect: rect(x, dockY + pad, cardW, cardH),
      iconX: x + cardW / 2,
      iconY: dockY + pad + Math.round(cardH * 0.46),
      iconScale: Math.min(1.5, Math.max(0.62, (cardH / 88) * 1.05)),
    };
  });

  const logistics = rect(
    w - pad - logisticsW,
    dockY + pad,
    logisticsW,
    cardH,
  );

  // --- top overlay ----------------------------------------------------------
  const barW = Math.round(Math.min(w * 0.3, 260 * scale));
  const barH = Math.round(Math.max(9, 13 * scale));
  const barY = Math.round(pad + 3);
  const playerBar = rect(pad, barY, barW, barH);
  const enemyBar = rect(w - pad - barW, barY, barW, barH);

  const controlSize = Math.round(Math.max(26, 32 * scale));
  // Clear of the health-bar labels, which sit under the bars.
  const controlY = barY + barH + Math.round(26 * scale);
  const exit = rect(w - pad - controlSize, controlY, controlSize, controlSize);
  const pause = rect(exit.x - controlSize - gap, controlY, controlSize, controlSize);
  const recenter = rect(
    logistics.x + logistics.w / 2 - controlSize / 2,
    dockY - controlSize - Math.round(6 * scale),
    controlSize,
    controlSize,
  );
  // Zoom sits to the left of recentre: field zoom is opt-in, fit is the default.
  const zoom = rect(recenter.x - controlSize - Math.round(8 * scale), recenter.y, controlSize, controlSize);

  return {
    cssWidth: w,
    cssHeight: h,
    scale,
    touch,
    topBarHeight,
    dockHeight,
    pad,
    slots,
    logistics,
    recenter,
    zoom,
    pause,
    exit,
    playerBar,
    enemyBar,
    statusLineY: barY + barH + Math.round(15 * scale),
    statsLineY: Math.round(pad + 3 + barH + 15 * scale),
  };
}

export function hitDeploy(layout: HudLayout, x: number, y: number): UnitKind | null {
  for (const slot of layout.slots) {
    if (rectContains(slot.rect, x, y)) return slot.kind;
  }
  return null;
}

export function hitLogistics(layout: HudLayout, x: number, y: number): boolean {
  return rectContains(layout.logistics, x, y);
}

export type HudControl = 'pause' | 'exit' | 'recenter' | 'zoom';

export function hitControl(layout: HudLayout, x: number, y: number): HudControl | null {
  if (rectContains(layout.pause, x, y)) return 'pause';
  if (rectContains(layout.exit, x, y)) return 'exit';
  if (rectContains(layout.recenter, x, y)) return 'recenter';
  if (rectContains(layout.zoom, x, y)) return 'zoom';
  return null;
}

/** True when a point is over any interactive HUD element (so it is not a pan). */
export function hitAnyControl(layout: HudLayout, x: number, y: number): boolean {
  return (
    hitDeploy(layout, x, y) !== null ||
    hitLogistics(layout, x, y) ||
    hitControl(layout, x, y) !== null
  );
}

/** Which unit a keyboard hotkey deploys. */
export function kindForHotkey(key: string): UnitKind | null {
  for (const [kind, hotkey] of Object.entries(HOTKEYS) as [UnitKind, string][]) {
    if (hotkey === key) return kind;
  }
  return null;
}
