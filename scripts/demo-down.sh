#!/usr/bin/env bash
# Stops the demo agent and the camera simulators.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Matched on the jar and the media files rather than a word that also appears in
# this script's own command line.
ps -eo pid,comm,args --no-headers | awk '$2=="java" && /camstream-agent\.jar/ {print $1}' \
  | while read -r pid; do kill "$pid" 2>/dev/null && echo "  stopped agent $pid"; done
ps -eo pid,comm,args --no-headers | awk '$2 ~ /^vlc/ {print $1}' \
  | while read -r pid; do kill "$pid" 2>/dev/null && echo "  stopped simulator $pid"; done
echo "Stopped."
