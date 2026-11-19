import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Glyph { contours: number; x0: number; y0: number; x1: number; y1: number; bytes: string }

function glyphs(file: string): (ch: string) => Glyph {
  const buf = readFileSync(new URL(file, import.meta.url))
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tables = new Map<string, number>()
  for (let i = 0; i < v.getUint16(4); i++) tables.set(buf.toString('latin1', 12 + 16 * i, 16 + 16 * i), v.getUint32(12 + 16 * i + 8))
  const at = (tag: string): number => {
    const o = tables.get(tag)
    if (o === undefined) throw new Error(`no ${tag} table`)
    return o
  }
  const cmap = at('cmap')
  let sub = -1
  for (let i = 0; i < v.getUint16(cmap + 2); i++) {
    const r = cmap + 4 + 8 * i
    if (v.getUint16(r) === 3 && v.getUint16(r + 2) === 1) sub = cmap + v.getUint32(r + 4)
  }
  const glyphId = (code: number): number => {
    const segs = v.getUint16(sub + 6) / 2
    const ends = sub + 14
    const starts = ends + 2 * segs + 2
    const deltas = starts + 2 * segs
    const ranges = deltas + 2 * segs
    for (let i = 0; i < segs; i++) {
      if (code > v.getUint16(ends + 2 * i) || code < v.getUint16(starts + 2 * i)) continue
      const ro = v.getUint16(ranges + 2 * i)
      const g = ro === 0 ? code : v.getUint16(ranges + 2 * i + ro + 2 * (code - v.getUint16(starts + 2 * i)))
      return (g + v.getInt16(deltas + 2 * i)) & 0xffff
    }
    return 0
  }
  const long = v.getInt16(at('head') + 50) === 1
  const loca = at('loca')
  const glyf = at('glyf')
  const offset = (g: number): number => (long ? v.getUint32(loca + 4 * g) : 2 * v.getUint16(loca + 2 * g))
  return (ch) => {
    const g = glyphId(ch.charCodeAt(0))
    const o = glyf + offset(g)
    return { contours: v.getInt16(o), x0: v.getInt16(o + 2), y0: v.getInt16(o + 4), x1: v.getInt16(o + 6), y1: v.getInt16(o + 8), bytes: buf.toString('hex', o, glyf + offset(g + 1)) }
  }
}

describe('the drafting face', () => {
  it('draws 1 and I, and 0 and O, as different letters, so designators read true', () => {
    const glyph = glyphs('./assets/SilkDraft.ttf')
    const [one, eye, zero, oh] = ['1', 'I', '0', 'O'].map(glyph) as [Glyph, Glyph, Glyph, Glyph]
    expect(one.bytes).not.toBe(eye.bytes)
    expect(one.x1 - one.x0, 'the 1 carries a flag and a foot').toBeGreaterThan(2.5 * (eye.x1 - eye.x0))
    expect(zero.bytes).not.toBe(oh.bytes)
    expect(zero.contours, 'the 0 is slashed').toBeGreaterThan(oh.contours)
  })
})
