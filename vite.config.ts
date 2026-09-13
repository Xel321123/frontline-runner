import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * GitHub Pages serves this app from https://<owner>.github.io/frontline-runner/,
 * so `base` must match the repo name — it is prefixed onto every asset URL, the
 * injected manifest link and the service-worker registration.
 *
 * Native shells (Capacitor) need a relative base instead:
 *   VITE_BASE=./ npm run build
 * which keeps every URL relative to the WebView's index.html with no further
 * code changes (see docs/NATIVE_PORTABILITY.md).
 */
const base = process.env.VITE_BASE ?? '/frontline-runner/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  plugins: [
    VitePWA({
      // `autoUpdate`: a new deployment takes over on next load, no prompt code.
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon-32.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Frontline Runner',
        short_name: 'Frontline',
        description:
          'Offline-first landscape tug-of-war battlefield. Vite + TypeScript + Canvas 2D, fully procedural units.',
        theme_color: '#0d1210',
        background_color: '#0d1210',
        display: 'standalone',
        // Landscape lock for installed Android/desktop PWAs. iOS ignores this
        // and native builds lock via Info.plist / AndroidManifest instead.
        orientation: 'landscape',
        // Relative so the manifest stays valid at any subpath or base.
        start_url: '.',
        scope: '.',
        categories: ['games', 'entertainment'],
        lang: 'en',
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Full offline caching for every static asset we ship: the app shell,
        // the 97 character parts, the weapons atlas and the theatre map.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,json,woff,woff2}'],
        // The Europe map SVG is ~1.5 MB (and the character parts add ~1 MB),
        // so raise Workbox's default 2 MiB precache ceiling.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      // Keep the PWA out of `vite dev` — HMR plus a service worker is misery.
      devOptions: { enabled: false },
    }),
  ],
});
