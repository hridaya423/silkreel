# silk-reel agent guide

KiCad board in, release video out. TypeScript monorepo (npm workspaces):

| package | role |
|---|---|
| `packages/ingest` | `.kicad_pcb` parser → `BoardModel` |
| `packages/choreo` | style engine: `compileTimeline(board, FilmConfig)` → `Timeline` (`trace` scene or `glyph` tracks), palettes, aspect layout, cast hints |
| `packages/render` | Canvas2D frame drawing (`drawFrame`) + WebGL2 bloom post pass + Remotion composition |
| `packages/render-api` | Fastify API, serial render queue, `renderFilm()` (mp4/gif/webm-alpha/prores-alpha) |
| `packages/studio` | Vite + Remotion Player web studio |
| `packages/cli` | `npm run reel -- board.kicad_pcb [flags]` |
| `packages/metrics` | ffmpeg-based probes and the advisory numeric gate |

## Commands

- `npx tsc --noEmit` (typecheck), `npx vitest run [path]` (tests), `npx eslint packages` (lint)
- `npm run test:production`: builds the studio and smoke-tests it against a fake render API
- `npm run reel -- fixtures/boards/icebreaker.kicad_pcb --aspect 9:16 --title iCEBreaker --version v1.0e -o /tmp/ice.mp4`
- `npx tsx scripts/format-smoke.mts`: renders glasgow in all four formats to `/tmp/fmt` and prints ffprobe facts
- Studio: `npm run start --workspace=@silk-reel/render-api` (port 3102) and `npm run dev --workspace=@silk-reel/studio` (port 3101)

## Env vars

- `SILK_REEL_GL`: Chromium GL backend for renders (default `angle`, which uses the GPU; use `swangle` on GPU-less CI/servers)
- `SILK_REEL_CONCURRENCY`: Remotion frame concurrency (default: half the cores)
- `SILK_REEL_MODELS`: extra STEP folders for the render API and `trace-stills.mts`, separated by `:` (`;` on Windows); `none` makes `trace-stills.mts` skip models

## The review gate: tests prove structure, not beauty

Deterministic tests pass on videos that look like slop. A change to anything visual is done only after a full-video review:

1. `npm run review -- --styles trace,glyph --boards all --aspects 4:5,1:1,9:16,16:9` writes `review/<stamp>/` (videos, 5 fps contact sheets covering every second, `index.html`, and a `notes.md` template). `npx tsx scripts/review-stats.mts review/<stamp>` adds numeric evidence (dead air, coverage, clipping).
2. Open **every** sheet for every video and watch each loop at real speed. Spot-checking a few frames is not a review.
3. Pre-filter: the old defect checks still gate first — no clipping, no dead air, clean loop seam, legible at phone size. A video that fails any of those is a FAIL before taste is scored.
4. Score every rubric line 1–5 with one concrete sentence per video:
   First frame (worth stopping the scroll?) · Reading path (the eye always knows where to look) · Rhythm (lands on the beat grid; nothing arbitrary) · Breath (sparse↔dense; negative space intended) · Restraint (nothing removable; glow only on energy) · Material (ink/copper/mask look chosen; no blobs or mud) · Signature moment (one beat people remember) · Resolve (invisible loop seam, or one-shot lands on a held hero frame) · Screenshot test (any frame is a poster) · Board truth (the board's designer would recognize it).
5. My pass requires every line ≥4. Any line <4 means iterate. The final pass is the user's sign-off. Keep the notes under `docs/reviews/` (local only; `docs/` is gitignored).

## Styleframes: compare against the reference, not just yourself

- `npx tsx scripts/styleframes.mts --style glyph --boards icebreaker,glasgow --aspect 4:5 --at 0.02,0.3,0.62,0.8 [--animatic] [--smooth]` dumps per-phase stills of each board next to the same-phase still of the private reference, plus optional half-size animatics, into `review/styleframes/<style>-<stamp>/index.html` with an `intent.md` to fill.
- `npx tsx scripts/trace-stills.mts glasgow,icebreaker 4:5 0.06,0.3,0.66,0.92` renders lit-trace stills at those phases plus one sheet per board into `review/trace-stills/` (about 2s a still). This is the fast look-loop for the trace renderer; a full video takes 1–2 min.
- `npx tsx scripts/taste.mts <video.mp4> [--ref <ref.mp4>] [--out <dir>]` writes `taste.html`: synced side-by-side playback, shared scrub, frame step (arrows), A/B flip (f), and a 240px native-pixel loupe. If no `--ref`, it uses `reference.mp4` beside the video or re-extracts it from git.

## Gotchas

- Imports inside `packages/render` must not carry `.js` extensions (the Remotion bundler resolves `.ts`/`.tsx` directly).
- The post pass renders on its own WebGL canvas and returns it; the visible canvas stays 2d so the fallback path works when WebGL2 or shader compilation fails.
- Trace renders through `trace-gl.ts`: a lit plate on a studio floor, component bodies from `choreo/src/trace/parts.ts`, a perspective camera, DOF, HDR bloom, and motion blur. Quality: `final` (5 subframes, 1.6× maps) for renders; `draft` (1 subframe) for the studio and `--draft`. `trace-maps.ts` rasterises board-space data maps (top/surf/fx) for only the region the camera sees, snapped to whole texels so thin copper does not crawl. `trace-draw.ts` is the flat fallback when WebGL2 is missing.
- The trace film is one arc on a 24-beat grid: drawing (plan view, copper routes out of the hero) → object (tilt, mask, silk, parts set on paste, reflow snap) → a held breath → power-on (the only strong light) → hold. The score lives in `choreo/src/trace/scene.ts`: `TRACE_ACTS`, `ROLE_TIME` (energy after power-on) and `shotList` (four shots, cuts on beats 10, 15 and 20; the film ends on the held poster, with no fade). Camera math is `choreo/src/trace/camera.ts`, net roles are `trace/nets.ts`, and the sound is `render-api/src/score-audio.ts`: bundled CC0 recordings from `render-api/assets/sound/` (sources in its `CREDITS.md`) placed on the score's events and mastered to −14 LUFS. Only CC0 audio may be bundled there. `renderFilm` muxes it into mp4/webm/prores trace renders; `--no-audio` skips it.
- Lit surfaces stop below the bloom threshold (`LIT_MAX` in `trace-gl.ts`); only authored light blooms. Motion blur clamps to the current shot (`shotSpan`), so a cut never double-exposes. Write any oscillation in seconds with a period of at least four frames.
- `npx tsx scripts/flicker.mts video.mp4` measures frame-to-frame shimmer per second; compare it before and after any change to the trace look.
- WebGL: `gl.clear` respects `depthMask`. Re-open it before clearing, or last frame's depth survives (single stills look fine, videos go black). Never `pow(x, 2.0)` in GLSL with x possibly negative (NaN on Metal/ANGLE); use `sq()`.
- Trace review renders: `SILK_REEL_CONCURRENCY=4` avoids GPU-memory browser crashes on this machine.
- Part models: `render-api/src/models.ts` tessellates STEP files (occt-import-js) into footprint-local meshes; `compileTimeline(board, config, bodies)` attaches them and `trace-gl.ts` draws them instanced (`VS_MESH`). KiCad negates model rotation angles, and a back footprint's local frame is stored mirrored in y. A model must cover 75% of its pads or the part keeps its estimated body. The studio preview compiles in the browser and shows estimated bodies only.
- A hero footprint on the back copper flips the trace film to the back side (mirrored, sides swapped), e.g. StickHub.
- Alpha formats need `transparent: true`; the queue and CLI set it automatically. GIFs render without grain and at ≤720px wide (`renderFilm` does both).
- Never pixel-hash post-processed frames in tests. GPU output differs across machines, so test the 2D draw through `test-recorder.ts`.
- `fixtures/reference/pcbanimation.mp4` is another artist's work. Keep it as a private comparison only; never ship it.
