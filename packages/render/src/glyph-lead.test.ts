import { describe, expect, it } from 'vitest'
import { HOLD, LEAD, solveLead } from './glyph-lead'
import type { Levels } from './glyph-lead'

describe('the main chip leads the held field', () => {
  const hero = 200
  const haze = 45
  const parts = { J5: 228, 'REF**': 206, U301: 196, U12: 160, C3: 90 }
  const spill = 0.05
  const measure = (lead: Map<string, number>): Levels => {
    const lit = (g: string): number => haze + (lead.get(g) ?? 1) * (parts[g as keyof typeof parts] - haze)
    const groups = new Map(Object.keys(parts).map((g) => [g, lit(g) + spill * (lit('J5') - haze)]))
    return { hero: hero + spill * (lit('J5') - haze), groups }
  }

  it('lowers every part over the rule to just under it, leaves the rest alone, and never touches the main chip', () => {
    const start = measure(new Map())
    const lead = solveLead(measure)
    const after = measure(lead)
    expect([...start.groups.values()].filter((l) => l / start.hero > HOLD).length, 'parts start over the rule').toBe(3)
    for (const [g, level] of after.groups) {
      const ratio = level / after.hero
      expect(ratio, g).toBeLessThanOrEqual(HOLD)
      expect(HOLD).toBeLessThan(LEAD)
      const before = (start.groups.get(g) as number) / start.hero
      if (before <= HOLD) expect(lead.get(g) ?? 1, `${g} was under the rule`).toBe(1)
      else expect(ratio, `${g} is lowered no further than the rule needs`).toBeGreaterThan(HOLD - 0.06)
    }
    expect(lead.has('hero')).toBe(false)
  })
})
