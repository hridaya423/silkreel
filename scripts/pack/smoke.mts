import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const [tarballArg, boardArg] = args.filter((a) => !a.startsWith('--'))
const tarball = path.resolve(tarballArg ?? readdirSync(path.join(root, 'dist-npm')).filter((f) => f.endsWith('.tgz')).map((f) => path.join(root, 'dist-npm', f)).sort().at(-1) ?? '')
const board = path.resolve(boardArg ?? path.join(root, 'fixtures/boards/icebreaker.kicad_pcb'))
if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}; run npm run pack:npx first`)

function which(name: string, from: string[]): string | undefined {
  return from.map((dir) => path.join(dir, name)).find((file) => existsSync(file))
}

const dirs = (process.env.PATH ?? '').split(path.delimiter)
const hidden = await mkdtemp(path.join('/private/tmp', 'silk-reel-nopath-'))
for (const tool of ['node', 'npm', 'npx']) {
  const found = which(tool, dirs)
  if (found !== undefined) symlinkSync(found, path.join(hidden, tool))
}
const withoutFfmpeg = [hidden, ...dirs.filter((dir) => !existsSync(path.join(dir, 'ffmpeg')))].join(path.delimiter)

const work = await mkdtemp(path.join('/private/tmp', 'silk-reel-smoke-'))
const run = (command: string, argv: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(command, argv, { cwd: work, encoding: 'utf8', env: { ...process.env, SILK_REEL_CONCURRENCY: '2', ...env } })
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n${detail}`}`)
  if (!ok) failed++
}

try {
  execFileSync('npm', ['init', '-y'], { cwd: work, stdio: 'ignore' })
  const installed = run('npm', ['install', '--no-audit', '--no-fund', tarball])
  check('npm install of the tarball', installed.status === 0, installed.stderr)

  const help = run('npx', ['silk-reel', '--help'])
  check('--help prints usage', help.status === 0 && help.stdout.includes('usage: npx silk-reel'), help.stdout + help.stderr)

  const bad = run('npx', ['silk-reel', path.join(work, 'package.json')])
  check('a non-board prints a one-line message, no stack', bad.status === 1 && bad.stderr.includes('is not a .kicad_pcb file') && !bad.stderr.includes('    at '), bad.stderr)

  for (const style of ['trace', 'plot', 'montage']) {
    const film = path.join(work, `${style}.mp4`)
    const render = run('npx', ['silk-reel', board, '--style', style, '--draft', '--aspect', '9:16', '-o', film], { PATH: withoutFfmpeg })
    check(`${style}: draft render with no ffmpeg on PATH`, render.status === 0 && existsSync(film), render.stdout + render.stderr)
    if (!existsSync(film)) continue
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', film], { encoding: 'utf8' })) as {
      streams: Array<{ codec_type: string; codec_name: string }>
      format: { duration: string }
    }
    const kinds = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`)
    check(`${style}: mp4 holds picture and sound (${kinds.join(', ')}, ${Number(probe.format.duration).toFixed(1)} s, ${((await stat(film)).size / 1e6).toFixed(1)} MB)`, kinds.some((k) => k.startsWith('video')) && kinds.some((k) => k.startsWith('audio')) && Number(probe.format.duration) > 5)
    check(`${style}: the poster is written`, existsSync(path.join(work, `${style}.poster.png`)))
  }
} finally {
  await rm(hidden, { recursive: true, force: true })
  if (keep) console.log(`kept ${work}`)
  else await rm(work, { recursive: true, force: true })
}
if (failed > 0) process.exit(1)
