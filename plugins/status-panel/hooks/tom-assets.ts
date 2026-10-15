// No built-in mascot: the panel shows none until you pick a GIF with "🖼 Change mascot".
// To ship a default one, run: python3 scripts/build-tom.py path/to/your.gif (rewrites this file).
export const TOM_SIZE = { width: 0, height: 0 } as const
export const TOM_GIF = ''
export const TOM_STILL = ''
export const TOM_RASTER = { columns: 0, rows: 0, frameMs: 125, frames: [] as string[] }
