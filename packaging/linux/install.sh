#!/usr/bin/env bash
# Installs CamStreamAgent as a systemd service.
#
#   sudo ./install.sh --identity path/to/identity.json   # zero-touch enrollment
#   sudo ./install.sh [path/to/agent.yaml]               # pre-configured agent
#
# Idempotent: re-running upgrades the jar and restarts the service, leaving the
# configuration and the device's keys untouched.
set -euo pipefail

SERVICE=camstream-agent
USER=camstream
INSTALL_DIR=/opt/camstream
CONFIG_DIR=/etc/camstream
STATE_DIR=/var/lib/camstream
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

IDENTITY=""
CONFIG_SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --identity=*) IDENTITY="${1#*=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) CONFIG_SRC="$1"; shift ;;
  esac
done
if [ -n "$IDENTITY" ] && [ ! -f "$IDENTITY" ]; then
  echo "ERROR: identity file not found: $IDENTITY" >&2
  exit 1
fi

echo "Checking prerequisites..."
missing=()
command -v java >/dev/null 2>&1 || missing+=("java (21 or newer)")
command -v ffmpeg >/dev/null 2>&1 || missing+=("ffmpeg")
command -v ffprobe >/dev/null 2>&1 || missing+=("ffprobe")
if [ ${#missing[@]} -gt 0 ]; then
  printf 'Missing: %s\n' "${missing[@]}" >&2
  echo "On Debian/Ubuntu: apt-get install -y openjdk-21-jre-headless ffmpeg" >&2
  exit 1
fi

java_major="$(java -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
if [ "${java_major:-0}" -lt 21 ]; then
  echo "Java 21 or newer is required (found $java_major)." >&2
  exit 1
fi

# CamStream stream-copies and needs no GPL codec; warn but do not block, since a
# distro build is fine for evaluation.
if "$HERE/../../scripts/check-ffmpeg-license.sh" >/dev/null 2>&1; then
  echo "  ffmpeg: LGPL build, suitable for distribution"
else
  echo "  ffmpeg: WARNING — this build is GPL/non-free. Fine for evaluation," >&2
  echo "          but do not ship it. See docs/licensing.md." >&2
fi

id -u "$USER" >/dev/null 2>&1 || {
  echo "Creating service user $USER..."
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$USER"
}

install -d -o root -g root -m 0755 "$INSTALL_DIR"
install -d -o "$USER" -g "$USER" -m 0700 "$STATE_DIR"
install -d -o root -g "$USER" -m 0750 "$CONFIG_DIR"

echo "Installing agent..."
install -o root -g root -m 0644 "$HERE/camstream-agent.jar" "$INSTALL_DIR/camstream-agent.jar"

if [ -n "$IDENTITY" ]; then
  # The agent enrols itself from this on first boot, then strips the secrets
  # out of it and keeps the endpoints.
  install -o "$USER" -g "$USER" -m 0600 "$IDENTITY" "$STATE_DIR/identity.json"
  if [ ! -f "$CONFIG_DIR/agent.yaml" ]; then
    cat > "$CONFIG_DIR/agent.yaml" <<EOF
# Written by install.sh. Everything about this device's identity and endpoints
# comes from identity.json; only local preferences belong here.
identityFile: $STATE_DIR/identity.json
stateDir: $STATE_DIR

segmentDurationMs: 2000
playlistWindow: 4
idleShutdownSeconds: 30

discoveryEnabled: true
discoveryIntervalMinutes: 30

# Cameras are normally approved centrally in the admin console. Anything listed
# here is configured locally and takes precedence.
cameras: []
EOF
    chown root:"$USER" "$CONFIG_DIR/agent.yaml"
    chmod 640 "$CONFIG_DIR/agent.yaml"
    echo "  wrote $CONFIG_DIR/agent.yaml"
  fi
elif [ -n "$CONFIG_SRC" ]; then
  # 0640 root:camstream — the config holds camera credentials.
  install -o root -g "$USER" -m 0640 "$CONFIG_SRC" "$CONFIG_DIR/agent.yaml"
elif [ ! -f "$CONFIG_DIR/agent.yaml" ]; then
  install -o root -g "$USER" -m 0640 "$HERE/agent.yaml.example" "$CONFIG_DIR/agent.yaml"
  echo "  wrote a template to $CONFIG_DIR/agent.yaml — edit it before starting"
fi

# Device identity lives with the state, not the config, so a config change
# never risks orphaning the credential key.
for f in device.crt device.key credential-key.pem; do
  [ -f "$HERE/$f" ] && install -o "$USER" -g "$USER" -m 0600 "$HERE/$f" "$STATE_DIR/$f"
done

install -m 0644 "$HERE/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

if systemctl is-active --quiet "$SERVICE"; then
  echo "Restarting $SERVICE..."
  systemctl restart "$SERVICE"
else
  echo "Starting $SERVICE..."
  systemctl start "$SERVICE" || true
fi

sleep 2
systemctl --no-pager --lines=0 status "$SERVICE" || true
cat <<EOF

Installed.
  config : $CONFIG_DIR/agent.yaml
  state  : $STATE_DIR
  logs   : journalctl -u $SERVICE -f
EOF
