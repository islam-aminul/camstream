# Runbook — standing it up by hand

Every step as a command, in order, with what it is for and what it costs. This
builds one working end-to-end path: an agent publishing to S3, and an authorised
viewer watching through CloudFront.

Do this in a scratch account first. It is roughly an hour, and having built it
once by hand is worth more in the design review than any diagram.

**Conventions.** Placeholders in `ANGLE_BRACKETS`. Region `ap-south-1`
throughout. Commands are `bash` with AWS CLI v2.

```bash
export AWS_REGION=ap-south-1
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export PREFIX=examcctv                     # everything is named from this
export DOMAIN=live.example.gov.in          # the viewer-facing domain
```

---

## 1. The segment bucket

**Why:** this replaces the 50 EFS file systems. No capacity, no shard map.

```bash
aws s3api create-bucket \
  --bucket ${PREFIX}-live-${ACCOUNT} \
  --region ${AWS_REGION} \
  --create-bucket-configuration LocationConstraint=${AWS_REGION}

# Public access stays off. CloudFront reaches it through OAC, not the internet.
aws s3api put-public-access-block \
  --bucket ${PREFIX}-live-${ACCOUNT} \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

**The lifecycle backstop.** The agent deletes its own segments as the 2-minute
window rolls; this only catches objects orphaned by a crash. One day is the
finest granularity S3 offers, which is why it cannot *be* the window.

```bash
cat > /tmp/lifecycle.json <<'JSON'
{ "Rules": [
    { "ID": "expire-orphaned-segments",
      "Status": "Enabled",
      "Filter": { "Prefix": "live/" },
      "Expiration": { "Days": 1 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } } ] }
JSON

aws s3api put-bucket-lifecycle-configuration \
  --bucket ${PREFIX}-live-${ACCOUNT} \
  --lifecycle-configuration file:///tmp/lifecycle.json
```

**Cost:** storage only. At a 2-minute window across 25,000 cameras, ~41 GB
resident ≈ $1/month. Ingest is free; DELETE is free.

---

## 2. Agent identity — IoT, and credentials without a shared secret

**Why:** this is what lets an agent write to S3 with no long-lived key on a
machine in a building you do not control.

### 2.1 The role an agent assumes

Note `${credentials-iot:ThingName}` in the resource path. That one variable is
what confines an agent to its own centre.

```bash
cat > /tmp/trust.json <<'JSON'
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
                  "Principal": { "Service": "credentials.iot.amazonaws.com" },
                  "Action": "sts:AssumeRole" }] }
JSON

aws iam create-role --role-name ${PREFIX}-agent \
  --assume-role-policy-document file:///tmp/trust.json

cat > /tmp/agent-policy.json <<JSON
{ "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${PREFIX}-live-${ACCOUNT}/live/\\\${credentials-iot:ThingName}/*" }
  ] }
JSON

aws iam put-role-policy --role-name ${PREFIX}-agent \
  --policy-name write-own-prefix \
  --policy-document file:///tmp/agent-policy.json
```

**Note there is no `s3:GetObject`.** An agent writes and deletes; it never
reads, not even its own video. A compromised centre cannot exfiltrate footage,
only corrupt its own.

### 2.2 The role alias

```bash
aws iot create-role-alias \
  --role-alias ${PREFIX}-agent-alias \
  --role-arn arn:aws:iam::${ACCOUNT}:role/${PREFIX}-agent \
  --credential-duration-seconds 3600

# The account-specific credentials endpoint. Agents need this in their config.
aws iot describe-endpoint --endpoint-type iot:CredentialProvider
aws iot describe-endpoint --endpoint-type iot:Data-ATS
```

### 2.3 The IoT policy attached to each certificate

```bash
cat > /tmp/iot-policy.json <<JSON
{ "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "iot:AssumeRoleWithCertificate",
      "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT}:rolealias/${PREFIX}-agent-alias" },
    { "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT}:client/\\\${iot:Connection.Thing.ThingName}" },
    { "Effect": "Allow", "Action": ["iot:Publish", "iot:Receive"],
      "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT}:topic/camstream/\\\${iot:Connection.Thing.ThingName}/*" },
    { "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": "arn:aws:iot:${AWS_REGION}:${ACCOUNT}:topicfilter/camstream/\\\${iot:Connection.Thing.ThingName}/*" }
  ] }
JSON

aws iot create-policy --policy-name ${PREFIX}-agent-policy \
  --policy-document file:///tmp/iot-policy.json
```

Every resource is bound to `${iot:Connection.Thing.ThingName}`. An agent cannot
publish to, subscribe to, or impersonate another centre. **This is the security
boundary of the whole design** — read it twice before deploying it.

### 2.4 Register one agent

For a pilot, by hand. For 1,500, use fleet provisioning with a claim
certificate (§8).

```bash
export THING=examtenant--centre4021--agent01

aws iot create-thing --thing-name ${THING}

aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile /tmp/${THING}.crt \
  --private-key-outfile /tmp/${THING}.key \
  --query certificateArn --output text > /tmp/${THING}.arn

export CERT_ARN=$(cat /tmp/${THING}.arn)
aws iot attach-policy --policy-name ${PREFIX}-agent-policy --target ${CERT_ARN}
aws iot attach-thing-principal --thing-name ${THING} --principal ${CERT_ARN}
```

### 2.5 Prove it — the step most worth doing yourself

Exchange the certificate for AWS credentials and write an object. If this works,
the hardest part of the architecture is proven.

```bash
export CRED_EP=$(aws iot describe-endpoint --endpoint-type iot:CredentialProvider \
  --query endpointAddress --output text)

curl --cert /tmp/${THING}.crt --key /tmp/${THING}.key \
  "https://${CRED_EP}/role-aliases/${PREFIX}-agent-alias/credentials" \
  -H "x-amzn-iot-thingname: ${THING}"
```

Export the three values it returns and write a segment:

```bash
export AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_SESSION_TOKEN=…

echo "segment" > /tmp/1.m4s
aws s3 cp /tmp/1.m4s s3://${PREFIX}-live-${ACCOUNT}/live/${THING}/cam-01/sub/1.m4s   # succeeds
aws s3 cp /tmp/1.m4s s3://${PREFIX}-live-${ACCOUNT}/live/someone-else/cam-01/sub/1.m4s  # AccessDenied
```

**The second command must fail.** If it does not, the policy is wrong and every
agent can overwrite every centre. Do not proceed past a passing second command.

**Cost:** IoT connectivity $0.08 per million connection-minutes — 1,500 agents
connected permanently is about **$5/month**.

---

## 3. Delivery — CloudFront with signed cookies

**Why:** replaces the Nginx tier. Authorisation happens at the edge, so an
unauthorised request never reaches S3.

### 3.1 The key pair that signs cookies

```bash
openssl genrsa -out /tmp/cf-private.pem 2048
openssl rsa -pubout -in /tmp/cf-private.pem -out /tmp/cf-public.pem

aws cloudfront create-public-key --public-key-config \
  "Name=${PREFIX}-viewer,EncodedKey=$(cat /tmp/cf-public.pem),CallerReference=$(date +%s)"
# note the Id, then:
aws cloudfront create-key-group --key-group-config \
  "Name=${PREFIX}-viewers,Items=<PUBLIC_KEY_ID>,CallerReference=$(date +%s)"
```

Put the private key in Secrets Manager. It is the key to every camera in the
country and must never be in a repository or an AMI:

```bash
aws secretsmanager create-secret --name ${PREFIX}/cloudfront-signing-key \
  --secret-string file:///tmp/cf-private.pem
shred -u /tmp/cf-private.pem
```

### 3.2 Origin access and the distribution

```bash
aws cloudfront create-origin-access-control --origin-access-control-config \
  "Name=${PREFIX}-oac,OriginAccessControlOriginType=s3,\
SigningBehavior=always,SigningProtocol=sigv4"
```

Create the distribution with the S3 bucket as origin, the OAC attached, and
`TrustedKeyGroups` set to the key group. Then let only that distribution read
the bucket:

```bash
cat > /tmp/bucket-policy.json <<JSON
{ "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${PREFIX}-live-${ACCOUNT}/*",
    "Condition": { "StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT}:distribution/<DIST_ID>" } } }] }
JSON

aws s3api put-bucket-policy --bucket ${PREFIX}-live-${ACCOUNT} \
  --policy file:///tmp/bucket-policy.json
```

### 3.3 Cache behaviours that matter

Two, and getting them wrong is the classic HLS mistake:

| Path pattern | TTL | Why |
|---|---|---|
| `*.m4s` / `*.ts` | 1 year | Segments are immutable — the filename changes, the content never does |
| `*.m3u8` | **1–2 s** | The playlist changes every segment. Cache it long and every viewer is stuck in the past |

With 10-second segments a playlist TTL of 2 s still collapses a hundred
observers watching one centre into a handful of origin reads, while keeping
everyone within one segment of live.

**Cost:** egress ~$0.10/GB tiered, requests $0.0120 per 10,000. No fixed
component.

---

## 4. Registry

**Why:** replaces whatever tracks agents and cameras today. On-demand billing
means it costs nothing between exams.

```bash
aws dynamodb create-table \
  --table-name ${PREFIX}-registry \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

aws dynamodb update-time-to-live --table-name ${PREFIX}-registry \
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt"
```

**Consider provisioned capacity with scheduled scaling for exam days.** On-demand
scales *after* a burst, and an exam starting at 09:00 nationwide is a step
function. A known-in-advance peak is exactly the case where provisioned capacity
is both cheaper and safer.

---

## 5. Health telemetry without a Lambda

**Why:** an IoT rule writes heartbeats straight to DynamoDB. No compute in the
path, so it cannot be throttled or cold-start.

```bash
cat > /tmp/heartbeat-rule.json <<JSON
{ "sql": "SELECT concat('TENANT#', substring(topic(2), 0, indexof(topic(2), '--'))) AS pk, concat('HEALTH#', topic(2)) AS sk, topic(2) AS thingName, agentVersion, publishing, camerasConfigured, healthy, cpuLoad, memoryUsedFraction, diskFreeBytes, uploadBytesPerSecond, floor(timestamp() / 1000) AS heartbeatAt, floor(timestamp() / 1000) + 259200 AS expiresAt FROM 'camstream/+/heartbeat'",
  "awsIotSqlVersion": "2016-03-23",
  "ruleDisabled": false,
  "actions": [ { "dynamoDBv2": {
      "putItem": { "tableName": "${PREFIX}-registry" },
      "roleArn": "arn:aws:iam::${ACCOUNT}:role/${PREFIX}-heartbeat-rule" } } ] }
JSON

aws iot create-topic-rule --rule-name ${PREFIX}_agent_heartbeat \
  --topic-rule-payload file:///tmp/heartbeat-rule.json
```

**The thing name comes from `topic(2)`, never from the payload.** A certificate
may only publish under its own thing name, so the topic is authenticated and the
message body is not. An agent cannot forge a heartbeat for another centre.

---

## 6. Alarms that matter on day one

```bash
aws sns create-topic --name ${PREFIX}-alarms
aws sns subscribe --topic-arn arn:aws:sns:${AWS_REGION}:${ACCOUNT}:${PREFIX}-alarms \
  --protocol email --notification-endpoint ops@example.gov.in
```

Three worth having before the first exam:

1. **No agent has heartbeated for 45 minutes** — `AWS/IoT TopicMatch` on the
   heartbeat rule, `Sum < 1`, **treat missing data as breaching**, because no
   data points at all is precisely the condition being detected.
2. **The heartbeat rule is failing** — `AWS/IoT Failure`. The quietest failure
   in the system: IoT accepts the message, the rule matches, the write fails,
   and every agent looks healthy from its own side while the console shows an
   estate that stopped reporting.
3. **Billing.** A publish loop that does not stop at the end of a shift is the
   failure mode that costs money silently.

---

## 7. The viewer session — the part with a trap in it

**Why:** the integration authenticates the user; we authorise the video.

The flow, and the reason it needs a redirect:

```
  1. user logs in to the integration console       (their IdP, their rules)
  2. their backend → POST /api/integration/viewer-sessions
        { user, scope: { centreIds: [...] }, ttlSeconds: 900 }
     ← { viewerUrl: "https://live.example.gov.in/session?t=<one-time>" }
  3. browser follows viewerUrl                     (OUR domain)
  4. our endpoint validates the token, and responds with
        Set-Cookie: CloudFront-Policy=…; Domain=live.example.gov.in; Secure; HttpOnly
        Set-Cookie: CloudFront-Signature=…
        Set-Cookie: CloudFront-Key-Pair-Id=…
     then 302s to the player
  5. player fetches m3u8 and segments; CloudFront checks the cookie at the edge
```

**Step 3 cannot be skipped.** A cookie can only be set by the domain that serves
the response, so the integration's backend cannot set a cookie on the CloudFront
domain. The browser has to touch our origin exactly once. Everything before that
is server-to-server and carries no video.

**The trap: a CloudFront custom policy carries exactly one resource statement.**
A viewer authorised for several centres cannot be granted all of them in one
cookie. The naive fix — issue a tenant-wide wildcard to anyone with more than
one centre — makes the restriction grant everything it was meant to limit. This
has been got wrong in production and is worth stating in the design review.

Since your observers are assigned to a few centres rather than roaming, the
practical answer is a prefix hierarchy chosen up front:

```
  live/<region>/<centre>/<camera>/...
```

Grant `live/KA/*` to a state control room, `live/KA/4021/*` to a centre
observer. **Decide this before the first object is written** — it is in every
key and changing it later is a migration.

Policy to sign (15-minute expiry):

```json
{ "Statement": [ {
    "Resource": "https://live.example.gov.in/live/KA/4021/*",
    "Condition": { "DateLessThan": { "AWS:EpochTime": 1788672000 } } } ] }
```

---

## 8. Fleet provisioning, for 1,500 agents

Doing §2.4 by hand 1,500 times is not a plan. Fleet provisioning issues each
agent its own certificate on first boot from a shared claim certificate.

```bash
aws iot create-provisioning-template \
  --template-name ${PREFIX}-provisioning \
  --provisioning-role-arn arn:aws:iam::${ACCOUNT}:role/${PREFIX}-provisioning \
  --template-body file:///tmp/provisioning-template.json \
  --enabled
```

**The claim certificate is a shared secret and must be treated as one.** Scope
its policy to provisioning actions only, and use a pre-provisioning hook Lambda
to check the claim against your own list of expected agents. Without that hook,
anyone holding the claim certificate can register any thing name they like — and
thing name is the security boundary for everything above.

---

## 9. Teardown

```bash
aws s3 rm s3://${PREFIX}-live-${ACCOUNT} --recursive
aws s3api delete-bucket --bucket ${PREFIX}-live-${ACCOUNT}
aws dynamodb delete-table --table-name ${PREFIX}-registry
aws iot delete-topic-rule --rule-name ${PREFIX}_agent_heartbeat
aws iot delete-role-alias --role-alias ${PREFIX}-agent-alias
# certificates must be deactivated and detached before deletion
```

CloudFront distributions must be disabled and fully deployed before they can be
deleted — allow 15 minutes.

---

## 10. Doing it properly

Everything above is one path, by hand, to prove the mechanism. For a real
deployment use infrastructure as code — the reference implementation is AWS CDK
in TypeScript, and it produces exactly the resources above plus the console, the
control-plane Lambdas, and the alarms.

The value of doing it by hand once is that when the CDK stack fails to deploy,
you will know which resource it was and what it is for.

**Order of work for a pilot:**

1. §1–2.5 — prove certificate-to-S3. Half an hour, and it de-risks the whole
   proposal.
2. §3 — one camera visible through CloudFront with a signed cookie.
3. Adapt one existing Java 1.8 agent to `putObject` instead of multipart upload
   (`10-implementation.md` §2.1). This is the real test and it is small.
4. Run one centre on both platforms through a full exam shift and compare.
5. Only then discuss migrating 800.
