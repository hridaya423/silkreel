const repo = 'https://github.com/hridaya423/silkreel'

export const site = {
  name: 'silk reel',
  url: 'https://silkreel.hridya.tech',
  repo,
  line: 'KiCad in. Film out.',
  title: 'silk reel: release films from KiCad boards',
  description: "Give silk reel a KiCad board file and it renders a release film from the board's real copper, parts and silkscreen. MP4, GIF, WebM or ProRes.",
  author: { '@type': 'Person', '@id': 'https://www.hridya.tech/#person', name: 'Hridya Agrawal', url: 'https://www.hridya.tech' },
  caseStudy: 'https://www.hridya.tech/projects/silkreel',
  command: 'npm run reel -- board.kicad_pcb',
  setup: `git clone ${repo} && cd silkreel && npm ci`
}

export interface BoardInfo {
  id: string
  name: string
  maker: string
  footprints: number
  /** the hero chip the glyph film lands on, from the compiled timeline */
  hero: { ref: string; value: string }
  /** the name the site's films set, as scripts/render-strobe.sh passes it with --title and --version */
  title?: { name: string; version?: string }
}

/** counts read from each parsed fixture (fixtures/boards, parsed with @silk-reel/ingest) */
export const boards: BoardInfo[] = [
  { id: 'icebreaker', name: 'iCEBreaker', maker: '1BitSquared, CC BY-SA 4.0', footprints: 192, hero: { ref: 'U4', value: 'FT2232H' }, title: { name: 'iCEBreaker', version: 'v1.0e' } },
  { id: 'glasgow', name: 'Glasgow', maker: 'Glasgow project, rev C3', footprints: 272, hero: { ref: 'U1', value: 'CY7C68013A' }, title: { name: 'Glasgow' } },
  { id: 'StickHub', name: 'StickHub', maker: 'KiCad demo', footprints: 94, hero: { ref: 'U1', value: 'XR22417' } },
  { id: 'ecc83-pp', name: 'ECC83 preamp', maker: 'KiCad demo', footprints: 15, hero: { ref: 'U1', value: 'ECC83' }, title: { name: 'ECC83 Preamp' } },
  { id: 'kit-dev-coldfire-xilinx_5213', name: 'ColdFire dev kit', maker: 'KiCad demo', footprints: 160, hero: { ref: 'U301', value: 'XCR3256' }, title: { name: 'ColdFire Xilinx Dev Kit' } },
  { id: 'video', name: 'Video board', maker: 'KiCad demo', footprints: 189, hero: { ref: 'U11', value: 'S5933' }, title: { name: 'Video Board' } }
]

export const aspects = [
  { id: '4:5', use: 'Instagram and LinkedIn feeds' },
  { id: '1:1', use: 'Feeds, avatars, READMEs' },
  { id: '9:16', use: 'Reels, Shorts, Stories' },
  { id: '16:9', use: 'Launch pages, YouTube, talks' }
] as const

export const inks = [
  { id: 'mono', text: 'White silk on black. The default.' },
  { id: 'copper', text: 'Warm silk, an amber head.' },
  { id: 'blueprint', text: 'Pale cyan on navy.' },
  { id: 'phosphor', text: 'Green, like an old scope.' }
] as const

export const formats = [
  { id: 'mp4', name: 'MP4', use: 'Posts, READMEs, launch pages' },
  { id: 'gif', name: 'GIF', use: 'Issues, forums, chat' },
  { id: 'webm-alpha', name: 'WebM', use: 'Overlays on the web and on streams' },
  { id: 'prores-alpha', name: 'ProRes 4444', use: 'Premiere, Resolve, Final Cut' }
] as const
