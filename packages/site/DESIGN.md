# silk reel: brand

silk reel turns a KiCad board file into a release film of that board. The site is its launch page and its studio. Every change to the site is checked against this page.

## Principles

1. **Show the film, not the metaphor.** Sprocket holes, strips and frames appear only on things that are film: the filmstrip under the cut and the footer bench. They never decorate a section edge, a label, an eyebrow or a table.
2. **Say it once.** No caption that restates the thing beside it, no label on an obvious control, no hint for something that just works, no copy defending a decision. A string stays only if the visitor cannot act without it (clean-copy ladder).
3. **Plain words.** Public copy never uses the engine's vocabulary: drawings, beats, acts, spine, pillars, hero chip, designators, render API (outside the self-hosting docs), zones, sheets. The film's steps are named by what happens: draw, pour, mask, silk, place, reflow, wait, power, hold; grow, rise, frame, loop.
4. **One focal point per screen, one primary action per screen.** One filled button a screen; everything else is outlined or a text link.
5. **Motion explains.** It shows playback, a page change or a state change. Nothing moves to prove the page is interactive. Every motion has a reduced-motion still.
6. **Polish over features.** Fewer, finished things. A control that cannot work for a visitor (the local render API) is hidden until it can.

## Voice

Short declarative sentences. Concrete nouns: board, film, frame, command. Second person for actions ("Drop your board"). No exclamation marks, no superlatives, no "simply", no "powerful".

## Type

- **NewStroke** (KiCad's single-stroke lettering, CC0, Vladimir Lapygin): every heading, drawn as SVG strokes by `Lettering.astro` (real text stays in the DOM for assistive tech). Uppercase, 1em per cap height, one SVG per heading so its lines scale together. Stroke weight 0.06–0.09 em. It is the face printed on real boards, and the drawing's own lettering.
- **Martian Mono** (OFL, variable weight and width): everything else, at width 87.5 %: ledes, body, buttons, labels, commands. The home command uses width 100 % and wraps tokens when space is tight.
- The studio uses the same two faces as the rest of the site: Martian Mono for controls and values, NewStroke for its group labels (Look, Frame, Title card, Advanced, Render on your machine). The renderer uses JetBrains Mono as `SilkMono` for film captions.
- Scale (tokens.css): xl, l, m, body 16 px, s 14 px, label 13 px. Display classes are sized for the lettering (0.62 of `--t-xl`, 0.66 of `--t-l`). Nothing under 13 px except mono timecode at 12 px and dimension values at 9–10 px.
- Uppercase only in NewStroke lettering and dimension values. Sentence case everywhere else.

## Colour

- Opal `#ecede9` ground, stock `#0b0b0b` ink and dark sections (`.pos`), one red: `#c4221a` on opal, `#ff4a3d` on stock (both 4.5:1). Muted text `#4a4a46` on opal, `#a9a9a3` on stock. Opal, ink and the opal red are also the plot look's `paper` palette, so the plot film and the page are one sheet.
- Red marks only the current thing: the active nav link, the playhead, the cut, the shutter slat standing edge-on, the primary button on hover, and in the plot film the live nets after power-on. Never decoration.

## Shape

- Radius: 6 px on buttons and inputs, 8 px on panels and the terminal, 0 on film frames (film has square corners).
- Lines: 1 px at 14 % or 30 % ink. No double rules, no zone grids, no title blocks outside the drawing.

## The cut

Home opens on the hero stage (`#film`, `src/cut/`), then three sections drawn from `docs/concepts/2026-11-04-sections/` (01 to 03). Each section is laid out in the concept's own 1586-unit grid: `--k` is one unit, so the desktop layout scales with the viewport up to 1920 px. At 900 px and below, each section uses a stacked layout.

- Two films of Glasgow share one camera: the **plot** film, drawn live in the page from its timeline (`public/films/plot/`, written by `scripts/plot-timelines.mts`), and the **trace** film as video (`public/films/cut/`). Both are compiled with the same config and part models, so they register to the pixel. Re-render both together or the cut tears.
- One WebGL2 shader (`cut-gl.ts`) composites them across a straight cut: plot on the paper side, trace on the stock side, a red hairline on the cut itself. On arrival the plot sweeps in and the cut slides in carrying the lit board. Fine grain unifies the two; film edges are feathered so a frame edge never shows as a line.
- The hero is the **copper shutter** (`shutter.ts` for the wave, `cut-gl.ts` for the slat pass). Its source and assembled faces use transparent renders of the same board. The slats follow their silhouettes, with a continuous board beneath the turn. A red edge marks the transition. The stage uses the rendered camera directly. Copper covers about 72 % of the initial desktop board and 70 % on phones. Scroll holds the drawing briefly, then turns it slowly into the assembled board. The 280svh hero overlaps the macro stage by one viewport. A shared canvas carries the assembled board into the macro stage. The opal ground darkens during the move. The destination stays fixed while the board approaches, then the close-up film takes over. Text appears after the board is in place.
- Hero assets live in `public/films/shutter/`. Both faces share a camera. The desktop render has a lower viewing angle than the release film. Regenerate the pair together. `CREDITS.md` records their board, render settings and palette.
- A visitor's board compiles in `world/film.worker.ts`. The page renders its transparent faces in the browser and replaces the hero. The board stays in the tab. The browser preview uses estimated component bodies.
- **Every frame** (`#frames`): a sticky stage maps native scroll position through Copper, Mask, Silk, Place, Power and Hold. It uses 260svh on desktop and 230svh on smaller screens. The range input remains usable with a pointer, Home, End and arrow keys. A short caption names the current change. Reduced motion removes the pin and scroll seeking; the selected still and manual control remain.
- **Three looks** (`#looks`): one board behind the hero's slats (`src/cut/looks.ts`, `looks-gl.ts`). Three stills of Glasgow from one camera (`public/films/looks/`) sit on it as three bands in the order Plot, Glyph, Trace, so each band shows the part of the board its look draws best. A slat stands edge-on, in red, on each seam. The band under the pointer widens and the slats turn as a seam passes them; pointing at or focusing a selector widens its band the same way; a click or a selector keeps the look and updates the command preview. On first view the seams sweep once to each side. Glyph keeps a solid black surface without added mounting holes or border rings. The phone shows the same board above three selectors. Without WebGL2 the three stills show as separate proofs.
- **One command** (`#make`): the command's words are the controls (native popovers), and the monitor plays what the line would render, with play, pause and seek. The aspect rail beside it is the same choice as `--aspect`. The title, supporting line, command, and monitor use normal document flow. The command wraps without compressing its type, including long filenames. Copy command is the only filled button. Glasgow Trace ships every aspect; other stock boards and Plot preview at 16:9 with a note.
- The hero uses ink text on opal. Reduced motion holds the shutter still. Without WebGL2 or JavaScript, the hero uses a responsive still and occupies one viewport.

The hero carries two ways in: Try your board (opens the file picker; the board stays in the tab) and the `git clone` line with its copy button. GitHub and its star count live in the header (read at build time; the count drops out if GitHub does not answer). The headline stays clear while the shutter turns. Portrait layouts place both file labels above the board and reserve space beneath the primary action.

The homepage closes with a studio action followed by the original interactive anatomy footer. The footer bench uses the same drawing language: paper faces and one ink line, with only the film, the screen and the board on it left black. Its SVG (`public/figure/bench.svg`, 619 KB) is fetched as the footer comes near, never inlined.

## Live copper

The page's pictures are board data, and they answer.

- **The pen.** Every `h1` and `h2` is plotted once, stroke by stroke in reading order, by one red pen head that lifts and travels between strokes (`src/motion/plot.ts`). A heading takes 0.45 to 1.35 s by its stroke length. "Every frame." plots when its copy fades in. Reduced motion shows the lettering at once. A heading waits hidden for its pen for at most 0.9 s: if the script is later than that, `html.plot-off` shows the headings on screen at once and only the ones below still plot.
- **The probe.** The hero board answers the pointer (`src/cut/probe.ts`, `nets.ts`). Copper under the pointer fires its whole net: light starts at the touch and runs the routes to every pad and via. A part on the assembled side fires all its signal nets from its pins. A tag names the net in KiCad's own lettering, with its routed length and vias; active-low nets carry KiCad's overbar. On the drawing the net burns white on dimmed red routes. On the assembled board the room dims and the net glows warm, hidden where a part stands in front of it. A touch fires for two seconds.
- **At rest** one part wakes every 5.4 s when the pointer has been still for 3 s, and its tag shows for 1.7 s. This is the hero's idle state. It tells a visitor the board is data and that it answers. Reduced motion has no idle pulse; a hovered net lights whole, at once.
- **Any board.** A dropped board gets the same probe from its own file (`film.worker.ts` returns the nets). The notice after loading states its parts, nets and metres of copper.
- The stock nets (`public/films/shutter/glasgow-*-nets.json`, written by `scripts/nets.mts`) carry the camera the faces were rendered through. Regenerate them with the faces or the light slides off the copper.

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

## Landing page continuity

The hero board moves into the macro stage on the same canvas. The header-to-headline gap is at least 32 px. The supporting line follows the heading by 24 px, and the desktop actions follow by 32 px. Scroll position drives the film in both directions, rather than starting a timed movie that a visitor can leave behind. The opal proof section follows the held final frame. Its selected style carries into the command, whose monitor enters below the controls.

The existing Lenis and GSAP clock drives these transitions. Reduced motion removes the scroll effects and keeps every section in ordinary document flow. Desktop headings reserve at least 96 px above their content to clear the fixed header. The phone proof selector shows one image and uses the same Plot, Trace, Glyph order as the desktop.


## Opal workbench studio

The studio keeps the workbench layout of `docs/concepts/2026-11-05-studio/01-opal-workbench.png` and wears the landing page's identity (restyled 2026-11-11). The site header and nav sit on top, with "Get the CLI" outlined so Record WebM is the one filled button. Under it a toolbar holds the filename behind a red pin, Change board, and Record WebM. The large preview sits beside a right inspector. Look, Frame, and Title card stay visible. Advanced and Render on your machine use native disclosures. Save still and Copy command sit at the bottom of the inspector.

Selections use the landing's vocabulary. A look is a bold word with a red underline, in the landing's order (Plot, Glyph, Trace) and with its copy under the row. A frame or format is a box whose outline turns red. The playhead is the red dot; the play control is outlined, never filled.

The desktop preview sits on the page gutter with a 32 px gap before the inspector. At 900 px and below, the preview and inspector stack in document flow. Phone margins are 16 px. The inspector scrolls independently on desktop. Its expanded content stays inside the page width.

Trace is the default look. The browser draws the actual Trace renderer with a transparent ground, adds a soft shadow, and composites it over `#e6e7e2`. The PNG and recorded WebM use that same opal composition. Local Trace renders retain the cinematic background and full render quality. The browser still uses estimated component bodies.

Change board opens a native popover with file selection and sample boards. An invalid file leaves the last valid film available. All previous palette, aspect, title, credit, tempo, seed, hero part, mask, accent, local format, setup, and render controls remain available.

`npm run check:layout --workspace=@silk-reel/site -- <url>` checks the actual browser geometry at 1440, 768, 390, and 320 px. It enforces hero spacing, studio margins, control sizes, and expanded-panel width. The old hero gap fails this check at 16 px.


## Live motion verification

Development and production use separate Vite optimizer caches under `node_modules/.vite/<mode>/`. A production build must not replace the running dev server's dependency cache.

After a build, keep dev running and use `npm run check:scroll --workspace=@silk-reel/site -- <dev-url> <capture-dir>`. This check sends wheel input and verifies the live copper turn and decoded film frames in both directions. It also records desktop and phone captures. A passing static production capture does not verify the open dev page.
