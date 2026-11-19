import { describe, expect, it } from 'vitest'
import { FORBIDDEN, packageJson } from './manifest.js'

const forbidden = (file: string): boolean => FORBIDDEN.some((pattern) => pattern.test(file))

describe('what the tarball may hold', () => {
  it.each([
    'fixtures/boards/icebreaker.kicad_pcb',
    'fixtures/reference/pcbanimation.mp4',
    'reference/pcbanimation.mp4',
    'docs/reviews/notes.md',
    'cook/state.json',
    'review/2026/index.html',
    'dist/cli.test.js',
    'bundle/bundle.js.map',
    'node_modules/react/index.js'
  ])('refuses %s', (file) => {
    expect(forbidden(file)).toBe(true)
  })

  it.each(['dist/cli.mjs', 'bundle/bundle.js', 'bundle/index.html', 'assets/sound/CREDITS.md', 'assets/sound/click-1.wav', 'licenses/OFL.txt', 'LICENSE', 'README.md', 'package.json'])('allows %s', (file) => {
    expect(forbidden(file)).toBe(false)
  })
})

describe('packageJson', () => {
  const manifest = packageJson({ version: '0.1.0', root: { description: 'd', keywords: ['k'], repository: { type: 'git', url: 'u' }, bugs: 'b', license: 'Apache-2.0', private: true }, dependencies: { react: '19.2.8' } })

  it('is publishable and runs through the cli bundle', () => {
    expect(manifest.name).toBe('silk-reel')
    expect(manifest.private).toBeUndefined()
    expect(manifest.bin).toEqual({ 'silk-reel': './dist/cli.mjs' })
    expect(manifest.dependencies).toEqual({ react: '19.2.8' })
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'bundle', 'assets', 'licenses']))
  })
})
