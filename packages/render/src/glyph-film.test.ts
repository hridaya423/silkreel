import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function localImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  const src = readFileSync(join(import.meta.dirname, `${file}.ts`), 'utf8')
  for (const m of src.matchAll(/(?:from|import) '\.\/([\w-]+)'/g)) localImports(m[1] as string, seen)
  return seen
}

describe('the glyph film', () => {
  it('draws through no trace renderer', () => {
    const files = [...localImports('glyph-film')]
    expect(files).toContain('glyph-draw')
    expect(files.filter((f) => f.startsWith('trace-'))).toEqual([])
  })
})
