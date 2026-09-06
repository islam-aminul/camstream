# Proposal: a serverless replacement for the examination CCTV platform

Drafted 2026-09-06 against a nationwide examination livestream platform:
800+ centres, 1,500+ agents, 25,000+ cameras, agents uploading HLS to 50+
WildFly servers, segments on 50+ EFS file systems sharded by agent id, viewers
served by Nginx reading those file systems.

The proposal is to delete the ingest and read tiers rather than resize them:
agents write segments straight to S3 with per-device scoped credentials, and
CloudFront serves them with signed-cookie authorisation.

## Read in this order

| Document | Answers | Read if |
|---|---|---|
| [`00-high-level.md`](00-high-level.md) | What is proposed and why | You have ten minutes |
| [`10-implementation.md`](10-implementation.md) | What gets built, the data model, the integration contract, what is unproven | You will build it or review it |
| [`20-cost.md`](20-cost.md) | What it costs, with the workings exposed | You sign for it |
| [`30-runbook.md`](30-runbook.md) | The commands, in order, end to end | You want to prove it yourself in an hour |
| [`40-questions.md`](40-questions.md) | The questions you will be asked | You are presenting it |

## The four things that matter most

**The agent does not need rewriting.** It is Java 1.8 driving FFmpeg. AWS SDK
for Java 2.x and the IoT Device SDK v2 both support Java 8. The change is where
the segment is *put*, not how it is made — the component that has absorbed years
of camera quirks is untouched.

**The delete problem stops existing.** The single-threaded `find` that cannot
keep up at peak has no equivalent here. The agent removes its own objects as the
2-minute window rolls, S3 charges nothing for DELETE, and there is no queue to
fall behind on. Fifty file systems become about 33 GB resident.

**Cost changes shape, not just size.** ~$65,000/year against an estimated
~$314k, or ~$35,200 with one read-path optimisation. The important part is that
the current bill is identical in June and on exam morning, because it is
provisioned capacity sized for two national exam days.

**S3 PUT requests are 92% of the bill.** Not bandwidth, not storage. Viewing is
6%. Every instinct about video platforms says bandwidth dominates; here it does
not, and that redirects the entire optimisation conversation to the write path.

**The security boundary is the thing name.** Every agent's credentials, topics
and S3 prefix are scoped by `${credentials-iot:ThingName}`. A compromised centre
can corrupt its own video and nothing else — it has no read permission at all.

## What is honestly unproven

This design runs today on a two-agent estate with real cameras, a real NVR,
signed remote updates and CloudFront signed cookies. Every measured number in
these documents comes from it.

Two agents is not 1,500. Four things are listed as unproven at scale in
`10-implementation.md` §7 — IoT connection patterns, S3 request rate, the
CloudFront cookie model under real control-room switching, and DynamoDB
on-demand ramp against a nationwide 09:00 step function. Each says what to test.

The cost comparison against the current platform uses assumed instance types and
EFS sizing. Those are the weakest numbers in the set and are labelled as such;
replace them before quoting anything.
