/**
 * Tiny DOM helpers.
 *
 * Deliberately minimal: the UI is markup strings plus one delegated event
 * listener in `shell.ts`, so there is no framework and no virtual DOM to
 * reason about — and the markup functions stay trivially testable.
 */

export function mustFind<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`missing required element: ${selector}`);
  }
  return found as T;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `<p>` with class `fine`, or nothing when `text` is empty. */
export function fine(text: string): string {
  return text ? `<p class="fine">${escapeHtml(text)}</p>` : '';
}

export function setHtml(node: HTMLElement, html: string): void {
  node.innerHTML = html;
}

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

/** Format a count with thin separators, e.g. 12345 -> 12 345. */
export function formatNumber(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
