# Frontline Runner

An offline-first, landscape **PWA** built with Vite + TypeScript + Canvas 2D,
structured so it can be wrapped in **@capacitor/core** for iOS/Android later
without restructuring.

> **Status: step 3 — the runner engine is playable.** Step 1 delivered the PWA
> scaffold, asset pipeline and engine subsystems; step 2 the historical campaign
> and weapon database; step 3 the side-scrolling run itself (parallax, squad,
> hazards, crates, math gates, end-zone bunker) with progression wired back into
> the save file.

## Play

`npm run dev` (or the deployed Pages site), pick a faction, then **deploy**.

| Control | Action |
| --- | --- |
| drag / pointer | the squad lerps to the pointer's Y (vertical only) |
| `W`/`S`, `↑`/`↓` | keyboard equivalent |
| `R` | redeploy a fresh run |
| `ESC` | back to base |
| `Enter` (at base) | deploy |

- **Display:** fixed **1280×720** internal resolution, 16:9 locked, letterboxed
  into any canvas size; manifest locks landscape for installed PWAs.
- **Parallax:** sky, hills, ruins, treeline and ground scroll right-to-left at
  different rates, all drawn procedurally per tile (nothing to download).
- **Squad:** anchored at 18% from the left, auto-fires right, and carries the
  best weapon its campaign progress has unlocked.
- **Hazards:** mines −3 troops, razor wire −1 troop/second while inside the
  field, enemy infantry 1:1 on contact. Shooting infantry kills them first.
- **Crates & gates:** crates show a counter (+1, +3 …) that rises when shot;
  passing one deploys that many paratroopers. Math gates (`+N`, `xN`, `-N`, `÷N`)
  sit in stacked bands — your lane decides which one you pass, and shooting a
  gate always improves it. A divider can reduce you but never wipes you.
- **End zone:** scrolling stops, the bunker/strongpoint is engaged, and the
  squad converges fire on it until it is destroyed or the timer runs out.
- **Progression:** a win awards the node's war bonds, unlocks the next sector,
  and the bonds buy upgrade tracks at base (firepower, armour, mobility, medkit).

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173/frontline-runner/
npm run check:data   # validate the campaign/weapon database
npm run check:sim    # headless balance, mechanics and performance checks
npm run build        # typecheck + PWA build + 404 fallback
npm run preview      # serve dist/ at http://localhost:4173/frontline-runner/
npm run icons        # regenerate public/icons/*.png
npm run build:native # relative-base build for Capacitor
```

## Engine

The run is a deterministic fixed-timestep simulation, so it can be tested
without a browser:

```
src/engine/Input.ts      vertical pointer/drag control (+ keyboard), reports a
                         target only — smoothing lives in the simulation
src/game/                pure simulation: constants, seeded rng, level layout,
                         entities, Simulation, loadout
src/render/              Canvas 2D: parallax Background, UnitSprites (crops and
                         composites the character parts), RunRenderer + HUD
src/app/Play.ts          the run loop: rAF + 1/60 s fixed steps, input, audio
                         policy, win/lose → save file
```

`npm run check:sim` runs the real `Simulation` in Node with three autopilots
(superhuman, human-reaction, do-nothing) over live campaign nodes, asserts every
documented mechanic one by one, and reports the cost per simulated tick
(~20 µs against a 16.6 ms frame budget). It is how the balance numbers in
`src/game/constants.ts` are set.

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

Polish and content: more weapons/loadout choice, per-node art passes, boss
variants (tank vs bunker), and a settings screen for volume and control
sensitivity. The engine boundaries are in place so any of those is additive.
