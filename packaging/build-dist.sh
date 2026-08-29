#!/usr/bin/env bash
# Builds the distributable agent bundles.
#
#   ./packaging/build-dist.sh [version]
#
# Produces, under dist/:
#   camstream-agent-<version>-linux.tar.gz
#   camstream-agent-<version>-windows.zip
#   camstream-agent-<version>-macos.tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(sed -n 's:.*<version>\(.*\)</version>.*:\1:p' "$ROOT/agent/pom.xml" | head -1)}"
OUT="$ROOT/dist"
JAR="$ROOT/agent/target/camstream-agent.jar"

echo "Building agent $VERSION..."
(cd "$ROOT/agent" && mvn -B -q package -DskipTests)
[ -f "$JAR" ] || { echo "Build produced no jar." >&2; exit 1; }

# The licence check is advisory at build time but the notice must ship.
echo "Collecting licence notices..."
rm -rf "$OUT"; mkdir -p "$OUT"

stage() {
  local platform="$1"; shift
  local dir="$OUT/stage-$platform"
  rm -rf "$dir"; mkdir -p "$dir"
  cp "$JAR" "$dir/"
  cp "$ROOT/packaging/agent.yaml.example" "$dir/"
  cp "$ROOT/docs/licensing.md" "$dir/LICENSING.md"
  cp "$ROOT/LICENSE" "$dir/"
  cp "$ROOT/NOTICE" "$dir/"
  cp "$ROOT/scripts/check-ffmpeg-license.sh" "$dir/"
  # The runtime is not shipped: the operator chooses the Java and FFmpeg
  # builds, and their licences, and drops the archives in here. The installer
  # extracts them into the installation directory and pins the agent to those
  # exact binaries rather than to anything on PATH.
  mkdir -p "$dir/dependencies"
  cp "$ROOT/packaging/dependencies/README.txt" "$dir/dependencies/"
  for f in "$@"; do cp "$f" "$dir/"; done
  echo "$dir"
}

linux_dir="$(stage linux \
  "$ROOT/packaging/linux/install.sh" \
  "$ROOT/packaging/linux/uninstall.sh" \
  "$ROOT/packaging/linux/camstream-agent.service")"
# install.sh resolves the licence checker relative to itself in the repo; in a
# bundle it sits alongside, so point at that copy.
sed -i 's#"$HERE/../../scripts/check-ffmpeg-license.sh"#"$HERE/check-ffmpeg-license.sh"#' "$linux_dir/install.sh"
tar -czf "$OUT/camstream-agent-$VERSION-linux.tar.gz" -C "$linux_dir" .

windows_dir="$(stage windows \
  "$ROOT/packaging/windows/install.ps1" \
  "$ROOT/packaging/windows/uninstall.ps1" \
  "$ROOT/packaging/windows/camstream-agent.xml")"
# zip is not installed everywhere this is built from - notably not on a
# Windows box with Git Bash, which is where an operator is most likely to be.
# Falling back rather than failing matters: the last time this step failed the
# tarballs were published and the zip was not, so the Windows bundle silently
# stayed months behind the other two.
make_zip() {
  local dir="$1" out="$2"
  if command -v zip >/dev/null 2>&1; then
    (cd "$dir" && zip -qr "$out" .)
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])' "$out" "$dir"
  elif command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command       "Compress-Archive -Path (Join-Path '$dir' '*') -DestinationPath '$out' -Force"
  else
    echo "Need one of: zip, python3, powershell - to build the Windows bundle." >&2
    exit 1
  fi
}
make_zip "$windows_dir" "$OUT/camstream-agent-$VERSION-windows.zip"

macos_dir="$(stage macos "$ROOT/packaging/macos/online.camstream.agent.plist")"
tar -czf "$OUT/camstream-agent-$VERSION-macos.tar.gz" -C "$macos_dir" .

rm -rf "$OUT"/stage-*
echo
ls -lh "$OUT" | tail -n +2 | awk '{printf "  %-46s %s\n", $9, $5}'

# Publishing makes the bundles fetchable by the installer scripts the admin
# console generates. The prefix is not mapped by any CloudFront behaviour, so
# they are reachable only through a presigned link.
if [ "${CAMSTREAM_PUBLISH:-}" = "1" ]; then
  BUCKET="$(aws cloudformation describe-stacks --stack-name "${CAMSTREAM_STACK:-CamStreamApp}" \
    --region "${CAMSTREAM_REGION:-ap-south-1}" \
    --query "Stacks[0].Outputs[?OutputKey=='LiveBucket'].OutputValue" --output text)"
  echo
  echo "Publishing to s3://$BUCKET/downloads/ ..."
  aws s3 cp "$OUT/" "s3://$BUCKET/downloads/" --recursive \
    --exclude "*" --include "camstream-agent-$VERSION-*" \
    --region "${CAMSTREAM_REGION:-ap-south-1}" --only-show-errors
  echo "Published."
fi
