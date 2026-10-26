#!/bin/sh
# Renders the trace films the site plays into packages/site/public/films/trace/: <board>-540.mp4 (16:9, 1280 px) and <board>-poster.webp
# for the boards in traceFilms (src/data/site.ts). Run from the repo root: sh packages/site/scripts/trace-films.sh. About five minutes on an M4 Pro.
set -e
out=packages/site/public/films/trace
tmp=$(mktemp -d)
mkdir -p "$out"
for b in icebreaker glasgow StickHub ecc83-pp kit-dev-coldfire-xilinx_5213 video; do
  SILK_REEL_CONCURRENCY=4 npm run reel -- "fixtures/boards/$b.kicad_pcb" --style trace --aspect 16:9 --no-audio -o "$tmp/$b.mp4"
  ffmpeg -v error -y -i "$tmp/$b.mp4" -vf scale=1280:-2 -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart -an "$out/$b-540.mp4"
  python3 -c "from PIL import Image; Image.open('$tmp/$b.poster.png').convert('RGB').resize((1280, 720), Image.LANCZOS).save('$out/$b-poster.webp', 'WEBP', quality=82, method=6)"
done
rm -rf "$tmp"
