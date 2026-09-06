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

/** The metric filter that counts signings. */
function signingFilter(template: Template): Record<string, unknown> {
  const filters = template.findResources('AWS::Logs::MetricFilter');
  const found = Object.values(filters)
    .map((f) => (f as { Properties: Record<string, unknown> }).Properties)
    .filter((p) => JSON.stringify(p).includes('ReleaseKeySignings'));
  expect(found).toHaveLength(1);
  return found[0];
}

describe('watching the release signing key', () => {
  it('uses a trail into logs, because EventBridge cannot see this event', () => {
    // Tried EventBridge first and it does not work. kms:Sign is a management
    // event and carries the key ARN in `resources`, but it is flagged
    // readOnly: true, and EventBridge does not deliver read-only management
    // events. The rule was deployed, the key was signed with, and thirty
    // minutes later TriggeredRules had no data points at all.
    //
    // This is pinned as a test rather than only as a comment because the
    // EventBridge version looks more elegant and someone will propose it
    // again - including me, if I forget.
    const template = synth();
    template.resourceCountIs('AWS::CloudTrail::Trail', 1);
    const rules = template.findResources('AWS::Events::Rule', {
      Properties: { EventPattern: Match.objectLike({ source: ['aws.kms'] }) },
    });
    expect(Object.keys(rules)).toHaveLength(0);
  });

  it('counts Sign on this key, and nothing else', () => {
    const pattern = JSON.stringify(signingFilter(synth()).FilterPattern);
    expect(pattern).toContain('Sign');
    expect(pattern).toContain('kms.amazonaws.com');
    // Anchored on the key ARN, so another asymmetric key added later cannot
    // quietly start paging this topic.
    expect(pattern).toContain('resources[0].ARN');
  });

  it('does not count Verify or GetPublicKey', () => {
    // Verify is never called by anything: agents check locally against the
    // public key compiled into them. GetPublicKey is how that key gets into a
    // build, and is a read of something already committed to this repository.
    // Either would make the alert routine, and a routine alert is one nobody
    // reads on the day it matters.
    const pattern = JSON.stringify(signingFilter(synth()).FilterPattern);
    expect(pattern).not.toContain('Verify');
    expect(pattern).not.toContain('GetPublicKey');
  });

  it('reports absence as zero, so it does not sit in INSUFFICIENT_DATA', () => {
    // Nothing signing is the ordinary state between releases. Without a
    // default the alarm would live in INSUFFICIENT_DATA and get muted by
    // whoever is tired of looking at it - and then it is gone.
    const transformation = (signingFilter(synth()).MetricTransformations as
      { DefaultValue?: number }[])[0];
    expect(transformation.DefaultValue).toBe(0);
  });

  it('fires on a single signature, and tells the alarm topic', () => {
    // One signature is the whole event. There is no suspicious rate to
    // detect, and a threshold high enough to be quiet would also be high
    // enough to miss the one that matters.
    const alarms = synth().findResources('AWS::CloudWatch::Alarm');
    const found = Object.values(alarms)
      .map((a) => (a as { Properties: Record<string, unknown> }).Properties)
      .filter((p) => JSON.stringify(p.MetricName ?? p).includes('ReleaseKeySignings'));
    expect(found).toHaveLength(1);
    expect(found[0].Threshold).toBe(1);
    expect(found[0].ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
    expect(JSON.stringify(found[0].AlarmActions)).toContain('AlarmTopic');
  });

  it('says what to do about it in the alarm itself', () => {
    // An alert that only says "the key was used" sends somebody to CloudTrail
    // for the one thing they wanted to know.
    const alarms = synth().findResources('AWS::CloudWatch::Alarm');
    const found = Object.values(alarms)
      .map((a) => (a as { Properties: Record<string, unknown> }).Properties)
      .filter((p) => JSON.stringify(p).includes('ReleaseKeySignings'));
    expect(found[0].AlarmDescription).toContain('compromise of the fleet update path');
  });
});
