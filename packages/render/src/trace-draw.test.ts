import './test-recorder.js'
import { describe, expect, it } from 'vitest'
import { compileTimeline } from '@silk-reel/choreo'
import type { FilmConfig, TraceTimeline } from '@silk-reel/choreo'
import { drawTraceFrame } from './trace-draw.js'
import { asCtx, currentRecorder, RecordingCtx } from './test-recorder.js'
import { boardModel } from '../../choreo/test/helpers.js'

function cfg(overrides: Partial<FilmConfig> = {}): FilmConfig {
  return {
    style: 'trace',
    knobs: {},
    seed: 42,
    duration: 'auto',
    output: { width: 1080, height: 1350, fps: 30 },
    ...overrides
  }
}

function traceTimeline(boardName: string, overrides: Partial<FilmConfig> = {}): TraceTimeline {
  const tl = compileTimeline(boardModel(boardName), cfg(overrides))
  if (tl.style !== 'trace') throw new Error('expected a trace timeline')
  return tl
}

function callsOf(method: string) {
  return currentRecorder().calls.filter((c) => c.method === method)
}

describe('drawTraceFrame', () => {
  it('paints the background and the placed pads at frame 0, nothing routed yet', () => {
    const timeline = traceTimeline('glasgow.kicad_pcb')
    const rec = currentRecorder()
    drawTraceFrame(asCtx(rec), timeline, 0)
    const fills = callsOf('fillRect')
    expect(fills[0]?.args).toEqual([0, 0, timeline.width, timeline.height])
    const bgSet = rec.calls.filter((c) => c.method === 'set:fillStyle').map((c) => c.args[0])
    expect(bgSet[0]).toBe(timeline.palette.bg)
  })

  it('draws growing heads and strokes mid-growth', () => {
    const timeline = traceTimeline('glasgow.kicad_pcb')
    const rec = currentRecorder()
    const drawn = drawTraceFrame(asCtx(rec), timeline, Math.floor(timeline.totalFrames * 0.5))
    expect(drawn).toBeGreaterThan(0)
    expect(callsOf('arc').length).toBeGreaterThanOrEqual(1)
    expect(callsOf('stroke').length).toBeGreaterThan(0)
  })

  it('ends on the held board, drawn at full strength', () => {
    const timeline = traceTimeline('glasgow.kicad_pcb')
    const rec = currentRecorder()
    const drawn = drawTraceFrame(asCtx(rec), timeline, timeline.totalFrames - 1)
    expect(drawn).toBeGreaterThan(0)
    const alphas = rec.calls.filter((c) => c.method === 'set:globalAlpha').map((c) => c.args[0] as number)
    expect(Math.max(...alphas)).toBe(1)
  })

  it('fades the drill constellation in during the outline beat', () => {
    const timeline = traceTimeline('glasgow.kicad_pcb')
    const rec = currentRecorder()
    // p=0.008: the outline beat: every drill fills, with the placed pads
    drawTraceFrame(asCtx(rec), timeline, Math.floor(timeline.totalFrames * 0.008))
    expect(callsOf('arc').length).toBeGreaterThanOrEqual(timeline.scene.drills.length)
    const fillStyles = rec.calls.filter((c) => c.method === 'set:fillStyle').map((c) => c.args[0])
    expect(fillStyles).toContain(timeline.palette.copperDim)
  })

  it('promotes back copper to the hero color when a board has no front layer', () => {
    const timeline = traceTimeline('ecc83-pp.kicad_pcb')
    expect(timeline.scene.layers.every((l) => l.side === 'B')).toBe(true)
    const rec = currentRecorder()
    drawTraceFrame(asCtx(rec), timeline, Math.floor(timeline.totalFrames * 0.5))
    const strokeStyles = rec.calls.filter((c) => c.method === 'set:strokeStyle').map((c) => c.args[0])
    expect(strokeStyles).toContain(timeline.palette.copper)
    // and the growth still draws dimmed inner/B layers as copperDim on mixed boards
    const mixed = traceTimeline('glasgow.kicad_pcb')
    drawTraceFrame(asCtx(currentRecorder()), mixed, Math.floor(mixed.totalFrames * 0.5))
    const mixedStyles = currentRecorder().calls.filter((c) => c.method === 'set:strokeStyle').map((c) => c.args[0])
    expect(mixedStyles).toContain(mixed.palette.copperDim)
  })

  it('types the title card on during the hold and stays away before it', () => {
    const timeline = traceTimeline('glasgow.kicad_pcb', { title: { name: 'Qzx Glasgow', version: 'revC3' } })
    const rec = currentRecorder()
    drawTraceFrame(asCtx(rec), timeline, Math.floor(timeline.totalFrames * 0.3))
    const early = callsOf('fillText').map((c) => c.args[0] as string)
    expect(early.some((t) => 'Qzx Glasgow'.startsWith(t) && t.length > 0)).toBe(false)
    rec.reset()
    drawTraceFrame(asCtx(rec), timeline, Math.floor(timeline.totalFrames * 0.94))
    const texts = callsOf('fillText').map((c) => c.args[0] as string)
    expect(texts.some((t) => 'Qzx Glasgow'.startsWith(t) && t.length > 0)).toBe(true)
  })

  it('clears instead of filling on a transparent timeline', () => {
    const timeline = traceTimeline('glasgow.kicad_pcb', { transparent: true })
    const rec = new RecordingCtx()
    drawTraceFrame(asCtx(rec), timeline, 0)
    expect(rec.calls.filter((c) => c.method === 'clearRect').length).toBe(1)
    expect(rec.calls.filter((c) => c.method === 'fillRect').length).toBe(0)
  })
})
