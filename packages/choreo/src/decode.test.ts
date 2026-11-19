import { describe, expect, it } from 'vitest'
import { DECODE_IN, DECODE_OUT, blinkAlpha, decodeAlpha, flareTone } from './decode'

const STEPS = 168

describe('decode pattern banks', () => {
  it('every decode-in pattern lands on 1 and every decode-out lands on 0', () => {
    for (const p of DECODE_IN) expect(p.at(-1)).toBe(1)
    for (const p of DECODE_OUT) expect(p.at(-1)).toBe(0)
  })

  it('patterns only ever use the hard-blink alphabet {0, 0.35, 1}', () => {
    const allowed = new Set([0, 0.35, 1])
    for (const v of [...DECODE_IN, ...DECODE_OUT].flat()) {
      expect(allowed.has(v)).toBe(true)
    }
  })
})

describe('decodeAlpha', () => {
  it('plays the decode-in pattern at inStep, then holds at 1', () => {
    const pattern = 3
    const inStep = 20
    const outStep = 60
    for (let k = 0; k < 5; k++) {
      expect(decodeAlpha(inStep + k, inStep, outStep, pattern, STEPS)).toBe(DECODE_IN[pattern]?.[k])
    }
    for (const s of [26, 30, 59]) {
      expect(decodeAlpha(s, inStep, outStep, pattern, STEPS)).toBe(1)
    }
  })

  it('plays the decode-out pattern at outStep, then goes dark', () => {
    const pattern = 1
    const inStep = 20
    const outStep = 60
    for (let k = 0; k < 6; k++) {
      expect(decodeAlpha(outStep + k, inStep, outStep, pattern, STEPS)).toBe(DECODE_OUT[pattern]?.[k])
    }
    for (const s of [66, 100, 19]) {
      expect(decodeAlpha(s, inStep, outStep, pattern, STEPS)).toBe(0)
    }
  })

  it('wraps around the loop: a unit decoding in at step 165 is visible at step 0', () => {
    const inStep = 165
    const outStep = 30
    // step 0 is local 3 in a window of steps 165..167,0..2 — pattern index 3
    expect(decodeAlpha(0, inStep, outStep, 0, STEPS)).toBe(DECODE_IN[0]?.[3])
    // mid-hold after decode-in (local 5..hold): fully lit across the wrap
    for (const s of [2, 10, 29]) {
      expect(decodeAlpha(s, inStep, outStep, 0, STEPS)).toBe(1)
    }
    // decode-out at outStep, then dark until the wrap
    expect(decodeAlpha(30 + 6, inStep, outStep, 0, STEPS)).toBe(0)
    expect(decodeAlpha(164, inStep, outStep, 0, STEPS)).toBe(0)
  })

  it('mods the pattern index into the banks', () => {
    expect(decodeAlpha(20, 20, 60, 8, STEPS)).toBe(decodeAlpha(20, 20, 60, 2, STEPS))
  })

  it('smooth mode ramps monotonically in and out instead of blinking', () => {
    const inStep = 20
    const outStep = 60
    let prev = -1
    for (let f = 0; f <= 5; f += 0.25) {
      const a = decodeAlpha(inStep + f, inStep, outStep, 0, STEPS, true)
      expect(a).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = a
    }
    expect(decodeAlpha(inStep + 5, inStep, outStep, 0, STEPS, true)).toBe(1)
    prev = 2
    for (let f = 0; f <= 6; f += 0.25) {
      const a = decodeAlpha(outStep + f, inStep, outStep, 0, STEPS, true)
      expect(a).toBeLessThanOrEqual(prev + 1e-9)
      prev = a
    }
    expect(decodeAlpha(outStep + 6, inStep, outStep, 0, STEPS, true)).toBe(0)
  })

  it('twos mode only ever returns the blink alphabet', () => {
    for (let s = 0; s < STEPS; s++) {
      for (let p = 0; p < 6; p++) {
        const a = decodeAlpha(s, 20, 130, p, STEPS)
        expect([0, 0.35, 1]).toContain(a)
      }
    }
  })

  it('plays the decode-out pattern across the loop boundary when outStep wraps', () => {
    const inStep = 160
    const outStep = 166 // hold = 6, so decode-out occupies steps 166,167,0..3
    for (let k = 0; k < 6; k++) {
      expect(decodeAlpha((outStep + k) % STEPS, inStep, outStep, 2, STEPS)).toBe(DECODE_OUT[2]?.[k])
    }
    // dark after the pattern, on both sides of the wrap
    expect(decodeAlpha(4, inStep, outStep, 2, STEPS)).toBe(0)
    expect(decodeAlpha(159, inStep, outStep, 2, STEPS)).toBe(0)
  })

  it('runs the full decode-in pattern even when outStep lands inside it', () => {
    const inStep = 10
    const outStep = 12 // hold = 2 < IN_LEN — the in window is checked first
    for (let k = 0; k < 5; k++) {
      expect(decodeAlpha(inStep + k, inStep, outStep, 0, STEPS)).toBe(DECODE_IN[0]?.[k])
    }
    // the decode-out tail still plays the slots past the hold
    for (const [s, k] of [[15, 3], [16, 4], [17, 5]] as const) {
      expect(decodeAlpha(s, inStep, outStep, 0, STEPS)).toBe(DECODE_OUT[0]?.[k])
    }
    expect(decodeAlpha(18, inStep, outStep, 0, STEPS)).toBe(0)
  })
})

describe('blinkAlpha', () => {
  it('is fully lit without blinks', () => {
    for (const s of [0, 40.7, STEPS - 1]) {
      expect(blinkAlpha(s, undefined, STEPS)).toBe(1)
    }
  })

  it('goes dark for one step and half-lit the next at each blink', () => {
    const blinks = [40]
    expect(blinkAlpha(39, blinks, STEPS)).toBe(1)
    expect(blinkAlpha(40, blinks, STEPS)).toBe(0)
    expect(blinkAlpha(41, blinks, STEPS)).toBe(0.35)
    expect(blinkAlpha(42, blinks, STEPS)).toBe(1)
  })

  it('wraps around the loop: a blink at the last step shades step 0', () => {
    const blinks = [STEPS - 1]
    expect(blinkAlpha(STEPS - 1, blinks, STEPS)).toBe(0)
    expect(blinkAlpha(0, blinks, STEPS)).toBe(0.35)
    expect(blinkAlpha(1, blinks, STEPS)).toBe(1)
  })

  it('floors fractional steps onto the twos grid', () => {
    const blinks = [10]
    expect(blinkAlpha(10.9, blinks, STEPS)).toBe(0)
    expect(blinkAlpha(11.9, blinks, STEPS)).toBe(0.35)
  })

  it('several blinks each dim their own two steps', () => {
    const blinks = [10, 80]
    expect(blinkAlpha(80, blinks, STEPS)).toBe(0)
    expect(blinkAlpha(81, blinks, STEPS)).toBe(0.35)
    expect(blinkAlpha(12, blinks, STEPS)).toBe(1)
    expect(blinkAlpha(82, blinks, STEPS)).toBe(1)
  })
})

describe('flareTone', () => {
  it('holds full ink through the decode and the flare, then settles to the tone, across the wrap', () => {
    const inStep = STEPS - 2
    const lit = DECODE_IN[0]?.length ?? 0
    expect(flareTone(inStep, inStep, 3, 0.6, STEPS)).toBe(1)
    expect(flareTone((inStep + lit + 2) % STEPS, inStep, 3, 0.6, STEPS)).toBe(1)
    expect(flareTone((inStep + lit + 3) % STEPS, inStep, 3, 0.6, STEPS)).toBe(0.6)
    expect(flareTone(inStep, inStep, undefined, 0.6, STEPS)).toBe(0.6)
  })
})

describe('the steady write-in', () => {
  it('never falls back once it has reached a level, then holds and writes out as the decode does', async () => {
    const { steadyAlpha } = await import('./decode')
    for (let pattern = 0; pattern < 6; pattern++) {
      const run = Array.from({ length: 30 }, (_, s) => steadyAlpha(s, 0, 20, pattern, 168))
      for (let s = 1; s < 20; s++) expect(run[s] as number).toBeGreaterThanOrEqual(run[s - 1] as number)
      expect(run[10]).toBe(1)
    }
  })
})
