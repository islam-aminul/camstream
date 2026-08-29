#!/usr/bin/env bash
# Enrols one edge agent: creates its IoT thing and X.509 identity, then writes
# the keystore and config file the agent needs.
#
#   ./scripts/provision-device.sh <tenantId> <deviceId> [siteName]
#
# Identifiers must be [a-z0-9-], 3-32 chars, and must not contain '--', which is
# reserved as the tenant/device separator inside the thing name.
set -euo pipefail
export AWS_PAGER=""

REGION="${CAMSTREAM_REGION:-ap-south-1}"
STACK="${CAMSTREAM_STACK:-CamStreamApp}"
POLICY="camstream-device-policy"
ROLE_ALIAS="camstream-device"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TENANT="${1:-}"; DEVICE="${2:-}"; SITE="${3:-$DEVICE}"
if [ -z "$TENANT" ] || [ -z "$DEVICE" ]; then
  echo "usage: $0 <tenantId> <deviceId> [siteName]" >&2
  exit 2
fi
for id in "$TENANT" "$DEVICE"; do
  if ! printf '%s' "$id" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$' || \
     [ ${#id} -lt 3 ] || [ ${#id} -gt 32 ] || case "$id" in *--*) true;; *) false;; esac; then
    echo "ERROR: '$id' must be 3-32 chars of [a-z0-9-] and must not contain '--'" >&2
    exit 2
  fi
done

THING="${TENANT}--${DEVICE}"
OUT="$ROOT/devices/$THING"
if [ -e "$OUT" ]; then
  echo "ERROR: $OUT already exists; refusing to overwrite an enrolled device." >&2
  exit 1
fi
mkdir -p "$OUT"
chmod 700 "$OUT"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(output LiveBucket)"
SITE_URL="$(output SiteUrl)"
API_URL="$(output ApiInvokeUrl)"
if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "ERROR: could not read LiveBucket from $STACK — is it deployed?" >&2
  exit 1
fi

CRED_ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:CredentialProvider --region "$REGION" --query endpointAddress --output text)"
DATA_ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region "$REGION" --query endpointAddress --output text)"

echo "Creating thing $THING ..."
# IoT thing attributes accept only [a-zA-Z0-9_.,@/:#=\[\]-]; the human-readable
# site name reaches the UI through the heartbeat, not through this attribute.
SITE_ATTR="$(printf '%s' "$SITE" | tr -c 'a-zA-Z0-9_.,@/:#=[]-' '-' | cut -c1-800)"
aws iot create-thing --thing-name "$THING" --thing-type-name camstream-agent \
  --attribute-payload "attributes={tenantId=$TENANT,siteName=$SITE_ATTR}" --region "$REGION" >/dev/null

echo "Issuing certificate ..."
CERT_ARN="$(aws iot create-keys-and-certificate --set-as-active --region "$REGION" \
  --certificate-pem-outfile "$OUT/device.crt" \
  --private-key-outfile "$OUT/device.key" \
  --public-key-outfile "$OUT/device.pub" \
  --query certificateArn --output text)"
chmod 600 "$OUT"/device.*

aws iot attach-policy --policy-name "$POLICY" --target "$CERT_ARN" --region "$REGION"
aws iot attach-thing-principal --thing-name "$THING" --principal "$CERT_ARN" --region "$REGION"

echo "Fetching Amazon root CA ..."
curl -fsSL https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "$OUT/AmazonRootCA1.pem"

# The agent talks mTLS to IoT via JSSE, which wants a PKCS#12 keystore rather
# than loose PEM files.
KEYSTORE_PASS="$(openssl rand -base64 24 | tr -d '\n')"
openssl pkcs12 -export \
  -in "$OUT/device.crt" -inkey "$OUT/device.key" \
  -certfile "$OUT/AmazonRootCA1.pem" \
  -name camstream-device \
  -out "$OUT/device.p12" -passout "pass:$KEYSTORE_PASS"
chmod 600 "$OUT/device.p12"

cat > "$OUT/agent.yaml" <<EOF
# CamStreamAgent configuration for $THING
tenantId: $TENANT
deviceId: $DEVICE
siteName: "$SITE"
region: $REGION
bucket: $BUCKET
# Direct API Gateway endpoint. Not the CloudFront domain — SigV4 signs the Host
# header and CloudFront rewrites it, which would break every signature.
apiInvokeUrl: $API_URL

iotCredentialsEndpoint: $CRED_ENDPOINT
iotDataEndpoint: $DATA_ENDPOINT
roleAlias: $ROLE_ALIAS
keystorePath: $OUT/device.p12
keystorePassword: "$KEYSTORE_PASS"
certificatePath: $OUT/device.crt
privateKeyPath: $OUT/device.key

# 2s segments give roughly 5s of latency. Raising this halves the S3 request
# bill for roughly double the delay.
segmentDurationMs: 2000
playlistWindow: 4
idleShutdownSeconds: 150

cameras:
  - id: front-door
    name: Front Door
    subStreamUrl: rtsp://user:pass@192.168.1.64:554/Streaming/Channels/102
    mainStreamUrl: rtsp://user:pass@192.168.1.64:554/Streaming/Channels/101
EOF
chmod 600 "$OUT/agent.yaml"

cat <<EOF

Provisioned $THING
  directory : $OUT   (contains private key material — keep it out of git)
  keystore  : $OUT/device.p12
  config    : $OUT/agent.yaml   <- edit the cameras list before starting

Start the agent with:
  java -jar agent/target/camstream-agent.jar $OUT/agent.yaml
EOF
