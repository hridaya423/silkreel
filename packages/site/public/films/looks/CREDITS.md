# Four looks cards

Glasgow rev C3 comes from the Glasgow project under 0BSD. Each card is silk reel's own renderer output from that board.

All four cards are drawn through one camera straight above the board, so the bands of the shutter register:

- Plot: the board's plan in the blueprint palette, on its own outline.
- Glyph: the glyph film's field frame (frame 360), on a black ground cut to the board's outline.
- Trace: the lit board at the trace film's last frame, transparent outside the board.
- Montage: the montage's x-ray build (frame 100), cut to the board's outline.

`packages/site/scripts/looks-cards.mts` writes every card, 3052 × 1856 and 1526 × 928 (`-1x`). Run it from the repo root: `npx tsx packages/site/scripts/looks-cards.mts`.
