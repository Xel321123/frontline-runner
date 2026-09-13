/**
 * Faction palettes and shared colours for the battle scene.
 *
 * Everything is drawn procedurally, so the palette *is* the art direction: the
 * Allies read as olive drab and khaki, the Axis as feldgrau. Helmet silhouette
 * follows from the same table, which is what makes the two armies tellable
 * apart at a glance in a 34 px-tall figure.
 */

import type { Environment } from '../data/campaignData';
import type { Faction } from '../core/types';

export type HelmetShape = 'brodie' | 'm1' | 'stahlhelm';

export interface FactionPalette {
  /** Main uniform tone. */
  readonly uniform: string;
  readonly uniformDark: string;
  readonly uniformLight: string;
  readonly helmet: string;
  readonly helmetDark: string;
  /** Webbing, belts and packs. */
  readonly webbing: string;
  readonly skin: string;
  readonly skinShade: string;
  /** Flag / marking colour for the side's strongpoint. */
  readonly accent: string;
  /** Vehicle hull tones. */
  readonly vehicle: string;
  readonly vehicleDark: string;
  readonly track: string;
}

export const ALLIED_PALETTE: FactionPalette = {
  uniform: '#5f6b38',
  uniformDark: '#3f4a24',
  uniformLight: '#7d8a4c',
  helmet: '#6f7a40',
  helmetDark: '#48502a',
  webbing: '#a99a68',
  skin: '#c9a179',
  skinShade: '#a37f5b',
  accent: '#cfd6b0',
  vehicle: '#5a6435',
  vehicleDark: '#3c4422',
  track: '#241f18',
};

export const AXIS_PALETTE: FactionPalette = {
  uniform: '#4f5a4c',
  uniformDark: '#364037',
  uniformLight: '#68755f',
  helmet: '#57634d',
  helmetDark: '#394433',
  webbing: '#2e372f',
  skin: '#c9a179',
  skinShade: '#a37f5b',
  accent: '#9aa88f',
  vehicle: '#4a5548',
  vehicleDark: '#333c34',
  track: '#22201c',
};

/**
 * Axis troops wear the Stahlhelm throughout; Allied troops start the war in the
 * Brodie and are re-kitted with the M1 as the campaign reaches the late tiers.
 */
export function helmetFor(faction: Faction, tier: number): HelmetShape {
  if (faction === 'axis') return 'stahlhelm';
  return tier >= 6 ? 'm1' : 'brodie';
}

export function paletteFor(faction: Faction): FactionPalette {
  return faction === 'axis' ? AXIS_PALETTE : ALLIED_PALETTE;
}

/** Scene colours shared by every layer. */
export const SCENE = {
  skyTop: '#2a3346',
  skyMid: '#4a4f56',
  skyHaze: '#8a7f6a',
  sunGlow: 'rgba(226, 186, 128, 0.30)',
  cloud: 'rgba(206, 200, 186, 0.16)',
  hillFar: '#3d4247',
  hillNear: '#333a35',
  ruinFar: '#2e332f',
  ruinNear: '#262b26',
  smokeFar: 'rgba(96, 96, 92, 0.30)',
  smokeNear: 'rgba(70, 68, 62, 0.34)',
  groundFar: '#5b5340',
  groundMid: '#4a4434',
  groundNear: '#3a3529',
  groundLine: '#6b6249',
  road: 'rgba(120, 108, 84, 0.35)',
  crater: 'rgba(28, 26, 20, 0.5)',
  grass: '#5d6238',
  grassDark: '#414629',
  shadow: 'rgba(10, 12, 10, 0.32)',
  bone: '#d8d2c0',
  brass: '#d9a441',
  spark: '#ffe9a8',
  tracer: '#ffd479',
  hud: '#e6ecdd',
  hudDim: '#93a28f',
  hudLine: '#2b362d',
  hudPanel: 'rgba(14, 19, 16, 0.86)',
  playerHp: '#7fbf6a',
  enemyHp: '#d9705f',
  bond: '#e8c15a',
  warning: '#e8c15a',
} as const;

export const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// --- environment looks ------------------------------------------------------

/**
 * The colours that change with the weather. Everything in a look is the same
 * *shape* of scene — hills, ruins, ground, road — re-lit for the environment,
 * so the terrain painters stay identical and only the palette moves.
 */
export interface SceneLook {
  readonly skyTop: string;
  readonly skyMid: string;
  readonly skyHaze: string;
  readonly sunGlow: string;
  readonly cloud: string;
  readonly hillFar: string;
  readonly hillNear: string;
  readonly ruinFar: string;
  readonly ruinNear: string;
  readonly smokeFar: string;
  readonly smokeNear: string;
  readonly groundFar: string;
  readonly groundMid: string;
  readonly groundNear: string;
  readonly groundLine: string;
  readonly road: string;
  readonly crater: string;
  readonly grass: string;
  readonly grassDark: string;
}

export const SCENE_LOOKS: Readonly<Record<Environment, SceneLook>> = {
  standard: {
    skyTop: SCENE.skyTop,
    skyMid: SCENE.skyMid,
    skyHaze: SCENE.skyHaze,
    sunGlow: SCENE.sunGlow,
    cloud: SCENE.cloud,
    hillFar: SCENE.hillFar,
    hillNear: SCENE.hillNear,
    ruinFar: SCENE.ruinFar,
    ruinNear: SCENE.ruinNear,
    smokeFar: SCENE.smokeFar,
    smokeNear: SCENE.smokeNear,
    groundFar: SCENE.groundFar,
    groundMid: SCENE.groundMid,
    groundNear: SCENE.groundNear,
    groundLine: SCENE.groundLine,
    road: SCENE.road,
    crater: SCENE.crater,
    grass: SCENE.grass,
    grassDark: SCENE.grassDark,
  },
  // Snow: a flat white light, pale ground, almost no colour left in the scene.
  snow: {
    skyTop: '#4d5a72',
    skyMid: '#8b96a6',
    skyHaze: '#d9dde2',
    sunGlow: 'rgba(226, 234, 240, 0.30)',
    cloud: 'rgba(240, 244, 248, 0.32)',
    hillFar: '#aeb7c2',
    hillNear: '#98a3b0',
    ruinFar: '#7d8590',
    ruinNear: '#666e79',
    smokeFar: 'rgba(120, 126, 134, 0.30)',
    smokeNear: 'rgba(94, 100, 108, 0.34)',
    groundFar: '#c9ced6',
    groundMid: '#dde1e6',
    groundNear: '#eff1f4',
    groundLine: '#b3bac4',
    road: 'rgba(150, 158, 170, 0.30)',
    crater: 'rgba(120, 128, 140, 0.35)',
    grass: '#b9c3bb',
    grassDark: '#9aa69f',
  },
  // Desert: hot haze, ochre ground, bleached sky.
  desert: {
    skyTop: '#6d7f97',
    skyMid: '#c3b189',
    skyHaze: '#e8d6a8',
    sunGlow: 'rgba(255, 226, 160, 0.38)',
    cloud: 'rgba(238, 222, 186, 0.20)',
    hillFar: '#b09a70',
    hillNear: '#9c8659',
    ruinFar: '#7d6a4a',
    ruinNear: '#65553b',
    smokeFar: 'rgba(150, 132, 100, 0.30)',
    smokeNear: 'rgba(112, 98, 74, 0.34)',
    groundFar: '#b79f70',
    groundMid: '#c9b182',
    groundNear: '#dcc79a',
    groundLine: '#a58d61',
    road: 'rgba(160, 140, 104, 0.30)',
    crater: 'rgba(96, 78, 50, 0.42)',
    grass: '#9c8f5c',
    grassDark: '#82754a',
  },
  // Mud: everything brown, wet and low-contrast, with standing water.
  mud: {
    skyTop: '#3b3a34',
    skyMid: '#5c5648',
    skyHaze: '#8b7f66',
    sunGlow: 'rgba(214, 186, 138, 0.18)',
    cloud: 'rgba(196, 188, 172, 0.18)',
    hillFar: '#4a453a',
    hillNear: '#3d392f',
    ruinFar: '#38342b',
    ruinNear: '#2c2922',
    smokeFar: 'rgba(96, 90, 74, 0.30)',
    smokeNear: 'rgba(74, 68, 56, 0.36)',
    groundFar: '#544732',
    groundMid: '#453929',
    groundNear: '#332a1e',
    groundLine: '#5f5039',
    road: 'rgba(96, 82, 60, 0.34)',
    crater: 'rgba(20, 16, 10, 0.55)',
    grass: '#4f4c2c',
    grassDark: '#3a3720',
  },
  // Night: near-monochrome blue, with a cold moon haze where the sun was.
  night: {
    skyTop: '#080c16',
    skyMid: '#121a2a',
    skyHaze: '#233046',
    sunGlow: 'rgba(150, 178, 210, 0.16)',
    cloud: 'rgba(120, 140, 170, 0.14)',
    hillFar: '#161d2a',
    hillNear: '#101620',
    ruinFar: '#121722',
    ruinNear: '#0c1018',
    smokeFar: 'rgba(70, 80, 96, 0.26)',
    smokeNear: 'rgba(48, 56, 70, 0.32)',
    groundFar: '#26241f',
    groundMid: '#1c1b17',
    groundNear: '#121110',
    groundLine: '#2e2b24',
    road: 'rgba(80, 86, 96, 0.22)',
    crater: 'rgba(6, 8, 10, 0.6)',
    grass: '#2a2f22',
    grassDark: '#1e2218',
  },
};

export function sceneLook(environment: Environment): SceneLook {
  return SCENE_LOOKS[environment] ?? SCENE_LOOKS.standard;
}
