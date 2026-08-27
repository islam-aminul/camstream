#!/usr/bin/env bash
# Verifies that an FFmpeg build is safe to ship with a commercial product.
# CamStream only stream-copies, so it never needs a GPL-enabled build.
set -uo pipefail

FFMPEG="${1:-${FFMPEG_PATH:-ffmpeg}}"

if ! command -v "$FFMPEG" >/dev/null 2>&1; then
  echo "FAIL: $FFMPEG not found on PATH" >&2
  exit 2
fi

config=$("$FFMPEG" -hide_banner -version 2>&1 || true)
version=$(printf '%s\n' "$config" | head -1)
echo "$version"

problems=()
for flag in --enable-gpl --enable-nonfree --enable-version3; do
  if printf '%s\n' "$config" | tr ' ' '\n' | grep -qx -- "$flag"; then
    problems+=("$flag")
  fi
done

if [ ${#problems[@]} -eq 0 ]; then
  echo "PASS: LGPL-compatible build (no GPL or non-free flags)."
  exit 0
fi

echo
echo "FAIL: this build is licensed under GPL/non-free terms."
printf '  offending flag: %s\n' "${problems[@]}"
cat <<'EOF'

CamStream stream-copies by default and needs no GPL codec. Rebuild or obtain
FFmpeg configured without --enable-gpl, --enable-nonfree, libx264, libx265 or
libfdk-aac, for example:

  ./configure --disable-gpl --disable-nonfree \
              --enable-shared --disable-static \
              --disable-encoders --enable-demuxer=rtsp --enable-muxer=hls

To transcode as well — needed for cameras emitting HEVC or H.264 High 10, which
no browser decodes — add the encoders for the hardware you have, all of which
are LGPL:

  --enable-vaapi        Intel/AMD integrated graphics on Linux
  --enable-nvenc        NVIDIA, Linux and Windows
  --enable-libopenh264  software fallback, BSD-2-Clause, for boxes with no GPU

libopenh264 is the only software H.264 encoder here on purpose: libx264 would
force --enable-gpl on the whole binary.

This build is fine for local development. Do not ship it.
EOF
exit 1
