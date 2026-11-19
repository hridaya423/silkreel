#!/usr/bin/env tsx
// Quantitative companion to review.ts: decodes each mp4 in a review dir and
// prints per-frame coverage/motion/seam stats, scene statistics, and ASCII
// thumbnails (max-pooled, so hairline copper survives downsampling) — enough
// evidence to fill in notes.md without eyeballing PNGs, and to catch real
// problems (dead air, clipping, stalls, washed-out palette) numerically.
// usage: npx tsx scripts/review-stats.mts [review/<stamp>]
import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { probeVideo, decodeGrayFrames } from '../packages/metrics/src/decode.js'
import { analyzeFrame } from '../packages/metrics/src/analyzer.js'
import { compileTimeline } from '../packages/choreo/src/index.js'
import type { TraceTimeline } from '../packages/choreo/src/index.js'
import { loadDemoBoard, defaultFilmConfig } from '../packages/render-api/src/boards.js'

const root = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const dirArg = argv.find((a) => !a.startsWith('--'))
const dir = dirArg !== undefined
  ? path.resolve(dirArg)
  : path.join(root, 'review', readdirSync(path.join(root, 'review')).filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort().at(-1) as string)

const SAMPLE_P = [0.03, 0.08, 0.15, 0.35, 0.55, 0.73, 0.82, 0.9, 0.975]
const DEAD_LIT = 0.08 // litPct below this counts as near-empty
const STALL_DIFF = 0.03 // mean abs diff below this reads as a freeze

const boardOf = (name: string): string => name.replace(/^trace-|^glyph-/, '').replace(/-[^-]+$/, '')

function asciiFrame(data: Uint8Array, width: number, height: number, cols = 100): string {
  const rows = Math.round((height / width) * cols * 0.5)
  const bx = width / cols
  const by = height / rows
  const ramp = ' .:-=+*#%@'
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      let max = 0
      const x0 = Math.floor(c * bx)
      const x1 = Math.max(x0 + 1, Math.floor((c + 1) * bx))
      const y0 = Math.floor(r * by)
      const y1 = Math.max(y0 + 1, Math.floor((r + 1) * by))
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const v = data[y * width + x] as number
          if (v > max) max = v
        }
      }
      line += ramp[Math.min(ramp.length - 1, Math.floor((max / 255) * ramp.length))]
    }
    lines.push(line)
  }
  return lines.join('\n')
}

const pct = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number
}

const f2 = (n: number): string => n.toFixed(2)

async function sceneStats(boardId: string, style: string, aspect: string): Promise<string> {
  const board = await loadDemoBoard(boardId)
  const tl = compileTimeline(board, { ...defaultFilmConfig(boardId), style, aspect } as never)
  const base = `${tl.width}x${tl.height} ${tl.durationSeconds}s/${tl.totalFrames}f warn=[${tl.warnings.map((w) => w.code).join(',')}]`
  if (tl.style === 'glyph') return `${base} glyph cast=${tl.cast.length}`
  if (tl.style !== 'trace') return base
  const t = tl as TraceTimeline
  const widths: number[] = []
  const perLayer: string[] = []
  for (const l of t.scene.layers) {
    const n = l.segs.length / 7
    perLayer.push(`${l.id}(${l.side}):${n}`)
    for (let i = 0; i < n; i++) widths.push(l.segs[i * 7 + 4] as number)
  }
  const padW = t.scene.pads.map((p) => p.w)
  const padH = t.scene.pads.map((p) => p.h)
  const textSize = t.scene.texts.map((x) => x.size)
  const segsTotal = t.scene.layers.reduce((s, l) => s + l.segs.length / 7, 0)
  return `${base}\n  scene: ${segsTotal} segs [${perLayer.join(' ')}] pads=${t.scene.pads.length} vias=${t.scene.vias.length} zones=${t.scene.zones.length} silk=${t.scene.silkStrokes.length} texts=${t.scene.texts.length}\n` +
    `  widthPx p10=${f2(pct(widths, 0.1))} p50=${f2(pct(widths, 0.5))} p90=${f2(pct(widths, 0.9))} max=${f2(Math.max(...widths))} | ` +
    `pad w p10=${f2(pct(padW, 0.1))} p90=${f2(pct(padW, 0.9))} h p10=${f2(pct(padH, 0.1))} p90=${f2(pct(padH, 0.9))} | ` +
    `text px min=${textSize.length > 0 ? f2(Math.min(...textSize)) : '-'} max=${textSize.length > 0 ? f2(Math.max(...textSize)) : '-'}`
}

async function videoStats(file: string): Promise<void> {
  const name = path.basename(file, '.mp4')
  const facts = await probeVideo(file)
  const total = facts.frameCount ?? 0
  const keepIdx = new Set(SAMPLE_P.map((p) => Math.min(total - 1, Math.max(0, Math.floor(p * total)))))
  const lit: number[] = []
  const diffs: number[] = []
  const bboxes: Array<{ x0: number; y0: number; x1: number; y1: number } | undefined> = []
  const centroids: Array<{ x: number; y: number }> = []
  let prev: Uint8Array | undefined
  let first: Uint8Array | undefined
  let last: Uint8Array | undefined
  let edgeTouch = 0
  const samples = new Map<number, Uint8Array>()
  let bgMeanMax = 0
  for await (const frame of decodeGrayFrames(file, { width: facts.width, height: facts.height })) {
    const s = analyzeFrame(frame)
    lit.push(s.litPct)
    bboxes.push(s.bbox)
    centroids.push(s.centroid)
    if (s.bgMeanBrightness > bgMeanMax) bgMeanMax = s.bgMeanBrightness
    if (s.bbox !== undefined && (s.bbox.x0 <= 2 || s.bbox.y0 <= 2 || s.bbox.x1 >= facts.width - 3 || s.bbox.y1 >= facts.height - 3)) edgeTouch += 1
    if (prev !== undefined) {
      let d = 0
      for (let i = 0; i < frame.data.length; i += 4) d += Math.abs((frame.data[i] as number) - (prev[i] as number))
      diffs.push(d / (frame.data.length / 4))
    }
    if (first === undefined) first = frame.data
    prev = frame.data
    last = frame.data
    if (keepIdx.has(frame.index)) samples.set(frame.index, frame.data)
  }
  const n = lit.length
  const p = (i: number): number => i / n
  let seam = 0
  if (first !== undefined && last !== undefined) {
    for (let i = 0; i < first.length; i += 4) seam += Math.abs((first[i] as number) - (last[i] as number))
    seam /= first.length / 4
  }
  const firstLit = lit.findIndex((v) => v > 0.05)
  const litAt = (sec: number): number => lit[Math.min(n - 1, Math.round(sec * facts.fps))] ?? 0
  // dead air: runs of near-empty frames (ignoring the first/last 2% = seam breath)
  let deadFrames = 0
  let deadLongest = 0
  let deadRun = 0
  let deadWorstAt = 0
  lit.forEach((v, i) => {
    const inSeam = i < n * 0.02 || i > n * 0.98
    const dead = v < DEAD_LIT && !inSeam
    if (dead) {
      deadFrames += 1
      deadRun += 1
      if (deadRun > deadLongest) {
        deadLongest = deadRun
        deadWorstAt = i
      }
    } else deadRun = 0
  })
  // stalls / pops on motion diff
  let stallRun = 0
  let stallLongest = 0
  let stallAt = 0
  let diffMax = 0
  let diffMaxAt = 0
  diffs.forEach((d, i) => {
    if (d > diffMax) {
      diffMax = d
      diffMaxAt = i
    }
    const nearSeam = i < n * 0.02 || i > n * 0.97
    if (d < STALL_DIFF && !nearSeam) {
      stallRun += 1
      if (stallRun > stallLongest) {
        stallLongest = stallRun
        stallAt = i
      }
    } else stallRun = 0
  })
  const motion = diffs.reduce((s, d) => s + d, 0) / Math.max(1, diffs.length)
  const peak = Math.max(...lit)
  const peakAt = lit.indexOf(peak)
  const plateau = lit.filter((v) => v >= peak * 0.9).length
  // composition at hold midpoint
  const holdIdx = Math.floor(n * 0.89)
  const hb = bboxes[holdIdx]
  const hc = centroids[holdIdx] ?? { x: 0, y: 0 }
  const safe = { x: facts.width * 0.1, y: facts.height * 0.1, w: facts.width * 0.8, h: facts.height * 0.8 }
  const coverPct = hb !== undefined ? ((hb.x1 - hb.x0) * (hb.y1 - hb.y0)) / (safe.w * safe.h) * 100 : 0
  const spark = SAMPLE_P.slice(0, -1).map((q) => `${f2(q)}:${f2(lit[Math.floor(q * (n - 1))] ?? 0)}`).join(' ')

  console.log(`\n=== ${name} — ${facts.width}x${facts.height}@${f2(facts.fps)} ${f2(facts.durationSeconds)}s ${n}f ${facts.codec}/${facts.pixFmt}`)
  console.log(`  lit% @p: ${spark} | peak ${f2(peak)}% @p=${f2(p(peakAt))} plateau>=90%: ${f2(plateau / facts.fps)}s`)
  console.log(`  hook: firstLit f${firstLit} (${f2(firstLit / facts.fps)}s) lit@0.5s=${f2(litAt(0.5))}% lit@1s=${f2(litAt(1))}%`)
  console.log(`  dead-air: ${deadFrames}f (${f2((deadFrames / n) * 100)}%) longest ${deadLongest}f @p=${f2(p(deadWorstAt))}`)
  console.log(`  motion: meanDiff=${f2(motion)} longest stall: ${stallLongest}f@p=${f2(p(stallAt))} maxDiff=${f2(diffMax)} @p=${f2(p(diffMaxAt))}`)
  console.log(`  seam: first<->last=${f2(seam)} lit(first)=${f2(lit[0] ?? 0)}% lit(last)=${f2(lit[n - 1] ?? 0)}%`)
  if (hb !== undefined) {
    console.log(`  comp@hold: bbox ${hb.x0},${hb.y0}-${hb.x1},${hb.y1} = ${hb.x1 - hb.x0}x${hb.y1 - hb.y0}px covers ${f2(coverPct)}% of safe ${safe.w}x${safe.h} centroid ${f2(hc.x)},${f2(hc.y)} vs ${facts.width / 2},${facts.height / 2} edge-touch frames=${edgeTouch}`)
  } else {
    console.log(`  comp@hold: EMPTY at p=0.89 edge-touch frames=${edgeTouch}`)
  }
  console.log(`  bg: bgMeanMax=${f2(bgMeanMax)}`)

  const asciiPath = path.join(dir, `${name}.ascii.txt`)
  const parts: string[] = []
  for (const q of SAMPLE_P) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(q * n)))
    const data = samples.get(idx)
    if (data === undefined) continue
    parts.push(`\n----- p=${f2(q)} frame ${idx} lit=${f2(lit[idx] ?? 0)}% -----\n${asciiFrame(data, facts.width, facts.height)}`)
  }
  writeFileSync(asciiPath, parts.join('\n'))
  console.log(`  ascii -> ${path.relative(root, asciiPath)}`)
}

console.log(`review dir: ${dir}`)
const mp4s = readdirSync(dir).filter((f) => f.endsWith('.mp4') && f !== 'reference.mp4').sort()
for (const f of mp4s) {
  const name = f.replace(/\.mp4$/, '')
  const [style, , aspectRaw] = [name.split('-')[0] ?? '', '', name.split('-').at(-1) ?? '']
  const aspect = aspectRaw.replace('x', ':')
  try {
    console.log(`\n### ${name}`)
    console.log(await sceneStats(boardOf(name), style, aspect))
  } catch (err) {
    console.log(`  scene stats failed: ${String(err)}`)
  }
  await videoStats(path.join(dir, f))
}
