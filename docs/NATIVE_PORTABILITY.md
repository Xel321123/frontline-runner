# Native portability (iOS / Android via Capacitor)

This project is written **web-standard-only** so a Capacitor shell can be
dropped in later without restructuring a single module. This document is the
contract that keeps that true, plus the exact steps to add native targets.

## 1. Layer rules (enforced by imports, checked in review)

```
src/data/       pure historical data (campaign nodes, weapon stats).
                NO DOM, NO window, NO localStorage, NO AudioContext.
src/core/       pure data + pure functions.
                NO DOM, NO window, NO localStorage, NO AudioContext.
src/game/       pure simulation: fixed 1/60 s steps, seeded level layout,
                entities, loadout maths. Headless-testable in Node
                (`npm run check:sim`) — NO DOM, NO AudioContext.
                    ▲                    ▲
src/engine/     subsystems behind interfaces: save file, audio synth, asset
                loading, procedural sprites, input. Uses Canvas 2D / Web Audio
                (both available in every WebView) but never DOM layout.
                    ▲
src/render/     Canvas 2D drawing only: parallax, sprite compositing, HUD.
src/platform/   the ONLY place that touches document / window / screen /
                localStorage / ResizeObserver.
                    ▲
src/app/        composition root: `shell.ts` (screens, navigation, run
                lifecycle) + `screens.ts` (markup) + `Play.ts` (run loop).
src/main.ts     the only file that knows it is a browser page.
```

`data/`, `core/` and `game/` import only each other; `engine/` never imports
from `app/` or `main.ts`. That is what makes the game logic testable in plain
Node and portable verbatim.

## 2. The one thing a native build must swap: the storage backend

`engine/Storage.ts` depends on the `KeyValueBackend` interface
(`src/platform/KeyValueStore.ts`), not on `localStorage`:

```ts
import { Preferences } from '@capacitor/preferences';
import type { KeyValueBackend } from './platform/KeyValueStore';

const nativeBackend: KeyValueBackend = {
  id: 'capacitor-preferences',
  persistent: true,
  get:  () => null,                       // sync API is required by Storage,
  set:  (k, v) => { void Preferences.set({ key: k, value: v }); },
  remove: (k) => { void Preferences.remove({ key: k }); },
};
```

`Preferences` is async while the interface is sync. Two clean options:

1. Keep `localStorage` — it works in the Android/iOS WebView and is persistent
   (this is what most Capacitor games do). **Recommended, zero code change.**
2. If you want the OS-level store, call `Preferences.get` once at startup,
   prime a `createMemoryBackend()` with the loaded values, and pass that to
   `createGameStorage({ backend })`; subscribe to storage changes and write
   through to `Preferences` on a debounce. The save logic itself is untouched.

Save portability between platforms is built in: `storage.exportJson()` /
`storage.importJson()` move a campaign between web and native.

## 3. Audio, canvas and assets need no changes

| Concern | Why it ports unchanged |
| --- | --- |
| Audio | `SoundManager` synthesises everything with `AudioContext` — no files, no fetch, no codec. Web Audio works in WKWebView and Android WebView. |
| Rendering | Canvas 2D only, sized from the container; `platform/Display.ts` already handles DPR + safe areas via CSS `env()`. |
| Assets | Loaded through `HTMLImageElement` from `import.meta.env.BASE_URL`. `npm run build:native` sets `VITE_BASE=./` so every URL is relative to the WebView's `index.html`. |
| Offline | Native builds are already offline; the service worker is simply absent and `describeServiceWorker()` reports it as such. No code branches required. |

## 4. Adding the shells

```bash
# 1. Relative base so the WebView can load dist/ from the filesystem
npm run build:native

# 2. Add Capacitor
npm i @capacitor/core @capacitor/cli
npx cap init "Frontline Runner" com.example.frontlinerunner --web-dir=dist

# 3. Targets
npm i @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android
npx cap sync
```

Then lock orientation and go immersive in the native config — the web manifest
cannot do this reliably on iOS:

- **iOS** — `ios/App/App/Info.plist`:
  `UISupportedInterfaceOrientations` → `UIInterfaceOrientationLandscapeLeft`,
  `UIInterfaceOrientationLandscapeRight`; add
  `UIViewControllerBasedStatusBarAppearance = false` and
  `UIStatusBarHidden = true`.
- **Android** — `android/app/src/main/AndroidManifest.xml`: on the main
  activity, `android:screenOrientation="sensorLandscape"` and a fullscreen
  theme.
- Optional: `@capacitor/status-bar` to hide the status bar, and
  `@capacitor/splash-screen` for a native splash.

## 5. Pre-flight checklist before shipping native

- [ ] `npm run build:native` and confirm `dist/index.html` references
      `./assets/...` (relative), not `/frontline-runner/...`.
- [ ] `grep -r "localStorage\\|document\\.\\|window\\." src/core src/engine` returns
      only comment hits — no real platform coupling leaked upward.
- [ ] Rotate the device: the canvas resizes and nothing is clipped by the notch
      (safe-area padding is already applied in `src/style.css`).
- [ ] Tap once, then confirm the audio state reads `running` on the boot panel.
- [ ] Confirm the save survives a full app kill (not just a reload).
