# Glyph style: what a change must keep

Read this before you change `packages/choreo/src/composer.ts`, `packages/render/src/glyph-film.ts`, `glyph-cam.ts` or `glyph-draw.ts`. The root `AGENTS.md` points here.

- The owner's bar is `review/fix-glyph-r01/glasgow-4x5.mp4` (local only). A new film is never darker, emptier or softer than it in any second. Measure that with `python3 cook/audit/floors.py new.mp4 review/fix-glyph-r01/glasgow-4x5.mp4 --glyph`, which prints the three curves per second.
- Glyph is 2D. No 3D board, no frame round the picture, no straight rays. The owner rejected a push that added them on 2026-11-13.
- The camera is one pull back in three phases, then a dive at the end (`camScale` in `glyph-cam.ts`).
  - `glide` is the approved curve: three smoothsteps, 3.1 to 2.3 to 1.75 to `GLYPH_WIDE`.
  - `GlyphTimeline.pulls` gives one `[start, lock]` pair of frames per formation (`composer.ts`). Each phase waits `PULL_WAIT` of its span, then lands on the glide's own scale six frames before its formation locks (`LAND_EARLY`), with a 0.8% rebound over twelve frames.
  - The camera is never wider than the glide on any frame. A wider camera makes the frame emptier and fails the floor. `glyph-cam.test.ts` holds this, the stop at each lock, and the loop's join.
  - `cook/audit/glyph-events.mts <board file> <aspect>` prints the events, formations and pulls.
- No formation is drawn over another. The owner said so on 2026-11-14 about the routes writing in on top of the part grid. One formation leaves, a short dark beat, then the next writes in.
  - `composer.ts` holds it in one pass after the acts are timed: a mark has decoded out before the next act writes a mark within `GLYPH_CLEAR` of it. `glyph-loop.test.ts` holds it on three boards in four aspects.
  - The next act's seed dots are the one exception. They show while the act before strips, at all three handovers.
  - The main chip is the one mark two acts share. The part grid and the routes draw it at the same size (`HERO_SIZE` in `acts.ts`), so it hands over and never goes dark between them. At two sizes it drew one chip inside the other.
  - The routes write in from f266 to f312, across the start of the dive at f289. The part grid's glow comes from the renderer's clock (`wave` in `glyph-film.ts`, peak on the grid near f227 to f252), so the grid cannot move earlier without losing it.
  - The old tests asked for the opposite (routes written while the frame act stands, never fewer marks than the standing act). They are gone on purpose.
- The main chip never floats. The owner said so on 2026-11-14 ("the chip like floating feels really shit"). It was 1.5 pitches wide in a gap of 6.
  - `routeAct` draws every route from the cell beside the chip. There the route's ordinary stroke points at the chip: square to its edge, a slash off a corner. About half a pitch of gap stays.
  - Tried and dropped the same day: long solid pins stretched to touch the body. The owner asked "why are these lines around the chip?" and chose the short strokes. Invent no mark the film does not already use.
  - `glyph-loop.test.ts` holds it: at least two route marks start within a pitch of the chip's body, and the chip stays lit from the part grid into the routes.
- Tried and dropped on 2026-11-14: glyphs that travel between formations along curved paths. On stills it read as a tangle with blown-up words at the corners.
- Two line weights exist: the approved one and a heavier one from the 2026-11-13 run (`review/elevate-glyph-heavier-line/`). The owner has not chosen.
- The film has one peak of light (`glyph-light.ts`, added 2026-11-14, not yet judged by the owner). It only adds light: no mark is dimmer than without it.
  - `lift` is 0 until the formation before the named one locks, 0.22 at the turn, full on the frame the named formation locks, held until 16 frames before the next formation, then down in 12 frames. `glyph-film.ts` adds it to every line, and to the glow at full strength for the main chip and 0.4 for the rest.
  - Three pulses run through the formation before the named one, in the order its marks wrote in, each faster and higher. Rank the marks by their place in that order, not by their step: many marks share a step, and by step half the formation blinked for three frames.
  - `glyph-light.test.ts` holds one peak, the rise, the fall and the pulses.
- The handover from the part plan to the named formation: the plan strips at beats `[15, 15.7]` and the named formation's arrivals bunch to its start (`rush: 3` in `SCORE`). About ten frames are low (f166 to f175 on Glasgow 4:5); before, 22. Tighter values draw one formation over the other. `cook/audit/glyph-ink.mts` prints the marks per frame.
- The film ends on the board's name spelled in the film's own marks (`name-act.ts`), after the field has stood whole at least 45 frames and left. `FilmConfig.ending` (CLI `--ending`, and `SILK_ENDING` for `scripts/film-props.mts`) picks the version: `parts` (the default) lays each letter's strokes in the board's commonest two-pad part with one other part of its mix at the corners and ends; `routes` keeps the field's main chip through the strip and routes the name from it with 45° traces. Both take the same frames, and every frame before the field leaves is the same in both. The owner chose both on 2026-11-19, `parts` as the default.
  - The name keeps the field's margin plus the drift (`NAME_MARGIN_X`, `NAME_MARGIN_Y`), takes the fewest lines whose dots are at least 7.5 px apart at 390 px wide, and has no camera pull of its own: the camera slides at one scale to centre it while the frame is dark, or while only the chip stands.
