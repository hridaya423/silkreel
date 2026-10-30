import './test-recorder.js'
import { describe, expect, it } from 'vitest'
import { compileTimeline } from '@silk-reel/choreo'
import type { FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { drawPlotFrame } from './plot-draw.js'
import { asCtx, currentRecorder } from './test-recorder.js'
import { boardModel } from '../../choreo/test/helpers.js'

function plotTimeline(boardName: string): TraceTimeline {
  const config: FilmConfig = { style: 'plot', knobs: {}, seed: 42, duration: 'auto', output: { width: 1080, height: 1350, fps: 30 } }
  const tl = compileTimeline(boardModel(boardName), config)
  if (tl.style !== 'plot') throw new Error('expected a plot timeline')
  return tl
}

const redStrokes = (tl: TraceTimeline, frame: number): number => {
  const rec = currentRecorder()
  rec.reset()
  drawPlotFrame(asCtx(rec), tl, frame)
  return rec.calls.filter((c) => c.method === 'set:strokeStyle' && c.args[0] === tl.palette.head).length
}

describe('drawPlotFrame', () => {
  it('compiles the trace score onto paper', () => {
    const tl = plotTimeline('glasgow.kicad_pcb')
    expect(tl.palette.id).toBe('paper')
    expect(tl.scene.layers.length).toBeGreaterThan(0)
  })

  it('keeps the red pen off the board while it is drawn, and runs it after power-on', () => {
    const tl = plotTimeline('glasgow.kicad_pcb')
    expect(redStrokes(tl, Math.floor(tl.totalFrames * 0.2))).toBe(0)
    const powered = Math.floor(tl.totalFrames * (tl.scene.acts.power[0] + tl.scene.acts.power[1]) / 2)
    expect(redStrokes(tl, powered)).toBeGreaterThan(1)
  })
})
