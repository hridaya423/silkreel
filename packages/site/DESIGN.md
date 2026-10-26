# silk reel: brand

silk reel turns a KiCad board file into a release film of that board. The site is its launch page and its studio. Every change to the site is checked against this page.

## Principles

1. **Show the film, not the metaphor.** Sprocket holes, gates, strips and frames appear only on things that are film: the hero reel, the gate, the studio monitor and the footer bench. They never decorate a section edge, a label, an eyebrow or a table.
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

- Opal `#ecede9` ground, stock `#0b0b0b` ink and dark sections (`.pos`), one red: `#c4221a` on opal, `#ff4a3d` on stock (both 4.5:1). Muted text `#4a4a46` on opal, `#a9a9a3` on stock.
- Red marks only the current thing: the active nav link, the playhead, the primary button on hover, the hero frame. Never decoration.

## Shape

- Radius: 6 px on buttons and inputs, 8 px on panels and the terminal, 0 on film frames (film has square corners).
- Lines: 1 px at 14 % or 30 % ink. No double rules, no zone grids, no title blocks outside the drawing.

## The drawing

One section on home (`#drawing`) is a real engineering drawing of the Glasgow board, white line on blueprint blue. It is the only place the blue appears.

- Ground `#123f86`, ink `#eaf1ff`. Nothing else on the site uses them.
- Every view comes from the board file: plan, front elevation, a live section A-A, Detail B of one solder joint, a parts list keyed to patent numerals, and a title block. Stackup thicknesses, finish, mask, rev and counts are read from `glasgow.kicad_pcb`; part heights are estimated (note 4 on the sheet says so).
- Drafting rules: ISO 128 line weights (thick 0.6, thin 0.3, fine 0.16 sheet mm), ISO 129 dimensions with filled arrows, third-angle projection, a different hatch per material, thin copper drawn solid. Zone grids and the title block belong to the sheet, so they are allowed there.
- Lettering: NewStroke, the same face as every heading on the site.
- Motion: the sheet plots in stroke by stroke once, then a pinned camera travels sheet, plan, section, detail and title block on scroll, and comes back to the plan. The plot is tied to scroll as well as time: it is complete before the camera leaves the first view, so a fast scroller never sees a half-drawn sheet. Back on the plan, the Glasgow glyph film fades in over the drawn board on its plan act (its plan placed on the drawn outline: line drawing to type, plan to plan) and opens out as the blue sinks to stock. That film is the glyph look's own canvas: as the looks scroll in, it slides behind their heading and lands in its frame, so the page never shows the same film twice. Both looks show Glasgow. That hand-off is the product's claim: the same file, as a film. The section cut follows the pointer over the plan and sweeps the dense band around the FPGA when idle. Reduced motion: no plot, no sweep, and the camera cuts between stops.
- Outside the sheet, the drawing's language appears only as dimensions that carry real data (`.dim` in `home.css`: a thin line, filled arrows, the value above the line). Under each look, a dimension chain shows the film's steps on its 24-beat score (`TRACE_ACTS` from choreo, the glyph `acts` from `data/site.ts`). A red playhead marks the current beat, and a click plays on from a step. The board picker draws each board's plan from its file (outline, front parts, the hero part in red, mounting holes; `figure/outlines.mts` writes `src/blueprint/outlines.json`) with its true width dimensioned under it. The aspect picker draws the four output frames on one scale (1920 px is 96 px, from `ASPECT_SIZE`) with their pixel widths dimensioned. The palette picker shows the monitor's film in each palette, at the same still frame reduced motion holds (`drawStill`). On the command's monitor, two dimensions show the output size in pixels for the selected aspect (`ASPECT_SIZE`).
- Phone: a portrait screen cannot read the whole sheet, so the camera opens on the plan and moves in close to the hero chip before the section.
- Code: `src/blueprint/draw.ts` draws (pure strings), `src/motion/drawing.ts` runs it, `figure/blueprint.mts` regenerates the data.

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

- Button: `.btn` (outlined) and `.btn--solid` (filled, one a screen), 44 px tall, 38 px in the header.
- Link: `.prose-link`, underline drawn on hover.
- Terminal: `.term`, the command with a copy button.
- Small label: `.silk`, only beside a bare value.

## The loader

On a first visit to home only: the mark draws itself on stock, a film strip under it fills frame by frame with the real load progress, then the mark lands in the header. Under 2 s, skipped on repeat visits, under reduced motion and on any input.
