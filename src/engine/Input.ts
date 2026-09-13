/**
 * Input — pointer, drag and keyboard for a full-bleed touch viewport.
 *
 * The canvas fills the window, so canvas-relative CSS pixels are the natural
 * coordinate space for both the HUD (which is drawn on the canvas) and for
 * panning. This layer reports three things and makes no decisions:
 *
 *   pointer   where the finger/cursor is, in canvas CSS pixels;
 *   taps      press-release pairs that did not turn into a pan;
 *   drags     accumulated movement since the last frame, in CSS pixels.
 *
 * A gesture that starts over a HUD control is still reported as a tap — the
 * caller decides, because only it knows the layout.
 */

export interface PointerSample {
  readonly x: number;
  readonly y: number;
}

export interface BattleInput {
  /** Latest pointer position, or null when the pointer is off-canvas. */
  readonly pointer: PointerSample | null;
  /** True between pointerdown and pointerup. */
  readonly pressing: boolean;
  /** Movement accumulated since the previous call, in CSS pixels. */
  takeDrag(): { readonly dx: number; readonly dy: number } | null;
  /** A press that ended without panning, in canvas CSS pixels. */
  takeTap(): PointerSample | null;
  /** Normalised keys pressed since the previous call. */
  takeKeys(): readonly string[];
  reset(): void;
  dispose(): void;
}

export interface BattleInputOptions {
  readonly element: HTMLElement;
  /** Fired on the first real interaction — used to unlock audio. */
  readonly onFirstGesture?: () => void;
  /** Movement past this many CSS pixels turns a press into a pan. */
  readonly tapSlop?: number;
}

export function createBattleInput(options: BattleInputOptions): BattleInput {
  const element = options.element;
  const tapSlop = options.tapSlop ?? 12;

  let pointer: PointerSample | null = null;
  let pressing = false;
  let startX = 0;
  let startY = 0;
  let movedX = 0;
  let movedY = 0;
  let panned = false;
  let tap: PointerSample | null = null;
  let queuedDragX = 0;
  let queuedDragY = 0;
  let hasDrag = false;
  const keys: string[] = [];
  let gestured = false;

  function localPoint(event: PointerEvent | MouseEvent): PointerSample {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function notifyGesture(): void {
    if (gestured) return;
    gestured = true;
    options.onFirstGesture?.();
  }

  const onPointerDown = (event: PointerEvent): void => {
    notifyGesture();
    // First pointer wins; extra fingers are ignored so a resting thumb is safe.
    if (pressing) return;
    pressing = true;
    panned = false;
    pointer = localPoint(event);
    startX = pointer.x;
    startY = pointer.y;
    movedX = 0;
    movedY = 0;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety; the game keeps working without it */
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const at = localPoint(event);
    const dx = at.x - (pointer?.x ?? at.x);
    const dy = at.y - (pointer?.y ?? at.y);
    pointer = at;
    if (!pressing) return;
    // Deltas are measured from the previous sample rather than read off
    // `movementX`: that property is zero for synthetic events and is not
    // reliable across pointer types.
    movedX += dx;
    movedY += dy;
    queuedDragX += dx;
    queuedDragY += dy;
    hasDrag = true;
    const travelled = Math.hypot(at.x - startX, at.y - startY);
    if (travelled > tapSlop) panned = true;
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!pressing) return;
    pressing = false;
    const at = localPoint(event);
    pointer = at;
    if (!panned) tap = at;
    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  const onPointerLeave = (): void => {
    if (!pressing) pointer = null;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    notifyGesture();
    keys.push(event.key);
    if (keys.length > 8) keys.shift();
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('keydown', onKeyDown);

  return {
    get pointer() {
      return pointer;
    },
    get pressing() {
      return pressing;
    },
    takeDrag() {
      if (!hasDrag) return null;
      const delta = { dx: queuedDragX, dy: queuedDragY };
      queuedDragX = 0;
      queuedDragY = 0;
      hasDrag = false;
      return delta;
    },
    takeTap() {
      const taken = tap;
      tap = null;
      return taken;
    },
    takeKeys() {
      if (keys.length === 0) return [];
      return keys.splice(0, keys.length);
    },
    reset() {
      tap = null;
      queuedDragX = 0;
      queuedDragY = 0;
      hasDrag = false;
      keys.length = 0;
    },
    dispose() {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
