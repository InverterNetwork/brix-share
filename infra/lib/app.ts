import type { App } from 'aws-cdk-lib';
import { BrixShareStack } from './brix-share-stack.ts';
import { EdgeStack } from './edge-stack.ts';
import type { StageConfig, ZoneRef } from './stages.ts';
import { ZoneStack } from './zone-stack.ts';

/** Builds every stack of every stage. Kept separate from bin/ so tests can build the app with their own context. */
export function buildApp(app: App, stages: StageConfig[]) {
  const built = stages.map((stage) => {
    const edgeEnv = { account: stage.account, region: 'us-east-1' };
    const prefix = `BrixShare-${stage.name}`;
    // Stack-level tags propagate to every taggable resource (cost allocation uses app=brix-share).
    const tags = { app: 'brix-share', stage: stage.name };

    let zoneStack: ZoneStack | undefined;
    let zoneRef: ZoneRef;
    if (stage.hostedZone.mode === 'create') {
      zoneStack = new ZoneStack(app, `${prefix}-zone`, {
        env: edgeEnv,
        tags,
        zoneName: stage.hostedZone.zoneName,
        crossRegionReferences: true,
      });
      zoneRef = { zoneId: zoneStack.zone.hostedZoneId, zoneName: stage.hostedZone.zoneName };
    } else {
      zoneRef = { zoneId: stage.hostedZone.zoneId, zoneName: stage.hostedZone.zoneName };
    }

    const edge = new EdgeStack(app, `${prefix}-edge`, {
      env: edgeEnv,
      tags,
      ...(stage.customDomain ? { domain: { name: stage.domainName, zoneRef } } : {}),
      crossRegionReferences: true,
    });
    if (zoneStack && stage.customDomain) edge.addStackDependency(zoneStack);

    const main = new BrixShareStack(app, prefix, {
      env: { account: stage.account, region: stage.region },
      tags,
      stage,
      ...(stage.customDomain && edge.certificate
        ? { domain: { zoneRef, certificate: edge.certificate } }
        : {}),
      webAclArn: edge.webAclArn,
      crossRegionReferences: true,
    });
    main.addStackDependency(edge);

    return { stage, zoneStack, edge, main };
  });
  return built;
}
