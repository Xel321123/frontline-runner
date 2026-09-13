/**
 * Dependency-free PWA icon generator (Node built-ins only).
 *
 * Renders the Frontline Runner icon set — a gold campaign star on an olive
 * field — from a signed-distance-style sampler. No ImageMagick, no PIL, no npm
 * packages: just `node:zlib`.
 *
 *   npm run icons      # writes public/icons/*.png, then commit the PNGs
 *
 * Design rules encoded here:
 *   - maskable icons: `rounded: false, scale: 0.8` keeps artwork inside the
 *     required 80% safe zone on a full-bleed canvas.
 *   - apple-touch icons: full-bleed (`rounded: false`) — iOS applies its own mask.
 *   - standard icons: rounded-tile mask for a consistent home-screen look.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA)
// ---------------------------------------------------------------------------

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

function encodePng(width, height, pixelAt) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
      offset += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Artwork — Frontline Runner campaign star
// ---------------------------------------------------------------------------

const BG = [20, 28, 18]
const FIELD = [38, 52, 32]
const STAR = [200, 161, 58]
const STAR_EDGE = [232, 200, 110]
const BAR = [125, 143, 82]

/** Five-pointed star polygon (10 vertices, outer/inner radii). */
function starPolygon(cx, cy, outer, inner, points = 5) {
  const vertices = []
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner
    const angle = -Math.PI / 2 + (i * Math.PI) / points
    vertices.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  return vertices
}

const STAR_OUTER = 0.3
const STAR_INNER = 0.126
const STAR_POLY = starPolygon(0.5, 0.52, STAR_OUTER, STAR_INNER)

function pointInPolygon(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function insideRoundedRect(nx, ny, radius) {
  const cx = Math.max(radius, Math.min(nx, 1 - radius))
  const cy = Math.max(radius, Math.min(ny, 1 - radius))
  return Math.hypot(nx - cx, ny - cy) <= radius
}

/**
 * Sample artwork at normalized coordinates.
 * @param nx - x in [0, 1]
 * @param ny - y in [0, 1]
 * @param rounded - apply rounded-tile mask (false = full bleed)
 * @param scale - draw content into a centered box of this size (safe zone)
 */
function sample(nx, ny, rounded, scale) {
  const dx = 0.5 + (nx - 0.5) / scale
  const dy = 0.5 + (ny - 0.5) / scale

  if (dx < 0 || dx > 1 || dy < 0 || dy > 1) {
    return rounded ? [0, 0, 0, 0] : [...BG, 255]
  }
  if (rounded && !insideRoundedRect(dx, dy, 0.22)) return [0, 0, 0, 0]

  // Ground bar — the "front line" the star stands on.
  const onBar = dy >= 0.735 && dy <= 0.795 && dx >= 0.2 && dx <= 0.8
  // Star body.
  if (pointInPolygon(dx, dy, STAR_POLY)) {
    // Slight inner highlight towards the top-left for depth.
    const shade = (dx - 0.5) * 0.35 + (dy - 0.52) * 0.35
    const colour = shade < -0.06 ? STAR_EDGE : STAR
    // Under-bar glow where the two overlap.
    if (onBar) return [...STAR, 255]
    return [...colour, 255]
  }
  if (onBar) return [...BAR, 255]
  return [...FIELD, 255]
}

function render(size, { rounded = true, scale = 1, filename }) {
  const png = encodePng(size, size, (x, y) =>
    sample((x + 0.5) / size, (y + 0.5) / size, rounded, scale)
  )
  writeFileSync(join(OUT_DIR, filename), png)
  console.log(`  ok ${filename} (${size}x${size})`)
}

mkdirSync(OUT_DIR, { recursive: true })
console.log('Generating icons:')
render(32, { filename: 'favicon-32.png' })
render(192, { filename: 'pwa-192x192.png' })
render(512, { filename: 'pwa-512x512.png' })
render(512, { rounded: false, scale: 0.8, filename: 'pwa-maskable-512x512.png' })
render(180, { rounded: false, scale: 0.85, filename: 'apple-touch-icon.png' })
console.log('Done.')
