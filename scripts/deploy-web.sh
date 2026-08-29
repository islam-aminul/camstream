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
cat > dist/config.json <<EOF
{
  "userPoolId": "$USER_POOL",
  "userPoolClientId": "$CLIENT_ID",
  "region": "$REGION"
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
