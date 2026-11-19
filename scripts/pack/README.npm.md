# silk reel

Your KiCad board, as a launch film. Give it a `.kicad_pcb`. Get a 12-second film of that exact board, built from its real copper, parts and silkscreen, with sound.

```bash
npx silk-reel path/to/board.kicad_pcb -o film.mp4
```

You need Node.js 22 or later. Nothing else: the film is drawn in a headless Chrome and encoded with the ffmpeg that ships with Remotion.

The first render downloads a headless Chrome (about 150 MB, 460 MB on disk) into a `node_modules/.remotion` folder. A fresh `npx` cache downloads it again. Install once with `npm i -g silk-reel` to keep it.

## Options

```
silk-reel <board.kicad_pcb> [options]

  --style trace|glyph|plot|montage   trace: the lit board (default); glyph: parts set as type;
                                     plot: the board drawn in pen on paper; montage: a fast-cut type film
  --aspect 4:5|1:1|9:16|16:9         frame (default 4:5)
  --title "Name" --version v1.0      title card
  --format mp4|gif|webm-alpha|prores-alpha
  --draft                            fast preview quality
  --no-audio                         leave the score out
  -o PATH                            output file
  -h, --help                         every option
```

A trace film also writes `<name>.poster.png`, the last frame, for a cover image. If your machine has no GPU, put `SILK_REEL_GL=swangle` in front of the command. `SILK_REEL_CONCURRENCY=N` sets how many frames render at once.

silk reel reads KiCad 4 and later. It does not read Gerber, Eagle or Altium files. Part models (STEP) are read when KiCad's library is installed or when you pass `--models DIR`.

## Credits

Every sound in the score is CC0 1.0; sources are in `assets/sound/CREDITS.md`. The fonts are under the SIL Open Font License; the licences are in `licenses/`. silk reel is Apache-2.0.

Source and issues: https://github.com/hridaya423/silkreel
