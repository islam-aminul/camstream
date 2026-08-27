#!/usr/bin/env bash
# Brings up a local demo: the H.265 simulator and an agent, so both cameras
# appear in the browser.
#
#   ./scripts/demo-up.sh [minutes]     default 60
#   ./scripts/demo-down.sh
set -uo pipefail
export AWS_PAGER=""

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MINUTES="${1:-60}"
DEVICE="${CAMSTREAM_DEVICE:-$ROOT/devices/gate-01}"
LOG="${CAMSTREAM_LOG:-/tmp/camstream-demo.log}"

[ -f "$DEVICE/agent.yaml" ] || { echo "No agent config at $DEVICE/agent.yaml" >&2; exit 1; }

echo "Starting the H.265 camera simulator..."
"$ROOT/scripts/simulate-camera.sh" start >/dev/null 2>&1 || true

# The simulator's own ports; the HEVC pair is separate.
if ! ss -ltn 2>/dev/null | grep -q ':8655'; then
  WORK="${CAMSTREAM_SIM_DIR:-/tmp/camstream-sim}"
  mkdir -p "$WORK"
  if [ ! -f "$WORK/hevc-sub.mp4" ]; then
    echo "  generating H.265 clips (once)..."
    for spec in "sub:640x360:300k" "main:1280x720:800k"; do
      name="${spec%%:*}"; rest="${spec#*:}"; size="${rest%%:*}"; rate="${rest##*:}"
      ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i "testsrc=size=$size:rate=15" -t 120 \
        -an -c:v libx265 -preset ultrafast \
        -x265-params "keyint=30:min-keyint=30:scenecut=0:log-level=none" \
        -b:v "$rate" -pix_fmt yuv420p -tag:v hvc1 "$WORK/hevc-$name.mp4"
    done
  fi
  nohup cvlc -q --repeat --no-audio "$WORK/hevc-sub.mp4" \
    --sout '#rtp{sdp=rtsp://0.0.0.0:8655/sub}' --sout-keep >/dev/null 2>&1 &
  nohup cvlc -q --repeat --no-audio "$WORK/hevc-main.mp4" \
    --sout '#rtp{sdp=rtsp://0.0.0.0:8654/main}' --sout-keep >/dev/null 2>&1 &
  sleep 5
fi
ss -ltn 2>/dev/null | grep -qE ':865[45]' && echo "  H.265 simulator listening on 8654/8655"

# A camera whose stream is H.264 by name and undecodable in fact. Several
# makes ship 10-bit as a default and describe it in their own UI as plain
# H.264, so this is the case where the codec name and the truth disagree —
# the one that exercises profile-aware detection rather than codec matching.
if ! ss -ltn 2>/dev/null | grep -q ':8657'; then
  WORK="${CAMSTREAM_SIM_DIR:-/tmp/camstream-sim}"
  mkdir -p "$WORK"
  if [ ! -f "$WORK/high10-sub.mp4" ]; then
    echo "  generating H.264 High 10 clips (once)..."
    for spec in "sub:640x360:400k" "main:1280x720:1200k"; do
      name="${spec%%:*}"; rest="${spec#*:}"; size="${rest%%:*}"; rate="${rest##*:}"
      ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i "testsrc=size=$size:rate=15" -t 120 \
        -an -c:v libx264 -profile:v high10 -pix_fmt yuv420p10le -preset veryfast \
        -g 30 -keyint_min 30 -sc_threshold 0 -b:v "$rate" "$WORK/high10-$name.mp4"
    done
  fi
  nohup cvlc -q --repeat --no-audio "$WORK/high10-sub.mp4" \
    --sout '#rtp{sdp=rtsp://0.0.0.0:8657/sub}' --sout-keep >/dev/null 2>&1 &
  nohup cvlc -q --repeat --no-audio "$WORK/high10-main.mp4" \
    --sout '#rtp{sdp=rtsp://0.0.0.0:8656/main}' --sout-keep >/dev/null 2>&1 &
  sleep 5
fi
ss -ltn 2>/dev/null | grep -qE ':865[67]' && echo "  H.264 High 10 simulator listening on 8656/8657"

echo "Starting the agent for ${MINUTES} minutes..."
nohup timeout "$((MINUTES * 60))" java -jar "$ROOT/agent/target/camstream-agent.jar" \
  "$DEVICE/agent.yaml" > "$LOG" 2>&1 &
sleep 12

if grep -q "connected and idle" "$LOG" 2>/dev/null; then
  echo "  agent connected"
else
  echo "  agent did not report ready — see $LOG" >&2
fi
echo
echo "Open https://camstream.online and sign in. Cameras start publishing when"
echo "you open the grid, and stop about 30s after you close it."
echo "  agent log: tail -f $LOG"
