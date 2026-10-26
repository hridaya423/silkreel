import { describe, expect, it } from 'vitest'
import { parseCliArgs } from './args.js'

describe('parseCliArgs', () => {
  it('defaults to trace 4:5 mp4 next to the input', () => {
    const a = parseCliArgs(['boards/glasgow.kicad_pcb'])
    expect(a.format).toBe('mp4')
    expect(a.out).toBe('boards/glasgow-trace-4x5.mp4')
    expect(a.config.style).toBe('trace')
    expect(a.config.aspect).toBe('4:5')
    expect(a.config.output).toMatchObject({ width: 1080, height: 1350 })
    expect(a.config.cast?.preferRefs).toContain('U1') // fixture boards keep the studio's cast hints
    expect(a.config.transparent).toBeUndefined()
  })

  it('round-trips every flag', () => {
    const a = parseCliArgs([
      'x/ice.kicad_pcb', '-o', '/tmp/ice.webm', '--style', 'glyph', '--aspect', '9:16', '--palette', 'blueprint',
      '--accent', '#ff00aa', '--title', 'iCEBreaker', '--version', 'v1.0e', '--seed', '7', '--tempo', '1.2',
      '--format', 'webm-alpha'
    ])
    expect(a).toMatchObject({ input: 'x/ice.kicad_pcb', out: '/tmp/ice.webm', format: 'webm-alpha' })
    expect(a.config).toMatchObject({
      style: 'glyph', aspect: '9:16', palette: 'blueprint', accent: '#ff00aa', seed: 7, transparent: true,
      title: { name: 'iCEBreaker', version: 'v1.0e' }, knobs: { tempo: 1.2 },
      output: { width: 1080, height: 1920 }
    })
  })

  it('rejects bad values', () => {
    expect(() => parseCliArgs(['b.kicad_pcb', '--aspect', '3:2'])).toThrow(/--aspect/)
    expect(() => parseCliArgs(['b.kicad_pcb', '--format', 'avi'])).toThrow(/--format/)
    expect(() => parseCliArgs(['b.kicad_pcb', '--accent', 'red'])).toThrow(/--accent/)
    expect(() => parseCliArgs([])).toThrow(/usage/)
  })

  it('reads --hero and --mask, and rejects a mask colour it does not know', () => {
    const a = parseCliArgs(['b.kicad_pcb', '--hero', 'U3', '--mask', 'blue'])
    expect(a.config).toMatchObject({ hero: 'U3', mask: 'blue' })
    expect(() => parseCliArgs(['b.kicad_pcb', '--mask', 'teal'])).toThrow(/--mask/)
  })

  it('answers --help and -h without a board', () => {
    expect(parseCliArgs(['--help']).help).toBe(true)
    expect(parseCliArgs(['-h']).help).toBe(true)
  })

  it('suggests the nearest flag for a typo', () => {
    expect(() => parseCliArgs(['b.kicad_pcb', '--styel', 'glyph'])).toThrow(/Did you mean --style\?/)
    expect(() => parseCliArgs(['b.kicad_pcb', '--zzzzzzz'])).toThrow(/Unknown option --zzzzzzz\. Run with --help/)
  })
})
