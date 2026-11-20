#!/bin/zsh
# Renders the trace and montage films the home page plays on the Windows PC (scripts/render-strobe.sh), then encodes each into
# packages/site/public/films/<style>/<board>-<aspect>.mp4 with its last frame as <board>-<aspect>-poster.webp. Glasgow plays at every aspect, the rest at 16:9.
# Glasgow's 16:9 trace film is also the link preview, packages/site/public/og.mp4, and the Every frame section's film, packages/site/public/films/frames/ (keyframe every 8 frames for scroll seeking, its poster at frame 270, one strip cell an act).
# Run from the repo root: zsh packages/site/scripts/site-films.sh [work folder]. About three minutes a film.
set -eu
work=${1:-review/site-films}
boards=(glasgow:glasgow icebreaker:icebreaker StickHub:stickhub kit-dev-coldfire-xilinx_5213:devkit ecc83-pp:ecc83-pp video:video)
films=()
for style in trace montage; do
  for slug in 4x5 1x1 9x16; do films+=("$style glasgow ${slug/x/:}"); done
  for b in $boards; do films+=("$style ${b#*:} 16:9"); done
done
SILK_FILMS=${(F)films} zsh scripts/render-strobe.sh $work
for film in $films; do
  parts=(${=film}); style=$parts[1] short=$parts[2] slug=${parts[3]/:/x}
  for b in $boards; do [[ ${b#*:} == $short ]] && id=${b%%:*}; done
  out=packages/site/public/films/$style
  mkdir -p $out
  case $slug in 16x9) width=1600 ;; 9x16) width=720 ;; 4x5) width=1024 ;; 1x1) width=1080 ;; esac
  src=$work/$style/$short-$slug.silent.mp4
  ffmpeg -v error -y -i $src -vf scale=$width:-2 -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -movflags +faststart -an $out/$id-$slug.mp4
  ffmpeg -v error -y -sseof -0.05 -i $src -frames:v 1 -update 1 $work/poster.png
  python3 -c "from PIL import Image; im = Image.open('$work/poster.png').convert('RGB'); im.resize(($width, round(im.height * $width / im.width)), Image.LANCZOS).save('$out/$id-$slug-poster.webp', 'WEBP', quality=82, method=6)"
  rm -f $work/poster.png
  echo $out/$id-$slug.mp4
done
ffmpeg -v error -y -i $work/trace/glasgow-16x9.silent.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart -an packages/site/public/og.mp4
frames=packages/site/public/films/frames
mkdir -p $frames
ffmpeg -v error -y -i $work/trace/glasgow-16x9.silent.mp4 -vf scale=1600:-2 -c:v libx264 -preset slow -crf 25 -g 8 -keyint_min 8 -pix_fmt yuv420p -movflags +faststart -an $frames/glasgow.mp4
ffmpeg -v error -y -i $work/trace/glasgow-16x9.silent.mp4 -vf "select=eq(n\,270),scale=1600:-2" -frames:v 1 $work/frames-poster.png
cells=()
for f in 60 95 110 160 260 359; do
  ffmpeg -v error -y -i $work/trace/glasgow-16x9.silent.mp4 -vf "select=eq(n\,$f),crop=ih*489/300:ih,scale=489:300" -frames:v 1 $work/cell-$f.png
  cells+=($work/cell-$f.png)
done
python3 -c "
import sys
from PIL import Image
cells = [Image.open(p).convert('RGB') for p in sys.argv[3:]]
strip = Image.new('RGB', (489 * len(cells), 300))
for i, c in enumerate(cells): strip.paste(c, (489 * i, 0))
strip.save(sys.argv[2], 'WEBP', quality=80, method=6)
Image.open('$work/frames-poster.png').convert('RGB').save(sys.argv[1], 'WEBP', quality=82, method=6)
" $frames/glasgow-poster.webp $frames/glasgow-strip.webp $cells
rm -f $work/frames-poster.png $cells
echo $frames/glasgow.mp4
