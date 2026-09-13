# Frontline Runner

An offline-first, landscape **PWA** built with Vite + TypeScript + Canvas 2D,
structured so it can be wrapped in **@capacitor/core** for iOS/Android later
without restructuring.

> **Status: step 2 — campaign and weapon database.** Step 1 delivered the
> scaffold, PWA/offline setup, asset pipeline and engine subsystems; step 2 adds
> the 60-node historical campaign and the 14-weapon stat database. **There is
> still no gameplay loop** — the boot screen is a static systems/data check that
> plots the campaign coordinates over the real theatre map.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/frontline-runner/
npm run check:data   # validate the campaign/weapon database
npm run build        # typecheck + PWA build + 404 fallback
npm run preview      # serve dist/ at http://localhost:4173/frontline-runner/
npm run icons        # regenerate public/icons/*.png
npm run build:native # relative-base build for Capacitor
```

## Campaign & weapon database

`src/data/campaignData.ts` is the single source of truth — pure data, no
balance maths:

- **60 campaign nodes**, 30 per faction, in `ALLIED_CAMPAIGN` / `AXIS_CAMPAIGN`,
  each `{ id, name, year, theater, coords, bossName, bossHp, briefing }`.
  Ids are `allied-01`…`allied-30` / `axis-01`…`axis-30`, ordered, and the id is
  what the save file stores.
- **`coords`** are percentages of the theatre map (0–100, origin top-left) and
  line up with `public/assets/maps/europe_blank_laea.svg` — the boot frame plots
  them to prove it.
- **14 weapons** (`ALLIED_WEAPONS` / `AXIS_WEAPONS`) with `id, name, faction,
  damage, fireRate, spread, minLevel` plus `caliber, year, magazineSize,
  reloadTime, automatic`. `minLevel` is the campaign node that unlocks the
  weapon. The brief's final slot ("M2 Browning/Bazooka",
  "Panzerschreck/Flammenwerfer 35") ships as two entries each, because a
  belt-fed HMG and a rocket launcher cannot share one stat block.
- **Briefings** are exactly two sentences of neutral military history per node —
  the data checker enforces the count.

`src/core/progression.ts` layers balance on top: enemy tier per node from the
shipped character-pack tiers, war bonds rising 60 → 495 per campaign, the
upgrade tracks, and `isStageId` / `nextStageId`, which follow the node's own
campaign so clearing `allied-30` does not unlock an Axis node.

`npm run check:data` imports the real TypeScript modules and asserts the whole
contract: 30 + 30 nodes, id format and ordering, coords inside the map, two
sentences per briefing, monotonic boss HP and rewards, sane weapon stats, and
correct progression wiring. It is deliberately not part of `npm run build`
because it relies on Node's built-in TypeScript support.

## Architecture

```
src/
  data/        historical database: 60 campaign nodes + 14 weapons
               (pure data, no balance logic, no DOM)
  core/        pure domain: types, campaign/economy tables, asset manifest
               (no DOM, no browser globals — unit-testable in Node)
  engine/      subsystems behind interfaces
      Storage.ts            typed save file (faction, unlocked stages,
                            war bonds, upgrades) over an injectable backend
      SoundManager.ts       procedural Web Audio synth: shot, hit, explosion,
                            uiClick, uiBack, reload + global mute
      AssetLoader.ts        manifest loader, per-sprite fallback, load report
      ProceduralSprites.ts  Canvas 2D fallback painters (map, weapons, units)
  platform/    the only DOM-aware layer
      KeyValueStore.ts      localStorage backend + in-memory fallback
      images.ts             canvas/Image primitives, decode with timeout
      Display.ts            canvas surface, DPR, resize, landscape lock
  app/Boot.ts  composition root — wires the above, static systems-check frame
  main.ts      web entry point
```

Rules that keep the native port a drop-in: `core/` imports nothing platform-y,
`engine/` never imports `app/`, and only `platform/` touches `document`,
`window`, `screen` or `localStorage`. See
[docs/NATIVE_PORTABILITY.md](docs/NATIVE_PORTABILITY.md).

## PWA / offline

- `vite-plugin-pwa` with `registerType: 'autoUpdate'` (a new deploy takes over
  on the next load — no update prompt code).
- **Full offline precache** of the shell plus every static asset: the 97
  character parts, the weapons atlas and the 1.5 MB theatre map
  (`maximumFileSizeToCacheInBytes` raised to 8 MiB for that reason).
- `orientation: 'landscape'` in the manifest, plus a `screen.orientation.lock`
  attempt from the ⛶ button (browsers require fullscreen; iOS ignores it and
  native shells lock via Info.plist / AndroidManifest — documented in
  `docs/NATIVE_PORTABILITY.md`).
- `dist/404.html` is written after every build so deep links and offline
  navigations resolve to the app shell on GitHub Pages.

Live site: <https://xel321123.github.io/frontline-runner/> (after the first
workflow deploy completes).

## Assets & the procedural fallback guarantee

`public/assets/` ships third-party art (see [CREDITS.md](CREDITS.md) — the map
is CC BY-SA 3.0 and the weapons SVG licence is **unverified**).

`AssetLoader` treats every manifest entry as optional: if a file is missing,
corrupt, blocked by a proxy or takes longer than 10 s to decode, that sprite is
replaced by a deterministic Canvas 2D fallback (`ProceduralSprites.ts`) and the
failure is listed on the boot screen with its reason. **The game is always
drawable**, which is also what makes the unverified weapons licence non-blocking.

## Save data

`GameStorage` persists `{ version, faction, unlockedStages, warBonds, upgrades,
settings, updatedAt }` under `frontline-runner:save:v1`:

- zero network access — local storage only;
- every read is re-validated and clamped, so a hand-edited or truncated save
  can't crash the boot;
- immutable snapshots (`snapshot()`) so game code can't mutate persisted state;
- versioned with a migration hook, plus `exportJson()` / `importJson()` for
  moving a campaign between web and native;
- falls back to an in-memory store (and says so on the boot screen) when
  storage is unavailable, e.g. Safari private mode.

## Audio

All sound is synthesised at runtime (`SoundManager`): noise bursts and swept
filters for shots/hits/explosions, short blips for UI. No audio files, nothing
to cache, nothing to license. The context is created on the first user gesture
(browser autoplay policy) and every `play()` is a safe no-op before that.

## Next step

Step 3: the gameplay loop (renderer, entities, input) consuming this scaffold —
`AssetLoader.all()` for sprites, the campaign node's `tier` for enemy art,
`GameStorage` for progression, `SoundManager` for feedback, and the weapon
table for loadouts.
