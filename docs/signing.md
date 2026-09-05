# Signing update packages

## What is wrong today

An update instruction names a URL and the agent's only check on it is
`isTrustedSource`: HTTPS, a host ending `.amazonaws.com` containing `s3`. That
is the *shape* of a URL, not evidence that the bundle behind it is ours.

The instruction itself is authenticated — it arrives on an MQTT topic that only
the control plane may publish to, and the agent's subscription is bound to its
own device certificate. That is genuinely adequate for "replace this jar",
which is why this has not been urgent. It is thin for anything wider, and it
becomes the whole of the security story the moment a package is allowed to
describe privileged steps, which is what the update-manifest proposal in
`pending.md` wants to do.

Put plainly: today, "who can produce a package this fleet will install" is
answered by "anyone who can write an object into the downloads prefix, or
anyone who can cause an instruction naming their bucket to be published".

## The decision

**Where the private key lives.** Everything else follows from it.

The recommendation is a **KMS asymmetric key**, `ECC_NIST_P256` with
`ECDSA_SHA_256`, used at publish time. The private half never exists outside
KMS: there is no file to leak, no secret in CI, and nothing to rotate out of a
developer's laptop. Who may sign is an IAM question with a CloudTrail record,
which is the same shape as every other authority in this system.

The alternative — a key file in Secrets Manager, or in the repository, or on
whoever's machine cuts releases — is rejected for the obvious reason. A signing
key that can be copied will eventually be copied, and its compromise is silent.

P-256 rather than RSA because the signature is ~70 bytes rather than ~256, it
travels inside the existing MQTT instruction with room to spare, and
`java.security.Signature` verifies it with no new dependency in the agent.

Cost is $1 a month for the key plus $0.03 per ten thousand signatures.

## What gets signed

The bundle bytes, as fetched. Not the jar inside it: the agent verifies before
it opens the archive, so a malformed or hostile archive is never parsed by a
build that has not already decided to trust it. This matters — the tar reader
is hand-rolled.

## How the signature travels

In the update instruction, beside `version`, `build` and `url`:

```json
{ "action": "update", "version": "0.1.2", "build": "<etag>",
  "url": "https://...", "signature": "<base64>", "keyId": "<kms key id>" }
```

A detached `.sig` object next to the bundle was considered and rejected: it is
one more fetch and one more thing to be missing, in exchange for nothing at
this size.

`keyId` is carried so the agent can say *which* key it could not verify
against, which is the difference between a five-minute diagnosis and an
afternoon. It is **not** used to decide what to trust — the agent trusts only
the keys baked into it.

## Where the public key lives

Baked into the agent jar as a resource, as a set rather than one key.

Fetching it would be circular: a public key delivered over the channel being
authenticated authenticates nothing. A set, because rotation needs the fleet to
trust the new key *before* anything is signed with it — the same two-phase
shape as everything else here.

## Rollout

`updating.md`'s rule governs: **the updater that runs is always the old one.**
An agent applies an update using the code it is already running, so any change
to how updates work only takes effect on the *next* update.

1. **Ship a build that verifies a signature when one is present, and accepts
   packages without one.** Every agent takes this using its current, unsigned
   updater. Start signing published bundles at the same time — a phase-1 agent
   verifies them, and a phase-0 agent ignores the field it does not know about.
2. **Once every agent reports the phase-1 version, ship a build that refuses
   an unsigned package.**

Both steps live in the agent. That is deliberate: if the publisher stopped
signing, nothing would break, whereas an agent that requires a signature it
cannot verify is stranded with no remote way to fix it. The dangerous half is
the one that must never be first.

## What this does and does not buy

**Does:** an attacker who can cause an update instruction to be issued — a
compromised control plane, or anyone who finds a way to publish to a command
topic — still cannot make an agent execute their code, because they cannot
produce a signature. Today they can.

**Does not:** protect against someone holding `kms:Sign` on the key. That
permission is the real trust boundary, and it should be held by the release
pipeline and nothing else.

**Does not:** stop a compromised agent replacing its own jar on Windows, where
the install directory must stay writable so the launcher can apply staged
updates. That is a separate gap, recorded in `pending.md`, and it needs a
privileged pre-start step rather than signing.

The two are complementary and signing is the more valuable: the Windows gap
needs an attacker already running as the agent, while the signing gap is
reachable from anywhere an instruction can be forged.

## What it costs to build

Small. A signing step in the publish path, ~70 lines in the agent to verify
before extraction, a public key resource, and the two-phase rollout above. The
work is not the code; it is doing the rollout in the right order and waiting
for the fleet between the halves.
