/**
 * Scattered battlefield props — the trees, rocks, ruins, walls and abandoned kit
 * that make the ground a place rather than a board.
 *
 * Every prop is SVG path data authored in **billboard space**: the origin is the
 * point where the prop touches the ground, `-y` is up and `+x` is right, and the
 * renderer has already placed the anchor at the projected position for the prop's
 * world coordinates. Ground-contact geometry (a wall's footprint, a haystack's
 * base, a ruin's floor slab) is drawn with `iso2`, a local 2:1 projection, so it
 * sits correctly in the isometric view, while foliage and damage are ordinary
 * upright shapes.
 *
 * One path set per kind serves all five environments: fills are `@token`s
 * resolved against a palette keyed by season, so a pine is snow-laden in the
 * Ardennes and dust-dry at El Alamein without a second set of paths. Variants —
 * size, lean, branch count, damage, which silhouette is drawn — come from the
 * `variant` hash the renderer derives per prop, never from `Math.random`, so a
 * sector scatters identically every time it is played.
 */

import type { Environment } from '../../data/campaignData';
import type { PropDrawOptions, PropKind } from './contracts';
import { drawShadow } from './common';
import { paintSprite, sh, type Palette, type Shape } from './paint';

// ---------------------------------------------------------------- palettes

/** Everything a prop can be made of, in one token space. */
interface PropPalette extends Palette {
  readonly leaf: string;
  readonly leafDark: string;
  readonly leafLight: string;
  readonly bark: string;
  readonly barkDark: string;
  readonly needle: string;
  readonly stone: string;
  readonly stoneDark: string;
  readonly stoneLight: string;
  readonly masonry: string;
  readonly masonryDark: string;
  readonly plank: string;
  readonly plankDark: string;
  readonly metal: string;
  readonly metalDark: string;
  readonly metalLight: string;
  readonly straw: string;
  readonly strawDark: string;
  readonly cloth: string;
  readonly rubble: string;
  readonly grass: string;
  readonly soot: string;
}

const TEMPERATE: PropPalette = {
  leaf: '#4d6b34',
  leafDark: '#335025',
  leafLight: '#69894a',
  bark: '#4a3826',
  barkDark: '#33261a',
  needle: '#37512f',
  stone: '#7d7a70',
  stoneDark: '#5a5851',
  stoneLight: '#94918a',
  masonry: '#8d8271',
  masonryDark: '#645b4c',
  plank: '#6d5a3c',
  plankDark: '#4b3d29',
  metal: '#4c5347',
  metalDark: '#31362f',
  metalLight: '#6a7263',
  straw: '#b39a5c',
  strawDark: '#8a7440',
  cloth: '#6d7245',
  rubble: '#8a8377',
  grass: '#5c7a3c',
  soot: '#2b2b28',
};

const SNOW: PropPalette = {
  ...TEMPERATE,
  leaf: '#4a5b48',
  leafDark: '#334236',
  leafLight: '#6d7a67',
  needle: '#2f4234',
  straw: '#9c8f6c',
  grass: '#6b7a63',
  cloth: '#7e8574',
  masonry: '#9a9c9c',
};

const DESERT: PropPalette = {
  ...TEMPERATE,
  leaf: '#5f6b39',
  leafDark: '#454f28',
  leafLight: '#7d8850',
  needle: '#4c5c33',
  bark: '#7a6340',
  barkDark: '#5b492c',
  stone: '#a99572',
  stoneDark: '#84714f',
  stoneLight: '#c4b08a',
  masonry: '#b3a181',
  masonryDark: '#87775c',
  straw: '#c2a869',
  strawDark: '#9c854c',
  rubble: '#ab9a7c',
  grass: '#8a8a52',
};

const MUD: PropPalette = {
  ...TEMPERATE,
  leaf: '#3f4a2b',
  leafDark: '#2b3320',
  leafLight: '#54603a',
  bark: '#3d3122',
  barkDark: '#282018',
  stone: '#615f58',
  stoneDark: '#454440',
  stoneLight: '#78766d',
  masonry: '#6d6659',
  masonryDark: '#4e483e',
  straw: '#8f7c4c',
  grass: '#4c5c31',
  soot: '#232321',
};

/** Night is genuinely darker rather than tinted: a filter over the whole scene
 * would lift the props back up again when the beam sweep passes. */
const NIGHT: PropPalette = {
  leaf: '#26361f',
  leafDark: '#1a2416',
  leafLight: '#34452b',
  bark: '#241c14',
  barkDark: '#16110c',
  needle: '#1d2c1e',
  stone: '#3f4145',
  stoneDark: '#2b2d31',
  stoneLight: '#4e5156',
  masonry: '#454753',
  masonryDark: '#2f3138',
  plank: '#31281c',
  plankDark: '#201a12',
  metal: '#282c30',
  metalDark: '#1a1d20',
  metalLight: '#3a4046',
  straw: '#5b4f31',
  strawDark: '#413922',
  cloth: '#343a30',
  rubble: '#44464a',
  grass: '#28331f',
  soot: '#141514',
};

const PALETTES: Readonly<Record<Environment, PropPalette>> = {
  standard: TEMPERATE,
  snow: SNOW,
  desert: DESERT,
  mud: MUD,
  night: NIGHT,
};

// --------------------------------------------------------------- primitives

/** Local 2:1 isometric projection, for geometry that lies on the ground. */
function iso2(u: number, v: number): { x: number; y: number } {
  return { x: u - v, y: (u + v) * 0.5 };
}

function poly(points: readonly { x: number; y: number }[], close = true): string {
  const head = points[0];
  if (!head) return '';
  let d = `M${round(head.x)} ${round(head.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point) d += `L${round(point.x)} ${round(point.y)}`;
  }
  return close ? `${d}Z` : d;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Footprint of a box standing on the ground, plus the two visible walls. */
function isoBoxLocal(
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  h: number,
  top: string,
  sideA: string,
  sideB: string,
): readonly Shape[] {
  const a = iso2(u0, v0);
  const b = iso2(u1, v0);
  const c = iso2(u1, v1);
  const d = iso2(u0, v1);
  const lift = (point: { x: number; y: number }): { x: number; y: number } => ({
    x: point.x,
    y: point.y - h,
  });
  const at = lift(a);
  const bt = lift(b);
  const ct = lift(c);
  const dt = lift(d);
  return [
    sh(poly([at, bt, ct, dt]), top),
    sh(poly([b, c, ct, bt]), sideA),
    sh(poly([d, c, ct, dt]), sideB),
  ];
}

/** A rounded natural mass (canopy, bush, rock) from a circle-ish path. */
function blob(cx: number, cy: number, rx: number, ry: number, wobble: number): string {
  const points = 7;
  let d = '';
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * Math.PI * 2;
    const k = 1 + Math.sin(angle * 3 + wobble) * 0.12;
    const x = cx + Math.cos(angle) * rx * k;
    const y = cy + Math.sin(angle) * ry * k;
    d += `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`;
  }
  return `${d}Z`;
}

function shake(variant: number, index: number): number {
  // A cheap hash: the same prop always leans the same way, at any frame rate.
  const value = Math.sin((variant * 977 + index * 131) * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

// ------------------------------------------------------------------- kinds

/** Broadleaf: trunk, branches, and a canopy of overlapping leaf masses. */
function tree(o: PropDrawOptions, size: number): readonly Shape[] {
  const trunkH = size * 0.46;
  const shapes: Shape[] = [
    sh(`M-2.4 0L2.4 0L1.6 ${round(-trunkH)}L-1.6 ${round(-trunkH)}Z`, '@bark'),
    sh(`M-0.6 0L2.4 0L1.6 ${round(-trunkH)}L0.6 ${round(-trunkH)}Z`, '@barkDark', { opacity: 0.6 }),
    sh(`M0 ${round(-trunkH * 0.62)}L${round(size * 0.16)} ${round(-trunkH * 0.92)}`, '@bark', {
      stroke: '@bark',
      strokeWidth: 2.2,
      lineCap: 'round',
    }),
    sh(`M0 ${round(-trunkH * 0.74)}L${round(-size * 0.14)} ${round(-trunkH * 1.02)}`, '@barkDark', {
      stroke: '@barkDark',
      strokeWidth: 1.6,
      lineCap: 'round',
    }),
  ];
  const canopyY = -trunkH - size * 0.22;
  const wobble = shake(o.variant, 2) * 6;
  shapes.push(
    sh(blob(-size * 0.2, canopyY + size * 0.06, size * 0.3, size * 0.24, wobble), '@leafDark'),
    sh(blob(size * 0.22, canopyY + size * 0.1, size * 0.26, size * 0.22, wobble + 2), '@leafDark'),
    sh(blob(0, canopyY - size * 0.1, size * 0.3, size * 0.26, wobble + 1), '@leaf'),
    sh(blob(-size * 0.16, canopyY - size * 0.26, size * 0.22, size * 0.18, wobble + 3), '@leafLight'),
    sh(blob(size * 0.2, canopyY - size * 0.22, size * 0.2, size * 0.16, wobble + 4), '@leafLight'),
  );
  return shapes;
}

/** Conifer: layered skirt tiers, snow-laden from the top down when it snows. */
function pine(o: PropDrawOptions, size: number): readonly Shape[] {
  const snowy = o.environment === 'snow';
  const tiers = 4 + Math.round(shake(o.variant, 1) * 2);
  const trunkH = size * 0.16;
  const shapes: Shape[] = [
    sh(`M-1.8 0L1.8 0L1.2 ${round(-trunkH * 1.6)}L-1.2 ${round(-trunkH * 1.6)}Z`, '@bark'),
  ];
  for (let i = 0; i < tiers; i += 1) {
    const t = i / (tiers - 1);
    const y = -trunkH - t * (size * 0.86);
    const halfWidth = size * (0.34 - t * 0.24);
    const halfHeight = size * (0.16 - t * 0.07);
    shapes.push(
      sh(
        `M${round(-halfWidth)} ${round(y)}L${round(halfWidth)} ${round(y)}L0 ${round(y - halfHeight * 2)}Z`,
        i % 2 === 0 ? '@needle' : '@leafDark',
      ),
    );
    if (snowy && i > 0) {
      // Snow sits on the upper face of each tier: white only where the light
      // would actually land, which is what stops it reading as a white cone.
      shapes.push(
        sh(
          `M${round(-halfWidth * 0.86)} ${round(y - 1)}L${round(halfWidth * 0.86)} ${round(y - 1)}L0 ${round(y - halfHeight * 1.5)}Z`,
          '#e8eff4',
          { opacity: 0.78 },
        ),
      );
    }
  }
  return shapes;
}

/** Palm: a curved trunk with a crown of fronds that move in the wind. */
function palm(o: PropDrawOptions, size: number): readonly Shape[] {
  const bend = (shake(o.variant, 1) - 0.5) * size * 0.2;
  const top = -size * 0.74;
  const fronds = 6 + Math.round(shake(o.variant, 2) * 3);
  const shapes: Shape[] = [
    sh(
      `M-2.6 0C-2.2 ${round(top * 0.5)} ${round(bend - 2)} ${round(top * 0.9)} ${round(bend)} ${round(top)}` +
        `L${round(bend + 2)} ${round(top)}C${round(bend + 3)} ${round(top * 0.9)} 2.4 ${round(top * 0.4)} 2.6 0Z`,
      '@bark',
    ),
    sh(`M0 0C0.4 ${round(top * 0.5)} ${round(bend)} ${round(top * 0.9)} ${round(bend)} ${round(top)}`, '@barkDark', {
      stroke: '@barkDark',
      strokeWidth: 1,
      lineCap: 'round',
      opacity: 0.6,
    }),
  ];
  for (let i = 0; i < fronds; i += 1) {
    const angle = (-Math.PI * 0.92 + (i / (fronds - 1)) * Math.PI * 0.84) + Math.sin(o.time * 0.6 + i) * 0.05;
    const length = size * (0.3 + shake(o.variant, i + 3) * 0.12);
    const tipX = bend + Math.cos(angle) * length;
    const tipY = top + Math.sin(angle) * length * -1;
    const midX = bend + Math.cos(angle) * length * 0.55;
    const midY = top + Math.sin(angle) * length * -1.35;
    shapes.push(
      sh(
        `M${round(bend)} ${round(top)}Q${round(midX)} ${round(midY)} ${round(tipX)} ${round(tipY)}` +
          `Q${round(midX + 2)} ${round(midY + 1.6)} ${round(bend)} ${round(top + 1)}Z`,
        i % 2 === 0 ? '@leaf' : '@leafDark',
      ),
    );
  }
  // A couple of dead fronds hanging down, so the tree looks lived-in.
  shapes.push(
    sh(`M${round(bend)} ${round(top)}Q${round(bend - size * 0.14)} ${round(top + size * 0.06)} ${round(bend - size * 0.2)} ${round(top + size * 0.2)}`, '@strawDark', {
      stroke: '@strawDark',
      strokeWidth: 1.6,
      lineCap: 'round',
      opacity: 0.8,
    }),
  );
  return shapes;
}

/** A shell-stripped trunk with jagged broken branches. */
function deadTree(o: PropDrawOptions, size: number): readonly Shape[] {
  const height = size * 0.86;
  const branches = 3 + Math.round(shake(o.variant, 2) * 2);
  const shapes: Shape[] = [
    sh(
      `M-2.8 0L2.8 0L1.8 ${round(-height * 0.6)}L0.9 ${round(-height)}L-0.9 ${round(-height)}L-1.8 ${round(-height * 0.6)}Z`,
      '@bark',
    ),
    sh(`M-0.4 0L2.8 0L1.8 ${round(-height * 0.6)}L0.6 ${round(-height * 0.72)}Z`, '@barkDark', { opacity: 0.65 }),
    // A charred base: the stump of everything that was shot away.
    sh(`M-3.4 0L3.4 0L3 2.4L-3 2.4Z`, '@soot'),
  ];
  for (let i = 0; i < branches; i += 1) {
    const t = 0.4 + (i / branches) * 0.5;
    const dir = i % 2 === 0 ? 1 : -1;
    const from = { x: dir * 0.6, y: -height * t };
    const to = { x: dir * size * (0.16 + shake(o.variant, i + 4) * 0.14), y: -height * (t + 0.16) };
    shapes.push(
      sh(`M${round(from.x)} ${round(from.y)}L${round(to.x)} ${round(to.y)}`, '@bark', {
        stroke: '@bark',
        strokeWidth: 2,
        lineCap: 'round',
      }),
      sh(`M${round(to.x)} ${round(to.y)}L${round(to.x + dir * 2)} ${round(to.y - 3)}`, '@barkDark', {
        stroke: '@barkDark',
        strokeWidth: 1.1,
        lineCap: 'round',
      }),
    );
  }
  return shapes;
}

/** A low cluster of faceted boulders: lit top, shadowed side. */
function rock(o: PropDrawOptions, size: number): readonly Shape[] {
  const count = 2 + Math.round(shake(o.variant, 1) * 1.5);
  const shapes: Shape[] = [];
  for (let i = 0; i < count; i += 1) {
    const offsetX = (i - (count - 1) / 2) * size * 0.44;
    const scale = 0.7 + shake(o.variant, i + 2) * 0.5;
    const w = size * 0.3 * scale;
    const h = size * 0.22 * scale;
    const y = -h - i * size * 0.04;
    shapes.push(
      sh(
        poly([
          { x: offsetX - w, y: 0 },
          { x: offsetX - w * 0.7, y: y },
          { x: offsetX + w * 0.4, y: y - h * 0.22 },
          { x: offsetX + w, y: 0 },
        ]),
        '@stone',
      ),
      sh(
        poly([
          { x: offsetX - w * 0.7, y: y },
          { x: offsetX + w * 0.4, y: y - h * 0.22 },
          { x: offsetX + w * 0.2, y: y + h * 0.3 },
          { x: offsetX - w * 0.5, y: y + h * 0.2 },
        ]),
        '@stoneLight',
      ),
      sh(
        poly([
          { x: offsetX + w, y: 0 },
          { x: offsetX + w * 0.4, y: y - h * 0.22 },
          { x: offsetX + w * 0.2, y: y + h * 0.3 },
          { x: offsetX + w * 0.7, y: h * 0.2 },
        ]),
        '@stoneDark',
      ),
    );
  }
  return shapes;
}

/** Low scrub: two or three lumps of foliage with twigs poking out. */
function bush(o: PropDrawOptions, size: number): readonly Shape[] {
  const lumps = 2 + Math.round(shake(o.variant, 1) * 1.5);
  const shapes: Shape[] = [];
  for (let i = 0; i < lumps; i += 1) {
    const cx = (i - (lumps - 1) / 2) * size * 0.34;
    const r = size * (0.22 + shake(o.variant, i + 3) * 0.12);
    shapes.push(sh(blob(cx, -r * 0.8, r, r * 0.72, shake(o.variant, i) * 6), i === 0 ? '@leaf' : '@leafDark'));
  }
  if (o.environment === 'snow') {
    shapes.push(sh(blob(0, -size * 0.26, size * 0.3, size * 0.1, 1), '#e9f0f5', { opacity: 0.75 }));
  }
  for (let i = 0; i < 3; i += 1) {
    const dx = (shake(o.variant, i + 6) - 0.5) * size * 0.5;
    shapes.push(
      sh(`M${round(dx)} 0L${round(dx + dx * 0.4)} ${round(-size * 0.42)}`, '@barkDark', {
        stroke: '@barkDark',
        strokeWidth: 0.9,
        lineCap: 'round',
        opacity: 0.8,
      }),
    );
  }
  return shapes;
}

/** A roofless corner of masonry: shell, jagged parapet, rubble at the foot. */
function ruin(o: PropDrawOptions, size: number): readonly Shape[] {
  const w = size * 0.5;
  const d = size * 0.34;
  const h = size * 0.62;
  const shapes: Shape[] = [
    ...isoBoxLocal(-w, -d, w, d, h, '@masonry', '@masonryDark', '@soot'),
    // Broken top edge: a zigzag parapet instead of a clean roof line.
    sh(
      poly([
        iso2(-w, -d),
        { x: iso2(-w * 0.2, -d).x, y: iso2(-w * 0.2, -d).y - h },
        { x: iso2(w * 0.1, -d).x, y: iso2(w * 0.1, -d).y - h * 0.62 },
        { x: iso2(w, -d).x, y: iso2(w, -d).y - h * 0.9 },
        iso2(w, d),
      ]),
      '@masonryDark',
      { opacity: 0.55 },
    ),
    // A window void and a fallen joist, so the inside reads as inside.
    sh(poly([iso2(-w * 0.5, -d), iso2(-w * 0.1, -d), { x: iso2(-w * 0.1, -d).x, y: iso2(-w * 0.1, -d).y - h * 0.4 }, { x: iso2(-w * 0.5, -d).x, y: iso2(-w * 0.5, -d).y - h * 0.4 }]), '@soot', { opacity: 0.62 }),
  ];
  const rub = 3 + Math.round(shake(o.variant, 2) * 3);
  for (let i = 0; i < rub; i += 1) {
    const rx = (shake(o.variant, i + 4) - 0.5) * w * 2.2;
    const ry = shake(o.variant, i + 9) * d * 2;
    shapes.push(sh(blob(rx, ry * 0.5 - 1, size * 0.07, size * 0.04, i), '@rubble'));
  }
  shapes.push(
    sh(`M${round(-w)} 0L${round(w)} 0`, '@grass', { stroke: '@grass', strokeWidth: 1.4, lineCap: 'round', opacity: 0.7 }),
  );
  return shapes;
}

/** A low field wall: two courses, a broken end, a light top face. */
function wall(o: PropDrawOptions, size: number): readonly Shape[] {
  const length = size * 0.9;
  const half = size * 0.1;
  const h = size * 0.26;
  const broken = shake(o.variant, 1) > 0.5;
  const shapes: Shape[] = [
    ...isoBoxLocal(-length * 0.5, -half, length * 0.5, half, h, '@stoneLight', '@stone', '@stoneDark'),
  ];
  if (broken) {
    // Part of the run has been knocked down: a stub of the same wall.
    shapes.push(...isoBoxLocal(length * 0.5, -half, length * 0.7, half, h * 0.45, '@stone', '@stoneDark', '@soot'));
  }
  for (let i = 0; i < 3; i += 1) {
    const u = (shake(o.variant, i + 5) - 0.5) * length;
    shapes.push(
      sh(`M${round(u - 2)} ${round(-h)}L${round(u + 2)} ${round(-h + 1.6)}`, '@stoneDark', {
        stroke: '@stoneDark',
        strokeWidth: 0.8,
        lineCap: 'round',
        opacity: 0.7,
      }),
    );
  }
  return shapes;
}

/** Post-and-rail fence, leaning and broken in places. */
function fence(o: PropDrawOptions, size: number): readonly Shape[] {
  const posts = 3 + Math.round(shake(o.variant, 1) * 1.5);
  const spacing = size * 0.34;
  const height = size * 0.34;
  const shapes: Shape[] = [
    sh(`M${round((-posts * spacing) / 2)} 0L${round((posts * spacing) / 2)} ${round(-size * 0.02)}`, '@soot', {
      stroke: '@soot',
      strokeWidth: 1.2,
      opacity: 0.25,
    }),
  ];
  for (let i = 0; i < posts; i += 1) {
    const x = (i - (posts - 1) / 2) * spacing;
    const lean = (shake(o.variant, i + 2) - 0.5) * 0.18;
    const dropped = shake(o.variant, i + 7) > 0.75 ? height * 0.3 : 0;
    shapes.push(
      sh(
        `M${round(x - 1.2)} 0L${round(x + 1.2)} 0L${round(x + 1.2 + lean * 8)} ${round(-height + dropped)}L${round(x - 1.2 + lean * 8)} ${round(-height + dropped)}Z`,
        '@plank',
      ),
      sh(`M${round(x - 1.6 + lean * 4)} ${round(-height * 0.62)}L${round(x + 1.6 + lean * 4)} ${round(-height * 0.58)}`, '@plankDark', {
        stroke: '@plankDark',
        strokeWidth: 1.4,
        lineCap: 'round',
        opacity: 0.8,
      }),
    );
  }
  for (let rail = 0; rail < 2; rail += 1) {
    const y = -height * (0.34 + rail * 0.42);
    shapes.push(
      sh(
        `M${round((-posts * spacing) / 2)} ${round(y)}L${round((posts * spacing) / 2 - 3)} ${round(y - 1.5)}`,
        rail === 0 ? '@plank' : '@plankDark',
        { stroke: rail === 0 ? '@plank' : '@plankDark', strokeWidth: 2, lineCap: 'round' },
      ),
    );
  }
  return shapes;
}

/** A filled sandbag emplacement: two courses of bags and a spoil of earth. */
function sandbags(o: PropDrawOptions, size: number): readonly Shape[] {
  const shapes: Shape[] = [];
  const bags = 5;
  const width = size * 0.52;
  for (let course = 0; course < 2; course += 1) {
    const count = bags - course;
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      // A slight arc, so the emplacement faces the enemy rather than the screen.
      const arc = Math.sin(t * Math.PI) * size * 0.06;
      const x = -width + t * width * 2;
      const y = -arc - course * size * 0.09;
      const rot = (shake(o.variant, i + course * 5) - 0.5) * 0.4;
      shapes.push(
        sh(
          `M${round(x - size * 0.13)} ${round(y)}Q${round(x)} ${round(y - size * 0.13)} ${round(x + size * 0.13)} ${round(y)}Q${round(x)} ${round(y + size * 0.04)} ${round(x - size * 0.13)} ${round(y)}Z`,
          course === 0 ? '@cloth' : '@strawDark',
          { transform: { rotate: rot, pivotX: x, pivotY: y } },
        ),
      );
    }
  }
  shapes.push(
    sh(
      poly([
        { x: -width - size * 0.16, y: 0 },
        { x: width + size * 0.16, y: 0 },
        { x: width, y: size * 0.07 },
        { x: -width, y: size * 0.07 },
      ]),
      '@rubble',
      { opacity: 0.75 },
    ),
  );
  return shapes;
}

/** A stack of ammunition crates with the lid ajar on the top one. */
function crate(o: PropDrawOptions, size: number): readonly Shape[] {
  const s = size * 0.22;
  const height = size * 0.18;
  const shapes: Shape[] = [
    ...isoBoxLocal(-s, -s, s, s, height, '@plank', '@plankDark', '@barkDark'),
    ...isoBoxLocal(-s * 0.9, -s * 0.9, s * 0.5, s * 0.5, height, '@plank', '@plankDark', '@barkDark'),
  ];
  if (shake(o.variant, 1) > 0.45) {
    shapes.push(
      sh(
        poly([
          iso2(-s * 0.6, -s * 0.6),
          iso2(s * 0.5, -s * 0.6),
          { x: iso2(s * 0.5, -s * 0.6).x, y: iso2(s * 0.5, -s * 0.6).y - height * 0.3 },
        ]),
        '@plankDark',
      ),
    );
  }
  // Stencilled band and a couple of spent cases at the foot.
  shapes.push(
    sh(`M${round(-s * 0.9)} ${round(-height * 0.5)}L${round(s * 0.9)} ${round(-height * 0.5)}`, '@straw', {
      stroke: '@straw',
      strokeWidth: 1.6,
      opacity: 0.75,
    }),
    sh(`M${round(s * 0.7)} ${round(height * 0.1)}L${round(s * 0.9)} ${round(height * 0.06)}`, '@metalLight', {
      stroke: '@metalLight',
      strokeWidth: 1.1,
      lineCap: 'round',
    }),
  );
  return shapes;
}

/** A burnt-out vehicle hulk with a thin wisp still coming off it. */
function wreck(o: PropDrawOptions, size: number): readonly Shape[] {
  const w = size * 0.42;
  const d = size * 0.2;
  const h = size * 0.2;
  const shapes: Shape[] = [
    ...isoBoxLocal(-w, -d, w, d, h, '@soot', '@metalDark', '@soot'),
    // Missing track run and a displaced plate: the wreck is broken, not parked.
    sh(poly([iso2(-w * 0.8, d * 0.5), iso2(w * 0.6, d * 0.5), iso2(w * 0.6, d), iso2(-w * 0.8, d)]), '@metal'),
    sh(
      poly([
        iso2(w * 0.1, -d * 1.4),
        iso2(w * 0.8, -d * 1.2),
        { x: iso2(w * 0.8, -d * 1.2).x, y: iso2(w * 0.8, -d * 1.2).y - h * 1.6 },
      ]),
      '@metalDark',
      { opacity: 0.9 },
    ),
    // Bent barrel.
    sh(`M${round(iso2(w * 0.4, 0).x)} ${round(iso2(w * 0.4, 0).y - h * 1.2)}L${round(iso2(w * 1.1, 0).x)} ${round(iso2(w * 1.1, 0).y - h * 2)}`, '@metalDark', {
      stroke: '@metalDark',
      strokeWidth: 2.2,
      lineCap: 'round',
    }),
    sh(blob(0, -h * 1.1, size * 0.12, size * 0.06, 2), '@soot', { opacity: 0.5 }),
  ];
  // A wisp of smoke, driven by `time` so a wreck is never mistaken for scenery.
  for (let i = 0; i < 3; i += 1) {
    const phase = (o.time * 0.4 + i * 0.33) % 1;
    shapes.push(
      sh(blob(phase * 4 - 2, -h - 6 - phase * 12, 1.6 + phase * 3.4, 1.2 + phase * 2.4, i), '@rubble', {
        opacity: (1 - phase) * 0.3,
      }),
    );
  }
  return shapes;
}

/** A leaning signpost: mine warning, direction, or a unit marking. */
function post(o: PropDrawOptions, size: number): readonly Shape[] {
  const height = size * 0.42;
  const lean = (shake(o.variant, 1) - 0.5) * 0.2;
  const kind = Math.floor(shake(o.variant, 2) * 3);
  const shapes: Shape[] = [
    sh(
      `M-1.2 0L1.2 0L${round(1.2 + lean * 8)} ${round(-height)}L${round(-1.2 + lean * 8)} ${round(-height)}Z`,
      '@plank',
    ),
    sh(`M-2.4 0L2.4 0L2.4 1.4L-2.4 1.4Z`, '@soot', { opacity: 0.4 }),
  ];
  const topX = lean * 8;
  if (kind === 0) {
    // Mine warning: a triangle on a board.
    shapes.push(
      sh(poly([{ x: topX - 4, y: -height }, { x: topX + 4, y: -height }, { x: topX, y: -height - 6 }]), '@plankDark'),
      sh(`M${round(topX)} ${round(-height - 1.4)}L${round(topX)} ${round(-height - 3.4)}`, '@straw', {
        stroke: '@straw',
        strokeWidth: 1,
        lineCap: 'round',
      }),
    );
  } else if (kind === 1) {
    // Direction board, pointing the way the road runs.
    shapes.push(
      sh(poly([{ x: topX, y: -height + 1 }, { x: topX + 8, y: -height + 1 }, { x: topX + 8, y: -height - 3.4 }, { x: topX, y: -height - 3.4 }]), '@plank'),
      sh(`M${round(topX + 1.6)} ${round(-height - 0.8)}L${round(topX + 6.4)} ${round(-height - 0.8)}`, '@plankDark', {
        stroke: '@plankDark',
        strokeWidth: 1,
        lineCap: 'round',
      }),
    );
  } else {
    // Unit marking and a stretch of wire, because a lone stake is a tripwire.
    shapes.push(
      sh(`M${round(topX - 5)} ${round(-height * 0.62)}L${round(topX + 5)} ${round(-height * 0.66)}`, '@metal', {
        stroke: '@metal',
        strokeWidth: 0.9,
      }),
      sh(`M${round(topX - 5)} ${round(-height * 0.62)}L${round(topX - 16)} ${round(-height * 0.5)}`, '@metal', {
        stroke: '@metal',
        strokeWidth: 0.8,
        opacity: 0.85,
      }),
      sh(`M${round(topX + 5)} ${round(-height * 0.66)}L${round(topX + 16)} ${round(-height * 0.54)}`, '@metal', {
        stroke: '@metal',
        strokeWidth: 0.8,
        opacity: 0.85,
      }),
    );
  }
  return shapes;
}

/** A rounded haystack with layered straw and a couple of blown-off tufts. */
function haystack(o: PropDrawOptions, size: number): readonly Shape[] {
  const w = size * 0.44;
  const h = size * 0.4;
  const shapes: Shape[] = [
    sh(
      `M${round(-w)} 0C${round(-w * 1.05)} ${round(-h * 0.5)} ${round(-w * 0.6)} ${round(-h)} 0 ${round(-h)}` +
        `C${round(w * 0.6)} ${round(-h)} ${round(w * 1.05)} ${round(-h * 0.5)} ${round(w)} 0Z`,
      '@straw',
    ),
  ];
  for (let i = 1; i <= 3; i += 1) {
    const t = i / 4;
    shapes.push(
      sh(
        `M${round(-w * (1 - t * 0.5))} ${round(-h * t)}C${round(-w * 0.4)} ${round(-h * (t + 0.16))} ${round(w * 0.4)} ${round(-h * (t + 0.16))} ${round(w * (1 - t * 0.5))} ${round(-h * t)}`,
        i % 2 === 0 ? '@strawDark' : '@straw',
        { stroke: i % 2 === 0 ? '@strawDark' : '@straw', strokeWidth: 1.2, opacity: 0.85 },
      ),
    );
  }
  for (let i = 0; i < 3; i += 1) {
    const dx = (shake(o.variant, i + 3) - 0.5) * w * 2.4;
    shapes.push(
      sh(`M${round(dx * 0.6)} 0L${round(dx)} ${round(-size * 0.05)}`, '@strawDark', {
        stroke: '@strawDark',
        strokeWidth: 0.9,
        lineCap: 'round',
        opacity: 0.8,
      }),
    );
  }
  return shapes;
}

// ------------------------------------------------------------------ driving

/** Base size in world units, before `scaleHint` and the per-prop jitter. */
const SIZES: Readonly<Record<PropKind, number>> = {
  tree: 68,
  pine: 84,
  palm: 76,
  deadTree: 60,
  rock: 16,
  bush: 22,
  ruin: 62,
  wall: 34,
  fence: 30,
  sandbags: 26,
  crate: 22,
  wreck: 40,
  post: 24,
  haystack: 34,
};

/** Half-extents of the shadow ellipse, world units, per kind. */
const SHADOWS: Readonly<Record<PropKind, number>> = {
  tree: 20,
  pine: 18,
  palm: 16,
  deadTree: 14,
  rock: 10,
  bush: 12,
  ruin: 30,
  wall: 18,
  fence: 16,
  sandbags: 14,
  crate: 11,
  wreck: 22,
  post: 5,
  haystack: 18,
};

/** Kinds whose own art already includes footprint shading. */
const NO_SHADOW: ReadonlySet<PropKind> = new Set<PropKind>(['wall', 'haystack', 'sandbags']);

function shapesFor(kind: PropKind, o: PropDrawOptions, size: number): readonly Shape[] {
  switch (kind) {
    case 'tree':
      return tree(o, size);
    case 'pine':
      return pine(o, size);
    case 'palm':
      return palm(o, size);
    case 'deadTree':
      return deadTree(o, size);
    case 'rock':
      return rock(o, size);
    case 'bush':
      return bush(o, size);
    case 'ruin':
      return ruin(o, size);
    case 'wall':
      return wall(o, size);
    case 'fence':
      return fence(o, size);
    case 'sandbags':
      return sandbags(o, size);
    case 'crate':
      return crate(o, size);
    case 'wreck':
      return wreck(o, size);
    case 'post':
      return post(o, size);
    case 'haystack':
      return haystack(o, size);
    default:
      return [];
  }
}

/** Draw one scattered prop, shadow and all. */
export function drawProp(ctx: CanvasRenderingContext2D, o: PropDrawOptions): void {
  const p = PALETTES[o.environment] ?? TEMPERATE;
  const jitter = 0.9 + shake(o.variant, 0) * 0.22;
  const size = SIZES[o.kind] * o.scaleHint * jitter;
  const scale = o.scale;

  if (!NO_SHADOW.has(o.kind)) {
    const radius = SHADOWS[o.kind] * o.scaleHint;
    drawShadow(ctx, {
      x: o.x,
      y: o.y,
      rx: radius * scale,
      ry: radius * 0.5 * scale,
      alpha: o.environment === 'night' ? 0.2 : 0.3,
    });
  }

  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(scale, scale);
  // A bush or a palm leans with the wind; heavier things lean only because they
  // were built badly.
  const lean = o.kind === 'tree' || o.kind === 'palm' || o.kind === 'bush'
    ? Math.sin(o.time * 0.7 + o.variant * 6) * 0.012
    : (shake(o.variant, 5) - 0.5) * 0.02;
  if (lean !== 0) ctx.rotate(lean);

  const shapes = shapesFor(o.kind, o, size);
  paintSprite(ctx, { shapes }, p);
  ctx.restore();
}
