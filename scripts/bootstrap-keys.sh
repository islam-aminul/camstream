#!/usr/bin/env bash
# Generates the RSA keypair CloudFront uses to sign viewer cookies.
#   public key  -> infra/keys/cloudfront-public.pem  (committed; CDK reads it at synth)
#   private key -> SSM SecureString                  (never touches the repo)
set -euo pipefail
export AWS_PAGER=""

REGION="${CAMSTREAM_REGION:-ap-south-1}"
PARAM="/camstream/cloudfront/private-key"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUB="$ROOT/infra/keys/cloudfront-public.pem"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if aws ssm get-parameter --name "$PARAM" --region "$REGION" >/dev/null 2>&1; then
  echo "SSM parameter $PARAM already exists."
  if [ -f "$PUB" ]; then
    echo "Public key already present at $PUB — nothing to do."
    exit 0
  fi
  echo "ERROR: private key exists in SSM but $PUB is missing; they must be a pair." >&2
  echo "Delete the parameter and re-run to regenerate both:" >&2
  echo "  aws ssm delete-parameter --name $PARAM --region $REGION" >&2
  exit 1
fi

echo "Generating RSA 2048 keypair..."
openssl genrsa -out "$TMP/private.pem" 2048 2>/dev/null
openssl rsa -pubout -in "$TMP/private.pem" -out "$PUB" 2>/dev/null

echo "Storing private key in SSM SecureString $PARAM ($REGION)..."
aws ssm put-parameter \
  --name "$PARAM" \
  --type SecureString \
  --value "file://$TMP/private.pem" \
  --description "CloudFront cookie-signing private key for CamStream" \
  --region "$REGION" \
  --tier Standard >/dev/null

echo "Done."
echo "  public : $PUB"
echo "  private: ssm://$PARAM ($REGION)"
