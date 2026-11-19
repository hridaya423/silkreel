/** at a phone's width no other part's pads in the held field reach this share of the main chip's level */
export const LEAD = 0.85
/** the renderer's own measure reads up to three points under the delivered film's, which adds compression and the last scaling, so parts are held under this */
export const HOLD = 0.82
const AIM = 0.8
const SLACK = 0.03
/** the level falls slower than the tone under it (the glow and the haze stay), so each step lowers the tone by more than the ratio is over */
const GAIN = 2
const ROUNDS = 8

export interface Levels {
  hero: number
  groups: Map<string, number>
}

/**
 * Each part's tone factor in the held field: 1 for every part whose pads stay
 * under `HOLD` of the main chip's level, and for one that does not, the
 * factor that brings it just under. `measure` gives the levels with a set of
 * factors applied; parts left out of the map keep their tone.
 */
export function solveLead(measure: (lead: Map<string, number>) => Levels): Map<string, number> {
  let lead = new Map<string, number>()
  let kept: Map<string, number> | undefined
  for (let round = 0; round < ROUNDS; round++) {
    const { hero, groups } = measure(lead)
    const ratios = [...groups].map(([g, level]) => [g, level / hero] as const)
    const over = ratios.some(([, r]) => r > HOLD)
    if (!over) kept = lead
    if (!over && ratios.every(([g, r]) => (lead.get(g) ?? 1) === 1 || r >= AIM - SLACK)) return lead
    const next = new Map(lead)
    for (const [g, r] of ratios) {
      const f = lead.get(g) ?? 1
      if (r > HOLD || (f < 1 && r < AIM - SLACK)) next.set(g, Math.min(1, f * (AIM / r) ** GAIN))
    }
    lead = next
  }
  return kept ?? lead
}
