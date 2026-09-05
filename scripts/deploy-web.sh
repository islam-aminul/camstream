#!/usr/bin/env bash
# Builds the player and publishes it to the web bucket behind CloudFront.
set -euo pipefail
export AWS_PAGER=""

REGION="${CAMSTREAM_REGION:-ap-south-1}"
STACK="${CAMSTREAM_STACK:-CamStreamApp}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

echo "Reading stack outputs..."
BUCKET="$(output WebBucket)"
DISTRIBUTION="$(output DistributionId)"
USER_POOL="$(output UserPoolId)"
CLIENT_ID="$(output UserPoolClientId)"
SITE="$(output SiteUrl)"

for pair in "BUCKET:$BUCKET" "DISTRIBUTION:$DISTRIBUTION" "USER_POOL:$USER_POOL" "CLIENT_ID:$CLIENT_ID"; do
  if [ -z "${pair#*:}" ] || [ "${pair#*:}" = "None" ]; then
    echo "ERROR: stack output ${pair%%:*} is empty — is $STACK deployed?" >&2
    exit 1
  fi
done

echo "Building..."
cd "$ROOT/web"
npm run build

# Written after the build so it always matches the stack being deployed to.
# Which commit this console was built from, and when.
#
# config.json is fetched with no-store and rewritten on every deploy, so it is
# the one file that is never stale - which makes it the only honest place to
# record what is actually published. Everything else behind CloudFront is
# content-hashed and cached forever, so an old bundle looks exactly like a
# current one from the outside.
#
# The point is that this is answerable without signing in:
#
#   curl -s https://camstream.online/config.json | jq -r .buildCommit
#
# Twice on 2026-09-05 the site served a console that was days behind the API,
# because the two deploy separately and skipping the second says nothing. There
# was no way to tell short of downloading the JavaScript and grepping it for a
# string that only exists in the newer build - and picking a string that also
# existed in the older one is how the second one got missed.
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if ! git -C "$ROOT" diff --quiet HEAD 2>/dev/null; then DIRTY="+local"; fi
BUILT_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

cat > dist/config.json <<EOF
{
  "userPoolId": "$USER_POOL",
  "userPoolClientId": "$CLIENT_ID",
  "region": "$REGION",
  "buildCommit": "$COMMIT$DIRTY",
  "builtAt": "$BUILT_AT"
}
EOF

echo "Uploading to s3://$BUCKET ..."
# Hashed filenames — safe to cache forever.
aws s3 sync dist/ "s3://$BUCKET/" --delete --region "$REGION" \
  --exclude "index.html" --exclude "config.json" \
  --cache-control "public, max-age=31536000, immutable"

# The two files that must never be stale.
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --region "$REGION" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
aws s3 cp dist/config.json "s3://$BUCKET/config.json" --region "$REGION" \
  --cache-control "no-cache" --content-type "application/json"

echo "Invalidating CloudFront..."
# MSYS_NO_PATHCONV stops Git Bash on Windows rewriting a leading "/" into a
# Windows path before the argument reaches the CLI: "/index.html" arrives as
# "C:/Program Files/Git/index.html" and CloudFront rejects it as an invalid
# invalidation path. Harmless elsewhere, and this is the script an operator
# on Windows is most likely to run.
MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths "/index.html" "/config.json" --query 'Invalidation.Id' --output text

echo "Done — $SITE"
