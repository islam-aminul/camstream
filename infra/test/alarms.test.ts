import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CamStreamZoneStack } from '../lib/zone-stack';
import { CamStreamCertStack } from '../lib/cert-stack';
import { CamStreamAppStack } from '../lib/app-stack';
import { resolveConfig } from '../lib/config';

/**
 * Alarms are only worth having if somebody is told.
 *
 * Seven of them existed and published to a topic with no subscriptions, so a
 * lambda failing overnight would have paged nobody and the first report would
 * have come from a customer looking at a black wall. The subscription belongs
 * in the stack rather than clicked into the console, or the next deploy is one
 * `cdk destroy` away from silence again.
 */
function synth(extra: Record<string, unknown> = {}) {
  // The same context the deployed stack uses, so the alarms under test are the
  // alarms that ship.
  const app = new App({
    context: {
      'camstream:account': '123456789012',
      'camstream:primaryRegion': 'ap-south-1',
      'camstream:edgeRegion': 'us-east-1',
      'camstream:domainName': 'camstream.online',
      'camstream:segmentTtlDays': 1,
      ...extra,
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

describe('alarms', () => {
  it('subscribes the address it is given', () => {
    const template = synth({ alarmEmail: 'alerts@example.com' });
    template.hasResourceProperties('AWS::SNS::Subscription', Match.objectLike({
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    }));
  });

  it('creates no subscription when none is configured, rather than a wrong one', () => {
    // Guessing an address is worse than none: mail to somebody who did not ask
    // for it, and a false sense that alerting is set up.
    synth().resourceCountIs('AWS::SNS::Subscription', 0);
  });

  it('alarms on throttling, which the error metrics do not cover', () => {
    // A throttled invocation never ran, so the function's own error metric
    // stays at zero while requests are shed. This account spent weeks capped
    // at ten concurrent executions with nothing saying so.
    const alarms = synth({ alarmEmail: 'a@b.com' }).findResources('AWS::CloudWatch::Alarm');
    const names = Object.values(alarms).map((a) => (a as never as { Properties: { MetricName?: string } }).Properties.MetricName);
    expect(names).toContain('Throttles');
  });

  it('alarms when no agent has reported at all', () => {
    // Every agent reports on a twenty-second heartbeat, so a fleet-wide zero
    // is the control plane being unreachable, not a quiet period. Missing data
    // has to breach here: no data points is the condition being detected.
    const alarms = synth({ alarmEmail: 'a@b.com' }).findResources('AWS::CloudWatch::Alarm');
    const quiet = Object.values(alarms)
      .map((a) => (a as never as { Properties: Record<string, unknown> }).Properties)
      .find((p) => p.MetricName === 'AgentReports');

    expect(quiet, 'an alarm on AgentReports should exist').toBeDefined();
    expect(quiet!.ComparisonOperator).toBe('LessThanThreshold');
    expect(quiet!.TreatMissingData).toBe('breaching');
  });

  it('every alarm actually notifies the topic', () => {
    // An alarm with no action is a dashboard nobody looks at.
    const alarms = synth({ alarmEmail: 'a@b.com' }).findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms).length).toBeGreaterThan(7);
    for (const [name, alarm] of Object.entries(alarms)) {
      const props = (alarm as never as { Properties: { AlarmActions?: unknown[] } }).Properties;
      expect(props.AlarmActions, `${name} has no action`).toBeDefined();
      expect(props.AlarmActions!.length, `${name} has no action`).toBeGreaterThan(0);
    }
  });
});
