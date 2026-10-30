import glyphData from './newstroke.json'

type Pt = { x: number; y: number }
const f = (n: number) => +n.toFixed(2)

class Pen {
  out = ''
  put(s: string) { this.out += s }
  open(attrs: string) { this.put(`<g ${attrs}>`) }
  close() { this.put('</g>') }
  // KiCad's single-stroke lettering (newstroke, CC0), the face every board's silkscreen is printed in
  text(s: string, x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end' = 'start', w = Math.max(0.22, size * 0.1), halo = false) {
    const k = size / 21
    const strokes: Pt[][] = []
    let pen = 0
    for (const ch of s) {
      const g = GLYPHS[ch.codePointAt(0) ?? 32] ?? GLYPHS[32]
      if (!g) continue
      const left = g.charCodeAt(0) - R
      let cur: Pt[] = []
      for (let i = 2; i < g.length; i += 2) {
        if (g[i] === ' ' && g[i + 1] === 'R') { if (cur.length) strokes.push(cur); cur = []; continue }
        cur.push({ x: pen + g.charCodeAt(i) - R - left, y: g.charCodeAt(i + 1) - R })
      }
      if (cur.length) strokes.push(cur)
      pen += g.charCodeAt(1) - R - left
    }
    const dx = anchor === 'start' ? 0 : anchor === 'middle' ? -pen / 2 : -pen
    const d = strokes.map((st) => 'M' + st.map((p) => `${f(x + (p.x + dx) * k)} ${f(y + (p.y + 9) * k)}`).join('L')).join('')
    if (halo) this.put(`<path class="halo" d="${d}" stroke-width="${f(w + size * 0.5)}"/>`)
    this.put(`<path class="t" d="${d}" stroke-width="${f(w)}" pathLength="1"/>`)
    return pen * k
  }
}

const GLYPHS = glyphData as Record<string, string>
// Hershey encoding: every coordinate is a character, offset from 'R'
const R = 82

// lines of the lettering as one standalone SVG, 1em per cap height, so every line scales together
export function lettering(lines: string[], { weight = 0.07, align = 'start', accent = -1 }: { weight?: number; align?: 'start' | 'middle' | 'end'; accent?: number } = {}) {
  const lead = 1.34
  const width = Math.max(...lines.map((l) => new Pen().text(l, 0, 0, 1, 'start', weight)))
  const x = align === 'start' ? 0 : align === 'middle' ? width / 2 : width
  const P = new Pen()
  lines.forEach((l, i) => {
    if (i === accent) P.open('class="lt--accent"')
    P.text(l, x, i * lead, 1, align, weight)
    if (i === accent) P.close()
  })
  const h = (lines.length - 1) * lead + 1
  return `<svg viewBox="${f(-weight)} ${f(-weight)} ${f(width + 2 * weight)} ${f(h + 2 * weight)}" style="width:${f(width + 2 * weight)}em" aria-hidden="true">${P.out.replace(/ pathLength="1"/g, '')}</svg>`
}
