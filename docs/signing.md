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

Cost is $1 a month for the key, prorated hourly, plus $0.15 per ten thousand
signatures — the ECC rate, not the $0.03 symmetric one. A release signs two
bundles, so the requests will never be noticed. Verification costs nothing:
the agent checks locally against the compiled-in key and `kms:Verify` is never
called. Rotation adds another $1 a month for as long as both keys are trusted,
since the charge is per key.

## What gets signed

The bundle bytes, as fetched. Not the jar inside it: the agent verifies before
it opens the archive, so a malformed or hostile archive is never parsed by a
build that has not already decided to trust it. This matters — the tar reader
is hand-rolled.

## Signing is over the digest, not the bundle

KMS refuses a raw message over 4096 bytes, and a bundle is thirty megabytes. So
the publisher hashes locally and signs the digest:

```bash
sha256sum bundle.tar.gz            # locally
aws kms sign --message-type DIGEST --signing-algorithm ECDSA_SHA_256
```

The agent is unaffected — `SHA256withECDSA` hashes the bytes and verifies, which
is the same operation from the other side. Confirmed end to end on 2026-09-05: a
KMS signature over a three-megabyte file verified in Java against the committed
public key, and changing one byte broke it.

Worth stating because `--message-type RAW` works perfectly on a small test file
and fails only at real bundle size, which is exactly the kind of thing that gets
discovered during a release rather than before one.

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

1. ~~**Ship a build that verifies a signature when one is present, and accepts
   packages without one.**~~ Shipped in 0.1.1. Every agent took it using its
   current, unsigned updater, and publishing started signing at the same time —
   a phase-1 agent verifies them, and a phase-0 agent ignores the field it does
   not know about.
2. ~~**Once every agent reports the phase-1 version, ship a build that refuses
   an unsigned package.**~~ Shipped in 0.1.7, once both agents reported 0.1.6.

Both steps live in the agent. That is deliberate: if the publisher stopped
signing, nothing would break, whereas an agent that requires a signature it
cannot verify is stranded with no remote way to fix it. The dangerous half is
the one that must never be first.

### What was checked before phase two

Not the code — the *published bundles*, because the enforcing build is only safe
if the signatures already in the bucket are ones it will actually accept. The
publisher signs a SHA-256 digest through KMS and the agent verifies the raw
bytes with `SHA256withECDSA`; those are the same operation from opposite sides,
but "should be equivalent" is a bad thing to learn was wrong from a fleet that
has stopped taking updates.

So every bundle from 0.1.4 to 0.1.6, both platforms, was fetched from the
downloads prefix and verified against the committed public key with `openssl
dgst -sha256 -verify` — the same check the agent makes, from outside the agent.
All six verified. 0.1.1 through 0.1.3 carry signatures too; 0.1.0 does not, and
is the one bundle this change makes unreachable.

### Where the escape hatch is

There is no configuration flag to accept unsigned packages, deliberately. Such a
flag is set once during an incident and never unset, and it would restore
exactly the hole this closes.

If the signing key were ever lost, the recovery is a manual install — which is
how an agent is installed in the first place, and is a path that does not go
through the updater at all. The fleet is small enough that this is a drive, not
a catastrophe. Rotation is the cheaper answer and is already supported: the
agent trusts a *set* of keys, so a new one can be added to the fleet before
anything is signed with it.

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
