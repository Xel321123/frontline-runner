# Frontline Runner

An offline-first, landscape-locked WW2 **tug-of-war battlefield** — Age of War /
Battle Cats style — built with Vite, TypeScript and Canvas 2D, and structured so
it can be wrapped in **@capacitor/core** for iOS/Android later without
restructuring.

**Live:** https://xel321123.github.io/frontline-runner/

> **Every unit, structure and terrain layer is drawn at runtime from Canvas 2D
> path primitives.** There are no sprite sheets, no character packs, no image
> downloads — the only file the app loads is the campaign-map SVG behind the menu
> screen. Zero external runtime dependencies, zero network calls.

## The battle

- **Layout:** your base sits at the left edge (x = 50), the enemy strongpoint at
  the right edge (x = 1230), one horizontal lane between them.
- **Supplies:** generated continuously at **2 per second**, spent to field units.
  A **Boost Logistics** button in the deployment bar buys a permanent in-battle
  increase (+0.6 supplies/s per level, five levels) using **war bonds**.
- **War bonds** drop from destroyed enemy units (5 / 9 / 15 / 45 by unit type)
  and are banked whether the battle is won or lost.
- **The line:** deployed units march toward the enemy, stop automatically the
  moment a hostile comes into range, and trade fire until one side is gone.

| Unit | Cost | Behaviour |
| --- | --- | --- |
| **Rifleman** | 20 | Long engagement range, bolt-action rate of fire — holds a fire line |
| **SMG Assault** | 35 | Fast advance, high fire rate, but has to close to 140 px to use it |
| **MG Gunner** | 55 | Medium cost, plants sandbags when it stops and suppresses what it hits (−45 % movement) |
| **Tank** | 140 | Slow, 430 hp with 6-point armour, lobs an arcing shell with a 78 px blast |

- **Win/loss:** destroying the enemy strongpoint wins the sector; losing your own
  base loses it. A 3-minute clock decides stalemates on remaining base health,
  and a draw counts as a defeat — the attacker has to actually take ground.

## Tactical environments

Every one of the 60 campaign nodes is authored with its own tactical shape —
how it is won, what the weather does, what terrain it is fought over and how
supplies are flowing. These are history rather than decoration: El Alamein was a
minefield in the desert, Arnhem was a bridge, Bastogne was snow, Seelow was
attacked at night behind searchlights.

| Environment | Battlefield effect | Scene |
| --- | --- | --- |
| **Snow** (Moscow, Bastogne) | all ground units move **35% slower** | white-out ground, falling snow, flat cold light |
| **Desert** (El Alamein, Tobruk) | maximum weapon engagement range is **halved** | sandstorm haze, drifting sand streaks, bleached ochre ground |
| **Mud** (Kursk, Rzhev) | armour costs **+50%**, vehicles traverse **40% slower** | churned brown ground, standing water, ground mist |
| **Night** (Dieppe, Seelow) | units caught in a searchlight beam take **+50% damage** | darkened scene with animated sweeping beams and lit pools |

| Feature | Effect |
| --- | --- |
| **Trenches** | dugout zones in no-man's-land; infantry that stop inside take **−70% projectile damage** until the position is overrun by the other side |
| **Minefield** | marked belts of buried mines; anything crossing sets one off for a burst of casualties and consumes it (neutral — they take whoever goes first) |
| **Bridge chokepoint** | a narrow span (Arnhem, Remagen, the Dnieper, Narva) that holds only **three units per side** at a time, funnelling an attack into a column |

| Mission | Win condition |
| --- | --- |
| **destroy_base** | break the strongpoint |
| **assault** | break a *reinforced* strongpoint (×1.25 hp) — the attacker has stockpiled supplies for the push |
| **survive_timer** | hold your own base for 120 seconds; the enemy is the attacker and is reinforced, you are dug in with your dumps |

Supply flow is per node too (`supplyRateMultiplier`, 0.7 for a besieged force up
to 1.4 for a blitzkrieg), and the briefing modal, the camp screen and the map all
report the real in-battle figure rather than the base one.

## Screens

| Screen | What it does |
| --- | --- |
| **Title** | Faction selection (Allies / Axis) with per-campaign totals, sound toggle, collapsible diagnostics |
| **Campaign map** | The Europe SVG with all 30 node coordinates plotted: **grey** locked, **gold** next objective, **green** cleared, **red** contested, each labelled with its weather glyph, plus a key for what each environment does. Clicking a node opens its briefing |
| **Briefing modal** | Authentic two-sentence history, theatre, grid reference, mission type, weather and its modifier, terrain features, the sector's real supply rate, difficulty tier, reward and the node's own record, with a Deploy button |
| **Camp / Armoury modal** | Supplies at deploy, base hit points, damage and rate-of-fire multipliers, the full unit roster with live stats, and the upgrade tracks bought with war bonds |
| **Result modal** | Bonds awarded and collected, units deployed and lost, enemy destroyed, logistics bought, and both structures' remaining strength |
| **Battle** | The tug of war itself, letterboxed into the available space |

## Play

`npm run dev` (or the deployed site), pick a side, then deploy a sector.

| Control | Action |
| --- | --- |
| `1` `2` `3` `4` | Field a rifleman / SMG / MG / tank |
| `U` | Buy the next logistics upgrade |
| `P` | Pause |
| `ESC` | Close the panel / abandon the battle |
| `Enter` (at the map) | Deploy the current sector |
| pointer | Click any deployment-bar slot or the logistics button |

**Display:** fixed **1280×720** internal resolution, 16:9 locked, letterboxed
into any canvas size; the manifest locks landscape for installed PWAs.

## Rendering (all procedural)

- **Silhouettes:** Allied troops wear olive drab and khaki under the **Brodie**
  helmet, re-kitted with the **M1** from tier 6 onward; Axis troops wear feldgrau
  under the **Stahlhelm**. Helmet shape — not colour alone — is what separates
  the two armies at 44 px tall.
- **Multi-layer parallax:** a dusk sky with a low sun and drifting cloud bands, a
  distant hill ridge, ruined buildings and a church tower with animated smoke
  columns, a mid-ground of broken walls and dead trees, and a detailed
  foreground ground plane (worn track, craters, grass, barbed wire, spent
  materiel). Each layer shifts by its own depth factor as the battle's centre of
  mass moves.
- **Game feel:** oval drop shadows under every figure and vehicle, muzzle-flash
  bursts with propellant smoke, ejected brass casings that arc and spin, impact
  spark bursts, dust and debris, smoke that hangs behind the troops, scorch
  patches and burning wrecks on damaged tanks, growing cracks and roof smoke on
  a shelled strongpoint, and deterministic screen shake on every shell blast.
- **Strongpoints:** concrete emplacement with an overhanging roof slab, an
  embrasure and defensive gun that fires, a sandbag parapet, a waving flag, and
  damage that accumulates visibly as its hit points fall.

## Architecture

```
src/data/       pure historical data: 60 campaign nodes + 14 weapons.
                NO DOM, NO window, NO localStorage.
src/core/       pure domain: types, campaign/economy tables, upgrade tracks.
src/game/       PURE simulation: constants, seeded rng, unit table, HUD layout,
                match config, TugSimulation. No DOM — runs in plain Node.
src/render/     Canvas 2D only: palette, battlefield layers, figures, effects,
                BattleRenderer. Reads a state snapshot, never mutates it.
src/engine/     subsystems behind interfaces: save file, procedural audio, input.
src/platform/   the ONLY place that touches document / window / localStorage.
src/app/        shell.ts (screens, navigation, battle lifecycle) +
                screens.ts (markup) + Match.ts (the fixed-step battle loop) +
                dom.ts.
src/main.ts     the only file that knows it is a browser page.
```

The simulation emits typed events (`deploy`, `shot`, `explosion`, `unitDown`,
`victory`…) rather than playing sounds itself, which is what keeps it testable
in Node. Visual game feel — particles, casings, shake — is simulation state too,
so the renderer stays a pure function of the state.

## Progression & offline

Everything persists to one `localStorage` key (`frontline-runner:save:v1`):
faction, unlocked sectors, war bonds, upgrade levels, per-node records
(wins/losses/units lost/best kills) and settings. Bonds banked on the field are
added even after a defeat, so a loss still moves the campaign forward. The four
upgrade tracks all feed the battle: **Starting Supplies**, **Damage**,
**Fire Rate** and **Fortifications**.

Nothing else is stored, and **the game makes no network calls at all**: the
service worker precaches 17 entries (~1.5 MiB) for offline play, and a resource
audit during a live battle shows every request same-origin.

## Verifying

```bash
npm install
npm run dev          # http://localhost:5173/frontline-runner/
npm run check:data   # validate the campaign/weapon database
npm run check:sim    # headless battle mechanics, autopilot brackets, µs/tick
npm run typecheck    # tsc --noEmit, strict
npm run build        # typecheck + PWA build + 404 fallback
```

`npm run check:sim` runs the real `TugSimulation` in Node through
`scripts/simulate-match.mjs`: it asserts every documented mechanic (the supply
rate, the logistics purchase, deployment costs, units stopping at range, the
tank's arcing area blast and screen shake, the MG digging in and suppressing,
bond drops, base destruction deciding the battle, and seed reproducibility) and
then plays whole campaign nodes with three autopilots — do-nothing, steady
riflemen, and a mission-aware adaptive one. The bracket: **do-nothing must lose
every node, adaptive must win the sampled nodes, and the simulation must stay far
inside the 16.6 ms frame budget** (measured 2–6 µs per tick). The sample covers
every mission type, all five environments and all three terrain features, and the
environment rules, the trench/searchlight damage stacking and the mine belts are
asserted directly rather than inferred.

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main`: install → typecheck
→ `vite build` (PWA + `404.html` fallback) → upload `dist/` → publish to GitHub
Pages. `base` is `/frontline-runner/` to match the project path;
`npm run build:native` switches to relative paths for a Capacitor bundle.

## Next step

Polish and content: a loadout/doctrine choice before deploying, per-node art
passes (weather, snow at Stalingrad, desert at El Alamein), boss variants
(tank park, artillery battery), veterancy for surviving units, and an optional
cloud sync behind the same `KeyValueBackend` seam.
