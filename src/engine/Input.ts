/**
 * Input — vertical pointer/drag control.
 *
 * The squad only moves on the Y axis, so the pointer's Y position (mapped into
 * the fixed 1280x720 logical space) is the entire control surface:
 *
 *   - touch / pen : press and drag, the target follows the finger
 *   - mouse       : hover follows too (no button needed), which feels right on
 *                   desktop; pressing still works
 *   - keyboard    : ArrowUp/ArrowDown or W/S as an equivalent path, so the game
 *                   is playable and testable without a pointer
 *
 * Input deliberately reports a *target* only. The smoothing (lerp) that turns
 * that target into motion lives in the simulation, which keeps the game
 * deterministic and headless-testable.
 */

import type { GameViewport } from '../platform/Viewport';
import { clamp, clientToLogical } from '../platform/Viewport';

export type PointerMode = 'pointer' | 'keyboard';

export interface InputOptions {
  /** Element that receives the pointer events — the game canvas. */
  readonly element: HTMLElement;
  /** Logical viewport, refreshed by the caller on resize. */
  readonly getViewport: () => GameViewport;
  /** Vertical limits for the target, in logical units. */
  readonly minY: number;
  readonly maxY: number;
  /** Starting target. */
  readonly initialY: number;
  /** Keyboard speed in logical units per second. */
  readonly keyboardSpeed?: number;
}

export interface InputState {
  readonly targetY: number;
  readonly mode: PointerMode;
  readonly isPointerDown: boolean;
}

const DEFAULT_KEYBOARD_SPEED = 640;

export class VerticalInput {
  private readonly options: InputOptions;
  private readonly keyboardSpeed: number;

  private targetYValue: number;
  private mode: PointerMode = 'pointer';
  private pointerDown = false;
  private activePointerId: number | null = null;

  private readonly pressed = new Set<string>();
  private disposed = false;

  constructor(options: InputOptions) {
    this.options = options;
    this.keyboardSpeed = options.keyboardSpeed ?? DEFAULT_KEYBOARD_SPEED;
    this.targetYValue = clamp(options.initialY, options.minY, options.maxY);

    const element = options.element;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('pointerleave', this.onPointerLeave);
    element.addEventListener('contextmenu', this.preventDefault);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  get state(): InputState {
    return { targetY: this.targetYValue, mode: this.mode, isPointerDown: this.pointerDown };
  }

  get targetY(): number {
    return this.targetYValue;
  }

  /** Advance keyboard-driven movement. Call once per frame with the frame dt. */
  update(dt: number): void {
    if (this.pressed.size === 0) return;
    let direction = 0;
    if (this.pressed.has('ArrowUp') || this.pressed.has('w') || this.pressed.has('W')) direction -= 1;
    if (this.pressed.has('ArrowDown') || this.pressed.has('s') || this.pressed.has('S')) direction += 1;
    if (direction === 0) return;
    this.mode = 'keyboard';
    this.setTarget(this.targetYValue + direction * this.keyboardSpeed * dt);
  }

  /** Snap the target without any smoothing (used on start/restart). */
  reset(y: number): void {
    this.targetYValue = clamp(y, this.options.minY, this.options.maxY);
    this.pressed.clear();
    this.mode = 'pointer';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const element = this.options.element;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerUp);
    element.removeEventListener('pointerleave', this.onPointerLeave);
    element.removeEventListener('contextmenu', this.preventDefault);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private setTarget(value: number): void {
    this.targetYValue = clamp(value, this.options.minY, this.options.maxY);
  }

  private setTargetFromEvent(event: PointerEvent): void {
    const rect = this.options.element.getBoundingClientRect();
    const point = clientToLogical(event.clientX, event.clientY, rect, this.options.getViewport());
    this.mode = 'pointer';
    this.setTarget(point.y);
  }

  private readonly preventDefault = (event: Event): void => {
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = true;
    this.activePointerId = event.pointerId;
    // Capture so a drag that leaves the canvas keeps steering the squad.
    try {
      this.options.element.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort */
    }
    this.setTargetFromEvent(event);
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const isActivePointer = this.activePointerId === event.pointerId;
    // Mouse steers on hover; touch and pen steer only while pressed.
    const hoverSteers = event.pointerType === 'mouse';
    if (!isActivePointer && !hoverSteers) return;
    this.setTargetFromEvent(event);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pointerDown && this.activePointerId === event.pointerId) {
      this.pointerDown = false;
      this.activePointerId = null;
      try {
        this.options.element.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.pointerDown) return;
    // Leaving with the mouse just stops steering; the squad holds its lane.
    this.activePointerId = null;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.pressed.add(event.key);
    if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight'
    ) {
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.key);
  };

  private readonly onBlur = (): void => {
    this.pressed.clear();
    this.pointerDown = false;
    this.activePointerId = null;
  };
}

export function createVerticalInput(options: InputOptions): VerticalInput {
  return new VerticalInput(options);
}
