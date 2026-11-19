import { build } from 'esbuild'
import { bundle } from '@remotion/bundler'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORBIDDEN, packageJson } from '../../packages/cli/src/npx/manifest.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dist = path.join(root, 'dist-npm')
const out = path.join(dist, 'silk-reel')
const read = (file: string): Promise<string> => readFile(path.join(root, file), 'utf8')

const USAGE_FROM = 'usage: npm run reel -- <board.kicad_pcb> [options]'
const USAGE_TO = 'usage: npx silk-reel <board.kicad_pcb> [options]'

function onlyOnce(source: string, from: string, to: string, file: string): string {
  if (source.split(from).length !== 2) throw new Error(`${file}: expected exactly one "${from}"`)
  return source.replace(from, to)
}

await rm(out, { recursive: true, force: true })
await mkdir(path.join(out, 'dist'), { recursive: true })

await build({
  entryPoints: [path.join(root, 'packages/cli/src/cli.ts')],
  outfile: path.join(out, 'dist/cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  external: ['@remotion/renderer', 'occt-import-js'],
  alias: {
    '@silk-reel/render-api': path.join(root, 'packages/cli/src/npx/render-api.ts'),
    '@remotion/bundler': path.join(root, 'packages/cli/src/npx/no-bundler.ts')
  },
  plugins: [
    {
      name: 'package-the-cli',
      setup(b) {
        b.onLoad({ filter: /packages\/cli\/src\/cli\.ts$/ }, async (args) => ({
          contents: onlyOnce(await readFile(args.path, 'utf8'), '#!/usr/bin/env tsx\n', '', 'cli.ts'),
          loader: 'ts'
        }))
        b.onLoad({ filter: /packages\/cli\/src\/args\.ts$/ }, async (args) => ({
          contents: onlyOnce(await readFile(args.path, 'utf8'), USAGE_FROM, USAGE_TO, 'args.ts'),
          loader: 'ts'
        }))
      }
    }
  ],
  logLevel: 'warning'
})
await chmod(path.join(out, 'dist/cli.mjs'), 0o755)

await bundle({
  entryPoint: path.join(root, 'packages/render/src/remotion-entry.tsx'),
  outDir: path.join(out, 'bundle'),
  enableCaching: false,
  onProgress: () => undefined
})
for (const file of await readdir(path.join(out, 'bundle'))) {
  const location = path.join(out, 'bundle', file)
  if (file.endsWith('.map')) await rm(location)
  else if (file.endsWith('.js')) await writeFile(location, (await readFile(location, 'utf8')).replace(/^\/\/[#@] ?sourceMappingURL=.*$/gm, ''))
}
const index = path.join(out, 'bundle/index.html')
await writeFile(index, (await readFile(index, 'utf8')).replace(/window\.remotion_cwd = "[^"]*"/, 'window.remotion_cwd = "/"'))

await cp(path.join(root, 'packages/render-api/assets/sound'), path.join(out, 'assets/sound'), { recursive: true })
await mkdir(path.join(out, 'licenses'), { recursive: true })
for (const file of await readdir(path.join(root, 'packages/render/src/assets'))) {
  if (file.startsWith('OFL')) await cp(path.join(root, 'packages/render/src/assets', file), path.join(out, 'licenses', file))
}
await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'))
await cp(path.join(root, 'scripts/pack/README.npm.md'), path.join(out, 'README.md'))

const installed = async (name: string): Promise<string> =>
  (JSON.parse(await read(`node_modules/${name}/package.json`)) as { version: string }).version
const rootManifest = JSON.parse(await read('package.json')) as Record<string, unknown>
const cliManifest = JSON.parse(await read('packages/cli/package.json')) as { version: string }
await writeFile(
  path.join(out, 'package.json'),
  JSON.stringify(
    packageJson({
      version: cliManifest.version,
      root: rootManifest,
      dependencies: {
        '@remotion/renderer': await installed('@remotion/renderer'),
        'occt-import-js': await installed('occt-import-js'),
        react: await installed('react'),
        'react-dom': await installed('react-dom')
      }
    }),
    null,
    2
  ) + '\n'
)

const leaks = spawnSync('grep', ['-rlIF', root, out], { encoding: 'utf8' }).stdout.trim()
if (leaks !== '') throw new Error(`the build holds this machine's path ${root} in: ${leaks}`)

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', dist], { cwd: out, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
) as Array<{ filename: string; size: number; unpackedSize: number; files: Array<{ path: string; size: number }> }>
const [tarball] = packed
if (tarball === undefined) throw new Error('npm pack reported nothing')
const forbidden = tarball.files.filter((f) => FORBIDDEN.some((pattern) => pattern.test(f.path)))
if (forbidden.length > 0) throw new Error(`the tarball holds files it must not: ${forbidden.map((f) => f.path).join(', ')}`)

console.log(`\n${tarball.filename}: ${(tarball.size / 1e6).toFixed(2)} MB packed, ${(tarball.unpackedSize / 1e6).toFixed(2)} MB unpacked, ${tarball.files.length} files`)
for (const f of tarball.files) console.log(`  ${f.path.padEnd(40)} ${(f.size / 1e3).toFixed(0).padStart(7)} kB`)
console.log(`\n${path.join(dist, tarball.filename)}`)
await stat(path.join(dist, tarball.filename))
