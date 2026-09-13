/**
 * Input — pointer and keyboard for the deployment bar.
 *
 * The battle has no analogue control: the player presses buttons. So this layer
 * reports *positions* (mapped into the fixed 1280x720 logical space, so the
 * HUD hit-tests line up exactly with what the renderer draws) and *edges*
 * (presses and key events) — and nothing else. All hit-testing and policy lives
 * in the app layer, which keeps this file dumb and the game loop testable.
 *
 * Keyboard equivalents are always present: 1-4 deploy, U buys logistics,
 * P pauses. That makes the game playable without a pointer and scriptable for
 * verification.
 */

import { clientToLogical, type GameViewport } from '../platform/Viewport';

export interface PointerState {
  readonly x: number;
  readonly y: number;
}

export interface BattleInput {
  /** Latest pointer position in logical coordinates, or null if never seen. */
  readonly pointer: PointerState | null;
  /** True while a pointer button is held. */
  readonly pressed: boolean;
  /** Consume the most recent press, if any (edge-triggered). */
  takePress(): PointerState | null;
  /** Consume queued key presses, in order (edge-triggered). */
  takeKeys(): readonly string[];
  reset(): void;
  dispose(): void;
}

export interface BattleInputOptions {
  readonly element: HTMLElement;
  /** Must be the same letterbox maths the renderer uses. */
  readonly getViewport: () => GameViewport;
}

export function createBattleInput(options: BattleInputOptions): BattleInput {
  const { element, getViewport } = options;
  const rect = () => element.getBoundingClientRect();

  let pointer: PointerState | null = null;
  let pendingPress: PointerState | null = null;
  let keys: string[] = [];
  let held = false;

  const toLogical = (clientX: number, clientY: number): PointerState =>
    clientToLogical(clientX, clientY, rect(), getViewport());

  const onPointerMove = (event: PointerEvent): void => {
    const next = toLogical(event.clientX, event.clientY);
    pointer = next;
    // A drag that started on the canvas keeps reporting position off-canvas.
    if (held) pendingPress = next;
  };

  const onPointerDown = (event: PointerEvent): void => {
    held = true;
    const next = toLogical(event.clientX, event.clientY);
    pointer = next;
    pendingPress = next;
    element.setPointerCapture?.(event.pointerId);
  };

  const onPointerUp = (event: PointerEvent): void => {
    held = false;
    element.releasePointerCapture?.(event.pointerId);
  };

  const onPointerLeave = (): void => {
    if (!held) pointer = null;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    if (key.length === 1 || key === 'escape') {
      keys.push(key);
      if (key !== 'escape') event.preventDefault();
    }
  };

  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('keydown', onKeyDown);

  return {
    get pointer() {
      return pointer;
    },
    get pressed() {
      return held;
    },
    takePress() {
      const press = pendingPress;
      pendingPress = null;
      return press;
    },
    takeKeys() {
      if (keys.length === 0) return [];
      const drained = keys;
      keys = [];
      return drained;
    },
    reset() {
      pointer = null;
      pendingPress = null;
      keys = [];
      held = false;
    },
    dispose() {
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
