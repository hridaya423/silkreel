#!/usr/bin/env tsx
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseKicadPcb } from '@silk-reel/ingest'
import { compileTimeline } from '@silk-reel/choreo'
import { renderFilm } from '@silk-reel/render-api'
import { HELP, parseCliArgs } from './args.js'

async function readBoard(input: string): Promise<string> {
  const file = await stat(input).catch(() => undefined)
  if (file === undefined) throw new Error(`No file at ${input}.`)
  if (!file.isFile()) throw new Error(`${input} is a folder. Give the .kicad_pcb file inside it.`)
  if (!input.toLowerCase().endsWith('.kicad_pcb')) {
    throw new Error(`${path.basename(input)} is not a .kicad_pcb file. silk reel reads KiCad board files (KiCad 4 or later); Gerber, Eagle and Altium files are not supported.`)
  }
  return await readFile(input, 'utf8')
}

async function main(): Promise<void> {
  const { input, out, config, format, draft, audio, help } = parseCliArgs(process.argv.slice(2))
  if (help) {
    console.log(HELP)
    return
  }
  const outputLocation = path.resolve(out)
  const text = await readBoard(input)
  await mkdir(path.dirname(outputLocation), { recursive: true }).catch(() => {
    throw new Error(`Cannot write to ${path.dirname(outputLocation)}. Choose another -o path.`)
  })
  const board = parseKicadPcb(text, path.basename(input))
  const timeline = compileTimeline(board, config)
  for (const w of timeline.warnings) console.warn(`warning: ${w.message}`)
  console.log(`${timeline.style} ${timeline.width}x${timeline.height} ${timeline.totalFrames}f @${timeline.fps}fps -> ${format}`)
  const live = process.stdout.isTTY
  const started = Date.now()
  let shown = -1
  const { posterLocation } = await renderFilm({
    inputProps: { timeline, quality: draft ? 'draft' : 'final' },
    outputLocation,
    format,
    audio,
    poster: true,
    onBrowserDownload: (mb) => {
      console.log(`Downloading a headless Chrome (${mb} MB, first run only)…`)
    },
    onProgress: ({ pct, etaSeconds }) => {
      const eta = etaSeconds === null ? '' : `, about ${etaSeconds} s left`
      if (live) process.stdout.write(`\r  ${pct}%${eta}   `)
      else if (pct >= shown + 20) {
        shown = pct - (pct % 20)
        console.log(`  ${pct}%${eta}`)
      }
    }
  })
  if (live) process.stdout.write('\n')
  const { size } = await stat(outputLocation)
  console.log(`${outputLocation} (${(size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - started) / 1000)} s)`)
  if (posterLocation !== undefined) console.log(`${posterLocation} (the last frame, for a cover image)`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
