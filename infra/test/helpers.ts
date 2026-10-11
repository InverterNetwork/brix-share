import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/app.ts';
import { readStages, type StageConfig } from '../lib/stages.ts';

/**
 * Builds the app from stages.example.json, once as configured and once per variant (each in its own App, since
 * stack names repeat). Variants flip settings that change what is synthesized, e.g. the custom domain.
 */
export function synthAll() {
  return [
    ...synthVariant('as configured', (s) => s),
    ...synthVariant('custom domain', (s) => ({ ...s, customDomain: true })),
  ];
}

function synthVariant(label: string, adjust: (s: StageConfig) => StageConfig) {
  // Skip esbuild bundling in assertion tests; `pnpm synth` bundles for real.
  // Same feature flags as `cdk synth` (cdk.json context), minus bundling.
  const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
    context: Record<string, unknown>;
  };
  const app = new App({ context: { ...cdkJson.context, 'aws:cdk:bundling-stacks': [] } });
  const stages = readStages(
    JSON.parse(readFileSync(new URL('../stages.example.json', import.meta.url), 'utf8')),
  );
  return buildApp(app, stages.map(adjust)).map((b) => ({
    ...b,
    label: `${b.stage.name}, ${label}`,
    mainT: Template.fromStack(b.main),
    edgeT: Template.fromStack(b.edge),
    zoneT: b.zoneStack ? Template.fromStack(b.zoneStack) : undefined,
  }));
}

type Resources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

export function resourcesOf(t: Template, type: string) {
  return Object.values(t.toJSON().Resources as Resources).filter((r) => r.Type === type);
}
