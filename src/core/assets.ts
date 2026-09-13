/**
 * Asset manifest. Pure data — describes *what* to load and *what to draw if
 * loading fails* (`procedural` ids are implemented in `engine/ProceduralSprites.ts`).
 *
 * Paths are relative to the app base and are resolved at load time, so the
 * same manifest works at a GitHub Pages subpath (`/frontline-runner/`) and
 * from a relative `./` base inside a Capacitor shell.
 */
import type { Faction } from './types';

/** Character-pack tiers that actually ship in the archive (no `t7`). */
export type UnitTier = 1 | 2 | 3 | 4 | 5 | 6 | 8 | 9;

export const UNIT_TIERS: readonly UnitTier[] = [1, 2, 3, 4, 5, 6, 8, 9];

/**
 * Ids of Canvas 2D procedural fallbacks. Kept as a closed union so a typo in
 * the manifest is a compile error rather than a silent black square.
 */
export type ProceduralSpriteId =
  | 'map.europe'
  | 'weapons.atlas'
  | 'unit.allied'
  | 'unit.enemy';

export type AssetKey = 'map.europe' | 'weapons.atlas' | `unit.${Faction}.t${UnitTier}`;

export interface AssetLayerSpec {
  /** Layer name, useful for compositing character parts later. */
  readonly name: string;
  /** Path relative to `import.meta.env.BASE_URL`. */
  readonly url: string;
}

export interface AssetSpec {
  readonly key: AssetKey;
  /** Human label for the boot/status screen. */
  readonly label: string;
  /** Draw order: first entry is the base layer. */
  readonly layers: readonly AssetLayerSpec[];
  /** Canvas 2D painter used when the layer files cannot be decoded. */
  readonly procedural: ProceduralSpriteId;
  /** Intrinsic size of the procedural fallback (and its layout box). */
  readonly proceduralSize: { readonly width: number; readonly height: number };
}

interface UnitTierSpec {
  readonly tier: UnitTier;
  readonly dir: string;
  readonly label: string;
  readonly body: string;
  readonly head: string;
  readonly helmet: string;
}

const ALLIED_TIERS: readonly UnitTierSpec[] = [
  {
    tier: 1,
    dir: 'ally_t1',
    label: 'Allied infantry',
    body: 'ally_body.png',
    head: 'ally_head.png',
    helmet: 'ally_hat_t1.png',
  },
];

const ENEMY_TIERS: readonly UnitTierSpec[] = [
  {
    tier: 1,
    dir: 'enemy_t1',
    label: 'Garrison infantry',
    body: 'enemy_body_t1.png',
    head: 'enemy_head_t1.png',
    helmet: 'helmet_t1.png',
  },
  {
    tier: 2,
    dir: 'enemy_t2',
    label: 'Motorised infantry',
    body: 'enemy_body_t2.png',
    head: 'enemy_head_t2.png',
    helmet: 'helmet_3_t2.png',
  },
  {
    tier: 3,
    dir: 'enemy_t3',
    label: 'Rifle platoon',
    body: 'enemy_body_t3.png',
    head: 'enemy_head_t3.png',
    helmet: 'helmet_2_t3.png',
  },
  {
    tier: 4,
    dir: 'enemy_t4',
    label: 'Veteran platoon',
    body: 'enemy_body_t4.png',
    head: 'enemy_head_t4.png',
    helmet: 'helmet_4_t4.png',
  },
  {
    tier: 5,
    dir: 'enemy_t5',
    label: 'Assault group',
    body: 'enemy_body_t5.png',
    head: 'enemy_head_t5.png',
    helmet: 'helmet_t5.png',
  },
  {
    tier: 6,
    dir: 'enemy_t6',
    label: 'Panzergrenadiers',
    body: 'enemy_body_t6.png',
    head: 'enemy_head_t6.png',
    helmet: 'helmet_t6.png',
  },
  {
    tier: 8,
    dir: 'enemy_t8',
    label: 'Guard battalion',
    body: 'enemy_body_t8.png',
    head: 'enemy_head_t8.png',
    helmet: 'helmet_t8.png',
  },
  {
    tier: 9,
    dir: 'enemy_t9',
    label: 'Final defence',
    body: 'enemy_body_t9.png',
    head: 'enemy_head_t9.png',
    helmet: 'helmet_t9.png',
  },
];

const UNIT_SIZE = { width: 128, height: 192 } as const;

function unitSpec(faction: Faction, tier: UnitTierSpec): AssetSpec {
  const dir = `assets/characters/${tier.dir}`;
  return {
    key: `unit.${faction}.t${tier.tier}` as AssetKey,
    label: `${tier.label} (tier ${tier.tier})`,
    layers: [
      { name: 'body', url: `${dir}/${tier.body}` },
      { name: 'head', url: `${dir}/${tier.head}` },
      { name: 'helmet', url: `${dir}/${tier.helmet}` },
    ],
    procedural: faction === 'allied' ? 'unit.allied' : 'unit.enemy',
    proceduralSize: UNIT_SIZE,
  };
}

export const ASSET_MANIFEST: readonly AssetSpec[] = [
  {
    key: 'map.europe',
    label: 'Europe theatre map',
    layers: [{ name: 'map', url: 'assets/maps/europe_blank_laea.svg' }],
    procedural: 'map.europe',
    proceduralSize: { width: 1401, height: 1198 },
  },
  {
    key: 'weapons.atlas',
    label: 'Weapons atlas',
    layers: [{ name: 'atlas', url: 'assets/weapons/guns_0.svg' }],
    procedural: 'weapons.atlas',
    proceduralSize: { width: 512, height: 512 },
  },
  ...ALLIED_TIERS.map((tier) => unitSpec('allied', tier)),
  ...ENEMY_TIERS.map((tier) => unitSpec('axis', tier)),
];

export function findAsset(key: AssetKey): AssetSpec | undefined {
  return ASSET_MANIFEST.find((spec) => spec.key === key);
}
