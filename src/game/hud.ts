/**
 * Deployment-bar and HUD geometry.
 *
 * Pure layout maths in the 1280x720 logical space, shared by the renderer and
 * by pointer hit-testing — so a button can never be drawn somewhere it cannot
 * be clicked. Costs come from `units.ts`, never from a second copy.
 */

import { UNIT_ORDER, unitStats, type UnitKind } from './units';
import { VIEW_HEIGHT, VIEW_WIDTH } from './constants';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const TOP_BAR_HEIGHT = 62;

const BAR_HEIGHT = 104;
const SLOT_W = 148;
const SLOT_H = 88;
const SLOT_GAP = 10;
const SLOT_LEFT = 22;
const BAR_TOP = VIEW_HEIGHT - BAR_HEIGHT;

export interface DeploySlot {
  readonly kind: UnitKind;
  readonly rect: Rect;
  /** Keyboard shortcut shown in the slot. */
  readonly hotkey: string;
}

export const DEPLOY_SLOTS: readonly DeploySlot[] = UNIT_ORDER.map((kind, index) => ({
  kind,
  hotkey: String(index + 1),
  rect: {
    x: SLOT_LEFT + index * (SLOT_W + SLOT_GAP),
    y: BAR_TOP + 10,
    w: SLOT_W,
    h: SLOT_H,
  },
}));

/** In-match logistics upgrade button, right of the deploy slots. */
export const LOGISTICS_RECT: Rect = {
  x: SLOT_LEFT + DEPLOY_SLOTS.length * (SLOT_W + SLOT_GAP) + 14,
  y: BAR_TOP + 10,
  w: 232,
  h: SLOT_H,
};

/** Live battlefield readout on the bottom right. */
export const READOUT_RECT: Rect = {
  x: LOGISTICS_RECT.x + LOGISTICS_RECT.w + 14,
  y: BAR_TOP + 10,
  w: VIEW_WIDTH - (LOGISTICS_RECT.x + LOGISTICS_RECT.w + 14) - SLOT_LEFT,
  h: SLOT_H,
};

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/** Which deploy slot is under the pointer, if any. */
export function slotAt(x: number, y: number): UnitKind | null {
  for (const slot of DEPLOY_SLOTS) {
    if (rectContains(slot.rect, x, y)) return slot.kind;
  }
  return null;
}

export function logisticsAt(x: number, y: number): boolean {
  return rectContains(LOGISTICS_RECT, x, y);
}

/** Keyboard shortcut ("1".."4") to a unit kind. */
export function kindForHotkey(key: string): UnitKind | null {
  const slot = DEPLOY_SLOTS.find((candidate) => candidate.hotkey === key);
  return slot ? slot.kind : null;
}

export function slotCost(kind: UnitKind): number {
  return unitStats(kind).cost;
}

/** Top bar holds the two base health bars, supplies, bonds and the clock. */
export const BASE_BAR_WIDTH = 340;
export const BASE_BAR_HEIGHT = 20;
