#!/bin/zsh
set -u
cd "${0:A:h}/.."
out="${1:?output folder}"
only="${2:-}"
remote=/d/Honey/silk-reel-strobe
remote_win=D:/Honey/silk-reel-strobe

lock="$remote/.render-lock"
until ssh -o BatchMode=yes win-pc "find $lock -maxdepth 0 -mmin +40 -exec rmdir {} \\; 2>/dev/null; mkdir $lock 2>/dev/null"; do
  echo "waiting for another render on the PC"; sleep 15
done
trap 'ssh -o BatchMode=yes win-pc "rmdir $lock 2>/dev/null"' EXIT INT TERM

sources=(packages/render packages/choreo packages/ingest)
files='find packages/render packages/choreo packages/ingest -type f -not -path "*/node_modules/*" | LC_ALL=C sort | xargs cat'
bundle=$(mktemp -t silk-reel-src).tgz
synced=no
for attempt in 1 2 3; do
  COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --exclude node_modules -czf "$bundle" "${sources[@]}"
  scp -q -o BatchMode=yes "$bundle" "win-pc:$remote_win/src.tgz"
  ssh -o BatchMode=yes win-pc "cd $remote && rm -rf packages/render/src packages/choreo/src packages/ingest/src && tar xzf src.tgz 2>/dev/null; rm -f src.tgz; mkdir -p props out"
  here=$(eval "$files" | shasum -a 1 | cut -c1-40)
  there=$(ssh -o BatchMode=yes win-pc "cd $remote && $files | sha1sum | cut -c1-40")
  [[ "$here" == "$there" ]] && { synced=yes; break; }
  echo "source copy differs on the PC, copying again ($attempt)"
done
rm -f "$bundle"
[[ "$synced" == yes ]] || { echo "STOP: the PC's source copy does not match"; exit 4; }

films=(
  "trace glasgow 4:5" "trace glasgow 9:16" "trace glasgow 16:9"
  "trace icebreaker 4:5" "trace icebreaker 9:16"
  "trace stickhub 16:9" "trace devkit 16:9"
  "plot glasgow 4:5" "plot glasgow 9:16" "plot glasgow 16:9"
  "plot icebreaker 4:5" "plot icebreaker 9:16"
  "plot stickhub 9:16" "plot devkit 4:5"
  "montage glasgow 4:5" "montage glasgow 9:16" "montage glasgow 16:9"
  "montage icebreaker 4:5" "montage icebreaker 9:16"
  "montage devkit 1:1" "montage devkit 16:9"
)

[[ -n "${SILK_FILMS:-}" ]] && films=("${(@f)SILK_FILMS}")

for film in "${films[@]}"; do
  parts=(${=film})
  style="${parts[1]}"; board="${parts[2]}"; aspect="${parts[3]}"
  folder="$style"; [[ "$style" == plot ]] && folder=blueprint
  name="$board-${aspect/:/x}"
  [[ -n "$only" && "$folder/$name" != ${~only} ]] && continue
  mkdir -p "$out/$folder" "$out/props"
  target="$out/$folder/$name.silent.mp4"
  [[ -s "$target" || -s "$out/$folder/$name.mp4" ]] && { echo "have $folder/$name"; continue; }
  waited=0
  while free=$(df -k /System/Volumes/Data | awk 'NR==2 {print int($4/1024)}'); (( free < 500 )); do
    (( waited >= 40 )) && { echo "STOP: $free MB free here after 20 minutes"; exit 3; }
    sleep 30; waited=$((waited + 1))
  done
  case "$board" in
    glasgow) args=(fixtures/boards/glasgow.kicad_pcb --title Glasgow) ;;
    icebreaker) args=(fixtures/boards/icebreaker.kicad_pcb --title iCEBreaker --version v1.0e) ;;
    stickhub) args=(fixtures/boards/StickHub.kicad_pcb) ;;
    devkit) args=(fixtures/boards/kit-dev-coldfire-xilinx_5213.kicad_pcb --title "ColdFire Xilinx Dev Kit") ;;
    ecc83-pp) args=(fixtures/boards/ecc83-pp.kicad_pcb --title "ECC83 Preamp") ;;
    video) args=(fixtures/boards/video.kicad_pcb --title "Video Board") ;;
  esac
  key="$folder-$name"
  props="$out/props/$key.json"
  echo "== $folder/$name $(date -u +%H:%M:%S)"
  npx tsx scripts/film-props.mts "${args[@]}" --style "$style" --aspect "$aspect" -o "$props" > "$out/$folder/$name.log" 2>&1 || { echo "FAILED props $key"; continue; }
  scp -q -o BatchMode=yes "$props" "win-pc:$remote_win/props/$key.json" || { echo "FAILED copy $key"; continue; }
  render="cd $remote && strobe render . --entry packages/render/src/remotion-entry.tsx --composition film --props props/$key.json -o out/$key.raw.mp4 --no-audio 2>&1 | grep -E '^(out/|error)'; test -s out/$key.raw.mp4"
  convert="cd $remote && ffmpeg -hide_banner -loglevel error -y -i out/$key.raw.mp4 -vf 'scale=in_range=pc:out_range=tv,format=yuv420p,setparams=range=tv:colorspace=unknown:color_primaries=unknown:color_trc=iec61966-2-1' -c:v libx264 -crf 14 -preset medium -g 720 -an -movflags +faststart out/$key.mp4 && rm -f out/$key.raw.mp4 props/$key.json"
  for attempt in 1 2 3; do
    ssh -o BatchMode=yes win-pc "$render" >> "$out/$folder/$name.log" 2>&1 && break
    echo "retry $attempt $key"; sleep 5
  done
  ssh -o BatchMode=yes win-pc "$convert" >> "$out/$folder/$name.log" 2>&1
  scp -q -o BatchMode=yes "win-pc:$remote_win/out/$key.mp4" "$target" && ssh -o BatchMode=yes win-pc "rm -f $remote/out/$key.mp4" || echo "FAILED render $key (see $out/$folder/$name.log)"
done
echo "done $(date -u +%H:%M:%S)"
