# Frontline Runner

An offline-first **isometric battlefield** — Age of Empires style — built with
Vite, TypeScript and Canvas 2D, and structured so it can be wrapped in
**@capacitor/core** for iOS/Android later without restructuring.

**Live:** https://xel321123.github.io/frontline-runner/

> **Every structure, figure, tree and terrain tile is drawn at runtime from SVG
> vector paths.** The art is authored as SVG path data (`d` strings) with palette
> tokens and gradients, compiled once into `Path2D` objects and painted
> isometrically. There are no sprite sheets, no character packs, no image
> downloads — the only file the app fetches is the campaign-map SVG behind the
> menu screen. Zero external runtime dependencies, zero network calls.

## The battle

- **The field is a plane, not a lane.** 960 × 560 world units of ground,
  projected 2:1 (`screenX = x − y`, `screenY = (x + y) / 2`), so the camera looks
  down on the battlefield at an angle. Units walk freely in two dimensions.
- **One to five positions per side.** The opening sectors are a duel between two
  positions; by tier 9 each side is holding five. Positions are laid out in each
  side's rear area, spread across the depth of the field, and named — the enemy's
  primary position carries the sector's historical strongpoint name.
- **You choose where from and where to.** Every launch names a launch pad and an
  objective: the HUD carries a *launch from* row and an *attack* row, and tapping
  a position on the field selects it directly.
- **Every position has its own timer.** The v2 pacing rule is per position, not
  global: a pad has to reload after it launches (0.9 s for a rifleman, up to
  8 s for armour), so three positions press on three axes at once instead of
  waiting on one shared cooldown.
- **Destroyed objectives re-task automatically.** When a unit's target position
  is razed it immediately re-aims at the nearest surviving position of that side,
  so a multi-position battle keeps moving instead of stranding troops in an empty
  field.
- **Supplies** are generated continuously at **2 per second**, spent to field
  units. A **Boost Logistics** button buys a permanent in-battle increase
  (+0.6 supplies/s per level, five levels) using **war bonds**, which drop from
  destroyed enemy units (5 / 9 / 15 / 45 by unit type) and are banked whether the
  battle is won or lost.
- **Win/loss:** raze every enemy position to win the sector; lose every one of
  yours and the sector is lost. A 175-second clock decides stalemates on total
  remaining position strength, and a draw counts as a defeat — the attacker has
  to actually take ground.

| Unit | Cost | Behaviour |
| --- | --- | --- |
| **Rifleman** | 20 | Long engagement range, bolt-action rate of fire — holds a fire line |
| **SMG Assault** | 35 | Fast advance, high fire rate, but has to close to 90 units to use it |
| **MG Gunner** | 55 | Digs in behind sandbags when it stops and suppresses what it hits (−45 % movement) |
| **Tank** | 140 | Slow, 430 hp with 6-point armour, lobs an arcing shell with a 48-unit blast |

## The isometric view

The renderer is a single camera over a ground plane:

- **Ground pass** — terrain tiles, roads, trench lines, mine belts and the river
  crossing are drawn *through the camera with the isometric basis applied*, so
  that artwork is authored in world coordinates and lands correctly projected.
- **Upright pass** — structures, trees, troops, wreckage, corpses, shots and
  debris are drawn in screen space at a projected anchor, sorted back-to-front by
  `x + y` (the painter's algorithm for this projection), so a soldier standing
  behind a building is drawn behind it.
- **Atmosphere pass** — precipitation, the darkness of a night battle, sweeping
  searchlight beams and the corner vignette are drawn in screen space over the
  whole viewport, whatever the zoom.
- **Heights are real.** `z` exists for anything that leaves the ground: shell
  arcs, thrown debris, brass, helmets. Screen shake is applied to both the ground
  and every projected anchor, so ground and troops never separate in a barrage.

Nothing is letterboxed: the camera spans the whole viewport at every aspect ratio
and crops ground instead of adding bars. Zoom 1 fits the *playable* field rather
than the empty corners of the plane's diamond.

## Natural movement

Units are rigged, not stamped: separate SVG parts (legs with knee joints, arms,
torso, head, helmet, weapon, pack) are posed every frame around named joints.

| State | What the rig does |
| --- | --- |
| **Walking** | Thigh swing with a lagging shin, opposing arm swing, a bob at twice the stride frequency, feet planted — the walk cycle is driven by *distance travelled*, so a unit that stops mid-stride stops mid-stride |
| **Idle** | Breathing, a small weight shift, a helmet glint — never frozen |
| **Firing** | Weapon pulled into the shoulder, torso rotated toward the aim, muzzle point tracked so the flash lands on the barrel |
| **Suppressed / dug in** | Crouched stance; the MG gunner goes down behind its bipod with the belt fed from a box |
| **Heading** | The whole figure rotates up to ±18° with its world heading, so a unit walking into or out of the screen reads as such |
| **Tanks** | An isometric hull and separate track runs whose road wheels turn with the stride, a turret that follows the heading, recoiling main gun, stowage, exhaust smoke that thickens as the tank is worn down |

Movement itself is a steering model: head for the objective, push clear of the
same-side neighbours (which is what stops a squad rendering as one sprite), walk
around buildings rather than through them, and funnel through a bridge span when
the river is in the way.

## Tactical environments

Every one of the 60 campaign nodes is authored with its own tactical shape — how
it is won, what the weather does, what terrain it is fought over and how supplies
are flowing — and the isometric view is lit and painted to match. These are
history rather than decoration: El Alamein was a minefield in the desert, Arnhem
was a bridge, Bastogne was snow, Seelow was attacked at night behind
searchlights.

| Environment | Battlefield effect | Scene |
| --- | --- | --- |
| **Snow** (Moscow, Bastogne) | all ground units move **35% slower** | white-out ground with wind-scoured gravel, laden pines, falling snow |
| **Desert** (El Alamein, Tobruk) | maximum weapon engagement range is **halved** | dune ripples, palms, drifting sand streaks, warm haze |
| **Mud** (Kursk, Rzhev) | armour costs **+50%**, vehicles traverse **40% slower** | churned ground with standing water that catches the sky, rain |
| **Night** (Dieppe, Seelow) | units caught in a searchlight beam take **+50% damage** | darkened scene, moonlight on the crowns, beams sweeping the field |
| **Temperate** | no modifiers | a worn dirt track with cart ruts across the middle of the field |

| Feature | Effect |
| --- | --- |
| **Trenches** | dugout bands lying across the direction of advance; infantry that stop inside take **−70% projectile damage** until the position is overrun by the other side |
| **Minefield** | marked belts of buried mines; anything crossing sets one off for a burst of casualties and consumes it (neutral — they take whoever goes first) |
| **Bridge chokepoint** | a river across the field with one span: units outside the span's band are held on the bank and only **four per side** fit on the deck, funnelling an attack into a column |

| Mission | Win condition |
| --- | --- |
| **destroy_base** | raze every enemy position |
| **assault** | raze a *reinforced* line (×1.25 hp, and a position more than usual) — the attacker has stockpiled supplies |
| **survive_timer** | hold your positions for 120 seconds; the enemy is the attacker and is reinforced, you are dug in with your dumps |

Supply flow is per node too (`supplyRateMultiplier`, 0.7 for a besieged force up
to 1.4 for a blitzkrieg), and the briefing modal, the camp screen and the map all
report the real in-battle figure rather than the base one.

## The end-of-battle splash

When a sector resolves, a full-screen splash appears by itself — no modal to
dismiss, no need to press Abort to find out how the battle went. It carries the
verdict (SECTOR SECURED / GROUND HELD / POSITION LOST / PUSH REPELLED), the
numbers behind it, and a **per-position breakdown**: every hostile position and
its fate, every friendly position and its fate, each with its remaining strength.
From there the player goes straight on to the next sector, retries, opens the
camp, or returns to the map, and the battlefield stays frozen on screen behind it.

The old **Abort** button is gone. It existed only because there was no other way
to end a level, and the splash has taken that job. The one control that remains
is a subdued **⚐ withdraw**: it resolves the sector there and then and hands the
outcome to the same splash (reading *you pulled out with N of M positions still
standing*), so leaving a lost battle early still produces a report instead of
dropping you on the map with nothing to read. It needs two presses inside four
seconds — the first arms it and it reads `sure?` — so it cannot be triggered by a
stray tap at the edge of the HUD. `Escape` during a battle follows the same
two-press path.

## Screens

| Screen | What it does |
| --- | --- |
| **Title** | Faction selection (Allies / Axis) with per-campaign totals, sound toggle, collapsible diagnostics |
| **Campaign map** | The Europe SVG with all 30 node coordinates plotted: **grey** locked, **gold** next objective, **green** cleared, **red** contested, each labelled with its weather glyph, plus a key for what each environment does |
| **Briefing modal** | Authentic two-sentence history, theatre, grid reference, mission type, how many positions each side holds, weather and its modifier, terrain features, the sector's real supply rate, difficulty tier, reward and the node's own record, with a Deploy button |
| **Camp / Armoury modal** | War bonds buy three permanent tracks — **unit health**, **attack damage**, **base fortification** — alongside the resulting loadout figures (supplies at deploy, positions in this sector, total position hit points, damage and unit HP multipliers) and the full unit roster with live stats |
| **Battle** | The isometric battlefield itself, full-bleed, with a DOM HUD over it |
| **Splash** | The end-of-battle report described above |

## Play

`npm run dev` (or the deployed site), pick a side, then deploy a sector.

| Control | Action |
| --- | --- |
| `1` `2` `3` `4` | Launch a rifleman / SMG / MG / tank from the selected position |
| `Tab` | Cycle your launch pads |
| `Q` / `E` | Cycle the enemy objective backwards / forwards |
| pointer tap | Tap any position on the field to select it (yours = launch pad, theirs = objective) |
| drag | Pan the field |
| `U` | Buy the next logistics upgrade |
| `P` | Pause |
| `Z` | Toggle close-action zoom |
| `ESC` | Abandon the battle, or close the splash |

**Display:** full-bleed at any viewport and aspect ratio; no letterboxing, no
fixed internal resolution. The manifest locks landscape for installed PWAs.

## Audio

Every sound is synthesised at runtime with the Web Audio API from oscillators,
filtered noise bursts and envelopes — no audio files, nothing to download, and
nothing that can fail to cache. Each weapon keeps a distinct signature, because
in a battle where you are watching six things at once the mix is often the only
tell for what is actually on the line:

| Sound | Design |
| --- | --- |
| **Rifle** | hard broadband crack, thin dry tail, almost no body |
| **SMG** | brighter, drier, very short — rapid fire reads as a burp |
| **MG** | heavier thud with real low-end push and a longer tail |
| **Tank shell** | cannon blast with a breech clank right behind it |
| **Ricochet** | metallic ping that falls away with a buzz, on rounds that ring off armour |
| **Explosion** | long low rumble with a debris crackle on top; mine blasts are dirtier and lower |

A compressor on the master bus keeps stacked explosions from clipping a phone
speaker, and every sound has its own throttle and voice budget so six machine
guns firing at once cannot turn into one clipped rasp. The header toggle
(**sound off / sound on**) is persistent: it writes `settings.muted` into the
save file, so a muted player stays muted across reloads and offline sessions.

## Architecture

```
src/data/       pure historical data: 60 campaign nodes + 14 weapons.
                NO DOM, NO window, NO localStorage.
src/core/       pure domain: types, campaign/economy tables, upgrade tracks,
                and the BattleOutcome report the splash renders.
src/game/       PURE simulation: constants, seeded rng, unit table, 2-D feature
                layout, environment rules, position layout + TugSimulation.
                No DOM — runs in plain Node.
src/render/iso/ the art and projection layer: iso.ts (projection, isoBox),
                paint.ts (SVG path painter + palette tokens), contracts.ts (the
                seam between renderer and artwork), then terrain, groundFeatures,
                structures, figures, props, scatter, effects, atmosphere.
src/render/     BattleRenderer: camera passes and the depth-sorted draw queue.
src/engine/     subsystems behind interfaces: save file, procedural audio, input.
src/platform/   the ONLY place that touches document / window / localStorage.
src/app/        shell.ts (screens, navigation, battle lifecycle, splash) +
                screens.ts (markup) + splash.ts (end-of-battle splash) +
                BattleHud.ts (DOM HUD) + Match.ts (the fixed-step battle loop).
src/main.ts     the only file that knows it is a browser page.
```

The simulation emits typed events (`deploy`, `shot`, `explosion`, `retarget`,
`baseDestroyed`, `victory`…) rather than playing sounds itself, which is what
keeps it testable in Node. Visual game feel — particles, casings, debris arcs,
shake — is simulation state too, so the renderer stays a pure function of the
state and the effects stay deterministic enough to assert on.

## Progression & offline

Everything persists to one `localStorage` key (`frontline-runner:save:v1`):
faction, unlocked sectors, war bonds, upgrade levels, per-node records
(wins/losses/units lost/best kills) and settings. Bonds banked on the field are
added even after a defeat, so a loss still moves the campaign forward. The three
upgrade tracks all feed the battle: **Unit Health**, **Damage** and
**Fortification**.

Nothing else is stored, and **the game makes no network calls at all**: the
service worker precaches the app shell for offline play, and a resource audit
during a live battle shows every request same-origin.

## Verifying

```bash
npm install
npm run dev           # http://localhost:5173/frontline-runner/
npm run check:data    # validate the campaign/weapon database
npm run check:sim     # headless mechanics + position/targeting rules + balance + µs/tick
npm run check:save    # all 60 stages: reachable, clearable, losable, persisted
npm run check:viewport # buffer/DPR sizing and the isometric camera's framing
npm run typecheck     # tsc --noEmit, strict
npm run build         # typecheck + PWA build + 404 fallback
```

`npm run check:sim` runs the real `TugSimulation` in Node: it asserts the
per-position layout rules, the economy, the launch rules (including that two
positions can fire in the same moment and that a pad's own timer blocks only that
pad), automatic re-tasking when an objective is razed, the environment and
terrain modifiers, engagement ranges, shell arcs and blast falloff, suppression,
dig-in, mine belts, bridge capacity, the win/loss conditions and seed
reproducibility — and then plays whole campaign nodes with three autopilots
(do-nothing, steady riflemen, mission-aware adaptive) across every mission type,
environment and terrain feature. The bracket: **do-nothing must lose every node,
the adaptive autopilot must win a clear majority, and the simulation must stay far
inside the 16.6 ms frame budget.**

`npm run check:save` walks **every one of the sixty nodes** through the real
storage layer: each must be reachable in order, clearable (bonds banked, next
node unlocked, record written), losable (recorded, nothing unlocked, no bonds),
and must survive a write → read round trip through the same normalisation path
`localStorage` uses — including legacy four-track saves from the previous
armoury, which migrate onto the current three.

### Measured, not asserted

The numbers below come from the checks on a development machine (Node 22.23,
headless Chromium at 1280x577), not from adjectives:

| Measurement | Result |
| --- | --- |
| Simulation cost | **mean 55.5 us, max 792 us per tick** — 0.33 % of a 16.6 ms frame |
| App cost per frame (sim + every canvas draw call, ~150 props on screen) | **p50 3.1 ms, p95 6.5 ms** |
| Viewport / DPR / isometric camera | 97 / 97 checks |
| Campaign progression through the real save layer | 815 / 815 checks |
| Autopilot bracket | do-nothing loses every sampled sector; the adaptive autopilot wins the large majority; the naive rifle flood sits between |

## Deployment

`.github/workflows/deploy.yml` runs on every push to `main`: install → typecheck
→ `vite build` (PWA + `404.html` fallback) → upload `dist/` → publish to GitHub
Pages. `base` is `/frontline-runner/` to match the project path;
`npm run build:native` switches to relative paths for a Capacitor bundle.

## Next step

Polish and content: veterancy for surviving units, doctrine choices before a
launch, artillery support off the map edge, position-specific artwork per
theatre, and an optional cloud sync behind the same `KeyValueBackend` seam.
