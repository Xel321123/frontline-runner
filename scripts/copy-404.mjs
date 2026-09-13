/**
 * GitHub Pages SPA fallback copier.
 *
 * GitHub Pages serves `404.html` for any unknown path, so copy the freshly
 * built `index.html` (which carries absolute, base-prefixed asset URLs) over
 * `dist/404.html`. Combined with the service worker's `navigateFallback`,
 * every path — online and offline — resolves to the app shell.
 *
 * Wire into the build: "build": "tsc --noEmit && vite build && node scripts/copy-404.mjs"
 * IMPORTANT: must run AFTER `vite build`.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const source = join(distDir, 'index.html')
const target = join(distDir, '404.html')

if (!existsSync(source)) {
  console.error('dist/index.html not found — run `vite build` first.')
  process.exit(1)
}

copyFileSync(source, target)
console.log('ok dist/404.html written (GitHub Pages SPA fallback)')
