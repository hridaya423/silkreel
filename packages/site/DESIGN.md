# silk reel: brand

silk reel turns a KiCad board file into a release film of that board. The site is its launch page and its studio. Every change to the site is checked against this page.

## Principles

1. **Show the film, not the metaphor.** Sprocket holes, strips and frames appear only on things that are film: the filmstrip under the cut, the studio monitor and the footer bench. They never decorate a section edge, a label, an eyebrow or a table.
2. **Say it once.** No caption that restates the thing beside it, no label on an obvious control, no hint for something that just works, no copy defending a decision. A string stays only if the visitor cannot act without it (clean-copy ladder).
3. **Plain words.** Public copy never uses the engine's vocabulary: drawings, beats, acts, spine, pillars, hero chip, designators, render API (outside the self-hosting docs), zones, sheets. The film's steps are named by what happens: draw, pour, mask, silk, place, reflow, wait, power, hold; grow, rise, frame, loop.
4. **One focal point per screen, one primary action per screen.** One filled button a screen; everything else is outlined or a text link.
5. **Motion explains.** It shows playback, a page change or a state change. Nothing moves to prove the page is interactive. Every motion has a reduced-motion still.
6. **Polish over features.** Fewer, finished things. A control that cannot work for a visitor (the local render API) is hidden until it can.

## Voice

Short declarative sentences. Concrete nouns: board, film, frame, command. Second person for actions ("Drop your board"). No exclamation marks, no superlatives, no "simply", no "powerful".

## Type

- **NewStroke** (KiCad's single-stroke lettering, CC0, Vladimir Lapygin): every heading, drawn as SVG strokes by `Lettering.astro` (real text stays in the DOM for assistive tech). Uppercase, 1em per cap height, one SVG per heading so its lines scale together. Stroke weight 0.06–0.09 em. It is the face printed on real boards, and the drawing's own lettering.
- **Martian Mono** (OFL, variable weight and width): everything else, at width 87.5 %: ledes, body, buttons, labels, commands. Commands drop to width 75 % where space is tight.
- **JetBrains Mono** stays only inside the films (`SilkMono`), because the renderer draws captions with it.
- Scale (tokens.css): xl, l, m, body 16 px, s 14 px, label 13 px. Display classes are sized for the lettering (0.62 of `--t-xl`, 0.66 of `--t-l`). Nothing under 13 px except mono timecode at 12 px and dimension values at 9–10 px.
- Uppercase only in NewStroke lettering and dimension values. Sentence case everywhere else.

## Colour

- Opal `#ecede9` ground, stock `#0b0b0b` ink and dark sections (`.pos`), one red: `#c4221a` on opal, `#ff4a3d` on stock (both 4.5:1). Muted text `#4a4a46` on opal, `#a9a9a3` on stock. Opal, ink and the opal red are also the plot look's `paper` palette, so the plot film and the page are one sheet.
- Red marks only the current thing: the active nav link, the playhead, the cut, the primary button on hover, and in the plot film the live nets after power-on. Never decoration.

## Shape

- Radius: 6 px on buttons and inputs, 8 px on panels and the terminal, 0 on film frames (film has square corners).
- Lines: 1 px at 14 % or 30 % ink. No double rules, no zone grids, no title blocks outside the drawing.

## The cut

Home opens on one stage that holds for three shots (`#film`, `src/cut/`). It is the product's claim made visible: the same board file, in three looks.

- Two films of Glasgow share one camera: the **plot** film, drawn live in the page from its timeline (`public/films/plot/`, written by `scripts/plot-timelines.mts`), and the **trace** film as video (`public/films/cut/`). Both are compiled with the same config and part models, so they register to the pixel. Re-render both together or the cut tears.
- One WebGL2 shader (`cut-gl.ts`) composites them across a straight cut: plot on the paper side, trace on the stock side, a red hairline on the cut itself. On arrival the plot sweeps in and the cut slides in carrying the lit board. Fine grain unifies the two; film edges are feathered so a frame edge never shows as a line.
- Shots: hero (the held poster; on windows narrower than 16:9 the board moves aside so the words stay on paper), every frame (the cut wipes off and scroll runs the plot film under a strip of its real frames), three looks (scroll reveals them in order: plot alone, the trace cut sweeps in, then the glyph cut, each label arriving with its look).
- Words on the stage print in `mix-blend-mode: difference`: ink on the paper, paper on the film.
- Reduced motion: no sweep, no slide-in, no grain; the shots and the reveal still follow scroll. Without WebGL2 the trace poster stands in.

The hero carries the one way in: the `git clone` line with its copy button. GitHub and its star count live in the header (read at build time; the count drops out if GitHub does not answer). The words stay on the paper side of the cut at every width.

The footer bench is the same drawing language: paper faces and one ink line, with only the film, the screen and the board on it left black. Its SVG (`public/figure/bench.svg`, 619 KB) is fetched as the footer comes near, never inlined.

## Motion tokens

| Token | Value | Use |
|---|---|---|
| `--t1` | 120 ms | press, scale 0.97 |
| `--t2` | 200 ms | hover, toggle, colour |
| `--t3` | 320 ms | panel, popover, underline |
| `--t4` | 600 ms | section entrance |
| `--soft` | cubic-bezier(0.25, 1, 0.5, 1) | everything that enters |
| `--out` | cubic-bezier(0.4, 0, 1, 1) | everything that leaves (faster) |
| `--pull` | cubic-bezier(0.77, 0, 0.175, 1) | film advancing a frame only |

Hover: a button's fill deepens (ink to red) or an outline fills with a 6 % tint; a link draws its underline. No rolling labels on hover; a label rolls only when its value changes (Copy to Copied).

## Components

- Button: `.btn` (outlined) and `.btn--solid` (filled, one a screen), 44 px tall, 40 px in the header.
- Link: `.prose-link`, underline drawn on hover.
- Terminal: `.term`, the command with a copy button.
- Small label: `.silk`, only beside a bare value.
