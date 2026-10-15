// The panel's mascot: a GIF made into panel assets by scripts/build-mascot.py (built-in default, or one the person uploads).
// Desktop: the GIF inside an SVG (still PNG while idle), drawn as a plain image: the GIF animates there,
// while the sandboxed frame `isInteractive` asks for does not load it. Terminal: the half-block cell frames
// drawn as coloured Text (the CLI's Raster element paints nothing there).
import type { MascotAssets } from '../types'
import { MASCOT_GIF, MASCOT_RASTER, MASCOT_SIZE, MASCOT_STILL } from './mascot-assets'

/** The built-in mascot from mascot-assets.ts; none when that file is the blank one. An uploaded one has the same shape. */
export const DEFAULT_MASCOT: MascotAssets | undefined = MASCOT_GIF
  ? { gif: MASCOT_GIF, still: MASCOT_STILL, ...MASCOT_SIZE, raster: { ...MASCOT_RASTER, frames: [...MASCOT_RASTER.frames] } }
  : undefined

export { MASCOT_RASTER, MASCOT_SIZE }

/** A run of same-coloured cells: `color` paints the glyph, `bg` the cell; neither for blank cells. */
export type Span = { text: string; color?: string; bg?: string }

const DEFAULT = 0x01000000 // the terminal's own colour
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`

function decode(b64: string, raster: MascotAssets['raster']): Span[][] {
  const bin = atob(b64)
  const u32 = (i: number) =>
    (bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8) | (bin.charCodeAt(i + 2) << 16) | (bin.charCodeAt(i + 3) << 24)) >>> 0
  const rows: Span[][] = []
  for (let r = 0; r < raster.rows; r++) {
    const row: Span[] = []
    for (let c = 0; c < raster.columns; c++) {
      const at = (r * raster.columns + c) * 12
      const fg = u32(at + 4)
      const bg = u32(at + 8)
      // ▀ paints the top pixel in `color` and the bottom in `bg`; a blank half falls back to the terminal's colour
      const cell: Span =
        fg === DEFAULT && bg === DEFAULT ? { text: ' ' }
        : fg === DEFAULT ? { text: '▄', color: hex(bg) }
        : bg === DEFAULT ? { text: '▀', color: hex(fg) }
        : { text: '▀', color: hex(fg), bg: hex(bg) }
      const last = row[row.length - 1]
      if (last && last.text[0] === cell.text && last.color === cell.color && last.bg === cell.bg) last.text += cell.text
      else row.push(cell)
    }
    rows.push(row)
  }
  return rows
}

const decoded = new WeakMap<MascotAssets, Span[][][]>()
/** Frame `i` (wrapping) of mascot `m` as rows of spans; decoded once per mascot, on first use. */
export const mascotText = (i: number, m: MascotAssets): Span[][] => {
  let frames = decoded.get(m)
  if (!frames) decoded.set(m, (frames = m.raster.frames.map(f => decode(f, m.raster))))
  return frames[i % frames.length] ?? []
}

/** The SVG document: the animated GIF while dancing, its first frame while idle, rounded corners. */
export function mascot(isDancing: boolean, m: MascotAssets): string {
  const href = isDancing ? `data:image/gif;base64,${m.gif}` : `data:image/png;base64,${m.still}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${m.height}">` +
    `<clipPath id="r"><rect width="${m.width}" height="${m.height}" rx="8"/></clipPath>` +
    `<image href="${href}" width="${m.width}" height="${m.height}" clip-path="url(#r)"/>` +
    `</svg>`
  )
}
