import { describe, expect, it } from 'vitest'
import { parseKicadPcb } from '@silk-reel/ingest'
import { loadBoard } from '../test/helpers'

describe('choreo precondition: ingest ids are consistent and footprint refs resolve', () => {
  it('every element object carries a well-formed unique id within its class', () => {
    for (const name of ['ecc83-pp.kicad_pcb', 'StickHub.kicad_pcb', 'video.kicad_pcb']) {
      const model = parseKicadPcb(loadBoard(name), name)
      const seen = new Set<string>()
      const claim = (id: string, where: string): void => {
        expect(id.length, `${where} empty id`).toBeGreaterThan(0)
        expect(id).toMatch(/^([a-z]+):\d+$/)
        expect(seen.has(`${where}:${id}`), `${where} repeats id ${id}`).toBe(false)
        seen.add(`${where}:${id}`)
      }
      for (const o of model.outline) claim(o.id, 'outline')
      for (const d of model.drill) claim(d.id, 'drill')
      for (const [layerId, c] of Object.entries(model.copper)) {
        for (const t of c.traces) claim(t.id, `trace:${layerId}`)
        for (const p of c.pads) claim(p.id, `pad:${layerId}`)
        for (const v of c.vias) claim(v.id, `via:${layerId}`)
        for (const z of c.zones) claim(z.id, `zone:${layerId}`)
      }
      for (const [layerId, s] of Object.entries(model.silkscreen)) {
        for (const l of s.lines) claim(l.id, `silk-line:${layerId}`)
        for (const t of s.texts) claim(t.id, `silk-text:${layerId}`)
      }
    }
  })

  it('the same logical element reuses one id across copper layers (through-hole identity)', () => {
    for (const name of ['ecc83-pp.kicad_pcb', 'StickHub.kicad_pcb']) {
      const model = parseKicadPcb(loadBoard(name), name)
      const padLayers = new Map<string, Set<string>>()
      for (const [layerId, c] of Object.entries(model.copper)) {
        for (const p of c.pads) {
          const set = padLayers.get(p.id) ?? new Set<string>()
          set.add(layerId)
          padLayers.set(p.id, set)
        }
      }
      let shared = 0
      for (const [id, layers] of padLayers) {
        if (layers.size > 1) shared++
        for (const layerId of layers) {
          const pad = model.copper[layerId]?.pads.find((p) => p.id === id)
          expect(pad?.footprintRef, `${name}: pad ${id} inconsistent ownership`).toBeDefined()
        }
      }
      expect(shared, `${name} should have through-hole pads shared across copper arrays`).toBeGreaterThan(0)
    }
  })

  it('footprint padRefs/silkRefs resolve to real objects with matching ownership and no double-claim', () => {
    for (const name of ['ecc83-pp.kicad_pcb', 'StickHub.kicad_pcb']) {
      const model = parseKicadPcb(loadBoard(name), name)
      const byId = new Map<string, { fp?: string | undefined }>()
      for (const c of Object.values(model.copper)) {
        for (const p of c.pads) byId.set(p.id, { fp: p.footprintRef })
        for (const v of c.vias) byId.set(v.id, {})
        for (const t of c.traces) byId.set(t.id, {})
      }
      for (const s of Object.values(model.silkscreen)) {
        for (const l of s.lines) byId.set(l.id, {})
        for (const t of s.texts) byId.set(t.id, { fp: t.footprintRef })
      }
      const claims = new Map<string, string>()
      for (const fp of model.footprints) {
        for (const ref of [...fp.padRefs, ...fp.silkRefs]) {
          const el = byId.get(ref)
          expect(el, `${name}: ${fp.ref} dangling ref ${ref}`).toBeDefined()
          if (el?.fp !== undefined && el.fp !== fp.ref) {
            throw new Error(`${name}: ref ${ref} owned by ${el.fp}, claimed also by ${fp.ref}`)
          }
          const prior = claims.get(ref)
          expect(prior, `${name}: ref ${ref} claimed twice (${prior}, ${fp.ref})`).toBeUndefined()
          claims.set(ref, fp.ref)
        }
      }
    }
  })
})
