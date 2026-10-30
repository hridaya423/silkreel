const repo = 'https://github.com/hridaya423/silkreel'

export const site = {
  name: 'silk reel',
  url: 'https://silkreel.hridya.tech',
  repo,
  line: 'KiCad in. Film out.',
  description: 'Turn a KiCad board file into a release film: the lit board under a camera, or its parts set as a looping glyph film. Any aspect, any format.',
  command: 'npm run reel -- board.kicad_pcb',
  setup: `git clone ${repo} && cd silkreel && npm ci`
}

/** the boards whose 16:9 trace film the site ships in public/films/trace (scripts/trace-films.sh) */
export const traceFilms: readonly string[] = ['icebreaker', 'glasgow', 'StickHub', 'ecc83-pp', 'kit-dev-coldfire-xilinx_5213', 'video']

export interface BoardInfo {
  id: string
  name: string
  maker: string
  what: string
  layers: number
  traces: number
  pads: number
  vias: number
  footprints: number
  /** the hero chip the glyph film lands on, from the compiled timeline */
  hero: { ref: string; value: string }
  note?: string
}

/** counts read from each parsed fixture (fixtures/boards, parsed with @silk-reel/ingest) */
export const boards: BoardInfo[] = [
  { id: 'icebreaker', name: 'iCEBreaker', maker: '1BitSquared, CC BY-SA 4.0', what: 'iCE40 FPGA dev board', layers: 4, traces: 1394, pads: 636, vias: 157, footprints: 192, hero: { ref: 'U4', value: 'FT2232H' } },
  { id: 'glasgow', name: 'Glasgow', maker: 'Glasgow project, rev C3', what: 'digital interface explorer', layers: 4, traces: 4715, pads: 1149, vias: 416, footprints: 272, hero: { ref: 'U1', value: 'CY7C68013A' } },
  { id: 'StickHub', name: 'StickHub', maker: 'KiCad demo', what: 'USB hub on a stick', layers: 2, traces: 1293, pads: 278, vias: 87, footprints: 94, hero: { ref: 'U1', value: 'XR22417' }, note: 'The hero chip sits on the back of the board.' },
  { id: 'ecc83-pp', name: 'ECC83 preamp', maker: 'KiCad demo', what: 'through-hole valve preamp', layers: 2, traces: 59, pads: 33, vias: 0, footprints: 15, hero: { ref: 'U1', value: 'ECC83' } },
  { id: 'kit-dev-coldfire-xilinx_5213', name: 'ColdFire dev kit', maker: 'KiCad demo', what: 'ColdFire MCF5213 with a Xilinx part', layers: 4, traces: 2935, pads: 825, vias: 253, footprints: 160, hero: { ref: 'U301', value: 'XCR3256' } },
  { id: 'video', name: 'Video board', maker: 'KiCad demo', what: 'the densest demo, 7,932 traces', layers: 4, traces: 7932, pads: 2118, vias: 808, footprints: 189, hero: { ref: 'U11', value: 'S5933' } }
]

/** the glyph loop's steps on its 24-beat score (choreo/src/acts.ts), named in plain words */
export const acts = [
  { at: 0, say: 'grow' },
  { at: 4, say: 'rise' },
  { at: 12, say: 'frame' },
  { at: 20, say: 'loop' }
] as const

export const aspects = [
  { id: '4:5', size: '1080 × 1350', use: 'Instagram and LinkedIn feeds' },
  { id: '1:1', size: '1080 × 1080', use: 'Feeds, avatars, READMEs' },
  { id: '9:16', size: '1080 × 1920', use: 'Reels, Shorts, Stories' },
  { id: '16:9', size: '1920 × 1080', use: 'Launch pages, YouTube, talks' }
] as const

export const inks = [
  { id: 'mono', text: 'White silk on black. The default.' },
  { id: 'copper', text: 'Warm silk, an amber head.' },
  { id: 'blueprint', text: 'Pale cyan on navy.' },
  { id: 'phosphor', text: 'Green, like an old scope.' }
] as const

/** measured on the StickHub glyph film, 16:9, 11.2 s (scripts/films.sh) */
export const formats = [
  { id: 'mp4', name: 'MP4', codec: 'H.264', px: '1920 × 1080', size: '2.4 MB', alpha: false, use: 'Posts, READMEs, launch pages' },
  { id: 'gif', name: 'GIF', codec: 'No grain', px: '720 × 405', size: '88 KB', alpha: false, use: 'Issues, forums, chat' },
  { id: 'webm-alpha', name: 'WebM', codec: 'VP9 with alpha', px: '1920 × 1080', size: '163 KB', alpha: true, use: 'Overlays on the web and on streams' },
  { id: 'prores-alpha', name: 'ProRes 4444', codec: 'With alpha', px: '1920 × 1080', size: '38.6 MB', alpha: true, use: 'Premiere, Resolve, Final Cut' }
] as const
