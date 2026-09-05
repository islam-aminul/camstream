#!/usr/bin/env bash
# Builds the agent bundles, signs them, and publishes them for remote update.
#
#   ./scripts/publish-agent.sh [version]
#
# Signing is the point. Without it an update instruction proves only that the
# URL it names looks like S3, and the agent installs whatever is behind it. See
# docs/signing.md.
#
# The signature travels as S3 object metadata rather than as a file beside the
# bundle, so it cannot go missing separately from the thing it describes. The
# admin lambda already does a HeadObject for the build id and reads both from
# the same response.
set -euo pipefail
export AWS_PAGER=""

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${CAMSTREAM_REGION:-ap-south-1}"
STACK="${CAMSTREAM_STACK:-CamStreamApp}"
VERSION="${1:-$(sed -n 's:.*<version>\(.*\)</version>.*:\1:p' "$ROOT/agent/pom.xml" | head -1)}"

# The AWS CLI may be a native Windows binary while this runs under Git Bash,
# in which case it cannot resolve a POSIX path like /tmp/xyz - the failure is
# "no such file" for a file that plainly exists. cygpath is the translation
# when it is there, and a no-op everywhere else.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?contains(OutputKey,'$1')].OutputValue" --output text
}

BUCKET="$(output LiveBucket)"
KEY_ID="$(output ReleaseSigningKeyId)"
[ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] || { echo "no live bucket in $STACK" >&2; exit 1; }
[ -n "$KEY_ID" ] && [ "$KEY_ID" != "None" ] || { echo "no signing key in $STACK" >&2; exit 1; }

echo "Publishing agent $VERSION"
echo "  bucket: $BUCKET"
echo "  key:    $KEY_ID"

"$ROOT/packaging/build-dist.sh" "$VERSION"

for platform in linux windows; do
  bundle="$ROOT/dist/camstream-agent-$VERSION-$platform.tar.gz"
  [ -f "$bundle" ] || { echo "missing $bundle" >&2; exit 1; }

  # KMS refuses a raw message over 4096 bytes and a bundle is thirty megabytes,
  # so the digest is computed here and that is what gets signed. The agent is
  # unaffected: SHA256withECDSA hashes the bytes and verifies, which is the
  # same operation from the other side.
  # Beside the bundle rather than in /tmp, so both this shell and a native
  # Windows CLI can name it.
  digest="$ROOT/dist/.$platform-$VERSION.sha256"
  python3 - "$bundle" "$digest" <<'PY'
import hashlib, sys
with open(sys.argv[1], 'rb') as f:
    h = hashlib.sha256()
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        h.update(chunk)
open(sys.argv[2], 'wb').write(h.digest())
PY

  signature="$(aws kms sign --key-id "$KEY_ID" --region "$REGION" \
      --message "fileb://$(native "$digest")" --message-type DIGEST \
      --signing-algorithm ECDSA_SHA_256 --query Signature --output text)"
  rm -f "$digest"
  [ -n "$signature" ] || { echo "signing $platform produced nothing" >&2; exit 1; }

  echo "  $platform: signed ($(echo -n "$signature" | wc -c) chars), uploading"
  aws s3 cp "$bundle" "s3://$BUCKET/downloads/camstream-agent-$VERSION-$platform.tar.gz" \
    --region "$REGION" --only-show-errors \
    --metadata "signature=$signature,signing-key-id=$KEY_ID"
done

echo
echo "Published $VERSION. Agents will verify against the key compiled into them;"
echo "a build older than signing ignores the field and installs as before."
