import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CamStreamZoneStack } from '../lib/zone-stack';
import { CamStreamCertStack } from '../lib/cert-stack';
import { CamStreamAppStack } from '../lib/app-stack';
import { resolveConfig } from '../lib/config';

/**
 * Somebody is told whenever the release key signs something.
 *
 * Since agent 0.1.7 an unsigned package is refused outright — which was the
 * point of signing, and which makes `kms:Sign` on this one key the whole of the
 * answer to "who decides what runs on the fleet". An agent installs any bundle
 * that key has signed, without further question.
 *
 * The key material cannot be copied out of KMS, so the only interesting event
 * is somebody asking it to sign, and until now nothing watched for that at all.
 * A signature made by anyone but the release path would have left no trace
 * anybody would see.
 */
function synth() {
  const app = new App({
    context: {
      'camstream:account': '123456789012',
      'camstream:primaryRegion': 'ap-south-1',
      'camstream:edgeRegion': 'us-east-1',
      'camstream:domainName': 'camstream.online',
      'camstream:segmentTtlDays': 1,
    },
  });
  const config = resolveConfig(app);
  const edgeEnv = { account: config.account, region: config.edgeRegion };
  const zone = new CamStreamZoneStack(app, 'Zone', { env: edgeEnv, config });
  const cert = new CamStreamCertStack(app, 'Cert', {
    env: edgeEnv, config, hostedZone: zone.hostedZone,
  });
  const stack = new CamStreamAppStack(app, 'App', {
    env: { account: config.account, region: config.primaryRegion },
    config,
    hostedZone: zone.hostedZone,
    certificate: cert.certificate,
    crossRegionReferences: true,
  });
  return Template.fromStack(stack);
}

/** The one rule that watches the signing key. */
function signingRule(template: Template): Record<string, unknown> {
  const rules = template.findResources('AWS::Events::Rule', {
    Properties: {
      EventPattern: Match.objectLike({ source: ['aws.kms'] }),
    },
  });
  const found = Object.values(rules);
  expect(found).toHaveLength(1);
  return (found[0] as { Properties: Record<string, unknown> }).Properties;
}

describe('watching the release signing key', () => {
  it('notices Sign, on the default bus, with no trail needed', () => {
    // KMS logs its cryptographic operations as CloudTrail management events,
    // which reach the default event bus without a trail existing. A trail
    // would mean an S3 bucket, a log group and a standing cost for the same
    // information.
    const pattern = signingRule(synth()).EventPattern as Record<string, unknown>;
    expect(pattern['detail-type']).toEqual(['AWS API Call via CloudTrail']);
    const detail = pattern.detail as Record<string, unknown>;
    expect(detail.eventName).toEqual(['Sign']);
    expect(detail.eventSource).toEqual(['kms.amazonaws.com']);
  });

  it('watches only Sign, not Verify or GetPublicKey', () => {
    // Verify is never called by anything: agents check locally against the
    // public key compiled into them. GetPublicKey is how that key gets into a
    // build, and is a read of something already published in the repository.
    // Including either would make this alert routine, and a routine alert is
    // one nobody reads on the day it matters.
    const detail = (signingRule(synth()).EventPattern as Record<string, unknown>)
      .detail as Record<string, unknown>;
    expect(detail.eventName).not.toContain('Verify');
    expect(detail.eventName).not.toContain('GetPublicKey');
  });

  it('is scoped to the release key rather than every key in the account', () => {
    // Other keys here are symmetric and cannot be signed with at all, so this
    // is belt and braces - but an unscoped rule would start paging about
    // somebody else's key the day an asymmetric one is added, and an alert
    // that fires for unrelated reasons stops being read.
    const detail = (signingRule(synth()).EventPattern as Record<string, unknown>)
      .detail as Record<string, unknown>;
    expect(detail.resources).toBeDefined();
    expect(JSON.stringify(detail.resources)).toContain('ReleaseKey');
  });

  it('actually notifies the alarm topic', () => {
    // The failure this whole file is guarding against is the one the alarms
    // test found before: seven alarms publishing to a topic nobody was
    // subscribed to. A rule with no target is the same mistake earlier in the
    // chain.
    const targets = signingRule(synth()).Targets as { Arn: unknown }[];
    expect(targets).toHaveLength(1);
    expect(JSON.stringify(targets[0].Arn)).toContain('AlarmTopic');
  });

  it('says who signed, and when, in the message itself', () => {
    // An alert that only says "the key was used" sends somebody to CloudTrail
    // to find the one thing they wanted to know. At three in the morning the
    // difference between that and a name in the message is whether anybody
    // bothers.
    const targets = signingRule(synth()).Targets as { InputTransformer?: unknown }[];
    const transformer = JSON.stringify(targets[0].InputTransformer);
    expect(transformer).toContain('$.detail.userIdentity.arn');
    expect(transformer).toContain('$.detail.eventTime');
    expect(transformer).toContain('$.detail.sourceIPAddress');
    // And the sentence that says what to do about it, which is the part
    // somebody reads first.
    expect(transformer).toContain('compromise of the');
  });
});
