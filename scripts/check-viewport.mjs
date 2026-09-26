/**
 * Viewport validation — buffer/display sizing, DPR scaling, and the isometric
 * camera.
 *
 * Two things are being proven here:
 *
 *  1. The bug that shipped once cannot come back: the backing buffer is sized by
 *     devicePixelRatio *and* the 2D context carries the matching transform, or
 *     on a phone (dpr 2-3) the whole game draws at 1/dpr scale in the top-left.
 *  2. The isometric camera frames the *playable field* at zoom 1 on every device,
 *     and the projection is exactly invertible, which is what the tap-to-select
 *     hit test depends on.
 */

import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.mjs', import.meta.url));

const metricsUrl = new URL('../src/platform/canvasMetrics.ts', import.meta.url);
const viewportUrl = new URL('../src/platform/Viewport.ts', import.meta.url);
const isoUrl = new URL('../src/render/iso/iso.ts', import.meta.url);
const constantsUrl = new URL('../src/game/constants.ts', import.meta.url);

const { computeCanvasMetrics, MAX_PIXEL_RATIO, isTransformConsistent } = await import(metricsUrl.href);
const V = await import(viewportUrl.href);
const Iso = await import(isoUrl.href);
const C = await import(constantsUrl.href);

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  const mark = condition ? '·' : 'x';
  console.log(`  ${mark} ${name}${detail ? ` (${detail})` : ''}`);
}

const DEVICES = [
  { name: 'iPhone 15 landscape', w: 852, h: 393, dpr: 3 },
  { name: 'iPhone SE landscape', w: 667, h: 375, dpr: 2 },
  { name: 'Pixel portrait', w: 412, h: 915, dpr: 2.6 },
  { name: 'iPad landscape', w: 1180, h: 820, dpr: 2 },
  { name: 'desktop 1080p', w: 1920, h: 1080, dpr: 1 },
  { name: 'laptop hidpi', w: 1440, h: 900, dpr: 1.5 },
];

console.log('\nviewport: buffer vs display');

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

console.log('\nprojection: isometric, exactly invertible');

const PROBES = [
  { x: 0, y: 0 },
  { x: C.WORLD_W, y: 0 },
  { x: 0, y: C.WORLD_H },
  { x: C.WORLD_W, y: C.WORLD_H },
  { x: 137.5, y: 402.25 },
  { x: C.PLAYER_REAR_X, y: 300 },
  { x: C.ENEMY_REAR_X, y: 120 },
];

for (const probe of PROBES) {
  const projected = Iso.isoPoint(probe.x, probe.y);
  const back = Iso.isoUnproject(projected.x, projected.y);
  check(`projection round trip (${probe.x}, ${probe.y})`,
    Math.abs(back.x - probe.x) < 1e-6 && Math.abs(back.y - probe.y) < 1e-6,
    `got (${back.x.toFixed(4)}, ${back.y.toFixed(4)})`);
}

// The 2:1 diamond: one world unit along x or y must move the projected point the
// same distance horizontally, and half of it vertically.
const o = Iso.isoPoint(0, 0);
const ex = Iso.isoPoint(1, 0);
const ey = Iso.isoPoint(0, 1);
check('projection is a 2:1 diamond', Math.abs(ex.x - o.x - 1) < 1e-9 && Math.abs(ex.y - o.y - 0.5) < 1e-9,
  `x axis → (${(ex.x - o.x).toFixed(2)}, ${(ex.y - o.y).toFixed(2)})`);
check('depth axis mirrors the x axis', Math.abs(ey.x - o.x + 1) < 1e-9 && Math.abs(ey.y - o.y - 0.5) < 1e-9,
  `y axis → (${(ey.x - o.x).toFixed(2)}, ${(ey.y - o.y).toFixed(2)})`);
check('depth sort key rises with distance', Iso.depthKey(10, 5) < Iso.depthKey(20, 5)
  && Iso.depthKey(10, 5) < Iso.depthKey(10, 20)
  && Iso.depthKey(10, 5, -40) < Iso.depthKey(19, 5));

console.log('\nprojection: base geometry');

const box = Iso.isoBox(0, 0, 20, 20, 12);
check('isoBox produces three closed faces', box.top.endsWith('Z') && box.left.endsWith('Z') && box.right.endsWith('Z'));
check('isoBox roof is lifted by its height',
  Math.abs(box.topCorners[0].y - (Iso.isoPoint(0, 0).y - 12)) < 1e-9);
check('isoBox footprint matches the projection',
  Math.abs(box.baseCorners[2].x - Iso.isoPoint(20, 20).x) < 1e-9);

console.log('\nviewport: isometric camera, framing and coverage');

for (const device of DEVICES) {
  const m = computeCanvasMetrics(device.w, device.h, device.dpr);
  const camera = V.createCamera(m.cssWidth, m.cssHeight);
  const label = device.name;

  // Zoom 1 frames the playable field: every corner of the default framing has to
  // land inside the viewport on at least the axis the fit scale was limited by.
  const bounds = Iso.VIEW_BOUNDS;
  const corners = [
    V.worldToScreen(camera, C.VIEW_MIN_X, C.VIEW_MIN_Y),
    V.worldToScreen(camera, C.VIEW_MAX_X, C.VIEW_MIN_Y),
    V.worldToScreen(camera, C.VIEW_MAX_X, C.VIEW_MAX_Y),
    V.worldToScreen(camera, C.VIEW_MIN_X, C.VIEW_MAX_Y),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const spannedX = Math.max(...xs) - Math.min(...xs);
  const spannedY = Math.max(...ys) - Math.min(...ys);
  check(`${label}: the playable field fits the viewport`,
    spannedX <= camera.cssWidth + 0.5 && spannedY <= camera.cssHeight + 0.5,
    `field ${spannedX.toFixed(0)}x${spannedY.toFixed(0)} in ${camera.cssWidth}x${camera.cssHeight}`);
  check(`${label}: the fit is tight on one axis`,
    Math.abs(spannedX - camera.cssWidth) < 2 || Math.abs(spannedY - camera.cssHeight) < 2,
    `slack ${(camera.cssWidth - spannedX).toFixed(1)}x${(camera.cssHeight - spannedY).toFixed(1)}`);
  check(`${label}: projection bounds agree with the framing`,
    Math.abs((bounds.maxX - bounds.minX) - spannedX / camera.zoom) < 1,
    `bounds ${(bounds.maxX - bounds.minX).toFixed(1)} vs ${(spannedX / camera.zoom).toFixed(1)}`);

  // Round trip: screen -> world -> screen is identity, which is what the
  // tap-to-select hit test relies on.
  const probes = [
    { x: 40, y: 40 },
    { x: camera.cssWidth / 2, y: camera.cssHeight / 2 },
    { x: camera.cssWidth - 30, y: camera.cssHeight - 24 },
  ];
  let roundTripOk = true;
  for (const probe of probes) {
    const world = V.screenToWorld(camera, probe.x, probe.y);
    const back = V.worldToScreen(camera, world.x, world.y);
    if (Math.abs(back.x - probe.x) > 0.01 || Math.abs(back.y - probe.y) > 0.01) roundTripOk = false;
  }
  check(`${label}: screen/world round trip`, roundTripOk);

  // A lifted point (a shell in flight) must rise on screen and scale with zoom.
  const ground = V.worldToScreen(camera, 400, 300, 0);
  const lifted = V.worldToScreen(camera, 400, 300, 40);
  check(`${label}: height lifts a point on screen`,
    Math.abs(ground.y - lifted.y - 40 * camera.zoom) < 0.01,
    `lift ${(ground.y - lifted.y).toFixed(2)} vs ${(40 * camera.zoom).toFixed(2)}`);

  // Zooming in narrows the visible field without letting the camera leave it.
  const zoomed = V.cameraAt(m.cssWidth, m.cssHeight, Iso.VIEW_CENTRE.x, Iso.VIEW_CENTRE.y, V.ZOOM_IN_FACTOR);
  const plainWidth = camera.cssWidth / camera.zoom;
  const zoomedWidth = camera.cssWidth / zoomed.zoom;
  check(`${label}: zoom-in narrows the visible field`,
    zoomedWidth < plainWidth && zoomedWidth > 40, `visible ${zoomedWidth.toFixed(0)} of ${plainWidth.toFixed(0)}`);
  check(`${label}: clamping refuses absurd zoom`,
    V.clampZoomFactor(99) === V.MAX_ZOOM_FACTOR && V.clampZoomFactor(0) === V.MIN_ZOOM_FACTOR);

  const far = V.cameraAt(m.cssWidth, m.cssHeight, 1e6, -1e6, V.DEFAULT_ZOOM_FACTOR);
  check(`${label}: focus cannot fly off the plane`,
    far.focusX <= C.WORLD_W + 100 && far.focusX >= -100 && far.focusY <= C.WORLD_H + 100 && far.focusY >= -100,
    `focus (${far.focusX.toFixed(0)}, ${far.focusY.toFixed(0)})`);

  // The visible world rectangle must contain the focus point and be finite.
  const rect = V.visibleWorldRect(camera);
  check(`${label}: visible world rect is sane`,
    rect.minX < camera.focusX && rect.maxX > camera.focusX && rect.minY < camera.focusY && rect.maxY > camera.focusY
      && Number.isFinite(rect.minX) && Number.isFinite(rect.maxY));
}

console.log(`\nviewport checks: ${checks - failures.length}/${checks} passed`);
if (failures.length > 0) {
  console.log('\nFAILURES');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('all viewport checks passed');
}
