import type { Palette, PaletteId, StyleId } from './types'

export const PALETTES: Record<PaletteId, Palette> = {
  mono:      { id: 'mono',      bg: '#050505', copper: '#f2f2f2', copperDim: '#5a5a5a', silk: '#ffffff', head: '#ffffff', bloom: 0.35 },
  copper:    { id: 'copper',    bg: '#0a0806', copper: '#d08a4c', copperDim: '#5b3a22', silk: '#efe6d8', head: '#ffd2a0', bloom: 0.6 },
  blueprint: { id: 'blueprint', bg: '#04101c', copper: '#6cc8ff', copperDim: '#1d4a6e', silk: '#dff4ff', head: '#e8fbff', bloom: 0.55 },
  phosphor:  { id: 'phosphor',  bg: '#020803', copper: '#3dff8a', copperDim: '#145c30', silk: '#c9ffd9', head: '#eafff0', bloom: 0.65 },
  paper:     { id: 'paper',     bg: '#ecede9', copper: '#151515', copperDim: '#8c8c86', silk: '#151515', head: '#c4221a', bloom: 0 }
}

export function resolvePalette(style: StyleId, id: PaletteId | undefined, accent: string | undefined): Palette {
  const base = PALETTES[id ?? (style === 'glyph' ? 'mono' : style === 'plot' ? 'paper' : 'copper')]
  return accent === undefined ? base : { ...base, id: 'custom', head: accent }
}
