#!/usr/bin/env bash
# Creates the shared claim certificate used by agent installers.
#
# The claim certificate is embedded in every download, so on its own it must be
# worth nothing: its IoT policy allows only requesting a certificate and calling
# the provisioning template, and the pre-provisioning hook refuses unless the
# request also carries a one-time enrollment token minted for one agent.
#
# CloudFormation cannot issue an IoT certificate and capture the private key,
# which is why this is a script rather than part of the stack.
set -euo pipefail
export AWS_PAGER=""

REGION="${CAMSTREAM_REGION:-ap-south-1}"
PARAM="/camstream/iot/claim-certificate"
POLICY="${CAMSTREAM_CLAIM_POLICY:-camstream-claim-policy}"

if aws ssm get-parameter --name "$PARAM" --region "$REGION" >/dev/null 2>&1; then
  echo "Claim certificate already exists at $PARAM."
  echo "To rotate it, delete the parameter and the old certificate first:"
  echo "  aws ssm delete-parameter --name $PARAM --region $REGION"
  exit 0
fi

if ! aws iot get-policy --policy-name "$POLICY" --region "$REGION" >/dev/null 2>&1; then
  echo "ERROR: IoT policy $POLICY does not exist — deploy CamStreamApp first." >&2
  exit 1
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "Issuing claim certificate..."
aws iot create-keys-and-certificate --set-as-active --region "$REGION" \
  --certificate-pem-outfile "$TMP/claim.crt" \
  --private-key-outfile "$TMP/claim.key" \
  --public-key-outfile "$TMP/claim.pub" \
  --query certificateArn --output text > "$TMP/arn"
CERT_ARN="$(cat "$TMP/arn")"

aws iot attach-policy --policy-name "$POLICY" --target "$CERT_ARN" --region "$REGION"

echo "Storing in SSM SecureString $PARAM..."
python3 - "$TMP/claim.crt" "$TMP/claim.key" "$CERT_ARN" > "$TMP/bundle.json" <<'PY'
import json, sys
print(json.dumps({
    "certificatePem": open(sys.argv[1]).read(),
    "privateKey": open(sys.argv[2]).read(),
    "certificateArn": sys.argv[3],
}))
PY
aws ssm put-parameter --name "$PARAM" --type SecureString \
  --value "file://$TMP/bundle.json" --region "$REGION" --tier Advanced \
  --description "Shared IoT claim certificate for CamStream agent enrollment" >/dev/null

echo "Done."
echo "  certificate : $CERT_ARN"
echo "  policy      : $POLICY  (request a certificate + run the template, nothing else)"
echo "  stored      : ssm://$PARAM ($REGION)"
