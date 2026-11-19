import { describe, expect, it } from 'vitest'
import { boardTitle, silkRevision } from './board-title'
import { boardModel } from '../test/helpers'

describe('boardTitle', () => {
  it('takes what the user passes first', () => {
    expect(boardTitle(boardModel('icebreaker.kicad_pcb'), { title: { name: 'Ice', version: 'v9' } })).toEqual({ name: 'Ice', nameFrom: 'user', revision: 'v9', revisionFrom: 'user' })
  })

  it('takes the revision the silk prints over a stale title block', () => {
    const t = boardTitle(boardModel('icebreaker.kicad_pcb'), {})
    expect(t).toEqual({ name: 'iCEBreaker', nameFrom: 'title-block', revision: 'V1.0e', revisionFrom: 'silk' })
  })

  it('finds a revision after rev or v inside a longer silk text, never a bare number such as USB 2.0', () => {
    expect(silkRevision(boardModel('glasgow.kicad_pcb'))).toBe('C3')
    expect(silkRevision(boardModel('StickHub.kicad_pcb'))).toBe('v1.4.0')
  })

  it('falls back to the title block, and names a board by its file when the title block names something else', () => {
    expect(boardTitle(boardModel('kit-dev-coldfire-xilinx_5213.kicad_pcb'), {})).toEqual({ name: 'kit dev coldfire xilinx 5213', nameFrom: 'file', revision: '2', revisionFrom: 'title-block' })
    expect(boardTitle(boardModel('glasgow.kicad_pcb'), {})).toEqual({ name: 'glasgow', nameFrom: 'file', revision: 'C3', revisionFrom: 'silk' })
    expect(boardTitle(boardModel('ecc83-pp.kicad_pcb'), {})).toEqual({ name: 'ecc83 pp', nameFrom: 'file', revision: undefined, revisionFrom: undefined })
  })

  it('keeps the user name and still reads the revision from the board when only a name is passed', () => {
    expect(boardTitle(boardModel('icebreaker.kicad_pcb'), { title: { name: 'iCEBreaker' } })).toMatchObject({ revision: 'V1.0e', revisionFrom: 'silk' })
  })
})
