import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readStages } from '../lib/stages.ts';

it('reads the example stage config', () => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../stages.example.json', import.meta.url), 'utf8'),
  );
  expect(readStages(raw).map((s) => s.name)).toEqual(['prod']);
});

it('accepts external alarm topics only in the stage account and region', () => {
  const base = {
    account: '123456789012',
    region: 'eu-central-1',
    domainName: 'x.example',
    hostedZone: { mode: 'create', zoneName: 'x.example' },
    adminRolePattern: 'r/*',
    filesBucketSuffix: 'abc12345',
  };
  const ok = 'arn:aws:sns:eu-central-1:123456789012:team-alerts';
  expect(readStages({ s: { ...base, alarmTopicArns: [ok] } })[0]!.alarmTopicArns).toEqual([ok]);
  for (const bad of [
    'arn:aws:sns:us-east-1:123456789012:team-alerts',
    'arn:aws:sns:eu-central-1:210987654321:team-alerts',
    'arn:aws:sqs:eu-central-1:123456789012:team-alerts',
  ])
    expect(() => readStages({ s: { ...base, alarmTopicArns: [bad] } })).toThrow(/alarmTopicArns/);
});

it('requires a random files bucket suffix', () => {
  const base = {
    account: '123456789012',
    region: 'eu-central-1',
    domainName: 'x.example',
    hostedZone: { mode: 'create', zoneName: 'x.example' },
    adminRolePattern: 'r/*',
  };
  expect(() => readStages({ s: base })).toThrow(/filesBucketSuffix/);
  for (const bad of ['short', 'UPPERCASE123', 'has-dash-123', 'x'.repeat(17)])
    expect(() => readStages({ s: { ...base, filesBucketSuffix: bad } })).toThrow(
      /filesBucketSuffix/,
    );
});
