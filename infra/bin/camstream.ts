#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { resolveConfig } from '../lib/config';
import { CamStreamZoneStack } from '../lib/zone-stack';
import { CamStreamCertStack } from '../lib/cert-stack';
import { CamStreamAppStack } from '../lib/app-stack';

const app = new App();
const config = resolveConfig(app);

// Deploy order matters, and is not fully automatable:
//   1. CamStreamZone  — then delegate the nameservers at the registrar
//   2. CamStreamCert  — DNS validation only succeeds once (1) has propagated
//   3. CamStreamApp
const edgeEnv = { account: config.account, region: config.edgeRegion };

const zone = new CamStreamZoneStack(app, 'CamStreamZone', {
  env: edgeEnv,
  config,
  description: 'CamStream — public hosted zone',
});

const cert = new CamStreamCertStack(app, 'CamStreamCert', {
  env: edgeEnv,
  config,
  hostedZone: zone.hostedZone,
  description: 'CamStream — CloudFront certificate (us-east-1)',
});

new CamStreamAppStack(app, 'CamStreamApp', {
  // CloudFront only accepts certificates from us-east-1, so the certificate ARN
  // and hosted zone id cross regions into the primary stack.
  env: { account: config.account, region: config.primaryRegion },
  config,
  hostedZone: zone.hostedZone,
  certificate: cert.certificate,
  crossRegionReferences: true,
  description: 'CamStream — storage, identity, ingest, control plane and CDN',
});

Tags.of(app).add('project', 'camstream');
