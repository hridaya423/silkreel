import { describe, expect, it } from 'vitest'
import { classify } from './cells'

describe('footprint classes', () => {
  it('a hole is a hole prefix and a number, nothing more', () => {
    expect(['H1', 'MH2', 'FID3', 'MK1', 'H'].map((ref) => classify(ref, undefined))).toEqual(['hole', 'hole', 'hole', 'hole', 'hole'])
    expect(['HDMI1', 'HS1', 'MKR1'].map((ref) => classify(ref, undefined))).toEqual(['other', 'other', 'other'])
  })
})
