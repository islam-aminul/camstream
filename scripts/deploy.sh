#!/usr/bin/env bash
# Deploys everything that changes when the repository changes: the control
# plane, then the console.
#
#   ./scripts/deploy.sh
#
# The two used to be separate steps, and the second one was silent when it was
# skipped. `cdk deploy` reports success, the API gains its new endpoints, and
# the site keeps serving whatever build was last synced — for days, in one
# case, with merged work that existed nowhere a user could see. There is no
# version in the console and nothing compares the bundle behind CloudFront to
# the commit, so the only way to notice is to fetch the deployed JavaScript and
# grep it.
#
# Running them from one place is the cheap half of that problem. It does not
# stop somebody running `cdk deploy` on its own, which is why the README now
# points here instead.
#
# The zone and certificate stacks are deliberately not here. They are set up
# once, one of them needs a human at a registrar, and redeploying them on every
# code change would be noise at best.
set -euo pipefail
export AWS_PAGER=""

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="${CAMSTREAM_STACK:-CamStreamApp}"

echo "==> Control plane ($STACK)"
(cd "$ROOT/infra" && npx cdk deploy "$STACK" "$@")

echo
echo "==> Console"
# After the stack, not before: deploy-web.sh reads the bucket and Cognito ids
# out of the stack's outputs, and writes them into the console's config.
"$ROOT/scripts/deploy-web.sh"
