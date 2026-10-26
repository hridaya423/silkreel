<p align="center">
  <img src="packages/site/public/og.png" alt="silk reel: a circuit board in, a film out" width="100%" />
</p>

<p align="center">
  <b>A KiCad board in. A release film out.</b><br />
  silk reel reads a <code>.kicad_pcb</code> and renders a film of that board, built from its real copper, parts and silkscreen.
</p>

<p align="center">
  <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-ecede9?style=flat-square&labelColor=0b0b0b" />
  <img alt="Node.js 22 or later" src="https://img.shields.io/badge/node-%E2%89%A522-ecede9?style=flat-square&labelColor=0b0b0b&logo=nodedotjs&logoColor=white" />
  <img alt="TypeScript, strict" src="https://img.shields.io/badge/TypeScript-strict-ecede9?style=flat-square&labelColor=0b0b0b&logo=typescript&logoColor=white" />
  <img alt="Input: .kicad_pcb" src="https://img.shields.io/badge/input-.kicad__pcb-ecede9?style=flat-square&labelColor=0b0b0b&logo=kicad&logoColor=white" />
  <img alt="Output: MP4, GIF, WebM, ProRes" src="https://img.shields.io/badge/output-MP4%20%C2%B7%20GIF%20%C2%B7%20WebM%20%C2%B7%20ProRes-ecede9?style=flat-square&labelColor=0b0b0b" />
  <img alt="Sound: CC0" src="https://img.shields.io/badge/sound-CC0-d7261e?style=flat-square&labelColor=0b0b0b" />
</p>

## Two looks, one board

| Trace | Glyph |
|---|---|
| ![The Glasgow board as a trace film](.github/media/glasgow-trace.gif) | ![The Glasgow board as a glyph film](.github/media/glasgow-glyph.gif) |
| The lit board under a camera. Copper routes out from the hero chip, the mask and silkscreen go on, the parts drop onto paste and reflow, and then the board powers on. 12 seconds, with sound. | Every part of the board set as type, in a loop. The hero chip's routes grow, the plan rises, a frame closes around it, and the loop seam is invisible. 11.2 seconds. |

Both films above are the [Glasgow](https://github.com/GlasgowEmbedded/glasgow) rev C3 board, rendered with the commands below.

## Quick start

```bash
git clone https://github.com/hridaya423/silkreel
cd silkreel
npm ci
npm run reel -- fixtures/boards/glasgow.kicad_pcb --style trace --aspect 16:9 -o glasgow.mp4
```

You need Node.js 22 or later, and `ffmpeg` and `ffprobe` on your PATH. The first render downloads a headless Chrome of about 90 MB, once.

To film your own board, give the CLI its file. silk reel reads `.kicad_pcb` files from KiCad 4 or later; it does not read Gerber, Eagle or Altium files.

```bash
npm run reel -- path/to/your-board.kicad_pcb --aspect 9:16 --title "Your Board" --version v1.0
```

A trace film takes about 30 seconds on an Apple M4 Pro and comes out near 8 MB. It also writes `<name>.poster.png`, the last frame, for a cover image. A glyph film renders in about ten seconds, and `--draft` takes a fraction of the time. On a machine without a GPU, put `SILK_REEL_GL=swangle` in front of the command. Run `npm run reel -- --help` to list every flag.

The film is about one part, the hero. silk reel picks the IC with the most pads, then any other part with eight or more pads, then the connector with the most pads. Name a different part with `--hero U3`.

## Options

| flag | values | default |
|---|---|---|
| `--style` | `trace` (the lit board) · `glyph` (parts set as type) | `trace` |
| `--aspect` | `4:5` 1080×1350 · `1:1` 1080×1080 · `9:16` 1080×1920 · `16:9` 1920×1080 | `4:5` |
| `--palette` | `copper` · `mono` · `blueprint` · `phosphor` | `copper` (trace), `mono` (glyph) |
| `--accent` | `#rrggbb` for the hero highlight | the palette's |
| `--hero` | the reference of the part the film is about, e.g. `U3` | the IC with the most pads |
| `--mask` | `green` · `black` · `white` · `blue` · `red` · `yellow` · `purple` (trace) | the board file's, else `green` |
| `--title` | the board's name on a title card; leave it out for no card | none |
| `--version` | a version under the title; needs `--title` | none |
| `--format` | `mp4` · `gif` (720 px wide at most) · `webm-alpha` · `prores-alpha` (4444) | `mp4` |
| `--seed` | any number; each one gives a different variation | `42` |
| `--tempo` | pace, from `0.75` to `1.5` | `1` |
| `--draft` | fast preview quality | off |
| `--no-audio` | leave the score out of a trace film | off |
| `-o` | output path | `<board>-<style>-<aspect>.<ext>` beside the input |
| `-h`, `--help` | list every flag | |

The alpha formats have a transparent background, so you can put the film over your own footage. The same board and flags always render the same film.

## Studio

The [website](packages/site) has a studio that runs in the browser. It plays a draft of both looks, for the sample boards and for your own board. Your board is read in the tab and never uploaded. It records WebM, saves stills, and writes the command for everything else.

Run the full studio on your machine to render every format from a queue:

```bash
npm run start --workspace=@silk-reel/render-api   # render API on :3102
npm run dev --workspace=@silk-reel/studio         # studio on :3101
```

## How it works

1. **`ingest`** parses the `.kicad_pcb` into a board model: outline, copper on every layer, pads, vias, zones, footprints and silkscreen.
2. **`choreo`** compiles the board into a timeline. A trace film is one camera arc on a 24-beat grid: the drawing, the object, a held breath, power-on and a hold. A glyph film picks the hero chip and sets the parts as glyphs across four acts.
3. **`render`** draws each frame. Trace uses WebGL2: a lit plate with component bodies, a perspective camera, depth of field, HDR bloom and motion blur. Glyph draws with Canvas2D.
4. **`render-api`** encodes the frames with Remotion and ffmpeg, and lays the score under trace films, mastered to −14 LUFS.

| package | role |
|---|---|
| [`ingest`](packages/ingest) | `.kicad_pcb` parser to `BoardModel` |
| [`choreo`](packages/choreo) | the style engine: board to `Timeline`, palettes, aspect layout |
| [`render`](packages/render) | frame drawing, the WebGL2 post pass, the Remotion composition |
| [`render-api`](packages/render-api) | Fastify API, render queue, `renderFilm()` for every format |
| [`cli`](packages/cli) | `npm run reel` |
| [`studio`](packages/studio) | the local studio (Vite and the Remotion Player) |
| [`site`](packages/site) | the website and its in-browser studio (Astro) |
| [`metrics`](packages/metrics) | ffmpeg probes and the numeric gate |

## Development

```bash
npx tsc --noEmit         # typecheck
npx vitest run           # tests
npx eslint packages      # lint
npm run test:production  # build the studio and smoke-test it
```

Every change to how a film looks goes through a full-video review. [AGENTS.md](AGENTS.md) has the commands and the rubric.

## Credits

- **Sample boards:** [iCEBreaker](https://github.com/icebreaker-fpga/icebreaker) © 2019 1BitSquared, CC BY-SA 4.0. [Glasgow](https://github.com/GlasgowEmbedded/glasgow) rev C3, Glasgow Embedded, 0BSD. StickHub, the ECC83 preamp, the ColdFire dev kit and the video board are KiCad demo projects.
- **Sound:** CC0 recordings from Freesound, listed in [CREDITS.md](packages/render-api/assets/sound/CREDITS.md).
- **Type:** title cards use JetBrains Mono (SIL Open Font License 1.1, [`OFL.txt`](packages/render/src/assets/OFL.txt)), bundled so renders match on every machine.

## License

silk reel is licensed under the [Apache License 2.0](LICENSE). The sample boards, the sound recordings and the fonts keep their own licenses, listed under Credits.
