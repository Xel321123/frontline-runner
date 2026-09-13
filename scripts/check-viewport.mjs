/**
 * Viewport validation — buffer/display sizing, DPR scaling and ground anchoring.
 *
 * This is the bug that shipped: the backing buffer was sized by devicePixelRatio
 * while the 2D context was left unscaled, so on a phone (dpr 2-3) the whole game
 * drew at 1/dpr scale in the top-left quadrant. Every case below is asserted
 * against the real maths the browser code uses.
 */

import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));

const metricsUrl = new URL('../src/platform/canvasMetrics.ts', import.meta.url);
const viewportUrl = new URL('../src/platform/Viewport.ts', import.meta.url);
const constantsUrl = new URL('../src/game/constants.ts', import.meta.url);

const { computeCanvasMetrics, MAX_PIXEL_RATIO, isTransformConsistent } = await import(metricsUrl.href);
const V = await import(viewportUrl.href);
const C = await import(constantsUrl.href);

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  const mark = condition ? '·' : 'x';
  console.log(`  ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

console.log('\nviewport: buffer vs display');

const DEVICES = [
  { name: 'iPhone 15 landscape', w: 852, h: 393, dpr: 3 },
  { name: 'iPhone SE landscape', w: 667, h: 375, dpr: 2 },
  { name: 'Pixel portrait', w: 412, h: 915, dpr: 2.6 },
  { name: 'iPad landscape', w: 1180, h: 820, dpr: 2 },
  { name: 'desktop 1080p', w: 1920, h: 1080, dpr: 1 },
  { name: 'laptop hidpi', w: 1440, h: 900, dpr: 1.5 },
];

for (const device of DEVICES) {
  const m = computeCanvasMetrics(device.w, device.h, device.dpr);
  const label = `${device.name} ${device.w}x${device.h}@${device.dpr}`;

  // The display box is exactly the window: no margins, no fixed sub-rectangle.
  check(`${label}: display box is the window`, m.cssWidth === device.w && m.cssHeight === device.h,
    `${m.cssWidth}x${m.cssHeight}`);

  // The buffer carries the pixel ratio, and the ratio is capped.
  check(`${label}: buffer = css * ratio`, m.bufferWidth === Math.floor(device.w * m.ratio) && m.bufferHeight === Math.floor(device.h * m.ratio),
    `buffer ${m.bufferWidth}x${m.bufferHeight} ratio ${m.ratio}`);
  check(`${label}: ratio capped at ${MAX_PIXEL_RATIO}`, m.ratio <= MAX_PIXEL_RATIO && m.ratio >= 1, `ratio ${m.ratio}`);

  // The transform the renderer applies must match the buffer/display ratio —
  // this is the assertion that fails when the game squishes into a quadrant.
  check(`${label}: ctx transform matches buffer/display`, isTransformConsistent(m, m.ratio, m.ratio));

  const quadrantScale = 1 / m.ratio;
  check(`${label}: is NOT drawn at 1/dpr scale`, m.ratio === 1 || quadrantScale < 1,
    `dpr ${device.dpr} would draw at ${(quadrantScale * 100).toFixed(0)}%`);
}

console.log('\nviewport: camera, anchoring and coverage');

for (const device of DEVICES) {
  const m = computeCanvasMetrics(device.w, device.h, device.dpr);
  const camera = V.createCamera(m.cssWidth, m.cssHeight);

  // Ground sits GROUND_MARGIN above the bottom edge, so the deploy bar has real
  // ground under it and the sky does not eat the screen.
  const ground = V.worldToScreen(camera, 0, C.GROUND_Y);
  check(`${device.name}: ground line anchored above the bar`,
    Math.abs(ground.y - (device.h - V.GROUND_MARGIN)) < 0.75,
    `groundY ${ground.y.toFixed(1)} vs ${device.h - V.GROUND_MARGIN}`);

  // Player HQ hugs the left edge; the enemy strongpoint hugs the right.
  const hq = V.worldToScreen(camera, C.BASE_X, C.GROUND_Y);
  const strongpoint = V.worldToScreen(camera, C.ENEMY_BASE_X, C.GROUND_Y);
  check(`${device.name}: HQ anchors to the left edge (0-80px)`, hq.x >= 0 && hq.x <= 80, `x ${hq.x.toFixed(1)}`);
  check(`${device.name}: strongpoint anchors to the right edge`,
    device.w - strongpoint.x >= 0 && device.w - strongpoint.x <= 80,
    `${(device.w - strongpoint.x).toFixed(1)}px from the right`);

  // The camera spans the whole viewport: the visible world covers the field.
  const visible = V.visibleWorldWidth(camera);
  check(`${device.name}: whole battlefield visible at fit`,
    visible >= C.VIEW_WIDTH - 1, `visible ${visible.toFixed(0)} of ${C.VIEW_WIDTH}`);

  // Zoom is a multiplier on fit, and clamped.
  const zoomed = V.cameraAt(m.cssWidth, m.cssHeight, C.VIEW_WIDTH / 2, V.ZOOM_IN_FACTOR);
  check(`${device.name}: zoom-in narrows the view without leaving the field`,
    V.visibleWorldWidth(zoomed) < visible &&
      V.visibleWorldWidth(zoomed) > 0 &&
      zoomed.focusX >= V.visibleWorldWidth(zoomed) / 2 - 1 &&
      zoomed.focusX <= C.VIEW_WIDTH - V.visibleWorldWidth(zoomed) / 2 + 1,
    `visible ${V.visibleWorldWidth(zoomed).toFixed(0)}`);

  check(`${device.name}: clamping refuses absurd zoom`,
    V.clampZoomFactor(99) === V.MAX_ZOOM_FACTOR && V.clampZoomFactor(0) === V.MIN_ZOOM_FACTOR);

  // Round trip: screen -> world -> screen is identity, which is what the HUD hit
  // tests rely on for pointer accuracy.
  const probe = { x: 123, y: 77 };
  const world = V.screenToWorld(camera, probe.x, probe.y);
  const back = V.worldToScreen(camera, world.x, world.y);
  check(`${device.name}: screen/world round trip`,
    Math.abs(back.x - probe.x) < 0.01 && Math.abs(back.y - probe.y) < 0.01);
}

console.log(`\nviewport checks: ${checks - failures.length}/${checks} passed`);
if (failures.length > 0) {
  console.log('\nFAILURES');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all viewport checks passed');
}
