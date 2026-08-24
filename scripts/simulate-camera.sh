#!/usr/bin/env bash
# Stands up a fake IP camera so the agent can be exercised without hardware.
#
#   ./scripts/simulate-camera.sh start   # generate clips + serve over RTSP
#   ./scripts/simulate-camera.sh stop
#   ./scripts/simulate-camera.sh status
#
# Serves two profiles, mirroring how a real camera exposes a sub and a main
# stream:
#   rtsp://127.0.0.1:8554/sub    640x360
#   rtsp://127.0.0.1:8555/main   1920x1080
set -uo pipefail

WORK="${CAMSTREAM_SIM_DIR:-/tmp/camstream-sim}"
SUB_PORT=8554
MAIN_PORT=8555
DURATION="${CAMSTREAM_SIM_SECONDS:-120}"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 is not installed" >&2; exit 1; }
}

generate() {
  mkdir -p "$WORK"
  # A keyframe every 2s matches the agent's default segmentDurationMs. The agent
  # stream-copies, so it can only cut segments on an IDR frame — a longer GOP
  # here would silently produce longer segments and more latency.
  local common=(-an -c:v libx264 -preset veryfast -tune zerolatency
                -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p)
  if [ ! -f "$WORK/sub.mp4" ]; then
    echo "Generating sub stream clip (${DURATION}s, 640x360)..."
    ffmpeg -nostdin -hide_banner -loglevel error \
      -f lavfi -i "testsrc=size=640x360:rate=15" -t "$DURATION" \
      "${common[@]}" -b:v 500k "$WORK/sub.mp4"
  fi
  if [ ! -f "$WORK/main.mp4" ]; then
    echo "Generating main stream clip (${DURATION}s, 1920x1080)..."
    ffmpeg -nostdin -hide_banner -loglevel error \
      -f lavfi -i "testsrc=size=1920x1080:rate=15" -t "$DURATION" \
      "${common[@]}" -b:v 3000k "$WORK/main.mp4"
  fi
}

start() {
  require ffmpeg; require cvlc
  stop >/dev/null 2>&1
  generate
  # VLC 3's RTSP server speaks UDP only — no TCP interleave — so the matching
  # camera entry in agent.yaml must set `rtspTransport: udp`.
  nohup cvlc -q --repeat --no-audio "$WORK/sub.mp4" \
    --sout "#rtp{sdp=rtsp://0.0.0.0:$SUB_PORT/sub}" --sout-keep > "$WORK/vlc-sub.log" 2>&1 &
  nohup cvlc -q --repeat --no-audio "$WORK/main.mp4" \
    --sout "#rtp{sdp=rtsp://0.0.0.0:$MAIN_PORT/main}" --sout-keep > "$WORK/vlc-main.log" 2>&1 &
  sleep 5
  status
  cat <<EOF

Point a camera entry at it:

  cameras:
    - id: front-door
      name: Front Door
      rtspTransport: udp
      subStreamUrl: rtsp://127.0.0.1:$SUB_PORT/sub
      mainStreamUrl: rtsp://127.0.0.1:$MAIN_PORT/main
EOF
}

stop() {
  # Match the media files rather than the word "rtsp", which would also match
  # this script's own command line.
  pkill -f "cvlc.*$WORK" 2>/dev/null
  pkill -f "vlc.*$WORK" 2>/dev/null
  echo "Stopped."
}

status() {
  local ok=0
  for port in $SUB_PORT $MAIN_PORT; do
    if ss -ltn 2>/dev/null | grep -q ":$port "; then
      echo "  listening on rtsp://127.0.0.1:$port"
      ok=1
    else
      echo "  NOT listening on port $port"
    fi
  done
  [ $ok -eq 1 ] || return 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
