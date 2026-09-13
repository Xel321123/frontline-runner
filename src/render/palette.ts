/**
 * Faction palettes and shared colours for the battle scene.
 *
 * Everything is drawn procedurally, so the palette *is* the art direction: the
 * Allies read as olive drab and khaki, the Axis as feldgrau. Helmet silhouette
 * follows from the same table, which is what makes the two armies tellable
 * apart at a glance in a 34 px-tall figure.
 */

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
