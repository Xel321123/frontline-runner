/**
 * Web/PWA entry point.
 *
 * The only file that knows it is running in a browser. A Capacitor build would
 * call `startShell` from its own entry after `Capacitor` setup — see
 * `docs/NATIVE_PORTABILITY.md`.
 */

import './style.css';
import { startShell } from './app/shell';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('#app container is missing from index.html');
}

// A landscape runner has no sensible portrait layout: tell the user instead of
// rendering a broken canvas.
function syncOrientationNotice(): void {
  document.body.classList.toggle('portrait', window.innerHeight > window.innerWidth);
}

syncOrientationNotice();
window.addEventListener('resize', syncOrientationNotice);
window.addEventListener('orientationchange', syncOrientationNotice);

startShell(root).catch((error: unknown) => {
  console.error('[boot] failed', error);
  root.innerHTML = `<div class="fatal"><h1>Boot failed</h1><pre>${String(
    error instanceof Error ? error.stack ?? error.message : error,
  )}</pre></div>`;
});
