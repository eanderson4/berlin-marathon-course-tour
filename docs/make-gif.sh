#!/usr/bin/env bash
# Build docs/course-tour.gif and docs/poster.png from a 60 s 16:9 render.
#
#   docs/make-gif.sh [INPUT.mp4]      (default: renders/course-tour-16x9.mp4)
#
# Needs ffmpeg. gifsicle (lossy LZW) takes the GIF from ~20 MB to ~6 MB; if it
# is not installed the script keeps the larger ffmpeg-only GIF and says so.
#
# Timing: the source is 60 s. The title (from 0.4 s, once it is fully faded
# in, to 4 s) and the finish hold (57-60 s) play at 2.5x so they stay
# readable; the course itself (4-57 s) plays at 7x. Result: about 10.3 s at
# 12 fps, 800 px wide, start line to finish.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="${1:-$ROOT/renders/course-tour-16x9.mp4}"
OUT_GIF="$ROOT/docs/course-tour.gif"
OUT_POSTER="$ROOT/docs/poster.png"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$IN" ] || { echo "no input video: $IN" >&2; exit 1; }

# 1. GIF: variable speed, 12 fps, 800 px, light blur (the building texture is
#    what makes every frame expensive), 32-colour palette, no dithering.
ffmpeg -v error -y -i "$IN" -filter_complex "\
[0:v]trim=0.4:4,setpts=(PTS-STARTPTS)/2.5[a];\
[0:v]trim=4:57,setpts=(PTS-STARTPTS)/7[b];\
[0:v]trim=57:60,setpts=(PTS-STARTPTS)/2.5[c];\
[a][b][c]concat=n=3:v=1,fps=12,scale=800:-1:flags=lanczos,gblur=sigma=0.5,split[x][y];\
[x]palettegen=max_colors=32:stats_mode=full[p];\
[y][p]paletteuse=dither=none:diff_mode=rectangle" \
  "$TMP/raw.gif"

# 2. Lossy LZW pass.
if command -v gifsicle >/dev/null 2>&1; then
  gifsicle -O2 --lossy=200 "$TMP/raw.gif" -o "$OUT_GIF"
else
  echo "gifsicle not found: keeping the ffmpeg-only GIF (much larger)" >&2
  cp "$TMP/raw.gif" "$OUT_GIF"
fi

# 3. Poster: the finish hold, whole route drawn, Gate and Reichstag pinned.
ffmpeg -v error -y -ss 59.5 -i "$IN" -frames:v 1 -vf scale=1280:-1:flags=lanczos "$OUT_POSTER"

ls -l "$OUT_GIF" "$OUT_POSTER"
