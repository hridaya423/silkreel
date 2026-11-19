# Montage style: what a change must keep

Read this before you change `packages/choreo/src/montage/` or `packages/render/src/montage-*.ts`. The root `AGENTS.md` points here.

## What the film is

A trailer cut: the main chip held in place through nine shortening cuts in three materials, a stop on the chip in the dark, then the light comes on and stays on. The 14 November "aura" rounds made the stop, the hit, the release and the end; the owner liked those and rejected that round's build (copper only, each cut a step closer): "slightly boring when its just zooming in and in and in. like i'd lowk click off there" (15 November). The build is the approved one again (`review/aura2-montage/montage/glasgow-4x5.mp4`); the owner has not seen this cut yet. The cut he approved on 12 November is `review/approved-1112/montage/glasgow-4x5.mp4`, and he rejected the 13 November rounds that rebuilt it from the trace film's dark shots ("pure slop"). Put any change beside the current film in one side-by-side file before it replaces anything. The dark stage with orange light belongs to trace; do not move montage there.

- Build, f0 to f134: nine shots on `STEPS`, the chip held in place under one slow push (`matchAt`). Every cut changes the material: copper on black, the blueprint print with the chip's size lettered, the lit board. A build must never change scale only. The lit shots take their clone frames after the stop's (`dark` in `hypeCut`), past the stretch the renderer eases a light over, so the stop stays dark.
- Stop, f135 to f164: the end frame's pose in the dark under the trace `rim` light (grade `stop`): the chip as a dark block with one lit edge. No caption.
- Hit, f165: the light comes on in one frame, three held frames (`HELD`), the lid word.
- Release, f165 to f299: the bright finished board under the cut's own stage (`STAGE`): one key from behind and to the side, shaped shadows, no net glow.
- Whole board, f255 to f284 (`WHOLE`): a cut to a pull back, then the board whole and still for 18 frames under the same key. This is the only look at the whole board.
- End, f300 on: the camera drops (f285 to f299) to a low frame of the main chip (`END`), the name in heavy caps behind the skyline, the revision small above its right end. It settles in 8 frames (`SETTLE`), then stands under a slow push (`PUSH`, 2%).

## Rules the tests hold (`hype.test.ts`, three dense boards in four aspects)

- `STOP=135`, `RELEASE=165`, `POSTER=300`, exported from `hype.ts`. `montageScore` in `render-api/src/score-audio.ts` cuts the sound to `hypeCut(...).events`, so moving one of these frames moves the sound. The end stands 1.5 s or more.
- Every build frame is `draw` or `copper`, look `lit`, grade `build`. Every build cut steps in on the chip by 8% or more and keeps it in place.
- Every stop frame is `lit` under `rim`, grade `stop`, on the end pose.
- The light comes on in one frame: the clone jumps at least 0.05 of `total` between f164 and f165. The trace renderer eases a light change over that stretch (`LIGHT_EASE`), and without the gap the hit fades in over about 70 frames.
- Every release and end frame is `lit`, grade `release`, under the `poster` light.
- No frame before f255 or after the settle holds the whole board outline; every frame from f267 to f284 does, with a streak under 0.4% of the width. Build and ride frames see at most about a third of its area.
- The words are the chip's part number, the name and the revision. The name stands whole under the top edge, centred, above the chip.
- No release frame streaks more than 10% of the frame's width.
- Motion carries through every release cut: the mean screen motion of the board points in view agrees (cos > 0.5) across the cut, and the shot after it is moving.

## The end frame (`hype.ts`)

- `endAt(tilt, turn)` is a lens of `END.fov` low over the chip, the chip `END.wide` of the short side and `END.down` down the frame. The tilt is the first that puts the board's far edge `END.sky` down the frame.
- `seatOf` measures the skyline of the parts behind the chip in the name's band and seats the name's foot on it (`NAME.over`, `NAME.tuck`). The cut takes the turn in `END.turns` where no letter is more than `NAME.letter` covered and the name floats least above the skyline. A tall dark part in front of a letter reads as a missing letter, not as depth, so the limit is low.
- The name follows the board's far edge (`follow`), so it sits still against the board through the push.
- `TraceScene.stage` (`types.ts`) is the montage's own light for the lit board. `trace-gl.ts` reads it only when it is set, and only this cut sets it. A change there must stay a parameter that leaves the trace film alone.
- `seatOf` also measures the parts in front of the chip; a turn where they cover more than `END.front` of the frame costs more, so no dark block fills the frame's bottom.
- The stage's gain on the main chip falls with the mask's lightness (`DARK_HERO`): the exposure already lifts a chip on a black board, and the full gain turned iCEBreaker's lid white.
- One ride only (the first slot no large connector covers), then the details, then the whole board. `HYPE_HINTS=none` makes `scripts/montage-hype.mts` compile with no demo hints.
- `POOL` in `montage-hype.ts` darkens the frame away from the chip on the hit and the end, so the chip is the brightest lit region.

## The release, in code (`hype.ts`)

- f165 to f186, hit: straight down on the main chip, three held frames (`HELD`), then a pull back.
  - The large name on the hit is the chip's only marking. `HypeCut.bareLid` tells the lit board to hide the hero's own marking from f165 (`uBareLid` in `trace-gl.ts`). The word lands large, then settles onto the first letters of the real marking at the marking's place and width (`lid.rest`, `MARKING_WIDE`). Over the last `MARKING_BACK` (5) frames to f186 the real marking fades back in and the word fades out. Never show the word and the full marking as two letterings. The word slides along its own line on the lid, the least that lands both its ends inside the frame at the size it lands (`LID_SLIDE`, `LID_INSIDE`), so its last letter is not cut by the frame's edge. The lid is the chip's flat top: where the chip wears a model, the vertices within `LID_FLAT` of its highest point, if they span at least `LID_LEAST` of the model each way. A package with leads has a top smaller than its footprint (StickHub 6.6 of 9 mm, the dev kit 13.6 of 16 mm), and the word sized to the footprint used to hang over the leads. The word is the part number: `heroLabel` in `facts.ts` drops a vendor name before an underscore only when it is all letters (`MaxLinear_XR22417-48`), never a part number (`S5933_PQ160` stays S5933, not PQ160), and the word ends at the first hyphen or underscore.
- f186 to f200, whip (joined, no cut): the camera leaves the chip toward the first ride (f186 to `WHIP`, f195), then enters the ride along the ride's own axis at its own speed (f195 to f200).
- f200 to f225, first ride (`slots`): the repeated parts, the second IC, else a connector or a lane. `upright` turns each so its silk reads.
- f225 to f255, details: up to three short shots, 10 frames each when there are three. A lettered silk label away from the main chip, a labelled chip, then a second label or chip (`lettered`, `chips`, `apartFrom`). `shrouded` drops a detail that a large connector covers. Each detail travels 0.11 of the frame width along its lettering.
- A board with no lettered detail cuts to a pin row instead: the longest connector with drawn pins that no ride shows, more than 1.2 chip sizes from the main chip, and with connectors over at most a fifth of the frame (`row`). A board with no such row keeps one long ride and no cut (the tube amp board, every aspect).
- f255 to f285, second ride. `flow` picks the direction of every ride and detail so the screen motion agrees across each cut, then the fewest reversals, earliest first.
- f285 to f300, pull (joined): leaves the last ride at its speed and pulls back with a turn to just short of the end pose. f300 to f308: the settle onto it.
  - The zoom drops from about 12x to 1x in eight frames, so a full shutter smears the frame into rays. Through the pull the shutter shortens (`HypeFrame.shut`) so no streak is longer than `PULL_SMEAR` (6%) of the frame's width; the rides shorten theirs to `RIDE_SMEAR` (2%). `cook/audit/hype-smear.mts <board file> <aspect> <from> <to>` prints blur, shutter, zoom and streak per frame.
  - The title lands on the first frame the board's streak is under `RESOLVED` (2%) of the width (f304 on Glasgow), not on f300, and does not overshoot its size.
- Joined moves (`join`) are not cuts: the clone and the camera keys run on through them, so the trace renderer's blur does not clamp there. Every release move's first frame is still a `cut` event for the score.

## How the renderer works (`render/src/montage-hype.ts`)

- It renders the trace scene read-only through a cloned timeline with the cut's camera keys (`HypeCut.shots`) and a stretched `total`. Each state takes its scene phase from its own window (`WINDOWS` in `hype.ts`), so a frame gets the board as drawing copper, bare copper, or landed and lit.
- The clone carries the cut's own marking flags (`HypeCut.turns`): a chip's marking reads the way the board's largest silk text reads. The trace scene sets its flags from the trace film's end camera, and that moved after the approved film, which turned the CY7C marking upside down against its silk. The trace film never sees the clone.
- Every frame's look is `lit`; the hype cut no longer uses `montage-treat.ts`. Build frames are masked to the board (`TraceGL.matte`), its edge faces painted black (`shadeWalls`), then vignetted and grained (`gradeBuild`).

## Words

Name and revision come from `boardTitle(board, config)` (`choreo/src/board-title.ts`) through `filmWords`: the user's flags, else the silk, else the title block. A mixed-case name keeps its case; an all-lower or all-upper name is shown in upper case. A revision starting with "v" or "rev" is shown as written, else as "REV X". The hype cut shows no build label and no `--line` lines.

## Look-loop

- `HYPE_QUALITY=final HYPE_AT=0,133,150,166,240,340 npx tsx scripts/montage-hype.mts glasgow 4:5 stills review/<dir>` writes stills and a `*-stills.jpg` sheet (about 2 s a still). End the frame list without a newline: an empty entry renders frame 0. Delete the `.jpeg` dumps after.
- Films render on the Windows PC: `SILK_FILMS=$'montage glasgow 4:5' zsh scripts/render-strobe.sh review/<dir>`, then `npx tsx packages/render-api/src/scripts/score-mux.ts <silent> <props> <out>`.
- Tests to run alone: `npx vitest run packages/choreo/src/montage/hype.test.ts` (about 15 s), then `montage.test.ts` and `render/src/montage-draw.test.ts` for the flat montage.

## History

The source of the approved cut was never committed. `cook/recovered/montage-pre-cinematic/` holds `hype.ts` (13 November 00:57 UTC) and the renderer from the same minute. The approved film is older (12 November 01:52). Its opening and its second-chip pass were put back by reversing the 12 November 17:37 to 19:30 edits found in the session transcripts.

## Traps

- A pale strip or wedge in the build is the board's edge face catching light. The fix is the matte mask and the black edge faces, not a darker vignette.
- The red glow under iCEBreaker's snap-off slot is the build light on the mask. It stays until the trace renderer's light changes.
- A burst followed by two frames of the old shot before black reads as a broken file.
