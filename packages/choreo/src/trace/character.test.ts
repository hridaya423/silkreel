import { describe, expect, it } from 'vitest'
import { parseKicadPcb } from '@silk-reel/ingest'
import { compileTimeline } from '../index'
import type { FilmConfig, TraceTimeline } from '../types'
import { boardModel, loadBoard } from '../../test/helpers'

const CONFIG: FilmConfig = { style: 'trace', aspect: '4:5', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } }
const film = (name: string): TraceTimeline => compileTimeline(boardModel(`${name}.kicad_pcb`), CONFIG) as TraceTimeline

describe('board character comes from the board file, never its name', () => {
  const films = new Map(['StickHub', 'ecc83-pp', 'glasgow'].map((b) => [b, film(b)]))

  it('a stick, a valve board and an LED board are read as such and open and sign differently', () => {
    const kinds = [...films.values()].map((tl) => tl.scene.character?.archetype)
    expect(kinds).toEqual(['stick', 'valve', 'leds'])
    const opening = [...films.values()].map((tl) => {
      const k = tl.scene.shots[0]
      return `${Math.round(k?.focus?.x ?? NaN)},${Math.round(k?.focus?.y ?? NaN)},${Math.round(((k?.tilt ?? 0) * 180) / Math.PI)}`
    })
    expect(new Set(opening).size).toBe(3)
    const signs = [...films.values()].map((tl) => tl.scene.sign?.kind)
    expect(new Set(signs).size).toBe(3)
    const stick = films.get('StickHub') as TraceTimeline
    expect(Math.hypot((stick.scene.character?.opening.x ?? 0) - stick.scene.origin.x, (stick.scene.character?.opening.y ?? 0) - stick.scene.origin.y)).toBeGreaterThan(0.25 * Math.max(...stick.scene.board.flat()))
  })

  it('an LED board lights its LEDs as the pulses reach them, after the nets wake, not all on one frame', () => {
    const tl = films.get('glasgow') as TraceTimeline
    const at = tl.scene.parts.filter((pt) => pt.led !== undefined && pt.led.at > tl.scene.acts.power[0] && pt.led.at < tl.scene.acts.power[1]).map((pt) => pt.led?.at as number)
    expect(at.length).toBeGreaterThanOrEqual(6)
    expect(Math.max(...at) - Math.min(...at)).toBeGreaterThan(2 / 360)
    expect(Math.min(...at)).toBeGreaterThan(tl.scene.acts.power[0] + 6 / 360)
  })

  it('a renamed copy of a board produces an identical timeline (given the same title, since an untitled film prints the file name)', () => {
    const src = loadBoard('StickHub.kicad_pcb')
    const titled = { ...CONFIG, title: { name: 'StickHub' } }
    const a = compileTimeline(parseKicadPcb(src, 'StickHub.kicad_pcb'), titled)
    const b = compileTimeline(parseKicadPcb(src, 'renamed-copy.kicad_pcb'), titled)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  }, 20000)
})
