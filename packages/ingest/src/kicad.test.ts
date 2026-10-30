import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseKicadPcb } from './kicad-ingest.js'

import { join } from 'node:path'
const boardsDir = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'boards')

function loadBoard(name: string): string {
  return readFileSync(`${boardsDir}/${name}`, 'utf8')
}

describe('VAL-INGEST-001 small board fully populated', () => {
  const contents = loadBoard('ecc83-pp.kicad_pcb')
  const model = parseKicadPcb(contents, 'ecc83-pp.kicad_pcb')

  it('reports kicad format and the input file', () => {
    expect(model.source.format).toBe('kicad')
    expect(model.source.files).toEqual(['ecc83-pp.kicad_pcb'])
    expect(model.source.boardName.toLowerCase()).toContain('ecc83')
  })

  it('declares front and back copper, silk, outline layers with valid enums', () => {
    const ids = model.layers.map((l) => l.id)
    expect(ids).toContain('F.Cu')
    expect(ids).toContain('B.Cu')
    const silkLayers = model.layers.filter((l) => l.kind === 'silk')
    expect(silkLayers.length).toBeGreaterThanOrEqual(1)
    expect(ids).toContain('Edge.Cuts')
    for (const layer of model.layers) {
      expect(['copper', 'silk', 'mask', 'drill', 'outline']).toContain(layer.kind)
      expect(['F', 'B', 'inner', null]).toContain(layer.side)
      expect(typeof layer.id).toBe('string')
      expect(layer.name.length).toBeGreaterThan(0)
    }
  })

  it('defines copper records for both outer layers with all arrays present', () => {
    for (const id of ['F.Cu', 'B.Cu']) {
      const c = model.copper[id]
      expect(c).toBeDefined()
      expect(Array.isArray(c?.traces)).toBe(true)
      expect(Array.isArray(c?.pads)).toBe(true)
      expect(Array.isArray(c?.vias)).toBe(true)
      expect(Array.isArray(c?.zones)).toBe(true)
    }
    expect(model.copper['F.Cu']?.pads.length).toBeGreaterThan(0)
    const totalTraces = Object.values(model.copper).reduce((n, c) => n + c.traces.length, 0)
    expect(totalTraces).toBeGreaterThan(0)
  })

  it('has non-empty footprints with complete fields', () => {
    expect(model.footprints.length).toBeGreaterThan(0)
    for (const fp of model.footprints) {
      expect(typeof fp.ref).toBe('string')
      expect(fp.ref.length).toBeGreaterThan(0)
      expect(Number.isFinite(fp.pos.x)).toBe(true)
      expect(Number.isFinite(fp.pos.y)).toBe(true)
      expect(typeof fp.rot).toBe('number')
      expect(typeof fp.layer).toBe('string')
      expect(Array.isArray(fp.padRefs)).toBe(true)
      expect(Array.isArray(fp.silkRefs)).toBe(true)
    }
  })

  it('holds silkscreen texts, outline paths, finite bbox, and six counters', () => {
    const textCount = Object.values(model.silkscreen).reduce((n, s) => n + s.texts.length, 0)
    expect(textCount).toBeGreaterThan(0)
    expect(model.outline.length).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(model.bbox.min.x)).toBe(true)
    expect(Number.isFinite(model.bbox.min.y)).toBe(true)
    expect(Number.isFinite(model.bbox.max.x)).toBe(true)
    expect(Number.isFinite(model.bbox.max.y)).toBe(true)
    expect(model.bbox.min.x).toBeLessThan(model.bbox.max.x)
    expect(model.bbox.min.y).toBeLessThan(model.bbox.max.y)
    for (const key of ['traces', 'pads', 'vias', 'zones', 'texts', 'drills'] as const) {
      expect(typeof model.stats[key]).toBe('number')
    }
  })
})

describe('VAL-INGEST-002 multilayer inner copper', () => {
  const model = parseKicadPcb(loadBoard('video.kicad_pcb'), 'video.kicad_pcb')

  it('exposes In1.Cu as an inner copper layer with traces', () => {
    const in1 = model.layers.find((l) => l.id === 'In1.Cu')
    expect(in1).toBeDefined()
    expect(in1?.kind).toBe('copper')
    expect(in1?.side).toBe('inner')
    const in1Copper = model.copper['In1.Cu']
    expect(in1Copper).toBeDefined()
    expect(in1Copper?.traces.length).toBeGreaterThan(0)
  })

  it('keeps inner-layer trace objects disjoint from outer-layer traces', () => {
    const in1 = model.copper['In1.Cu']?.traces ?? []
    const f = model.copper['F.Cu']?.traces ?? []
    const b = model.copper['B.Cu']?.traces ?? []
    const fSet = new Set(f)
    const bSet = new Set(b)
    for (const t of in1) {
      expect(fSet.has(t)).toBe(false)
      expect(bSet.has(t)).toBe(false)
    }
    const keys = (ts: typeof in1) => ts.map((t) => `${t.points[0]?.x},${t.points[0]?.y}>${t.points.at(-1)?.x},${t.points.at(-1)?.y}`)
    const fKeys = new Set(keys(f))
    for (const k of keys(in1)) expect(fKeys.has(k)).toBe(false)
  })

  it('matches declared copper layers 1:1 with populated copper records', () => {
    const raw = loadBoard('video.kicad_pcb')
    const declared = [...raw.matchAll(/^\s*\(\d+ "([A-Za-z0-9_.]+\.Cu)"/gm)].map((m) => m[1] as string)
    expect(declared.length).toBeGreaterThan(2)
    const declaredSet = new Set(declared)
    const modeled = Object.keys(model.copper)
    expect(modeled.sort()).toEqual([...declaredSet].sort())
    for (const [id, c] of Object.entries(model.copper)) {
      expect(c.traces.length + c.vias.length + c.zones.length, `layer ${id} empty`).toBeGreaterThan(0)
    }
  })
})

describe('VAL-INGEST-003 oldest and newest formats parse identically', () => {
  const video = parseKicadPcb(loadBoard('video.kicad_pcb'), 'video.kicad_pcb')
  const stickhub = parseKicadPcb(loadBoard('StickHub.kicad_pcb'), 'StickHub.kicad_pcb')

  function shapeOf(m: ReturnType<typeof parseKicadPcb>): Record<string, string> {
    return {
      topKeys: Object.keys(m).sort().join(','),
      sourceKeys: Object.keys(m.source).sort().join(','),
      format: m.source.format,
      layerFields: Object.keys(m.layers[0] ?? {}).sort().join(','),
      copperRecordKeys: Object.keys(Object.values(m.copper)[0] ?? {}).sort().join(','),
      footprintFields: Object.keys(m.footprints[0] ?? {}).sort().join(','),
      statsFields: Object.keys(m.stats).sort().join(',')
    }
  }

  it('produces structurally identical models across v20241229 and v20250907', () => {
    expect(shapeOf(video)).toEqual(shapeOf(stickhub))
  })

  it('both models are fully populated', () => {
    for (const m of [video, stickhub]) {
      expect(m.footprints.length).toBeGreaterThan(0)
      expect(m.stats.traces).toBeGreaterThan(0)
      expect(m.stats.pads).toBeGreaterThan(0)
      expect(m.stats.texts).toBeGreaterThan(0)
      expect(m.outline.length).toBeGreaterThan(0)
    }
  })

  it('never leaks the version token into the model', () => {
    expect(JSON.stringify(video)).not.toContain('20241229')
    expect(JSON.stringify(stickhub)).not.toContain('20250907')
  })
})

describe('VAL-INGEST-010 silk text byte fidelity', () => {
  it('preserves exact silk refdes values from ecc83', () => {
    const raw = loadBoard('ecc83-pp.kicad_pcb')
    const model = parseKicadPcb(raw, 'ecc83-pp.kicad_pcb')
    const values = Object.values(model.silkscreen).flatMap((s) => s.texts.map((t) => t.value))
    const refs = [...raw.matchAll(/\(property "Reference" "([^"]*)"/g)].map((m) => m[1] as string)
    expect(refs.length).toBeGreaterThan(0)
    expect(values.length).toBeGreaterThan(0)
    for (const cand of refs) {
      expect(values.some((v) => v === cand), `missing silk refdes: ${JSON.stringify(cand)}`).toBe(true)
    }
  })

  it('preserves exact gr_text strings from StickHub', () => {
    const raw = loadBoard('StickHub.kicad_pcb')
    const model = parseKicadPcb(raw, 'StickHub.kicad_pcb')
    const values = Object.values(model.silkscreen).flatMap((s) => s.texts.map((t) => t.value))
    expect(values.length).toBeGreaterThan(0)
    const grTexts = [...raw.matchAll(/\(gr_text\s+"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] as string)
    expect(grTexts.length).toBeGreaterThan(0)
    for (const g of grTexts) {
      const unescaped = g.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      expect(
        values.some((v) => v === g || v === unescaped),
        `missing gr_text: ${JSON.stringify(g)}`
      ).toBe(true)
    }
    for (const v of values) {
      expect(v.includes('\ufffd')).toBe(false)
    }
  })

  it('keeps mirrored flag boolean and values non-empty', () => {
    for (const name of ['ecc83-pp.kicad_pcb', 'StickHub.kicad_pcb']) {
      const raw = loadBoard(name)
      const model = parseKicadPcb(raw, name)
      for (const s of Object.values(model.silkscreen)) {
        for (const t of s.texts) {
          expect(typeof t.mirrored).toBe('boolean')
          expect(t.value.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('binds refdes texts to existing footprints', () => {
    for (const name of ['ecc83-pp.kicad_pcb', 'StickHub.kicad_pcb']) {
      const model = parseKicadPcb(loadBoard(name), name)
      const refs = new Set(model.footprints.map((f) => f.ref))
      for (const s of Object.values(model.silkscreen)) {
        for (const t of s.texts) {
          if (t.refdes !== undefined) expect(refs.has(t.refdes)).toBe(true)
        }
      }
    }
  })
})

describe('VAL-INGEST-011 nets rich for KiCad', () => {
  it('provides unique ids, non-empty names, multi-node nets on all KiCad boards', () => {
    for (const name of ['ecc83-pp.kicad_pcb', 'video.kicad_pcb', 'StickHub.kicad_pcb']) {
      const model = parseKicadPcb(loadBoard(name), name)
      expect(model.nets.length, name).toBeGreaterThan(0)
      const ids = new Set<number>()
      for (const net of model.nets) {
        expect(Number.isInteger(net.id)).toBe(true)
        ids.add(net.id)
        expect(net.name.length).toBeGreaterThan(0)
        expect(Array.isArray(net.nodeRefs)).toBe(true)
      }
      expect(ids.size).toBe(model.nets.length)
      expect(model.nets.some((n) => n.nodeRefs.length >= 2), `${name} has no multi-node net`).toBe(true)
    }
  })

  it('refdes-tagged texts bind to existing footprints and only refdes text carries footprint refs', () => {
    for (const name of ['ecc83-pp.kicad_pcb', 'StickHub.kicad_pcb']) {
      const model = parseKicadPcb(loadBoard(name), name)
      const refs = new Set(model.footprints.map((f) => f.ref))
      const refdesTagged = Object.values(model.silkscreen)
        .flatMap((s) => s.texts)
        .filter((t) => t.refdes !== undefined)
      expect(refdesTagged.length, `${name} should carry refdes-tagged texts`).toBeGreaterThan(0)
      for (const s of Object.values(model.silkscreen)) {
        for (const t of s.texts) {
          if (t.refdes !== undefined) {
            expect(refs.has(t.refdes), `${name}: refdes ${t.refdes} has no footprint`).toBe(true)
          } else if (t.footprintRef !== undefined) {
            expect.fail(`${name}: non-refdes text ${JSON.stringify(t.value)} leaks footprintRef ${t.footprintRef}`)
          }
        }
      }
      const visibleRefs = new Set(
        refdesTagged
          .filter((t) => !/^\s*$/.test(t.value))
          .map((t) => t.value)
      )
      expect(visibleRefs.size, `${name} distinct visible refdes values`).toBeGreaterThan(0)
    }
  })
})

describe('VAL-INGEST-010 mirrored silk text stays readable', () => {
  it('layer-mirror and font-mirror texts keep un-reversed values with mirrored: true', () => {
    const doc = `(kicad_pcb (version 20241229) (generator pcbnew)
      (gr_text "SILK-BOTH" (at 10 0) (layer "F.SilkS" mirror) (effects (font (size 1 1))))
      (gr_text "SILK-FONT" (at 20 0) (layer "F.SilkS") (effects (font (size 1 1) mirror)))
      (gr_text "PLAIN" (at 30 0) (layer "F.SilkS"))
    )`
    const model = parseKicadPcb(doc, 'mirror-probe.kicad_pcb')
    const texts = Object.values(model.silkscreen).flatMap((s) => s.texts)
    const byValue = new Map(texts.map((t) => [t.value, t]))
    expect([...byValue.keys()].sort()).toEqual(['PLAIN', 'SILK-BOTH', 'SILK-FONT'])
    const both = byValue.get('SILK-BOTH')
    const font = byValue.get('SILK-FONT')
    const plain = byValue.get('PLAIN')
    expect(both?.mirrored).toBe(true)
    expect(font?.mirrored).toBe(true)
    expect(plain?.mirrored).toBe(false)
    for (const t of texts) {
      expect(t.value).not.toContain('\ufffd')
      expect(t.value.length, `value ${JSON.stringify(t.value)} must stay un-reversed`).toBeGreaterThan(0)
    }
  })

  it('footprint property Reference text on a mirrored layer keeps the readable ref', () => {
    const doc = `(kicad_pcb (version 20241229) (generator pcbnew)
      (footprint "Test0_R_0805" (layer "F.Cu")
        (at 5 5 90)
        (property "Reference" "R7" (at 0 -1.2 90) (layer "F.SilkS") (effects (font (size 1 1) mirror)))
        (property "Value" "10k" (at 0 1.2 90) (layer "F.Fab"))
        (pad "1" smd roundrect (at -0.9 0 90) (size 1 1.2) (layers "F.Cu"))
        (pad "2" smd roundrect (at 0.9 0 90) (size 1 1.2) (layers "F.Cu"))
      )
    )`
    const model = parseKicadPcb(doc, 'mirror-fp.kicad_pcb')
    const texts = Object.values(model.silkscreen).flatMap((s) => s.texts)
    const r7 = texts.find((t) => t.value === 'R7')
    expect(r7).toBeDefined()
    if (!r7) return
    expect(r7.mirrored).toBe(true)
    expect(r7.refdes).toBe('R7')
    expect(model.footprints[0]?.ref).toBe('R7')
  })
})

describe('VAL-INGEST-017 pad fidelity', () => {
  it('preserves custom and trapezoid shapes and expands wildcard copper layers', () => {
    const doc = `(kicad_pcb (version 20241229) (generator pcbnew)
      (layers
        (0 "F.Cu" signal)
        (2 "In1.Cu" power)
        (31 "B.Cu" signal)
      )
      (footprint "FidelityProbe" (layer "F.Cu")
        (at 10 20)
        (property "Reference" "FP1" (at 0 0) (layer "F.SilkS"))
        (pad "custom" smd custom (at 0 0) (size 2 1) (layers "*.Cu" "*.Mask"))
        (pad "trapezoid" smd trapezoid (at 3 0) (size 2 1) (layers "B.Cu"))
      )
    )`
    const model = parseKicadPcb(doc, 'pad-fidelity.kicad_pcb')

    const wildcardPads = Object.values(model.copper)
      .flatMap((layer) => layer.pads)
      .filter((pad) => pad.footprintRef === 'FP1' && pad.pos.x === 10 && pad.pos.y === 20)
    expect(wildcardPads.map((pad) => pad.shape)).toEqual(['custom', 'custom', 'custom'])
    expect(Object.keys(model.copper).sort()).toEqual(['B.Cu', 'F.Cu', 'In1.Cu'])

    const trapezoidPad = model.copper['B.Cu']?.pads.find(
      (pad) => pad.footprintRef === 'FP1' && pad.pos.x === 13 && pad.pos.y === 20
    )
    expect(trapezoidPad?.shape).toBe('trapezoid')
    expect(model.stats.pads).toBe(2)
  })
})

describe('Edge.Cuts beyond lines and arcs', () => {
  const edge = '(stroke (width 0.1)) (layer "Edge.Cuts")'
  const model = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
    (gr_line (start 0 0) (end 50 0) ${edge})
    (gr_curve (pts (xy 50 0) (xy 68 4) (xy 68 36) (xy 50 40)) ${edge})
    (gr_line (start 50 40) (end 0 40) ${edge})
    (gr_circle (center 30 20) (end 31.6 20) ${edge})
    (footprint "Hole" (layer "F.Cu") (at 5 8 90)
      (fp_circle (center 0 0) (end 1.6 0) ${edge})
      (fp_line (start -2 -3) (end 2 -3) ${edge})))`, 'edge.kicad_pcb')

  it('samples a spline edge into a polyline that meets its neighbours', () => {
    const curve = model.outline.find((o) => o.points.length > 3 && !o.closed)
    expect(curve?.points[0]).toEqual({ x: 50, y: 0 })
    expect(curve?.points.at(-1)).toEqual({ x: 50, y: 40 })
    expect(Math.max(...(curve?.points ?? []).map((p) => p.x))).toBeCloseTo(63.5, 1)
  })

  it('keeps board circles and footprint edge shapes as outline', () => {
    expect(model.outline.filter((o) => o.closed)).toHaveLength(2)
    const hole = model.outline.find((o) => o.closed && Math.abs((o.points[0]?.x ?? 0) - 6.6) < 0.01)
    expect(hole).toBeDefined()
    expect(model.outline.filter((o) => !o.closed)).toHaveLength(4)
  })
})

describe('footprint 3D models', () => {
  const model = parseKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal))
    (footprint "A" (layer "F.Cu") (at 1 2) (property "Reference" "U1")
      (model "\${KICAD8_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl" (offset (xyz 0.5 0 0)) (scale (xyz 1 1 1)) (rotate (xyz -90 0 90)))
      (model "hidden.step" (hide yes)))
    (module "B" (layer "F.Cu") (at 3 4) (fp_text reference "U2" (at 0 0) (layer "F.SilkS"))
      (model legacy.wrl (at (xyz 0.1 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))))`, 'models.kicad_pcb')

  it('keeps each visible model with its offset, scale and rotation', () => {
    expect(model.footprints[0]?.models).toEqual([{
      path: '${KICAD8_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl',
      offset: { x: 0.5, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotate: { x: -90, y: 0, z: 90 }
    }])
  })

  it('reads a KiCad 5 offset in inches', () => {
    expect(model.footprints[1]?.models[0]?.offset.x).toBeCloseTo(2.54, 6)
  })
})
