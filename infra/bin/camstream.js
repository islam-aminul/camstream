#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const aws_cdk_lib_1 = require("aws-cdk-lib");
const config_1 = require("../lib/config");
const zone_stack_1 = require("../lib/zone-stack");
const cert_stack_1 = require("../lib/cert-stack");
const app_stack_1 = require("../lib/app-stack");
const app = new aws_cdk_lib_1.App();
const config = (0, config_1.resolveConfig)(app);
// Deploy order matters, and is not fully automatable:
//   1. CamStreamZone  — then delegate the nameservers at the registrar
//   2. CamStreamCert  — DNS validation only succeeds once (1) has propagated
//   3. CamStreamApp
const edgeEnv = { account: config.account, region: config.edgeRegion };
const zone = new zone_stack_1.CamStreamZoneStack(app, 'CamStreamZone', {
    env: edgeEnv,
    config,
    description: 'CamStream — public hosted zone',
});
const cert = new cert_stack_1.CamStreamCertStack(app, 'CamStreamCert', {
    env: edgeEnv,
    config,
    hostedZone: zone.hostedZone,
    description: 'CamStream — CloudFront certificate (us-east-1)',
});
new app_stack_1.CamStreamAppStack(app, 'CamStreamApp', {
    // CloudFront only accepts certificates from us-east-1, so the certificate ARN
    // and hosted zone id cross regions into the primary stack.
    env: { account: config.account, region: config.primaryRegion },
    config,
    hostedZone: zone.hostedZone,
    certificate: cert.certificate,
    crossRegionReferences: true,
    description: 'CamStream — storage, identity, ingest, control plane and CDN',
});
aws_cdk_lib_1.Tags.of(app).add('project', 'camstream');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2Ftc3RyZWFtLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2Ftc3RyZWFtLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUNBLDZDQUF3QztBQUN4QywwQ0FBOEM7QUFDOUMsa0RBQXVEO0FBQ3ZELGtEQUF1RDtBQUN2RCxnREFBcUQ7QUFFckQsTUFBTSxHQUFHLEdBQUcsSUFBSSxpQkFBRyxFQUFFLENBQUM7QUFDdEIsTUFBTSxNQUFNLEdBQUcsSUFBQSxzQkFBYSxFQUFDLEdBQUcsQ0FBQyxDQUFDO0FBRWxDLHNEQUFzRDtBQUN0RCx1RUFBdUU7QUFDdkUsNkVBQTZFO0FBQzdFLG9CQUFvQjtBQUNwQixNQUFNLE9BQU8sR0FBRyxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsVUFBVSxFQUFFLENBQUM7QUFFdkUsTUFBTSxJQUFJLEdBQUcsSUFBSSwrQkFBa0IsQ0FBQyxHQUFHLEVBQUUsZUFBZSxFQUFFO0lBQ3hELEdBQUcsRUFBRSxPQUFPO0lBQ1osTUFBTTtJQUNOLFdBQVcsRUFBRSxnQ0FBZ0M7Q0FDOUMsQ0FBQyxDQUFDO0FBRUgsTUFBTSxJQUFJLEdBQUcsSUFBSSwrQkFBa0IsQ0FBQyxHQUFHLEVBQUUsZUFBZSxFQUFFO0lBQ3hELEdBQUcsRUFBRSxPQUFPO0lBQ1osTUFBTTtJQUNOLFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVTtJQUMzQixXQUFXLEVBQUUsZ0RBQWdEO0NBQzlELENBQUMsQ0FBQztBQUVILElBQUksNkJBQWlCLENBQUMsR0FBRyxFQUFFLGNBQWMsRUFBRTtJQUN6Qyw4RUFBOEU7SUFDOUUsMkRBQTJEO0lBQzNELEdBQUcsRUFBRSxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsYUFBYSxFQUFFO0lBQzlELE1BQU07SUFDTixVQUFVLEVBQUUsSUFBSSxDQUFDLFVBQVU7SUFDM0IsV0FBVyxFQUFFLElBQUksQ0FBQyxXQUFXO0lBQzdCLHFCQUFxQixFQUFFLElBQUk7SUFDM0IsV0FBVyxFQUFFLDhEQUE4RDtDQUM1RSxDQUFDLENBQUM7QUFFSCxrQkFBSSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFLFdBQVcsQ0FBQyxDQUFDIn0=