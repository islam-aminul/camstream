#!/usr/bin/env bash
# Installs CamStreamAgent as a systemd service.
#
#   sudo ./install.sh --identity path/to/identity.json   # zero-touch enrollment
#   sudo ./install.sh [path/to/agent.yaml]               # pre-configured agent
#   sudo ./install.sh --allow-system-tools                # use the host's java/ffmpeg
#   ./install.sh --check                                 # verify dependencies/, install nothing
#
# The agent runs the Java and FFmpeg binaries shipped in this bundle's
# dependencies/ directory, extracted into /opt/camstream/runtime. Nothing is
# read from PATH and nothing is installed system-wide.
#
# That is deliberate. The unit runs as its own user, whose PATH is not the
# installing administrator's, and a distribution upgrade must not be able to
# replace ffmpeg under a running service.
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

IDENTITY=""
CONFIG_SRC=""
# The service runs as a system unit, so what matters is the interpreter the
# unit will invoke — not whichever java happens to be on the installing user's
# PATH. Those differ routinely: under sudo, or with sdkman or asdf managing a
# newer JDK for the login shell only.
JAVA_BIN="${JAVA_BIN:-}"
DEPS_DIR="$HERE/dependencies"
RUNTIME_DIR="$INSTALL_DIR/runtime"
ALLOW_SYSTEM=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    # Resolves the runtime and reports what the agent would use, without
    # installing anything or needing root. The question "did I put the right
    # archives in dependencies/" deserves an answer that costs nothing to ask.
    --check) CHECK_ONLY=1; shift ;;
    --allow-system-tools) ALLOW_SYSTEM=1; shift ;;
    --dependencies) DEPS_DIR="${2:-}"; shift 2 ;;
    --dependencies=*) DEPS_DIR="${1#*=}"; shift ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --identity=*) IDENTITY="${1#*=}"; shift ;;
    --java) JAVA_BIN="${2:-}"; shift 2 ;;
    --java=*) JAVA_BIN="${1#*=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) CONFIG_SRC="$1"; shift ;;
  esac
done
if [ -n "$IDENTITY" ] && [ ! -f "$IDENTITY" ]; then
  echo "ERROR: identity file not found: $IDENTITY" >&2
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  RUNTIME_DIR="$(mktemp -d)"
  trap 'rm -rf "$RUNTIME_DIR"' EXIT
else
  [ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
fi

echo "Checking prerequisites..."

# Unpacks every archive in dependencies/ into the installation's own runtime
# directory. One directory per archive, named after it, so two runtimes cannot
# overwrite each other and re-running is idempotent.
extract_dependencies() {
  [ -d "$DEPS_DIR" ] || return 0
  local found=0
  mkdir -p "$RUNTIME_DIR"
  for archive in "$DEPS_DIR"/*; do
    [ -f "$archive" ] || continue
    local base target
    base="$(basename "$archive")"
    case "$base" in
      *.zip|*.7z|*.tar|*.tgz|*.tar.gz|*.tar.xz|*.tar.bz2) ;;
      *) continue ;;
    esac
    found=1
    target="$RUNTIME_DIR/${base%%.*}"
    if [ -d "$target" ]; then
      echo "  already extracted: $base"
      continue
    fi
    mkdir -p "$target"
    echo "  extracting $base..."
    case "$base" in
      *.zip)
        command -v unzip >/dev/null 2>&1 || {
          echo "ERROR: unzip is needed to unpack $base. Install it, or use the .tar.gz build." >&2
          rm -rf "$target"; exit 1; }
        unzip -q "$archive" -d "$target" ;;
      *.7z)
        # p7zip is not installed by default anywhere; the Linux builds of both
        # dependencies are available as tarballs, so say so plainly.
        if command -v 7z >/dev/null 2>&1; then 7z x -o"$target" -y "$archive" >/dev/null
        elif command -v 7za >/dev/null 2>&1; then 7za x -o"$target" -y "$archive" >/dev/null
        else
          echo "ERROR: $base needs p7zip, which is not installed." >&2
          echo "       Install p7zip-full, or download the .tar.xz build instead." >&2
          rm -rf "$target"; exit 1
        fi ;;
      *)
        tar -xf "$archive" -C "$target" ;;
    esac
  done
  [ "$found" -eq 1 ]
}

# Archive layouts vary between builds, so the tree is searched rather than a
# path assumed. A copy under bin/ wins: that is what tells a real JRE layout
# from a stray helper binary sitting beside it.
find_bundled() {
  local name="$1" hit
  [ -d "$RUNTIME_DIR" ] || return 1
  hit="$(find "$RUNTIME_DIR" -type f -name "$name" -perm -u+x 2>/dev/null | grep '/bin/' | head -1)"
  [ -n "$hit" ] || hit="$(find "$RUNTIME_DIR" -type f -name "$name" -perm -u+x 2>/dev/null | head -1)"
  [ -n "$hit" ] || return 1
  printf '%s' "$hit"
}

resolve_tool() {
  local name="$1" what="$2" hit
  if hit="$(find_bundled "$name")"; then
    printf '%s' "$hit"
    return 0
  fi
  if [ "$ALLOW_SYSTEM" -eq 1 ]; then
    hit="$(command -v "$name" || true)"
    if [ -n "$hit" ]; then
      echo "  WARNING: $name came from PATH, not this bundle; it can change under the service." >&2
      printf '%s' "$hit"
      return 0
    fi
  fi
  echo "ERROR: $name was not found in this bundle." >&2
  echo "       Put $what into $DEPS_DIR and run this again." >&2
  echo "       See dependencies/README.txt for where to download it; nothing needs unpacking." >&2
  exit 1
}

if ! extract_dependencies && [ "$ALLOW_SYSTEM" -eq 0 ] && [ -z "$JAVA_BIN" ]; then
  cat >&2 <<'MSG'
ERROR: the dependencies/ directory is empty.

The agent ships without a Java runtime or FFmpeg so that you choose the builds
and their licences. Put both archives in dependencies/ and run this again — see
dependencies/README.txt.

To use tools already on this machine instead, re-run with --allow-system-tools.
The service then depends on a PATH that is not the one you see here.
MSG
  exit 1
fi

# An explicit --java still wins: an operator naming a specific JRE has made a
# deliberate choice.
[ -n "$JAVA_BIN" ] || JAVA_BIN="$(resolve_tool java 'a JRE 21 or newer')"
FFMPEG_BIN="$(resolve_tool ffmpeg 'an FFmpeg build')"
FFPROBE_BIN="$(resolve_tool ffprobe 'an FFmpeg build (ffprobe ships with it)')"
echo "  ffmpeg:  $FFMPEG_BIN"
echo "  ffprobe: $FFPROBE_BIN"

java_major="$("$JAVA_BIN" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
echo "  java: $JAVA_BIN (${java_major:-unknown})"
if [ "${java_major:-0}" -lt 21 ]; then
  echo "ERROR: the service would run $JAVA_BIN, which is Java ${java_major:-unknown}." >&2
  echo "       Java 21 or newer is required. Pass --java to point at a different one." >&2
  exit 1
fi

# The agent jar carries AWS CRT natives for every architecture and picks one at
# runtime, so it is portable — but only to architectures that are actually in
# there. Failing here beats an UnsatisfiedLinkError on first start.
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64|aarch64|arm64|armv7l|armv6l) echo "  architecture: $arch" ;;
  *)
    echo "ERROR: unsupported architecture '$arch'." >&2
    echo "       The AWS CRT native library ships for x86_64, aarch64, armv7 and armv6 only." >&2
    exit 1
    ;;
esac

# The JVM's own architecture decides which native is loaded, and a 32-bit JVM on
# a 64-bit host silently picks the 32-bit library.
java_arch="$("$JAVA_BIN" -XshowSettings:properties -version 2>&1 | sed -n 's/.*os\.arch = //p' | tr -d ' ')"
echo "  jvm architecture: ${java_arch:-unknown}"
if [ "$java_arch" = "x86" ] || [ "$java_arch" = "i386" ]; then
  echo "  WARNING: a 32-bit JVM is installed. Use a 64-bit JRE unless this box really is 32-bit." >&2
fi

# CamStream stream-copies and needs no GPL codec; warn but do not block, since a
# distro build is fine for evaluation.
if "$HERE/../../scripts/check-ffmpeg-license.sh" "$FFMPEG_BIN" >/dev/null 2>&1; then
  echo "  ffmpeg: LGPL build, suitable for distribution"
else
  echo "  ffmpeg: WARNING — this build is GPL/non-free. Fine for evaluation," >&2
  echo "          but do not ship it. See docs/licensing.md." >&2
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  echo "Dependencies check passed. Nothing was installed."
  echo "Run this again as root, without --check, to install."
  exit 0
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

# Absolute paths into this installation's own runtime. The unit runs as its
# own user, whose PATH is not the installing administrator's, and a system
# upgrade must not be able to change which ffmpeg the agent runs.
ffmpegPath: $FFMPEG_BIN
ffprobePath: $FFPROBE_BIN

segmentDurationMs: 2000
playlistWindow: 4
idleShutdownSeconds: 150

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

# However the config arrived — generated above, supplied on the command line,
# or already present from an earlier install — it must name the binaries this
# installation resolved. A config without these falls back to bare "ffmpeg",
# which is exactly the PATH dependency the bundled runtime exists to remove.
# An operator who set them deliberately keeps their choice.
if ! grep -qE '^[[:space:]]*ffmpegPath:' "$CONFIG_DIR/agent.yaml"; then
  cat >> "$CONFIG_DIR/agent.yaml" <<EOF

# Added by install.sh: absolute paths into this installation's own runtime.
ffmpegPath: $FFMPEG_BIN
EOF
  echo "  pinned ffmpegPath to the bundled runtime"
fi
if ! grep -qE '^[[:space:]]*ffprobePath:' "$CONFIG_DIR/agent.yaml"; then
  echo "ffprobePath: $FFPROBE_BIN" >> "$CONFIG_DIR/agent.yaml"
  echo "  pinned ffprobePath to the bundled runtime"
fi
chown root:"$USER" "$CONFIG_DIR/agent.yaml"
chmod 640 "$CONFIG_DIR/agent.yaml"

# Device identity lives with the state, not the config, so a config change
# never risks orphaning the credential key.
for f in device.crt device.key credential-key.pem; do
  [ -f "$HERE/$f" ] && install -o "$USER" -g "$USER" -m 0600 "$HERE/$f" "$STATE_DIR/$f"
done

# The unit must name the interpreter that was actually checked, not a fixed
# /usr/bin/java that may be a different version entirely.
sed "s#^ExecStart=/usr/bin/java #ExecStart=$JAVA_BIN #" \
  "$HERE/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
chmod 0644 "/etc/systemd/system/$SERVICE.service"
# time-sync.target is passive unless something blocks it, so enable the waiter
# chrony ships if chrony is what this box runs. Without it the unit's
# After=time-sync.target orders against a target that is already reached, and a
# board with no clock battery starts its agent with a clock behind by the
# length of its own outage - far enough that AWS refuses to sign anything.
if systemctl list-unit-files chrony-wait.service >/dev/null 2>&1; then
  systemctl enable chrony-wait.service >/dev/null 2>&1     && echo "  clock: agent will wait for chrony before starting"     || echo "  clock: could not enable chrony-wait; agent may start before NTP settles"
fi

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
